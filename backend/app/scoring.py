"""Risk model, Nudge Propensity model, and Contextual Thompson Sampling."""
from __future__ import annotations
import numpy as np

# ----------------------------------------------------------------------------
# Risk model - logistic scorecard over delinquency drivers.
# ----------------------------------------------------------------------------
RISK_WEIGHTS = {
    "utilization": 2.40,
    "missed_payments": 0.55,
    "days_past_due": 0.030,
    "hardship_flag": 1.05,
    "payment_history": -2.10,   # protective
    "tenure_years": -0.075,     # protective
}
RISK_INTERCEPT = -0.55


def risk_score(c) -> float:
    z = (
        RISK_INTERCEPT
        + RISK_WEIGHTS["utilization"] * float(c.utilization)
        + RISK_WEIGHTS["missed_payments"] * float(c.missed_payments)
        + RISK_WEIGHTS["days_past_due"] * float(c.days_past_due)
        + RISK_WEIGHTS["hardship_flag"] * (1.0 if c.hardship_flag else 0.0)
        + RISK_WEIGHTS["payment_history"] * float(c.payment_history)
        + RISK_WEIGHTS["tenure_years"] * float(c.tenure_years)
    )
    return round(float(100.0 / (1.0 + np.exp(-z))), 1)


def risk_drivers(c) -> list[dict]:
    """Per-feature contribution to the risk logit, for explainability."""
    raw = {
        "Credit utilization": RISK_WEIGHTS["utilization"] * float(c.utilization),
        "Missed payments": RISK_WEIGHTS["missed_payments"] * float(c.missed_payments),
        "Days past due": RISK_WEIGHTS["days_past_due"] * float(c.days_past_due),
        "Hardship flag": RISK_WEIGHTS["hardship_flag"] * (1.0 if c.hardship_flag else 0.0),
        "Payment history": RISK_WEIGHTS["payment_history"] * float(c.payment_history),
        "Tenure": RISK_WEIGHTS["tenure_years"] * float(c.tenure_years),
    }
    return [
        {"feature": k, "contribution": round(v, 3), "direction": "increases" if v >= 0 else "reduces"}
        for k, v in sorted(raw.items(), key=lambda kv: -abs(kv[1]))
    ]


# ----------------------------------------------------------------------------
# Nudge Propensity model - can this customer's behaviour actually be changed?
# ----------------------------------------------------------------------------
NUDGE_WEIGHTS = {
    "sms_response": 0.30,
    "app_usage": 0.20,
    "tenure": 0.20,
    "hardship": 0.15,
    "payment_history": 0.15,
}


def _nudge_features(c) -> dict:
    """Each feature normalised to 0-1 before weighting."""
    return {
        "sms_response": 1.0 if c.sms_responsive else 0.0,
        "app_usage": 1.0 if c.app_user else 0.0,
        "tenure": min(float(c.tenure_years) / 10.0, 1.0),
        # A *temporary* hardship makes someone nudgeable; severe hardship (many
        # missed payments) does not - a payment plan cannot replace lost income.
        "hardship": 1.0 if (c.hardship_flag and c.missed_payments <= 1) else 0.0,
        "payment_history": float(c.payment_history),
    }


def nudge_score(c) -> float:
    f = _nudge_features(c)
    score = sum(NUDGE_WEIGHTS[k] * f[k] for k in NUDGE_WEIGHTS) * 100.0
    # Severe distress suppresses influenceability: standard nudges do not work.
    if c.missed_payments >= 3:
        score *= 0.35
    elif c.missed_payments == 2:
        score *= 0.70
    return round(min(max(score, 0.0), 100.0), 1)


NUDGE_LABELS = {
    "sms_response": "SMS responsive",
    "app_usage": "Mobile app usage",
    "tenure": "Relationship tenure",
    "hardship": "Temporary hardship",
    "payment_history": "Payment history",
}


def nudge_explanation(c) -> dict:
    f = _nudge_features(c)
    raw = {k: NUDGE_WEIGHTS[k] * f[k] * 100.0 for k in NUDGE_WEIGHTS}
    penalty = 0.0
    subtotal = sum(raw.values())
    final = nudge_score(c)
    if final < subtotal:
        penalty = round(final - subtotal, 1)
    return {
        "score": final,
        "contributions": [
            {"factor": NUDGE_LABELS[k], "points": round(v, 1), "max_points": round(NUDGE_WEIGHTS[k] * 100, 1)}
            for k, v in sorted(raw.items(), key=lambda kv: -kv[1])
        ],
        "severity_penalty": penalty,
        "self_cure_score": self_cure_score(c),
        "segment": segment_for(c),
    }


# ----------------------------------------------------------------------------
# Self-cure model - would this customer pay WITHOUT any intervention?
# ----------------------------------------------------------------------------
# The four uplift quadrants cannot be recovered from the nudge score alone:
# "Sure Thing" and "Sleeping Dog" are both low-influenceability, and what
# separates them is baseline behaviour, not persuadability. So segmentation
# uses two axes - nudge propensity (can we change them?) and self-cure
# likelihood (will they fix it themselves?).
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
    """Uplift quadrant from (nudge propensity, self-cure likelihood)."""
    nudge = nudge_score(c)
    cure = self_cure_score(c)
    if nudge >= NUDGE_THRESHOLD:
        return "Persuadable"          # influenceable - treatment changes the outcome
    if cure >= SELF_CURE_THRESHOLD:
        return "Sure Thing"           # would pay anyway - spend nothing beyond a reminder
    if c.hardship_flag and c.missed_payments >= 2:
        return "Lost Cause"           # cannot pay - no nudge substitutes for lost income
    return "Sleeping Dog"             # disengaged - outreach risks a negative reaction


SEGMENT_ACTION = {
    "Persuadable": "Route to Contextual Thompson Sampling for treatment selection",
    "Sure Thing": "Low-cost reminder only - would likely self-cure",
    "Lost Cause": "Escalate to hardship team / special servicing",
    "Sleeping Dog": "Do not contact - outreach risks a negative reaction",
}


# ----------------------------------------------------------------------------
# Contextual Thompson Sampling over recovery journeys.
# ----------------------------------------------------------------------------
# Context multipliers nudge the Beta draw toward journeys that fit the customer
# situation - this is what makes the bandit *contextual* rather than global.
def context_multipliers(c) -> dict[str, float]:
    m = {"J1": 1.0, "J2": 1.0, "J3": 1.0, "J4": 1.0, "J5": 1.0}
    if c.sms_responsive:
        m["J1"] *= 1.20
    else:
        m["J1"] *= 0.70
        m["J4"] *= 1.15
    if c.hardship_flag and c.missed_payments <= 1:
        m["J2"] *= 1.35   # temporary hardship -> split the payment
        m["J5"] *= 1.15
    if c.missed_payments >= 3:
        m["J3"] *= 1.45   # severe hardship -> hardship plan
        m["J1"] *= 0.60
    if c.utilization > 0.85:
        m["J2"] *= 1.10
    if c.app_user:
        m["J2"] *= 1.10
        m["J5"] *= 1.05
    if c.tenure_years >= 5:
        m["J2"] *= 1.05
        m["J3"] *= 1.05
    return m


def thompson_sample(journeys, stats_by_journey, customer, rng: np.random.Generator | None = None):
    """Draw one Beta sample per arm, apply context, return the ranking."""
    rng = rng or np.random.default_rng()
    mult = context_multipliers(customer)
    ranking = []
    for j in journeys:
        st = stats_by_journey[j.journey_id]
        base = float(rng.beta(st.successes + 1, st.failures + 1))
        m = mult.get(j.journey_code, 1.0)
        ranking.append(
            {
                "journey_id": j.journey_id,
                "journey_code": j.journey_code,
                "journey_name": j.journey_name,
                "description": j.description,
                "successes": st.successes,
                "failures": st.failures,
                "posterior_mean": round(st.successes / max(st.successes + st.failures, 1), 4),
                "base_sample": round(base, 4),
                "context_multiplier": round(m, 3),
                "score": round(min(base * m, 1.0), 4),
            }
        )
    ranking.sort(key=lambda r: -r["score"])
    return ranking
