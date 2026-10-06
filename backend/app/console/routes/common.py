"""Helpers and request models shared by more than one group of console routes."""
from __future__ import annotations

import json
from datetime import timezone


from fastapi import HTTPException
from sqlalchemy.orm import Session


from ... import models
from .. import analytics, engine
from ..engine import jl
from ..models import AlertRule, Campaign, ComplianceViolation, Decision, Insight, TreatmentMeta, User
from ..platform import METRICS, audit, now


UTC = timezone.utc


MATERIAL = {"target_cohorts", "include_segments", "risk_bands", "min_dpd", "max_dpd", "min_balance",
            "max_balance", "treatment_codes", "control_pct", "escalate_to", "escalate_after_days"}


# What a copy (clone or revision) carries over from its source.
COPY_FIELDS = ("description", "target_cohorts", "include_segments", "risk_bands", "min_balance", "max_balance",
               "min_dpd", "max_dpd", "treatment_codes", "cadence_days", "max_touches", "tone",
               "send_window_start", "send_window_end", "escalate_after_days", "escalate_to", "control_pct",
               "wave_size", "evaluation_days", "recovery_target")


SERVICE_ACTORS = {"nova-agent": "Nova agent (MCP)", "system": "System"}


def _user_names(db: Session) -> dict[str, str]:
    return {**SERVICE_ACTORS, **{u.user_id: u.name for u in db.query(User)}}


def _treatments(db: Session) -> dict[str, models.Strategy]:
    return {s.code: s for s in db.query(models.Strategy)}


def _ordered_treatments(db: Session) -> list[models.Strategy]:
    """S1, S2 ... S10 - numeric order, not string order."""
    return sorted(db.query(models.Strategy), key=lambda s: (len(s.code), s.code))


def _has_decisions(db: Session, cid: str) -> bool:
    return db.query(Decision.decision_id).filter(Decision.campaign_id == cid).first() is not None


def _open_revision(db: Session, cid: str) -> Campaign | None:
    """A draft version of this strategy that has not gone live yet."""
    return (db.query(Campaign).filter(Campaign.parent_id == cid,
                                      Campaign.status.in_(["Draft", "In review", "Approved"]))
            .order_by(Campaign.created_at.desc()).first())


def _strategy_out(db: Session, c: Campaign, stats: bool = True) -> dict:
    names = _user_names(db)
    t = _treatments(db)
    status = {m.code: m.status for m in db.query(TreatmentMeta)}
    out = {k: getattr(c, k) for k in (
        "campaign_id", "name", "description", "status", "version", "source", "steps_completed",
        "min_balance", "max_balance", "min_dpd", "max_dpd", "cadence_days", "max_touches", "tone",
        "send_window_start", "send_window_end", "escalate_after_days", "escalate_to", "control_pct",
        "wave_size", "evaluation_days", "recovery_target", "created_at", "updated_at", "submitted_at",
        "approved_at", "launched_at", "waves_run", "owner_id", "created_by", "approved_by", "parent_id")}
    has_history = _has_decisions(db, c.campaign_id)
    revision = _open_revision(db, c.campaign_id) if c.status in ("Live", "Paused") else None
    out.update(target_cohorts=jl(c.target_cohorts), include_segments=jl(c.include_segments),
               risk_bands=jl(c.risk_bands), treatment_codes=jl(c.treatment_codes),
               owner=names.get(c.owner_id), approver=names.get(c.approved_by),
               channels=sorted({t[x].channel for x in jl(c.treatment_codes) if x in t}),
               treatments=[{"code": x, "name": t[x].name, "channel": t[x].channel,
                            "status": status.get(x, "Active")}
                           for x in jl(c.treatment_codes) if x in t],
               has_history=has_history,
               # What the console may offer for this strategy. The routes enforce the same rules.
               editable=c.status in ("Draft", "In review", "Approved")
                        or (c.status == "Paused" and not has_history),
               revisable=c.status in ("Live", "Paused") and has_history,
               deletable=c.status != "Live" and not has_history,
               open_revision=revision.campaign_id if revision else None)
    if stats:
        out["stats"] = analytics.campaign_stats(db, c)
        out["pool_remaining"] = (len(engine.undecided_pool(db, c)) if c.status in ("Live", "Paused")
                                 else None)
    return out


def _get_campaign(db: Session, cid: str) -> Campaign:
    c = db.get(Campaign, cid)
    if not c:
        raise HTTPException(404, f"Strategy {cid} not found.")
    return c


def _next_campaign_id(db: Session) -> str:
    ids = [int(c.campaign_id.split("-")[1]) for c in db.query(Campaign)]
    return f"STR-{max(ids + [0]) + 1:03d}"


def _copy(db: Session, src: Campaign, user: User, **fields) -> Campaign:
    new_id = _next_campaign_id(db)
    ts = now()
    c = Campaign(**{k: getattr(src, k) for k in COPY_FIELDS}, campaign_id=new_id, owner_id=user.user_id,
                 created_by=user.user_id, status="Draft", created_at=ts, updated_at=ts,
                 seed=int(new_id.split("-")[1]) * 7 + 3, **fields)
    db.add(c)
    return c


def _make_revision(db: Session, src: Campaign, user: User) -> tuple[Campaign, bool]:
    """The draft that will replace a running strategy. Reused if one is open,
    so a strategy never has two competing next versions."""
    existing = _open_revision(db, src.campaign_id)
    if existing:
        return existing, False
    c = _copy(db, src, user, name=src.name, source="revision", steps_completed=6,
              version=src.version + 1, parent_id=src.campaign_id)
    audit(db, user.user_id, "CREATE", "strategy", c.campaign_id,
          f"Opened {c.campaign_id} as v{c.version} of {src.campaign_id} {src.name}")
    return c, True


def _insights_for(db: Session, user: User) -> list[dict]:
    names = _user_names(db)
    q = db.query(Insight)
    q = q.filter(Insight.to_user == user.user_id) if user.role == "strategist" else q
    return [{"insight_id": i.insight_id, "campaign_id": i.campaign_id, "from": names.get(i.from_user),
             "to": names.get(i.to_user), "title": i.title, "body": i.body, "evidence": i.evidence,
             "priority": i.priority, "status": i.status, "change": json.loads(i.proposed_change or "{}"),
             "created_at": i.created_at, "response_note": i.response_note}
            for i in q.order_by(Insight.created_at.desc())]


def _metric_values(db: Session) -> list[tuple[str, str | None, float | None]]:
    """(metric, campaign_id, value) for every alertable metric."""
    vals: list[tuple[str, str | None, float | None]] = []
    k = analytics.kpis(db)
    vals.append(("escalation_rate", None, k["escalation_rate"]["value"]))
    vals.append(("recovery_rate", None, k["recovery_rate"]["value"]))
    vals.append(("pending_review", None, float(db.query(Decision).filter(Decision.review_status == "pending").count())))
    vals.append(("critical_violations", None, float(db.query(ComplianceViolation).filter(
        ComplianceViolation.status != "Resolved", ComplianceViolation.severity == "Critical").count())))
    vals.append(("latency_p95_ms", None, METRICS.snapshot()["latency_p95_ms"]))
    for c in db.query(Campaign).filter(Campaign.status == "Live"):
        s = analytics.campaign_stats(db, c)
        if s["treated"] >= 20 and s["recovery_rate"] is not None:
            vals.append(("campaign_rate_vs_target", c.campaign_id, s["recovery_rate"] - c.recovery_target))
        if s["control"] >= 15 and s["uplift"] is not None:
            vals.append(("campaign_uplift", c.campaign_id, s["uplift"]))
    return vals


METRIC_LABELS = {
    "campaign_rate_vs_target": "Strategy recovery rate minus target",
    "campaign_uplift": "Strategy uplift over control",
    "escalation_rate": "Portfolio escalation rate",
    "recovery_rate": "Portfolio recovery rate",
    "critical_violations": "Open critical violations",
    "pending_review": "Decisions waiting for review",
    "latency_p95_ms": "API latency p95 (ms)",
}


def _fmt_metric(metric: str, v: float) -> str:
    if metric in ("campaign_rate_vs_target", "campaign_uplift"):
        return f"{v * 100:+.1f} pp"
    if metric in ("escalation_rate", "recovery_rate"):
        return f"{v * 100:.1f}%"
    if metric == "latency_p95_ms":
        return f"{v:.0f} ms"
    return f"{v:.0f}"


def fired_alerts(db: Session) -> list[dict]:
    vals = _metric_values(db)
    out = []
    for r in db.query(AlertRule).filter(AlertRule.enabled.is_(True)):
        for metric, cid, v in vals:
            if metric != r.metric or v is None:
                continue
            hit = v < r.threshold if r.comparator == "lt" else v > r.threshold
            if hit:
                out.append({"rule_id": r.rule_id, "name": r.name, "severity": r.severity, "campaign_id": cid,
                            "value": round(v, 4), "threshold": r.threshold, "metric": metric,
                            "message": f"{(cid + ': ') if cid else ''}{METRIC_LABELS.get(metric, metric)} "
                                       f"is {_fmt_metric(metric, v)} "
                                       f"({'below' if r.comparator == 'lt' else 'above'} {_fmt_metric(metric, r.threshold)})"})
    order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}
    return sorted(out, key=lambda a: order.get(a["severity"], 9))
