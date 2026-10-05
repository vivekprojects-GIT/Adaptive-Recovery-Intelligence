"""ARI Console API. Every route names the permission it requires; the check
is in rbac.require, so the UI hiding a button is never the only guard."""
from __future__ import annotations

import csv
import io
import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import String, cast, func
from sqlalchemy.orm import Session

from .. import models
from ..db import get_db
from ..scoring import KINDS, SEGMENT_ACTION, check_rules, eligibility, fit_reasons, nudge_explanation
from . import analytics, compliance, engine, insights, mcp_server, playbook
from .engine import arrears, jl
from .models import (
    AlertRule, AuditEvent, Campaign, ComplianceViolation, ContactRecord, Decision, EngagementEvent,
    Handoff, Insight, Nudge, Outcome, PlatformConfig, RolePermission, TreatmentMeta, User,
)
from .platform import CONFIG_DEFAULTS, METRICS, STARTED_AT, audit, cfg, now
from .rbac import LOCKED, PERMISSIONS, ROLES, current_user, granted, require

UTC = timezone.utc
router = APIRouter(prefix="/console", tags=["console"])

MATERIAL = {"target_cohorts", "include_segments", "risk_bands", "min_dpd", "max_dpd", "min_balance",
            "max_balance", "treatment_codes", "control_pct", "escalate_to", "escalate_after_days"}

# What a copy (clone or revision) carries over from its source.
COPY_FIELDS = ("description", "target_cohorts", "include_segments", "risk_bands", "min_balance", "max_balance",
               "min_dpd", "max_dpd", "treatment_codes", "cadence_days", "max_touches", "tone",
               "send_window_start", "send_window_end", "escalate_after_days", "escalate_to", "control_pct",
               "wave_size", "evaluation_days", "recovery_target")


SERVICE_ACTORS = {"nova-agent": "Nova agent (MCP)", "system": "System"}


def _user_names(db: Session) -> dict[str, str]:
    return {**SERVICE_ACTORS, **{u.user_id: u.name for u in db.query(User)}}


def _treatments(db: Session) -> dict[str, models.Strategy]:
    return {s.code: s for s in db.query(models.Strategy)}


def _ordered_treatments(db: Session) -> list[models.Strategy]:
    """S1, S2 ... S10 - numeric order, not string order."""
    return sorted(db.query(models.Strategy), key=lambda s: (len(s.code), s.code))


def _has_decisions(db: Session, cid: str) -> bool:
    return db.query(Decision.decision_id).filter(Decision.campaign_id == cid).first() is not None


def _open_revision(db: Session, cid: str) -> Campaign | None:
    """A draft version of this strategy that has not gone live yet."""
    return (db.query(Campaign).filter(Campaign.parent_id == cid,
                                      Campaign.status.in_(["Draft", "In review", "Approved"]))
            .order_by(Campaign.created_at.desc()).first())


# =========================================================================== session
@router.get("/users/public")
def users_public(db: Session = Depends(get_db)):
    """Persona switcher. In production this is the SSO login, not a list."""
    return [{"user_id": u.user_id, "name": u.name, "role": u.role, "role_label": ROLES[u.role],
             "status": u.status} for u in db.query(User).order_by(User.role, User.name)]


@router.get("/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    perms = sorted(granted(db, user.role))
    user.last_login = now()
    db.commit()
    mine = db.query(Campaign).filter(Campaign.owner_id == user.user_id)
    return {
        "user": {"user_id": user.user_id, "name": user.name, "email": user.email, "role": user.role,
                 "role_label": ROLES[user.role]},
        "permissions": perms,
        "badges": {
            "live_campaigns": mine.filter(Campaign.status == "Live").count(),
            "open_violations": db.query(ComplianceViolation).filter(
                ComplianceViolation.status != "Resolved",
                ComplianceViolation.severity.in_(["Critical", "High"])).count(),
            "pending_review": db.query(Decision).filter(Decision.review_status == "pending").count(),
            "awaiting_approval": db.query(Campaign).filter(Campaign.status == "In review").count(),
            "new_insights": db.query(Insight).filter(Insight.to_user == user.user_id,
                                                     Insight.status == "New").count(),
        },
        "agent": {"decisions_total": db.query(func.count(Decision.decision_id)).scalar(),
                  "shadow_mode": cfg(db, "shadow_mode") == "true",
                  "model_version": cfg(db, "model_version")},
    }


@router.get("/status")
def platform_status(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The header status menu: each part of the platform, its state and when it
    last did something. Read by every signed-in user, so nothing sensitive."""
    shadow = cfg(db, "shadow_mode") == "true"
    m = METRICS.snapshot()
    scanned = db.get(PlatformConfig, "_compliance_scanned_until")
    components = [
        {"name": "Decision service", "status": "Operational" if m["error_rate"] < 0.01 else "Degraded",
         "detail": "Last decision", "at": db.query(func.max(Decision.decided_at))
            .filter(Decision.decided_at <= now()).scalar()},
        {"name": "Customer channels", "status": "Simulated" if shadow else "Operational",
         "detail": "Messages are simulated" if shadow else "Messages go to customers", "at": None},
        {"name": "Collections handoff", "status": "Operational", "detail": "Last handoff",
         "at": db.query(func.max(Handoff.at)).scalar()},
        {"name": "Compliance monitor", "status": "Operational", "detail": "Last scan",
         "at": scanned.value if scanned else None},
    ]
    degraded = any(c["status"] == "Degraded" for c in components)
    return {"overall": "Degraded" if degraded else "Operational", "mode": "shadow" if shadow else "live",
            "model_version": cfg(db, "model_version"), "components": components}


# =========================================================================== strategies
class StrategyIn(BaseModel):
    name: str = Field(min_length=3, max_length=100)
    description: str = ""
    target_cohorts: list[str] = []
    include_segments: list[str] = ["Persuadable"]
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


def _strategy_out(db: Session, c: Campaign, stats: bool = True) -> dict:
    names = _user_names(db)
    t = _treatments(db)
    status = {m.code: m.status for m in db.query(TreatmentMeta)}
    out = {k: getattr(c, k) for k in (
        "campaign_id", "name", "description", "status", "version", "source", "steps_completed",
        "min_balance", "max_balance", "min_dpd", "max_dpd", "cadence_days", "max_touches", "tone",
        "send_window_start", "send_window_end", "escalate_after_days", "escalate_to", "control_pct",
        "wave_size", "evaluation_days", "recovery_target", "created_at", "updated_at", "submitted_at",
        "approved_at", "launched_at", "waves_run", "owner_id", "created_by", "approved_by", "parent_id")}
    has_history = _has_decisions(db, c.campaign_id)
    revision = _open_revision(db, c.campaign_id) if c.status in ("Live", "Paused") else None
    out.update(target_cohorts=jl(c.target_cohorts), include_segments=jl(c.include_segments),
               risk_bands=jl(c.risk_bands), treatment_codes=jl(c.treatment_codes),
               owner=names.get(c.owner_id), approver=names.get(c.approved_by),
               channels=sorted({t[x].channel for x in jl(c.treatment_codes) if x in t}),
               treatments=[{"code": x, "name": t[x].name, "channel": t[x].channel,
                            "status": status.get(x, "Active")}
                           for x in jl(c.treatment_codes) if x in t],
               has_history=has_history,
               # What the console may offer for this strategy. The routes enforce the same rules.
               editable=c.status in ("Draft", "In review", "Approved")
                        or (c.status == "Paused" and not has_history),
               revisable=c.status in ("Live", "Paused") and has_history,
               deletable=c.status != "Live" and not has_history,
               open_revision=revision.campaign_id if revision else None)
    if stats:
        out["stats"] = analytics.campaign_stats(db, c)
        out["pool_remaining"] = (len(engine.undecided_pool(db, c)) if c.status in ("Live", "Paused")
                                 else None)
    return out


def _get_campaign(db: Session, cid: str) -> Campaign:
    c = db.get(Campaign, cid)
    if not c:
        raise HTTPException(404, f"Strategy {cid} not found.")
    return c


def _next_campaign_id(db: Session) -> str:
    ids = [int(c.campaign_id.split("-")[1]) for c in db.query(Campaign)]
    return f"STR-{max(ids + [0]) + 1:03d}"


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
def estimate(cohorts: str = "", segments: str = "Persuadable", risk_bands: str = "",
             min_balance: float | None = None, max_balance: float | None = None,
             min_dpd: int | None = None, max_dpd: int | None = None, treatments: str = "",
             user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    """Live count for the guided builder: how many customers this definition reaches."""
    tmp = Campaign(campaign_id="STR-TMP", target_cohorts=json.dumps([x for x in cohorts.split(",") if x]),
                   include_segments=json.dumps([x for x in segments.split(",") if x]),
                   risk_bands=json.dumps([x for x in risk_bands.split(",") if x]),
                   min_balance=min_balance, max_balance=max_balance, min_dpd=min_dpd, max_dpd=max_dpd,
                   treatment_codes=json.dumps([x for x in treatments.split(",") if x] or ["S1"]),
                   control_pct=0.2)
    return engine.population_breakdown(db, tmp)


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
    # Per arm: raw rate and the reweighted (inverse-propensity) rate.
    arms = []
    rows = analytics._rows(db, [cid])
    c_rate = out["stats"]["control_rate"]
    t = _treatments(db)
    for code in jl(c.treatment_codes):
        if code not in t:
            continue
        arm = [(d, o) for d, o in rows if d.treatment_code == code and d.group == "Treatment"
               and o is not None and o.reward is not None]
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
    body = StrategyIn(**{k: (jl(getattr(c, k)) if k in ("target_cohorts", "include_segments", "risk_bands",
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


def _copy(db: Session, src: Campaign, user: User, **fields) -> Campaign:
    new_id = _next_campaign_id(db)
    ts = now()
    c = Campaign(**{k: getattr(src, k) for k in COPY_FIELDS}, campaign_id=new_id, owner_id=user.user_id,
                 created_by=user.user_id, status="Draft", created_at=ts, updated_at=ts,
                 seed=int(new_id.split("-")[1]) * 7 + 3, **fields)
    db.add(c)
    return c


@router.post("/strategies/{cid}/clone")
def clone(cid: str, user: User = Depends(require("create_strategy")), db: Session = Depends(get_db)):
    src = _get_campaign(db, cid)
    c = _copy(db, src, user, name=f"{src.name} (copy)", source="clone", steps_completed=5)
    audit(db, user.user_id, "CREATE", "strategy", c.campaign_id, f"Cloned {cid} into {c.campaign_id}")
    db.commit()
    return _strategy_out(db, c, stats=False)


def _make_revision(db: Session, src: Campaign, user: User) -> tuple[Campaign, bool]:
    """The draft that will replace a running strategy. Reused if one is open,
    so a strategy never has two competing next versions."""
    existing = _open_revision(db, src.campaign_id)
    if existing:
        return existing, False
    c = _copy(db, src, user, name=src.name, source="revision", steps_completed=6,
              version=src.version + 1, parent_id=src.campaign_id)
    audit(db, user.user_id, "CREATE", "strategy", c.campaign_id,
          f"Opened {c.campaign_id} as v{c.version} of {src.campaign_id} {src.name}")
    return c, True


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


@router.get("/strategies/{cid}/recommendations")
def recommendations(cid: str, user: User = Depends(require("create_strategy")),
                    db: Session = Depends(get_db)):
    """Guided-build assistance, computed from live results."""
    c = _get_campaign(db, cid)
    mine = set(jl(c.target_cohorts))
    out = []
    best = None
    family = set(engine.lineage(db, c))  # a revision is not pointed at the version it replaces
    for other in db.query(Campaign).filter(Campaign.campaign_id.notin_(family),
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


# =========================================================================== treatment playbook
@router.get("/treatments")
def treatments(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    return playbook.list_treatments(db)


KIND_HELP = {
    "Reminder": "A prompt to pay. Suits customers who respond to SMS; weak once arrears are severe.",
    "Digital nudge": "An in-app prompt. Suits active app users and costs almost nothing.",
    "Arrangement": "Spreads the arrears into instalments. Suits temporary hardship and maxed-out cards.",
    "Deferral": "Moves the due date. Suits a short-term cash-flow gap.",
    "Outreach": "A person makes contact. Suits customers who ignore digital channels.",
    "Hardship": "An affordability review. Suits severe, ongoing hardship.",
}
RULE_SCHEMA = [
    {"key": "requires_app_user", "label": "Active mobile-app users only", "type": "bool"},
    {"key": "requires_sms_responsive", "label": "Responds to SMS", "type": "bool"},
    {"key": "requires_hardship_flag", "label": "Hardship flag on file", "type": "bool"},
    {"key": "min_balance", "label": "Minimum balance", "type": "money"},
    {"key": "max_missed_payments", "label": "Most missed payments in 12 months", "type": "int"},
    {"key": "min_tenure_years", "label": "Minimum tenure (years)", "type": "number"},
    {"key": "min_payment_history", "label": "Minimum on-time payment history", "type": "percent"},
    {"key": "min_dpd", "label": "Minimum days past due", "type": "int"},
    {"key": "max_dpd", "label": "Maximum days past due", "type": "int"},
]


@router.get("/treatments/schema")
def treatment_schema(user: User = Depends(require("view_kpi_dashboard"))):
    return {"kinds": [{"kind": k, "help": KIND_HELP[k]} for k in KINDS], "channels": playbook.CHANNELS,
            "rules": RULE_SCHEMA}


class RulesIn(BaseModel):
    rules: dict = {}


@router.post("/treatments/preview")
def treatment_preview(body: RulesIn, user: User = Depends(require("view_kpi_dashboard")),
                      db: Session = Depends(get_db)):
    """Who a rule set would reach, before it is saved."""
    try:
        rules = playbook._clean_rules(body.rules)
    except (playbook.PlaybookError, TypeError, ValueError) as e:
        raise HTTPException(400, str(e) or "Invalid rule value.")
    from ..scoring import describe_rules
    by_cohort: dict[str, dict] = {}
    total = eligible = persuadable = 0
    reasons: Counter = Counter()
    for c in db.query(models.Customer):
        total += 1
        ok, why = check_rules(rules, c)
        row = by_cohort.setdefault(c.cohort_id, {"cohort_id": c.cohort_id, "customers": 0, "eligible": 0,
                                                 "persuadable": 0})
        row["customers"] += 1
        if ok:
            eligible += 1
            row["eligible"] += 1
            if c.segment == "Persuadable":
                persuadable += 1
                row["persuadable"] += 1
        else:
            reasons[why] += 1
    return {"rule": describe_rules(rules), "customers": total, "eligible": eligible, "persuadable": persuadable,
            "by_cohort": sorted(by_cohort.values(), key=lambda r: r["cohort_id"]),
            "excluded_by": [{"reason": r, "count": n} for r, n in reasons.most_common(4)]}


class TreatmentIn(BaseModel):
    name: str = Field(min_length=3, max_length=80)
    kind: str
    channel: str = Field(min_length=2, max_length=60)
    offer: str = Field(min_length=3, max_length=400)
    timing: str = Field("Day 1", max_length=60)
    cost: float = Field(0.0, ge=0, le=500)
    human_review: bool = False
    rules: dict = {}


def _playbook_call(fn, *args, status: int = 400):
    try:
        return fn(*args)
    except playbook.PlaybookError as e:
        raise HTTPException(status, str(e))
    except (TypeError, ValueError):
        raise HTTPException(400, "A rule has an invalid value.")


@router.post("/treatments")
def create_treatment(body: TreatmentIn, user: User = Depends(require("manage_treatments")),
                     db: Session = Depends(get_db)):
    return _playbook_call(playbook.create, db, body.model_dump(), user.user_id)


@router.put("/treatments/{code}")
def update_treatment(code: str, body: TreatmentIn, user: User = Depends(require("manage_treatments")),
                     db: Session = Depends(get_db)):
    return _playbook_call(playbook.update, db, code, body.model_dump(), user.user_id)


@router.post("/treatments/{code}/retire")
def retire_treatment(code: str, user: User = Depends(require("manage_treatments")), db: Session = Depends(get_db)):
    return _playbook_call(playbook.set_status, db, code, "Retired", user.user_id, status=409)


@router.post("/treatments/{code}/activate")
def activate_treatment(code: str, user: User = Depends(require("manage_treatments")),
                       db: Session = Depends(get_db)):
    return _playbook_call(playbook.set_status, db, code, "Active", user.user_id, status=409)


@router.delete("/treatments/{code}")
def delete_treatment(code: str, user: User = Depends(require("manage_treatments")), db: Session = Depends(get_db)):
    return _playbook_call(playbook.delete, db, code, user.user_id, status=409)


# =========================================================================== cohort handoffs
@router.get("/handoffs")
def list_handoffs(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    return {"handoffs": playbook.handoffs(db), "auto": cfg(db, "auto_handoff") == "true",
            "next_sizes": playbook.HANDOFF_SIZES}


@router.post("/handoffs")
def receive_handoff(user: User = Depends(require("launch_strategy")), db: Session = Depends(get_db)):
    with engine.ENGINE_LOCK:
        return playbook.ingest_handoff(db, actor=user.user_id, trigger="manual")


@router.get("/cohorts")
def cohorts(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    out = []
    for co in db.query(models.Cohort).order_by(models.Cohort.sort_order):
        cs = db.query(models.Customer).filter(models.Customer.cohort_id == co.cohort_id).all()
        seg = Counter(c.segment for c in cs)
        out.append({"cohort_id": co.cohort_id, "name": co.name, "dpd_bucket": co.dpd_bucket,
                    "risk_band": co.client_risk_band, "expected_payment": co.expected_payment,
                    "description": co.description, "customers": len(cs),
                    "balance": round(sum(c.balance for c in cs), 2),
                    "segments": dict(seg), "segment_action": SEGMENT_ACTION})
    return out


# =========================================================================== dashboards
@router.get("/dashboard/strategist")
def strategist_dashboard(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    mine = db.query(Campaign).filter(Campaign.owner_id == user.user_id).all()
    ids = [c.campaign_id for c in mine]
    stats = analytics.stats_from_rows(db, analytics._rows(db, ids),
                                      db.query(Nudge).filter(Nudge.campaign_id.in_(ids)).all())
    today = (datetime.now(UTC) - timedelta(days=1)).isoformat(timespec="seconds")
    draft = next((c for c in sorted(mine, key=lambda c: c.updated_at, reverse=True)
                  if c.status == "Draft"), None)
    return {
        "kpis": {"strategies": len(mine), "live": sum(c.status == "Live" for c in mine),
                 "accounts": stats["decisions"], "recovery_rate": stats["recovery_rate"],
                 "uplift": stats["uplift"], "control_rate": stats["control_rate"],
                 "decisions_24h": db.query(Decision).filter(Decision.campaign_id.in_(ids),
                                                            Decision.decided_at >= today).count(),
                 "pending_review": db.query(Decision).filter(Decision.campaign_id.in_(ids),
                                                             Decision.review_status == "pending").count()},
        "draft": _strategy_out(db, draft, stats=False) if draft else None,
        "strategies": [_strategy_out(db, c) for c in sorted(mine, key=lambda c: c.status != "Live")],
        "insights": _insights_for(db, user),
        "weekly": analytics.weekly(db, ids),
    }


@router.get("/kpis")
def kpi_dashboard(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    return {"kpis": analytics.kpis(db), "weekly": analytics.weekly(db),
            "segments": analytics.segment_performance(db), "leaderboard": analytics.leaderboard(db),
            "alerts": fired_alerts(db)}


@router.get("/portfolio-health")
def portfolio_health(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    states = analytics.customer_state(db)
    by_cohort = defaultdict(Counter)
    customers = {c.customer_id: c for c in db.query(models.Customer)}
    for cid, s in states.items():
        by_cohort[customers[cid].cohort_id][s["status"]] += 1
    cohorts_out = []
    for co in db.query(models.Cohort).order_by(models.Cohort.sort_order):
        members = [c for c in customers.values() if c.cohort_id == co.cohort_id]
        ids = [c.customer_id for c in members]
        rows = [(d, o) for d, o in analytics._rows(db) if d.customer_id in set(ids)]
        s = analytics.stats_from_rows(db, rows)
        cohorts_out.append({"cohort_id": co.cohort_id, "name": co.name, "dpd_bucket": co.dpd_bucket,
                            "risk_band": co.client_risk_band, "customers": len(members),
                            "in_strategy": len({d.customer_id for d, _ in rows}),
                            "arrears": round(sum(arrears(c) for c in members), 2),
                            "segments": dict(Counter(c.segment for c in members)),
                            "states": dict(by_cohort[co.cohort_id]), **{k: s[k] for k in (
                                "recovery_rate", "control_rate", "uplift", "recovered")}})
    return {"cohorts": cohorts_out, "pipeline": dict(Counter(s["status"] for s in states.values())),
            "not_in_strategy": len(customers) - len(states), "customers": len(customers)}


@router.get("/compare")
def compare(ids: str, user: User = Depends(require("compare_strategies")), db: Session = Depends(get_db)):
    chosen = [x for x in ids.split(",") if x][:3]
    out = []
    for cid in chosen:
        c = _get_campaign(db, cid)
        out.append({**_strategy_out(db, c), "weekly": analytics.weekly(db, [cid])})
    return {"strategies": out}


@router.get("/team")
def team(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    return {"team": analytics.team(db)}


# =========================================================================== customers
@router.get("/customers")
def customers(view: str = "all", q: str = "", cohort: str = "", page: int = 1, page_size: int = 25,
              user: User = Depends(require("view_customer_list")), db: Session = Depends(get_db)):
    query = db.query(models.Customer)
    if cohort:
        query = query.filter(models.Customer.cohort_id == cohort)
    if q:
        like = f"%{q}%"
        query = query.filter((models.Customer.name.like(like)) |
                             (cast(models.Customer.customer_id, String).like(like)))
    all_rows = query.all()
    states = analytics.customer_state(db, [c.customer_id for c in all_rows])
    t = _treatments(db)
    camps = {c.campaign_id: c.name for c in db.query(Campaign)}
    rows = []
    for c in all_rows:
        s = states.get(c.customer_id)
        rows.append({"customer_id": c.customer_id, "name": c.name, "cohort_id": c.cohort_id,
                     "balance": c.balance, "arrears": arrears(c), "days_past_due": c.days_past_due,
                     "risk_score": c.client_risk_score, "risk_band": c.client_risk_band,
                     "segment": c.segment, "status": s["status"] if s else "Not in a strategy",
                     "progress": s["progress"] if s else 0,
                     "strategy": camps.get(s["campaign_id"]) if s else None,
                     "campaign_id": s["campaign_id"] if s else None,
                     "treatment": t[s["treatment_code"]].name if s and s["treatment_code"] else None,
                     "last_contact": s["last_contact"] if s else None})
    filters = {
        "high_risk": lambda r: r["risk_band"] in ("High", "Very high"),
        "unresponsive": lambda r: r["status"] in ("Unresponsive", "Escalated"),
        "resolved": lambda r: r["status"] in ("Resolved", "Accepted"),
        "in_strategy": lambda r: r["campaign_id"] is not None,
        "pending": lambda r: r["status"] == "Pending review",
    }
    counts = {k: sum(1 for r in rows if f(r)) for k, f in filters.items()}
    counts["all"] = len(rows)
    if view in filters:
        rows = [r for r in rows if filters[view](r)]
    rows.sort(key=lambda r: r["last_contact"] or "", reverse=True)
    total = len(rows)
    start = (page - 1) * page_size
    return {"total": total, "page": page, "page_size": page_size, "counts": counts,
            "rows": rows[start:start + page_size]}


@router.get("/customers/{customer_id}/journey")
def customer_journey(customer_id: int, user: User = Depends(require("view_customer_list")),
                     db: Session = Depends(get_db)):
    j = analytics.journey(db, customer_id)
    if not j:
        raise HTTPException(404, "Customer not found.")
    c = db.get(models.Customer, customer_id)
    j["nudge_profile"] = nudge_explanation(c)
    j["eligibility"] = [{"code": s.code, "name": s.name, "eligible": eligibility(s.code, c)[0],
                         "reason": eligibility(s.code, c)[1], "fit_reasons": fit_reasons(s.code, c)}
                        for s in _ordered_treatments(db)]
    return j


class CustomerAction(BaseModel):
    action: str = Field(pattern="^(pause_journey|resume_journey|manual_nudge|skip_next_step)$")
    message: str = ""
    reason: str = ""


@router.post("/customers/{customer_id}/actions")
def customer_action(customer_id: int, body: CustomerAction,
                    user: User = Depends(require("override_decisions")), db: Session = Depends(get_db)):
    c = db.get(models.Customer, customer_id)
    d = (db.query(Decision).filter(Decision.customer_id == customer_id)
         .order_by(Decision.decided_at.desc()).first())
    if not c or not d:
        raise HTTPException(404, "This customer is not in a strategy.")
    if body.action == "manual_nudge":
        if not body.message.strip():
            raise HTTPException(400, "Write the message to send.")
        camp = db.get(Campaign, d.campaign_id)
        import numpy as np
        with engine.ENGINE_LOCK:
            n = engine.execute(db, camp, d, c, datetime.now(UTC), np.random.default_rng(),
                               engine.Seq(db), touch=9, manual_text=body.message, code="S1")
        audit(db, user.user_id, "CREATE", "nudge", n.nudge_id,
              f"Sent manual nudge to customer {customer_id}", {"status": n.status})
        db.commit()
        compliance.scan(db)
        return {"nudge_id": n.nudge_id, "status": n.status, "note": n.failure_reason}
    if not body.reason.strip():
        raise HTTPException(400, "Give a reason - it goes in the audit log.")
    label = {"pause_journey": "Paused journey", "resume_journey": "Resumed journey",
             "skip_next_step": "Skipped next step"}[body.action]
    audit(db, user.user_id, "UPDATE", "journey", str(customer_id),
          f"{label} for customer {customer_id}: {body.reason}")
    db.commit()
    return {"ok": True, "message": f"{label}. Recorded in the audit log."}


# =========================================================================== decisions
def _decision_row(d: Decision, o: Outcome | None, names: dict, camps: dict, t: dict, cust: dict) -> dict:
    return {"decision_id": d.decision_id, "campaign_id": d.campaign_id, "strategy": camps.get(d.campaign_id),
            "customer_id": d.customer_id, "customer": cust.get(d.customer_id), "wave": d.wave,
            "group": d.group, "treatment_code": d.treatment_code,
            "treatment": t[d.treatment_code].name if d.treatment_code in t else None,
            "selection_probability": d.selection_probability, "review_policy": d.review_policy,
            "review_status": d.review_status, "overridden": d.overridden, "decided_at": d.decided_at,
            "origin": d.origin,
            "latency_ms": d.latency_ms,
            "outcome": None if o is None else ("Paid" if o.paid else "Not paid"),
            "amount": o.amount if o else None}


@router.get("/decisions")
def decisions(campaign: str = "", group: str = "", review: str = "", q: str = "", page: int = 1,
              page_size: int = 30, user: User = Depends(require("view_ai_decisions")),
              db: Session = Depends(get_db)):
    query = db.query(Decision, Outcome).outerjoin(Outcome, Outcome.decision_id == Decision.decision_id)
    if campaign:
        query = query.filter(Decision.campaign_id == campaign)
    if group:
        query = query.filter(Decision.group == group)
    if review:
        query = query.filter(Decision.review_status == review)
    if q:
        query = query.filter(Decision.decision_id.like(f"%{q}%") |
                             cast(Decision.customer_id, String).like(f"%{q}%"))
    total = query.count()
    rows = query.order_by(Decision.decided_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    names, t = _user_names(db), _treatments(db)
    camps = {c.campaign_id: c.name for c in db.query(Campaign)}
    cust = {c.customer_id: c.name for c in db.query(models.Customer).filter(
        models.Customer.customer_id.in_([d.customer_id for d, _ in rows]))}
    return {"total": total, "page": page, "page_size": page_size,
            "rows": [_decision_row(d, o, names, camps, t, cust) for d, o in rows]}


@router.get("/decisions/{did}")
def decision_audit(did: str, user: User = Depends(require("view_ai_decisions")), db: Session = Depends(get_db)):
    d = db.get(Decision, did)
    if not d:
        raise HTTPException(404, "Decision not found.")
    c = db.get(models.Customer, d.customer_id)
    camp = db.get(Campaign, d.campaign_id)
    o = db.query(Outcome).filter(Outcome.decision_id == did).first()
    snap = json.loads(d.snapshot)
    ranking = jl(d.ranking)
    t = _treatments(db)
    nudges = db.query(Nudge).filter(Nudge.decision_id == did).order_by(Nudge.scheduled_at).all()
    expl = nudge_explanation(c)
    first = nudges[0] if nudges else None
    first_stages = jl(first.pipeline) if first else []
    guard = next((s for s in first_stages if s["stage"] == "Compliance check"), None)
    eligible = jl(d.eligible_arms)
    from_agent = d.origin == "mcp"
    trace = [
        {"step": "Client risk context", "agent": "Nova, via MCP" if from_agent else "Upstream (client model)",
         "ok": True,
         "detail": f"{snap.get('client_risk_band')} risk · score {snap.get('client_risk_score')} · "
                   f"{snap.get('days_past_due')} DPD. "
                   + (f"Sent by Nova for account {snap.get('account_id')}; ARI asked for the decision in real time."
                      if from_agent else "Supplied by the bank, not computed by ARI.")},
        {"step": "Intervention fit", "agent": "Nudge & self-cure scoring", "ok": True,
         "detail": f"Nudge propensity {snap.get('nudge_score')} · self-cure {snap.get('self_cure_score')} "
                   f"→ {snap.get('segment')}"},
        {"step": "Eligibility", "agent": "Business rules", "ok": bool(eligible),
         "detail": f"{len(eligible)} of {len(jl(camp.treatment_codes))} strategy treatments eligible: "
                   + ", ".join(t[x].name for x in eligible)},
        {"step": "Control split", "agent": "Randomiser", "ok": True,
         "detail": ("Assigned to the randomised control group (business as usual)."
                    if d.group == "Control" else
                    f"Treatment group (control share {camp.control_pct:.0%}).")},
    ]
    if d.group == "Treatment":
        top = ranking[0] if ranking else {}
        trace.append({"step": "Treatment selection", "agent": "Contextual Thompson sampling", "ok": True,
                      "detail": d.explanation})
        trace.append({"step": "Review policy", "agent": "Governance",
                      "ok": d.review_status != "rejected",
                      "detail": ("Communication treatment - executes automatically."
                                 if d.review_policy == "auto" else
                                 f"Forbearance treatment - human review: {d.review_status}"
                                 + (f" by {_user_names(db).get(d.reviewed_by, d.reviewed_by)}"
                                    if d.reviewed_by else ""))})
        if guard:
            trace.append({"step": "Compliance guard", "agent": "Contact policy", "ok": guard["ok"],
                          "detail": guard["detail"]})
        if first:
            trace.append({"step": "Execution", "agent": "Channel gateway",
                          "ok": first.status not in ("Failed", "Held"),
                          "detail": f"{first.nudge_id} via {first.channel}: {first.status}"
                                    + (f" ({first.failure_reason})" if first.failure_reason else "")})
    trace.append({"step": "Outcome", "agent": "Learning loop", "ok": True,
                  "detail": (("Awaiting Nova's payment report." if from_agent else "Awaiting the evaluation window.")
                             if o is None else
                             (f"Paid ${o.amount:,.2f} after {o.days_to_pay} days." if o.paid else
                              f"No payment in {o.window_days} days.")
                             + ("" if o is None else
                                (" Learned from (reward {:.0f}).".format(o.reward) if o.learned else
                                 (" Comparison only - control outcomes are not learned from."
                                  if d.group == "Control" else " Not learned from - treatment not delivered."))))})
    return {
        "decision": _decision_row(d, o, _user_names(db), {camp.campaign_id: camp.name}, t,
                                  {c.customer_id: c.name}),
        "explanation": d.explanation, "exclusion_reason": d.exclusion_reason,
        "override_reason": d.override_reason, "original_treatment": d.original_treatment,
        "snapshot": snap, "ranking": ranking, "trace": trace,
        "factors": expl["contributions"], "self_cure": expl["self_cure_score"],
        "nudges": [{"nudge_id": n.nudge_id, "channel": n.channel, "status": n.status,
                    "scheduled_at": n.scheduled_at, "touch": n.touch_number, "escalation": n.is_escalation}
                   for n in nudges],
        "metadata": {"decision_id": d.decision_id, "timestamp": d.decided_at, "origin": d.origin,
                     "model": cfg(db, "model_version"), "strategy": d.campaign_id,
                     "strategy_version": camp.version, "segment": snap.get("segment"),
                     "risk_band": snap.get("client_risk_band"), "latency_ms": d.latency_ms,
                     "selection_probability": d.selection_probability},
    }


class ReviewDecisionIn(BaseModel):
    approve: bool
    note: str = ""


@router.post("/decisions/{did}/review")
def review_decision(did: str, body: ReviewDecisionIn, user: User = Depends(require("override_decisions")),
                    db: Session = Depends(get_db)):
    d = db.get(Decision, did)
    if not d or d.review_status != "pending":
        raise HTTPException(409, "This decision is not waiting for review.")
    if not body.approve and not body.note.strip():
        raise HTTPException(400, "Give a reason for rejecting the offer.")
    with engine.ENGINE_LOCK:
        out = engine.approve_and_execute(db, d, user.user_id, body.approve)
    audit(db, user.user_id, "APPROVE" if body.approve else "UPDATE", "decision", did,
          f"{'Approved' if body.approve else 'Rejected'} {did} ({d.treatment_code})"
          + (f": {body.note}" if body.note else ""))
    db.commit()
    return out


class OverrideIn(BaseModel):
    treatment_code: str | None
    reason: str = Field(min_length=5)


@router.post("/decisions/{did}/override")
def override_decision(did: str, body: OverrideIn, user: User = Depends(require("override_decisions")),
                      db: Session = Depends(get_db)):
    d = db.get(Decision, did)
    if not d or d.group != "Treatment":
        raise HTTPException(409, "Only a treated decision can be overridden.")
    c = db.get(models.Customer, d.customer_id)
    if body.treatment_code and not eligibility(body.treatment_code, c)[0]:
        raise HTTPException(400, f"{body.treatment_code} is not eligible for this customer: "
                                 f"{eligibility(body.treatment_code, c)[1]}.")
    d.original_treatment = d.original_treatment or d.treatment_code
    d.treatment_code = body.treatment_code
    d.overridden = True
    d.override_reason = body.reason
    # A human choice is not evidence about the bandit's choice: stop learning from it.
    o = db.query(Outcome).filter(Outcome.decision_id == did).first()
    if o:
        o.learned = False
    audit(db, user.user_id, "UPDATE", "decision", did,
          f"Overrode {did}: {d.original_treatment} -> {body.treatment_code or 'no treatment'}",
          {"reason": body.reason})
    db.commit()
    return {"ok": True}


@router.get("/nudges")
def nudges(status: str = "", campaign: str = "", page: int = 1, page_size: int = 30,
           user: User = Depends(require("view_ai_decisions")), db: Session = Depends(get_db)):
    q = db.query(Nudge).filter(Nudge.scheduled_at <= now())
    if status:
        q = q.filter(Nudge.status == status)
    if campaign:
        q = q.filter(Nudge.campaign_id == campaign)
    total = q.count()
    rows = q.order_by(Nudge.scheduled_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    cust = {c.customer_id: c.name for c in db.query(models.Customer).filter(
        models.Customer.customer_id.in_([n.customer_id for n in rows]))}
    counts = dict(db.query(Nudge.status, func.count()).filter(Nudge.scheduled_at <= now())
                  .group_by(Nudge.status).all())
    return {"total": total, "counts": counts, "rows": [
        {"nudge_id": n.nudge_id, "decision_id": n.decision_id, "campaign_id": n.campaign_id,
         "customer_id": n.customer_id, "customer": cust.get(n.customer_id), "channel": n.channel,
         "treatment_code": n.treatment_code, "status": n.status, "touch": n.touch_number,
         "escalation": n.is_escalation, "manual": n.manual, "scheduled_at": n.scheduled_at,
         "sent_at": n.sent_at} for n in rows]}


@router.get("/nudges/{nid}")
def nudge_detail(nid: str, user: User = Depends(require("view_ai_decisions")), db: Session = Depends(get_db)):
    n = db.get(Nudge, nid)
    if not n:
        raise HTTPException(404, "Nudge not found.")
    c = db.get(models.Customer, n.customer_id)
    d = db.get(Decision, n.decision_id)
    events = db.query(EngagementEvent).filter(EngagementEvent.nudge_id == nid).order_by(EngagementEvent.at).all()
    ranking = jl(d.ranking) if d else []
    chosen = next((r for r in ranking if r["code"] == n.treatment_code), None)
    sent = datetime.fromisoformat(n.sent_at) if n.sent_at else None
    first_click = next((e for e in events if e.event == "Clicked"), None)
    violations = db.query(ComplianceViolation).filter(ComplianceViolation.nudge_id == nid).all()
    return {
        "nudge": {"nudge_id": n.nudge_id, "decision_id": n.decision_id, "campaign_id": n.campaign_id,
                  "customer_id": n.customer_id, "customer": c.name, "channel": n.channel,
                  "treatment_code": n.treatment_code, "status": n.status, "touch": n.touch_number,
                  "escalation": n.is_escalation, "manual": n.manual, "scheduled_at": n.scheduled_at,
                  "sent_at": n.sent_at, "failure_reason": n.failure_reason, "content": n.content},
        "pipeline": jl(n.pipeline),
        "reasoning": {
            "summary": (d.explanation if d and n.touch_number == 1 and not n.manual else
                        ("Manual message sent by a strategist." if n.manual else
                         ("Escalation step from the strategy's escalation rule." if n.is_escalation
                          else f"Follow-up touch {n.touch_number} on the strategy's cadence."))),
            "fit_reasons": chosen["fit_reasons"] if chosen else fit_reasons(n.treatment_code, c),
            "ranking": ranking,
        },
        "engagement": {
            "events": [{"event": e.event, "at": e.at} for e in events],
            "opened": any(e.event == "Opened" for e in events),
            "clicked": first_click is not None,
            "form_completed": any(e.event == "FormCompleted" for e in events),
            "time_to_click_min": round((datetime.fromisoformat(first_click.at) - sent).total_seconds() / 60)
            if first_click and sent else None},
        "violations": [{"violation_id": v.violation_id, "rule": v.rule, "severity": v.severity,
                        "status": v.status} for v in violations],
    }


@router.get("/activity")
def activity(limit: int = 60, user: User = Depends(require("view_ai_decisions")), db: Session = Depends(get_db)):
    t = _treatments(db)
    cust = {c.customer_id: c.name for c in db.query(models.Customer)}
    items = []
    for d in db.query(Decision).filter(Decision.decided_at <= now()).order_by(Decision.decided_at.desc()).limit(limit):
        items.append({"at": d.decided_at, "kind": "decision", "id": d.decision_id, "campaign_id": d.campaign_id,
                      "title": (f"{t[d.treatment_code].name} chosen for {cust.get(d.customer_id)}"
                                if d.group == "Treatment" else f"{cust.get(d.customer_id)} held out as control")
                               + (" · asked by Nova" if d.origin == "mcp" else ""),
                      "detail": d.explanation[:140], "status": d.review_status if d.review_policy != "auto" else d.group})
    for n in db.query(Nudge).filter(Nudge.sent_at.isnot(None), Nudge.sent_at <= now()).order_by(Nudge.sent_at.desc()).limit(limit):
        items.append({"at": n.sent_at, "kind": "nudge", "id": n.nudge_id, "campaign_id": n.campaign_id,
                      "title": f"{n.channel} to {cust.get(n.customer_id)}", "detail": n.content[:140],
                      "status": n.status})
    for o in db.query(Outcome).filter(Outcome.paid.is_(True), Outcome.observed_at <= now()).order_by(Outcome.observed_at.desc()).limit(limit // 2):
        items.append({"at": o.observed_at, "kind": "payment", "id": o.decision_id, "campaign_id": o.campaign_id,
                      "title": f"${o.amount:,.2f} received from {cust.get(o.customer_id)}",
                      "detail": f"{o.days_to_pay} days after the decision", "status": "Paid"})
    items.sort(key=lambda i: i["at"], reverse=True)
    return {"items": items[:limit]}


# =========================================================================== compliance
@router.get("/compliance")
def compliance_view(severity: str = "", status: str = "", area: str = "",
                    user: User = Depends(require("view_compliance")), db: Session = Depends(get_db)):
    month = datetime.now(UTC) - timedelta(days=30)
    q = db.query(ComplianceViolation)
    all_v = q.order_by(ComplianceViolation.detected_at.desc()).all()
    rows = [v for v in all_v if (not severity or v.severity == severity) and (not status or v.status == status)
            and (not area or v.policy_area == area)]
    weekly: dict[str, Counter] = defaultdict(Counter)
    for v in all_v:
        d = datetime.fromisoformat(v.detected_at)
        weekly[(d - timedelta(days=d.weekday())).date().isoformat()][v.policy_area] += 1
    open_v = [v for v in all_v if v.status != "Resolved"]
    resolved = [v for v in all_v if v.status == "Resolved" and v.resolved_at]
    res_days = [(datetime.fromisoformat(v.resolved_at) - datetime.fromisoformat(v.detected_at)).total_seconds() / 86400
                for v in resolved]
    scores = compliance.area_scores(db, month)
    return {
        "kpis": {"open": len(open_v), "open_critical": sum(v.severity == "Critical" for v in open_v),
                 "open_high": sum(v.severity == "High" for v in open_v),
                 "month_total": sum(1 for v in all_v if v.detected_at >= month.isoformat()),
                 "score": round(sum(s["score"] for s in scores) / len(scores), 4),
                 "weakest": min(scores, key=lambda s: s["score"])["area"],
                 "avg_resolution_days": round(sum(res_days) / len(res_days), 1) if res_days else None},
        "areas": scores,
        "weekly": [{"week": w, **dict(c), "total": sum(c.values())} for w, c in sorted(weekly.items())],
        "by_strategy": [{"campaign_id": k, "count": n} for k, n in
                        Counter(v.campaign_id or "BAU only" for v in all_v).most_common()],
        "violations": [{k: getattr(v, k) for k in (
            "violation_id", "policy_area", "rule", "severity", "campaign_id", "customer_id", "nudge_id",
            "description", "detected_at", "status", "resolved_by", "resolved_at", "resolution_note")}
            for v in rows],
    }


class ViolationIn(BaseModel):
    status: str = Field(pattern="^(Open|Investigating|Resolved)$")
    note: str = ""


@router.post("/compliance/{vid}")
def update_violation(vid: str, body: ViolationIn, user: User = Depends(require("resolve_violations")),
                     db: Session = Depends(get_db)):
    v = db.get(ComplianceViolation, vid)
    if not v:
        raise HTTPException(404, "Violation not found.")
    if body.status == "Resolved" and not body.note.strip():
        raise HTTPException(400, "A resolution note is required.")
    v.status = body.status
    if body.status == "Resolved":
        v.resolved_by, v.resolved_at, v.resolution_note = user.user_id, now(), body.note
    audit(db, user.user_id, "UPDATE", "violation", vid, f"{vid} -> {body.status}", {"note": body.note})
    db.commit()
    return {"ok": True}


@router.post("/compliance/scan")
def scan_now(user: User = Depends(require("resolve_violations")), db: Session = Depends(get_db)):
    n = compliance.scan(db)
    audit(db, user.user_id, "READ", "compliance", "scan", f"Ran compliance scan: {n} new")
    db.commit()
    return {"new_violations": n}


# =========================================================================== workbench & insights
def _insights_for(db: Session, user: User) -> list[dict]:
    names = _user_names(db)
    q = db.query(Insight)
    q = q.filter(Insight.to_user == user.user_id) if user.role == "strategist" else q
    return [{"insight_id": i.insight_id, "campaign_id": i.campaign_id, "from": names.get(i.from_user),
             "to": names.get(i.to_user), "title": i.title, "body": i.body, "evidence": i.evidence,
             "priority": i.priority, "status": i.status, "change": json.loads(i.proposed_change or "{}"),
             "created_at": i.created_at, "response_note": i.response_note}
            for i in q.order_by(Insight.created_at.desc())]


@router.get("/workbench")
def workbench(user: User = Depends(require("use_ai_workbench")), db: Session = Depends(get_db)):
    return {"areas": insights.problem_areas(db), "sent": _insights_for(db, user)}


@router.get("/workbench/areas/{area_id}")
def area_ideas(area_id: str, user: User = Depends(require("use_ai_workbench")), db: Session = Depends(get_db)):
    area = next((a for a in insights.problem_areas(db) if a["id"] == area_id), None)
    if not area:
        raise HTTPException(404, "That problem area is no longer active.")
    return {"area": area, "ideas": [i | {"area_id": area_id, "campaign_id": area.get("campaign_id")}
                                    for i in insights.ideas_for(db, area)]}


class AskIn(BaseModel):
    text: str = Field(min_length=3)


@router.post("/workbench/ask")
def ask(body: AskIn, user: User = Depends(require("use_ai_workbench")), db: Session = Depends(get_db)):
    return insights.answer(db, body.text)


class SendInsightIn(BaseModel):
    title: str
    body: str
    evidence: str = ""
    priority: str = "Medium"
    campaign_id: str | None = None
    change: dict = {}
    to_user: str | None = None


@router.post("/insights")
def send_insight(body: SendInsightIn, user: User = Depends(require("use_ai_workbench")),
                 db: Session = Depends(get_db)):
    to = body.to_user
    if not to and body.campaign_id:
        c = db.get(Campaign, body.campaign_id)
        to = c.owner_id if c else None
    if not to:
        raise HTTPException(400, "Choose who to send this to.")
    n = db.query(Insight).count() + 1
    i = Insight(insight_id=f"IN-{n:03d}", campaign_id=body.campaign_id, from_user=user.user_id, to_user=to,
                title=body.title, body=body.body, evidence=body.evidence, priority=body.priority,
                proposed_change=json.dumps(body.change), created_at=now())
    db.add(i)
    audit(db, user.user_id, "CREATE", "insight", i.insight_id, f"Sent '{body.title}' to {_user_names(db).get(to)}")
    db.commit()
    return {"insight_id": i.insight_id}


@router.get("/insights")
def my_insights(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _insights_for(db, user)


class RespondIn(BaseModel):
    action: str = Field(pattern="^(accept|review|decline|apply)$")
    note: str = ""


@router.post("/insights/{iid}/respond")
def respond(iid: str, body: RespondIn, user: User = Depends(require("edit_strategy")),
            db: Session = Depends(get_db)):
    i = db.get(Insight, iid)
    if not i or i.to_user != user.user_id:
        raise HTTPException(404, "Insight not found in your inbox.")
    i.responded_at, i.response_note = now(), body.note or None
    result: dict = {"ok": True}
    if body.action == "apply":
        change = json.loads(i.proposed_change or "{}")
        if not change or not i.campaign_id:
            raise HTTPException(400, "This insight has no strategy change to apply.")
        src = _get_campaign(db, i.campaign_id)
        # Applying never edits a running strategy: the change lands on its next
        # version, a draft that goes through approval like anything else.
        if src.status in ("Live", "Paused") and _has_decisions(db, src.campaign_id):
            new, _ = _make_revision(db, src, user)
        else:
            new = _copy(db, src, user, name=f"{src.name} (from {iid})", source="insight", steps_completed=5)
        for k, v in change.items():
            if k in COPY_FIELDS:
                setattr(new, k, json.dumps(v) if isinstance(v, list) else v)
        if new.status != "Draft":
            new.status = "Draft"
            new.approved_by = new.approved_at = new.submitted_at = None
        new.updated_at = now()
        new.description = f"{src.description}\n\nChange from {iid}: {i.title}"
        i.status = "Applied"
        result["campaign_id"] = new.campaign_id
        audit(db, user.user_id, "UPDATE", "insight", iid, f"Applied {iid} as draft {new.campaign_id}")
    else:
        i.status = {"accept": "Accepted", "review": "In review", "decline": "Declined"}[body.action]
        audit(db, user.user_id, "UPDATE", "insight", iid, f"{i.status} insight {iid}")
    db.commit()
    return result


# =========================================================================== reports
REPORTS = {
    "portfolio": ("Portfolio performance", "Recovery, uplift over control, cost and escalation by strategy"),
    "decisions": ("Decision log", "Every decision with its group, treatment, probability and outcome"),
    "compliance": ("Compliance violations", "All detected violations with status and resolution"),
    "audit": ("Audit trail", "Every user and system action"),
    "team": ("Team performance", "Per-strategist results"),
}


@router.get("/reports")
def reports(user: User = Depends(require("export_reports"))):
    return [{"id": k, "name": v[0], "description": v[1]} for k, v in REPORTS.items()]


@router.get("/reports/{rid}.csv")
def export_report(rid: str, user: User = Depends(require("export_reports")), db: Session = Depends(get_db)):
    if rid not in REPORTS:
        raise HTTPException(404, "Unknown report.")
    buf = io.StringIO()
    w = csv.writer(buf)
    if rid == "portfolio":
        w.writerow(["strategy", "name", "owner", "status", "decisions", "treated", "control", "recovery_rate",
                    "control_rate", "uplift", "uplift_ci_low", "uplift_ci_high", "recovered",
                    "cost_per_recovery", "escalation_rate"])
        for c in db.query(Campaign):
            s = analytics.campaign_stats(db, c)
            ci = s["uplift_ci"] or [None, None]
            w.writerow([c.campaign_id, c.name, c.owner_id, c.status, s["decisions"], s["treated"], s["control"],
                        s["recovery_rate"], s["control_rate"], s["uplift"], ci[0], ci[1], s["recovered"],
                        s["cost_per_recovery"], s["escalation_rate"]])
    elif rid == "decisions":
        w.writerow(["decision_id", "strategy", "customer_id", "wave", "group", "treatment",
                    "selection_probability", "review_status", "overridden", "decided_at", "paid", "amount"])
        for d, o in analytics._rows(db):
            w.writerow([d.decision_id, d.campaign_id, d.customer_id, d.wave, d.group, d.treatment_code,
                        d.selection_probability, d.review_status, d.overridden, d.decided_at,
                        None if o is None else o.paid, None if o is None else o.amount])
    elif rid == "compliance":
        w.writerow(["violation_id", "area", "rule", "severity", "strategy", "customer_id", "detected_at",
                    "status", "description"])
        for v in db.query(ComplianceViolation).order_by(ComplianceViolation.detected_at):
            w.writerow([v.violation_id, v.policy_area, v.rule, v.severity, v.campaign_id, v.customer_id,
                        v.detected_at, v.status, v.description])
    elif rid == "audit":
        w.writerow(["at", "actor", "action", "entity", "entity_id", "summary"])
        for a in db.query(AuditEvent).order_by(AuditEvent.at):
            w.writerow([a.at, a.actor, a.action, a.entity, a.entity_id, a.summary])
    elif rid == "team":
        rows = analytics.team(db)
        w.writerow(list(rows[0].keys()) if rows else [])
        for r in rows:
            w.writerow(list(r.values()))
    audit(db, user.user_id, "EXPORT", "report", rid, f"Exported {REPORTS[rid][0].lower()} report")
    db.commit()
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename=ari-{rid}.csv"})


# =========================================================================== alerts
def _metric_values(db: Session) -> list[tuple[str, str | None, float | None]]:
    """(metric, campaign_id, value) for every alertable metric."""
    vals: list[tuple[str, str | None, float | None]] = []
    k = analytics.kpis(db)
    vals.append(("escalation_rate", None, k["escalation_rate"]["value"]))
    vals.append(("recovery_rate", None, k["recovery_rate"]["value"]))
    vals.append(("pending_review", None, float(db.query(Decision).filter(Decision.review_status == "pending").count())))
    vals.append(("critical_violations", None, float(db.query(ComplianceViolation).filter(
        ComplianceViolation.status != "Resolved", ComplianceViolation.severity == "Critical").count())))
    vals.append(("latency_p95_ms", None, METRICS.snapshot()["latency_p95_ms"]))
    for c in db.query(Campaign).filter(Campaign.status == "Live"):
        s = analytics.campaign_stats(db, c)
        if s["treated"] >= 20 and s["recovery_rate"] is not None:
            vals.append(("campaign_rate_vs_target", c.campaign_id, s["recovery_rate"] - c.recovery_target))
        if s["control"] >= 15 and s["uplift"] is not None:
            vals.append(("campaign_uplift", c.campaign_id, s["uplift"]))
    return vals


METRIC_LABELS = {
    "campaign_rate_vs_target": "Strategy recovery rate minus target",
    "campaign_uplift": "Strategy uplift over control",
    "escalation_rate": "Portfolio escalation rate",
    "recovery_rate": "Portfolio recovery rate",
    "critical_violations": "Open critical violations",
    "pending_review": "Decisions waiting for review",
    "latency_p95_ms": "API latency p95 (ms)",
}


def _fmt_metric(metric: str, v: float) -> str:
    if metric in ("campaign_rate_vs_target", "campaign_uplift"):
        return f"{v * 100:+.1f} pp"
    if metric in ("escalation_rate", "recovery_rate"):
        return f"{v * 100:.1f}%"
    if metric == "latency_p95_ms":
        return f"{v:.0f} ms"
    return f"{v:.0f}"


def fired_alerts(db: Session) -> list[dict]:
    vals = _metric_values(db)
    out = []
    for r in db.query(AlertRule).filter(AlertRule.enabled.is_(True)):
        for metric, cid, v in vals:
            if metric != r.metric or v is None:
                continue
            hit = v < r.threshold if r.comparator == "lt" else v > r.threshold
            if hit:
                out.append({"rule_id": r.rule_id, "name": r.name, "severity": r.severity, "campaign_id": cid,
                            "value": round(v, 4), "threshold": r.threshold, "metric": metric,
                            "message": f"{(cid + ': ') if cid else ''}{METRIC_LABELS.get(metric, metric)} "
                                       f"is {_fmt_metric(metric, v)} "
                                       f"({'below' if r.comparator == 'lt' else 'above'} {_fmt_metric(metric, r.threshold)})"})
    order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}
    return sorted(out, key=lambda a: order.get(a["severity"], 9))


@router.get("/alerts")
def alerts(user: User = Depends(require("view_kpi_dashboard")), db: Session = Depends(get_db)):
    return fired_alerts(db)


class AlertIn(BaseModel):
    name: str = Field(min_length=3)
    metric: str
    comparator: str = Field(pattern="^(lt|gt)$")
    threshold: float
    severity: str = Field(pattern="^(Critical|High|Medium|Low)$")
    enabled: bool = True
    notify: str = ""


@router.get("/admin/alerts")
def list_alert_rules(user: User = Depends(require("manage_alert_rules")), db: Session = Depends(get_db)):
    fired = Counter(a["rule_id"] for a in fired_alerts(db))
    return {"rules": [{**{k: getattr(r, k) for k in ("rule_id", "name", "metric", "comparator", "threshold",
                                                    "scope", "severity", "enabled", "notify", "updated_at")},
                       "metric_label": METRIC_LABELS.get(r.metric, r.metric), "firing": fired.get(r.rule_id, 0)}
                      for r in db.query(AlertRule).order_by(AlertRule.rule_id)],
            "metrics": [{"key": k, "label": v} for k, v in METRIC_LABELS.items()]}


@router.post("/admin/alerts")
def create_alert(body: AlertIn, user: User = Depends(require("manage_alert_rules")), db: Session = Depends(get_db)):
    if body.metric not in METRIC_LABELS:
        raise HTTPException(400, "Unknown metric.")
    r = AlertRule(**body.model_dump(), scope="campaign" if body.metric.startswith("campaign") else "portfolio",
                  created_by=user.user_id, updated_at=now())
    db.add(r)
    db.flush()
    audit(db, user.user_id, "CREATE", "alert_rule", str(r.rule_id), f"Created alert rule '{body.name}'")
    db.commit()
    return {"rule_id": r.rule_id}


@router.put("/admin/alerts/{rid}")
def update_alert(rid: int, body: AlertIn, user: User = Depends(require("manage_alert_rules")),
                 db: Session = Depends(get_db)):
    r = db.get(AlertRule, rid)
    if not r:
        raise HTTPException(404, "Rule not found.")
    for k, v in body.model_dump().items():
        setattr(r, k, v)
    r.updated_at = now()
    audit(db, user.user_id, "UPDATE", "alert_rule", str(rid), f"Updated alert rule '{body.name}'")
    db.commit()
    return {"ok": True}


@router.delete("/admin/alerts/{rid}")
def delete_alert(rid: int, user: User = Depends(require("manage_alert_rules")), db: Session = Depends(get_db)):
    r = db.get(AlertRule, rid)
    if not r:
        raise HTTPException(404, "Rule not found.")
    db.delete(r)
    audit(db, user.user_id, "DELETE", "alert_rule", str(rid), f"Deleted alert rule '{r.name}'")
    db.commit()
    return {"ok": True}


# =========================================================================== admin
@router.get("/admin/overview")
def admin_overview(user: User = Depends(require("manage_users")), db: Session = Depends(get_db)):
    users = db.query(User).all()
    owned = Counter(c.owner_id for c in db.query(Campaign))
    names = _user_names(db)
    audits = db.query(AuditEvent).order_by(AuditEvent.at.desc()).limit(8).all()
    return {
        "kpis": {"users": len(users), "active_users": sum(u.status == "Active" for u in users),
                 "live_strategies": db.query(Campaign).filter(Campaign.status == "Live").count(),
                 "strategists": sum(u.role == "strategist" for u in users),
                 "roles": len(ROLES), "permissions": len(PERMISSIONS),
                 "availability": METRICS.snapshot()["availability"]},
        "users": [{"user_id": u.user_id, "name": u.name, "email": u.email, "role": u.role,
                   "role_label": ROLES[u.role], "status": u.status, "strategies": owned.get(u.user_id, 0),
                   "last_login": u.last_login} for u in users],
        "role_distribution": [{"role": r, "label": l, "count": sum(u.role == r for u in users)}
                              for r, l in ROLES.items()],
        "health": system_health(user, db),
        "audit": [{"at": a.at, "actor": names.get(a.actor, a.actor), "action": a.action,
                   "summary": a.summary} for a in audits],
    }


class UserIn(BaseModel):
    name: str = Field(min_length=2)
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    role: str = Field(pattern="^(strategist|leader|admin|viewer)$")


class UserPatch(BaseModel):
    role: str | None = Field(default=None, pattern="^(strategist|leader|admin|viewer)$")
    status: str | None = Field(default=None, pattern="^(Active|Inactive|Pending)$")


@router.get("/admin/users")
def list_users(user: User = Depends(require("manage_users")), db: Session = Depends(get_db)):
    owned = Counter(c.owner_id for c in db.query(Campaign))
    perms = {r: sorted(granted(db, r)) for r in ROLES}
    return {"users": [{"user_id": u.user_id, "name": u.name, "email": u.email, "role": u.role,
                       "role_label": ROLES[u.role], "status": u.status, "last_login": u.last_login,
                       "created_at": u.created_at, "strategies": owned.get(u.user_id, 0)}
                      for u in db.query(User).order_by(User.name)],
            "role_permissions": perms,
            "permissions": [{"key": k, "label": l, "description": d, "category": c} for k, l, d, c in PERMISSIONS]}


@router.post("/admin/users")
def invite_user(body: UserIn, user: User = Depends(require("manage_users")), db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == body.email).first():
        raise HTTPException(409, "A user with that email already exists.")
    uid = "u-" + body.email.split("@")[0].replace(".", "-")[:14]
    db.add(User(user_id=uid, name=body.name, email=body.email, role=body.role, status="Pending",
                created_at=now()))
    audit(db, user.user_id, "CREATE", "user", uid, f"Invited {body.name} as {ROLES[body.role]}")
    db.commit()
    return {"user_id": uid}


@router.patch("/admin/users/{uid}")
def patch_user(uid: str, body: UserPatch, user: User = Depends(require("manage_users")),
               db: Session = Depends(get_db)):
    u = db.get(User, uid)
    if not u:
        raise HTTPException(404, "User not found.")
    if uid == user.user_id and (body.role not in (None, u.role) or body.status not in (None, "Active")):
        raise HTTPException(409, "You cannot change your own role or deactivate yourself.")
    if u.role == "admin" and (body.role not in (None, "admin") or body.status not in (None, "Active")):
        if db.query(User).filter(User.role == "admin", User.status == "Active").count() <= 1:
            raise HTTPException(409, "This is the last active admin. Assign another admin first.")
    changes = []
    if body.role and body.role != u.role:
        changes.append(f"role {ROLES[u.role]} -> {ROLES[body.role]}")
        u.role = body.role
    if body.status and body.status != u.status:
        changes.append(f"status {u.status} -> {body.status}")
        u.status = body.status
    if changes:
        audit(db, user.user_id, "UPDATE", "user", uid, f"Updated {u.name}: {', '.join(changes)}")
    db.commit()
    return {"ok": True}


@router.get("/admin/roles")
def roles(user: User = Depends(require("manage_roles")), db: Session = Depends(get_db)):
    matrix = defaultdict(dict)
    for rp in db.query(RolePermission):
        matrix[rp.role][rp.permission] = rp.granted
    counts = Counter(u.role for u in db.query(User))
    return {"roles": [{"role": r, "label": l, "users": counts.get(r, 0),
                       "granted": sum(1 for v in matrix[r].values() if v)} for r, l in ROLES.items()],
            "permissions": [{"key": k, "label": lab, "description": d, "category": c}
                            for k, lab, d, c in PERMISSIONS],
            "matrix": matrix, "locked": [list(x) for x in LOCKED]}


class RolesIn(BaseModel):
    matrix: dict[str, dict[str, bool]]


@router.put("/admin/roles")
def save_roles(body: RolesIn, user: User = Depends(require("manage_roles")), db: Session = Depends(get_db)):
    changes = []
    for role, perms in body.matrix.items():
        if role not in ROLES:
            continue
        for perm, val in perms.items():
            if (role, perm) in LOCKED and not val:
                raise HTTPException(409, f"{ROLES[role]} must keep '{perm.replace('_', ' ')}' - "
                                         f"otherwise nobody could manage access again.")
            rp = db.get(RolePermission, (role, perm))
            if rp and rp.granted != val:
                rp.granted = val
                changes.append(f"{ROLES[role]}: {'granted' if val else 'revoked'} {perm}")
    if changes:
        audit(db, user.user_id, "UPDATE", "roles", "matrix", f"Changed {len(changes)} permissions",
              {"changes": changes})
    db.commit()
    return {"changed": changes}


@router.get("/admin/config")
def get_config(user: User = Depends(require("configure_platform")), db: Session = Depends(get_db)):
    names = _user_names(db)
    keys = [k for k, *_ in CONFIG_DEFAULTS]
    rows = {r.key: r for r in db.query(PlatformConfig).filter(PlatformConfig.key.in_(keys))}
    return [{"key": k, "value": rows[k].value if k in rows else d, "default": d, "label": lab, "group": g,
             "kind": kind, "help": h, "updated_by": names.get(rows[k].updated_by) if k in rows else None,
             "updated_at": rows[k].updated_at if k in rows else None}
            for k, d, lab, g, kind, h in CONFIG_DEFAULTS]


class ConfigIn(BaseModel):
    values: dict[str, str]


@router.put("/admin/config")
def put_config(body: ConfigIn, user: User = Depends(require("configure_platform")),
               db: Session = Depends(get_db)):
    kinds = {k: kind for k, _d, _l, _g, kind, _h in CONFIG_DEFAULTS}
    changed = []
    for k, v in body.values.items():
        if k not in kinds:
            raise HTTPException(400, f"Unknown setting {k}.")
        try:
            if kinds[k] in ("number", "hour"):
                x = float(v)
                if x < 0 or (kinds[k] == "hour" and x > 24):
                    raise ValueError
            if kinds[k] == "percent" and not 0 <= float(v) <= 1:
                raise ValueError
            if kinds[k] == "bool" and v not in ("true", "false"):
                raise ValueError
        except ValueError:
            raise HTTPException(400, f"Invalid value for {k}: {v}")
        row = db.get(PlatformConfig, k)
        if row and row.value != v:
            changed.append(f"{k}: {row.value} -> {v}")
            row.value, row.updated_by, row.updated_at = v, user.user_id, now()
    if int(float(body.values.get("contact_hour_end", cfg(db, "contact_hour_end")))) <= \
            int(float(body.values.get("contact_hour_start", cfg(db, "contact_hour_start")))):
        db.rollback()
        raise HTTPException(400, "Latest contact hour must be after the earliest.")
    if changed:
        audit(db, user.user_id, "UPDATE", "config", "platform", f"Changed {len(changed)} settings",
              {"changes": changed})
    db.commit()
    return {"changed": changed}


@router.get("/admin/integrations")
def integrations(user: User = Depends(require("manage_integrations")), db: Session = Depends(get_db)):
    last_decision = db.query(func.max(Decision.decided_at)).filter(Decision.decided_at <= now()).scalar()
    last_nudge = db.query(func.max(Nudge.sent_at)).filter(Nudge.sent_at <= now()).scalar()
    sent = Counter(n.channel for n in db.query(Nudge).filter(Nudge.sent_at.isnot(None)))
    failed = Counter(n.channel for n in db.query(Nudge).filter(Nudge.status == "Failed"))
    shadow = cfg(db, "shadow_mode") == "true"
    feeds = [
        {"id": "risk_feed", "name": "Client risk model & cohort handoff", "kind": "Inbound data",
         "status": "Connected", "mode": "Batch (daily)", "detail":
             f"{db.query(models.Customer).count()} customers in {db.query(models.Cohort).count()} cohorts"
             f" · {db.query(Handoff).count()} handoffs received",
         "last_sync": db.query(func.max(Handoff.at)).scalar() or last_decision},
        {"id": "payments", "name": "Payments & outcomes feed", "kind": "Inbound data", "status": "Connected",
         "mode": "Batch (daily)", "detail": f"{db.query(Outcome).count()} outcomes recorded",
         "last_sync": last_decision},
        {"id": "bau", "name": "BAU contact history (dialler, letters)", "kind": "Inbound data",
         "status": "Connected", "mode": "Batch (hourly)",
         "detail": f"{db.query(ContactRecord).filter(ContactRecord.source == 'BAU').count()} contacts",
         "last_sync": last_decision},
    ]
    channels = []
    in_use = {s.channel for s in db.query(models.Strategy)}
    for name, ch in [("SMS gateway", "SMS"), ("Mobile app push", "App push"), ("SMS + App offers", "SMS + App"),
                     ("Email service", "Email"), ("Print and mail (letters)", "Letter"),
                     ("Dialler (agent calls)", "Outbound call"), ("Specialist team queue", "Specialist team")]:
        if ch not in in_use and not sent.get(ch):
            continue  # no treatment in the playbook uses this channel
        total = sent.get(ch, 0) + failed.get(ch, 0)
        channels.append({"id": ch, "name": name, "kind": "Outbound channel",
                         "status": "Simulated" if shadow else "Connected",
                         "mode": "Shadow mode - not contacting customers" if shadow else "Live",
                         "detail": f"{sent.get(ch, 0)} sent · {failed.get(ch, 0)} failed"
                                   + (f" ({failed.get(ch, 0) / total:.1%})" if total else ""),
                         "last_sync": last_nudge})
    return {"feeds": feeds, "channels": channels, "shadow_mode": shadow}


@router.get("/admin/mcp")
def mcp_status(user: User = Depends(require("manage_integrations")), db: Session = Depends(get_db)):
    """The MCP endpoint agents call: transport, tools, traffic. The token stays masked."""
    return mcp_server.status(db)


@router.post("/admin/mcp/token")
def mcp_reveal_token(user: User = Depends(require("manage_integrations")), db: Session = Depends(get_db)):
    token, source = mcp_server.access_token(db)
    audit(db, user.user_id, "READ", "integration", "mcp", "Revealed the MCP access token")
    db.commit()
    return {"token": token, "source": source}


@router.post("/admin/mcp/token/rotate")
def mcp_rotate_token(user: User = Depends(require("manage_integrations")), db: Session = Depends(get_db)):
    try:
        return {"token": mcp_server.rotate_token(db, user.user_id)}
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.get("/admin/audit")
def audit_log(actor: str = "", action: str = "", entity: str = "", q: str = "", page: int = 1,
              page_size: int = 40, user: User = Depends(require("view_audit_log")), db: Session = Depends(get_db)):
    query = db.query(AuditEvent)
    if actor:
        query = query.filter(AuditEvent.actor == actor)
    if action:
        query = query.filter(AuditEvent.action == action)
    if entity:
        query = query.filter(AuditEvent.entity == entity)
    if q:
        query = query.filter(AuditEvent.summary.like(f"%{q}%"))
    query = query.filter(AuditEvent.at <= now())
    total = query.count()
    names = _user_names(db)
    rows = query.order_by(AuditEvent.at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    return {"total": total, "page": page, "page_size": page_size,
            "actors": [{"id": k, "name": names.get(k, k)} for (k,) in db.query(AuditEvent.actor).distinct()],
            "entities": sorted({e for (e,) in db.query(AuditEvent.entity).distinct()}),
            "rows": [{"audit_id": a.audit_id, "at": a.at, "actor": a.actor, "actor_name": names.get(a.actor, a.actor),
                      "action": a.action, "entity": a.entity, "entity_id": a.entity_id, "summary": a.summary,
                      "detail": json.loads(a.detail or "{}")} for a in rows]}


@router.get("/admin/health")
def system_health(user: User = Depends(require("view_system_health")), db: Session = Depends(get_db)):
    import os
    from ..db import DB_PATH
    m = METRICS.snapshot()
    day = (datetime.now(UTC) - timedelta(days=1)).isoformat(timespec="seconds")
    lat = db.query(func.avg(Decision.latency_ms)).scalar() or 0
    last_wave = db.query(func.max(Decision.decided_at)).filter(Decision.decided_at <= now()).scalar()
    size = os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0
    components = [
        {"name": "Decision API", "status": "Operational" if m["error_rate"] < 0.01 else "Degraded",
         "detail": f"p95 {m['latency_p95_ms']} ms over {len(METRICS.samples)} recent requests"},
        {"name": "Decision engine", "status": "Operational",
         "detail": f"avg {lat:.0f} ms per decision · last wave {last_wave or 'never'}"},
        {"name": "Compliance monitor", "status": "Operational",
         "detail": f"last scan {(db.get(PlatformConfig, '_compliance_scanned_until').value if db.get(PlatformConfig, '_compliance_scanned_until') else 'never')}"},
        {"name": "Channel gateways", "status": "Simulated" if cfg(db, "shadow_mode") == "true" else "Operational",
         "detail": "Shadow mode: deliveries are simulated"},
        {"name": "Database", "status": "Operational", "detail": f"SQLite · {size / 1_048_576:.1f} MB"},
    ]
    return {"metrics": m, "components": components, "model_version": cfg(db, "model_version"),
            "decisions_24h": db.query(Decision).filter(Decision.decided_at >= day,
                                                       Decision.decided_at <= now()).count(),
            "decision_latency_ms": round(lat, 1), "started_at": STARTED_AT.isoformat(timespec="seconds")}
