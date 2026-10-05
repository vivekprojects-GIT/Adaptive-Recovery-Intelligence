"""AI Workbench and AI-assisted strategy drafting.

Both are deterministic analysis over the live decision log. Every number in a
problem area, an idea or a draft rationale is read from the data and can be
traced back to it. A language model could rephrase these later; it should not
be the source of the figures.

Drafting respects the governance rule that business users author strategies:
an AI draft is only ever a Draft, and it needs approval like any other.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from .. import models
from .analytics import campaign_stats
from .engine import jl
from .models import Campaign, ComplianceViolation, Decision
from .platform import cfg_float
from .playbook import active_codes

UTC = timezone.utc


def _pct(x):
    return f"{x * 100:.0f}%" if x is not None else "n/a"


def _pp(x):
    return f"{x * 100:+.1f} pp" if x is not None else "n/a"


# ---------------------------------------------------------------------------
# Problem areas
# ---------------------------------------------------------------------------
def problem_areas(db: Session) -> list[dict]:
    out: list[dict] = []
    now = datetime.now(UTC)
    last = (now - timedelta(days=14)).isoformat(timespec="seconds")
    prior = (now - timedelta(days=28)).isoformat(timespec="seconds")
    ceiling = cfg_float(db, "escalation_rate_target")
    treat = {s.code: s.name for s in db.query(models.Strategy)}

    for c in db.query(Campaign).filter(Campaign.status == "Live"):
        s = campaign_stats(db, c)
        if s["treated"] < 20:
            continue
        if s["recovery_rate"] is not None and s["recovery_rate"] < c.recovery_target - 0.05:
            gap = c.recovery_target - s["recovery_rate"]
            out.append({
                "id": f"under-{c.campaign_id}", "kind": "underperforming", "campaign_id": c.campaign_id,
                "severity": "Critical" if gap > 0.15 else "High",
                "title": f"{c.campaign_id} underperforming",
                "metrics": f"{_pct(s['recovery_rate'])} rate vs {_pct(c.recovery_target)} target · "
                           f"uplift over control {_pp(s['uplift'])}",
                "evidence": s})
        elif s["uplift"] is not None and s["uplift"] <= 0 and s["control"] >= 15:
            out.append({
                "id": f"nolift-{c.campaign_id}", "kind": "no_lift", "campaign_id": c.campaign_id,
                "severity": "High", "title": f"{c.campaign_id} shows no lift over control",
                "metrics": f"treated {_pct(s['recovery_rate'])} vs control {_pct(s['control_rate'])} "
                           f"({s['treated']} vs {s['control']} customers)",
                "evidence": s})

        if c.escalate_to:
            cur = campaign_stats(db, c, last)
            from .analytics import _rows, stats_from_rows  # local: avoid a cycle at import
            prev = stats_from_rows(db, _rows(db, [c.campaign_id], prior, last))
            er, pr = cur["escalation_rate"], prev["escalation_rate"]
            if er is not None and er > ceiling and (pr is None or er > pr):
                out.append({
                    "id": f"esc-{c.campaign_id}", "kind": "escalation", "campaign_id": c.campaign_id,
                    "severity": "High", "title": "Escalation rate rising",
                    "metrics": f"{_pct(er)} in {c.campaign_id} (ceiling {_pct(ceiling)})"
                               + (f", up from {_pct(pr)}" if pr is not None else ""),
                    "evidence": {"current": er, "previous": pr, "escalate_after_days": c.escalate_after_days,
                                 "escalate_to": treat.get(c.escalate_to)}})

        plan_arms = [a for a in ("S3", "S4") if a in jl(c.treatment_codes)]
        if plan_arms:
            rows = (db.query(Decision).filter(Decision.campaign_id == c.campaign_id,
                                              Decision.treatment_code.in_(plan_arms)).count())
            if rows >= 15:
                pass  # take-up is covered by per-arm stats in the idea generator

    opt = (db.query(ComplianceViolation)
           .filter(ComplianceViolation.policy_area == "Opt-Out / Suppression",
                   ComplianceViolation.status != "Resolved").all())
    if opt:
        v = opt[-1]
        out.append({"id": "optout", "kind": "optout", "campaign_id": v.campaign_id, "severity": "High",
                    "title": "Opt-out suppression lag",
                    "metrics": f"{v.violation_id}: {v.description[:70]} · {len(opt)} open",
                    "evidence": {"open": len(opt), "example": v.description}})

    pending = db.query(Decision).filter(Decision.review_status == "pending").count()
    if pending:
        out.append({"id": "review", "kind": "review_backlog", "campaign_id": None, "severity": "Medium",
                    "title": "Decisions waiting for human review",
                    "metrics": f"{pending} forbearance decisions are held until a strategist approves them",
                    "evidence": {"pending": pending}})

    order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}
    return sorted(out, key=lambda a: order.get(a["severity"], 9))


# ---------------------------------------------------------------------------
# Ideas
# ---------------------------------------------------------------------------
def _arm_stats(db: Session, camp: Campaign) -> list[dict]:
    from .analytics import _rows
    rows = _rows(db, [camp.campaign_id])
    control = [o for d, o in rows if d.group == "Control" and o is not None]
    c_rate = sum(o.paid for o in control) / len(control) if control else None
    treat = {s.code: s.name for s in db.query(models.Strategy)}
    out = []
    for code in jl(camp.treatment_codes):
        arm = [o for d, o in rows if d.treatment_code == code and d.group == "Treatment"
               and o is not None and o.reward is not None]
        if not arm:
            continue
        rate = sum(o.paid for o in arm) / len(arm)
        out.append({"code": code, "name": treat.get(code, code), "n": len(arm), "rate": rate,
                    "uplift": rate - c_rate if c_rate is not None else None})
    return out


def ideas_for(db: Session, area: dict) -> list[dict]:
    camp = db.get(Campaign, area["campaign_id"]) if area.get("campaign_id") else None
    kind = area["kind"]
    out: list[dict] = []
    if kind in ("underperforming", "no_lift") and camp:
        arms = sorted(_arm_stats(db, camp), key=lambda a: a["rate"])
        if len(arms) >= 2 and arms[0]["n"] >= 8:
            worst, best = arms[0], arms[-1]
            keep = [c for c in jl(camp.treatment_codes) if c != worst["code"]]
            out.append({
                "title": f"Drop {worst['name']} from {camp.campaign_id}",
                "body": f"{worst['name']} converts {_pct(worst['rate'])} over {worst['n']} customers, "
                        f"against {_pct(best['rate'])} for {best['name']}. Removing it lets the bandit "
                        f"spend that traffic on arms with evidence behind them.",
                "evidence": "Per-arm rates are confounded by routing; confirm on the reweighted view "
                            "before acting.",
                "priority": "High", "change": {"treatment_codes": keep}})
        out.append({
            "title": f"Slow the cadence in {camp.campaign_id}",
            "body": f"Contacts go out every {camp.cadence_days} days up to {camp.max_touches} touches. "
                    f"Moving to every {camp.cadence_days + 2} days reduces contact load while the "
                    f"strategy is below target, and tests whether frequency is costing goodwill.",
            "evidence": f"Current rate {area['metrics']}.", "priority": "Medium",
            "change": {"cadence_days": camp.cadence_days + 2}})
    elif kind == "escalation" and camp:
        ev = area["evidence"]
        out.append({
            "title": f"Delay escalation in {camp.campaign_id} to day {camp.escalate_after_days + 7}",
            "body": f"Escalation to {ev.get('escalate_to')} currently fires on day "
                    f"{camp.escalate_after_days}. Many digital payers settle in the second week; "
                    f"escalating later avoids paying for calls the customer did not need.",
            "evidence": area["metrics"], "priority": "High",
            "change": {"escalate_after_days": camp.escalate_after_days + 7}})
        out.append({
            "title": f"Cap touches at {max(1, camp.max_touches - 1)} before escalation",
            "body": "Fewer reminders before the escalation step keeps the contact count inside "
                    "the 7-in-7 guidance when the BAU dialler is also active.",
            "evidence": area["metrics"], "priority": "Medium",
            "change": {"max_touches": max(1, camp.max_touches - 1)}})
    elif kind == "optout":
        out.append({
            "title": "Sync opt-outs to the BAU dialler within 1 hour",
            "body": "The breaches are contacts from the bank's existing systems after a customer "
                    "opted out through an ARI message. ARI suppresses immediately; the BAU feed does "
                    "not. This is a process fix for the integration, not a strategy change.",
            "evidence": area["evidence"]["example"], "priority": "Critical", "change": {}})
    elif kind == "review_backlog":
        out.append({
            "title": "Clear the review queue daily",
            "body": "Plan and deferral offers wait for a person by design. A queue that grows means "
                    "customers who need help wait longer. Assign a reviewer per strategy.",
            "evidence": area["metrics"], "priority": "Medium", "change": {}})
    return out


def answer(db: Session, text: str) -> dict:
    """Free-text question: route to the matching problem areas."""
    t = text.lower()
    areas = problem_areas(db)
    hits = [a for a in areas if (a.get("campaign_id") and a["campaign_id"].lower() in t)
            or any(w in t for w in {
                "underperforming": ["underperform", "low rate", "target", "lift", "not working"],
                "no_lift": ["lift", "control", "uplift"],
                "escalation": ["escalat", "call"],
                "optout": ["opt", "suppress", "stop"],
                "review_backlog": ["review", "queue", "pending", "approval"],
            }.get(a["kind"], []))]
    if not hits:
        return {"reply": "I could not match that to a current problem area. Pick one on the left, or "
                         "name a strategy (for example STR-021) and I will analyse it against its "
                         "control group.", "ideas": [], "areas": []}
    ideas = [i | {"area_id": a["id"], "campaign_id": a.get("campaign_id")}
             for a in hits for i in ideas_for(db, a)]
    lines = [f"{a['title']}: {a['metrics']}" for a in hits]
    return {"reply": "Here is what the data shows:\n" + "\n".join(f"• {l}" for l in lines),
            "ideas": ideas, "areas": [a["id"] for a in hits]}


# ---------------------------------------------------------------------------
# AI-assisted strategy drafting
# ---------------------------------------------------------------------------
PRESETS = [
    {"label": "Medium risk 30 DPD — first contact, higher balance",
     "brief": "Recovery strategy for medium-risk 30 DPD card accounts with balances between $2k-$10k. "
              "First contact. Offer flexible payment plans and avoid aggressive escalation in the first 14 days.",
     "risk": "Medium", "goal": "Payment plan"},
    {"label": "Low risk early arrears — balance under $2k, quick recovery",
     "brief": "Low-risk early arrears with balance under $2k. Quick, cheap digital reminders only.",
     "risk": "Low", "goal": "Quick recovery"},
    {"label": "High risk 60 DPD — last attempt before escalation",
     "brief": "High-risk 60 DPD accounts. Last attempt before external escalation; call within 7 days.",
     "risk": "High", "goal": "Pre-escalation"},
    {"label": "First-time delinquent — empathetic approach",
     "brief": "First-time delinquent customers, empathetic and supportive tone, no calls, max 2 touches.",
     "risk": "Low", "goal": "Empathetic"},
]

RISK_TO_COHORT = {"Low": ["C1"], "Medium": ["C2"], "High": ["C3"], "Very high": ["C4"]}
GOAL_ARMS = {
    "Payment plan": ["S3", "S1", "S2"],
    "Quick recovery": ["S1", "S2"],
    "Pre-escalation": ["S5", "S3", "S1"],
    "Empathetic": ["S2", "S1", "S4"],
}


def _money(s: str) -> float:
    s = s.lower().replace(",", "").replace("$", "")
    mult = 1000 if s.endswith("k") else 1
    return float(s.rstrip("k")) * mult


def draft_from_brief(db: Session, brief: str, risk: str, goal: str) -> tuple[dict, list[str]]:
    """Returns (campaign fields, rationale). Every field is explained, and the
    explanation names the words in the brief that produced it."""
    text = brief.lower()
    why: list[str] = []
    cohorts = RISK_TO_COHORT.get(risk, ["C2"])
    names = {c.cohort_id: c.name for c in db.query(models.Cohort)}
    why.append(f"Target cohort {', '.join(names.get(c, c) for c in cohorts)} from risk profile '{risk}'.")
    arms = list(GOAL_ARMS.get(goal, ["S1", "S2"]))
    treat = {s.code: s.name for s in db.query(models.Strategy)}
    why.append(f"Arms {', '.join(treat[a] for a in arms)} for the goal '{goal}'.")

    fields: dict = {"target_cohorts": cohorts, "risk_bands": [], "include_segments": ["Persuadable"],
                    "treatment_codes": arms, "tone": "Supportive", "cadence_days": 3, "max_touches": 3,
                    "escalate_after_days": 14, "escalate_to": None}

    rng = re.search(r"\$?(\d[\d,]*k?)\s*(?:-|to)\s*\$?(\d[\d,]*k?)", text)
    if rng:
        fields["min_balance"], fields["max_balance"] = _money(rng.group(1)), _money(rng.group(2))
        why.append(f"Balance ${fields['min_balance']:,.0f}-${fields['max_balance']:,.0f} "
                   f"from '{rng.group(0)}'.")
    else:
        under = re.search(r"(?:under|below|less than)\s*\$?(\d[\d,]*k?)", text)
        if under:
            fields["max_balance"] = _money(under.group(1))
            why.append(f"Balance cap ${fields['max_balance']:,.0f} from '{under.group(0)}'.")

    days = re.search(r"first\s+(\d+)\s+days", text)
    if "escalat" in text and days:
        fields["escalate_after_days"] = max(int(days.group(1)) + 1, 7)
        why.append(f"No escalation before day {fields['escalate_after_days']} from '{days.group(0)}'.")
    if "call" in text and "no call" not in text and "S5" not in arms:
        fields["escalate_to"] = "S5"
        why.append("Escalate to Agent Call because the brief mentions calls.")
    elif goal == "Pre-escalation":
        fields["escalate_to"] = "S5"
        fields["escalate_after_days"] = 7
        why.append("Escalate to Agent Call on day 7 for a last-attempt strategy.")
    if "no call" in text and "S5" in arms:
        arms.remove("S5")
        why.append("Removed Agent Call because the brief says no calls.")
    if any(w in text for w in ("empathetic", "supportive", "gentle")):
        fields["tone"] = "Supportive"
        why.append("Supportive tone from the brief's wording.")
    elif any(w in text for w in ("firm", "direct", "urgent")):
        fields["tone"] = "Direct"
        why.append("Direct tone from the brief's wording.")
    touches = re.search(r"max\s*(\d+)\s*touch", text)
    if touches:
        fields["max_touches"] = int(touches.group(1))
        why.append(f"Max {fields['max_touches']} touches from '{touches.group(0)}'.")
    if "quick" in text or "cheap" in text:
        fields["cadence_days"] = 2
        why.append("Two-day cadence for a quick-recovery goal.")
    if "hardship" in text and "S6" not in arms:
        arms.append("S6")
        fields["include_segments"] = ["Persuadable", "Lost Cause"]
        why.append("Added Hardship Review and the Lost Cause segment because the brief mentions hardship.")

    live = active_codes(db)
    dropped = [a for a in arms if a not in live]
    if dropped:
        arms[:] = [a for a in arms if a in live]
        why.append(f"Left out {', '.join(treat.get(a, a) for a in dropped)} - retired from the playbook.")
    if not arms and live:
        arms.append(sorted(live, key=lambda k: (len(k), k))[0])
    if fields["escalate_to"] and fields["escalate_to"] not in live:
        fields["escalate_to"] = None

    label = {"Low": "Low-Risk", "Medium": "Medium-Risk", "High": "High-Risk"}.get(risk, risk)
    fields["name"] = f"{label} {goal.title()} Flow"
    fields["description"] = brief.strip()[:400]
    why.append("Drafted as a Draft. It cannot run until someone other than its author approves it.")
    return fields, why


def as_json(obj) -> str:
    return json.dumps(obj)
