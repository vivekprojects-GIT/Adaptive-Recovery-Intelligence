"""The AI Workbench and the insights a leader sends to a strategy owner."""
from __future__ import annotations

import json


from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session


from ...core.database import get_db
from .. import insights
from ..models import Campaign, Insight, User
from ..platform import audit, now
from ..rbac import current_user, require
from .common import COPY_FIELDS, _copy, _get_campaign, _has_decisions, _insights_for, _make_revision, _user_names

router = APIRouter()


@router.get("/workbench")
def workbench(user: User = Depends(require("use_ai_workbench")), db: Session = Depends(get_db)):
    return {"areas": insights.problem_areas(db), "sent": _insights_for(db, user)}


@router.get("/workbench/areas/{area_id}")
def area_ideas(area_id: str, user: User = Depends(require("use_ai_workbench")), db: Session = Depends(get_db)):
    area = next((a for a in insights.problem_areas(db) if a["id"] == area_id), None)
    if not area:
        raise HTTPException(404, "That problem area is no longer active.")
    return {"area": area, "ideas": [i | {"area_id": area_id, "campaign_id": area.get("campaign_id")}
                                    for i in insights.ideas_for(db, area)]}


class AskIn(BaseModel):
    text: str = Field(min_length=3)


@router.post("/workbench/ask")
def ask(body: AskIn, user: User = Depends(require("use_ai_workbench")), db: Session = Depends(get_db)):
    return insights.answer(db, body.text)


class SendInsightIn(BaseModel):
    title: str
    body: str
    evidence: str = ""
    priority: str = "Medium"
    campaign_id: str | None = None
    change: dict = {}
    to_user: str | None = None


@router.post("/insights")
def send_insight(body: SendInsightIn, user: User = Depends(require("use_ai_workbench")),
                 db: Session = Depends(get_db)):
    to = body.to_user
    if not to and body.campaign_id:
        c = db.get(Campaign, body.campaign_id)
        to = c.owner_id if c else None
    if not to:
        raise HTTPException(400, "Choose who to send this to.")
    n = db.query(Insight).count() + 1
    i = Insight(insight_id=f"IN-{n:03d}", campaign_id=body.campaign_id, from_user=user.user_id, to_user=to,
                title=body.title, body=body.body, evidence=body.evidence, priority=body.priority,
                proposed_change=json.dumps(body.change), created_at=now())
    db.add(i)
    audit(db, user.user_id, "CREATE", "insight", i.insight_id, f"Sent '{body.title}' to {_user_names(db).get(to)}")
    db.commit()
    return {"insight_id": i.insight_id}


@router.get("/insights")
def my_insights(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _insights_for(db, user)


class RespondIn(BaseModel):
    action: str = Field(pattern="^(accept|review|decline|apply)$")
    note: str = ""


@router.post("/insights/{iid}/respond")
def respond(iid: str, body: RespondIn, user: User = Depends(require("edit_strategy")),
            db: Session = Depends(get_db)):
    i = db.get(Insight, iid)
    if not i or i.to_user != user.user_id:
        raise HTTPException(404, "Insight not found in your inbox.")
    i.responded_at, i.response_note = now(), body.note or None
    result: dict = {"ok": True}
    if body.action == "apply":
        change = json.loads(i.proposed_change or "{}")
        if not change or not i.campaign_id:
            raise HTTPException(400, "This insight has no strategy change to apply.")
        src = _get_campaign(db, i.campaign_id)
        # Applying never edits a running strategy: the change lands on its next
        # version, a draft that goes through approval like anything else.
        if src.status in ("Live", "Paused") and _has_decisions(db, src.campaign_id):
            new, _ = _make_revision(db, src, user)
        else:
            new = _copy(db, src, user, name=f"{src.name} (from {iid})", source="insight", steps_completed=5)
        for k, v in change.items():
            if k in COPY_FIELDS:
                setattr(new, k, json.dumps(v) if isinstance(v, list) else v)
        if new.status != "Draft":
            new.status = "Draft"
            new.approved_by = new.approved_at = new.submitted_at = None
        new.updated_at = now()
        new.description = f"{src.description}\n\nChange from {iid}: {i.title}"
        i.status = "Applied"
        result["campaign_id"] = new.campaign_id
        audit(db, user.user_id, "UPDATE", "insight", iid, f"Applied {iid} as draft {new.campaign_id}")
    else:
        i.status = {"accept": "Accepted", "review": "In review", "decline": "Declined"}[body.action]
        audit(db, user.user_id, "UPDATE", "insight", iid, f"{i.status} insight {iid}")
    db.commit()
    return result
