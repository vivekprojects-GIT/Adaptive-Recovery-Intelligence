"""Nova integration: the service behind ARI's MCP server.

Nova, the bank's enterprise data layer, owns what is true about a customer.
ARI, the recovery agent, owns the decision. Between them:

  1. Nova sends one account's context; ARI returns the recovery action.
  2. The decision is recorded with its selection probability (data contract
     C11), so it can be audited and replayed.
  3. Nova reports the payment outcome; ARI learns from it.
  4. Either side reads a decision back by id or by account.

Field names follow the Nova data contract (RecoveryStrategy_Nova_Contract,
05-nova-api-contract.md), and only fields a decision needs are asked for: no
address or contact details. This module knows nothing about transport -
mcp_server.py exposes it over MCP, and a REST facade would call the same
functions.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timezone
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from .. import models
from ..scoring import SEGMENT_ACTION, nudge_score, self_cure_score, segment_for
from . import analytics, engine
from .engine import UNNAMED, iso, jl
from .models import Campaign, Decision, ExternalCustomer, Nudge, Outcome, TreatmentMeta
from .platform import audit, cfg, now
from .playbook import human_review_codes

UTC = timezone.utc
SOURCE = "nova"
ACTOR = "nova-agent"

# Cohorts are the client's DPD buckets. An account Nova sends lands in the one its arrears put it in.
COHORT_BY_DPD = (("C1", 1, 29), ("C2", 30, 59), ("C3", 60, 89), ("C4", 90, None))
BAND_BY_COHORT = {"C1": "Low", "C2": "Medium", "C3": "High", "C4": "Very high"}
RISK_MIDPOINT = {"Low": 28.0, "Medium": 54.0, "High": 75.0, "Very high": 91.0}
FIT_LABEL = {"Persuadable": "Likely responsive", "Sure Thing": "Likely self-cure",
             "Lost Cause": "Needs support", "Sleeping Dog": "Do not contact"}


class NovaError(ValueError):
    """The request cannot be served as asked; the message says why."""


# ---------------------------------------------------------------------------
# What Nova sends
# ---------------------------------------------------------------------------
class Consent(BaseModel):
    sms: bool | None = Field(None, description="May ARI send SMS? false blocks SMS and SMS + App treatments.")
    email: bool | None = Field(None, description="May ARI send email?")
    call: bool | None = Field(None, description="May ARI call? false blocks agent-call treatments.")


class NovaAccount(BaseModel):
    """One delinquent account as Nova describes it (data contract C1-C6).
    Only account_id, days_past_due and current_balance are required; anything
    missing is filled with a stated, conservative default and listed back."""
    model_config = ConfigDict(extra="ignore")

    account_id: str = Field(min_length=1, max_length=64,
                            description="Nova account id. The key for every later call: outcome reports and look-ups.")
    customer_id: str | None = Field(None, max_length=64, description="Nova customer id, if it differs from the account.")
    customer_name: str | None = Field(None, max_length=60,
                                      description="Optional. Only used to greet the customer; never needed to decide.")
    days_past_due: int = Field(ge=0, le=720, description="Days past due on the as-of date (C3).")
    current_balance: float = Field(ge=0, description="Outstanding balance (C2).")
    credit_limit: float | None = Field(None, gt=0, description="Credit limit (C2), for utilisation.")
    amount_past_due: float | None = Field(None, ge=0, description="Arrears amount (C3). Kept for lineage.")
    opened_date: date | None = Field(None, description="Account opened date (C2). Gives tenure.")
    prior_delinquencies_12m: int | None = Field(None, ge=0, le=12,
                                                description="Missed payments in the last 12 months (C3).")
    on_time_payment_ratio: float | None = Field(None, ge=0, le=1,
                                                description="Share of the last 12 months' payments made on time (C4).")
    risk_segment: Literal["Low", "Medium", "High", "Very high"] | None = Field(
        None, description="The bank's own risk band (C1). ARI does not recompute it.")
    risk_score: float | None = Field(None, ge=0, le=100,
                                     description="The bank's risk score on a 0-100 scale, higher is riskier.")
    preferred_channel: str | None = Field(None, description="C1 preferred channel, e.g. App, SMS, Email, Phone.")
    app_user: bool | None = Field(None, description="Active mobile-app user (C6 AppLogin signals).")
    sms_responsive: bool | None = Field(None, description="Has responded to SMS before (C5 outcomes).")
    hardship_flag: bool | None = Field(None, description="A hardship indicator is on file.")
    vulnerability_flag: bool = Field(False, description="C1. A vulnerable customer is never contacted by an "
                                                        "automated treatment; ARI refers them to a person.")
    consent: Consent | None = Field(None, description="C1 consent by channel.")
    contacts_last_7d: int | None = Field(None, ge=0, description="Contacts in the last 7 days made by systems other "
                                                                 "than ARI (C5 counts). Counted against the contact cap.")
    as_of_timestamp: datetime | None = Field(None, description="When the data was true in Nova (lineage).")
    source_system: str | None = Field(None, max_length=40, description="Nova's source system (lineage).")


class PaymentReport(BaseModel):
    """A payment outcome for a decision ARI returned (data contract C10)."""
    decision_id: str | None = Field(None, description="The decision_id ARI returned. Preferred.")
    account_id: str | None = Field(None, description="Or the account: its latest decision is used.")
    paid: bool = Field(description="Did the customer pay?")
    amount: float | None = Field(None, ge=0, description="Amount paid. Defaults to the amount_past_due Nova sent with the account.")
    payment_date: date | None = Field(None, description="When it was paid. Decides whether it fell in the window.")
    payment_status: Literal["Posted", "Reversed"] = Field(
        "Posted", description="A reversed payment counts as not paid - a reversal we never hear about would "
                              "teach the model a false success.")


# ---------------------------------------------------------------------------
# Account -> customer record
# ---------------------------------------------------------------------------
def cohort_for(dpd: int) -> str:
    return next(c for c, lo, hi in COHORT_BY_DPD if dpd >= lo and (hi is None or dpd <= hi))


def _apply(rec: NovaAccount, c: models.Customer) -> list[str]:
    """Fill a customer record from Nova's account. Returns what had to be assumed."""
    assumed: list[str] = []
    c.cohort_id = cohort_for(rec.days_past_due)
    c.days_past_due = rec.days_past_due
    c.balance = round(rec.current_balance, 2)
    if rec.credit_limit:
        c.credit_limit = float(rec.credit_limit)
    else:
        c.credit_limit = round(max(rec.current_balance / 0.8, 1.0), 2)
        assumed.append("credit_limit: utilisation taken as 80%")
    c.utilization = round(min(c.balance / c.credit_limit, 1.0), 3)
    if rec.opened_date:
        c.tenure_years = max(0, (date.today() - rec.opened_date).days // 365)
    else:
        c.tenure_years = 3
        assumed.append("tenure: 3 years (no opened_date)")
    if rec.prior_delinquencies_12m is not None:
        c.missed_payments = rec.prior_delinquencies_12m
    else:
        c.missed_payments = 1 if rec.days_past_due >= 30 else 0
        assumed.append(f"missed payments: {c.missed_payments} (from days past due)")
    if rec.on_time_payment_ratio is not None:
        c.payment_history = rec.on_time_payment_ratio
    else:
        c.payment_history = 0.8
        assumed.append("on-time payment ratio: 80%")
    preferred = (rec.preferred_channel or "").strip().lower()
    for field, flag, hint in (("app_user", rec.app_user, "app"), ("sms_responsive", rec.sms_responsive, "sms")):
        if flag is not None:
            setattr(c, field, flag)
        else:
            setattr(c, field, preferred == hint)
            assumed.append(f"{field}: {'yes' if preferred == hint else 'no'}"
                           f"{' (from preferred_channel)' if preferred else ''}")
    c.hardship_flag = bool(rec.hardship_flag)
    if rec.hardship_flag is None:
        assumed.append("hardship_flag: none on file")
    c.client_risk_band = rec.risk_segment or BAND_BY_COHORT[c.cohort_id]
    if rec.risk_segment is None:
        assumed.append(f"risk band: {c.client_risk_band} (from the DPD bucket)")
    c.client_risk_score = rec.risk_score if rec.risk_score is not None else RISK_MIDPOINT[c.client_risk_band]
    if rec.risk_score is None:
        assumed.append(f"risk score: {c.client_risk_score:g} (band midpoint)")
    c.name = (rec.customer_name or f"{UNNAMED}{rec.account_id}")[:60]
    c.persona_note = f"Handed over by Nova as {rec.account_id}" + (f" from {rec.source_system}" if rec.source_system else "")
    c.nudge_score = nudge_score(c)
    c.self_cure_score = self_cure_score(c)
    c.segment = segment_for(c)
    return assumed


def _link(db: Session, account_id: str) -> ExternalCustomer | None:
    return db.query(ExternalCustomer).filter_by(source=SOURCE, external_ref=account_id).first()


def upsert(db: Session, rec: NovaAccount) -> tuple[models.Customer, list[str]]:
    """Create or refresh ARI's record of this account. Nova's account_id stays the key."""
    link = _link(db, rec.account_id)
    c = db.get(models.Customer, link.customer_id) if link else None
    created = c is None
    if created:
        c = models.Customer(is_persona=False)
    assumed = _apply(rec, c)
    payload = json.dumps(rec.model_dump(mode="json", exclude_none=True))
    if created:
        db.add(c)
        db.flush()
        if link is None:
            link = ExternalCustomer(source=SOURCE, external_ref=rec.account_id, customer_id=c.customer_id,
                                    first_seen=now(), last_seen=now(), payload=payload)
            db.add(link)
        else:
            link.customer_id = c.customer_id
    link.last_seen, link.payload = now(), payload
    return c, assumed


def _transient(db: Session, rec: NovaAccount) -> tuple[models.Customer, list[str]]:
    """The same record, never stored - for previews. Keeps the stored id, if
    any, so the preview splits control exactly as a real request would."""
    link = _link(db, rec.account_id)
    c = models.Customer(is_persona=False)
    assumed = _apply(rec, c)
    c.customer_id = link.customer_id if link else None
    return c, assumed


# ---------------------------------------------------------------------------
# Routing: which live strategy owns this account
# ---------------------------------------------------------------------------
def _in_journey(db: Session, customer_id: int) -> Decision | None:
    """An account already decided by a running strategy - or by an earlier
    version of one, which keeps its customers - is mid-journey, not new."""
    running = db.query(Campaign).filter(Campaign.status.in_(["Live", "Paused"])).all()
    owners = {cid for camp in running for cid in engine.lineage(db, camp)}
    if not owners:
        return None
    return (db.query(Decision).filter(Decision.customer_id == customer_id, Decision.campaign_id.in_(owners))
            .order_by(Decision.decided_at.desc()).first())


def _specificity(camp: Campaign) -> tuple:
    """Most specific audience first: fewer cohorts, fewer fit groups, more
    filters. Then the earliest launched. A strategy written for exactly this
    kind of account beats a broad one that also covers it."""
    filters = sum(v is not None for v in (camp.min_dpd, camp.max_dpd, camp.min_balance, camp.max_balance))
    return (len(jl(camp.target_cohorts)) or 99, len(jl(camp.include_segments)),
            -(filters + len(jl(camp.risk_bands))), camp.launched_at or "", camp.campaign_id)


def route(db: Session, c) -> tuple[Campaign | None, list[dict]]:
    """Every live strategy is checked; the account goes to the most specific
    one whose audience includes it. One customer, one strategy."""
    checked, chosen = [], None
    for camp in sorted(db.query(Campaign).filter(Campaign.status == "Live"), key=_specificity):
        ok, why = engine.in_audience(camp, c)
        checked.append({"strategy_id": camp.campaign_id, "name": camp.name, "matches": ok,
                        "reason": "assigned" if ok and chosen is None else ("also matches" if ok else why)})
        if ok and chosen is None:
            chosen = camp
    return chosen, checked


# ---------------------------------------------------------------------------
# Describing a decision back to the caller
# ---------------------------------------------------------------------------
def _customer_out(rec_id: str, c) -> dict:
    return {"account_id": rec_id, "ari_customer_id": c.customer_id, "cohort": c.cohort_id,
            "days_past_due": c.days_past_due, "risk_band": c.client_risk_band,
            "intervention_fit": FIT_LABEL.get(c.segment, c.segment), "fit_group": c.segment,
            "nudge_score": c.nudge_score, "self_cure_score": c.self_cure_score}


def _treatment_out(db: Session, code: str | None) -> dict | None:
    if not code:
        return None
    t = db.get(models.Strategy, code)
    m = db.get(TreatmentMeta, code)
    return {"code": code, "name": t.name if t else code, "kind": m.kind if m else None,
            "channel": t.channel if t else None, "offer": t.offer if t else None,
            "timing": t.timing if t else None, "cost_per_contact": t.cost_per_contact if t else None}


def describe(db: Session, dec: Decision, c, camp: Campaign, account_id: str, *, preview: bool = False,
             existing: bool = False, assumed: list[str] | None = None, checked: list[dict] | None = None) -> dict:
    """The decision in the caller's terms: what to do, why, and what comes next."""
    t = _treatment_out(db, dec.treatment_code)
    nudge = None if preview else (db.query(Nudge).filter(Nudge.decision_id == dec.decision_id)
                                  .order_by(Nudge.scheduled_at).first())
    outcome = None if preview else db.query(Outcome).filter(Outcome.decision_id == dec.decision_id).first()
    window = camp.evaluation_days
    p = dec.selection_probability or 0.0
    blocked = jl(dec.blocked_arms)
    # Treated, but every eligible treatment was blocked by the contact rules
    # before sampling (an override to "no treatment" is a different thing).
    none_allowed = dec.group == "Treatment" and not dec.treatment_code and not dec.overridden

    if preview and dec.group == "Control":
        action = "control_bau"
        summary = ("Preview: this account would be held out as control and stay on business as usual. "
                   "Nothing was recorded.")
    elif preview and none_allowed:
        action = "would_be_blocked"
        summary = f"Preview: {dec.explanation} Nothing was recorded."
    elif preview:
        needs_person = dec.review_policy == "human_review"
        action = "would_need_approval" if needs_person else "would_contact"
        summary = (f"ARI would offer {t['name']} via {t['channel']} ({p:.0%} of the time for accounts like "
                   f"this)" + (", after a person approves it" if needs_person else "")
                   + ". Nothing was recorded or sent.")
    elif dec.group == "Control":
        action = "control_bau"
        summary = ("Randomised control: keep this account on the bank's business-as-usual process. Its outcome "
                   "is the comparison every treated result is measured against, so please still report it.")
    elif none_allowed:
        action = "contact_blocked"
        summary = dec.explanation
    elif dec.review_status == "cancelled":
        action = "cancelled"
        summary = f"{t['name']} was proposed, then withdrawn before anything was sent. {dec.exclusion_reason}"
    elif dec.review_status == "pending":
        action = "awaiting_approval"
        summary = (f"{t['name']} via {t['channel']}, chosen by Thompson sampling ({p:.0%} of the time for "
                   f"accounts like this). It changes what the customer owes, so a person approves it in the "
                   f"ARI Review Queue before anything is sent. Consent and contact limits are checked again "
                   f"against Nova's newest data when it is approved.")
    elif dec.review_status == "rejected":
        action = "rejected"
        summary = f"{t['name']} was proposed, and a reviewer declined it. Nothing was sent."
    elif nudge is not None and nudge.status == "Held":
        action = "contact_blocked"
        summary = f"{t['name']} was chosen, but the send-time contact check held it: {nudge.failure_reason}."
    elif nudge is not None and nudge.status == "Failed":
        action = "contact_failed"
        summary = (f"{t['name']} via {t['channel']} was chosen, but the simulated send failed "
                   f"({nudge.failure_reason}). No channel gateway is connected; nobody was contacted.")
    else:
        action = "contact"
        summary = (f"{t['name']} via {t['channel']}, chosen by Thompson sampling ({p:.0%} of the time for "
                   f"accounts like this). Simulated send: no channel gateway is connected, so nobody is contacted.")

    message = None
    if t:
        message = nudge.content if nudge else engine.render(dec.treatment_code, camp.tone, c,
                                                            db.get(models.Strategy, dec.treatment_code),
                                                            due=engine.message_amount(dec, c))
    contact = None
    if nudge is not None:
        stages = jl(nudge.pipeline)
        guard_stage = next((s for s in stages if s["stage"] == "Compliance check"), None)
        contact = {"nudge_id": nudge.nudge_id, "channel": nudge.channel, "send_at": nudge.scheduled_at,
                   "status": nudge.status, "guard": guard_stage["detail"] if guard_stage else None,
                   "simulated": True}

    if preview:
        next_step = "Call get_recovery_strategy with the same account to record the decision and act on it."
    elif action in ("contact", "contact_blocked", "contact_failed", "control_bau", "awaiting_approval"):
        next_step = (("Check get_decision for the approval, then report " if action == "awaiting_approval"
                      else "Report ")
                     + f"the payment outcome after the {window}-day window: "
                       f"report_payment_outcome(decision_id='{dec.decision_id}', paid=true|false).")
    else:
        next_step = None

    out = {
        "decision_id": None if preview else dec.decision_id,
        "action": action,
        "summary": summary,
        "existing": existing,
        "customer": _customer_out(account_id, c),
        "strategy": {"strategy_id": camp.campaign_id, "name": camp.name, "version": camp.version,
                     "evaluation_days": window},
        "group": dec.group,
        "treatment": t,
        "selection_probability": dec.selection_probability,
        "alternatives": [{"code": r["code"], "name": r["name"], "selection_probability": r.get("selection_probability"),
                          "belief": r["belief"], "customer_fit": r["fit"], "fit_reasons": r.get("fit_reasons", [])}
                         for r in jl(dec.ranking)],
        # Eligible, but blocked by the contact rules before Thompson sampling: never sampled.
        "blocked_treatments": [{"code": b["code"], "name": b["name"], "reason_code": b["reason_code"],
                                "reason": b["reason"]} for b in blocked],
        "explanation": dec.explanation,
        "message": message,
        "contact": contact,
        "review": {"required": dec.review_policy == "human_review", "status": dec.review_status},
        "outcome": None if outcome is None else {"paid": outcome.paid, "amount": outcome.amount,
                                                 "days_to_pay": outcome.days_to_pay, "learned": outcome.learned},
        "decided_at": None if preview else dec.decided_at,
        "next_step": next_step,
        "model_version": cfg(db, "model_version"),
    }
    if preview and c.customer_id is None:
        out["note"] = (f"New account: in a real request {camp.control_pct:.0%} of accounts are held out at random "
                       f"as control, so this account could land in control instead.")
    if assumed:
        out["assumed"] = assumed
    if checked:
        out["strategies_checked"] = checked
    return out


def _no_action(account_id: str, c, reason: str, *, checked: list[dict] | None = None,
               assumed: list[str] | None = None, action: str = "no_action") -> dict:
    out = {"decision_id": None, "action": action, "summary": reason, "existing": False,
           "customer": _customer_out(account_id, c) if c is not None else {"account_id": account_id},
           "strategy": None, "treatment": None, "next_step": None}
    if checked:
        out["strategies_checked"] = checked
    if assumed:
        out["assumed"] = assumed
    return out


# ---------------------------------------------------------------------------
# The calls
# ---------------------------------------------------------------------------
def recovery_strategy(db: Session, rec: NovaAccount, *, record: bool = True) -> dict:
    """The recovery action for one account. record=False is a dry run: nothing
    is stored, sent or learned, and the account stays free for a real request."""
    if rec.days_past_due == 0:
        return _no_action(rec.account_id, None, "Not in arrears (0 days past due): no recovery action.")
    if record:
        c, assumed = upsert(db, rec)
    else:
        c, assumed = _transient(db, rec)

    if rec.vulnerability_flag:
        cancelled = []
        if record:
            # An offer still waiting for review must not go out to a customer
            # who is now flagged as vulnerable.
            reason = (f"Nova reported a vulnerability flag on {now()[:10]}, after this offer was proposed. No "
                      f"automated treatment: refer the customer to a trained specialist.")
            for dec in db.query(Decision).filter(Decision.customer_id == c.customer_id,
                                                 Decision.review_status == "pending"):
                engine.cancel_pending(dec, reason, ACTOR)
                audit(db, ACTOR, "UPDATE", "decision", dec.decision_id,
                      f"Cancelled {dec.decision_id} ({dec.treatment_code}) before review: vulnerability flag")
                cancelled.append(dec.decision_id)
            db.commit()
        out = _no_action(rec.account_id, c, "Vulnerability flag on file: no automated treatment. Refer the "
                                            "customer to a trained specialist."
                         + (f" Cancelled the offer still waiting for review ({', '.join(cancelled)})."
                            if cancelled else ""), assumed=assumed, action="refer_to_specialist")
        if cancelled:
            out["cancelled_decisions"] = cancelled
        return out

    if record:
        ongoing = _in_journey(db, c.customer_id)
        if ongoing is not None:
            camp = db.get(Campaign, ongoing.campaign_id)
            db.commit()
            out = describe(db, ongoing, c, camp, rec.account_id, existing=True, assumed=assumed)
            out["summary"] = f"Already in {camp.campaign_id} since {ongoing.decided_at[:10]}. " + out["summary"]
            return out

    camp, checked = route(db, c)
    if camp is None:
        if record:
            db.commit()
        handling = SEGMENT_ACTION.get(c.segment, "")
        why = ("no live strategy targets this account" if not checked else
               "no live strategy's audience includes this account")
        return _no_action(rec.account_id, c, f"{FIT_LABEL.get(c.segment, c.segment)}: {why}. Default handling: "
                                             f"{handling[0].lower() + handling[1:] if handling else 'business as usual'}.",
                          checked=checked, assumed=assumed)

    # Frozen with the decision. "arrears" is Nova's amount_past_due, never an
    # estimate: a message quotes it, or names no figure when Nova sent none.
    extra = {"source": "Nova (MCP)", "account_id": rec.account_id,
             "amount_past_due": rec.amount_past_due, "arrears": rec.amount_past_due,
             "reported_contacts_7d": rec.contacts_last_7d or 0,
             "no_consent": [k for k, v in (rec.consent.model_dump() if rec.consent else {}).items() if v is False]}
    if not record:
        wave = camp.waves_run + 1
        seed = hashlib.sha256(f"{camp.campaign_id}:{c.customer_id}:{wave}".encode()).hexdigest()[:8]
        dec = engine.decide_one(db, camp, c, decision_id="PREVIEW", wave=wave, decided_at=datetime.now(UTC),
                                rng=np.random.default_rng(int(seed, 16)), arms_state=engine.beliefs(db, camp),
                                human_review=human_review_codes(db), auto_approve=False, origin="mcp",
                                extra_snapshot=extra)
        return describe(db, dec, c, camp, rec.account_id, preview=True, assumed=assumed, checked=checked)

    dec, _ = engine.decide_now(db, camp, c, origin="mcp", extra_snapshot=extra)
    return describe(db, dec, c, camp, rec.account_id, assumed=assumed, checked=checked)


def _decision_for(db: Session, decision_id: str | None, account_id: str | None) -> Decision:
    if decision_id:
        dec = db.get(Decision, decision_id)
        if dec is None:
            raise NovaError(f"No decision {decision_id}.")
        return dec
    if account_id:
        link = _link(db, account_id)
        dec = None if link is None else (db.query(Decision).filter(Decision.customer_id == link.customer_id)
                                         .order_by(Decision.decided_at.desc()).first())
        if dec is None:
            raise NovaError(f"No decision for account {account_id}.")
        return dec
    raise NovaError("Give a decision_id or an account_id.")


def _account_of(db: Session, dec: Decision) -> str:
    link = db.query(ExternalCustomer).filter_by(source=SOURCE, customer_id=dec.customer_id).first()
    return link.external_ref if link else f"ARI-{dec.customer_id}"


def get_decision(db: Session, decision_id: str | None = None, account_id: str | None = None) -> dict:
    dec = _decision_for(db, decision_id, account_id)
    c = db.get(models.Customer, dec.customer_id)
    return describe(db, dec, c, db.get(Campaign, dec.campaign_id), _account_of(db, dec), existing=True)


def _not_sent(dec: Decision, first) -> str:
    if not dec.treatment_code:
        return "every eligible treatment was blocked by the contact rules"
    if dec.review_status in ("pending", "cancelled", "rejected"):
        return {"pending": "still awaiting approval", "cancelled": "the offer was cancelled before review",
                "rejected": "a reviewer declined the offer"}[dec.review_status]
    return first.status.lower() if first else "not sent"


def report_outcome(db: Session, rep: PaymentReport) -> dict:
    """Record a payment outcome and learn from it where the rules allow."""
    dec = _decision_for(db, rep.decision_id, rep.account_id)
    if dec.origin != "mcp":
        raise NovaError(f"{dec.decision_id} was decided in a console wave; its outcome comes from the simulator, "
                        f"not from a report.")
    camp = db.get(Campaign, dec.campaign_id)
    decided = datetime.fromisoformat(dec.decided_at)
    paid = rep.paid and rep.payment_status == "Posted"
    days = None
    if paid and rep.payment_date is not None:
        days = (rep.payment_date - decided.date()).days
        if days < 0:
            raise NovaError(f"payment_date {rep.payment_date} is before the decision ({decided.date()}).")
    in_window = days is None or days <= camp.evaluation_days
    success = paid and in_window

    first = (db.query(Nudge).filter(Nudge.decision_id == dec.decision_id).order_by(Nudge.scheduled_at).first())
    delivered = first is not None and first.status not in ("Failed", "Held")
    treated = dec.group == "Treatment"
    learnable = treated and delivered and not dec.overridden and (
        dec.review_policy == "auto" or dec.review_status == "approved")
    code = dec.treatment_code
    before = engine.beliefs(db, camp).get(code) if treated and code else None

    o = db.query(Outcome).filter(Outcome.decision_id == dec.decision_id).first()
    corrected = o is not None
    if o is None:
        o = Outcome(decision_id=dec.decision_id, campaign_id=dec.campaign_id, customer_id=dec.customer_id)
        db.add(o)
    o.paid = paid
    # No amount reported: fall back to the amount past due Nova sent with the
    # account - never to an estimate. 0 when Nova sent neither.
    sent_due = jl(dec.snapshot, {}).get("amount_past_due")
    o.amount = round(rep.amount if rep.amount is not None else (sent_due or 0.0), 2) if paid else 0.0
    o.days_to_pay = days if paid else None
    o.escalated = False
    o.window_days = camp.evaluation_days
    # Control outcomes always count - they are the comparison. A treatment that
    # never reached the customer says nothing about the treatment.
    o.reward = (1.0 if success else 0.0) if (not treated or delivered) else None
    o.learned = learnable
    o.observed_at = iso(datetime.now(UTC))
    db.flush()
    after = engine.beliefs(db, camp).get(code) if treated and code else None

    if not treated:
        note = "Recorded as a control outcome: it is the comparison for uplift, not something to learn from."
    elif dec.overridden:
        note = "Recorded, not learned from: a person overrode this decision."
    elif not delivered:
        note = ("Recorded, not learned from: the treatment never reached the customer "
                f"({_not_sent(dec, first)}).")
    elif not learnable:
        note = "Recorded, not learned from: the offer was not approved."
    else:
        note = (f"Learned: {before['name']}'s estimated payment rate in {camp.campaign_id} moved from "
                f"{before['mean']:.1%} to {after['mean']:.1%} ({after['learned']} outcomes).")
    if paid and not in_window:
        note += (f" Paid {days} days after the decision, outside the {camp.evaluation_days}-day window: counted "
                 f"as not paid for learning (late payments are an open design item).")
    if rep.paid and rep.payment_status == "Reversed":
        note += " The payment was reversed, so it counts as not paid."

    db.commit()
    return {
        "decision_id": dec.decision_id, "recorded": True, "corrected": corrected,
        "paid": paid, "counted_as_success": success, "learned": learnable, "note": note,
        "learning": None if before is None else {
            "treatment": {"code": code, "name": before["name"]},
            "belief_before": round(before["mean"], 4), "belief_after": round(after["mean"], 4),
            "outcomes_learned": after["learned"]},
    }


def strategies(db: Session) -> list[dict]:
    names = {k: v for k, v in ((c.cohort_id, c.name) for c in db.query(models.Cohort))}
    out = []
    for camp in (db.query(Campaign).filter(Campaign.status == "Live")
                 .order_by(Campaign.launched_at, Campaign.campaign_id)):
        s = analytics.campaign_stats(db, camp)
        learning = engine.learning(db, camp)["waves"][-1]["posterior"]
        lead = max(learning.items(), key=lambda kv: kv[1]["p_best"]) if learning else None
        treatments = [_treatment_out(db, x) for x in jl(camp.treatment_codes)]
        out.append({
            "strategy_id": camp.campaign_id, "name": camp.name, "version": camp.version,
            "description": camp.description,
            "audience": {"cohorts": [f"{x} {names.get(x, '')}".strip() for x in jl(camp.target_cohorts)],
                         "fit_groups": [FIT_LABEL.get(g, g) for g in jl(camp.include_segments)],
                         "risk_bands": jl(camp.risk_bands) or "any",
                         "days_past_due": [camp.min_dpd, camp.max_dpd], "balance": [camp.min_balance, camp.max_balance]},
            "treatments": [{"code": t["code"], "name": t["name"], "channel": t["channel"]} for t in treatments if t],
            "control_share": camp.control_pct, "evaluation_days": camp.evaluation_days,
            "results": {"treated": s["treated"], "control": s["control"], "recovery_rate": s["recovery_rate"],
                        "control_rate": s["control_rate"], "uplift": s["uplift"], "significant": s["significant"]},
            "leading_treatment": None if lead is None else {"code": lead[0], "probability_best": round(lead[1]["p_best"], 3)},
        })
    return out


def treatments(db: Session) -> list[dict]:
    from . import playbook
    return [{k: t[k] for k in ("code", "name", "kind", "channel", "offer", "timing", "eligibility_rule", "cost",
                               "human_review", "historical_rate", "historical_n")}
            for t in playbook.list_treatments(db) if t["status"] == "Active"]
