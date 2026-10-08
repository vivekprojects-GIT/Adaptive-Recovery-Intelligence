"""Treatment playbook and cohort handoffs.

Treatments are business-authored and stored as data: offer text, channel and
cost live in models.Strategy (the original playbook table); kind, eligibility
rules, review policy, status and version live in TreatmentMeta. The scoring
cache is refreshed after every change, so the engine, the builder and the
legacy strategy sheet all see the same playbook immediately.

Handoffs simulate what the bank's collections system does every cycle: send a
new set of delinquent accounts. Without them a fixed demo population runs dry
and later waves have nobody left to decide.
"""
from __future__ import annotations

import json
import random
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models
from ..scoring import (
    BUILTIN_TREATMENTS, KINDS, RULE_FIELDS, describe_rules, nudge_score, segment_for, self_cure_score,
    set_treatments,
)
from .models import Campaign, Decision, Handoff, Nudge, TreatmentMeta, User
from .platform import audit
from . import router

UTC = timezone.utc
HUMAN_REVIEW_DEFAULT = {"S3", "S4", "S6"}
CHANNELS = ["SMS", "App push", "SMS + App", "Email", "Outbound call", "Letter", "Specialist team"]


class PlaybookError(Exception):
    """A governance rule refused the change."""


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------
def refresh_cache(db: Session) -> None:
    metas = {m.code: m for m in db.query(TreatmentMeta)}
    cache = {}
    for s in db.query(models.Strategy):
        m = metas.get(s.code)
        if m:
            cache[s.code] = {"kind": m.kind, "rules": json.loads(m.rules or "{}"), "active": m.status == "Active"}
        elif s.code in BUILTIN_TREATMENTS:
            cache[s.code] = dict(BUILTIN_TREATMENTS[s.code])
    set_treatments(cache)


def seed_meta(db: Session) -> None:
    """Describe the six original treatments in the same terms as new ones."""
    for code, spec in BUILTIN_TREATMENTS.items():
        if db.get(TreatmentMeta, code) or not db.get(models.Strategy, code):
            continue
        db.add(TreatmentMeta(code=code, kind=spec["kind"], rules=json.dumps(spec["rules"]),
                             human_review=code in HUMAN_REVIEW_DEFAULT, builtin=True,
                             updated_at=now()))
    db.commit()
    refresh_cache(db)


def human_review_codes(db: Session) -> set[str]:
    return {m.code for m in db.query(TreatmentMeta).filter(TreatmentMeta.human_review.is_(True))}


def active_codes(db: Session) -> set[str]:
    return {m.code for m in db.query(TreatmentMeta).filter(TreatmentMeta.status == "Active")}


# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
def usage(db: Session, code: str) -> dict:
    strategies = [c for c in db.query(Campaign)
                  if code in json.loads(c.treatment_codes or "[]") or c.escalate_to == code]
    decisions = db.query(func.count(Decision.decision_id)).filter(Decision.treatment_code == code).scalar() or 0
    nudges = db.query(func.count(Nudge.nudge_id)).filter(Nudge.treatment_code == code).scalar() or 0
    return {
        "strategies": [{"campaign_id": c.campaign_id, "name": c.name, "status": c.status} for c in strategies],
        "live_strategies": sum(1 for c in strategies if c.status == "Live"),
        "decisions": decisions, "nudges": nudges,
        "deletable": not strategies and decisions == 0 and nudges == 0,
    }


def _name(db: Session, user_id: str | None) -> str | None:
    if not user_id or user_id == "system":
        return None
    u = db.get(User, user_id)
    return u.name if u else user_id


def serialize(db: Session, s: models.Strategy, m: TreatmentMeta | None) -> dict:
    rules = json.loads(m.rules) if m else BUILTIN_TREATMENTS.get(s.code, {}).get("rules", {})
    n = s.hist_successes + s.hist_failures
    return {
        "code": s.code, "name": s.name, "channel": s.channel, "offer": s.offer, "timing": s.timing,
        "eligibility_rule": describe_rules(rules), "rules": rules, "cost": s.cost_per_contact,
        "historical_rate": round(s.hist_successes / n, 4) if n else None, "historical_n": n,
        "kind": m.kind if m else BUILTIN_TREATMENTS.get(s.code, {}).get("kind"),
        "status": m.status if m else "Active", "human_review": bool(m and m.human_review),
        "version": m.version if m else 1, "builtin": bool(m and m.builtin),
        "updated_by": _name(db, m.updated_by) if m else None, "updated_at": m.updated_at if m else None,
        "usage": usage(db, s.code),
    }


def list_treatments(db: Session) -> list[dict]:
    metas = {m.code: m for m in db.query(TreatmentMeta)}
    rows = sorted(db.query(models.Strategy), key=lambda s: (len(s.code), s.code))
    return [serialize(db, s, metas.get(s.code)) for s in rows]


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------
def _clean_rules(rules: dict) -> dict:
    out = {}
    for k in RULE_FIELDS:
        v = rules.get(k)
        # Not `v in (None, "", False)`: 0 == False, and "no missed payments" is a real rule.
        if v is None or v is False or v == "":
            continue
        out[k] = True if k.startswith("requires_") else float(v) if k in ("min_balance", "min_payment_history", "min_tenure_years") else int(v)
    if "min_payment_history" in out and not 0 <= out["min_payment_history"] <= 1:
        raise PlaybookError("On-time history must be between 0% and 100%.")
    if out.get("min_dpd") is not None and out.get("max_dpd") is not None and out["min_dpd"] > out["max_dpd"]:
        raise PlaybookError("Minimum days past due cannot be above the maximum.")
    return out


def _validate(payload: dict) -> None:
    if len((payload.get("name") or "").strip()) < 3:
        raise PlaybookError("A treatment needs a name of at least 3 characters.")
    if payload.get("kind") not in KINDS:
        raise PlaybookError(f"Kind must be one of: {', '.join(KINDS)}.")
    if not (payload.get("channel") or "").strip():
        raise PlaybookError("Choose a channel.")
    if (payload.get("cost") or 0) < 0:
        raise PlaybookError("Cost per contact cannot be negative.")
    if not (payload.get("offer") or "").strip():
        raise PlaybookError("Describe the offer or message the customer receives.")


def _next_code(db: Session) -> str:
    nums = [int(s.code[1:]) for s in db.query(models.Strategy) if s.code[1:].isdigit()]
    return f"S{max(nums + [0]) + 1}"


def create(db: Session, payload: dict, actor: str) -> dict:
    _validate(payload)
    rules = _clean_rules(payload.get("rules") or {})
    code = _next_code(db)
    db.add(models.Strategy(code=code, name=payload["name"].strip(), channel=payload["channel"].strip(),
                           offer=payload["offer"].strip(), timing=(payload.get("timing") or "Day 1").strip(),
                           eligibility_rule=describe_rules(rules), cost_per_contact=float(payload.get("cost") or 0),
                           hist_successes=0, hist_failures=0))
    db.add(TreatmentMeta(code=code, kind=payload["kind"], rules=json.dumps(rules),
                         human_review=bool(payload.get("human_review")), created_by=actor, updated_by=actor,
                         updated_at=now()))
    audit(db, actor, "CREATE", "treatment", code, f"Added treatment {code} {payload['name'].strip()}")
    db.commit()
    refresh_cache(db)
    return serialize(db, db.get(models.Strategy, code), db.get(TreatmentMeta, code))


MATERIAL = ("kind", "channel", "rules", "human_review")


def update(db: Session, code: str, payload: dict, actor: str) -> dict:
    s = db.get(models.Strategy, code)
    m = db.get(TreatmentMeta, code)
    if not s or not m:
        raise PlaybookError("Treatment not found.")
    _validate(payload)
    rules = _clean_rules(payload.get("rules") or {})
    before = {"kind": m.kind, "channel": s.channel, "rules": json.loads(m.rules), "human_review": m.human_review}
    after = {"kind": payload["kind"], "channel": payload["channel"].strip(), "rules": rules,
             "human_review": bool(payload.get("human_review"))}
    material = [k for k in MATERIAL if before[k] != after[k]]
    s.name, s.channel, s.offer = payload["name"].strip(), after["channel"], payload["offer"].strip()
    s.timing = (payload.get("timing") or s.timing).strip()
    s.cost_per_contact = float(payload.get("cost") or 0)
    s.eligibility_rule = describe_rules(rules)
    m.kind, m.rules, m.human_review = after["kind"], json.dumps(rules), after["human_review"]
    if material:
        m.version += 1
    m.updated_by, m.updated_at = actor, now()
    u = usage(db, code)
    note = (f" - v{m.version}; applies to the next wave of {u['live_strategies']} live strateg"
            f"{'y' if u['live_strategies'] == 1 else 'ies'}") if material and u["live_strategies"] else (
        f" - v{m.version}" if material else "")
    audit(db, actor, "UPDATE", "treatment", code, f"Edited treatment {code}{note}",
          {"material": material, "before": before, "after": after})
    db.commit()
    refresh_cache(db)
    out = serialize(db, s, m)
    out["material_change"] = bool(material)
    return out


def set_status(db: Session, code: str, status: str, actor: str) -> dict:
    m = db.get(TreatmentMeta, code)
    if not m:
        raise PlaybookError("Treatment not found.")
    if status == "Retired":
        active = [c for c in db.query(TreatmentMeta).filter(TreatmentMeta.status == "Active")]
        if len(active) <= 1:
            raise PlaybookError("At least one treatment must stay active.")
    m.status, m.updated_by, m.updated_at = status, actor, now()
    audit(db, actor, "UPDATE", "treatment", code,
          f"{'Retired' if status == 'Retired' else 'Reactivated'} treatment {code}")
    db.commit()
    refresh_cache(db)
    return serialize(db, db.get(models.Strategy, code), m)


def delete(db: Session, code: str, actor: str) -> dict:
    s = db.get(models.Strategy, code)
    m = db.get(TreatmentMeta, code)
    if not s:
        raise PlaybookError("Treatment not found.")
    u = usage(db, code)
    if not u["deletable"]:
        where = ", ".join(x["campaign_id"] for x in u["strategies"]) or "past decisions"
        raise PlaybookError(f"{code} is referenced by {where} and {u['decisions']} decisions. Deleting it would "
                            f"break their history - retire it instead, so it can no longer be chosen.")
    if m:
        db.delete(m)
    db.delete(s)
    audit(db, actor, "DELETE", "treatment", code, f"Deleted treatment {code} {s.name}")
    db.commit()
    refresh_cache(db)
    return {"deleted": code}


# ---------------------------------------------------------------------------
# Handoffs
# ---------------------------------------------------------------------------
HANDOFF_SIZES = {"C1": 120, "C2": 160, "C3": 90, "C4": 50}


def ingest_handoff(db: Session, actor: str = "system", trigger: str = "manual",
                   sizes: dict[str, int] | None = None, seed: int | None = None) -> dict:
    """Generate the next cycle's delinquent accounts, cohort by cohort, with the
    same behavioural mix as the original handoff."""
    from ..seed import COHORTS, FIRST, LAST, _draw  # same generator as the initial data
    sizes = sizes or HANDOFF_SIZES
    n_prev = db.query(func.count(Handoff.handoff_id)).scalar() or 0
    rng = random.Random(seed if seed is not None else 7_000 + n_prev)
    counts: dict[str, int] = {}
    arrived: list = []
    for co in COHORTS:
        n = sizes.get(co["cohort_id"], 0)
        if not n:
            continue
        targets: list[str] = []
        for seg, share in co["mix"].items():
            targets += [seg] * int(round(share * n))
        while len(targets) < n:
            targets.append("Sure Thing")
        rng.shuffle(targets)
        for target in targets[:n]:
            for _ in range(60):
                f = _draw(target, rng)
                limit = rng.choice([2000, 3000, 5000, 8000, 12000, 15000])
                cand = models.Customer(
                    cohort_id=co["cohort_id"], name=f"{rng.choice(FIRST)} {rng.choice(LAST)}",
                    balance=round(limit * f["utilization"], 2), credit_limit=float(limit),
                    days_past_due=rng.randint(*co["dpd"]), client_risk_band=co["client_risk_band"],
                    client_risk_score=round(rng.uniform(*co["risk"]), 1), **f)
                if segment_for(cand) == target:
                    break
            cand.nudge_score = nudge_score(cand)
            cand.self_cure_score = self_cure_score(cand)
            cand.segment = segment_for(cand)
            db.add(cand)
            arrived.append(cand)
            counts[co["cohort_id"]] = counts.get(co["cohort_id"], 0) + 1
    total = sum(counts.values())
    db.flush()
    at = datetime.now(timezone.utc)
    for cand in arrived:   # every account goes through the Propensity Router as it arrives
        router.record(db, cand, origin="handoff", at=at, simulate=True)
    db.add(Handoff(at=now(), by=actor, counts=json.dumps(counts), total=total, trigger=trigger))
    audit(db, actor, "CREATE", "handoff", str(n_prev + 1),
          f"Received cohort handoff #{n_prev + 1}: {total} new accounts ({trigger})", counts)
    db.commit()
    return {"handoff": n_prev + 1, "total": total, "counts": counts, "trigger": trigger}


def handoffs(db: Session) -> list[dict]:
    return [{"handoff_id": h.handoff_id, "at": h.at, "by": _name(db, h.by) or "Collections system", "total": h.total,
             "counts": json.loads(h.counts), "trigger": h.trigger}
            for h in db.query(Handoff).order_by(Handoff.handoff_id.desc())]
