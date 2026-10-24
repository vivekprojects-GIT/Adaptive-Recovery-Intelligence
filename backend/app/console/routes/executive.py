"""The executive dashboard (every role's first screen) and the governance summary."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ...core.database import get_db
from ...seed import PRODUCTS
from .. import executive, governance, overview as ov
from ..models import User
from ..rbac import require, require_any
from .common import _insights_for, fired_alerts

router = APIRouter()


@router.get("/executive")
def executive_dashboard(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    """Intake, routing, pipeline, recovery, deviations from plan and exceptions."""
    return executive.dashboard(db, fired_alerts(db))


@router.get("/governance")
def governance_summary(user: User = Depends(require_any("view_compliance", "manage_roles")),
                       db: Session = Depends(get_db)):
    """Encryption, tokenisation, traceability, human review, audit and fairness."""
    return governance.summary(db)


@router.get("/overview")
def overview(product: str = "", process: str = "all", period: int = 30, mine: bool = False,
             user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    """The one dashboard, sliced by card business, process, period and owner."""
    if product and product not in PRODUCTS:
        raise HTTPException(400, f"Unknown card business {product}.")
    if process not in ("all", "collections", "recovery"):
        raise HTTPException(400, "process is all, collections or recovery.")
    out = ov.dashboard(db, user, product or None, process, period if period in (30, 90, 180) else 30, mine)
    out["exceptions"] = executive.exceptions(db, fired_alerts(db))
    out["insights"] = [i for i in _insights_for(db, user) if i["status"] in ("New", "In review")] \
        if user.role == "strategist" else []
    return out
