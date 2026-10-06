"""Report catalogue and CSV exports."""
from __future__ import annotations

import csv
import io


from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session


from ...core.database import get_db
from .. import analytics
from ..models import AuditEvent, Campaign, ComplianceViolation, User
from ..platform import audit
from ..rbac import require

router = APIRouter()


REPORTS = {
    "portfolio": ("Portfolio performance", "Recovery, uplift over control, cost and escalation by strategy"),
    "decisions": ("Decision log", "Every decision with its group, treatment, probability and outcome"),
    "compliance": ("Compliance violations", "All detected violations with status and resolution"),
    "audit": ("Audit trail", "Every user and system action"),
    "team": ("Team performance", "Per-strategist results"),
}


@router.get("/reports")
def reports(user: User = Depends(require("export_reports"))):
    return [{"id": k, "name": v[0], "description": v[1]} for k, v in REPORTS.items()]


@router.get("/reports/{rid}.csv")
def export_report(rid: str, user: User = Depends(require("export_reports")), db: Session = Depends(get_db)):
    if rid not in REPORTS:
        raise HTTPException(404, "Unknown report.")
    buf = io.StringIO()
    w = csv.writer(buf)
    if rid == "portfolio":
        w.writerow(["strategy", "name", "owner", "status", "decisions", "treated", "control", "recovery_rate",
                    "control_rate", "uplift", "uplift_ci_low", "uplift_ci_high", "recovered",
                    "cost_per_recovery", "escalation_rate"])
        for c in db.query(Campaign):
            s = analytics.campaign_stats(db, c)
            ci = s["uplift_ci"] or [None, None]
            w.writerow([c.campaign_id, c.name, c.owner_id, c.status, s["decisions"], s["treated"], s["control"],
                        s["recovery_rate"], s["control_rate"], s["uplift"], ci[0], ci[1], s["recovered"],
                        s["cost_per_recovery"], s["escalation_rate"]])
    elif rid == "decisions":
        w.writerow(["decision_id", "strategy", "customer_id", "wave", "group", "treatment",
                    "selection_probability", "review_status", "overridden", "decided_at", "paid", "amount"])
        for d, o in analytics._rows(db):
            w.writerow([d.decision_id, d.campaign_id, d.customer_id, d.wave, d.group, d.treatment_code,
                        d.selection_probability, d.review_status, d.overridden, d.decided_at,
                        None if o is None else o.paid, None if o is None else o.amount])
    elif rid == "compliance":
        w.writerow(["violation_id", "area", "rule", "severity", "strategy", "customer_id", "detected_at",
                    "status", "description"])
        for v in db.query(ComplianceViolation).order_by(ComplianceViolation.detected_at):
            w.writerow([v.violation_id, v.policy_area, v.rule, v.severity, v.campaign_id, v.customer_id,
                        v.detected_at, v.status, v.description])
    elif rid == "audit":
        w.writerow(["at", "actor", "action", "entity", "entity_id", "summary"])
        for a in db.query(AuditEvent).order_by(AuditEvent.at):
            w.writerow([a.at, a.actor, a.action, a.entity, a.entity_id, a.summary])
    elif rid == "team":
        rows = analytics.team(db)
        w.writerow(list(rows[0].keys()) if rows else [])
        for r in rows:
            w.writerow(list(r.values()))
    audit(db, user.user_id, "EXPORT", "report", rid, f"Exported {REPORTS[rid][0].lower()} report")
    db.commit()
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename=ari-{rid}.csv"})
