"""Intervention experiments: eligible population -> control / treatment groups ->
strategy assignment in waves -> outcome tracking and learning.

Experiments are held in memory. That is deliberate for the prototype: they are
cheap to recreate, and the free hosting tier wipes local state on restart anyway.

OPEN ITEM - delayed outcomes. In practice a payment can land days after the
intervention (the handoff cohort expects 7-10 days). How to credit those late
outcomes - attribution window, pending state, partial feedback to the learner -
is still to be agreed. This prototype records each wave's outcome
as soon as the wave runs. Do not treat that as the intended design.
"""
from __future__ import annotations

import math
import uuid
from collections import OrderedDict
from datetime import datetime
from types import SimpleNamespace

import numpy as np

from .scoring import eligibility, fit_multiplier, thompson_rank, treatment_kind

PRIOR_STRENGTH = 10  # pseudo-observations borrowed from historical success rates
MAX_EXPERIMENTS = 60

SEGMENT_EXCLUSION = {
    "Sure Thing": "Expected to pay without help - business-as-usual reminder",
    "Lost Cause": "Cannot pay - routed to the hardship team",
    "Sleeping Dog": "Contact likely to backfire - suppressed",
}

# ---------------------------------------------------------------------------
# Outcome simulator. The hidden "true" response rates - the experiment never
# sees these directly, it only sees the paid / not-paid outcomes they produce.
# ---------------------------------------------------------------------------
BASE_PAY = {"Persuadable": 0.22, "Sure Thing": 0.62, "Lost Cause": 0.06, "Sleeping Dog": 0.30}
# Effects are deliberately modest - field studies of collections treatments
# report single-digit to low-teens point lifts. An earlier version used up to
# +34 points for split plans, which made the demo's winner an artifact of the
# simulator rather than something an experiment would find.
# Keyed by treatment KIND, so a treatment added in the console has a true
# effect too. The engine never reads this table; it only produces outcomes.
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
    keys = ("customer_id", "name", "segment", "balance", "utilization", "tenure_years", "sms_responsive",
            "app_user", "hardship_flag", "missed_payments", "payment_history", "days_past_due",
            "nudge_score", "cohort_id")
    return SimpleNamespace(**{k: getattr(c, k) for k in keys})


class Experiment:
    def __init__(self, cohort, customers, strategies, control_pct, mode, include_segments,
                 wave_size, seed=None):
        self.id = uuid.uuid4().hex[:8]
        self.created_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        self.cohort = {k: getattr(cohort, k) for k in (
            "cohort_id", "name", "dpd_bucket", "client_risk_band", "expected_payment")}
        self.strategies = {s.code: s for s in strategies}
        self.codes = [s.code for s in strategies]
        self.control_pct = control_pct
        self.mode = mode
        self.include_segments = include_segments
        self.wave_size = wave_size
        self.rng = np.random.default_rng(seed)

        # ---- Step 1: eligible population ------------------------------------
        self.population_total = len(customers)
        exclusions: dict[str, int] = OrderedDict()
        self.status: dict[int, dict] = {}
        eligible = []
        for c in customers:
            s = snapshot(c)
            if s.segment not in include_segments:
                reason = SEGMENT_EXCLUSION.get(s.segment, "Not in test population")
                exclusions[reason] = exclusions.get(reason, 0) + 1
                self.status[s.customer_id] = {"state": "excluded", "reason": reason}
                continue
            arms = [code for code in self.codes if eligibility(code, s)[0]]
            if not arms:
                reason = "No selected strategy applies"
                exclusions[reason] = exclusions.get(reason, 0) + 1
                self.status[s.customer_id] = {"state": "excluded", "reason": reason}
                continue
            s.eligible_arms = arms
            eligible.append(s)
        self.exclusions = [{"reason": r, "count": n} for r, n in exclusions.items()]
        self.segment_counts = {}
        for c in customers:
            self.segment_counts[c.segment] = self.segment_counts.get(c.segment, 0) + 1

        # ---- Step 2: random split into control and treatment -----------------
        order = self.rng.permutation(len(eligible))
        shuffled = [eligible[i] for i in order]
        n_control = int(round(control_pct * len(shuffled)))
        self.control = shuffled[:n_control]
        self.treatment = shuffled[n_control:]
        for s in self.control:
            self.status[s.customer_id] = {"state": "control", "reason": "Held out - receives no new intervention"}
        for s in self.treatment:
            self.status[s.customer_id] = {"state": "queued", "reason": "In treatment group, awaiting assignment"}
        self.total_waves = max(1, math.ceil(len(self.treatment) / wave_size)) if self.treatment else 0
        self.t_cursor = 0
        self.c_cursor = 0

        # ---- Arms: beliefs start from the client's historical record ---------
        self.arms = OrderedDict()
        for code in self.codes:
            st = self.strategies[code]
            n = st.hist_successes + st.hist_failures
            mean = st.hist_successes / n if n else 0.5
            a0, b0 = (1 + PRIOR_STRENGTH * mean, 1 + PRIOR_STRENGTH * (1 - mean)) if n else (1.0, 1.0)
            self.arms[code] = {
                "code": code, "name": st.name, "cost": st.cost_per_contact,
                "prior_a": a0, "prior_b": b0, "a": a0, "b": b0,
                "assigned": 0, "paid": 0,
                "eligible": sum(1 for s in eligible if code in s.eligible_arms),
            }
        self.control_stats = {"assigned": 0, "paid": 0}
        self.waves: list[dict] = []
        self.assignments: list[dict] = []

    # ---- Step 3 + 4: assign a wave, observe outcomes, learn -------------------
    def run_wave(self) -> dict | None:
        if self.t_cursor >= len(self.treatment):
            return None
        wave_no = len(self.waves) + 1
        batch = self.treatment[self.t_cursor:self.t_cursor + self.wave_size]
        self.t_cursor += len(batch)
        remaining_waves = self.total_waves - wave_no + 1
        c_take = math.ceil((len(self.control) - self.c_cursor) / max(remaining_waves, 1))
        c_batch = self.control[self.c_cursor:self.c_cursor + c_take]
        self.c_cursor += len(c_batch)

        allocation = {code: 0 for code in self.codes}
        paid_t = 0
        # Every customer in a wave is assigned from the same beliefs; the wave's
        # results are applied together once the wave is complete.
        pending: list[tuple[str, bool]] = []
        for s in batch:
            if self.mode == "adaptive":
                arms = [{"code": c, "name": self.arms[c]["name"], "a": self.arms[c]["a"],
                         "b": self.arms[c]["b"]} for c in s.eligible_arms]
                ranking = thompson_rank(arms, s, self.rng)
                chosen, score = ranking[0]["code"], ranking[0]["score"]
                why = f"Highest sampled score ({score:.2f}) of {len(ranking)} eligible"
            else:
                least = min(self.arms[c]["assigned"] for c in s.eligible_arms)
                tied = [c for c in s.eligible_arms if self.arms[c]["assigned"] == least]
                chosen = tied[int(self.rng.integers(len(tied)))]
                score = None
                why = "Equal split across eligible strategies"
            paid = bool(self.rng.random() < true_pay_probability(s, chosen))
            arm = self.arms[chosen]
            arm["assigned"] += 1
            if paid:
                arm["paid"] += 1
                paid_t += 1
            pending.append((chosen, paid))
            allocation[chosen] += 1
            self.status[s.customer_id] = {"state": "treated", "strategy": chosen,
                                          "strategy_name": arm["name"], "wave": wave_no,
                                          "outcome": "Paid" if paid else "Not paid"}
            self.assignments.append({
                "wave": wave_no, "customer_id": s.customer_id, "name": s.name, "segment": s.segment,
                "group": "Treatment", "strategy": chosen, "strategy_name": arm["name"],
                "score": score, "why": why, "outcome": "Paid" if paid else "Not paid",
            })

        # Learning update. Fixed mode still records results; it just doesn't use them.
        for code, paid in pending:
            self.arms[code]["a"] += 1 if paid else 0
            self.arms[code]["b"] += 0 if paid else 1

        paid_c = 0
        for s in c_batch:
            paid = bool(self.rng.random() < true_pay_probability(s, None))
            paid_c += paid
            self.control_stats["assigned"] += 1
            self.control_stats["paid"] += paid
            self.status[s.customer_id] = {"state": "control", "wave": wave_no,
                                          "reason": "Held out - receives no new intervention",
                                          "outcome": "Paid" if paid else "Not paid"}
            self.assignments.append({
                "wave": wave_no, "customer_id": s.customer_id, "name": s.name, "segment": s.segment,
                "group": "Control", "strategy": None, "strategy_name": "No new intervention",
                "score": None, "why": "Random holdout", "outcome": "Paid" if paid else "Not paid",
            })

        wave = {
            "wave": wave_no, "treatment_n": len(batch), "control_n": len(c_batch),
            "allocation": allocation, "treatment_paid": paid_t, "control_paid": paid_c,
            "treatment_rate": round(paid_t / max(len(batch), 1), 4),
            "control_rate": round(paid_c / max(len(c_batch), 1), 4) if c_batch else None,
            "cum_treatment_rate": round(
                sum(a["paid"] for a in self.arms.values()) / max(sum(a["assigned"] for a in self.arms.values()), 1), 4),
            "cum_control_rate": round(self.control_stats["paid"] / self.control_stats["assigned"], 4)
            if self.control_stats["assigned"] else None,
            "beliefs": {c: round(a["a"] / (a["a"] + a["b"]), 4) for c, a in self.arms.items()},
        }
        self.waves.append(wave)
        return wave

    # ---- Views ---------------------------------------------------------------
    def summary(self) -> dict:
        ctrl_rate = (self.control_stats["paid"] / self.control_stats["assigned"]
                     if self.control_stats["assigned"] else None)
        arms = []
        for a in self.arms.values():
            rate = a["paid"] / a["assigned"] if a["assigned"] else None
            n = a["a"] + a["b"]
            mean = a["a"] / n
            sd = math.sqrt(mean * (1 - mean) / (n + 1))
            arms.append({
                "code": a["code"], "name": a["name"], "cost": a["cost"], "eligible": a["eligible"],
                "assigned": a["assigned"], "paid": a["paid"],
                "pay_rate": round(rate, 4) if rate is not None else None,
                "uplift_vs_control": round(rate - ctrl_rate, 4) if rate is not None and ctrl_rate is not None else None,
                "cost_per_payment": round(a["cost"] * a["assigned"] / a["paid"], 2) if a["paid"] else None,
                "prior_mean": round(a["prior_a"] / (a["prior_a"] + a["prior_b"]), 4),
                "belief": round(mean, 4),
                "belief_low": round(max(mean - 1.96 * sd, 0), 4),
                "belief_high": round(min(mean + 1.96 * sd, 1), 4),
                "share": round(a["assigned"] / max(sum(x["assigned"] for x in self.arms.values()), 1), 4),
            })
        treated = sum(a["assigned"] for a in self.arms.values())
        treated_paid = sum(a["paid"] for a in self.arms.values())
        t_rate = treated_paid / treated if treated else None
        return {
            "id": self.id, "created_at": self.created_at, "cohort": self.cohort,
            "strategies": [{"code": c, "name": self.strategies[c].name} for c in self.codes],
            "settings": {"control_pct": self.control_pct, "mode": self.mode,
                         "include_segments": self.include_segments, "wave_size": self.wave_size},
            "population": {
                "total": self.population_total, "segments": self.segment_counts,
                "exclusions": self.exclusions,
                "eligible": len(self.control) + len(self.treatment),
                "control": len(self.control), "treatment": len(self.treatment),
            },
            "progress": {"waves_run": len(self.waves), "total_waves": self.total_waves,
                         "treated": treated, "control_observed": self.control_stats["assigned"],
                         "done": self.t_cursor >= len(self.treatment)},
            "results": {
                "treatment_rate": round(t_rate, 4) if t_rate is not None else None,
                "control_rate": round(ctrl_rate, 4) if ctrl_rate is not None else None,
                "uplift": round(t_rate - ctrl_rate, 4) if t_rate is not None and ctrl_rate is not None else None,
                "treated_paid": treated_paid, "control_paid": self.control_stats["paid"],
            },
            "arms": arms,
            "waves": self.waves,
            # Newest wave first; within a wave, treated customers before the control holdout.
            "recent_assignments": sorted(self.assignments, key=lambda a: (-a["wave"], a["group"] == "Control"))[:40],
        }


_EXPERIMENTS: "OrderedDict[str, Experiment]" = OrderedDict()


def store(exp: Experiment) -> Experiment:
    _EXPERIMENTS[exp.id] = exp
    while len(_EXPERIMENTS) > MAX_EXPERIMENTS:
        _EXPERIMENTS.popitem(last=False)
    return exp


def get(exp_id: str) -> Experiment | None:
    return _EXPERIMENTS.get(exp_id)
