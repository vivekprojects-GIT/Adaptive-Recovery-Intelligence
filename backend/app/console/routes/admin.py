"""Administration: users, roles, configuration, integrations, MCP access, audit, health."""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta


from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, text
from sqlalchemy.orm import Session


from ... import models
from ...core.database import SessionLocal, get_db
from .. import mcp_server
from .. import router as propensity_router
from ..models import (
    AuditEvent, Campaign, ContactRecord, Decision, Handoff, Nudge, Outcome, PlatformConfig, RolePermission, User,
)
from ..platform import CONFIG_DEFAULTS, METRICS, STARTED_AT, audit, cfg, now
from ..rbac import LOCKED, PERMISSIONS, ROLES, granted, require
from .common import UTC, _user_names

router = APIRouter()


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
        if k == "shadow_mode" and v != "true":
            raise HTTPException(409, "Shadow mode stays on: no channel gateway is connected, so ARI records "
                                     "contacts but cannot deliver them. It can be turned off once a channel "
                                     "gateway is integrated.")
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
    out: dict = {"changed": changed}
    if any(c.startswith("router_validation_share:") for c in changed):
        # A new routing policy applies to everyone no strategy has decided yet.
        out["rerouted"] = propensity_router.reroute_undecided(db)
        audit(db, user.user_id, "UPDATE", "routing", "propensity-router",
              f"Re-routed {out['rerouted']} undecided customers under the new validation share")
        db.commit()
    return out


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
                         "status": "Not connected",
                         "mode": "Delivery not connected",
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


@router.post("/admin/reseed")
def reseed(user: User = Depends(require("configure_platform"))):
    """Wipe and regenerate all data. Platform admins only: anyone else could
    erase a shared environment mid-meeting."""
    from ...seed import seed
    from ..seed import seed_console
    out = seed(reset=True)
    db = SessionLocal()
    try:
        out["console"] = seed_console(db, force=True)
    finally:
        db.close()
    return out


@router.get("/admin/health")
def system_health(user: User = Depends(require("view_system_health")), db: Session = Depends(get_db)):
    import os
    from ...core.database import DB_PATH, IS_SQLITE
    m = METRICS.snapshot()
    day = (datetime.now(UTC) - timedelta(days=1)).isoformat(timespec="seconds")
    lat = db.query(func.avg(Decision.latency_ms)).scalar() or 0
    last_wave = db.query(func.max(Decision.decided_at)).filter(Decision.decided_at <= now()).scalar()
    if IS_SQLITE:
        size = os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0
        database = f"SQLite · {size / 1_048_576:.1f} MB"
    else:
        size = db.execute(text("SELECT pg_database_size(current_database())")).scalar() or 0
        database = f"PostgreSQL · {size / 1_048_576:.1f} MB"
    components = [
        {"name": "Decision API", "status": "Operational" if m["error_rate"] < 0.01 else "Degraded",
         "detail": f"p95 {m['latency_p95_ms']} ms over {len(METRICS.samples)} recent requests"},
        {"name": "Decision engine", "status": "Operational",
         "detail": f"avg {lat:.0f} ms per decision · last wave {last_wave or 'never'}"},
        {"name": "Compliance monitor", "status": "Operational",
         "detail": f"last scan {(db.get(PlatformConfig, '_compliance_scanned_until').value if db.get(PlatformConfig, '_compliance_scanned_until') else 'never')}"},
        {"name": "Channel gateways", "status": "Not connected" if cfg(db, "shadow_mode") == "true" else "Operational",
         "detail": "No gateway connected: decisions are recorded, no message is sent"},
        {"name": "Database", "status": "Operational", "detail": database},
    ]
    return {"metrics": m, "components": components, "model_version": cfg(db, "model_version"),
            "decisions_24h": db.query(Decision).filter(Decision.decided_at >= day,
                                                       Decision.decided_at <= now()).count(),
            "decision_latency_ms": round(lat, 1), "started_at": STARTED_AT.isoformat(timespec="seconds")}
