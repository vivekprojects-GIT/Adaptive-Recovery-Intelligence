"""Strategist and leadership dashboards: KPIs, portfolio health, comparison, team."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta


from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session


from ... import models
from ...core.database import get_db
from .. import analytics, scorecards
from ..engine import arrears
from ..models import Campaign, Decision, Nudge, User
from ..rbac import require
from .common import UTC, _get_campaign, _insights_for, _strategy_out, fired_alerts

router = APIRouter()


@router.get("/scorecards")
def model_scorecards(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    """Is the Propensity Router right, and is Thompson sampling picking well?"""
    return {"router": scorecards.router_scorecard(db), "engine": scorecards.engine_scorecard(db)}


@router.get("/dashboard/strategist")
def strategist_dashboard(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    mine = db.query(Campaign).filter(Campaign.owner_id == user.user_id).all()
    ids = [c.campaign_id for c in mine]
    stats = analytics.stats_from_rows(db, analytics._rows(db, ids),
                                      db.query(Nudge).filter(Nudge.campaign_id.in_(ids)).all())
    today = (datetime.now(UTC) - timedelta(days=1)).isoformat(timespec="seconds")
    draft = next((c for c in sorted(mine, key=lambda c: c.updated_at, reverse=True)
                  if c.status == "Draft"), None)
    return {
        "kpis": {"strategies": len(mine), "live": sum(c.status == "Live" for c in mine),
                 "accounts": stats["decisions"], "recovery_rate": stats["recovery_rate"],
                 "uplift": stats["uplift"], "control_rate": stats["control_rate"],
                 "decisions_24h": db.query(Decision).filter(Decision.campaign_id.in_(ids),
                                                            Decision.decided_at >= today).count(),
                 "pending_review": db.query(Decision).filter(Decision.campaign_id.in_(ids),
                                                             Decision.review_status == "pending").count()},
        "draft": _strategy_out(db, draft, stats=False) if draft else None,
        "strategies": [_strategy_out(db, c) for c in sorted(mine, key=lambda c: c.status != "Live")],
        "insights": _insights_for(db, user),
        "weekly": analytics.weekly(db, ids),
    }


@router.get("/kpis")
def kpi_dashboard(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    return {"kpis": analytics.kpis(db), "weekly": analytics.weekly(db),
            "segments": analytics.segment_performance(db), "leaderboard": analytics.leaderboard(db),
            "alerts": fired_alerts(db)}


@router.get("/portfolio-health")
def portfolio_health(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    states = analytics.customer_state(db)
    by_cohort = defaultdict(Counter)
    customers = {c.customer_id: c for c in db.query(models.Customer)}
    for cid, s in states.items():
        by_cohort[customers[cid].cohort_id][s["status"]] += 1
    cohorts_out = []
    for co in db.query(models.Cohort).order_by(models.Cohort.sort_order):
        members = [c for c in customers.values() if c.cohort_id == co.cohort_id]
        ids = [c.customer_id for c in members]
        rows = [(d, o) for d, o in analytics._rows(db) if d.customer_id in set(ids)]
        s = analytics.stats_from_rows(db, rows)
        cohorts_out.append({"cohort_id": co.cohort_id, "name": co.name, "dpd_bucket": co.dpd_bucket,
                            "risk_band": co.client_risk_band, "customers": len(members),
                            "in_strategy": len({d.customer_id for d, _ in rows}),
                            "arrears": round(sum(arrears(c) for c in members), 2),
                            "segments": dict(Counter(c.segment for c in members)),
                            "states": dict(by_cohort[co.cohort_id]), **{k: s[k] for k in (
                                "recovery_rate", "control_rate", "uplift", "recovered")}})
    return {"cohorts": cohorts_out, "pipeline": dict(Counter(s["status"] for s in states.values())),
            "not_in_strategy": len(customers) - len(states), "customers": len(customers)}


@router.get("/compare")
def compare(ids: str, user: User = Depends(require("compare_strategies")), db: Session = Depends(get_db)):
    chosen = [x for x in ids.split(",") if x][:3]
    out = []
    for cid in chosen:
        c = _get_campaign(db, cid)
        out.append({**_strategy_out(db, c), "weekly": analytics.weekly(db, [cid])})
    return {"strategies": out}


@router.get("/team")
def team(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    return {"team": analytics.team(db)}
