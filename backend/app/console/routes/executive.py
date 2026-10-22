"""The executive dashboard (every role's first screen) and the governance summary."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...core.database import get_db
from .. import executive, governance
from ..models import User
from ..rbac import require
from .common import fired_alerts

router = APIRouter()


@router.get("/executive")
def executive_dashboard(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    """Intake, routing, pipeline, recovery, deviations from plan and exceptions."""
    return executive.dashboard(db, fired_alerts(db))


@router.get("/governance")
def governance_summary(user: User = Depends(require("view_compliance")), db: Session = Depends(get_db)):
    """Encryption, tokenisation, traceability, human review, audit and fairness."""
    return governance.summary(db)
