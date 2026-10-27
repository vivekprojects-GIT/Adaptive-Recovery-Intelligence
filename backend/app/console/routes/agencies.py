"""Outsourced collections: the agency panel, placements and their approval."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ... import models
from ...core.database import get_db
from .. import agencies
from ..models import User
from ..rbac import require

router = APIRouter()


class ReviewIn(BaseModel):
    approve: bool
    note: str = ""


class NoteIn(BaseModel):
    note: str = ""


class ProposeIn(BaseModel):
    customer_id: int
    reason: str = ""


def _fail(e: Exception):
    code = 404 if isinstance(e, LookupError) else 403 if isinstance(e, PermissionError) else 400
    raise HTTPException(code, str(e))


@router.get("/agencies")
def agency_panel(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    """Each agency's contract terms and results: placed, recovered, fees, net recovery."""
    return agencies.performance(db)


@router.get("/placements")
def placement_list(status: str = "", agency_id: str = "", user: User = Depends(require("view_kpi_dashboard")),
                   db: Session = Depends(get_db)):
    return agencies.placements(db, status or None, agency_id or None)


@router.get("/placements/eligibility/{customer_id}")
def placement_eligibility(customer_id: int, user: User = Depends(require("view_customer_list")),
                          db: Session = Depends(get_db)):
    c = db.get(models.Customer, customer_id)
    if c is None:
        raise HTTPException(404, "Customer not found")
    ok, why = agencies.eligibility(db, c)
    agency, match_why = agencies.match(db, c) if ok else (None, "")
    return {"eligible": ok and agency is not None, "reason": why if not ok else match_why,
            "agency": agency.name if agency else None}


@router.post("/placements")
def propose_placement(body: ProposeIn, user: User = Depends(require("override_decisions")),
                      db: Session = Depends(get_db)):
    """A person proposes one account. Someone else approves it."""
    c = db.get(models.Customer, body.customer_id)
    if c is None:
        raise HTTPException(404, "Customer not found")
    try:
        p = agencies.propose(db, c, user.user_id, reason=body.reason.strip())
    except ValueError as e:
        _fail(e)
    db.commit()
    return agencies.placements(db)[0] if p else None


@router.post("/placements/scan")
def scan_for_placements(user: User = Depends(require("override_decisions")), db: Session = Depends(get_db)):
    """CARE proposes eligible late-stage accounts. Every proposal waits for approval."""
    made = agencies.propose_batch(db, "system", limit=10)
    db.commit()
    return {"proposed": len(made), "placement_ids": [p.placement_id for p in made]}


@router.post("/placements/{placement_id}/review")
def review_placement(placement_id: str, body: ReviewIn, user: User = Depends(require("approve_placements")),
                     db: Session = Depends(get_db)):
    try:
        agencies.review(db, placement_id, body.approve, user.user_id, body.note)
    except (LookupError, PermissionError, ValueError) as e:
        _fail(e)
    db.commit()
    return next(r for r in agencies.placements(db) if r["placement_id"] == placement_id)


@router.post("/placements/{placement_id}/recall")
def recall_placement(placement_id: str, body: NoteIn, user: User = Depends(require("approve_placements")),
                     db: Session = Depends(get_db)):
    try:
        agencies.recall(db, placement_id, user.user_id, body.note)
    except (LookupError, ValueError) as e:
        _fail(e)
    db.commit()
    return next(r for r in agencies.placements(db) if r["placement_id"] == placement_id)
