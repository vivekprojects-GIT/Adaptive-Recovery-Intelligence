"""Signed-in user, persona list and the platform status shown in the header."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session


from ...core.database import get_db
from ..models import Campaign, ComplianceViolation, Decision, Handoff, Insight, PlatformConfig, User
from ..platform import METRICS, cfg, now
from ..rbac import ROLES, current_user, granted

router = APIRouter()


@router.get("/users/public")
def users_public(db: Session = Depends(get_db)):
    """Persona switcher. In production this is the SSO login, not a list."""
    return [{"user_id": u.user_id, "name": u.name, "role": u.role, "role_label": ROLES[u.role],
             "status": u.status} for u in db.query(User).order_by(User.role, User.name)]


@router.get("/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    perms = sorted(granted(db, user.role))
    user.last_login = now()
    db.commit()
    mine = db.query(Campaign).filter(Campaign.owner_id == user.user_id)
    return {
        "user": {"user_id": user.user_id, "name": user.name, "email": user.email, "role": user.role,
                 "role_label": ROLES[user.role]},
        "permissions": perms,
        "badges": {
            "live_campaigns": mine.filter(Campaign.status == "Live").count(),
            "open_violations": db.query(ComplianceViolation).filter(
                ComplianceViolation.status != "Resolved",
                ComplianceViolation.severity.in_(["Critical", "High"])).count(),
            "pending_review": db.query(Decision).filter(Decision.review_status == "pending").count(),
            "awaiting_approval": db.query(Campaign).filter(Campaign.status == "In review").count(),
            "new_insights": db.query(Insight).filter(Insight.to_user == user.user_id,
                                                     Insight.status == "New").count(),
        },
        "agent": {"decisions_total": db.query(func.count(Decision.decision_id)).scalar(),
                  "shadow_mode": cfg(db, "shadow_mode") == "true",
                  "model_version": cfg(db, "model_version")},
    }


@router.get("/status")
def platform_status(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The header status menu: each part of the platform, its state and when it
    last did something. Read by every signed-in user, so nothing sensitive."""
    shadow = cfg(db, "shadow_mode") == "true"
    m = METRICS.snapshot()
    scanned = db.get(PlatformConfig, "_compliance_scanned_until")
    components = [
        {"name": "Decision service", "status": "Operational" if m["error_rate"] < 0.01 else "Degraded",
         "detail": "Last decision", "at": db.query(func.max(Decision.decided_at))
            .filter(Decision.decided_at <= now()).scalar()},
        {"name": "Customer channels", "status": "Not connected",
         "detail": "Decisions are recorded; no message is sent until a channel gateway is connected", "at": None},
        {"name": "Collections handoff", "status": "Operational", "detail": "Last handoff",
         "at": db.query(func.max(Handoff.at)).scalar()},
        {"name": "Compliance monitor", "status": "Operational", "detail": "Last scan",
         "at": scanned.value if scanned else None},
    ]
    degraded = any(c["status"] == "Degraded" for c in components)
    return {"overall": "Degraded" if degraded else "Operational", "mode": "shadow" if shadow else "live",
            "model_version": cfg(db, "model_version"), "components": components}
