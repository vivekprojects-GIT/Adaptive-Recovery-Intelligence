"""Strategies: list, detail, analytics, the build and approval lifecycle, versions, waves, suggestions and drafting."""
from __future__ import annotations

import json
import math
from collections import Counter, defaultdict


from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session


from ...core.database import get_db
from .. import analytics, compliance, engine, insights, playbook, suggest, scorecards
from ..engine import jl
from ..models import Campaign, Decision, Outcome, User
from ..platform import audit, cfg, now
from ..rbac import ROLES, granted, require
from .common import (
    MATERIAL, _copy, _get_campaign, _has_decisions, _make_revision, _next_campaign_id, _open_revision,
    _strategy_out, _treatments, _user_names,
)

router = APIRouter()


class StrategyIn(BaseModel):
    name: str = Field(min_length=3, max_length=100)
    description: str = ""
    target_cohorts: list[str] = []
    risk_bands: list[str] = []
    min_balance: float | None = None
    max_balance: float | None = None
    min_dpd: int | None = None
    max_dpd: int | None = None
    treatment_codes: list[str] = []
    cadence_days: int = Field(3, ge=1, le=30)
    max_touches: int = Field(3, ge=1, le=6)
    tone: str = "Supportive"
    send_window_start: int = Field(9, ge=0, le=23)
    send_window_end: int = Field(19, ge=1, le=24)
    escalate_after_days: int = Field(14, ge=1, le=60)
    escalate_to: str | None = None
    control_pct: float = Field(0.2, ge=0.1, le=0.5)
    wave_size: int = Field(40, ge=5, le=500)
    evaluation_days: int = Field(7, ge=1, le=60)
    recovery_target: float = Field(0.4, ge=0.05, le=0.99)
    steps_completed: int = Field(0, ge=0, le=6)


def _validate_strategy(db: Session, body: StrategyIn, final: bool) -> None:
    t = _treatments(db)
    bad = [c for c in body.treatment_codes if c not in t]
    if bad:
        raise HTTPException(400, f"Unknown treatments: {', '.join(bad)}")
    if body.escalate_to and body.escalate_to not in t:
        raise HTTPException(400, "Escalation must point at a treatment in the playbook.")
    if body.send_window_end <= body.send_window_start:
        raise HTTPException(400, "Send window end must be after its start.")
    start, end = int(cfg(db, "contact_hour_start")), int(cfg(db, "contact_hour_end"))
    if body.send_window_start < start or body.send_window_end > end:
        raise HTTPException(400, f"Send window must sit inside the permitted contact hours "
                                 f"({start:02d}:00-{end:02d}:00).")
    if final:
        if not body.target_cohorts:
            raise HTTPException(400, "Pick at least one target cohort.")
        if not body.treatment_codes:
            raise HTTPException(400, "Pick at least one treatment for the bandit to choose among.")
        active = playbook.active_codes(db)
        retired = [c for c in body.treatment_codes if c not in active]
        if retired:
            raise HTTPException(400, f"{', '.join(retired)} {'is' if len(retired) == 1 else 'are'} retired from "
                                     f"the playbook and cannot run. Remove {'it' if len(retired) == 1 else 'them'} "
                                     f"from the treatments step.")
        if body.escalate_to and body.escalate_to not in active:
            raise HTTPException(400, f"Escalation target {body.escalate_to} is retired from the playbook.")


@router.get("/strategies")
def list_strategies(scope: str = "all", status: str | None = None,
                    user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    q = db.query(Campaign)
    if scope == "mine":
        q = q.filter(Campaign.owner_id == user.user_id)
    if status:
        q = q.filter(Campaign.status == status)
    order = {"Live": 0, "In review": 1, "Approved": 2, "Draft": 3, "Paused": 4, "Archived": 5}
    rows = sorted(q.all(), key=lambda c: (order.get(c.status, 9), c.campaign_id))
    return [_strategy_out(db, c) for c in rows]


@router.get("/strategies/estimate")
def estimate(cohorts: str = "", risk_bands: str = "",
             min_balance: float | None = None, max_balance: float | None = None,
             min_dpd: int | None = None, max_dpd: int | None = None, treatments: str = "",
             user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    """Live count for the guided builder: how many customers this definition reaches."""
    tmp = Campaign(campaign_id="STR-TMP", target_cohorts=json.dumps([x for x in cohorts.split(",") if x]),
                   risk_bands=json.dumps([x for x in risk_bands.split(",") if x]),
                   min_balance=min_balance, max_balance=max_balance, min_dpd=min_dpd, max_dpd=max_dpd,
                   treatment_codes=json.dumps([x for x in treatments.split(",") if x] or ["S1"]),
                   control_pct=0.2)
    return engine.population_breakdown(db, tmp)


@router.get("/strategies/recommendations")
def form_recommendations(cohorts: str = "", editing: str = "", user: User = Depends(require("create_strategy")),
                         db: Session = Depends(get_db)):
    """Recommendations for the cohorts on the builder form as it stands, saved or
    not, so they follow every change. `editing` is the strategy being edited."""
    c = db.get(Campaign, editing) if editing else None
    return build_recommendations(db, {x for x in cohorts.split(",") if x},
                                 set(engine.lineage(db, c)) if c else set())


# Registered before /strategies/{cid}, which would otherwise take "suggestions" as an id.
@router.get("/strategies/suggestions")
def strategy_suggestions(user: User = Depends(require("create_strategy")), db: Session = Depends(get_db)):
    """Strategies ARI suggests from the decision log: audiences no live
    strategy covers, and new versions of strategies that are falling short."""
    return suggest.suggestions(db)


@router.post("/strategies/suggestions/{key}/draft")
def draft_from_suggestion(key: str, user: User = Depends(require("create_strategy")),
                          db: Session = Depends(get_db)):
    """Turn a suggestion into a Draft - or, for a strategy that is running, its
    next draft version. Either way it needs approval like any other strategy.
    The suggestion is recomputed here, so what is created is what the data
    supports now, not what a stale page showed."""
    s = suggest.find(db, key)
    if s is None:
        raise HTTPException(409, "This suggestion no longer applies - the data has changed since it was shown. "
                                 "Refresh the suggestions.")
    if s["kind"] == "new":
        body = StrategyIn(**s["fields"], steps_completed=5)
        _validate_strategy(db, body, final=False)
        cid = _next_campaign_id(db)
        ts = now()
        c = Campaign(campaign_id=cid, owner_id=user.user_id, created_by=user.user_id, status="Draft",
                     source="suggested", created_at=ts, updated_at=ts, seed=int(cid.split("-")[1]) * 7 + 3,
                     **{k: (json.dumps(v) if isinstance(v, list) else v) for k, v in body.model_dump().items()})
        db.add(c)
        summary = f"Created {cid} {c.name} from an ARI suggestion"
    else:
        if "edit_strategy" not in granted(db, user.role):
            raise HTTPException(403, f"{ROLES.get(user.role, user.role)} role does not have: Edit Strategy.")
        src = _get_campaign(db, s["based_on"])
        open_rev = _open_revision(db, src.campaign_id)
        if open_rev is not None:
            raise HTTPException(409, f"{src.campaign_id} already has a draft version, {open_rev.campaign_id}. "
                                     f"Finish or delete it before starting another.")
        c, _ = _make_revision(db, src, user)
        for k, v in s["fields"].items():
            setattr(c, k, json.dumps(v) if isinstance(v, list) else v)
        c.source = "suggested"
        c.description = ((c.description + "\n\n") if c.description else "") + "From an ARI suggestion: " + s["summary"]
        summary = f"Created {c.campaign_id} as v{c.version} of {src.campaign_id} from an ARI suggestion"
    audit(db, user.user_id, "CREATE", "strategy", c.campaign_id, summary,
          {"suggestion": key, "why": s["why"], "caveats": s["caveats"]})
    db.commit()
    out = _strategy_out(db, c, stats=False)
    out["suggestion"] = key
    return out


@router.get("/strategies/{cid}")
def strategy_detail(cid: str, user: User = Depends(require("view_kpi_dashboard")),
                    db: Session = Depends(get_db)):
    c = _get_campaign(db, cid)
    out = _strategy_out(db, c)
    out["population"] = engine.population_breakdown(db, c)
    out["beliefs"] = list(engine.beliefs(db, c).values())
    out["learning"] = engine.learning(db, c)
    out["pool_remaining"] = len(engine.undecided_pool(db, c)) if c.status in ("Live", "Paused") else None
    out["weekly"] = analytics.weekly(db, [cid])
    out["scorecard"] = scorecards.strategy(db, c)
    # Per arm: raw rate and the reweighted (inverse-propensity) rate.
    arms = []
    rows = analytics._rows(db, [cid])
    c_rate = out["stats"]["control_rate"]
    t = _treatments(db)
    for code in jl(c.treatment_codes):
        if code not in t:
            continue
        arm = [(d, o) for d, o in rows if d.treatment_code == code and d.group == "Treatment"
               and not d.validation and o is not None and o.reward is not None]
        n = len(arm)
        paid = sum(o.paid for _, o in arm)
        w = [(o.paid, 1 / max(d.selection_probability or 1e-3, 1e-3)) for d, o in arm]
        ipw = sum(p * x for p, x in w) / sum(x for _, x in w) if w else None
        lo, hi = analytics._wilson(paid, n)
        arms.append({"code": code, "name": t[code].name, "n": n, "paid": paid,
                     "rate": paid / n if n else None, "ipw_rate": ipw, "ci": [lo, hi],
                     "uplift": (paid / n - c_rate) if n and c_rate is not None else None})
    out["arms"] = arms
    out["waves"] = [
        {"wave": w, **analytics.stats_from_rows(db, [(d, o) for d, o in rows if d.wave == w])}
        for w in sorted({d.wave for d, _ in rows})]
    out["learning_state"] = analytics.learning_state(c, out["learning"], out["population"],
                                                     {b["code"]: b for b in out["beliefs"]})
    out["results_state"] = analytics.results_state(out["stats"])
    # Version history: the versions this one replaced, and any later version.
    names = _user_names(db)
    chain = [db.get(Campaign, x) for x in engine.lineage(db, c)]
    later = db.query(Campaign).filter(Campaign.parent_id == cid).order_by(Campaign.created_at).all()
    out["versions"] = [{"campaign_id": v.campaign_id, "version": v.version, "status": v.status,
                        "owner": names.get(v.owner_id), "created_at": v.created_at,
                        "launched_at": v.launched_at, "current": v.campaign_id == cid}
                       for v in sorted([x for x in chain if x] + later, key=lambda v: v.version)]
    return out


@router.get("/analytics/strategies")
def strategy_analytics(include_archived: bool = False, user: User = Depends(require("view_kpi_dashboard")),
                       db: Session = Depends(get_db)):
    """Every running strategy side by side: its result against its own control
    group, and where Thompson sampling stands in it."""
    statuses = ["Live", "Paused"] + (["Archived"] if include_archived else [])
    order = {"Live": 0, "Paused": 1, "Archived": 2}
    rows = []
    for c in sorted(db.query(Campaign).filter(Campaign.status.in_(statuses)),
                    key=lambda c: (order[c.status], c.campaign_id)):
        stats = analytics.campaign_stats(db, c)
        learning = engine.learning(db, c)
        row = _strategy_out(db, c, stats=False)
        row.update(stats=stats, learning=learning,
                   learning_state=analytics.learning_state(c, learning, engine.population_breakdown(db, c),
                                                           engine.beliefs(db, c)),
                   results_state=analytics.results_state(stats))
        rows.append(row)
    learning_states = Counter(r["learning_state"]["state"] for r in rows)
    result_states = Counter(r["results_state"]["state"] for r in rows)
    return {"strategies": rows, "summary": {
        "strategies": len(rows), "live": sum(r["status"] == "Live" for r in rows),
        "proven": result_states.get("Proven", 0), "worse": result_states.get("Worse than control", 0),
        "settled": learning_states.get("Settled", 0),
        "still_learning": learning_states.get("Leaning", 0) + learning_states.get("Exploring", 0),
        "recovered": round(sum(r["stats"]["recovered"] for r in rows), 2)}}


@router.post("/strategies")
def create_strategy(body: StrategyIn, user: User = Depends(require("create_strategy")),
                    db: Session = Depends(get_db)):
    _validate_strategy(db, body, final=False)
    cid = _next_campaign_id(db)
    ts = now()
    data = body.model_dump()
    c = Campaign(campaign_id=cid, owner_id=user.user_id, created_by=user.user_id, status="Draft",
                 source="manual", created_at=ts, updated_at=ts, seed=int(cid.split("-")[1]) * 7 + 3,
                 **{k: (json.dumps(v) if isinstance(v, list) else v) for k, v in data.items()})
    db.add(c)
    audit(db, user.user_id, "CREATE", "strategy", cid, f"Created strategy {cid} {body.name}")
    db.commit()
    return _strategy_out(db, c, stats=False)


@router.put("/strategies/{cid}")
def update_strategy(cid: str, body: StrategyIn, user: User = Depends(require("edit_strategy")),
                    db: Session = Depends(get_db)):
    c = _get_campaign(db, cid)
    if c.status in ("Live", "Paused") and _has_decisions(db, cid):
        raise HTTPException(409, f"{cid} has already decided customers, so it is changed by creating a new "
                                 f"version: use Edit, which opens v{c.version + 1} as a draft. The running "
                                 f"version keeps going until the new one is approved and launched.")
    if c.status == "Live":
        # Never edited while running: a change would take effect without approval.
        raise HTTPException(409, f"{cid} is live. Pause it first; changes to its audience, treatments or "
                                 f"experiment then go back for approval before it runs again.")
    if c.status == "Archived":
        raise HTTPException(409, "An archived strategy cannot be edited. Clone it into a new draft.")
    _validate_strategy(db, body, final=False)
    data = body.model_dump()
    changed = [k for k, v in data.items()
               if (json.dumps(v) if isinstance(v, list) else v) != getattr(c, k)]
    material = [k for k in changed if k in MATERIAL]
    for k, v in data.items():
        setattr(c, k, json.dumps(v) if isinstance(v, list) else v)
    note = ""
    if material and c.status in ("Approved", "Paused", "In review"):
        # What was approved is no longer what would run.
        c.version += 1
        c.status = "Draft"
        c.approved_by = c.approved_at = c.submitted_at = None
        note = f" - material change ({', '.join(material)}): v{c.version}, back to Draft for re-approval"
    c.updated_at = now()
    audit(db, user.user_id, "UPDATE", "strategy", cid,
          f"Edited {cid}{note}" if changed else f"Saved {cid} (no changes)",
          {"changed": changed, "material": material})
    db.commit()
    out = _strategy_out(db, c, stats=False)
    out["reapproval_required"] = bool(note)
    return out


def _transition(db: Session, c: Campaign, user: User, to: str, action: str, summary: str) -> dict:
    c.status = to
    c.updated_at = now()
    audit(db, user.user_id, action, "strategy", c.campaign_id, summary)
    db.commit()
    return _strategy_out(db, c, stats=False)


@router.post("/strategies/{cid}/submit")
def submit(cid: str, user: User = Depends(require("edit_strategy")), db: Session = Depends(get_db)):
    c = _get_campaign(db, cid)
    if c.status != "Draft":
        raise HTTPException(409, f"Only a draft can be submitted (this one is {c.status}).")
    body = StrategyIn(**{k: (jl(getattr(c, k)) if k in ("target_cohorts", "risk_bands",
                                                         "treatment_codes") else getattr(c, k))
                         for k in StrategyIn.model_fields})
    _validate_strategy(db, body, final=True)
    c.submitted_at = now()
    c.steps_completed = 6
    return _transition(db, c, user, "In review", "UPDATE", f"Submitted {cid} for approval")


class ReviewIn(BaseModel):
    note: str = ""


@router.post("/strategies/{cid}/approve")
def approve(cid: str, body: ReviewIn, user: User = Depends(require("approve_strategy")),
            db: Session = Depends(get_db)):
    c = _get_campaign(db, cid)
    if c.status != "In review":
        raise HTTPException(409, f"Only a strategy in review can be approved (this one is {c.status}).")
    if c.created_by == user.user_id or c.owner_id == user.user_id:
        raise HTTPException(403, "Maker-checker: you cannot approve a strategy you authored.")
    c.approved_by, c.approved_at = user.user_id, now()
    return _transition(db, c, user, "Approved", "APPROVE",
                       f"Approved {cid} (v{c.version})" + (f": {body.note}" if body.note else ""))


@router.post("/strategies/{cid}/reject")
def reject(cid: str, body: ReviewIn, user: User = Depends(require("approve_strategy")),
           db: Session = Depends(get_db)):
    c = _get_campaign(db, cid)
    if c.status != "In review":
        raise HTTPException(409, "Only a strategy in review can be returned.")
    if not body.note.strip():
        raise HTTPException(400, "Say what needs to change when returning a strategy.")
    c.submitted_at = None
    return _transition(db, c, user, "Draft", "UPDATE", f"Returned {cid} to draft: {body.note}")


@router.post("/strategies/{cid}/launch")
def launch(cid: str, user: User = Depends(require("launch_strategy")), db: Session = Depends(get_db)):
    c = _get_campaign(db, cid)
    if c.status not in ("Approved", "Paused"):
        raise HTTPException(409, "Only an approved or paused strategy can go live.")
    replaced = ""
    parent = db.get(Campaign, c.parent_id) if c.parent_id else None
    if parent is not None and parent.status in ("Live", "Paused"):
        # One live version at a time: the version this one replaces retires.
        # Its decisions and outcomes stay on its own record.
        parent.status, parent.updated_at = "Archived", now()
        audit(db, user.user_id, "UPDATE", "strategy", parent.campaign_id,
              f"Archived {parent.campaign_id} v{parent.version} - replaced by {cid} v{c.version}")
        replaced = f", replacing {parent.campaign_id} v{parent.version}"
    c.launched_at = c.launched_at or now()
    return _transition(db, c, user, "Live", "UPDATE", f"Launched {cid} v{c.version}{replaced}")


@router.post("/strategies/{cid}/pause")
def pause(cid: str, user: User = Depends(require("pause_archive_strategy")), db: Session = Depends(get_db)):
    c = _get_campaign(db, cid)
    if c.status != "Live":
        raise HTTPException(409, "Only a live strategy can be paused.")
    return _transition(db, c, user, "Paused", "UPDATE", f"Paused strategy {cid}")


@router.post("/strategies/{cid}/archive")
def archive(cid: str, user: User = Depends(require("pause_archive_strategy")),
            db: Session = Depends(get_db)):
    c = _get_campaign(db, cid)
    if c.status == "Live":
        raise HTTPException(409, "Pause a live strategy before archiving it.")
    return _transition(db, c, user, "Archived", "UPDATE", f"Archived strategy {cid}")


@router.delete("/strategies/{cid}")
def delete_strategy(cid: str, user: User = Depends(require("create_strategy")), db: Session = Depends(get_db)):
    c = _get_campaign(db, cid)
    if c.status == "Live":
        raise HTTPException(409, "Pause a live strategy before deleting it.")
    if _has_decisions(db, cid):
        raise HTTPException(409, f"{cid} has decided customers. Its decisions and outcomes are the evidence "
                                 f"for every result shown, so it is archived rather than deleted.")
    label = {"Draft": "draft", "In review": "strategy in review", "Approved": "approved strategy"}.get(
        c.status, f"{c.status.lower()} strategy")
    db.delete(c)
    audit(db, user.user_id, "DELETE", "strategy", cid, f"Deleted {label} {cid} {c.name}")
    db.commit()
    return {"deleted": cid}


@router.post("/strategies/{cid}/clone")
def clone(cid: str, user: User = Depends(require("create_strategy")), db: Session = Depends(get_db)):
    src = _get_campaign(db, cid)
    c = _copy(db, src, user, name=f"{src.name} (copy)", source="clone", steps_completed=5)
    audit(db, user.user_id, "CREATE", "strategy", c.campaign_id, f"Cloned {cid} into {c.campaign_id}")
    db.commit()
    return _strategy_out(db, c, stats=False)


@router.post("/strategies/{cid}/revise")
def revise(cid: str, user: User = Depends(require("edit_strategy")), db: Session = Depends(get_db)):
    """Change a strategy that has already run. The running version is never
    edited in place: what was approved is what keeps running until the new
    version is approved and launched, which archives the old one."""
    src = _get_campaign(db, cid)
    if src.status not in ("Live", "Paused") or not _has_decisions(db, cid):
        raise HTTPException(409, f"{cid} has no live history - edit it directly.")
    c, created = _make_revision(db, src, user)
    db.commit()
    out = _strategy_out(db, c, stats=False)
    out["created"] = created
    return out


@router.post("/strategies/{cid}/waves")
def run_wave(cid: str, count: int = Query(1, ge=1, le=10), user: User = Depends(require("launch_strategy")),
             db: Session = Depends(get_db)):
    c = _get_campaign(db, cid)
    if c.status != "Live":
        raise HTTPException(409, "Waves only run on a live strategy.")
    auto = cfg(db, "auto_handoff") == "true"
    waves: list[dict] = []
    handoffs: list[dict] = []
    message = None
    # Customers a full wave needs: its treated quota plus the control share.
    needed = math.ceil(c.wave_size / max(0.05, 1 - c.control_pct))
    with engine.ENGINE_LOCK:
        for _ in range(count):
            if auto and len(engine.undecided_pool(db, c)) < needed:
                # Too few left for a full wave: pull the next cohort handoff first,
                # rather than running a wave on a handful of leftovers.
                handoffs.append(playbook.ingest_handoff(db, actor=user.user_id, trigger="auto"))
            out = engine.run_wave(db, c, actor=user.user_id, realise=True)
            if out["decided"] == 0:
                message = ("No customers in the latest handoff match this strategy's rules."
                           if handoffs else
                           "Everyone this strategy targets has already been decided. Receive the next cohort "
                           "handoff, or turn on automatic handoffs in Platform Configuration.")
                break
            audit(db, user.user_id, "UPDATE", "strategy", cid,
                  f"Ran wave {out['wave']} for {cid}: {out['decided']} decided", out)
            db.commit()
            waves.append(out)
        compliance.scan(db)
    keys = ("decided", "treatment", "control", "held_for_review", "blocked_by_guard", "delivered", "failed",
            "learned")
    total = {k: sum(w[k] for w in waves) for k in keys}
    by_treatment: dict[str, int] = {}
    for w in waves:
        for code, n in w["by_treatment"].items():
            by_treatment[code] = by_treatment.get(code, 0) + n
    return {**total, "by_treatment": by_treatment, "first_wave": waves[0]["wave"] if waves else None,
            "wave": waves[-1]["wave"] if waves else None, "waves_run": len(waves),
            "waves": waves, "handoffs": handoffs, "message": message,
            "pool_remaining": len(engine.undecided_pool(db, c))}


def build_recommendations(db: Session, cohorts: set[str], family: set[str]) -> dict:
    """Guided-build assistance for the cohorts on the form, computed from live
    results. `family` is the strategy being edited and the versions it replaces,
    so a revision is not pointed at itself."""
    mine = cohorts
    out = []
    best = None
    for other in db.query(Campaign).filter(Campaign.campaign_id.notin_(family or {""}),
                                           Campaign.status.in_(["Live", "Paused"])):
        if mine and mine & set(jl(other.target_cohorts)):
            s = analytics.campaign_stats(db, other)
            if s["uplift"] is not None and (best is None or s["uplift"] > best[1]["uplift"]):
                best = (other, s)
    if best:
        o, s = best
        out.append({"kind": "clone", "title": "Segment match found",
                    "body": f"{o.campaign_id} {o.name} targets the same cohort with "
                            f"{s['recovery_rate']:.0%} recovery and {s['uplift'] * 100:+.1f} pp over its "
                            f"control ({'significant' if s['significant'] else 'not yet significant'}, "
                            f"{s['treated']} vs {s['control']} customers). Clone it as a starting point?",
                    "campaign_id": o.campaign_id})
    # Which balance band has paid best in these cohorts so far?
    rows = (db.query(Decision, Outcome).join(Outcome, Outcome.decision_id == Decision.decision_id)
            .filter(Decision.group == "Treatment").all())
    bands = defaultdict(lambda: [0, 0])
    for d, o in rows:
        snap = json.loads(d.snapshot)
        if mine and snap.get("cohort_id") not in mine:
            continue
        b = snap.get("balance", 0)
        key = "under $2k" if b < 2000 else "$2k-$5k" if b < 5000 else "$5k-$10k" if b < 10000 else "$10k+"
        bands[key][0] += o.paid
        bands[key][1] += 1
    ranked = sorted(((k, v[0] / v[1], v[1]) for k, v in bands.items() if v[1] >= 15), key=lambda x: -x[1])
    if ranked:
        k, r, n = ranked[0]
        out.append({"kind": "balance", "title": "Best-responding balance band",
                    "body": f"Treated customers with balances {k} paid at {r:.0%} ({n} decisions). "
                            f"Raw rates include self-cure, so treat this as a hint, not a target."})
    library = [{"campaign_id": o.campaign_id, "name": o.name,
                "rate": analytics.campaign_stats(db, o)["recovery_rate"]}
               for o in db.query(Campaign).filter(Campaign.status.in_(["Live", "Paused"])).limit(4)]
    return {"recommendations": out, "library": library}


@router.get("/strategies/{cid}/recommendations")
def recommendations(cid: str, user: User = Depends(require("create_strategy")),
                    db: Session = Depends(get_db)):
    """Recommendations for a saved strategy's own cohorts."""
    c = _get_campaign(db, cid)
    return build_recommendations(db, set(jl(c.target_cohorts)), set(engine.lineage(db, c)))


class DraftIn(BaseModel):
    brief: str = Field(min_length=10)
    risk: str = "Medium"
    goal: str = "Payment plan"


@router.get("/ai/presets")
def presets(user: User = Depends(require("create_strategy"))):
    return {"presets": insights.PRESETS, "goals": list(insights.GOAL_ARMS),
            "risks": list(insights.RISK_TO_COHORT)}


@router.post("/strategies/ai-draft")
def ai_draft(body: DraftIn, user: User = Depends(require("create_strategy")), db: Session = Depends(get_db)):
    fields, why = insights.draft_from_brief(db, body.brief, body.risk, body.goal)
    cid = _next_campaign_id(db)
    ts = now()
    c = Campaign(campaign_id=cid, owner_id=user.user_id, created_by=user.user_id, status="Draft",
                 source="ai_draft", steps_completed=5, created_at=ts, updated_at=ts,
                 seed=int(cid.split("-")[1]) * 7 + 3,
                 **{k: (json.dumps(v) if isinstance(v, list) else v) for k, v in fields.items()})
    db.add(c)
    audit(db, user.user_id, "CREATE", "strategy", cid, f"AI-drafted {cid} from a brief", {"brief": body.brief})
    db.commit()
    out = _strategy_out(db, c, stats=False)
    out["rationale"] = why
    out["population"] = engine.population_breakdown(db, c)
    return out
