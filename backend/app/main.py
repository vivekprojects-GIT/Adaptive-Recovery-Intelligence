"""Adaptive Recovery Intelligence - intervention API.

Scope starts at the intervention point. Collections dashboards, DPD bucketing,
risk scoring and cohort identification belong to the client's existing
systems; this API receives their output as a cohort / customer handoff.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from starlette.routing import Route
import numpy as np

from .db import get_db, engine, Base, SessionLocal
from . import models, experiments
from .scoring import (
    nudge_explanation, SEGMENT_ACTION, eligibility, fit_multiplier, fit_reasons, thompson_rank,
)
from .seed import seed
from .console import models as _console_models  # noqa: F401  (registers console tables)
from .console.api import router as console_router
from .console.mcp_server import ENDPOINT_PATH as MCP_PATH, gateway as mcp_gateway, server as mcp_server
from .console.platform import metrics_middleware
from .console.seed import seed_console


@asynccontextmanager
async def lifespan(_app):
    """Seed, then keep the MCP transport's task group running for the app's
    life. The production entrypoint (server.py) mounts this app and runs this
    same lifespan, because a mounted app's own lifespan never runs."""
    _startup()
    async with mcp_server.session_manager.run():
        yield


app = FastAPI(title="ARI Intervention API", version="4.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)
app.middleware("http")(metrics_middleware)
app.include_router(console_router)
# MCP: agents such as Nova's ask for recovery decisions here (console/mcp_server.py).
app.router.routes.append(Route(MCP_PATH, endpoint=mcp_gateway))

RNG = np.random.default_rng()
SEGMENTS = ["Persuadable", "Sure Thing", "Lost Cause", "Sleeping Dog"]
STRATEGY_BEST_FOR = {
    "S1": "SMS responders who simply forgot",
    "S2": "App users - cheapest touch there is",
    "S3": "Temporary hardship with a manageable balance",
    "S4": "A short-term cash-flow gap",
    "S5": "Customers who ignore digital channels",
    "S6": "Severe, ongoing hardship",
}


def _startup() -> None:
    Base.metadata.create_all(engine)
    db = SessionLocal()
    try:
        empty = db.query(models.Customer).count() == 0 or db.query(models.Strategy).count() == 0
    except Exception:
        empty = True
    finally:
        db.close()
    if empty:
        seed(reset=True)
    db = SessionLocal()
    try:
        seed_console(db)
    finally:
        db.close()




# --------------------------------------------------------------------------- schemas
class CustomerOut(BaseModel):
    customer_id: int
    cohort_id: str
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
    client_risk_band: str
    client_risk_score: float
    nudge_score: float
    self_cure_score: float
    segment: str
    is_persona: bool
    persona_note: str

    class Config:
        from_attributes = True


class ExperimentIn(BaseModel):
    cohort_id: str
    strategies: list[str] = Field(min_length=1)
    control_pct: float = Field(0.20, ge=0.0, le=0.5)
    mode: str = Field("adaptive", pattern="^(adaptive|fixed)$")
    include_segments: list[str] = ["Persuadable"]
    wave_size: int = Field(30, ge=5, le=500)


def _hist_rate(s: models.Strategy) -> float:
    n = s.hist_successes + s.hist_failures
    return s.hist_successes / n if n else 0.0  # a treatment added in the console has no history yet


def _strategy_out(s: models.Strategy) -> dict:
    return {
        "code": s.code, "name": s.name, "channel": s.channel, "offer": s.offer, "timing": s.timing,
        "eligibility_rule": s.eligibility_rule, "cost_per_contact": s.cost_per_contact,
        "hist_success_rate": round(_hist_rate(s), 4),
        "hist_trials": s.hist_successes + s.hist_failures,
        "best_for": STRATEGY_BEST_FOR.get(s.code, ""),
    }


def _customer(db: Session, cid: int) -> models.Customer:
    c = db.get(models.Customer, cid)
    if not c:
        raise HTTPException(404, "Customer not found")
    return c


def _cohort(db: Session, cid: str) -> models.Cohort:
    co = db.get(models.Cohort, cid)
    if not co:
        raise HTTPException(404, "Cohort not found")
    return co


# --------------------------------------------------------------------------- upstream handoff
@app.get("/cohorts")
def list_cohorts(db: Session = Depends(get_db)):
    """What the client's collections system hands over."""
    out = []
    for co in db.query(models.Cohort).order_by(models.Cohort.sort_order).all():
        members = db.query(models.Customer).filter(models.Customer.cohort_id == co.cohort_id).all()
        out.append({
            "cohort_id": co.cohort_id, "name": co.name, "dpd_bucket": co.dpd_bucket,
            "client_risk_band": co.client_risk_band, "expected_payment": co.expected_payment,
            "description": co.description, "customers": len(members),
            "balance": round(sum(m.balance for m in members), 2),
        })
    return out


@app.get("/cohorts/{cohort_id}")
def cohort_detail(cohort_id: str, db: Session = Depends(get_db)):
    co = _cohort(db, cohort_id)
    members = db.query(models.Customer).filter(models.Customer.cohort_id == cohort_id).all()
    n = max(len(members), 1)
    seg = {s: [m for m in members if m.segment == s] for s in SEGMENTS}
    return {
        "cohort_id": co.cohort_id, "name": co.name, "dpd_bucket": co.dpd_bucket,
        "client_risk_band": co.client_risk_band, "expected_payment": co.expected_payment,
        "description": co.description,
        "customers": len(members),
        "balance": round(sum(m.balance for m in members), 2),
        "profile": {
            "avg_balance": round(sum(m.balance for m in members) / n, 2),
            "sms_responsive_pct": round(sum(m.sms_responsive for m in members) / n, 4),
            "app_user_pct": round(sum(m.app_user for m in members) / n, 4),
            "hardship_pct": round(sum(m.hardship_flag for m in members) / n, 4),
            "avg_tenure": round(sum(m.tenure_years for m in members) / n, 1),
            "avg_nudge": round(sum(m.nudge_score for m in members) / n, 1),
        },
        "segments": [
            {"segment": s, "count": len(seg[s]), "balance": round(sum(m.balance for m in seg[s]), 2),
             "action": SEGMENT_ACTION[s]}
            for s in SEGMENTS
        ],
        "personas": [CustomerOut.model_validate(m) for m in members if m.is_persona],
    }


@app.get("/customers", response_model=list[CustomerOut])
def list_customers(
    db: Session = Depends(get_db),
    cohort_id: str | None = None,
    segment: str | None = None,
    search: str | None = None,
    limit: int = Query(300, le=2000),
):
    q = db.query(models.Customer)
    if cohort_id:
        q = q.filter(models.Customer.cohort_id == cohort_id)
    if segment and segment != "All":
        q = q.filter(models.Customer.segment == segment)
    if search:
        q = q.filter(models.Customer.name.ilike(f"%{search}%"))
    q = q.order_by(models.Customer.is_persona.desc(), models.Customer.nudge_score.desc())
    return q.limit(limit).all()


@app.get("/customers/{customer_id}", response_model=CustomerOut)
def get_customer(customer_id: int, db: Session = Depends(get_db)):
    return _customer(db, customer_id)


@app.get("/customers/{customer_id}/fit")
def customer_fit(customer_id: int, db: Session = Depends(get_db)):
    """Intervention fit: how influenceable, how likely to self-cure, which group."""
    c = _customer(db, customer_id)
    e = nudge_explanation(c)
    return {
        "customer_id": c.customer_id, "name": c.name, "nudge_score": e["score"],
        "self_cure_score": e["self_cure_score"], "segment": e["segment"],
        "recommended_action": SEGMENT_ACTION[e["segment"]],
        "contributions": e["contributions"], "severity_penalty": e["severity_penalty"],
    }


# --------------------------------------------------------------------------- strategy sheet
@app.get("/strategies")
def list_strategies(db: Session = Depends(get_db)):
    return [_strategy_out(s) for s in db.query(models.Strategy).order_by(models.Strategy.code).all()]


@app.get("/strategy-sheet/cohort/{cohort_id}")
def cohort_strategy_sheet(cohort_id: str, db: Session = Depends(get_db)):
    co = _cohort(db, cohort_id)
    members = db.query(models.Customer).filter(models.Customer.cohort_id == cohort_id).all()
    target = [m for m in members if m.segment == "Persuadable"]
    rows = []
    for s in db.query(models.Strategy).order_by(models.Strategy.code).all():
        elig_all = [m for m in members if eligibility(s.code, m)[0]]
        elig_t = [m for m in target if eligibility(s.code, m)[0]]
        avg_fit = sum(fit_multiplier(s.code, m) for m in elig_t) / len(elig_t) if elig_t else 0.0
        reach = len(elig_t) / len(target) if target else 0.0
        rows.append({
            **_strategy_out(s),
            "eligible_in_cohort": len(elig_all),
            "eligible_in_target": len(elig_t),
            "reach_in_target": round(reach, 4),
            "avg_fit": round(avg_fit, 3),
            "expected_score": round(_hist_rate(s) * avg_fit, 4),
            # Expected success, discounted for cost - a $6.50 specialist review must beat
            # a $0.02 push by a real margin to be worth recommending.
            "value_score": round(_hist_rate(s) * avg_fit / (1 + s.cost_per_contact / 10), 4),
            "est_cost": round(s.cost_per_contact * len(elig_t), 2),
        })
    ranked = sorted([r for r in rows if r["reach_in_target"] >= 0.20], key=lambda r: -r["value_score"])
    top = {r["code"] for r in ranked[:3]}
    for r in rows:
        if r["reach_in_target"] < 0.20:
            r["status"], r["note"] = "Limited reach", "Fewer than 1 in 5 target customers qualify"
        elif r["code"] in top:
            r["status"], r["note"] = "Recommended", "Best expected result for the cost"
        else:
            r["status"], r["note"] = "Applicable", "Eligible - weaker fit or higher cost"
    return {
        "scope": "cohort", "cohort_id": co.cohort_id, "cohort_name": co.name,
        "dpd_bucket": co.dpd_bucket, "client_risk_band": co.client_risk_band,
        "expected_payment": co.expected_payment,
        "customers": len(members), "target_group": "Persuadable", "target_customers": len(target),
        "rows": rows,
    }


@app.get("/strategy-sheet/customer/{customer_id}")
def customer_strategy_sheet(customer_id: int, db: Session = Depends(get_db)):
    c = _customer(db, customer_id)
    rows = []
    for s in db.query(models.Strategy).order_by(models.Strategy.code).all():
        ok, reason = eligibility(s.code, c)
        fit = fit_multiplier(s.code, c)
        rows.append({
            **_strategy_out(s), "eligible": ok, "eligibility_reason": reason, "fit": fit,
            "fit_reasons": fit_reasons(s.code, c),
            "expected_score": round(_hist_rate(s) * fit, 4) if ok else 0.0,
        })

    seg = c.segment
    eligible = sorted([r for r in rows if r["eligible"]], key=lambda r: -r["expected_score"])
    top = [x["code"] for x in eligible[:2]]
    cheapest = min(eligible, key=lambda x: x["cost_per_contact"])["code"] if eligible else None
    for r in rows:
        if seg == "Sleeping Dog":
            r["status"], r["note"] = "Suppress", "Contact is likely to backfire"
        elif not r["eligible"]:
            r["status"], r["note"] = "Not eligible", r["eligibility_reason"]
        elif seg == "Persuadable":
            r["status"] = "Recommended" if r["code"] in top else "Applicable"
            r["note"] = "Best expected fit" if r["code"] in top else "Eligible, weaker fit"
        elif seg == "Sure Thing":
            if r["code"] == cheapest:
                r["status"], r["note"] = "Recommended", "Lowest-cost touch - expected to pay anyway"
            else:
                r["status"], r["note"] = "Not advised", "Spend is wasted - expected to self-cure"
        else:  # Lost Cause
            if r["code"] == "S6":
                r["status"], r["note"] = "Recommended", "Hardship route"
            else:
                r["status"], r["note"] = "Not advised", "Cannot pay - a nudge will not help"
    return {
        "scope": "customer", "customer_id": c.customer_id, "name": c.name, "cohort_id": c.cohort_id,
        "segment": seg, "recommended_action": SEGMENT_ACTION[seg], "rows": rows,
    }


# --------------------------------------------------------------------------- experiments
@app.post("/experiments")
def create_experiment(body: ExperimentIn, db: Session = Depends(get_db)):
    co = _cohort(db, body.cohort_id)
    strategies = db.query(models.Strategy).filter(models.Strategy.code.in_(body.strategies)) \
                   .order_by(models.Strategy.code).all()
    if not strategies:
        raise HTTPException(400, "Select at least one strategy")
    members = db.query(models.Customer).filter(models.Customer.cohort_id == body.cohort_id).all()
    exp = experiments.store(experiments.Experiment(
        co, members, strategies, body.control_pct, body.mode,
        [s for s in body.include_segments if s in SEGMENTS] or ["Persuadable"], body.wave_size,
    ))
    return exp.summary()


def _exp(exp_id: str) -> experiments.Experiment:
    exp = experiments.get(exp_id)
    if not exp:
        raise HTTPException(404, "Experiment not found - it may have expired when the server restarted")
    return exp


@app.get("/experiments/{exp_id}")
def get_experiment(exp_id: str):
    return _exp(exp_id).summary()


@app.post("/experiments/{exp_id}/waves")
def run_waves(exp_id: str, count: int = Query(1, ge=1, le=100)):
    exp = _exp(exp_id)
    for _ in range(count):
        if exp.run_wave() is None:
            break
    return exp.summary()


@app.get("/experiments/{exp_id}/customers/{customer_id}")
def experiment_customer(exp_id: str, customer_id: int):
    exp = _exp(exp_id)
    st = exp.status.get(customer_id)
    if st is None:
        raise HTTPException(404, "Customer is not in this experiment's cohort")
    return {"customer_id": customer_id, **st}


@app.get("/customers/{customer_id}/assignment-preview")
def assignment_preview(customer_id: int, strategies: str = "", db: Session = Depends(get_db)):
    """Customer-level view of the experiment: which group, which strategies, the live draw."""
    c = _customer(db, customer_id)
    codes = [s for s in strategies.split(",") if s] or [
        s.code for s in db.query(models.Strategy).order_by(models.Strategy.code).all()]
    strats = {s.code: s for s in db.query(models.Strategy).filter(models.Strategy.code.in_(codes)).all()}
    in_test = c.segment == "Persuadable"
    elig = []
    for code in codes:
        if code not in strats:
            continue
        ok, reason = eligibility(code, c)
        elig.append({"code": code, "name": strats[code].name, "eligible": ok, "reason": reason})
    arms = []
    for e in elig:
        if not e["eligible"]:
            continue
        s = strats[e["code"]]
        mean, n = _hist_rate(s), s.hist_successes + s.hist_failures
        arms.append({"code": s.code, "name": s.name,
                     "a": 1 + experiments.PRIOR_STRENGTH * mean if n else 1.0,
                     "b": 1 + experiments.PRIOR_STRENGTH * (1 - mean) if n else 1.0})
    ranking = thompson_rank(arms, c, RNG) if arms else []
    for r in ranking:
        r["fit_reasons"] = fit_reasons(r["code"], c)
    return {
        "customer_id": c.customer_id, "name": c.name, "segment": c.segment, "cohort_id": c.cohort_id,
        "in_test_population": in_test,
        "gate_reason": None if in_test else experiments.SEGMENT_EXCLUSION.get(c.segment),
        "eligibility": elig, "ranking": ranking,
        "selected": ranking[0] if (ranking and in_test) else None,
    }


@app.post("/admin/reseed")
def reseed():
    out = seed(reset=True)
    db = SessionLocal()
    try:
        out["console"] = seed_console(db, force=True)
    finally:
        db.close()
    return out


@app.get("/health")
def health():
    return {"status": "ok"}
