"""One search for every role: strategies, customers, decisions and messages,
each only when the role may open it. Pages are matched in the browser."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ... import models
from ...core.database import get_db
from ..models import Campaign, Decision, Nudge, User
from ..platform import customer_ref
from ..rbac import current_user, granted
from .common import customer_match

router = APIRouter()

LIMIT = 5


@router.get("/search")
def search(q: str = "", user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Grouped matches for the header search. `scopes` says what this role can
    search, so the box can say so; anything the role cannot open is not searched."""
    have = granted(db, user.role)
    scopes = [s for s, perm in (("strategies", "view_kpi_dashboard"), ("customers", "view_customer_list"),
                                ("decisions", "view_ai_decisions")) if perm in have]
    out: dict = {"scopes": scopes, "strategies": [], "customers": [], "decisions": [], "messages": []}
    q = q.strip()
    if len(q) < 2:
        return out
    like = f"%{q}%"

    if "strategies" in scopes:
        rows = (db.query(Campaign).filter(or_(Campaign.campaign_id.ilike(like), Campaign.name.ilike(like)))
                .order_by(Campaign.campaign_id.desc()).limit(LIMIT))
        out["strategies"] = [{"campaign_id": c.campaign_id, "name": c.name, "status": c.status,
                              "version": c.version} for c in rows]

    if "customers" in scopes:
        rows = db.query(models.Customer).filter(customer_match(q)).order_by(models.Customer.name).limit(LIMIT)
        out["customers"] = [{"customer_id": c.customer_id, "name": c.name, "ref": customer_ref(c.customer_id),
                             "cohort_id": c.cohort_id, "days_past_due": c.days_past_due} for c in rows]

    if "decisions" in scopes:
        rows = (db.query(Decision).filter(Decision.decision_id.ilike(like))
                .order_by(Decision.decision_id.desc()).limit(LIMIT))
        out["decisions"] = [{"decision_id": d.decision_id, "campaign_id": d.campaign_id,
                             "customer": customer_ref(d.customer_id), "group": d.group} for d in rows]
        rows = db.query(Nudge).filter(Nudge.nudge_id.ilike(like)).order_by(Nudge.nudge_id.desc()).limit(LIMIT)
        out["messages"] = [{"nudge_id": n.nudge_id, "channel": n.channel, "status": n.status,
                            "customer": customer_ref(n.customer_id)} for n in rows]
    return out
