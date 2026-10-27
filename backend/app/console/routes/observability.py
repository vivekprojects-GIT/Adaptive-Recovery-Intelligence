"""Observability: the OpenTelemetry traces, metrics, events and logs CARE records (MELT)."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from opentelemetry.trace import StatusCode

from ...core import telemetry
from ..models import User
from ..rbac import require

router = APIRouter()
UTC = timezone.utc


def _ts(ns: int | None) -> str | None:
    return datetime.fromtimestamp(ns / 1e9, UTC).isoformat(timespec="milliseconds") if ns else None


def _ms(a: int | None, b: int | None) -> float | None:
    return round((b - a) / 1e6, 2) if a and b else None


def _attrs(a) -> dict:
    return {k: (v if isinstance(v, (str, int, float, bool)) else str(v)) for k, v in dict(a or {}).items()}


def _by_trace() -> dict[str, list]:
    traces: dict[str, list] = defaultdict(list)
    for s in telemetry.spans.spans():
        traces[f"{s.context.trace_id:032x}"].append(s)
    return traces


def _root(spans: list):
    ids = {s.context.span_id for s in spans}
    roots = [s for s in spans if s.parent is None or s.parent.span_id not in ids]
    return min(roots or spans, key=lambda s: s.start_time)


def _label(root) -> str:
    a = dict(root.attributes or {})
    if "http.route" in a or "http.target" in a:
        return f"{a.get('http.method', '')} {a.get('http.route') or a.get('http.target')}".strip()
    return root.name


@router.get("/observability/traces")
def traces(q: str = "", errors: bool = False, limit: int = 60, user: User = Depends(require("view_system_health"))):
    """Recent traces, newest first: the request or job at the root, how long it took, and what it touched."""
    out = []
    for tid, spans in _by_trace().items():
        root = _root(spans)
        names = sorted({s.name for s in spans})
        failed = any(s.status.status_code == StatusCode.ERROR for s in spans)
        decision = next((dict(s.attributes or {}).get("ari.decision_id") for s in spans
                         if dict(s.attributes or {}).get("ari.decision_id")), None)
        label = _label(root)
        if q and q.lower() not in (label + " " + " ".join(names) + " " + (decision or "")).lower():
            continue
        if errors and not failed:
            continue
        out.append({"trace_id": tid, "name": label, "root_span": root.name, "start": _ts(root.start_time),
                    "duration_ms": _ms(root.start_time, root.end_time), "spans": len(spans), "error": failed,
                    "decision_id": decision, "operations": names[:8],
                    "status_code": dict(root.attributes or {}).get("http.status_code")})
    out.sort(key=lambda t: t["start"] or "", reverse=True)
    return {"traces": out[:limit], "total": len(out)}


@router.get("/observability/traces/{trace_id}")
def trace_detail(trace_id: str, user: User = Depends(require("view_system_health"))):
    """Every span in one trace, as a waterfall: offset and duration from the start of the trace."""
    spans = _by_trace().get(trace_id)
    if not spans:
        raise HTTPException(404, "Trace not found, or no longer held in memory.")
    t0 = min(s.start_time for s in spans)
    by_id = {s.context.span_id: s for s in spans}

    def depth(s) -> int:
        n = 0
        while s.parent is not None and s.parent.span_id in by_id and n < 50:
            s, n = by_id[s.parent.span_id], n + 1
        return n

    rows = []
    # Clock ticks can tie on some platforms, so a parent is placed before its children explicitly.
    for s in sorted(spans, key=lambda s: (s.start_time, depth(s))):
        rows.append({"depth": depth(s), "span_id": f"{s.context.span_id:016x}",
                     "parent_id": f"{s.parent.span_id:016x}" if s.parent else None,
                     "name": s.name, "kind": s.kind.name.lower(), "offset_ms": _ms(t0, s.start_time) or 0.0,
                     "duration_ms": _ms(s.start_time, s.end_time), "status": s.status.status_code.name.lower(),
                     "attributes": _attrs(s.attributes),
                     "events": [{"name": e.name, "time": _ts(e.timestamp), "attributes": _attrs(e.attributes)}
                                for e in s.events]})
    root = _root(spans)
    return {"trace_id": trace_id, "name": _label(root), "start": _ts(t0),
            "duration_ms": _ms(t0, max(s.end_time or t0 for s in spans)), "spans": rows,
            "service": dict(telemetry.resource.attributes)}


@router.get("/observability/metrics")
def metrics(user: User = Depends(require("view_system_health"))):
    """Current values of CARE's metrics, by attribute set."""
    data = telemetry.metric_reader.get_metrics_data()
    out = []
    for rm in (data.resource_metrics if data else []):
        for sm in rm.scope_metrics:
            for m in sm.metrics:
                points = []
                for p in m.data.data_points:
                    row = {"attributes": _attrs(p.attributes)}
                    if hasattr(p, "bucket_counts"):
                        row.update(count=p.count, sum=round(p.sum, 2), avg=round(p.sum / p.count, 2) if p.count else None,
                                   min=round(p.min, 2) if p.count else None, max=round(p.max, 2) if p.count else None)
                    else:
                        row["value"] = p.value
                    points.append(row)
                out.append({"name": m.name, "description": m.description, "unit": m.unit, "scope": sm.scope.name,
                            "type": type(m.data).__name__.lower(), "points": points})
    out.sort(key=lambda m: (not m["name"].startswith("ari."), m["name"]))
    return {"metrics": out}


@router.get("/observability/events")
def events(limit: int = 200, user: User = Depends(require("view_system_health"))):
    """Span events, newest first: rules that blocked a treatment, decisions sent to review, held contacts."""
    out = []
    for s in telemetry.spans.spans():
        for e in s.events:
            if e.name == "exception" or e.name.startswith(("rule.", "review.", "contact.", "mcp.")):
                out.append({"time": _ts(e.timestamp), "name": e.name, "attributes": _attrs(e.attributes),
                            "span": s.name, "trace_id": f"{s.context.trace_id:032x}"})
    out.sort(key=lambda e: e["time"] or "", reverse=True)
    return {"events": out[:limit], "total": len(out)}


@router.get("/observability/logs")
def logs(level: str = "", limit: int = 300, user: User = Depends(require("view_system_health"))):
    """Log records, newest first, each linked to the trace it was written in."""
    out = []
    for d in telemetry.log_exporter.logs():
        r = d.log_record
        sev = (r.severity_text or "INFO").upper()
        if level and sev != level.upper():
            continue
        out.append({"time": _ts(r.timestamp or r.observed_timestamp), "severity": sev, "body": str(r.body),
                    "trace_id": f"{r.trace_id:032x}" if r.trace_id else None,
                    "span_id": f"{r.span_id:016x}" if r.span_id else None})
    out.sort(key=lambda x: x["time"] or "", reverse=True)
    return {"logs": out[:limit], "total": len(out)}


@router.get("/observability/summary")
def summary(user: User = Depends(require("view_system_health"))):
    traces_ = _by_trace()
    spans = telemetry.spans.spans()
    decide = sorted(_ms(s.start_time, s.end_time) or 0.0 for s in spans if s.name == "ari.decide")
    p95 = decide[min(len(decide) - 1, int(0.95 * len(decide)))] if decide else None
    return {"service": dict(telemetry.resource.attributes), "traces": len(traces_), "spans": len(spans),
            "errors": sum(1 for s in spans if s.status.status_code == StatusCode.ERROR),
            "decisions_traced": len(decide), "decision_p95_ms": p95,
            "logs": len(telemetry.log_exporter.logs()),
            "exporting_to": telemetry.OTLP_ENDPOINT or None}
