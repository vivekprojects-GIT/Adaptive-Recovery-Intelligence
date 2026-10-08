"""Propensity Router: every customer passes through it before any strategy.

ARI classifies each customer from two propensity scores (scoring.py): how
likely a treatment is to change what they do, and how likely they are to pay
without help. The fit group decides the route:

  Likely responsive  -> strategy            a live strategy's audience, then Thompson sampling
  Likely self-cure   -> business as usual   they are expected to pay anyway
  Needs support      -> hardship team       reminders will not help
  Do not contact     -> suppressed          contact is likely to backfire

This is platform policy: the same for every strategy and every channel, set
in Platform Config, never per strategy.

A small validation share of the self-cure and needs-support groups is sent to
strategies anyway, against the route, so the router itself can be scored:
without treated customers in those groups nobody can check that treating them
really makes no difference. Their outcomes are recorded, never taught to
Thompson sampling, and kept out of strategy results. Do not contact is never
in the validation share. Which customers are in it is fixed by their id, so
a customer's route does not change from one request to the next.
"""
from __future__ import annotations

import hashlib
import random
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from .. import models
from ..scoring import nudge_score, segment_for, self_cure_score
from ..simulation import true_pay_probability
from .models import Decision, ExternalCustomer, Routing
from .platform import cfg_float

UTC = timezone.utc
POLICY = "propensity-router/1"

ROUTES = {"Persuadable": "strategy", "Sure Thing": "bau", "Lost Cause": "hardship", "Sleeping Dog": "suppress"}
ROUTE_LABEL = {"strategy": "Strategy", "bau": "Business as usual", "hardship": "Hardship team",
               "suppress": "Suppressed"}
GROUP_LABEL = {"Persuadable": "Likely responsive", "Sure Thing": "Likely self-cure", "Lost Cause": "Needs support",
               "Sleeping Dog": "Do not contact"}
WHY = {
    "Persuadable": "a treatment can change what they do, so a strategy decides how to contact them",
    "Sure Thing": "expected to pay without help, so contacting them would add cost and change nothing",
    "Lost Cause": "cannot pay what is due, so reminders will not help; the hardship team takes them",
    "Sleeping Dog": "contact is likely to make things worse, so nothing is sent",
}
# Groups whose route is checked by sending a few to strategies anyway.
VALIDATED = ("Sure Thing", "Lost Cause")
OUTCOME_WINDOW_DAYS = 7


def _in_validation_share(customer_id: int | None, share: float) -> bool:
    if customer_id is None or share <= 0:
        return False
    h = hashlib.sha256(f"router-validation:{customer_id}".encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF < share


def validation_share(db: Session) -> float:
    return max(0.0, min(0.10, cfg_float(db, "router_validation_share")))


def decide(c, share: float) -> dict:
    """The route for one customer. Pure: the same customer always gets the same answer."""
    group = c.segment
    route = ROUTES.get(group, "bau")
    validation = group in VALIDATED and _in_validation_share(c.customer_id, share)
    if validation:
        reason = (f"{GROUP_LABEL[group]}: normally {ROUTE_LABEL[route].lower()}, but in the "
                  f"{share:.0%} validation share, so a strategy treats them to check that the route is right")
        route = "strategy"
    else:
        reason = f"{GROUP_LABEL.get(group, group)}: {WHY.get(group, 'business as usual')}"
    return {"policy": POLICY, "fit_group": group, "fit_label": GROUP_LABEL.get(group, group),
            "nudge_score": c.nudge_score, "self_cure_score": c.self_cure_score,
            "route": route, "route_label": ROUTE_LABEL[route], "validation": validation, "reason": reason}


def classify(c) -> None:
    """Score the customer and set their fit group."""
    c.nudge_score = nudge_score(c)
    c.self_cure_score = self_cure_score(c)
    c.segment = segment_for(c)


def apply(c, share: float) -> dict:
    """Classify and route without recording anything (a preview)."""
    classify(c)
    r = decide(c, share)
    c.route, c.route_validation = r["route"], r["validation"]
    c._routing = r   # the full answer, for whoever describes this customer next
    return r


def record(db: Session, c, *, origin: str, at: datetime, simulate: bool) -> Routing:
    """Route a stored customer and log it. For test handoffs, a customer kept off
    strategies gets a simulated outcome after the window; Nova reports its own."""
    r = apply(c, validation_share(db))
    row = Routing(customer_id=c.customer_id, origin=origin, policy=POLICY, fit_group=r["fit_group"],
                  nudge_score=r["nudge_score"], self_cure_score=r["self_cure_score"], route=r["route"],
                  validation=r["validation"], reason=r["reason"],
                  routed_at=at.astimezone(UTC).isoformat(timespec="seconds"), window_days=OUTCOME_WINDOW_DAYS)
    if simulate and r["route"] != "strategy":
        from .engine import arrears   # engine imports this module
        rng = random.Random(c.customer_id * 7919 + 13)
        paid = rng.random() < true_pay_probability(c, None)
        days = rng.randint(1, OUTCOME_WINDOW_DAYS) if paid else OUTCOME_WINDOW_DAYS
        row.paid, row.amount = paid, (arrears(c) if paid else 0.0)
        row.observed_at = (at + timedelta(days=days)).astimezone(UTC).isoformat(timespec="seconds")
    db.add(row)
    return row


def route_unrouted(db: Session, at: datetime | None = None) -> int:
    """Route every customer that has not been through the router yet. Safe on every start."""
    at = at or datetime.now(UTC)
    todo = db.query(models.Customer).filter(models.Customer.route.is_(None)).all()
    for c in todo:
        record(db, c, origin="handoff", at=at, simulate=True)
    if todo:
        db.commit()
    return len(todo)


def reroute_undecided(db: Session, at: datetime | None = None) -> int:
    """Apply a changed routing policy to every customer no strategy has decided
    yet. Customers already decided keep the route they were decided under."""
    at = at or datetime.now(UTC)
    decided = {cid for (cid,) in db.query(Decision.customer_id).distinct()}
    from_nova = {cid for (cid,) in db.query(ExternalCustomer.customer_id)}
    share = validation_share(db)
    moved = 0
    for c in db.query(models.Customer).filter(models.Customer.route.isnot(None)):
        if c.customer_id in decided:
            continue
        r = decide(c, share)
        if (r["route"], r["validation"]) != (c.route, bool(c.route_validation)):
            # Nova reports its own accounts' outcomes; only test handoffs are simulated.
            record(db, c, origin="policy", at=at, simulate=c.customer_id not in from_nova)
            moved += 1
    db.commit()
    return moved


def latest(db: Session, customer_id: int) -> Routing | None:
    return (db.query(Routing).filter(Routing.customer_id == customer_id)
            .order_by(Routing.routing_id.desc()).first())


def routing_out(row: Routing | dict | None) -> dict | None:
    """The router's answer as an API block."""
    if row is None:
        return None
    if isinstance(row, dict):
        return {k: row[k] for k in ("policy", "fit_group", "fit_label", "nudge_score", "self_cure_score", "route",
                                    "route_label", "validation", "reason")}
    return {"policy": row.policy, "fit_group": row.fit_group, "fit_label": GROUP_LABEL.get(row.fit_group, row.fit_group),
            "nudge_score": row.nudge_score, "self_cure_score": row.self_cure_score, "route": row.route,
            "route_label": ROUTE_LABEL.get(row.route, row.route), "validation": row.validation, "reason": row.reason,
            "routed_at": row.routed_at}
