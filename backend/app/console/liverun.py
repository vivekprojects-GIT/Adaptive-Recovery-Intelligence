"""Live run: one customer at a time through a live strategy, step by step.

The run uses the engine itself - the same rules, Thompson sampling, send,
outcome and learning a wave uses - and stores everything it does, so the
customer's journey, the decision audit and the strategy's results all show it.

Two scenarios, as the business asked to see them:
  pays   - the first message works: the customer pays inside the window.
  retry  - the first treatment gets no answer; the engine learns from that,
           sets it aside for this customer, draws again among the rest, and
           the second treatment works.
A scenario picks a customer whose run turns out that way: candidates are tried
in the strategy's own order and any run that does not match is rolled back
before anything is committed.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

import numpy as np
from sqlalchemy.orm import Session

from .. import models
from ..scoring import fit_reasons
from . import engine
from .engine import (Seq, _bucket, _observe, add_decision, arrears, beliefs, channel_of, decide_one, execute, first_name,
                     jl, parse, target_customers, undecided_pool)
from .models import Campaign, EngagementEvent, Nudge, Outcome
from .nlq import COHORT_NAMES
from .platform import cfg_float
from .playbook import human_review_codes

UTC = timezone.utc
SCENARIOS = ("pays", "retry")
GATEWAY = {"SMS": "SMS gateway", "SMS + App": "SMS gateway", "App push": "Push service", "Email": "Email service",
           "Letter": "Print and mail", "Outbound call": "Dialler", "Specialist team": "Specialist team queue"}
# How many waiting customers a run looks through, and draws per customer.
CANDIDATES, DRAWS = 60, 4


def _standing(db: Session, camp: Campaign) -> list[dict]:
    """Each treatment's record in this strategy now. The same random draws every
    time, so a change between two calls is the outcome, not sampling noise."""
    b = beliefs(db, camp)
    pb = engine._p_best({k: (v["a"], v["b"]) for k, v in b.items()}, np.random.default_rng(17), draws=20000)
    return [{"code": k, "name": v["name"], "channel": channel_of(db, k), "mean": round(v["mean"], 4),
             "low": round(v["low"], 4), "high": round(v["high"], 4), "p_best": round(pb.get(k, 0.0), 4),
             "learned": v["learned"]} for k, v in b.items()]


def strategies(db: Session) -> list[dict]:
    out = []
    for camp in db.query(Campaign).filter(Campaign.status == "Live").order_by(Campaign.campaign_id):
        waiting = len(undecided_pool(db, camp))
        out.append({"id": camp.campaign_id, "name": camp.name, "audience": len(target_customers(db, camp)),
                    "waiting": waiting, "window_days": camp.evaluation_days,
                    "treatments": [{"code": a["code"], "name": a["name"], "channel": a["channel"]}
                                   for a in _standing(db, camp)]})
    return out


def _customer(c) -> dict:
    return {"id": c.customer_id, "name": c.name, "first": first_name(c), "days_past_due": c.days_past_due,
            "balance": round(c.balance, 2), "past_due": round(arrears(c), 2), "risk": c.client_risk_band,
            "late": COHORT_NAMES.get(c.cohort_id, c.cohort_id), "sms": bool(c.sms_responsive), "app": bool(c.app_user),
            "missed": c.missed_payments, "hardship": bool(c.hardship_flag)}


def _choice(db: Session, dec, c, arms_before: list[dict], set_aside: str | None, named: str | None = None) -> dict:
    """What the engine weighed: every treatment, allowed or not, with its record
    and this customer's draw; and whether the pick was the proven one or a test."""
    ranking = {r["code"]: r for r in jl(dec.ranking, [])}
    blocked = {b["code"]: b for b in jl(dec.blocked_arms, [])}
    eligible = set(jl(dec.eligible_arms, []))
    rows = []
    for a in arms_before:
        r = ranking.get(a["code"])
        if a["code"] == set_aside:
            why = "Tried already for this customer"
        elif named and not r and a["code"] != named:
            why = "Not the strategy's next try"
        elif r:
            why = None
        elif a["code"] in blocked:
            why = "; ".join(x["reason"] for x in blocked[a["code"]]["reasons"])
        elif a["code"] not in eligible:
            why = "Customer not eligible"
        else:
            why = "Not allowed"
        rows.append({**a, "allowed": r is not None, "why_not": why,
                     "draw": r["base_sample"] if r else None, "fit": r["fit"] if r else None,
                     "score": r["score"] if r else None, "chosen": a["code"] == dec.treatment_code})
    allowed = [x for x in rows if x["allowed"]]
    best = max(allowed, key=lambda x: x["mean"])
    chosen = next(x for x in rows if x["chosen"])
    exploit = best["code"] == chosen["code"]
    if named:
        reason = f"The strategy names {chosen['name']} as the next try, so the engine sends it."
    elif exploit:
        reason = f"{chosen['name']} has the best record so far ({chosen['mean']:.0%} paid) and its draw came out on top."
    elif chosen["learned"] < best["learned"]:
        reason = (f"{best['name']} has the better record ({best['mean']:.0%}), but {chosen['name']} has fewer results, "
                  f"so its range is wider. Its draw came out higher, so the engine tests it.")
    else:
        reason = (f"{best['name']} has the better record ({best['mean']:.0%}), but {chosen['name']} could still be "
                  f"the best. Its draw came out higher this time, so the engine tests it.")
    return {"treatments": rows, "chosen": {k: chosen[k] for k in ("code", "name", "channel")},
            "mode": "named" if named else "exploit" if exploit else "explore", "reason": reason,
            "fit_reasons": fit_reasons(dec.treatment_code, c), "chosen_share": dec.selection_probability,
            "set_aside": set_aside}


def _contact(db: Session, nudge: Nudge, day0: datetime) -> dict:
    stages = {s["stage"]: s for s in jl(nudge.pipeline, [])}
    sent = parse(nudge.sent_at) if nudge.sent_at else parse(nudge.scheduled_at)
    events = (db.query(EngagementEvent).filter(EngagementEvent.nudge_id == nudge.nudge_id)
              .order_by(EngagementEvent.at).all())
    return {"nudge_id": nudge.nudge_id, "touch": nudge.touch_number, "channel": nudge.channel,
            "gateway": GATEWAY.get(nudge.channel, nudge.channel), "content": nudge.content, "status": nudge.status,
            "ref": f"MSG-{nudge.nudge_id[2:]}", "day": (sent - day0).days, "sent_at": nudge.sent_at,
            "rules_check": stages.get("Compliance check", {}).get("detail"),
            "events": [{"event": e.event, "minutes": round((parse(e.at) - sent).total_seconds() / 60)} for e in events]}


def _attempt(db: Session, camp: Campaign, c, at: datetime, rng, seq: Seq, *, set_aside: str | None,
             origin: str, want_paid: bool, want_quiet: bool) -> dict | None:
    """Decide, send and observe one treatment for one customer. None when the
    run did not turn out as the scenario needs (the caller rolls back)."""
    arms_before = _standing(db, camp)
    state = beliefs(db, camp)
    if origin == "next_try":
        state = engine.next_try_state(db, camp, c, state)
        if not state:
            return None
    dec = decide_one(db, camp, c, decision_id=seq.decision(), wave=camp.waves_run + 1, decided_at=at, rng=rng,
                     arms_state=state, human_review=human_review_codes(db), auto_approve=False, origin=origin)
    if dec.group != "Treatment" or not dec.treatment_code or dec.review_status == "pending":
        return None
    if set_aside is None and not want_paid and not engine.next_try_state(
            db, camp, c, {k: None for k in jl(camp.treatment_codes) if k != dec.treatment_code}):
        return None   # nothing left to try second
    add_decision(db, dec)
    first = execute(db, camp, dec, c, at, rng, seq)
    if first.status != "Delivered":
        return None
    _observe(db, camp, dec, c, dec.treatment_code, at, rng, [], first=first, seq=seq)
    db.flush()
    out = db.query(Outcome).filter(Outcome.decision_id == dec.decision_id).one()
    contacts = [_contact(db, n, at) for n in db.query(Nudge).filter(Nudge.decision_id == dec.decision_id)
                .order_by(Nudge.scheduled_at).all()]
    if out.paid != want_paid or not out.learned:
        return None
    if want_quiet and any(x["events"] for x in contacts):
        return None
    named = camp.escalate_to if origin == "next_try" else None
    return {"decision_id": dec.decision_id, "day": 0, "choice": _choice(db, dec, c, arms_before, set_aside, named),
            "contacts": contacts,
            "outcome": {"outcome_id": out.outcome_id, "paid": out.paid, "amount": round(out.amount, 2),
                        "days_to_pay": out.days_to_pay, "window_days": out.window_days, "reward": out.reward,
                        "learned": out.learned},
            "arms_before": arms_before, "arms_after": _standing(db, camp)}


# Channels the customer's phone on the screen can show.
ON_PHONE = ("SMS", "SMS + App", "App push", "Outbound call")


def _fit(scenario: str, one: dict, has_sms: bool) -> int | None:
    """How well a run shows the scenario: 0 is the run it is after, higher is a
    fallback, None does not show it. The first scenario looks for a text message
    the customer taps through to pay; failing that, any message the phone shows
    that the customer taps; failing that, one they pay after without tapping."""
    if scenario == "retry":
        return 0
    channel = one["choice"]["chosen"]["channel"]
    if channel not in ON_PHONE:
        return None
    tapped = any(e["event"] == "Clicked" for e in one["contacts"][0]["events"])
    if tapped and (channel.startswith("SMS") or not has_sms):
        return 0
    return 1 if tapped else 2


def run(db: Session, cid: str, scenario: str) -> dict | None:
    """One scenario on one live strategy. Returns the full trace, or None when
    no waiting customer turns out the way the scenario needs."""
    camp = db.get(Campaign, cid)
    pool = undecided_pool(db, camp)
    waiting, audience = len(pool), len(target_customers(db, camp))
    threshold = cfg_float(db, "human_review_balance_threshold")
    candidates = [c.customer_id for c in pool if c.balance < threshold and not getattr(c, "route_validation", False)
                  and _bucket(camp.campaign_id, c.customer_id) >= camp.control_pct][:CANDIDATES]
    window = camp.evaluation_days
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    # Dated so the last outcome lands today: the run replays the days it covers.
    start = now - timedelta(days=window if scenario == "pays" else 2 * window + 1)
    has_sms = any(a["channel"].startswith("SMS") for a in _standing(db, camp))

    def play(cust_id: str, draw: int):
        """One customer, one draw. The same inputs give the same run, so the
        best fallback can be played again after it was rolled back."""
        camp, c = db.get(Campaign, cid), db.get(models.Customer, cust_id)
        seed = int(hashlib.sha256(f"live:{cid}:{cust_id}:{scenario}:{draw}".encode()).hexdigest()[:8], 16)
        rng = np.random.default_rng(seed)
        seq = Seq(db)
        one = _attempt(db, camp, c, start, rng, seq, set_aside=None, origin="wave",
                       want_paid=scenario == "pays", want_quiet=scenario == "retry")
        if not one:
            return None
        two = None
        if scenario == "retry":
            # The miss is closed off the way a wave closes it: the next try is decided.
            db.get(Outcome, one["outcome"]["outcome_id"]).escalated = True
            second_at = start + timedelta(days=window + 1)
            two = _attempt(db, camp, c, second_at, rng, seq, set_aside=one["choice"]["chosen"]["code"],
                           origin="next_try", want_paid=True, want_quiet=False)
            if not two:
                return None
            two["day"] = window + 1
            for x in two["contacts"]:
                x["day"] += window + 1
        fit = _fit(scenario, one, has_sms)
        return None if fit is None else (fit, [x for x in (one, two) if x], c)

    def keep(attempts, c) -> dict:
        camp = db.get(Campaign, cid)
        wave = camp.waves_run + 1
        if engine._treated_in_wave(db, camp, wave) >= camp.wave_size:
            camp.waves_run = wave
        db.commit()
        return {"scenario": scenario, "started": engine.iso(start),
                "strategy": {"id": camp.campaign_id, "name": camp.name, "audience": audience,
                             "waiting": waiting, "window_days": window, "tone": camp.tone},
                "customer": _customer(c), "attempts": attempts}

    best = None   # (fit, customer, draw) of the best fallback seen
    for cust_id in candidates:
        for draw in range(DRAWS):
            got = play(cust_id, draw)
            if got and got[0] == 0:
                return keep(got[1], got[2])
            if got and (best is None or got[0] < best[0]):
                best = (got[0], cust_id, draw)
            db.rollback()
    if best:
        got = play(best[1], best[2])
        if got:
            return keep(got[1], got[2])
        db.rollback()
    return None
