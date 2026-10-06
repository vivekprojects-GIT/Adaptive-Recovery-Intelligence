"""Customers, their journeys, and the actions a strategist can take on one."""
from __future__ import annotations

from datetime import datetime


from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from sqlalchemy.orm import Session


from ... import models
from ...core.database import get_db
from ...scoring import eligibility, fit_reasons, nudge_explanation
from .. import analytics, compliance, engine
from ..engine import arrears
from ..models import Campaign, Decision, User
from ..platform import audit, customer_ref
from ..rbac import require
from .common import UTC, _ordered_treatments, _treatments, customer_match

router = APIRouter()


@router.get("/customers")
def customers(view: str = "all", q: str = "", cohort: str = "", page: int = 1, page_size: int = 25,
              user: User = Depends(require("view_customer_list")), db: Session = Depends(get_db)):
    query = db.query(models.Customer)
    if cohort:
        query = query.filter(models.Customer.cohort_id == cohort)
    if q.strip():
        query = query.filter(customer_match(q))
    all_rows = query.all()
    states = analytics.customer_state(db, [c.customer_id for c in all_rows])
    t = _treatments(db)
    camps = {c.campaign_id: c.name for c in db.query(Campaign)}
    rows = []
    for c in all_rows:
        s = states.get(c.customer_id)
        rows.append({"customer_id": c.customer_id, "name": c.name, "cohort_id": c.cohort_id,
                     "balance": c.balance, "arrears": arrears(c), "days_past_due": c.days_past_due,
                     "risk_score": c.client_risk_score, "risk_band": c.client_risk_band,
                     "segment": c.segment, "status": s["status"] if s else "Not in a strategy",
                     "progress": s["progress"] if s else 0,
                     "strategy": camps.get(s["campaign_id"]) if s else None,
                     "campaign_id": s["campaign_id"] if s else None,
                     "treatment": t[s["treatment_code"]].name if s and s["treatment_code"] else None,
                     "last_contact": s["last_contact"] if s else None})
    filters = {
        "high_risk": lambda r: r["risk_band"] in ("High", "Very high"),
        "unresponsive": lambda r: r["status"] in ("Unresponsive", "Escalated"),
        "resolved": lambda r: r["status"] in ("Resolved", "Accepted"),
        "in_strategy": lambda r: r["campaign_id"] is not None,
        "pending": lambda r: r["status"] == "Pending review",
    }
    counts = {k: sum(1 for r in rows if f(r)) for k, f in filters.items()}
    counts["all"] = len(rows)
    if view in filters:
        rows = [r for r in rows if filters[view](r)]
    rows.sort(key=lambda r: r["last_contact"] or "", reverse=True)
    total = len(rows)
    start = (page - 1) * page_size
    return {"total": total, "page": page, "page_size": page_size, "counts": counts,
            "rows": rows[start:start + page_size]}


@router.get("/customers/{customer_id}/journey")
def customer_journey(customer_id: int, user: User = Depends(require("view_customer_list")),
                     db: Session = Depends(get_db)):
    j = analytics.journey(db, customer_id)
    if not j:
        raise HTTPException(404, "Customer not found.")
    c = db.get(models.Customer, customer_id)
    j["nudge_profile"] = nudge_explanation(c)
    j["eligibility"] = [{"code": s.code, "name": s.name, "eligible": eligibility(s.code, c)[0],
                         "reason": eligibility(s.code, c)[1], "fit_reasons": fit_reasons(s.code, c)}
                        for s in _ordered_treatments(db)]
    return j


class CustomerAction(BaseModel):
    action: str = Field(pattern="^(pause_journey|resume_journey|manual_nudge|skip_next_step)$")
    message: str = ""
    reason: str = ""


@router.post("/customers/{customer_id}/actions")
def customer_action(customer_id: int, body: CustomerAction,
                    user: User = Depends(require("override_decisions")), db: Session = Depends(get_db)):
    c = db.get(models.Customer, customer_id)
    d = (db.query(Decision).filter(Decision.customer_id == customer_id)
         .order_by(Decision.decided_at.desc()).first())
    if not c or not d:
        raise HTTPException(404, "This customer is not in a strategy.")
    if body.action == "manual_nudge":
        if not body.message.strip():
            raise HTTPException(400, "Write the message to send.")
        camp = db.get(Campaign, d.campaign_id)
        import numpy as np
        with engine.ENGINE_LOCK:
            n = engine.execute(db, camp, d, c, datetime.now(UTC), np.random.default_rng(),
                               engine.Seq(db), touch=9, manual_text=body.message, code="S1")
        audit(db, user.user_id, "CREATE", "nudge", n.nudge_id,
              f"Sent manual nudge to {customer_ref(customer_id)}", {"status": n.status})
        db.commit()
        compliance.scan(db)
        return {"nudge_id": n.nudge_id, "status": n.status, "note": n.failure_reason}
    if not body.reason.strip():
        raise HTTPException(400, "Give a reason - it goes in the audit log.")
    label = {"pause_journey": "Paused journey", "resume_journey": "Resumed journey",
             "skip_next_step": "Skipped next step"}[body.action]
    audit(db, user.user_id, "UPDATE", "journey", str(customer_id),
          f"{label} for {customer_ref(customer_id)}: {body.reason}")
    db.commit()
    return {"ok": True, "message": f"{label}. Recorded in the audit log."}
