"""Compliance violations and scans."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta


from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session


from ...core.database import get_db
from .. import compliance
from ..models import ComplianceViolation, User
from ..platform import audit, now
from ..rbac import require
from .common import UTC

router = APIRouter()


@router.get("/compliance")
def compliance_view(severity: str = "", status: str = "", area: str = "",
                    user: User = Depends(require("view_compliance")), db: Session = Depends(get_db)):
    month = datetime.now(UTC) - timedelta(days=30)
    q = db.query(ComplianceViolation)
    all_v = q.order_by(ComplianceViolation.detected_at.desc()).all()
    rows = [v for v in all_v if (not severity or v.severity == severity) and (not status or v.status == status)
            and (not area or v.policy_area == area)]
    weekly: dict[str, Counter] = defaultdict(Counter)
    for v in all_v:
        d = datetime.fromisoformat(v.detected_at)
        weekly[(d - timedelta(days=d.weekday())).date().isoformat()][v.policy_area] += 1
    open_v = [v for v in all_v if v.status != "Resolved"]
    resolved = [v for v in all_v if v.status == "Resolved" and v.resolved_at]
    res_days = [(datetime.fromisoformat(v.resolved_at) - datetime.fromisoformat(v.detected_at)).total_seconds() / 86400
                for v in resolved]
    scores = compliance.area_scores(db, month)
    return {
        "kpis": {"open": len(open_v), "open_critical": sum(v.severity == "Critical" for v in open_v),
                 "open_high": sum(v.severity == "High" for v in open_v),
                 "month_total": sum(1 for v in all_v if v.detected_at >= month.isoformat()),
                 "score": round(sum(s["score"] for s in scores) / len(scores), 4),
                 "weakest": min(scores, key=lambda s: s["score"])["area"],
                 "avg_resolution_days": round(sum(res_days) / len(res_days), 1) if res_days else None},
        "areas": scores,
        "weekly": [{"week": w, **dict(c), "total": sum(c.values())} for w, c in sorted(weekly.items())],
        "by_strategy": [{"campaign_id": k, "count": n} for k, n in
                        Counter(v.campaign_id or "BAU only" for v in all_v).most_common()],
        "violations": [{k: getattr(v, k) for k in (
            "violation_id", "policy_area", "rule", "severity", "campaign_id", "customer_id", "nudge_id",
            "description", "detected_at", "status", "resolved_by", "resolved_at", "resolution_note")}
            for v in rows],
    }


class ViolationIn(BaseModel):
    status: str = Field(pattern="^(Open|Investigating|Resolved)$")
    note: str = ""


@router.post("/compliance/{vid}")
def update_violation(vid: str, body: ViolationIn, user: User = Depends(require("resolve_violations")),
                     db: Session = Depends(get_db)):
    v = db.get(ComplianceViolation, vid)
    if not v:
        raise HTTPException(404, "Violation not found.")
    if body.status == "Resolved" and not body.note.strip():
        raise HTTPException(400, "A resolution note is required.")
    v.status = body.status
    if body.status == "Resolved":
        v.resolved_by, v.resolved_at, v.resolution_note = user.user_id, now(), body.note
    audit(db, user.user_id, "UPDATE", "violation", vid, f"{vid} -> {body.status}", {"note": body.note})
    db.commit()
    return {"ok": True}


@router.post("/compliance/scan")
def scan_now(user: User = Depends(require("resolve_violations")), db: Session = Depends(get_db)):
    n = compliance.scan(db)
    audit(db, user.user_id, "READ", "compliance", "scan", f"Ran compliance scan: {n} new")
    db.commit()
    return {"new_violations": n}
