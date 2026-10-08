"""Scorecards: is each part of ARI doing its job?

  strategy  what the strategy caused, against its own control group: incremental
            recoveries and dollars, what each one cost, and where learning stands
  router    whether the Propensity Router's groups behave as it claims: treatment
            helps Likely responsive customers, and makes no difference to the
            customers it keeps off strategies (checked with its validation share)
  engine    offline evaluation: how often Thompson sampling picked the treatment the
            reference response model expects to pay best
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from types import SimpleNamespace

from sqlalchemy.orm import Session

from .. import models
from ..simulation import true_pay_probability
from . import analytics, engine, router
from .models import Campaign, Decision, Outcome, Routing

MIN_N = 20   # fewer results than this in either arm and a group is not judged


def _rate(paid: int, n: int) -> float | None:
    return round(paid / n, 4) if n else None


def _difference(tp: int, tn: int, cp: int, cn: int) -> dict:
    """Treated minus untreated payment rate, with an Agresti-Caffo 95% range."""
    if not tn or not cn:
        return {"value": None, "ci": None, "significant": False}
    n1, n2 = tn + 2, cn + 2
    p1, p2 = (tp + 1) / n1, (cp + 1) / n2
    se = math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2)
    lo, hi = (p1 - p2) - 1.96 * se, (p1 - p2) + 1.96 * se
    return {"value": round(tp / tn - cp / cn, 4), "ci": [round(lo, 4), round(hi, 4)], "significant": lo > 0 or hi < 0}


# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------
def strategy(db: Session, camp: Campaign) -> dict:
    s = analytics.campaign_stats(db, camp)
    rows = [(d, o) for d, o in analytics._rows(db, [camp.campaign_id]) if not d.validation and o is not None]
    treated = [o for d, o in rows if d.group == "Treatment" and o.reward is not None]
    control = [o for d, o in rows if d.group == "Control"]
    per_t = sum(o.amount for o in treated if o.paid) / len(treated) if treated else None
    per_c = sum(o.amount for o in control if o.paid) / len(control) if control else None
    up, ci = s["uplift"], s["uplift_ci"]
    inc = round(up * s["treated"], 1) if up is not None else None
    inc_range = [round(ci[0] * s["treated"], 1), round(ci[1] * s["treated"], 1)] if ci else None
    dollars = round((per_t - per_c) * s["treated"], 2) if per_t is not None and per_c is not None else None
    # 95% range for the dollars: difference of mean recovered per customer, scaled to the treated group.
    dollars_range = None
    if len(treated) > 1 and len(control) > 1:
        xt = [o.amount if o.paid else 0.0 for o in treated]
        xc = [o.amount if o.paid else 0.0 for o in control]
        var = lambda xs, m: sum((x - m) ** 2 for x in xs) / (len(xs) - 1)  # noqa: E731
        se = math.sqrt(var(xt, per_t) / len(xt) + var(xc, per_c) / len(xc))
        dollars_range = [round((per_t - per_c - 1.96 * se) * s["treated"], 2),
                         round((per_t - per_c + 1.96 * se) * s["treated"], 2)]
    cost = s["contact_cost"]
    standing = engine.current_standing(db, camp)
    names = {t.code: t.name for t in db.query(models.Strategy)}
    return {
        "treated": s["treated"], "control": s["control"],
        "recovery_rate": s["recovery_rate"], "control_rate": s["control_rate"],
        "uplift": up, "uplift_ci": ci, "significant": s["significant"], "mde": s["mde"],
        "incremental_recoveries": inc, "incremental_range": inc_range,
        "recovered_per_treated": round(per_t, 2) if per_t is not None else None,
        "recovered_per_control": round(per_c, 2) if per_c is not None else None,
        "incremental_dollars": dollars, "incremental_dollars_range": dollars_range,
        "dollars_proven": bool(dollars_range and dollars_range[0] > 0), "contact_cost": cost,
        "cost_per_incremental_recovery": round(cost / inc, 2) if inc and inc > 0 else None,
        "return_on_contact": round(dollars / cost, 2) if dollars is not None and cost else None,
        "treatments": sorted(({"code": k, "name": names.get(k, k), **v} for k, v in standing.items()),
                             key=lambda x: -x["p_best"]),
        "validation_decisions": sum(1 for d, _ in analytics._rows(db, [camp.campaign_id]) if d.validation),
    }


# ---------------------------------------------------------------------------
# Propensity Router
# ---------------------------------------------------------------------------
EXPECTED = {
    "Persuadable": "Treatment raises their payment rate",
    "Sure Thing": "They pay without help, so treatment adds nothing",
    "Lost Cause": "They cannot pay, so treatment adds nothing",
    "Sleeping Dog": "Contact makes things worse",
}


def _verdict(group: str, diff: dict, tn: int, cn: int) -> tuple[str, str]:
    """(state, plain-words verdict) for one group against what the router claims."""
    if group == "Sleeping Dog":
        return "Not measured", "Never contacted, by design, so the claim cannot be tested on live customers."
    if tn < MIN_N or cn < MIN_N:
        return "Too few results", f"Needs at least {MIN_N} treated and {MIN_N} untreated outcomes ({tn} and {cn} so far)."
    lo, hi = diff["ci"]
    if group == "Persuadable":
        if lo > 0:
            return "Confirmed", f"Treatment adds {diff['value'] * 100:+.1f} pp, and the 95% range is above zero."
        if hi < 0:
            return "Contradicted", "Treated customers pay less than untreated ones: the group is not responsive."
        return "Not proven yet", f"{diff['value'] * 100:+.1f} pp so far; the 95% range still includes zero."
    if lo > 0:
        return "Contradicted", (f"Treatment adds {diff['value'] * 100:+.1f} pp for a group the router keeps off "
                                f"strategies: it may be leaving recoveries on the table.")
    return "Consistent", (f"Treatment makes no measurable difference ({diff['value'] * 100:+.1f} pp, range "
                          f"{lo * 100:+.0f} to {hi * 100:+.0f} pp), as the router assumes.")


def _band(x: float, edges: list[float], labels: list[str]) -> str:
    for e, label in zip(edges, labels):
        if x < e:
            return label
    return labels[-1]


def router_scorecard(db: Session) -> dict:
    customers = db.query(models.Customer).all()
    routes: dict[str, dict] = defaultdict(lambda: defaultdict(int))
    for c in customers:
        if c.route:
            routes[c.segment]["validation" if c.route_validation else c.route] += 1

    decided = (db.query(Decision, Outcome).join(Outcome, Outcome.decision_id == Decision.decision_id)
               .filter(Decision.group.in_(["Treatment", "Control"])).all())
    routed_away = db.query(Routing).filter(Routing.route != "strategy", Routing.paid.isnot(None)).all()
    # One record per outcome: (fit group, treated?, paid, self-cure score, nudge score, reported by Nova?)
    outcomes = []
    for d, o in decided:
        if d.group == "Treatment" and o.reward is None:
            continue   # never reached the customer: says nothing either way
        snap = json.loads(d.snapshot or "{}")
        outcomes.append((snap.get("segment"), d.group == "Treatment", bool(o.paid), snap.get("self_cure_score"),
                         snap.get("nudge_score"), d.origin == "mcp"))
    for r in routed_away:
        outcomes.append((r.fit_group, False, bool(r.paid), r.self_cure_score, r.nudge_score, r.origin == "mcp"))

    groups = []
    for g in ("Persuadable", "Sure Thing", "Lost Cause", "Sleeping Dog"):
        mine = [x for x in outcomes if x[0] == g]
        t = [x for x in mine if x[1]]
        u = [x for x in mine if not x[1]]
        tp, cp = sum(x[2] for x in t), sum(x[2] for x in u)
        diff = _difference(tp, len(t), cp, len(u))
        state, verdict = _verdict(g, diff, len(t), len(u))
        groups.append({
            "fit_group": g, "label": router.GROUP_LABEL[g], "route": router.ROUTES[g],
            "route_label": router.ROUTE_LABEL[router.ROUTES[g]], "expected": EXPECTED[g],
            "customers": sum(routes[g].values()), "routed": dict(routes[g]),
            "treated": {"n": len(t), "paid": tp, "rate": _rate(tp, len(t))},
            "untreated": {"n": len(u), "paid": cp, "rate": _rate(cp, len(u))},
            "difference": diff, "state": state, "verdict": verdict,
            "treated_from": "strategies" if g == "Persuadable" else ("validation share" if g in router.VALIDATED else None),
            "untreated_from": "strategy control groups" if g == "Persuadable" else router.ROUTE_LABEL[router.ROUTES[g]].lower(),
        })

    # Calibration: untreated payment rate should rise with the self-cure score.
    sc_edges, sc_labels = [40, 55, 70], ["Under 40", "40-55", "55-70", "70 and over"]
    cal = {lab: [0, 0] for lab in sc_labels}
    for _g, treated, paid, sc, _ns, _ in outcomes:
        if not treated and sc is not None:
            b = cal[_band(sc, sc_edges, sc_labels)]
            b[0] += paid
            b[1] += 1
    self_cure = [{"band": lab, "n": n, "paid": p, "rate": _rate(p, n)} for lab, (p, n) in cal.items()]
    reported = sum(1 for x in outcomes if x[5])
    return {
        "policy": router.POLICY, "validation_share": router.validation_share(db),
        "customers": len(customers), "groups": groups,
        "calibration": {"self_cure": self_cure},
        "outcomes": {"total": len(outcomes), "reported_by_nova": reported},
    }


# ---------------------------------------------------------------------------
# Engine (test environment only)
# ---------------------------------------------------------------------------
def engine_scorecard(db: Session) -> dict:
    """Offline evaluation of Thompson sampling: how often it picked the treatment
    the reference response model (simulation.py) expects to pay best for the
    customer in front of it, and what the misses cost. Decisions requested by
    Nova are left out: the model does not describe Nova's customers."""
    camps = {c.campaign_id: c for c in db.query(Campaign).filter(Campaign.status.in_(["Live", "Paused"]))}
    rows = (db.query(Decision).filter(Decision.group == "Treatment", Decision.origin != "mcp",
                                      Decision.validation.is_(False), Decision.campaign_id.in_(list(camps)))
            .order_by(Decision.wave).all())
    per: dict[str, list] = defaultdict(list)
    for d in rows:
        ranking = json.loads(d.ranking or "[]")
        if len(ranking) < 2 or not d.treatment_code:
            continue   # one allowed treatment: nothing to choose
        c = SimpleNamespace(**json.loads(d.snapshot or "{}"))
        truth = {r["code"]: true_pay_probability(c, r["code"]) for r in ranking}
        best = max(truth.values())
        per[d.campaign_id].append((d.wave, truth.get(d.treatment_code, 0) >= best - 1e-9,
                                   best - truth.get(d.treatment_code, 0)))

    def summary(xs: list) -> dict:
        if not xs:
            return {"decisions": 0, "picked_best": None, "regret": None}
        return {"decisions": len(xs), "picked_best": round(sum(x[1] for x in xs) / len(xs), 4),
                "regret": round(sum(x[2] for x in xs) / len(xs), 4)}

    strategies = []
    for cid, xs in sorted(per.items()):
        waves = sorted({w for w, *_ in xs})
        early = [x for x in xs if x[0] in waves[:2]]
        recent = [x for x in xs if x[0] in waves[-2:]] if len(waves) > 2 else []
        strategies.append({"campaign_id": cid, "name": camps[cid].name, **summary(xs),
                           "early": summary(early), "recent": summary(recent), "waves": len(waves)})
    everything = [x for xs in per.values() for x in xs]
    return {"available": bool(everything), "overall": summary(everything), "strategies": strategies,
            "note": "Offline evaluation: each choice is compared with the treatment the reference response "
                    "model expects to pay best for that customer. Outcomes alone never show which treatment "
                    "would have been best, so this check runs offline and leaves out Nova's decisions."}
