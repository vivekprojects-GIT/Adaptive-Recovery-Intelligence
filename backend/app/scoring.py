"""Intervention-side models: nudge propensity, self-cure, segmentation, strategy
eligibility and fit, and Thompson sampling with a customer-fit adjustment.

The fit adjustment is a fixed, hand-written table (fit_multiplier), not something
the learner estimates: the posterior learns how well each treatment works in a
strategy, and the table tilts each draw toward the customer's profile.

Delinquency risk is NOT modelled here. It comes from the client's existing risk
model and arrives with the cohort handoff (client_risk_band / client_risk_score).
"""
from __future__ import annotations
import numpy as np

# ----------------------------------------------------------------------------
# Nudge propensity - can this customer's behaviour be changed by an intervention?
# ----------------------------------------------------------------------------
NUDGE_WEIGHTS = {
    "sms_response": 0.30,
    "app_usage": 0.20,
    "tenure": 0.20,
    "hardship": 0.15,
    "payment_history": 0.15,
}

NUDGE_LABELS = {
    "sms_response": "Responds to SMS",
    "app_usage": "Uses the mobile app",
    "tenure": "Relationship tenure",
    "hardship": "Temporary hardship",
    "payment_history": "Payment history",
}


def _nudge_features(c) -> dict:
    """Each feature normalised to 0-1 before weighting."""
    return {
        "sms_response": 1.0 if c.sms_responsive else 0.0,
        "app_usage": 1.0 if c.app_user else 0.0,
        "tenure": min(float(c.tenure_years) / 10.0, 1.0),
        # Temporary hardship makes a customer nudgeable; severe hardship does not -
        # a payment plan cannot replace lost income.
        "hardship": 1.0 if (c.hardship_flag and c.missed_payments <= 1) else 0.0,
        "payment_history": float(c.payment_history),
    }


def nudge_score(c) -> float:
    f = _nudge_features(c)
    score = sum(NUDGE_WEIGHTS[k] * f[k] for k in NUDGE_WEIGHTS) * 100.0
    if c.missed_payments >= 3:
        score *= 0.35
    elif c.missed_payments == 2:
        score *= 0.70
    return round(min(max(score, 0.0), 100.0), 1)


# ----------------------------------------------------------------------------
# Self-cure - would this customer pay WITHOUT any intervention?
# ----------------------------------------------------------------------------
SELF_CURE_WEIGHTS = {"payment_history": 0.45, "missed": 0.25, "dpd": 0.20, "no_hardship": 0.10}


def self_cure_score(c) -> float:
    s = (
        SELF_CURE_WEIGHTS["payment_history"] * float(c.payment_history)
        + SELF_CURE_WEIGHTS["missed"] * (1.0 - min(float(c.missed_payments) / 4.0, 1.0))
        + SELF_CURE_WEIGHTS["dpd"] * (1.0 - min(float(c.days_past_due) / 90.0, 1.0))
        + SELF_CURE_WEIGHTS["no_hardship"] * (0.0 if c.hardship_flag else 1.0)
    )
    return round(s * 100.0, 1)


NUDGE_THRESHOLD = 70.0
SELF_CURE_THRESHOLD = 55.0


def segment_for(c) -> str:
    """Intervention-fit group from (nudge propensity, self-cure likelihood)."""
    if nudge_score(c) >= NUDGE_THRESHOLD:
        return "Persuadable"
    if self_cure_score(c) >= SELF_CURE_THRESHOLD:
        return "Sure Thing"
    if c.hardship_flag and c.missed_payments >= 2:
        return "Lost Cause"
    return "Sleeping Dog"


SEGMENT_ACTION = {
    "Persuadable": "Test intervention strategies - the choice of treatment changes the outcome",
    "Sure Thing": "Business-as-usual reminder only - expected to pay without help",
    "Lost Cause": "Route to the hardship team - standard nudges will not help",
    "Sleeping Dog": "Suppress contact - outreach is likely to backfire",
}


def nudge_explanation(c) -> dict:
    f = _nudge_features(c)
    raw = {k: NUDGE_WEIGHTS[k] * f[k] * 100.0 for k in NUDGE_WEIGHTS}
    subtotal = sum(raw.values())
    final = nudge_score(c)
    return {
        "score": final,
        "contributions": [
            {"factor": NUDGE_LABELS[k], "points": round(v, 1), "max_points": round(NUDGE_WEIGHTS[k] * 100, 1)}
            for k, v in sorted(raw.items(), key=lambda kv: -kv[1])
        ],
        "severity_penalty": round(final - subtotal, 1) if final < subtotal else 0.0,
        "self_cure_score": self_cure_score(c),
        "segment": segment_for(c),
    }


# ----------------------------------------------------------------------------
# Treatment eligibility (policy rules) and fit (how well it suits this customer).
#
# Both are data, not code. Each treatment in the playbook has a KIND, which
# decides how customer fit is judged, and a set of RULES, which decide who may
# receive it. The six original treatments are expressed in exactly the same
# terms, so adding a treatment in the console needs no code change. The cache
# below is refreshed from the database whenever the playbook changes.
# ----------------------------------------------------------------------------
KINDS = ["Reminder", "Digital nudge", "Arrangement", "Deferral", "Outreach", "Hardship"]

RULE_FIELDS = [
    "requires_app_user", "requires_sms_responsive", "requires_hardship_flag", "min_balance",
    "max_missed_payments", "min_tenure_years", "min_payment_history", "min_dpd", "max_dpd",
]

BUILTIN_TREATMENTS: dict[str, dict] = {
    "S1": {"kind": "Reminder", "rules": {}},
    "S2": {"kind": "Digital nudge", "rules": {"requires_app_user": True}},
    "S3": {"kind": "Arrangement", "rules": {"min_balance": 500, "max_missed_payments": 2}},
    "S4": {"kind": "Deferral", "rules": {"min_tenure_years": 2, "min_payment_history": 0.70}},
    "S5": {"kind": "Outreach", "rules": {}},
    "S6": {"kind": "Hardship", "rules": {"requires_hardship_flag": True}},
}

_TREATMENTS: dict[str, dict] = {k: dict(v) for k, v in BUILTIN_TREATMENTS.items()}


def set_treatments(treatments: dict[str, dict]) -> None:
    """Replace the playbook cache: {code: {"kind": ..., "rules": {...}, "active": bool}}."""
    global _TREATMENTS
    _TREATMENTS = {k: dict(v) for k, v in treatments.items()}


def treatment_kind(code: str) -> str | None:
    t = _TREATMENTS.get(code)
    return t["kind"] if t else None


def describe_rules(rules: dict) -> str:
    """Human-readable eligibility rule, e.g. 'Balance >= $500 and no more than 2 missed payments'."""
    parts = []
    if rules.get("requires_app_user"):
        parts.append("active mobile-app users")
    if rules.get("requires_sms_responsive"):
        parts.append("SMS responders")
    if rules.get("requires_hardship_flag"):
        parts.append("hardship flag on file")
    if rules.get("min_balance") is not None:
        parts.append(f"balance ≥ ${float(rules['min_balance']):,.0f}")
    if rules.get("max_missed_payments") is not None:
        parts.append(f"no more than {int(rules['max_missed_payments'])} missed payments in 12 months")
    if rules.get("min_tenure_years") is not None:
        parts.append(f"tenure ≥ {float(rules['min_tenure_years']):g} years")
    if rules.get("min_payment_history") is not None:
        parts.append(f"on-time history ≥ {float(rules['min_payment_history']) * 100:.0f}%")
    if rules.get("min_dpd") is not None:
        parts.append(f"≥ {int(rules['min_dpd'])} days past due")
    if rules.get("max_dpd") is not None:
        parts.append(f"≤ {int(rules['max_dpd'])} days past due")
    if not parts:
        return "All contactable customers"
    text = " and ".join(parts)
    return text[0].upper() + text[1:]


def eligibility(code: str, c) -> tuple[bool, str]:
    """Business-policy eligibility. Returns (eligible, reason)."""
    t = _TREATMENTS.get(code)
    if not t:
        return False, "Unknown treatment"
    if t.get("active") is False:
        return False, "Treatment retired from the playbook"
    return check_rules(t.get("rules") or {}, c)


def check_rules(r: dict, c) -> tuple[bool, str]:
    """Apply one rule set to one customer. Used for saved treatments and for
    previewing a rule set's reach before it is saved."""
    if r.get("requires_app_user") and not c.app_user:
        return False, "Not an app user"
    if r.get("requires_sms_responsive") and not c.sms_responsive:
        return False, "Does not respond to SMS"
    if r.get("requires_hardship_flag") and not c.hardship_flag:
        return False, "No hardship flag"
    if r.get("min_balance") is not None and c.balance < float(r["min_balance"]):
        return False, f"Balance under ${float(r['min_balance']):,.0f}"
    if r.get("max_missed_payments") is not None and c.missed_payments > int(r["max_missed_payments"]):
        return False, f"More than {int(r['max_missed_payments'])} missed payments in 12 months"
    if r.get("min_tenure_years") is not None and c.tenure_years < float(r["min_tenure_years"]):
        return False, f"Tenure under {float(r['min_tenure_years']):g} years"
    if r.get("min_payment_history") is not None and c.payment_history < float(r["min_payment_history"]):
        return False, f"On-time history under {float(r['min_payment_history']) * 100:.0f}%"
    if r.get("min_dpd") is not None and c.days_past_due < int(r["min_dpd"]):
        return False, f"Under {int(r['min_dpd'])} days past due"
    if r.get("max_dpd") is not None and c.days_past_due > int(r["max_dpd"]):
        return False, f"Over {int(r['max_dpd'])} days past due"
    return True, describe_rules(r)


def fit_multiplier(code: str, c) -> float:
    """How strongly this customer's profile favours a treatment (1.0 = neutral).
    Judged by the treatment's kind, so a new SMS reminder is read like the old one."""
    kind = treatment_kind(code)
    temp_hardship = c.hardship_flag and c.missed_payments <= 1
    severe = c.missed_payments >= 3
    m = 1.0
    if kind == "Reminder":
        m *= 1.20 if c.sms_responsive else 0.70
        if severe:
            m *= 0.60
    elif kind == "Digital nudge":
        m *= 1.25 if c.app_user else 0.50
    elif kind == "Arrangement":
        if temp_hardship:
            m *= 1.35
        if c.utilization > 0.85:
            m *= 1.10
        if c.app_user:
            m *= 1.10
        if c.tenure_years >= 5:
            m *= 1.05
    elif kind == "Deferral":
        if temp_hardship:
            m *= 1.15
        if c.app_user:
            m *= 1.05
    elif kind == "Outreach":
        if not c.sms_responsive:
            m *= 1.15
    elif kind == "Hardship":
        if severe:
            m *= 1.45
        if c.tenure_years >= 5:
            m *= 1.05
    # Square-root damping: fit tilts the decision, but evidence from outcomes
    # still has to do most of the work - otherwise the learner never explores.
    return round(m ** 0.5, 3)


def fit_reasons(code: str, c) -> list[str]:
    kind = treatment_kind(code)
    temp_hardship = c.hardship_flag and c.missed_payments <= 1
    r: list[str] = []
    if kind == "Reminder":
        r.append("Responds to SMS" if c.sms_responsive else "Rarely responds to SMS")
        if c.missed_payments >= 3:
            r.append("Severe arrears - a reminder will not fix it")
    elif kind == "Digital nudge":
        r.append("Active app user" if c.app_user else "No app usage")
    elif kind == "Arrangement":
        if temp_hardship:
            r.append("Temporary hardship - spreading the arrears helps")
        if c.utilization > 0.85:
            r.append("Card nearly maxed out")
        if c.app_user:
            r.append("Can accept the plan in-app")
    elif kind == "Deferral":
        if temp_hardship:
            r.append("Short-term cash-flow gap")
    elif kind == "Outreach":
        if not c.sms_responsive:
            r.append("Does not engage with digital channels")
    elif kind == "Hardship":
        if c.missed_payments >= 3:
            r.append("Severe, ongoing hardship")
    return r


# ----------------------------------------------------------------------------
# Thompson sampling with a customer-fit adjustment.
# ----------------------------------------------------------------------------
def thompson_rank(arms: list[dict], customer, rng: np.random.Generator) -> list[dict]:
    """arms: [{code, name, a, b}]. One Beta draw per arm, tilted by customer fit."""
    ranking = []
    for arm in arms:
        base = float(rng.beta(arm["a"], arm["b"]))
        m = fit_multiplier(arm["code"], customer)
        ranking.append({
            "code": arm["code"],
            "name": arm["name"],
            "belief": round(arm["a"] / (arm["a"] + arm["b"]), 4),
            "base_sample": round(base, 4),
            "fit": m,
            "score": round(min(base * m, 1.0), 4),
        })
    ranking.sort(key=lambda r: -r["score"])
    return ranking
