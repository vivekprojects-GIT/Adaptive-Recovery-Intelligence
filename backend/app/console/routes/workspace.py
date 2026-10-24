"""The Strategy Workspace: collections and recovery strategies by card business."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ... import models
from ...core.database import get_db
from ...seed import PRODUCTS
from .. import analytics, recovery
from ..engine import arrears, jl
from ..models import Campaign, Decision, Outcome, User
from ..platform import customer_ref
from ..rbac import granted, require

router = APIRouter()
UTC = timezone.utc
ROUTE_STATUS = {"bau": "Business as usual", "hardship": "Hardship team", "suppress": "Do not contact"}


def _product(p: str) -> str | None:
    if not p:
        return None
    if p not in PRODUCTS:
        raise HTTPException(400, f"Unknown card business {p}. Use one of: {', '.join(PRODUCTS)}.")
    return p


def _paid(db: Session, ids: list[int], since: str, until: str) -> float:
    if not ids:
        return 0.0
    return float(db.query(func.coalesce(func.sum(Outcome.amount), 0.0)).filter(
        Outcome.customer_id.in_(ids), Outcome.paid.is_(True), Outcome.observed_at > since,
        Outcome.observed_at <= until).scalar() or 0.0)


@router.get("/workspace")
def workspace_meta(user: User = Depends(require("view_kpi_dashboard"))):
    return {"businesses": PRODUCTS, "recovery_treatments": recovery.treatments(),
            "charge_off_days": recovery.CHARGE_OFF_DPD}


@router.get("/workspace/collections")
def collections(product: str = "", user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    """Delinquent accounts before charge-off, for one card business or all."""
    p = _product(product)
    q = db.query(models.Customer)
    if p:
        q = q.filter(models.Customer.product == p)
    custs = q.all()
    ids = [c.customer_id for c in custs]
    now_ = datetime.now(UTC)
    iso = lambda d: d.isoformat(timespec="seconds")  # noqa: E731
    collected = _paid(db, ids, iso(now_ - timedelta(days=30)), iso(now_))
    collected_prev = _paid(db, ids, iso(now_ - timedelta(days=60)), iso(now_ - timedelta(days=30)))
    in_strategy = {cid for (cid,) in db.query(Decision.customer_id).filter(Decision.customer_id.in_(ids))} if ids else set()
    out = {
        "product": p,
        "kpis": {"delinquent_accounts": len(custs), "balance": round(sum(c.balance for c in custs), 2),
                 "past_due": round(sum(arrears(c) for c in custs), 2), "in_strategies": len(in_strategy),
                 "collected_30d": {"value": round(collected, 2),
                                   "delta": round((collected - collected_prev) / collected_prev, 4)
                                   if collected_prev else None}},
        "strategies": [],
        "population": None,
    }
    for c in db.query(Campaign).filter(Campaign.status.in_(["Live", "Paused"])).order_by(Campaign.campaign_id):
        s = analytics.campaign_stats(db, c)
        out["strategies"].append({"campaign_id": c.campaign_id, "name": c.name, "status": c.status,
                                  "description": c.description, "treatments": jl(c.treatment_codes),
                                  "payment_rate": s["recovery_rate"], "lift": s["uplift"],
                                  "target": c.recovery_target, "cohorts": jl(c.target_cohorts)})
    if "view_customer_list" in granted(db, user.role):
        latest = {}
        if ids:
            for d in db.query(Decision).filter(Decision.customer_id.in_(ids)).order_by(Decision.decided_at):
                latest[d.customer_id] = d
        names = {c.campaign_id: c.name for c in db.query(Campaign)}
        top = sorted(custs, key=lambda c: -c.days_past_due)[:5]
        out["population"] = {"total": len(custs), "rows": [{
            "customer_id": c.customer_id, "account_number": customer_ref(c.customer_id), "name": c.name,
            "product": c.product, "days_past_due": c.days_past_due, "balance": c.balance, "past_due": arrears(c),
            "status": (names.get(latest[c.customer_id].campaign_id, "In strategy") if c.customer_id in latest
                       else ROUTE_STATUS.get(c.route or "", "Awaiting strategy"))} for c in top]}
    return out


@router.get("/workspace/recovery")
def recovery_view(product: str = "", user: User = Depends(require("view_kpi_dashboard")),
                  db: Session = Depends(get_db)):
    """Charged-off accounts: the four tiles, and the account population for roles that may see accounts."""
    p = _product(product)
    out = {"summary": recovery.summary(db, p), "treatments": recovery.treatments(), "population": None}
    if "view_customer_list" in granted(db, user.role):
        out["population"] = recovery.accounts(db, p, page_size=5)
    return out


@router.get("/workspace/recovery/accounts")
def recovery_accounts(product: str = "", status: str = "", page: int = 1, page_size: int = 25,
                      user: User = Depends(require("view_customer_list")), db: Session = Depends(get_db)):
    return recovery.accounts(db, _product(product), status or None, page, min(max(page_size, 1), 100))


class AssignIn(BaseModel):
    recovery_ids: list[int]
    treatment: str


@router.post("/workspace/recovery/assign")
def recovery_assign(body: AssignIn, user: User = Depends(require("edit_strategy")), db: Session = Depends(get_db)):
    """A strategist assigns a recovery treatment. Settlement offers then wait for review."""
    try:
        return recovery.assign(db, body.recovery_ids, body.treatment, user.user_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
