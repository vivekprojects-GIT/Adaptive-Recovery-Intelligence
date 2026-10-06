"""The treatment playbook: business-authored treatments and their rules."""
from __future__ import annotations

from collections import Counter


from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session


from ... import models
from ...core.database import get_db
from ...scoring import KINDS, check_rules
from .. import playbook
from ..models import User
from ..rbac import require

router = APIRouter()


@router.get("/treatments")
def treatments(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    return playbook.list_treatments(db)


KIND_HELP = {
    "Reminder": "A prompt to pay. Suits customers who respond to SMS; weak once arrears are severe.",
    "Digital nudge": "An in-app prompt. Suits active app users and costs almost nothing.",
    "Arrangement": "Spreads the arrears into instalments. Suits temporary hardship and maxed-out cards.",
    "Deferral": "Moves the due date. Suits a short-term cash-flow gap.",
    "Outreach": "A person makes contact. Suits customers who ignore digital channels.",
    "Hardship": "An affordability review. Suits severe, ongoing hardship.",
}


RULE_SCHEMA = [
    {"key": "requires_app_user", "label": "Active mobile-app users only", "type": "bool"},
    {"key": "requires_sms_responsive", "label": "Responds to SMS", "type": "bool"},
    {"key": "requires_hardship_flag", "label": "Hardship flag on file", "type": "bool"},
    {"key": "min_balance", "label": "Minimum balance", "type": "money"},
    {"key": "max_missed_payments", "label": "Most missed payments in 12 months", "type": "int"},
    {"key": "min_tenure_years", "label": "Minimum tenure (years)", "type": "number"},
    {"key": "min_payment_history", "label": "Minimum on-time payment history", "type": "percent"},
    {"key": "min_dpd", "label": "Minimum days past due", "type": "int"},
    {"key": "max_dpd", "label": "Maximum days past due", "type": "int"},
]


@router.get("/treatments/schema")
def treatment_schema(user: User = Depends(require("view_kpi_dashboard"))):
    return {"kinds": [{"kind": k, "help": KIND_HELP[k]} for k in KINDS], "channels": playbook.CHANNELS,
            "rules": RULE_SCHEMA}


class RulesIn(BaseModel):
    rules: dict = {}


@router.post("/treatments/preview")
def treatment_preview(body: RulesIn, user: User = Depends(require("view_kpi_dashboard")),
                      db: Session = Depends(get_db)):
    """Who a rule set would reach, before it is saved."""
    try:
        rules = playbook._clean_rules(body.rules)
    except (playbook.PlaybookError, TypeError, ValueError) as e:
        raise HTTPException(400, str(e) or "Invalid rule value.")
    from ...scoring import describe_rules
    by_cohort: dict[str, dict] = {}
    total = eligible = persuadable = 0
    reasons: Counter = Counter()
    for c in db.query(models.Customer):
        total += 1
        ok, why = check_rules(rules, c)
        row = by_cohort.setdefault(c.cohort_id, {"cohort_id": c.cohort_id, "customers": 0, "eligible": 0,
                                                 "persuadable": 0})
        row["customers"] += 1
        if ok:
            eligible += 1
            row["eligible"] += 1
            if c.segment == "Persuadable":
                persuadable += 1
                row["persuadable"] += 1
        else:
            reasons[why] += 1
    return {"rule": describe_rules(rules), "customers": total, "eligible": eligible, "persuadable": persuadable,
            "by_cohort": sorted(by_cohort.values(), key=lambda r: r["cohort_id"]),
            "excluded_by": [{"reason": r, "count": n} for r, n in reasons.most_common(4)]}


class TreatmentIn(BaseModel):
    name: str = Field(min_length=3, max_length=80)
    kind: str
    channel: str = Field(min_length=2, max_length=60)
    offer: str = Field(min_length=3, max_length=400)
    timing: str = Field("Day 1", max_length=60)
    cost: float = Field(0.0, ge=0, le=500)
    human_review: bool = False
    rules: dict = {}


def _playbook_call(fn, *args, status: int = 400):
    try:
        return fn(*args)
    except playbook.PlaybookError as e:
        raise HTTPException(status, str(e))
    except (TypeError, ValueError):
        raise HTTPException(400, "A rule has an invalid value.")


@router.post("/treatments")
def create_treatment(body: TreatmentIn, user: User = Depends(require("manage_treatments")),
                     db: Session = Depends(get_db)):
    return _playbook_call(playbook.create, db, body.model_dump(), user.user_id)


@router.put("/treatments/{code}")
def update_treatment(code: str, body: TreatmentIn, user: User = Depends(require("manage_treatments")),
                     db: Session = Depends(get_db)):
    return _playbook_call(playbook.update, db, code, body.model_dump(), user.user_id)


@router.post("/treatments/{code}/retire")
def retire_treatment(code: str, user: User = Depends(require("manage_treatments")), db: Session = Depends(get_db)):
    return _playbook_call(playbook.set_status, db, code, "Retired", user.user_id, status=409)


@router.post("/treatments/{code}/activate")
def activate_treatment(code: str, user: User = Depends(require("manage_treatments")),
                       db: Session = Depends(get_db)):
    return _playbook_call(playbook.set_status, db, code, "Active", user.user_id, status=409)


@router.delete("/treatments/{code}")
def delete_treatment(code: str, user: User = Depends(require("manage_treatments")), db: Session = Depends(get_db)):
    return _playbook_call(playbook.delete, db, code, user.user_id, status=409)
