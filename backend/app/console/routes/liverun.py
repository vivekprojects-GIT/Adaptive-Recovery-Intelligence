"""Live run: follow one customer through a live strategy, step by step."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ...core.database import get_db
from .. import engine, liverun
from ..models import Campaign, User
from ..platform import audit
from ..rbac import require

router = APIRouter()


class RunIn(BaseModel):
    strategy: str
    scenario: str = Field(pattern="^(pays|retry)$")


@router.get("/live-run/strategies")
def strategies(user: User = Depends(require("view_ai_decisions")), db: Session = Depends(get_db)):
    return liverun.strategies(db)


@router.post("/live-run")
def run(body: RunIn, user: User = Depends(require("launch_strategy")), db: Session = Depends(get_db)):
    camp = db.get(Campaign, body.strategy)
    if not camp:
        raise HTTPException(404, f"No strategy {body.strategy}.")
    if camp.status != "Live":
        raise HTTPException(409, "Only a live strategy contacts customers.")
    with engine.ENGINE_LOCK:
        out = liverun.run(db, body.strategy, body.scenario)
        if out is None:
            raise HTTPException(409, "No waiting customer in this strategy fits that scenario now. "
                                     "Pick another strategy, or receive the next handoff.")
        ids = ", ".join(a["decision_id"] for a in out["attempts"])
        audit(db, user.user_id, "UPDATE", "strategy", body.strategy,
              f"Live run for {body.strategy}: customer {out['customer']['id']}, decisions {ids}",
              {"scenario": body.scenario, "decisions": ids})
        db.commit()
    return out
