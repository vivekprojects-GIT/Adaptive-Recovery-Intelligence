"""Collections performance in industry terms, from the decision log.

Every figure is computed from decisions and their outcomes, never stored, and
each one comes with the formula that produced it so a reader can check it.

  Control       customers randomly held back on business as usual
  Experiment    customers the strategy treated
  Payment rate  accounts that paid anything within the window / accounts
  Cure rate     accounts that paid the full arrears within the window / accounts
  Liquidation   dollars recovered / dollars in arrears
  Cost to collect   contact cost / dollars recovered
  Cost per recovery contact cost / paying accounts

The Propensity Router's validation share is left out: it scores the router,
not the strategies.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from .. import models
from .models import Campaign, Decision, Nudge, Outcome

UTC = timezone.utc

FORMULAS = {
    "payment_rate": "Accounts that paid anything within the evaluation window ÷ accounts in the group",
    "cure_rate": "Accounts that paid their full arrears within the window ÷ accounts in the group",
    "liquidation_rate": "Dollars recovered ÷ dollars in arrears when the decision was made",
    "recovered": "Sum of payments received within the window",
    "lift": "Experiment payment rate − control payment rate, with a 95% range (Agresti-Caffo)",
    "incremental_recoveries": "Lift × accounts in the experiment",
    "cost_per_recovery": "Contact cost ÷ paying accounts",
    "cost_to_collect": "Contact cost ÷ dollars recovered",
    "avg_days_to_pay": "Average days from the decision to the payment, for accounts that paid",
    "volume": "Payments received in the period",
    "value": "Dollars received in the period",
}


def _arrears(d: Decision) -> float:
    return float(json.loads(d.snapshot or "{}").get("arrears") or 0.0)


def _group(rows: list[tuple[Decision, Outcome]], cost: float | None) -> dict:
    n = len(rows)
    payers = [(d, o) for d, o in rows if o.paid]
    cured = sum(1 for d, o in payers if o.amount >= _arrears(d) - 0.005)
    owed = sum(_arrears(d) for d, _ in rows)
    recovered = sum(o.amount for _, o in payers)
    days = [o.days_to_pay for _, o in payers if o.days_to_pay]
    rate = lambda x: round(x / n, 4) if n else None  # noqa: E731
    return {
        "accounts": n, "paying": len(payers), "cured": cured,
        "payment_rate": rate(len(payers)), "cure_rate": rate(cured),
        "arrears": round(owed, 2), "recovered": round(recovered, 2),
        "liquidation_rate": round(recovered / owed, 4) if owed else None,
        "avg_days_to_pay": round(sum(days) / len(days), 1) if days else None,
        "contact_cost": None if cost is None else round(cost, 2),
        "cost_per_recovery": round(cost / len(payers), 2) if cost is not None and payers else None,
        "cost_to_collect": round(cost / recovered, 4) if cost is not None and recovered else None,
    }


def _lift(t: dict, c: dict) -> dict:
    tn, cn = t["accounts"], c["accounts"]
    if not tn or not cn:
        return {"value": None, "ci": None, "significant": False}
    n1, n2 = tn + 2, cn + 2
    p1, p2 = (t["paying"] + 1) / n1, (c["paying"] + 1) / n2
    se = math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2)
    lo, hi = (p1 - p2) - 1.96 * se, (p1 - p2) + 1.96 * se
    return {"value": round(t["payment_rate"] - c["payment_rate"], 4), "ci": [round(lo, 4), round(hi, 4)],
            "significant": lo > 0 or hi < 0}


def _rows(db: Session, campaign_ids: list[str] | None) -> list[tuple[Decision, Outcome]]:
    q = (db.query(Decision, Outcome).join(Outcome, Outcome.decision_id == Decision.decision_id)
         .filter(Decision.group.in_(["Treatment", "Control"]), Decision.validation.is_(False)))
    if campaign_ids is not None:
        q = q.filter(Decision.campaign_id.in_(campaign_ids))
    # A treated account whose message never reached them says nothing about the treatment.
    return [(d, o) for d, o in q.all() if d.group == "Control" or o.reward is not None]


def _costs(db: Session, campaign_ids: list[str] | None) -> tuple[dict[str, float], dict[str, float]]:
    """Contact cost by decision and by treatment, for delivered contacts."""
    price = {s.code: s.cost_per_contact for s in db.query(models.Strategy)}
    q = db.query(Nudge).filter(Nudge.status.in_(["Delivered", "Opened", "Clicked"]))
    if campaign_ids is not None:
        q = q.filter(Nudge.campaign_id.in_(campaign_ids))
    by_decision: dict[str, float] = defaultdict(float)
    for n in q:
        by_decision[n.decision_id] += price.get(n.treatment_code, 0.0)
    return by_decision, price


def comparison(db: Session, campaign_ids: list[str] | None = None) -> dict:
    """Control (business as usual) against Experiment (the strategy), side by side."""
    rows = _rows(db, campaign_ids)
    cost, _ = _costs(db, campaign_ids)
    exp = [(d, o) for d, o in rows if d.group == "Treatment"]
    ctl = [(d, o) for d, o in rows if d.group == "Control"]
    e = _group(exp, sum(cost.get(d.decision_id, 0.0) for d, _ in exp))
    c = _group(ctl, None)   # business as usual costs are the bank's, not tracked here
    lift = _lift(e, c)
    return {"experiment": e, "control": c, "lift": lift,
            "incremental_recoveries": round(lift["value"] * e["accounts"], 1) if lift["value"] is not None else None,
            "difference": {k: (round(e[k] - c[k], 4) if e[k] is not None and c[k] is not None else None)
                           for k in ("payment_rate", "cure_rate", "liquidation_rate", "avg_days_to_pay")}}


def timeline(db: Session, campaign_ids: list[str] | None = None, period: str = "week") -> list[dict]:
    """Recoveries by the period the payment arrived: how many (volume) and how much (value)."""
    rows = [(d, o) for d, o in _rows(db, campaign_ids) if o.paid]
    now = datetime.now(UTC)

    def key(ts: str) -> str:
        t = datetime.fromisoformat(ts)
        return (t - timedelta(days=t.weekday())).date().isoformat() if period == "week" else t.strftime("%Y-%m")

    if period == "week":
        start = now - timedelta(weeks=6)
        keys = [((start + timedelta(weeks=i)) - timedelta(days=(start + timedelta(weeks=i)).weekday())).date().isoformat()
                for i in range(7)]
    else:
        keys = []
        y, m = now.year, now.month
        for _ in range(6):
            keys.append(f"{y:04d}-{m:02d}")
            y, m = (y, m - 1) if m > 1 else (y - 1, 12)
        keys.reverse()
    out = {k: {"period": k, "experiment_volume": 0, "experiment_value": 0.0, "control_volume": 0,
               "control_value": 0.0} for k in keys}
    for d, o in rows:
        if datetime.fromisoformat(o.observed_at) > now:
            continue   # not received yet
        k = key(o.observed_at)
        if k not in out:
            continue
        side = "experiment" if d.group == "Treatment" else "control"
        out[k][f"{side}_volume"] += 1
        out[k][f"{side}_value"] = round(out[k][f"{side}_value"] + o.amount, 2)
    return list(out.values())


def treatments(db: Session, campaign_ids: list[str] | None = None) -> list[dict]:
    """Effectiveness of each treatment: what its accounts did, what it cost, and how
    its payment rate compares with the control groups of the strategies that used it."""
    rows = _rows(db, campaign_ids)
    cost, _ = _costs(db, campaign_ids)
    names = {s.code: (s.name, s.channel) for s in db.query(models.Strategy)}
    controls: dict[str, list] = defaultdict(list)
    for d, o in rows:
        if d.group == "Control":
            controls[d.campaign_id].append((d, o))
    by_code: dict[str, list] = defaultdict(list)
    for d, o in rows:
        if d.group == "Treatment" and d.treatment_code:
            by_code[d.treatment_code].append((d, o))
    out = []
    for code, mine in sorted(by_code.items(), key=lambda kv: (len(kv[0]), kv[0])):
        g = _group(mine, sum(cost.get(d.decision_id, 0.0) for d, _ in mine))
        camps = {d.campaign_id for d, _ in mine}
        ctl = _group([x for cid in camps for x in controls.get(cid, [])], None)
        lift = _lift(g, ctl)
        out.append({"code": code, "name": names.get(code, (code, ""))[0], "channel": names.get(code, ("", ""))[1],
                    **g, "control_payment_rate": ctl["payment_rate"], "lift": lift,
                    "strategies": sorted(camps)})
    return out


def report(db: Session, campaign_id: str | None = None, period: str = "week") -> dict:
    ids = [campaign_id] if campaign_id else None
    if campaign_id is None:
        ids = [k for (k,) in db.query(Campaign.campaign_id)]
    return {"comparison": comparison(db, ids), "timeline": timeline(db, ids, period),
            "treatments": treatments(db, ids), "period": period, "formulas": FORMULAS}
