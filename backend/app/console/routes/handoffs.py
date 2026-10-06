"""Cohort handoffs from the collections system, and the cohort overview."""
from __future__ import annotations

from collections import Counter


from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session


from ... import models
from ...core.database import get_db
from ...scoring import SEGMENT_ACTION
from .. import engine, playbook
from ..models import User
from ..platform import cfg
from ..rbac import require

router = APIRouter()


@router.get("/handoffs")
def list_handoffs(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    return {"handoffs": playbook.handoffs(db), "auto": cfg(db, "auto_handoff") == "true",
            "next_sizes": playbook.HANDOFF_SIZES}


@router.post("/handoffs")
def receive_handoff(user: User = Depends(require("launch_strategy")), db: Session = Depends(get_db)):
    with engine.ENGINE_LOCK:
        return playbook.ingest_handoff(db, actor=user.user_id, trigger="manual")


@router.get("/cohorts")
def cohorts(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    out = []
    for co in db.query(models.Cohort).order_by(models.Cohort.sort_order):
        cs = db.query(models.Customer).filter(models.Customer.cohort_id == co.cohort_id).all()
        seg = Counter(c.segment for c in cs)
        out.append({"cohort_id": co.cohort_id, "name": co.name, "dpd_bucket": co.dpd_bucket,
                    "risk_band": co.client_risk_band, "expected_payment": co.expected_payment,
                    "description": co.description, "customers": len(cs),
                    "balance": round(sum(c.balance for c in cs), 2),
                    "segments": dict(seg), "segment_action": SEGMENT_ACTION})
    return out
