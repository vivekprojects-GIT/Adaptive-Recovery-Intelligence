"""Suggested strategies: ARI proposes complete strategies from the decision log.

Two kinds, both built from what has actually happened:

  new       an audience no live strategy covers - accounts that can be helped
            but are not being decided by anyone - with the treatments the
            evidence favours for customers like them.
  revision  a live strategy that is behind target, not beating its control
            group, or escalating past the ceiling - as its next version, with
            the treatment mix the evidence favours. It goes through the normal
            versioning: the running version keeps going until the new one is
            approved and launched.

Every number shown is read from the data and comes with its sample size. The
evidence for a treatment is, in order of preference: outcomes for the same
cohort and intervention-fit group; outcomes for the same fit group in any
cohort; the playbook's historical rate. Raw payment rates include customers
who would have paid anyway, so they rank treatments; they are not a forecast.

A suggestion is only ever a starting point. Choosing one creates a Draft (or
a draft version), which needs approval by someone other than its author like
any other strategy. Deterministic: the same data gives the same suggestions.
"""
from __future__ import annotations

import json
from collections import defaultdict

from sqlalchemy.orm import Session

from .. import models
from ..scoring import eligibility, treatment_kind
from . import analytics, engine
from .models import Campaign, Decision, Outcome
from .platform import cfg, cfg_float
from .playbook import active_codes, human_review_codes

# Fit groups a strategy may target, and why the others are left out.
TREATABLE = ("Persuadable", "Lost Cause")
FIT_LABEL = {"Persuadable": "likely to respond", "Lost Cause": "needs support", "Sure Thing": "likely to self-cure",
             "Sleeping Dog": "do not contact"}
MIN_ACCOUNTS = 20       # an audience smaller than this is not worth a strategy
MIN_REACH = 0.2         # a treatment must be open to at least this share of the audience
MAX_ARMS = 3
MIN_TREATED = 30        # a live strategy needs this many results before it is judged


def _pct(x: float | None) -> str:
    return "n/a" if x is None else f"{x:.0%}"


class Evidence:
    """Treated and control outcomes, grouped by cohort and fit group."""

    def __init__(self, db: Session):
        self.arm: dict[tuple, list[int]] = defaultdict(lambda: [0, 0])      # (cohort, segment, code) -> [paid, n]
        self.arm_seg: dict[tuple, list[int]] = defaultdict(lambda: [0, 0])  # (segment, code)
        self.ctrl: dict[tuple, list[int]] = defaultdict(lambda: [0, 0])     # (cohort, segment)
        rows = (db.query(Decision.group, Decision.treatment_code, Decision.snapshot, Outcome.paid, Outcome.learned)
                .join(Outcome, Outcome.decision_id == Decision.decision_id).all())
        for group, code, snap, paid, learned in rows:
            s = json.loads(snap or "{}")
            co, seg = s.get("cohort_id"), s.get("segment")
            if group == "Treatment" and learned and code:
                for key, table in (((co, seg, code), self.arm), ((seg, code), self.arm_seg)):
                    table[key][0] += int(bool(paid))
                    table[key][1] += 1
            elif group == "Control":
                self.ctrl[(co, seg)][0] += int(bool(paid))
                self.ctrl[(co, seg)][1] += 1
        self.k = float(cfg(db, "prior_strength"))
        self.hist = {s.code: s for s in db.query(models.Strategy)}

    def for_arm(self, code: str, cohorts: list[str], segments: list[str]) -> dict:
        """Best available evidence for one treatment and audience, with a
        Beta posterior mean that blends it with the playbook history."""
        paid = n = 0
        for co in cohorts:
            for seg in segments:
                p, m = self.arm[(co, seg, code)]
                paid, n = paid + p, n + m
        source = "this audience"
        if n < 10:
            paid = sum(self.arm_seg[(seg, code)][0] for seg in segments)
            n = sum(self.arm_seg[(seg, code)][1] for seg in segments)
            source = "this fit group, other cohorts" if n else "playbook history only"
        st = self.hist.get(code)
        hn = (st.hist_successes + st.hist_failures) if st else 0
        prior = st.hist_successes / hn if hn else 0.5
        a = 1 + (self.k * prior if hn else 0) + paid
        b = 1 + (self.k * (1 - prior) if hn else 0) + (n - paid)
        return {"paid": paid, "n": n, "rate": paid / n if n else None, "source": source,
                "playbook_rate": prior if hn else None, "score": a / (a + b)}

    def control(self, cohorts: list[str], segments: list[str]) -> tuple[int, int]:
        paid = n = 0
        for co in cohorts:
            for seg in segments:
                p, m = self.ctrl[(co, seg)]
                paid, n = paid + p, n + m
        return paid, n


def _treatments(db: Session, ev: Evidence, customers: list, cohorts: list[str], segments: list[str]) -> list[dict]:
    """The best-evidenced active treatments open to enough of the audience.

    Policy before optimisation: an audience that includes customers who need
    support always keeps a hardship treatment, whatever the payment rates say.
    Its reach is judged on those customers alone."""
    meta = {m.code: m for m in db.query(models.Strategy)}
    review = human_review_codes(db)
    support = [c for c in customers if c.segment == "Lost Cause"]
    out, hardship = [], []
    for code in sorted(active_codes(db), key=lambda k: (len(k), k)):
        st = meta.get(code)
        row = lambda reach: {"code": code, "name": st.name if st else code,  # noqa: E731
                             "channel": st.channel if st else None, "reach": round(reach, 3),
                             "human_review": code in review, "kept_for_support": False,
                             "evidence": ev.for_arm(code, cohorts, segments)}
        reach = sum(1 for c in customers if eligibility(code, c)[0]) / len(customers) if customers else 0
        if reach >= MIN_REACH:
            out.append(row(reach))
        if support and treatment_kind(code) == "Hardship":
            r = sum(1 for c in support if eligibility(code, c)[0]) / len(support)
            if r >= MIN_REACH:
                hardship.append(row(reach))
    out.sort(key=lambda t: -t["evidence"]["score"])
    chosen = out[:MAX_ARMS]
    if hardship and not any(treatment_kind(t["code"]) == "Hardship" for t in chosen):
        keep = max(hardship, key=lambda t: t["evidence"]["score"])
        keep["kept_for_support"] = True
        chosen = chosen[:MAX_ARMS - 1] + [keep]
    return chosen


def _evidence_line(t: dict) -> str:
    e = t["evidence"]
    if t.get("kept_for_support"):
        return (f"{t['name']} is kept whatever its payment rate ({_pct(e['rate'])} of {e['n']}): the audience "
                f"includes customers who need support, and they keep the hardship route.")
    if e["n"]:
        return (f"{t['name']}: {e['paid']} of {e['n']} treated customers paid ({_pct(e['rate'])}, {e['source']}); "
                f"open to {_pct(t['reach'])} of the audience.")
    return (f"{t['name']}: no results yet; playbook history {_pct(e['playbook_rate'])}. Open to "
            f"{_pct(t['reach'])} of the audience - Thompson sampling will test it.")


def _confidence(treatments: list[dict], ctrl_n: int) -> str:
    top = treatments[0]["evidence"] if treatments else {"n": 0, "source": ""}
    if top["n"] >= 50 and top["source"] == "this audience" and ctrl_n >= 30:
        return "Strong evidence"
    if top["n"] >= 15:
        return "Some evidence"
    return "Little evidence"


# ---------------------------------------------------------------------------
# New strategies for audiences nobody covers
# ---------------------------------------------------------------------------
def _uncovered(db: Session) -> dict[str, list]:
    live = db.query(Campaign).filter(Campaign.status == "Live").all()
    running = [k for (k,) in db.query(Campaign.campaign_id).filter(Campaign.status.in_(["Live", "Paused"]))]
    decided = {cid for (cid,) in db.query(Decision.customer_id).filter(Decision.campaign_id.in_(running))}
    out: dict[str, list] = defaultdict(list)
    for c in db.query(models.Customer).filter(models.Customer.segment.in_(TREATABLE)):
        if c.customer_id in decided or any(engine.in_audience(x, c)[0] for x in live):
            continue
        out[c.cohort_id].append(c)
    return out


def _new_suggestions(db: Session, ev: Evidence) -> list[dict]:
    cohorts = {c.cohort_id: c for c in db.query(models.Cohort)}
    paused = {jc: x for x in db.query(Campaign).filter(Campaign.status == "Paused") for jc in json.loads(x.target_cohorts)}
    out = []
    for cohort_id, customers in sorted(_uncovered(db).items()):
        if len(customers) < MIN_ACCOUNTS:
            continue
        segments = [s for s in TREATABLE if any(c.segment == s for c in customers)]
        audience = [c for c in customers if c.segment in segments]
        treatments = _treatments(db, ev, audience, [cohort_id], segments)
        if not treatments:
            continue
        cp, cn = ev.control([cohort_id], segments)
        co = cohorts.get(cohort_id)
        best = treatments[0]["evidence"]
        counts = {s: sum(1 for c in audience if c.segment == s) for s in segments}
        why = [f"{len(audience)} {co.name if co else cohort_id} accounts that can be helped are not covered by any "
               f"live strategy (" + ", ".join(f"{n} {FIT_LABEL[s]}" for s, n in counts.items()) + ")."]
        if cohort_id in paused:
            p = paused[cohort_id]
            why.append(f"{p.campaign_id} {p.name} covered this cohort but is paused.")
        why += [_evidence_line(t) for t in treatments]
        if cn:
            why.append(f"Comparable control customers paid {_pct(cp / cn)} without treatment ({cp} of {cn}).")
        caveats = ["Raw payment rates include customers who would have paid anyway; the strategy's own control group "
                   "will measure what it adds."]
        if best["n"] < 15:
            caveats.append("Little outcome data for this audience yet: the first waves are mostly exploration.")
        needs_person = [t["name"] for t in treatments if t["human_review"]]
        if needs_person:
            caveats.append(", ".join(needs_person) + " needs a person to approve each offer, so it adds to the "
                           "Review Queue.")
        hardship = any(t["code"] == "S6" or "Hardship" in t["name"] for t in treatments)
        focus = "Hardship and Recovery" if "Lost Cause" in segments and hardship else "Recovery"
        name = f"{co.name if co else cohort_id} {focus}"[:100]
        rate = max(best["score"], 0.05)
        fields = {
            "name": name,
            "description": (f"Suggested by ARI from the decision log: covers {len(audience)} {cohort_id} accounts "
                            f"no live strategy reaches."),
            "target_cohorts": [cohort_id], "include_segments": segments, "risk_bands": [],
            "min_balance": None, "max_balance": None, "min_dpd": None, "max_dpd": None,
            "treatment_codes": [t["code"] for t in treatments],
            "cadence_days": 4 if "Lost Cause" in segments else 3, "max_touches": 2 if "Lost Cause" in segments else 3,
            "tone": "Supportive", "send_window_start": max(9, int(cfg(db, "contact_hour_start"))),
            "send_window_end": min(19, int(cfg(db, "contact_hour_end"))),
            "escalate_after_days": 14, "escalate_to": None,
            "control_pct": float(cfg(db, "default_control_pct")),
            "wave_size": max(10, min(40, len(audience) // 4)),
            "evaluation_days": int(cfg(db, "evaluation_days")),
            "recovery_target": round(int(rate * 20) / 20, 2) or 0.05,
        }
        out.append({"key": f"new-{cohort_id}", "kind": "new", "title": f"Cover {co.name if co else cohort_id}",
                    "summary": (f"A new strategy for {len(audience)} {co.name if co else cohort_id} accounts that no "
                                f"live strategy reaches, led by {treatments[0]['name']}."),
                    "accounts": len(audience), "based_on": None, "treatments": treatments, "fields": fields,
                    "why": why, "caveats": caveats, "confidence": _confidence(treatments, cn),
                    "gain": max(best["score"] - (cp / cn if cn else best["score"] - 0.05), 0.02)})
    return out


# ---------------------------------------------------------------------------
# New versions of strategies that are falling short
# ---------------------------------------------------------------------------
def _revision_suggestions(db: Session, ev: Evidence) -> list[dict]:
    ceiling = cfg_float(db, "escalation_rate_target")
    out = []
    for camp in db.query(Campaign).filter(Campaign.status == "Live").order_by(Campaign.campaign_id):
        s = analytics.campaign_stats(db, camp)
        if s["treated"] < MIN_TREATED:
            continue
        behind = s["recovery_rate"] is not None and s["recovery_rate"] < camp.recovery_target - 0.05
        no_lift = s["uplift"] is not None and s["uplift"] <= 0
        escalating = bool(camp.escalate_to) and (s["escalation_rate"] or 0) > ceiling
        if not (behind or no_lift or escalating):
            continue
        cohorts = json.loads(camp.target_cohorts)
        segments = [x for x in json.loads(camp.include_segments) if x in TREATABLE] or ["Persuadable"]
        audience = [c for c in engine.target_customers(db, camp) if c.segment in segments]
        treatments = _treatments(db, ev, audience, cohorts, segments)
        current = json.loads(camp.treatment_codes)
        proposed = [t["code"] for t in treatments]
        arms_change = bool(treatments) and set(proposed) != set(current)
        if not (arms_change or escalating):
            continue
        names = {st.code: st.name for st in db.query(models.Strategy)}
        problems = []
        if behind:
            problems.append(f"recovers {_pct(s['recovery_rate'])} against a {_pct(camp.recovery_target)} target")
        if no_lift:
            problems.append(f"is {abs(s['uplift']) * 100:.1f} pts below its own control group "
                            f"({s['treated']} treated vs {s['control']} control)")
        if escalating:
            problems.append(f"escalates {_pct(s['escalation_rate'])} of customers against an {_pct(ceiling)} ceiling")
        why = [f"{camp.campaign_id} {camp.name} " + "; ".join(problems) + "."]
        changes = []
        if arms_change:
            dropped = [c for c in current if c not in proposed]
            added = [c for c in proposed if c not in current]
            if dropped:
                changes.append("drop " + ", ".join(names.get(c, c) for c in dropped))
                for c in dropped:
                    e = ev.for_arm(c, cohorts, segments)
                    if e["n"]:
                        why.append(f"{names.get(c, c)}: {e['paid']} of {e['n']} paid ({_pct(e['rate'])}, {e['source']}).")
            if added:
                changes.append("add " + ", ".join(names.get(c, c) for c in added))
            why += [_evidence_line(t) for t in treatments
                    if t["code"] in added or t["kept_for_support"] or not dropped]
        fields = {"treatment_codes": proposed if arms_change else current}
        if escalating:
            fields.update(escalate_to=None)
            changes.append(f"stop escalating to {names.get(camp.escalate_to, camp.escalate_to)}")
        cp, cn = ev.control(cohorts, segments)
        best = treatments[0]["evidence"] if treatments else {"score": s["recovery_rate"] or 0}
        caveats = ["Created as the next version of the strategy. The running version keeps going until the new one "
                   "is approved and launched.",
                   "Raw payment rates include customers who would have paid anyway."]
        newly_reviewed = [t for t in treatments if t["code"] not in current]
        needs_person = [t["name"] for t in newly_reviewed if t["human_review"]]
        if needs_person:
            caveats.append(", ".join(needs_person) + " needs a person to approve each offer, so it adds to the "
                           "Review Queue.")
        out.append({"key": f"rev-{camp.campaign_id}", "kind": "revision",
                    "title": f"Rework {camp.campaign_id} {camp.name}",
                    "summary": f"A new version of {camp.campaign_id}: " + "; ".join(changes) + ".",
                    "accounts": len(audience), "based_on": camp.campaign_id, "treatments": treatments,
                    "fields": fields, "why": why, "caveats": caveats,
                    "confidence": _confidence(treatments, cn),
                    "gain": max(best["score"] - (s["recovery_rate"] or 0), 0.02)})
    return out


def suggestions(db: Session, limit: int = 3) -> dict:
    ev = Evidence(db)
    found = _new_suggestions(db, ev) + _revision_suggestions(db, ev)
    found.sort(key=lambda x: (-(x["accounts"] * x["gain"]), x["key"]))
    # Reworking what runs tends to outscore covering what does not; keep the
    # best coverage idea in view so a gap is never hidden by the ranking.
    new = next((x for x in found if x["kind"] == "new"), None)
    if new is not None and new not in found[:limit]:
        found = found[:limit - 1] + [new] + [x for x in found[limit - 1:] if x is not new]
    # Fit groups deliberately left out, with the evidence for leaving them out.
    left_out = []
    for seg in ("Sure Thing", "Sleeping Dog"):
        p = sum(v[0] for (co, s), v in ev.ctrl.items() if s == seg)
        n = sum(v[1] for (co, s), v in ev.ctrl.items() if s == seg)
        reason = ("pays without help" if seg == "Sure Thing" else "contact is likely to backfire")
        left_out.append({"segment": seg, "label": FIT_LABEL[seg], "reason": reason,
                         "control": None if not n else {"paid": p, "n": n, "rate": p / n}})
    return {"suggestions": found[:limit], "considered": len(found), "left_out": left_out}


def find(db: Session, key: str) -> dict | None:
    return next((s for s in suggestions(db, limit=50)["suggestions"] if s["key"] == key), None)
