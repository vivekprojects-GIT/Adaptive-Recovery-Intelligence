"""Outcome simulator for test environments: how customers respond.

The hidden "true" payment rates below stand in for real customers. The
decision engine never reads them when deciding - it only learns from the
paid / not-paid outcomes they produce, exactly as it would from real ones.
Agent (Nova) decisions are never simulated: their outcomes are reported.
"""
from __future__ import annotations

from types import SimpleNamespace

from .scoring import fit_multiplier, treatment_kind

BASE_PAY = {"Persuadable": 0.22, "Sure Thing": 0.62, "Lost Cause": 0.06, "Sleeping Dog": 0.30}
# Effects are deliberately modest - field studies of collections treatments
# report single-digit to low-teens point lifts. Keyed by treatment KIND, so a
# treatment added in the console has a true effect too.
LIFT = {
    "Persuadable": {"Reminder": 0.05, "Digital nudge": 0.06, "Arrangement": 0.15, "Deferral": 0.09,
                    "Outreach": 0.04, "Hardship": 0.06},
    "Sure Thing": {"Reminder": 0.02, "Digital nudge": 0.03, "Arrangement": 0.01, "Deferral": 0.01,
                   "Outreach": 0.01, "Hardship": 0.00},
    "Lost Cause": {"Reminder": 0.00, "Digital nudge": 0.00, "Arrangement": 0.02, "Deferral": 0.03,
                   "Outreach": 0.01, "Hardship": 0.12},
    "Sleeping Dog": {"Reminder": -0.04, "Digital nudge": -0.02, "Arrangement": 0.00, "Deferral": 0.01,
                     "Outreach": -0.08, "Hardship": 0.00},
}


def _variant(code: str) -> float:
    """A treatment added later is not identical to the original of its kind:
    a small, fixed, code-specific difference in true effect (+/- 2 points)."""
    if code in ("S1", "S2", "S3", "S4", "S5", "S6"):
        return 0.0
    h = sum(ord(ch) * (i + 1) for i, ch in enumerate(code))
    return ((h % 41) - 20) / 1000.0


def true_pay_probability(c, code: str | None) -> float:
    p = BASE_PAY[c.segment]
    if code:
        kind = treatment_kind(code)
        if kind:
            fit = fit_multiplier(code, c)
            p += (LIFT[c.segment][kind] + _variant(code)) * (1.0 + 0.30 * (fit - 1.0))
    return min(max(p, 0.01), 0.95)


def snapshot(c) -> SimpleNamespace:
    """The customer fields a decision reads, as a plain record."""
    keys = ("customer_id", "name", "segment", "balance", "utilization", "tenure_years", "sms_responsive",
            "app_user", "hardship_flag", "missed_payments", "payment_history", "days_past_due",
            "nudge_score", "cohort_id")
    return SimpleNamespace(**{k: getattr(c, k) for k in keys})
