"""Campaign engine: target population -> eligibility -> control split ->
contact rules -> Thompson sampling among the treatments still allowed ->
execution (simulated, with the contact rules checked again at send time) ->
engagement -> outcome -> learning.

Everything is written to the decision log, so the journey, nudge, decision
audit and every dashboard read the same records. Nothing on screen is
synthesised separately from what the engine actually did.

Simulation boundary: `simulation.true_pay_probability` stands in for real
customers. The engine never reads it when deciding; it only produces outcomes.
"""
from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from types import SimpleNamespace
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models
from ..simulation import snapshot, true_pay_probability
from ..scoring import eligibility, fit_multiplier, fit_reasons, thompson_rank
from . import rules
from .contract import FEATURE_SET_VERSION, NovaAccount, guard_context
from .models import (
    Campaign, ContactRecord, Decision, EligibilityEval, EngagementEvent, ExternalCustomer, FeatureSnapshot, Nudge,
    Outcome,
)
from .platform import cfg
from .playbook import human_review_codes

UTC = timezone.utc
# One channel family for opt-out purposes.
DIGITAL = {"SMS", "App push", "SMS + App", "Email"}

# Channels of the original playbook. Treatments added later carry their own
# channel on the playbook row; channel_of() reads that first.
CHANNEL_OF = {
    "S1": "SMS", "S2": "App push", "S3": "SMS + App", "S4": "SMS + App",
    "S5": "Outbound call", "S6": "Specialist team",
}

DELIVERY_FAILURE = {"SMS": 0.03, "App push": 0.02, "SMS + App": 0.02, "Email": 0.04, "Letter": 0.01,
                    "Outbound call": 0.12, "Specialist team": 0.0}


# One writer at a time. Waves, human reviews and agent (MCP) requests all
# allocate sequential ids and read-then-write the contact history; serialising
# them keeps both consistent in this single-process deployment.
ENGINE_LOCK = threading.RLock()

# Accounts handed over without a name are stored as "Account <ref>"; messages
# then greet them neutrally. Names are not needed to decide (minimum PII).
UNNAMED = "Account "


def first_name(c) -> str:
    return "there" if not c.name or c.name.startswith(UNNAMED) else c.name.split()[0]


def channel_of(db: Session, code: str) -> str:
    st = db.get(models.Strategy, code)
    return st.channel if st else CHANNEL_OF.get(code, "SMS")


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="seconds")


def parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


def jl(text: str | None, default=None):
    try:
        return json.loads(text) if text else (default if default is not None else [])
    except (TypeError, ValueError):
        return default if default is not None else []


def as_of_decision(snap: dict) -> SimpleNamespace:
    """The customer as they were when a decision was made, rebuilt from its
    frozen snapshot - for audit views and overrides, which must not judge an
    old decision on today's data."""
    return SimpleNamespace(**{k: snap.get(k) for k in (
        "customer_id", "name", "segment", "balance", "utilization", "tenure_years", "sms_responsive", "app_user",
        "hardship_flag", "missed_payments", "payment_history", "days_past_due", "nudge_score", "cohort_id",
        "client_risk_band", "client_risk_score", "self_cure_score")})


def arrears(c) -> float:
    """Amount past due. The handoff carries balance and DPD; arrears is about one
    minimum payment per missed cycle."""
    cycles = max(1, round(c.days_past_due / 30))
    return round(max(35.0, c.balance * 0.035) * cycles, 2)


def _bucket(campaign_id: str, customer_id: int) -> float:
    h = hashlib.sha256(f"{campaign_id}:{customer_id}".encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


# ---------------------------------------------------------------------------
# Population
# ---------------------------------------------------------------------------
def target_customers(db: Session, camp: Campaign) -> list[models.Customer]:
    q = db.query(models.Customer)
    cohorts = jl(camp.target_cohorts)
    if cohorts:
        q = q.filter(models.Customer.cohort_id.in_(cohorts))
    bands = jl(camp.risk_bands)
    if bands:
        q = q.filter(models.Customer.client_risk_band.in_(bands))
    if camp.min_dpd is not None:
        q = q.filter(models.Customer.days_past_due >= camp.min_dpd)
    if camp.max_dpd is not None:
        q = q.filter(models.Customer.days_past_due <= camp.max_dpd)
    if camp.min_balance is not None:
        q = q.filter(models.Customer.balance >= camp.min_balance)
    if camp.max_balance is not None:
        q = q.filter(models.Customer.balance <= camp.max_balance)
    return q.order_by(models.Customer.customer_id).all()


def population_breakdown(db: Session, camp: Campaign) -> dict:
    """Step 1 of the experiment: who is in, who is out, and why."""
    customers = target_customers(db, camp)
    segments = set(jl(camp.include_segments))
    codes = jl(camp.treatment_codes)
    # Reach is counted for the whole playbook, not only the selected arms, so a
    # strategist can see who a treatment would reach before adding it.
    all_codes = sorted((s.code for s in db.query(models.Strategy)), key=lambda k: (len(k), k))
    out: dict = {"matching": len(customers), "segments": {}, "exclusions": {},
                 "eligible": 0, "control": 0, "treatment": 0,
                 "arm_eligibility": {c: 0 for c in all_codes}}
    for c in customers:
        out["segments"][c.segment] = out["segments"].get(c.segment, 0) + 1
        if c.segment not in segments:
            reason = {
                "Sure Thing": "Expected to self-cure - left on business as usual",
                "Lost Cause": "Cannot pay - routed to the hardship team",
                "Sleeping Dog": "Contact likely to backfire - suppressed",
            }.get(c.segment, "Outside the target segment")
            out["exclusions"][reason] = out["exclusions"].get(reason, 0) + 1
            continue
        for code in all_codes:
            if eligibility(code, c)[0]:
                out["arm_eligibility"][code] += 1
        arms = [code for code in codes if eligibility(code, c)[0]]
        if not arms:
            out["exclusions"]["No selected treatment applies"] = \
                out["exclusions"].get("No selected treatment applies", 0) + 1
            continue
        out["eligible"] += 1
        if _bucket(camp.campaign_id, c.customer_id) < camp.control_pct:
            out["control"] += 1
        else:
            out["treatment"] += 1
    out["exclusions"] = [{"reason": r, "count": n} for r, n in out["exclusions"].items()]
    return out


# ---------------------------------------------------------------------------
# Beliefs
# ---------------------------------------------------------------------------
def _priors(db: Session, camp: Campaign) -> dict[str, dict]:
    """Starting belief per arm. A treatment with a track record starts from it,
    weighted as a handful of observations (prior_strength). A treatment with no
    history starts flat - Beta(1, 1) - so it is explored on equal terms and its
    record is built entirely from live outcomes."""
    strength = float(cfg(db, "prior_strength"))
    out: dict[str, dict] = {}
    for code in jl(camp.treatment_codes):
        st = db.get(models.Strategy, code)
        if not st:
            continue
        n = st.hist_successes + st.hist_failures
        if n:
            mean = st.hist_successes / n
            a, b = 1 + strength * mean, 1 + strength * (1 - mean)
        else:
            mean, a, b = 0.5, 1.0, 1.0
        out[code] = {"code": code, "name": st.name, "cost": st.cost_per_contact, "a": a, "b": b,
                     "prior_mean": mean, "prior": "playbook" if n else "uniform", "learned": 0}
    return out


def _summary(a: float, b: float) -> dict:
    n = a + b
    mean = a / n
    sd = math.sqrt(a * b / (n * n * (n + 1)))
    return {"mean": mean, "low": max(0.0, mean - 1.96 * sd), "high": min(1.0, mean + 1.96 * sd)}


def beliefs(db: Session, camp: Campaign) -> dict[str, dict]:
    """Per-arm Beta posterior for this campaign: the prior, plus every learned
    outcome in this campaign."""
    out = _priors(db, camp)
    rows = (db.query(Decision.treatment_code, Outcome.reward)
            .join(Outcome, Outcome.decision_id == Decision.decision_id)
            .filter(Decision.campaign_id == camp.campaign_id, Outcome.learned.is_(True))
            .all())
    for code, reward in rows:
        if code in out and reward is not None:
            out[code]["a"] += reward
            out[code]["b"] += 1 - reward
            out[code]["learned"] += 1
    for v in out.values():
        v.update(_summary(v["a"], v["b"]))
    return out


def _p_best(state: dict[str, tuple[float, float]], rng: np.random.Generator, draws: int = 4000) -> dict[str, float]:
    """Posterior probability that each arm has the highest success rate."""
    codes = list(state)
    if not codes:
        return {}
    a = np.array([state[k][0] for k in codes])
    b = np.array([state[k][1] for k in codes])
    wins = np.bincount(rng.beta(a, b, size=(draws, len(codes))).argmax(axis=1), minlength=len(codes))
    return {k: float(wins[i] / draws) for i, k in enumerate(codes)}


def learning(db: Session, camp: Campaign) -> dict:
    """How the bandit's beliefs and its allocation moved, wave by wave.

    Learning is batched per wave: wave N is decided with everything learned up
    to wave N-1. So the allocation in a wave reflects the beliefs shown for the
    wave before it."""
    priors = _priors(db, camp)
    codes = list(priors)
    state = {k: (priors[k]["a"], priors[k]["b"]) for k in codes}
    rng = np.random.default_rng(17)
    rows = (db.query(Decision.wave, Decision.group, Decision.treatment_code, Outcome.reward, Outcome.learned)
            .outerjoin(Outcome, Outcome.decision_id == Decision.decision_id)
            .filter(Decision.campaign_id == camp.campaign_id).all())

    def point(wave: int, label: str, counts: dict[str, int], learned: int) -> dict:
        treated = sum(counts.values())
        best = _p_best(state, rng)
        return {"wave": wave, "label": label, "treated": treated, "learned": learned,
                "counts": {k: counts.get(k, 0) for k in codes},
                "allocation": {k: (counts.get(k, 0) / treated if treated else 0.0) for k in codes},
                "posterior": {k: {**_summary(*state[k]), "p_best": best[k]} for k in codes}}

    out = [point(0, "Prior", {}, 0)]
    for w in sorted({r[0] for r in rows}):
        counts: dict[str, int] = {}
        learned = 0
        for _, group, code, reward, was_learned in (r for r in rows if r[0] == w):
            if group == "Treatment" and code in state:
                counts[code] = counts.get(code, 0) + 1
            if was_learned and reward is not None and code in state:
                a, b = state[code]
                state[code] = (a + reward, b + 1 - reward)
                learned += 1
        out.append(point(w, f"Wave {w}", counts, learned))
    return {"arms": [{"code": k, "name": priors[k]["name"], "prior": priors[k]["prior"]} for k in codes],
            "waves": out}


def selection_probabilities(arms: list[dict], customer, rng: np.random.Generator,
                            draws: int = 600) -> dict[str, float]:
    """P(each arm wins | context). Logged on every decision: per-arm effects
    are confounded by routing, and this is what lets them be reweighted."""
    if not arms:
        return {}
    a = np.array([x["a"] for x in arms])
    b = np.array([x["b"] for x in arms])
    fit = np.array([fit_multiplier(x["code"], customer) for x in arms])
    samples = np.minimum(rng.beta(a, b, size=(draws, len(arms))) * fit, 1.0)
    wins = np.bincount(samples.argmax(axis=1), minlength=len(arms))
    return {x["code"]: float(wins[i] / draws) for i, x in enumerate(arms)}


# ---------------------------------------------------------------------------
# Content
# ---------------------------------------------------------------------------
# Messages quote only figures the bank supplied. No card number is ever
# written: ARI is not given one, and it must not make one up.
TEMPLATES = {
    ("S1", "Supportive"): "Hi {first}, a quick reminder that ${due} is past due on your account. "
                          "You can pay in seconds here: {link}. Reply STOP to opt out.",
    ("S1", "Neutral"): "{first}, your account has ${due} past due. Pay now: {link}. "
                       "Reply STOP to opt out.",
    ("S1", "Direct"): "{first}, ${due} on your account is now {dpd} days overdue. "
                      "Please pay today: {link}. Reply STOP to opt out.",
    ("S2", None): "Your ${due} payment is ready - tap to settle it in one step.",
    ("S3", None): "Hi {first}, we can split the ${due} past due on your account into 3 payments of "
                  "${inst}, with no fee. Review the plan: {link}. Reply STOP to opt out.",
    ("S4", None): "Hi {first}, we can move your payment date by 30 days at no cost. "
                  "See the details: {link}. Reply STOP to opt out.",
    ("S5", None): "Call script: confirm identity, explain the ${due} past due, agree an affordable "
                  "date, record the promise to pay. No pressure language.",
    ("S6", None): "Referral to the specialist team for an affordability review.",
}

# The same messages when the past-due amount is not known.
TEMPLATES_NO_AMOUNT = {
    ("S1", "Supportive"): "Hi {first}, a quick reminder that a payment on your account is past due. "
                          "You can pay in seconds here: {link}. Reply STOP to opt out.",
    ("S1", "Neutral"): "{first}, your account has a past-due payment. Pay now: {link}. Reply STOP to opt out.",
    ("S1", "Direct"): "{first}, your account is now {dpd} days overdue. Please pay today: {link}. "
                      "Reply STOP to opt out.",
    ("S2", None): "Your past-due payment is ready - tap to settle it in one step.",
    ("S3", None): "Hi {first}, we can split your past-due amount into 3 payments, with no fee. "
                  "Review the plan: {link}. Reply STOP to opt out.",
    ("S5", None): "Call script: confirm identity, explain the past-due amount, agree an affordable "
                  "date, record the promise to pay. No pressure language.",
}


def _offer_template(st, with_amount: bool) -> str:
    """Message for a treatment added in the console: its own offer text, in its
    channel's format. Pre-approved wording around it; braces escaped so offer
    text cannot inject template fields."""
    offer = (st.offer if st else "Please review your account.").strip().rstrip(".") + "."
    offer = offer.replace("{", "{{").replace("}", "}}")
    channel = st.channel if st else "SMS"
    past_due = "the ${due} past due" if with_amount else "the past-due amount"
    if channel == "Outbound call":
        return ("Call script: confirm identity, explain " + past_due + ", then offer: " + offer
                + " Record the outcome. No pressure language.")
    if channel == "Specialist team":
        return "Referral to the specialist team. Offer: " + offer
    if channel == "Letter":
        return ("Dear {first}, your account has " + ("${due} past due. " if with_amount else "a past-due payment. ")
                + offer + " Call us or visit {link} to respond.")
    if channel == "Email":
        return "Hi {first}, about " + past_due + " on your account: " + offer + " Details: {link}. Unsubscribe at any time."
    if channel == "App push":
        return offer + " Tap to review."
    return "Hi {first}, about " + past_due + " on your account: " + offer + " Details: {link}. Reply STOP to opt out."


def message_amount(dec: Decision | None, c) -> float | None:
    """The past-due amount a message may quote. For an account Nova sent,
    only Nova's own amount_past_due - None when it did not send one, and the
    message then names no figure. Console customers are synthetic, and quote
    their generated arrears."""
    snap = jl(dec.snapshot, {}) if dec is not None else {}
    if (dec is not None and dec.origin == "mcp") or "amount_past_due" in snap:
        v = snap.get("amount_past_due")
        return float(v) if v is not None else None
    return arrears(c)


def render(code: str, tone: str, c, st=None, *, due: float | None) -> str:
    table = TEMPLATES if due is not None else {**TEMPLATES, **TEMPLATES_NO_AMOUNT}
    tpl = table.get((code, tone)) or table.get((code, None)) or _offer_template(st, due is not None)
    cid = c.customer_id or 0  # a previewed account has no ARI id yet
    return tpl.format(first=first_name(c), due=f"{due:,.0f}" if due is not None else "",
                      link="ari.bank/p/" + hashlib.md5(str(cid).encode()).hexdigest()[:6],
                      dpd=c.days_past_due, inst=f"{due / 3:,.0f}" if due is not None else "")


# ---------------------------------------------------------------------------
# Contact rules (prevention) live in rules.py. They run twice: before
# Thompson sampling, for every candidate treatment, and again at send time,
# because contacts can change between a decision and its send. Detection of
# what slipped through lives in compliance.py.
# ---------------------------------------------------------------------------
CONSENT_FOR = rules.CONSENT_FOR

CONSOLE_GUARD = {"contract_version": "console", "consent": {}, "contacts": {}, "vulnerability_flag": None,
                 "restrictions": None, "arrangement": None, "timezone": None, "as_of": {}}


def guard_of(ctx: dict) -> dict:
    """The guardrail inputs of a decision's snapshot. Decisions made before
    RecoveryContext carried only a consent list and a contact count."""
    if ctx.get("guard"):
        return ctx["guard"]
    return {**CONSOLE_GUARD, "contract_version": "v0" if ctx.get("source") else "console",
            "consent": {k: False for k in (ctx.get("no_consent") or [])},
            "contacts": {"total": ctx.get("reported_contacts_7d")}}


def guard(db: Session, customer_id: int, channel: str, at: datetime,
          reported_7d: int = 0, no_consent: tuple | list = ()) -> tuple[bool, str]:
    """The send-time check for a v0-shaped context: (allowed, note)."""
    g = {**CONSOLE_GUARD, "contract_version": "v0", "consent": {k: False for k in no_consent},
         "contacts": {"total": reported_7d}}
    return rules.send_check(db, customer_id, channel, g, at)


def latest_context(db: Session, dec: Decision) -> tuple[dict, str | None]:
    """The context to apply when a decision is executed after a wait (a person
    approving an offer): what Nova told ARI most recently about the account,
    over what it said at decision time. ARI cannot ask Nova for fresh data, so
    the newest request is the best it has. Returns (context, when that request
    arrived)."""
    ctx = jl(dec.snapshot, {})
    if dec.origin != "mcp":
        return ctx, None
    link = (db.query(ExternalCustomer)
            .filter(ExternalCustomer.source == "nova", ExternalCustomer.customer_id == dec.customer_id).first())
    if link is None:
        return ctx, None
    try:
        g = guard_context(NovaAccount.model_validate(jl(link.payload, {})))
    except ValueError:
        return ctx, None
    return {**ctx, "guard": g}, link.last_seen


def cancel_pending(dec: Decision, reason: str, actor: str) -> None:
    """Withdraw an offer that is still waiting for review. Nothing was sent."""
    dec.review_status = "cancelled"
    dec.exclusion_reason = reason
    dec.reviewed_by = actor


# ---------------------------------------------------------------------------
# Wave
# ---------------------------------------------------------------------------
class Seq:
    """Readable sequential ids (D-4820, N-4821) without a sequence table."""

    def __init__(self, db: Session):
        self.d = (db.query(func.count(Decision.decision_id)).scalar() or 0) + 4000
        self.n = (db.query(func.count(Nudge.nudge_id)).scalar() or 0) + 4000

    def decision(self) -> str:
        self.d += 1
        return f"D-{self.d}"

    def nudge(self) -> str:
        self.n += 1
        return f"N-{self.n}"


def _send_hour(camp: Campaign, rng: np.random.Generator) -> int:
    return int(rng.integers(camp.send_window_start, max(camp.send_window_start + 1, camp.send_window_end)))


def lineage(db: Session, camp: Campaign) -> list[str]:
    """This strategy and every earlier version it replaced."""
    ids: list[str] = []
    cur: Campaign | None = camp
    while cur is not None and cur.campaign_id not in ids:
        ids.append(cur.campaign_id)
        cur = db.get(Campaign, cur.parent_id) if cur.parent_id else None
    return ids


def in_audience(camp: Campaign, c) -> tuple[bool, str]:
    """Whether this strategy would target this one customer - the same filters
    as target_customers and undecided_pool, applied to a single record."""
    cohorts, bands = jl(camp.target_cohorts), jl(camp.risk_bands)
    if cohorts and c.cohort_id not in cohorts:
        return False, f"targets {', '.join(cohorts)}, not {c.cohort_id}"
    if bands and c.client_risk_band not in bands:
        return False, f"targets {', '.join(bands)} risk, not {c.client_risk_band}"
    if camp.min_dpd is not None and c.days_past_due < camp.min_dpd:
        return False, f"starts at {camp.min_dpd} days past due"
    if camp.max_dpd is not None and c.days_past_due > camp.max_dpd:
        return False, f"stops at {camp.max_dpd} days past due"
    if camp.min_balance is not None and c.balance < camp.min_balance:
        return False, f"needs a balance of at least ${camp.min_balance:,.0f}"
    if camp.max_balance is not None and c.balance > camp.max_balance:
        return False, f"takes balances up to ${camp.max_balance:,.0f}"
    if c.segment not in jl(camp.include_segments):
        return False, f"does not include the {c.segment} fit group"
    if not any(eligibility(code, c)[0] for code in jl(camp.treatment_codes)):
        return False, "has no treatment this customer is eligible for"
    return True, "in audience"


def undecided_pool(db: Session, camp: Campaign) -> list[models.Customer]:
    """Customers this strategy could still decide: in target, in an included
    segment, at least one arm eligible, and not already in a strategy.

    One customer, one strategy: anyone decided by another live or paused
    strategy is skipped, otherwise two strategies contact the same person and
    both claim the payment. A revision also skips everyone its earlier versions
    decided - they are mid-journey, not new."""
    active = [k for (k,) in db.query(Campaign.campaign_id).filter(Campaign.status.in_(["Live", "Paused"]))]
    decided = {cid for (cid,) in db.query(Decision.customer_id)
               .filter(Decision.campaign_id.in_(active + lineage(db, camp)))}
    segments = set(jl(camp.include_segments))
    codes = jl(camp.treatment_codes)
    pool = [c for c in target_customers(db, camp)
            if c.customer_id not in decided and c.segment in segments
            and any(eligibility(code, c)[0] for code in codes)]
    # Deterministic but not id-ordered, so a wave is a spread of the population.
    pool.sort(key=lambda c: _bucket(f"order-{camp.campaign_id}", c.customer_id))
    return pool


def console_context(c) -> dict:
    """The decision context of a console wave: the synthetic handoff record,
    with no Nova guardrail data."""
    return {"contract_version": "console", "request_id": None, "account_ref": None, "party_ref": None,
            "as_of": None, "raw": None, "guard": CONSOLE_GUARD, "snapshot_extra": {}, "assumed": [],
            "ignored": [], "aliases": [], "lineage_only": [],
            "source_lineage": {"source": "Collections handoff (synthetic console data)", "customer_id": c.customer_id}}


def decide_one(db: Session, camp: Campaign, c, *, decision_id: str, wave: int, decided_at: datetime,
               rng: np.random.Generator, arms_state: dict, human_review: set[str], auto_approve: bool,
               origin: str = "wave", context: dict | None = None) -> Decision:
    """One customer, one strategy. Every rule is evaluated for every candidate
    treatment first (rules.py); then the randomised control split among those
    with at least one allowed treatment; then Thompson sampling (with a
    customer-fit adjustment) among the allowed treatments. An account with no
    allowed treatment is Excluded - recorded, but outside the experiment.

    Returns the Decision without adding it to the session; its frozen context
    (FeatureSnapshot) and rule results (EligibilityEval) ride along and are
    stored by add_decision. Waves and agent requests both decide through here,
    so they can never diverge."""
    t0 = time.perf_counter()
    ctx = context or console_context(c)
    g = ctx["guard"]
    s = snapshot(c)
    snap = {**vars(s), "client_risk_band": c.client_risk_band, "client_risk_score": c.client_risk_score,
            "self_cure_score": c.self_cure_score, "arrears": arrears(c), **ctx["snapshot_extra"],
            "contract_version": ctx["contract_version"], "guard": g}
    codes = [k for k in jl(camp.treatment_codes) if k in arms_state]
    eligible = [code for code in codes if eligibility(code, c)[0]]
    allowed, rows, fresh = rules.evaluate(db, codes, c, g, decided_at)
    blocked = rules.blocked_summary(rows)
    for b in blocked:
        b["name"] = arms_state[b["code"]]["name"]
    dec = Decision(decision_id=decision_id, campaign_id=camp.campaign_id, customer_id=c.customer_id,
                   wave=wave, origin=origin, eligible_arms=json.dumps(eligible), snapshot=json.dumps(snap),
                   blocked_arms=json.dumps(blocked), decided_at=iso(decided_at),
                   contract_version=ctx["contract_version"], request_id=ctx["request_id"], context_as_of=ctx["as_of"])
    evaluated_at = iso(decided_at)
    dec._evals = [EligibilityEval(decision_id=decision_id, arm_id=x["arm_id"], arm_version=x["arm_version"],
                                  stage=x["stage"], rule_id=x["rule_id"], rule_version=x["rule_version"],
                                  result=x["result"], reason_code=x["reason_code"], reason=x["reason"],
                                  input_refs=json.dumps(x["input_refs"], default=str), evaluated_at=evaluated_at)
                  for x in rows]
    dec._feature_snapshot = FeatureSnapshot(
        decision_id=decision_id, account_ref=ctx["account_ref"], party_ref=ctx["party_ref"],
        contract_version=ctx["contract_version"], request_id=ctx["request_id"], as_of_ts=ctx["as_of"],
        received_at=ctx.get("received_at") or evaluated_at, feature_set_version=FEATURE_SET_VERSION,
        raw_payload=json.dumps(ctx["raw"] or {}, default=str), features=json.dumps(snap, default=str),
        guard_context=json.dumps(g, default=str), assumed=json.dumps(ctx["assumed"]),
        ignored_fields=json.dumps(ctx["ignored"]), aliases_used=json.dumps(ctx["aliases"]),
        lineage_only=json.dumps(ctx["lineage_only"]), source_lineage=json.dumps(ctx["source_lineage"], default=str),
        staleness=json.dumps(fresh))
    not_allowed = "; ".join(f"{b['name']} ({', '.join(r['reason'][0].lower() + r['reason'][1:] for r in b['reasons'])})"
                            for b in blocked)
    if not allowed:
        # Excluded before the control split: the same exclusions apply to
        # treated and control alike, so the comparison stays fair.
        dec.group = "Excluded"
        dec.exclusion_reason = rules.exclusion_action(rows)
        dec.explanation = f"No treatment allowed: {not_allowed}. Nothing is sent."
        dec.latency_ms = round((time.perf_counter() - t0) * 1000, 1)
        return dec
    # A record that is not stored yet (a preview) has no id to randomise on: it
    # is shown as treated, and the caller says so.
    if c.customer_id is not None and _bucket(camp.campaign_id, c.customer_id) < camp.control_pct:
        dec.group = "Control"
        dec.explanation = ("Randomised holdout. Stays on the bank's business-as-usual process "
                           "so every treated result has a fair comparison.")
    else:
        dec.group = "Treatment"
        arms = [{"code": k, "name": arms_state[k]["name"], "a": arms_state[k]["a"],
                 "b": arms_state[k]["b"]} for k in allowed]
        ranking = thompson_rank(arms, c, rng)
        probs = selection_probabilities(arms, c, rng)
        chosen = ranking[0]["code"]
        for r in ranking:
            r["selection_probability"] = round(probs.get(r["code"], 0.0), 4)
            r["fit_reasons"] = fit_reasons(r["code"], c)
        dec.treatment_code = chosen
        dec.ranking = json.dumps(ranking)
        dec.selection_probability = round(probs.get(chosen, 0.0), 4)
        runner = ranking[1] if len(ranking) > 1 else None
        dec.explanation = (
            f"{ranking[0]['name']} drew the highest score ({ranking[0]['score']:.2f}) of "
            f"{len(ranking)} allowed treatments: belief {ranking[0]['belief']:.0%}, customer fit "
            f"x{ranking[0]['fit']:.2f}."
            + (f" Runner-up {runner['name']} at {runner['score']:.2f}." if runner else "")
            + f" Chosen {probs.get(chosen, 0):.0%} of the time in this context."
            + (f" Not allowed: {not_allowed}." if blocked else ""))
        if chosen in human_review:
            dec.review_policy = "human_review"
            dec.review_status = "approved" if auto_approve else "pending"
            if auto_approve:
                dec.reviewed_by = camp.owner_id
    dec.latency_ms = round((time.perf_counter() - t0) * 1000, 1)
    return dec


def add_decision(db: Session, dec: Decision) -> None:
    """Store a decision with its frozen context and every rule result."""
    db.add(dec)
    db.flush()
    fs = getattr(dec, "_feature_snapshot", None)
    if fs is not None:
        db.add(fs)
        db.add_all(dec._evals)
        db.flush()
        dec.feature_snapshot_id = fs.snapshot_id


def _treated_in_wave(db: Session, camp: Campaign, wave: int) -> int:
    db.flush()
    return (db.query(func.count(Decision.decision_id))
            .filter(Decision.campaign_id == camp.campaign_id, Decision.wave == wave,
                    Decision.group == "Treatment").scalar() or 0)


def decide_now(db: Session, camp: Campaign, c, *, origin: str, context: dict | None = None,
               at: datetime | None = None) -> tuple[Decision, "Nudge | None"]:
    """One decision outside a wave: an agent asking about one account.

    It joins the strategy's current wave, which closes once it holds a full
    wave of treated customers - so learning stays batched by wave whichever way
    customers arrive. The draw is seeded by strategy, customer and wave, so the
    same request replays to the same decision. The outcome is not simulated:
    the caller reports the real payment later."""
    at = at or datetime.now(UTC)
    wave = camp.waves_run + 1
    seq = Seq(db)
    rng = np.random.default_rng(int(hashlib.sha256(
        f"{camp.campaign_id}:{c.customer_id}:{wave}".encode()).hexdigest()[:8], 16))
    dec = decide_one(db, camp, c, decision_id=seq.decision(), wave=wave, decided_at=at, rng=rng,
                     arms_state=beliefs(db, camp), human_review=human_review_codes(db), auto_approve=False,
                     origin=origin, context=context)
    add_decision(db, dec)
    nudge = None
    if dec.group == "Treatment" and dec.treatment_code and dec.review_status != "pending":
        nudge = execute(db, camp, dec, c, at, rng, seq)
    if _treated_in_wave(db, camp, wave) >= camp.wave_size:
        camp.waves_run = wave
    db.commit()
    return dec, nudge


def run_wave(db: Session, camp: Campaign, at: datetime | None = None, actor: str = "system",
             realise: bool = True) -> dict:
    """Decide, guard, execute and (optionally) observe one wave."""
    at = at or datetime.now(UTC)
    wave = camp.waves_run + 1
    # Agent requests may already have started this wave; a wave holds wave_size
    # treated customers whichever way they arrived.
    already = _treated_in_wave(db, camp, wave)
    if already >= camp.wave_size:
        camp.waves_run, wave, already = wave, wave + 1, 0
    rng = np.random.default_rng((camp.seed or 7) * 1000 + wave)
    human_review = human_review_codes(db)
    pool = undecided_pool(db, camp)

    arms_state = beliefs(db, camp)
    seq = Seq(db)
    summary = {"wave": wave, "decided": 0, "treatment": 0, "control": 0, "excluded": 0,
               "held_for_review": 0, "blocked_by_guard": 0, "delivered": 0, "failed": 0,
               "by_treatment": {}, "pool_before": len(pool)}
    treated_quota = camp.wave_size - already
    pending_learning: list[tuple[str, float]] = []

    for c in pool:
        if summary["treatment"] >= treated_quota:
            break
        decided_at = at + timedelta(minutes=int(rng.integers(0, 240)))
        dec = decide_one(db, camp, c, decision_id=seq.decision(), wave=wave, decided_at=decided_at, rng=rng,
                         arms_state=arms_state, human_review=human_review, auto_approve=realise)
        add_decision(db, dec)
        summary["decided"] += 1
        if dec.group == "Excluded":
            summary["excluded"] += 1  # no allowed treatment: outside the experiment, nothing to send
            continue
        if dec.group == "Control":
            summary["control"] += 1
            if realise:
                _observe(db, camp, dec, c, None, decided_at, rng, pending_learning, first=None)
            continue
        summary["treatment"] += 1
        summary["by_treatment"][dec.treatment_code] = summary["by_treatment"].get(dec.treatment_code, 0) + 1
        if dec.review_status == "pending":
            summary["held_for_review"] += 1
            continue
        nudge = execute(db, camp, dec, c, decided_at, rng, seq)
        if nudge.status == "Held":
            summary["blocked_by_guard"] += 1
        elif nudge.status == "Failed":
            summary["failed"] += 1
        else:
            summary["delivered"] += 1
        if realise:
            _observe(db, camp, dec, c, dec.treatment_code, decided_at, rng, pending_learning,
                     first=nudge, seq=seq)

    # A wave that found nobody is not a wave: the counter only moves when
    # someone was decided.
    if summary["decided"]:
        camp.waves_run = wave
    else:
        summary["wave"] = None
    db.commit()
    summary["learned"] = len(pending_learning)
    summary["pool_after"] = len(pool) - summary["decided"]
    return summary


def execute(db: Session, camp: Campaign, dec, c, at: datetime,
            rng: np.random.Generator, seq: Seq, touch: int = 1, escalation: bool = False,
            manual_text: str | None = None, code: str | None = None,
            ctx: dict | None = None, ctx_source: str = "") -> Nudge:
    """Send-time contact check, content, delivery. Returns the nudge; its
    status is Delivered, Failed, or Held (stopped by the check before sending).

    Delivery is SIMULATED: no channel gateway is connected, so a send is a
    random draw against each channel's typical failure rate and nobody is
    contacted."""
    code = code or dec.treatment_code
    st = db.get(models.Strategy, code)
    channel = st.channel if st else CHANNEL_OF.get(code, "SMS")
    # What the caller told us (Nova: consent, contacts made elsewhere). By
    # default the decision-time context; an approval passes the newest.
    ctx = ctx if ctx is not None else jl(dec.snapshot, {})
    g = guard_of(ctx)
    # The send window is the customer's local time when Nova gives a time zone;
    # otherwise UTC, as before.
    tz = ZoneInfo(g["timezone"]) if g.get("timezone") else UTC
    hour = _send_hour(camp, rng)
    local_at = at.astimezone(tz)
    send_local = local_at.replace(hour=hour, minute=int(rng.integers(0, 59)), second=0, microsecond=0)
    if send_local < local_at:
        send_local += timedelta(days=1)
    send_at = send_local.astimezone(UTC)
    ok, guard_note = rules.send_check(db, c.customer_id, channel, g, send_at)
    guard_note += ctx_source
    content = manual_text or render(code, camp.tone, c, st, due=message_amount(dec, c))
    n = Nudge(nudge_id=seq.nudge(), decision_id=dec.decision_id, campaign_id=camp.campaign_id,
              customer_id=c.customer_id, treatment_code=code, channel=channel, touch_number=touch,
              content=content, scheduled_at=iso(send_at), is_escalation=escalation,
              manual=manual_text is not None)
    stages = [
        {"stage": "Trigger evaluation", "at": iso(at), "ok": True,
         "detail": f"{camp.campaign_id} wave {dec.wave}: customer in target segment, "
                   f"{len(jl(dec.eligible_arms))} eligible treatments"},
        {"stage": "Treatment selection", "at": iso(at + timedelta(seconds=1)), "ok": True,
         "detail": f"Thompson sampling chose {code} ({channel})"
                   + (f", selection probability {dec.selection_probability:.0%}"
                      if dec.selection_probability is not None else "")},
        {"stage": "Content generation", "at": iso(at + timedelta(seconds=2)), "ok": True,
         "detail": "Manual message from strategist" if manual_text
         else f"Approved template, {camp.tone.lower()} tone"},
        {"stage": "Compliance check", "at": iso(send_at - timedelta(seconds=1)), "ok": ok,
         "detail": guard_note},
    ]
    if not ok:
        n.status = "Held"
        n.failure_reason = guard_note
        n.pipeline = json.dumps(stages)
        db.add(n)
        return n
    failed = rng.random() < DELIVERY_FAILURE.get(channel, 0.03)
    stages.append({"stage": "Delivery", "at": iso(send_at), "ok": not failed,
                   "detail": ("Delivery check failed: number unreachable. Channel delivery is not connected."
                              if failed else
                              f"{channel} send recorded. Channel delivery is not connected, so no message was sent "
                              f"(ref SIM-{n.nudge_id[2:]})")})
    n.status = "Failed" if failed else "Delivered"
    n.sent_at = iso(send_at)
    if failed:
        n.failure_reason = "Number unreachable (simulated)"
    n.pipeline = json.dumps(stages)
    db.add(n)
    if not failed:
        db.add(ContactRecord(customer_id=c.customer_id, channel=channel, source="ARI",
                             nudge_id=n.nudge_id, at=iso(send_at), local_hour=send_local.hour))
    return n


def _observe(db: Session, camp: Campaign, dec: Decision, c, code: str | None, at: datetime,
             rng: np.random.Generator, pending: list, first: Nudge | None,
             seq: Seq | None = None) -> None:
    """Outcome within the evaluation window, engagement, follow-ups, escalation.

    A treatment that was never delivered behaves like no treatment, and is not
    learned from - a failed send says nothing about the strategy.

    OPEN ITEM - delayed outcomes: this records the window's result when the wave
    is processed. How late payments are credited is still a design decision."""
    delivered = first is not None and first.status == "Delivered"
    s = snapshot(c)
    p = true_pay_probability(s, code if delivered else None)
    paid = bool(rng.random() < p)
    window = camp.evaluation_days
    days = int(rng.integers(1, window + 1)) if paid else None
    due = arrears(c)
    amount = round(due * float(rng.choice([0.5, 0.75, 1.0, 1.0, 1.0])), 2) if paid else 0.0

    if delivered:
        sent = parse(first.sent_at)
        opened = rng.random() < (0.85 if paid else 0.42)
        clicked = opened and rng.random() < (0.75 if paid else 0.22)
        events = []
        if first.channel == "Outbound call":
            if rng.random() < (0.8 if paid else 0.35):
                events.append(("Answered", sent + timedelta(minutes=1)))
        elif first.channel == "Letter":
            pass  # post gives no engagement signal; only the payment is observed
        else:
            if opened:
                events.append(("Opened", sent + timedelta(minutes=int(rng.integers(2, 180)))))
            if clicked:
                events.append(("Clicked", events[-1][1] + timedelta(minutes=int(rng.integers(1, 40)))))
            if clicked and paid and rng.random() < 0.6:
                events.append(("FormCompleted", events[-1][1] + timedelta(minutes=int(rng.integers(1, 15)))))
            if not paid and first.channel in DIGITAL and rng.random() < 0.025:
                events.append(("OptOut", sent + timedelta(hours=int(rng.integers(1, 20)))))
        for ev, ts in events:
            db.add(EngagementEvent(nudge_id=first.nudge_id, customer_id=c.customer_id, event=ev, at=iso(ts)))
            if ev == "OptOut":
                db.add(ContactRecord(customer_id=c.customer_id, channel=first.channel, source="ARI",
                                     nudge_id=first.nudge_id, at=iso(ts), local_hour=ts.hour, opted_out=True))
        stages = jl(first.pipeline)
        stages.append({"stage": "Engagement tracking", "at": iso(events[-1][1]) if events else first.sent_at,
                       "ok": True, "detail": ", ".join(e for e, _ in events) or "No engagement recorded"})
        stages.append({"stage": "Response routing", "at": iso(sent + timedelta(days=days or window)),
                       "ok": True, "detail": ("Payment received - journey closed" if paid
                                              else f"No payment in {window} days - follow-up per cadence")})
        first.pipeline = json.dumps(stages)
        if events:
            first.status = {"Clicked": "Clicked", "FormCompleted": "Clicked", "Opened": "Opened",
                            "Answered": "Delivered", "OptOut": "Delivered"}[events[-1][0]]

    escalated = False
    if not paid and code and delivered and seq is not None:
        # Follow-up touches on the cadence, inside the evaluation window.
        for touch in range(2, camp.max_touches + 1):
            when = at + timedelta(days=camp.cadence_days * (touch - 1))
            if (when - at).days > window:
                break
            execute(db, camp, dec, c, when, rng, seq, touch=touch)
        # Escalation: a different treatment after N days with no payment.
        if camp.escalate_to and camp.escalate_to != code:
            esc = execute(db, camp, dec, c, at + timedelta(days=camp.escalate_after_days), rng, seq,
                          touch=camp.max_touches + 1, escalation=True, code=camp.escalate_to)
            escalated = esc.status != "Held"

    is_treated = dec.group == "Treatment"
    learned = is_treated and delivered and (dec.review_policy == "auto"
                                            or dec.review_status == "approved")
    reward = 1.0 if paid else 0.0
    # Control outcomes always count (they are the comparison). Treated outcomes
    # only count if the treatment actually reached the customer.
    db.add(Outcome(decision_id=dec.decision_id, campaign_id=camp.campaign_id, customer_id=c.customer_id,
                   paid=paid, amount=amount, days_to_pay=days, escalated=escalated, window_days=window,
                   reward=reward if (not is_treated or delivered) else None,
                   reward_policy="binary-paid-in-window/1", learned=learned,
                   observed_at=iso(at + timedelta(days=days or window))))
    if learned:
        pending.append((code, reward))


def approve_and_execute(db: Session, dec: Decision, reviewer: str, approve: bool) -> dict:
    """Human review of a forbearance-type decision. Approval executes it -
    after the hard stops and contact rules are checked again against the
    newest context, because the customer's situation can change while the
    offer waits."""
    camp = db.get(Campaign, dec.campaign_id)
    c = db.get(models.Customer, dec.customer_id)
    dec.reviewed_by = reviewer
    if not approve:
        dec.review_status = "rejected"
        db.commit()
        return {"executed": False}
    ctx, seen = latest_context(db, dec)
    g = guard_of(ctx)
    now_ = datetime.now(UTC)
    stops = [x for x in rules.account_rules(g, rules.freshness(db, g, now_)) if x["result"] == "BLOCK"]
    if stops:
        when = f" on {seen[:10]}" if seen else ""
        reason = (f"Nova's data{when} stops automated treatment, after this offer was proposed: "
                  + "; ".join(x["reason"] for x in stops) + ".")
        cancel_pending(dec, reason, reviewer)
        db.commit()
        return {"executed": False, "cancelled": reason}
    dec.review_status = "approved"
    now = datetime.now(UTC)
    rng = np.random.default_rng(int(hashlib.md5(dec.decision_id.encode()).hexdigest()[:8], 16))
    seq = Seq(db)
    nudge = execute(db, camp, dec, c, now, rng, seq, ctx=ctx,
                    ctx_source=f" (re-checked at approval against Nova's data of {seen[:16].replace('T', ' ')})"
                    if seen else "")
    if dec.origin != "mcp":
        # Console decisions are simulated end to end. An agent's decision waits
        # for the agent to report the real payment outcome.
        _observe(db, camp, dec, c, dec.treatment_code, now, rng, [], first=nudge, seq=seq)
    db.commit()
    return {"executed": nudge.status != "Held", "status": nudge.status, "note": nudge.failure_reason}
