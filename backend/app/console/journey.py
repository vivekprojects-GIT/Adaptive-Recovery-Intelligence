"""The Collections Journey page: the story of the collections book told with the
book's own numbers, in the order the demo walks it. The problem, the journey as
it runs today, how information flows through CARE, how the target base is
picked, how a campaign runs on it, where CARE steps in, and what it changes."""
from __future__ import annotations

from collections import Counter

from sqlalchemy.orm import Session

from .. import models
from ..seed import COHORTS
from . import overview, router
from .engine import arrears
from .models import Campaign, Decision, Outcome
from .platform import cfg_float


def collections(db: Session, user) -> dict:
    custs = db.query(models.Customer).order_by(models.Customer.customer_id).all()
    group = Counter(c.segment for c in custs)
    route = Counter(c.route or "bau" for c in custs)
    dash = overview.dashboard(db, user, None, "collections", 30, False)
    pr = dash["kpis"]["payment_rate"] or {}
    share = router.validation_share(db)
    tnames = {s.code: s.name for s in db.query(models.Strategy)}
    camps = {c.campaign_id: c.name for c in db.query(Campaign)}

    # Three customers in the same cohort with the same bank risk band, and three different right answers.
    personas = []
    for c in [c for c in custs if c.is_persona]:
        d = (db.query(Decision).filter(Decision.customer_id == c.customer_id)
             .order_by(Decision.decided_at.desc()).first())
        o = db.query(Outcome).filter(Outcome.decision_id == d.decision_id).first() if d else None
        r = router.decide(c, share)
        personas.append({
            "customer_id": c.customer_id, "name": c.name, "account_number": c.account_number, "product": c.product,
            "cohort_id": c.cohort_id, "risk_band": c.client_risk_band, "risk_score": c.client_risk_score,
            "balance": c.balance, "delinquent_amount": arrears(c), "days_past_due": c.days_past_due,
            "nudge_score": c.nudge_score, "self_cure_score": c.self_cure_score,
            "group": router.GROUP_LABEL.get(c.segment, c.segment), "route": c.route,
            "route_label": router.ROUTE_LABEL.get(c.route or "bau"), "why": router.WHY.get(c.segment, ""),
            "reason": r["reason"], "note": c.persona_note,
            "decision": None if d is None else {
                "decision_id": d.decision_id, "strategy": camps.get(d.campaign_id), "campaign_id": d.campaign_id,
                "group": d.group, "treatment": tnames.get(d.treatment_code or ""),
                "probability": d.selection_probability, "explanation": d.explanation,
                "outcome": None if o is None else ("Paid" if o.paid else "Not paid"),
                "amount": o.amount if o else None},
        })

    return {
        "problem": {
            "accounts": len(custs), "delinquent": round(sum(arrears(c) for c in custs), 2),
            "self_cure": group["Sure Thing"], "do_not_contact": group["Sleeping Dog"],
            "needs_support": group["Lost Cause"], "responsive": group["Persuadable"],
        },
        "cohorts": [{"cohort_id": co["cohort_id"], "name": co["name"], "dpd_bucket": co["dpd_bucket"],
                     "risk_band": co["client_risk_band"],
                     "accounts": sum(1 for c in custs if c.cohort_id == co["cohort_id"])} for co in COHORTS],
        "groups": [{"key": g, "label": router.GROUP_LABEL[g], "accounts": group[g],
                    "route": router.ROUTES[g], "route_label": router.ROUTE_LABEL[router.ROUTES[g]],
                    "why": router.WHY[g]} for g in router.ROUTES],
        "routes": {k: route.get(k, 0) for k in ("strategy", "bau", "hardship", "suppress")},
        "personas": personas,
        "strategies": [s for s in dash["strategies"] if s["status"] in ("Live", "Paused")],
        "control_pct": cfg_float(db, "default_control_pct"),
        "results": {"treated": pr.get("treated"), "payment_rate": pr.get("value"), "control_rate": pr.get("control"),
                    "lift": pr.get("lift"), "collected_30d": (dash["kpis"]["collected"] or {}).get("value")},
    }
