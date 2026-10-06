"""Console seed: people, permissions, strategies and five weeks of history.

History is produced by running the real engine week by week with the clock
set back, so every dashboard reads genuine decisions. Two things are injected
around the engine, because they come from outside ARI:

  * BAU contacts - the bank's existing dialler and letters keep running
    alongside ARI. Compliance has to count them.
  * Three manual messages typed by a strategist - the realistic source of
    content breaches, since ARI's own templates are pre-approved.
"""
from __future__ import annotations

import json
import random
from datetime import datetime, timedelta, timezone

import numpy as np
from sqlalchemy import text
from sqlalchemy.orm import Session

from .. import models
from ..seed import COHORTS
from . import compliance, engine, insights, playbook
from .models import (
    AlertRule, Campaign, ContactRecord, Decision, EngagementEvent, Handoff, Insight, Nudge, PlatformConfig,
    RolePermission, User,
)
from .platform import CONFIG_DEFAULTS, audit
from .rbac import DEFAULT_GRANTS, PERMISSION_KEYS

UTC = timezone.utc

USERS = [
    ("u-maya", "Maya Patel", "maya.patel@firm.co", "strategist", "Active", 0.03),
    ("u-james", "James Thornton", "j.thornton@firm.co", "leader", "Active", 0.25),
    ("u-ravi", "Ravi Kumar", "ravi.k@firm.co", "strategist", "Active", 0.6),
    ("u-aisha", "Aisha Osei", "a.osei@firm.co", "strategist", "Inactive", 9),
    ("u-tom", "Tom Eriksson", "t.eriksson@firm.co", "viewer", "Pending", None),
    ("u-priya", "Priya Nair", "priya.nair@firm.co", "admin", "Active", 0.01),
]

# name, owner, status, launch weeks ago, waves, fields
CAMPAIGNS = [
    ("STR-021", "Payment Plan AI Offer", "u-maya", "Live", 5, 5, dict(
        description="Instalment offers for medium-risk 30 DPD customers who can be helped. "
                    "Plans need a person to approve each offer.",
        target_cohorts=["C2"], include_segments=["Persuadable"], treatment_codes=["S3", "S1", "S2"],
        tone="Supportive", cadence_days=3, max_touches=3, escalate_to=None,
        wave_size=18, recovery_target=0.55)),
    ("STR-014", "Early Engagement Cascade", "u-maya", "Live", 5, 5, dict(
        description="Tiered digital reminders before any escalation. Works across early buckets.",
        target_cohorts=["C1", "C2"], include_segments=["Persuadable"], treatment_codes=["S1", "S2", "S4"],
        tone="Supportive", cadence_days=3, max_touches=3, escalate_to=None, wave_size=18,
        recovery_target=0.50)),
    ("STR-009", "Low Balance Quick Win", "u-ravi", "Live", 5, 5, dict(
        description="Fast one-touch SMS for balances under $2.5k. High close rate, minimal cost.",
        target_cohorts=["C1"], include_segments=["Persuadable", "Sure Thing"], max_balance=2500,
        treatment_codes=["S1", "S2"], tone="Neutral", cadence_days=2, max_touches=2, escalate_to=None,
        wave_size=24, recovery_target=0.70)),
    ("STR-018", "High-Risk Escalation Path", "u-maya", "Live", 4, 4, dict(
        description="Structured outreach for 60 DPD: plan offer, agent call, or hardship review.",
        target_cohorts=["C3"], include_segments=["Persuadable", "Lost Cause"],
        treatment_codes=["S3", "S5", "S6"], tone="Neutral", cadence_days=4, max_touches=2,
        escalate_to=None, wave_size=18, recovery_target=0.40)),
    ("STR-031", "Multi-Channel Blitz", "u-ravi", "Live", 3, 3, dict(
        description="Daily touches across SMS, app and calls with early escalation.",
        target_cohorts=["C2", "C3"], include_segments=["Persuadable"], treatment_codes=["S1", "S5", "S2"],
        tone="Direct", cadence_days=1, max_touches=4, escalate_after_days=5, escalate_to="S5",
        wave_size=20, recovery_target=0.65)),
    ("STR-022", "Settlement Fast-Track", "u-aisha", "Paused", 5, 2, dict(
        description="Deferral or call for very high-risk accounts. Paused pending review.",
        target_cohorts=["C4"], include_segments=["Persuadable", "Lost Cause"],
        treatment_codes=["S4", "S5", "S6"], tone="Neutral", cadence_days=4, max_touches=2,
        escalate_to=None, wave_size=12, recovery_target=0.35)),
    ("STR-027", "First-Time Delinquent Nurture", "u-ravi", "In review", None, 0, dict(
        description="Empathetic multi-touch sequence for first-time missed payments. Avoids escalation.",
        target_cohorts=["C1"], include_segments=["Persuadable"], treatment_codes=["S2", "S1"],
        tone="Supportive", cadence_days=4, max_touches=2, escalate_to=None, wave_size=20,
        recovery_target=0.60, steps_completed=6)),
    ("STR-025", "Low-Risk Nurture Flow", "u-maya", "Draft", None, 0, dict(
        description="Gentle app-first nudges for low-risk early arrears.",
        target_cohorts=["C1"], include_segments=["Persuadable"], treatment_codes=["S2"],
        tone="Supportive", cadence_days=5, max_touches=2, escalate_to=None, wave_size=20,
        recovery_target=0.55, steps_completed=2)),
]

ALERTS = [
    ("Strategy recovery rate below target", "campaign_rate_vs_target", "lt", -0.05, "campaign",
     "Critical", "Strategy owner, James Thornton"),
    ("No lift over control", "campaign_uplift", "lt", 0.0, "campaign", "High", "Strategy owner"),
    ("Escalation rate above ceiling", "escalation_rate", "gt", 0.08, "portfolio", "High", "James Thornton"),
    ("Open critical compliance violations", "critical_violations", "gt", 0, "portfolio", "Critical",
     "Compliance, James Thornton"),
    ("Review queue backlog", "pending_review", "gt", 10, "portfolio", "Medium", "Strategists"),
    ("API p95 latency", "latency_p95_ms", "gt", 800, "portfolio", "Medium", "Priya Nair"),
]


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def ensure_console(db: Session) -> None:
    """Bring an existing database up to the current schema and reference data,
    and load the treatment playbook into the scoring cache. Safe on every start;
    without it, treatments added in the console would be unknown after a restart."""
    added_columns = [("campaigns", "parent_id", "VARCHAR(12)"),
                     ("decisions", "origin", "VARCHAR(12) DEFAULT 'wave'"),
                     ("decisions", "blocked_arms", "TEXT DEFAULT '[]'")]
    try:
        for table, column, ddl in added_columns:
            cols = {r[1] for r in db.execute(text(f"PRAGMA table_info({table})"))}
            if cols and column not in cols:
                db.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
        db.commit()
    except Exception:  # not SQLite: migrations are handled by the deployment
        db.rollback()
    have = {(r.role, r.permission) for r in db.query(RolePermission)}
    for role, grants in DEFAULT_GRANTS.items():
        for p in PERMISSION_KEYS:
            if (role, p) not in have:
                db.add(RolePermission(role=role, permission=p, granted=p in grants))
    rows = {r.key: r for r in db.query(PlatformConfig)}
    for key, default, label, group, kind, help_ in CONFIG_DEFAULTS:
        if key not in rows:
            db.add(PlatformConfig(key=key, value=default, label=label, group=group, kind=kind, help=help_))
        elif rows[key].help != help_:
            rows[key].help = help_  # help text follows the code; values stay as configured
    # No channel gateway is connected, so shadow mode cannot be off.
    if "shadow_mode" in rows and rows["shadow_mode"].value != "true":
        rows["shadow_mode"].value = "true"
    db.commit()
    playbook.seed_meta(db)


def seed_console(db: Session, force: bool = False) -> dict:
    if db.query(User).count() and not force:
        ensure_console(db)
        return {"status": "already seeded"}
    now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    rng = random.Random(2026)

    for uid, name, email, role, status, days_ago in USERS:
        db.add(User(user_id=uid, name=name, email=email, role=role, status=status,
                    last_login=_iso(now - timedelta(days=days_ago)) if days_ago is not None else None,
                    created_at=_iso(now - timedelta(days=120))))
    for role, grants in DEFAULT_GRANTS.items():
        for p in PERMISSION_KEYS:
            db.add(RolePermission(role=role, permission=p, granted=p in grants))
    for key, default, label, group, kind, help_ in CONFIG_DEFAULTS:
        db.add(PlatformConfig(key=key, value=default, label=label, group=group, kind=kind, help=help_,
                              updated_by="u-priya", updated_at=_iso(now - timedelta(days=40))))
    for name, metric, comp, thr, scope, sev, notify in ALERTS:
        db.add(AlertRule(name=name, metric=metric, comparator=comp, threshold=thr, scope=scope,
                         severity=sev, notify=notify, enabled=True, created_by="u-priya",
                         updated_at=_iso(now - timedelta(days=30))))
    # The accounts already loaded arrived as the first handoff.
    db.add(Handoff(at=_iso(now - timedelta(weeks=6)), by="system", trigger="initial",
                   counts=json.dumps({co["cohort_id"]: co["size"] for co in COHORTS}),
                   total=sum(co["size"] for co in COHORTS)))
    db.commit()
    # Review policy and eligibility rules come from the playbook, so it must be
    # described before the first wave runs.
    playbook.seed_meta(db)

    # ---- strategies ---------------------------------------------------------
    camps: dict[str, Campaign] = {}
    for i, (cid, name, owner, status, weeks, waves, f) in enumerate(CAMPAIGNS):
        created = now - timedelta(weeks=(weeks or 1) + 1, days=rng.randint(0, 3))
        c = Campaign(campaign_id=cid, name=name, owner_id=owner, created_by=owner, status="Draft",
                     source="manual", seed=101 + i, created_at=_iso(created), updated_at=_iso(created),
                     description=f.pop("description"),
                     target_cohorts=json.dumps(f.pop("target_cohorts")),
                     include_segments=json.dumps(f.pop("include_segments")),
                     treatment_codes=json.dumps(f.pop("treatment_codes")),
                     risk_bands="[]", steps_completed=f.pop("steps_completed", 6), **f)
        db.add(c)
        camps[cid] = c
        audit(db, owner, "CREATE", "strategy", cid, f"Created strategy {cid} {name}", at=_iso(created))
        if status in ("Live", "Paused", "In review"):
            c.submitted_at = _iso(created + timedelta(days=1))
            audit(db, owner, "UPDATE", "strategy", cid, f"Submitted {cid} for approval", at=c.submitted_at)
        if status in ("Live", "Paused"):
            c.approved_by, c.approved_at = "u-james", _iso(created + timedelta(days=2))
            c.launched_at = _iso(now - timedelta(weeks=weeks))
            audit(db, "u-james", "APPROVE", "strategy", cid, f"Approved {cid} (v1)", at=c.approved_at)
            audit(db, owner, "UPDATE", "strategy", cid, f"Launched {cid}", at=c.launched_at)
            c.status = "Live"
        else:
            c.status = status
    db.commit()

    # ---- five weeks of history, week by week across strategies ---------------
    for wk in range(5, 0, -1):
        for cid, _, owner, status, weeks, waves, _f in CAMPAIGNS:
            c = camps[cid]
            if not weeks or wk > weeks:
                continue
            if status == "Paused" and c.waves_run >= waves:
                continue
            at = now - timedelta(weeks=wk, days=-1, hours=rng.randint(0, 8))
            engine.run_wave(db, c, at=at, actor="system", realise=True)
            audit(db, "system", "UPDATE", "strategy", cid, f"Wave {c.waves_run} decided for {cid}",
                  at=_iso(at))
    camps["STR-022"].status = "Paused"
    audit(db, "u-aisha", "UPDATE", "strategy", "STR-022", "Paused strategy STR-022",
          at=_iso(now - timedelta(weeks=3)))
    db.commit()

    _bau_contacts(db, rng, now)
    _manual_nudges(db, camps, now)
    db.commit()

    # A live wave in review: forbearance decisions waiting for a person.
    for cid in ("STR-021", "STR-018"):
        engine.run_wave(db, camps[cid], at=now - timedelta(hours=20), realise=False)
    db.commit()

    found = compliance.scan(db, until=now)
    _insights(db, now)
    _audit_extras(db, now)
    db.commit()
    return {"status": "seeded", "decisions": db.query(Decision).count(),
            "nudges": db.query(Nudge).count(), "violations": found}


def _bau_contacts(db: Session, rng: random.Random, now: datetime) -> None:
    """The bank's existing dialler and letters, running alongside ARI."""
    decisions = db.query(Decision).all()
    optouts = {e.customer_id: datetime.fromisoformat(e.at)
               for e in db.query(EngagementEvent).filter(EngagementEvent.event == "OptOut")}
    for d in decisions:
        start = datetime.fromisoformat(d.decided_at)
        heavy = d.campaign_id == "STR-031"
        n = rng.choices([0, 1, 2, 3], weights=[55, 25, 12, 8])[0] + (rng.randint(3, 6) if heavy else 0)
        for _ in range(n):
            at = start + timedelta(days=rng.randint(0, 6), hours=rng.randint(0, 10))
            hour = 21 if rng.random() < 0.012 else rng.randint(9, 19)
            at = at.replace(hour=hour)
            if at > now:
                continue
            channel = "Outbound call" if heavy else rng.choice(["Outbound call", "Outbound call", "Letter"])
            db.add(ContactRecord(customer_id=d.customer_id, channel=channel, source="BAU", at=_iso(at),
                                 local_hour=hour))
    for cid, at in optouts.items():
        if rng.random() < 0.55:
            lag = at + timedelta(days=rng.randint(1, 3), hours=rng.randint(1, 6))
            if lag < now:
                db.add(ContactRecord(customer_id=cid, channel="SMS", source="BAU", at=_iso(lag),
                                     local_hour=min(max(lag.hour, 9), 19)))


def _manual_nudges(db: Session, camps: dict, now: datetime) -> None:
    """Strategist-typed messages: the realistic source of content breaches."""
    texts = [
        ("STR-031", "This is a final warning about your overdue balance. Pay today."),
        ("STR-031", "Your account is overdue. Please call us back today."),
        ("STR-021", "Hi, your plan offer is ready. Ref 4532015112830366. Reply STOP to opt out."),
    ]
    seq = engine.Seq(db)
    used: set[int] = set()
    for i, (cid, text) in enumerate(texts):
        at = now - timedelta(days=2 + i * 3)
        # A strategist would message someone the guard allows; pick such a customer.
        d = next((x for x in db.query(Decision).filter(Decision.campaign_id == cid, Decision.group == "Treatment")
                  .order_by(Decision.decided_at.desc())
                  if x.customer_id not in used and engine.guard(db, x.customer_id, "SMS", at)[0]), None)
        if not d:
            continue
        used.add(d.customer_id)
        c = db.get(models.Customer, d.customer_id)
        rng = np.random.default_rng(900 + i)
        engine.execute(db, camps[cid], d, c, at, rng, seq, touch=9, manual_text=text, code="S1")
        audit(db, "u-ravi" if cid == "STR-031" else "u-maya", "CREATE", "nudge", d.decision_id,
              f"Sent manual nudge to customer {d.customer_id}", at=_iso(at))


def _insights(db: Session, now: datetime) -> None:
    n = 1
    for area in insights.problem_areas(db)[:4]:
        for idea in insights.ideas_for(db, area)[:1]:
            camp = db.get(Campaign, area["campaign_id"]) if area.get("campaign_id") else None
            to = camp.owner_id if camp else "u-maya"
            db.add(Insight(insight_id=f"IN-{n:03d}", campaign_id=area.get("campaign_id"),
                           from_user="u-james", to_user=to, title=idea["title"], body=idea["body"],
                           evidence=idea["evidence"], priority=idea["priority"],
                           status="New" if n % 2 else "In review",
                           proposed_change=json.dumps(idea["change"]),
                           created_at=_iso(now - timedelta(hours=2 + n * 7))))
            audit(db, "u-james", "CREATE", "insight", f"IN-{n:03d}",
                  f"Sent '{idea['title']}' to {to}", at=_iso(now - timedelta(hours=2 + n * 7)))
            n += 1


def _audit_extras(db: Session, now: datetime) -> None:
    audit(db, "u-priya", "UPDATE", "user", "u-tom", "Updated role: Tom Eriksson -> Viewer",
          at=_iso(now - timedelta(hours=26)))
    audit(db, "u-james", "EXPORT", "report", "portfolio", "Exported portfolio report",
          at=_iso(now - timedelta(hours=9)))
    audit(db, "u-priya", "UPDATE", "config", "contact_cap_7d", "Set contact cap to 7 per 7 days",
          at=_iso(now - timedelta(days=40)))
