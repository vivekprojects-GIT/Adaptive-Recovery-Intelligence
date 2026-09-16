"""AI Recovery Agent - FastAPI backend."""
from __future__ import annotations
from datetime import datetime
from math import lgamma, exp, log

import numpy as np
from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from .db import get_db, engine, Base, SessionLocal
from . import models
from .scoring import (
    risk_score, risk_drivers, nudge_explanation, self_cure_score,
    SEGMENT_ACTION, thompson_sample, context_multipliers,
)
from .seed import seed, BANDIT_PRIOR

app = FastAPI(title="AI Recovery Agent API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

RNG = np.random.default_rng(7)


@app.on_event("startup")
def _startup() -> None:
    Base.metadata.create_all(engine)
    db = SessionLocal()
    try:
        empty = db.query(models.Customer).count() == 0
    finally:
        db.close()
    if empty:
        seed(1000, reset=False)


# --------------------------------------------------------------------------- schemas
class CustomerOut(BaseModel):
    customer_id: int
    name: str
    balance: float
    credit_limit: float
    utilization: float
    tenure_years: int
    sms_responsive: bool
    app_user: bool
    hardship_flag: bool
    missed_payments: int
    payment_history: float
    days_past_due: int
    risk_score: float
    nudge_score: float
    self_cure_score: float
    segment: str
    treatment: str
    outcome: str
    is_persona: bool
    persona_note: str

    class Config:
        from_attributes = True


class ScoreRequest(BaseModel):
    customer_id: int


class OutcomeRequest(BaseModel):
    customer_id: int
    journey_id: int
    success: bool


# --------------------------------------------------------------------------- customers
@app.get("/customers", response_model=list[CustomerOut])
def list_customers(
    db: Session = Depends(get_db),
    segment: str | None = None,
    search: str | None = None,
    min_risk: float = 0,
    limit: int = Query(200, le=2000),
    offset: int = 0,
):
    q = db.query(models.Customer)
    if segment and segment != "All":
        q = q.filter(models.Customer.segment == segment)
    if search:
        q = q.filter(models.Customer.name.ilike(f"%{search}%"))
    if min_risk:
        q = q.filter(models.Customer.risk_score >= min_risk)
    q = q.order_by(models.Customer.is_persona.desc(), models.Customer.risk_score.desc())
    return q.offset(offset).limit(limit).all()


@app.get("/customers/{customer_id}", response_model=CustomerOut)
def get_customer(customer_id: int, db: Session = Depends(get_db)):
    c = db.get(models.Customer, customer_id)
    if not c:
        raise HTTPException(404, "Customer not found")
    return c


def _require(db: Session, cid: int) -> models.Customer:
    c = db.get(models.Customer, cid)
    if not c:
        raise HTTPException(404, "Customer not found")
    return c


# --------------------------------------------------------------------------- models
@app.post("/risk-score")
def post_risk_score(req: ScoreRequest, db: Session = Depends(get_db)):
    c = _require(db, req.customer_id)
    score = risk_score(c)
    return {
        "customer_id": c.customer_id,
        "name": c.name,
        "risk_score": score,
        "band": "High" if score >= 70 else "Medium" if score >= 40 else "Low",
        "drivers": risk_drivers(c),
    }


@app.post("/nudge-score")
def post_nudge_score(req: ScoreRequest, db: Session = Depends(get_db)):
    c = _require(db, req.customer_id)
    exp_ = nudge_explanation(c)
    return {
        "customer_id": c.customer_id,
        "name": c.name,
        "nudge_score": exp_["score"],
        "self_cure_score": exp_["self_cure_score"],
        "segment": exp_["segment"],
        "recommended_action": SEGMENT_ACTION[exp_["segment"]],
        "contributions": exp_["contributions"],
        "severity_penalty": exp_["severity_penalty"],
    }


@app.post("/recommend-journey")
def recommend_journey(req: ScoreRequest, db: Session = Depends(get_db)):
    c = _require(db, req.customer_id)
    journeys = db.query(models.Journey).order_by(models.Journey.journey_id).all()
    stats = {s.journey_id: s for s in db.query(models.BanditStat).all()}
    ranking = thompson_sample(journeys, stats, c, RNG)
    best = ranking[0]
    eligible = c.segment == "Persuadable"
    return {
        "customer_id": c.customer_id,
        "name": c.name,
        "segment": c.segment,
        "eligible_for_bandit": eligible,
        "gate_reason": None if eligible else SEGMENT_ACTION[c.segment],
        "journey": best["journey_name"],
        "journey_id": best["journey_id"],
        "score": best["score"],
        "ranking": ranking,
        "context_multipliers": context_multipliers(c),
    }


@app.post("/record-outcome")
def record_outcome(req: OutcomeRequest, db: Session = Depends(get_db)):
    """Feedback loop - update the Beta posterior for the chosen arm."""
    c = _require(db, req.customer_id)
    st = db.query(models.BanditStat).filter_by(journey_id=req.journey_id).first()
    if not st:
        raise HTTPException(404, "Journey not found")
    if req.success:
        st.successes += 1
    else:
        st.failures += 1
    db.add(models.Intervention(
        customer_id=c.customer_id, journey_id=req.journey_id,
        outcome="success" if req.success else "failure", created_at=datetime.utcnow(),
    ))
    db.commit()
    return {"journey_id": req.journey_id, "successes": st.successes, "failures": st.failures,
            "posterior_mean": round(st.successes / (st.successes + st.failures), 4)}


# --------------------------------------------------------------------------- journeys / bandit
@app.get("/journeys")
def list_journeys(db: Session = Depends(get_db)):
    journeys = db.query(models.Journey).order_by(models.Journey.journey_id).all()
    stats = {s.journey_id: s for s in db.query(models.BanditStat).all()}
    out = []
    for j in journeys:
        s = stats[j.journey_id]
        n = s.successes + s.failures
        mean = s.successes / max(n, 1)
        sd = float(np.sqrt(mean * (1 - mean) / max(n + 1, 1)))
        out.append({
            "journey_id": j.journey_id, "journey_code": j.journey_code, "journey_name": j.journey_name,
            "description": j.description, "cost_per_contact": j.cost_per_contact,
            "successes": s.successes, "failures": s.failures, "trials": n,
            "posterior_mean": round(mean, 4),
            "ci_low": round(max(mean - 1.96 * sd, 0), 4), "ci_high": round(min(mean + 1.96 * sd, 1), 4),
        })
    return out


@app.get("/bandit/posterior")
def posterior_curves(db: Session = Depends(get_db), points: int = 100):
    """Beta PDFs for every arm, for the belief-distribution chart."""
    journeys = db.query(models.Journey).order_by(models.Journey.journey_id).all()
    stats = {s.journey_id: s for s in db.query(models.BanditStat).all()}
    # Focus the x-range on where the mass actually is, so the curves fill the chart.
    lo, hi = 1.0, 0.0
    for j in journeys:
        s = stats[j.journey_id]
        a, b = s.successes + 1, s.failures + 1
        mean = a / (a + b)
        sd = (mean * (1 - mean) / (a + b + 1)) ** 0.5
        lo, hi = min(lo, mean - 4.5 * sd), max(hi, mean + 4.5 * sd)
    lo, hi = max(lo, 0.005), min(hi, 0.995)
    xs = np.linspace(lo, hi, points)
    rows = []
    for i, x in enumerate(xs):
        row = {"x": round(float(x), 4)}
        for j in journeys:
            s = stats[j.journey_id]
            a, b = s.successes + 1, s.failures + 1
            logB = lgamma(a) + lgamma(b) - lgamma(a + b)
            row[j.journey_name] = round(exp((a - 1) * log(x) + (b - 1) * log(1 - x) - logB), 4)
        rows.append(row)
    return {"series": [j.journey_name for j in journeys], "data": rows}


@app.post("/bandit/simulate")
def simulate_rounds(rounds: int = 50, db: Session = Depends(get_db)):
    """Run N Persuadable customers through the bandit and feed outcomes back."""
    journeys = db.query(models.Journey).order_by(models.Journey.journey_id).all()
    stats = {s.journey_id: s for s in db.query(models.BanditStat).all()}
    pool = (db.query(models.Customer).filter(models.Customer.segment == "Persuadable")
            .order_by(func.random()).limit(rounds).all())
    # Latent true conversion rates the simulator draws outcomes from.
    true_rate = {"J1": 0.22, "J2": 0.46, "J3": 0.34, "J4": 0.18, "J5": 0.27}
    picks: dict[str, int] = {}
    wins = 0
    for c in pool:
        ranking = thompson_sample(journeys, stats, c, RNG)
        best = ranking[0]
        # Context lifts the true rate, but only partially - fit is not destiny.
        m = best["context_multiplier"]
        p = min(true_rate[best["journey_code"]] * (1.0 + 0.30 * (m - 1.0)), 0.85)
        success = bool(RNG.random() < p)
        st = stats[best["journey_id"]]
        if success:
            st.successes += 1
            wins += 1
        else:
            st.failures += 1
        picks[best["journey_name"]] = picks.get(best["journey_name"], 0) + 1
        db.add(models.Intervention(customer_id=c.customer_id, journey_id=best["journey_id"],
                                   sampled_score=best["score"],
                                   outcome="success" if success else "failure"))
    db.commit()
    return {"rounds": len(pool), "successes": wins,
            "conversion_rate": round(wins / max(len(pool), 1), 4), "allocation": picks}


@app.post("/bandit/reset")
def reset_bandit(flat: bool = False, db: Session = Depends(get_db)):
    """Restore the historical priors, or wipe to a flat Beta(1,1) to demo cold-start exploration."""
    for j in db.query(models.Journey).all():
        st = db.query(models.BanditStat).filter_by(journey_id=j.journey_id).first()
        st.successes, st.failures = (1, 1) if flat else BANDIT_PRIOR[j.journey_code]
    db.query(models.Intervention).delete()
    db.commit()
    return {"status": "reset", "mode": "flat" if flat else "priors"}


# --------------------------------------------------------------------------- dashboard
EXPECTED_LIFT = {"Persuadable": 0.42, "Sure Thing": 0.03, "Lost Cause": 0.08, "Sleeping Dog": -0.05}
BLANKET_CONTACT_COST = 6.50   # cost of treating every delinquent account with an agent call
HIGH_RISK_THRESHOLD = 50.0
CYCLES_PER_YEAR = 12


@app.get("/dashboard")
def dashboard(db: Session = Depends(get_db)):
    total = db.query(models.Customer).count()
    high_risk = db.query(models.Customer).filter(models.Customer.risk_score >= HIGH_RISK_THRESHOLD).count()
    seg_rows = db.query(models.Customer.segment, func.count(), func.sum(models.Customer.balance)) \
                 .group_by(models.Customer.segment).all()
    segments = [{"segment": s, "count": n, "balance": round(float(b or 0), 2)} for s, n, b in seg_rows]
    by_seg = {s["segment"]: s for s in segments}

    persuadable = by_seg.get("Persuadable", {"count": 0, "balance": 0.0})
    interventions = int(persuadable["count"] * 0.79)
    recoveries = int(interventions * 0.82)
    expected_recovery = sum(
        float(by_seg.get(s, {}).get("balance", 0.0)) * EXPECTED_LIFT[s] for s in EXPECTED_LIFT
    )
    targeted_contacts = persuadable["count"] + by_seg.get("Lost Cause", {}).get("count", 0)
    savings = (total - targeted_contacts) * BLANKET_CONTACT_COST

    return {
        "total_customers": total,
        "high_risk": high_risk,
        "persuadables": persuadable["count"],
        "expected_recovery": round(expected_recovery, 2),
        "projected_savings": round(savings, 2),
        "annual_savings": round(savings * CYCLES_PER_YEAR, 2),
        "contacts_avoided": total - targeted_contacts,
        "contact_reduction_pct": round(100 * (1 - targeted_contacts / max(total, 1)), 1),
        "segments": sorted(segments, key=lambda s: -s["count"]),
        "funnel": [
            {"stage": "Total customers", "value": total},
            {"stage": "High risk", "value": high_risk},
            {"stage": "Persuadable", "value": persuadable["count"]},
            {"stage": "Interventions", "value": interventions},
            {"stage": "Recoveries", "value": recoveries},
        ],
        "risk_distribution": _risk_histogram(db),
        "outcomes": [{"outcome": o, "count": n} for o, n in
                     db.query(models.Customer.outcome, func.count()).group_by(models.Customer.outcome).all()],
    }


def _risk_histogram(db: Session):
    buckets = [(0, 20), (20, 40), (40, 60), (60, 80), (80, 101)]
    out = []
    for lo, hi in buckets:
        n = db.query(models.Customer).filter(
            models.Customer.risk_score >= lo, models.Customer.risk_score < hi).count()
        out.append({"band": f"{lo}-{min(hi, 100)}", "count": n})
    return out


@app.get("/personas", response_model=list[CustomerOut])
def personas(db: Session = Depends(get_db)):
    return db.query(models.Customer).filter(models.Customer.is_persona.is_(True)) \
             .order_by(models.Customer.customer_id).all()


@app.get("/journey-simulation/{customer_id}")
def journey_simulation(customer_id: int, db: Session = Depends(get_db)):
    c = _require(db, customer_id)
    r = f"{c.risk_score}%"
    if c.segment == "Persuadable":
        steps = [
            ("Day 0", "Payment missed", f"Risk model fires at {r} risk of roll-forward", "trigger"),
            ("Day 3", "Split Payment Plan sent", "Bandit selected J2 ahead of SMS and Call", "action"),
            ("Day 7", "Plan accepted", "Customer accepted a 3-instalment schedule in-app", "positive"),
            ("Day 14", "First payment received", "Instalment 1 cleared", "positive"),
            ("Day 29", "Account current", "Arrears cleared, account back in good standing", "positive"),
            ("Day 90", "Sustained cure", "No re-delinquency - success fed back to the bandit", "success"),
        ]
    elif c.segment == "Sure Thing":
        steps = [
            ("Day 0", "Payment missed", f"Risk {r} but nudge propensity is low", "trigger"),
            ("Day 2", "Reminder SMS", "Cheapest possible touch - no agent time spent", "action"),
            ("Day 4", "Payment received", "Customer would most likely have paid regardless", "positive"),
            ("Day 90", "Self-cured", "No intensive treatment spent on this account", "success"),
        ]
    elif c.segment == "Lost Cause":
        steps = [
            ("Day 0", "Payment missed", f"Risk {r}, severe hardship detected", "trigger"),
            ("Day 1", "Routed to hardship team", "Standard nudges would not change this outcome", "action"),
            ("Day 10", "Affordability assessment", "Income loss confirmed", "neutral"),
            ("Day 21", "Hardship plan agreed", "Reduced payment, interest frozen", "positive"),
            ("Day 90", "Assisted route", "Account stabilised under special servicing", "success"),
        ]
    else:
        steps = [
            ("Day 0", "Payment missed", f"Risk {r}, nudge propensity very low", "trigger"),
            ("Day 1", "Suppressed from outreach", "Contact would risk a negative reaction", "action"),
            ("Day 90", "Monitored only", "No contact cost incurred", "neutral"),
        ]
    return {"customer_id": c.customer_id, "name": c.name, "segment": c.segment,
            "steps": [{"day": d, "title": t, "detail": x, "kind": k} for d, t, x, k in steps]}


@app.post("/admin/reseed")
def reseed(n: int = 1000):
    return seed(n, reset=True)


@app.get("/health")
def health():
    return {"status": "ok"}
