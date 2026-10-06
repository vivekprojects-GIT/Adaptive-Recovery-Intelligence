"""Alerts raised from the alert rules, and managing the rules."""
from __future__ import annotations

from collections import Counter


from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session


from ...core.database import get_db
from ..models import AlertRule, User
from ..platform import audit, now
from ..rbac import require
from .common import METRIC_LABELS, fired_alerts

router = APIRouter()


@router.get("/alerts")
def alerts(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    return fired_alerts(db)


class AlertIn(BaseModel):
    name: str = Field(min_length=3)
    metric: str
    comparator: str = Field(pattern="^(lt|gt)$")
    threshold: float
    severity: str = Field(pattern="^(Critical|High|Medium|Low)$")
    enabled: bool = True
    notify: str = ""


@router.get("/admin/alerts")
def list_alert_rules(user: User = Depends(require("manage_alert_rules")), db: Session = Depends(get_db)):
    fired = Counter(a["rule_id"] for a in fired_alerts(db))
    return {"rules": [{**{k: getattr(r, k) for k in ("rule_id", "name", "metric", "comparator", "threshold",
                                                    "scope", "severity", "enabled", "notify", "updated_at")},
                       "metric_label": METRIC_LABELS.get(r.metric, r.metric), "firing": fired.get(r.rule_id, 0)}
                      for r in db.query(AlertRule).order_by(AlertRule.rule_id)],
            "metrics": [{"key": k, "label": v} for k, v in METRIC_LABELS.items()]}


@router.post("/admin/alerts")
def create_alert(body: AlertIn, user: User = Depends(require("manage_alert_rules")), db: Session = Depends(get_db)):
    if body.metric not in METRIC_LABELS:
        raise HTTPException(400, "Unknown metric.")
    r = AlertRule(**body.model_dump(), scope="campaign" if body.metric.startswith("campaign") else "portfolio",
                  created_by=user.user_id, updated_at=now())
    db.add(r)
    db.flush()
    audit(db, user.user_id, "CREATE", "alert_rule", str(r.rule_id), f"Created alert rule '{body.name}'")
    db.commit()
    return {"rule_id": r.rule_id}


@router.put("/admin/alerts/{rid}")
def update_alert(rid: int, body: AlertIn, user: User = Depends(require("manage_alert_rules")),
                 db: Session = Depends(get_db)):
    r = db.get(AlertRule, rid)
    if not r:
        raise HTTPException(404, "Rule not found.")
    for k, v in body.model_dump().items():
        setattr(r, k, v)
    r.updated_at = now()
    audit(db, user.user_id, "UPDATE", "alert_rule", str(rid), f"Updated alert rule '{body.name}'")
    db.commit()
    return {"ok": True}


@router.delete("/admin/alerts/{rid}")
def delete_alert(rid: int, user: User = Depends(require("manage_alert_rules")), db: Session = Depends(get_db)):
    r = db.get(AlertRule, rid)
    if not r:
        raise HTTPException(404, "Rule not found.")
    db.delete(r)
    audit(db, user.user_id, "DELETE", "alert_rule", str(rid), f"Deleted alert rule '{r.name}'")
    db.commit()
    return {"ok": True}
