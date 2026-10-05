"""Read models for every dashboard. All figures are computed from the decision
log - decisions, nudges, engagement, outcomes - never stored separately.

One rule runs through all of it: a strategy's result is reported against its
own randomised control group. A raw recovery rate includes customers who would
have paid anyway; the uplift over control is what the strategy caused.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from .. import models
from .engine import CHANNEL_OF, arrears, jl
from .models import (
    Campaign, ContactRecord, Decision, EngagementEvent, Nudge, Outcome, User,
)
from .platform import cfg_float

UTC = timezone.utc


def _dt(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


def _wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 0.0
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def _mde(p: float, n: int) -> float | None:
    if n <= 0:
        return None
    return (1.96 + 0.84) * math.sqrt(2 * p * (1 - p) / n)


def treatment_costs(db: Session) -> dict[str, float]:
    return {s.code: s.cost_per_contact for s in db.query(models.Strategy)}


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------
def _rows(db: Session, campaign_ids: list[str] | None = None, since: str | None = None,
          until: str | None = None):
    q = (db.query(Decision, Outcome)
         .outerjoin(Outcome, Outcome.decision_id == Decision.decision_id))
    if campaign_ids is not None:
        q = q.filter(Decision.campaign_id.in_(campaign_ids))
    if since:
        q = q.filter(Decision.decided_at >= since)
    if until:
        q = q.filter(Decision.decided_at < until)
    return q.all()


def stats_from_rows(db: Session, rows, nudges: list[Nudge] | None = None) -> dict:
    costs = treatment_costs(db)
    treated = [(d, o) for d, o in rows if d.group == "Treatment" and o is not None and o.reward is not None]
    control = [(d, o) for d, o in rows if d.group == "Control" and o is not None]
    t_paid = sum(1 for _, o in treated if o.paid)
    c_paid = sum(1 for _, o in control if o.paid)
    t_rate = t_paid / len(treated) if treated else None
    c_rate = c_paid / len(control) if control else None
    uplift = (t_rate - c_rate) if t_rate is not None and c_rate is not None else None
    ci = None
    if uplift is not None:
        # Agresti-Caffo: add one success and one failure to each group before
        # computing the interval. The plain normal interval collapses when a
        # small control group happens to have 0% or 100% paying, and would
        # call a 10-person comparison "significant".
        n1, n2 = len(treated) + 2, len(control) + 2
        p1, p2 = (t_paid + 1) / n1, (c_paid + 1) / n2
        se = math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2)
        ci = ((p1 - p2) - 1.96 * se, (p1 - p2) + 1.96 * se)
    mde = _mde(c_rate if c_rate else 0.3, min(len(treated), len(control))) if control else None
    delivered = [n for n in (nudges or []) if n.status in ("Delivered", "Opened", "Clicked")]
    cost = sum(costs.get(n.treatment_code, 0) for n in delivered)
    all_paid = [o for _, o in rows if o is not None and o.paid]
    escalated = sum(1 for _, o in treated if o.escalated)
    days = [o.days_to_pay for o in all_paid if o.days_to_pay]
    return {
        "decisions": len(rows),
        "treated": len(treated), "treated_paid": t_paid,
        "control": len(control), "control_paid": c_paid,
        "recovery_rate": round(t_rate, 4) if t_rate is not None else None,
        "control_rate": round(c_rate, 4) if c_rate is not None else None,
        "uplift": round(uplift, 4) if uplift is not None else None,
        "uplift_ci": [round(ci[0], 4), round(ci[1], 4)] if ci else None,
        "significant": bool(ci and (ci[0] > 0 or ci[1] < 0)),
        "mde": round(mde, 4) if mde else None,
        "underpowered": bool(mde and uplift is not None and abs(uplift) < mde),
        "recovered": round(sum(o.amount for o in all_paid), 2),
        "contact_cost": round(cost, 2),
        "contacts": len(delivered),
        "cost_per_recovery": round(cost / t_paid, 2) if t_paid else None,
        "escalation_rate": round(escalated / len(treated), 4) if treated else None,
        "avg_resolution_days": round(sum(days) / len(days), 1) if days else None,
        "pending_review": sum(1 for d, _ in rows if d.review_status == "pending"),
    }


def campaign_stats(db: Session, camp: Campaign, since: str | None = None) -> dict:
    rows = _rows(db, [camp.campaign_id], since)
    q = db.query(Nudge).filter(Nudge.campaign_id == camp.campaign_id)
    if since:
        q = q.filter(Nudge.scheduled_at >= since)
    return stats_from_rows(db, rows, q.all())


def weekly(db: Session, campaign_ids: list[str] | None = None, weeks: int = 6) -> list[dict]:
    end = datetime.now(UTC)
    start = end - timedelta(weeks=weeks)
    rows = _rows(db, campaign_ids, start.isoformat(timespec="seconds"))
    nq = db.query(Nudge).filter(Nudge.scheduled_at >= start.isoformat(timespec="seconds"))
    if campaign_ids is not None:
        nq = nq.filter(Nudge.campaign_id.in_(campaign_ids))
    buckets: dict[str, list] = defaultdict(list)
    nb: dict[str, list] = defaultdict(list)
    week_start = lambda d: (d - timedelta(days=d.weekday())).date().isoformat()  # noqa: E731
    for d, o in rows:
        buckets[week_start(_dt(d.decided_at))].append((d, o))
    for n in nq:
        nb[week_start(_dt(n.scheduled_at))].append(n)
    out = []
    for wk in sorted(buckets):
        s = stats_from_rows(db, buckets[wk], nb.get(wk, []))
        out.append({"week": wk, **{k: s[k] for k in (
            "recovery_rate", "control_rate", "uplift", "recovered", "treated", "control",
            "escalation_rate", "cost_per_recovery", "contacts")}})
    return out


# ---------------------------------------------------------------------------
# Portfolio KPIs
# ---------------------------------------------------------------------------
def kpis(db: Session) -> dict:
    now = datetime.now(UTC)
    last = (now - timedelta(days=14)).isoformat(timespec="seconds")
    prior = (now - timedelta(days=28)).isoformat(timespec="seconds")
    month = (now - timedelta(days=30)).isoformat(timespec="seconds")
    cur = stats_from_rows(db, _rows(db, None, last),
                          db.query(Nudge).filter(Nudge.scheduled_at >= last).all())
    prev = stats_from_rows(db, _rows(db, None, prior, last),
                           db.query(Nudge).filter(Nudge.scheduled_at >= prior,
                                                  Nudge.scheduled_at < last).all())
    allt = stats_from_rows(db, _rows(db, None, month),
                           db.query(Nudge).filter(Nudge.scheduled_at >= month).all())

    def delta(k):
        a, b = cur.get(k), prev.get(k)
        return round(a - b, 4) if a is not None and b is not None else None

    live = db.query(Campaign).filter(Campaign.status == "Live").count()
    live_prev = db.query(Campaign).filter(Campaign.status.in_(["Live", "Paused"]),
                                          Campaign.launched_at < last).count()
    return {
        "recovery_rate": {"value": allt["recovery_rate"], "delta": delta("recovery_rate"),
                          "target": cfg_float(db, "recovery_rate_target")},
        "uplift": {"value": allt["uplift"], "ci": allt["uplift_ci"], "mde": allt["mde"],
                   "control_rate": allt["control_rate"], "significant": allt["significant"],
                   "underpowered": allt["underpowered"]},
        "recovered": {"value": allt["recovered"], "delta": delta("recovered")},
        "cost_per_recovery": {"value": allt["cost_per_recovery"], "delta": delta("cost_per_recovery"),
                              "target": cfg_float(db, "cost_per_recovery_target")},
        "escalation_rate": {"value": allt["escalation_rate"], "delta": delta("escalation_rate"),
                            "target": cfg_float(db, "escalation_rate_target")},
        "active_strategies": {"value": live, "delta": live - live_prev},
        "avg_resolution_days": {"value": allt["avg_resolution_days"],
                                "delta": delta("avg_resolution_days")},
        "decisions_30d": allt["decisions"],
        "pending_review": allt["pending_review"],
    }


def segment_performance(db: Session) -> list[dict]:
    month = (datetime.now(UTC) - timedelta(days=30)).isoformat(timespec="seconds")
    rows = _rows(db, None, month)
    by: dict[str, list] = defaultdict(list)
    for d, o in rows:
        band = json.loads(d.snapshot or "{}").get("client_risk_band", "Unknown")
        by[band].append((d, o))
    order = ["Low", "Medium", "High", "Very high"]
    out = []
    for band in sorted(by, key=lambda b: order.index(b) if b in order else 9):
        s = stats_from_rows(db, by[band])
        out.append({"band": band, "accounts": len({d.customer_id for d, _ in by[band]}),
                    "recovery_rate": s["recovery_rate"], "control_rate": s["control_rate"],
                    "uplift": s["uplift"]})
    return out


def leaderboard(db: Session) -> list[dict]:
    users = {u.user_id: u.name for u in db.query(User)}
    out = []
    for c in db.query(Campaign).filter(Campaign.status.in_(["Live", "Paused"])):
        s = campaign_stats(db, c)
        recent = campaign_stats(db, c, (datetime.now(UTC) - timedelta(days=7)).isoformat(timespec="seconds"))
        out.append({"campaign_id": c.campaign_id, "name": c.name, "owner": users.get(c.owner_id),
                    "status": c.status, "accounts": s["decisions"], "recovery_rate": s["recovery_rate"],
                    "uplift": s["uplift"], "significant": s["significant"],
                    "underpowered": s["underpowered"], "last_week_rate": recent["recovery_rate"],
                    "cost_per_recovery": s["cost_per_recovery"], "target": c.recovery_target})
    return sorted(out, key=lambda r: -(r["uplift"] if r["uplift"] is not None else -1))


def team(db: Session) -> list[dict]:
    out = []
    for u in db.query(User).filter(User.role == "strategist"):
        camps = db.query(Campaign).filter(Campaign.owner_id == u.user_id).all()
        ids = [c.campaign_id for c in camps]
        s = stats_from_rows(db, _rows(db, ids), db.query(Nudge).filter(Nudge.campaign_id.in_(ids)).all()) \
            if ids else stats_from_rows(db, [])
        overrides = (db.query(Decision).filter(Decision.campaign_id.in_(ids), Decision.overridden.is_(True))
                     .count() if ids else 0)
        reviews = (db.query(Decision).filter(Decision.campaign_id.in_(ids),
                                             Decision.reviewed_by == u.user_id).count() if ids else 0)
        out.append({"user_id": u.user_id, "name": u.name, "status": u.status,
                    "strategies": len(camps), "live": sum(1 for c in camps if c.status == "Live"),
                    "drafts": sum(1 for c in camps if c.status in ("Draft", "In review")),
                    "accounts": s["decisions"], "recovery_rate": s["recovery_rate"],
                    "uplift": s["uplift"], "recovered": s["recovered"], "overrides": overrides,
                    "reviews": reviews, "cost_per_recovery": s["cost_per_recovery"]})
    return out


# ---------------------------------------------------------------------------
# Customers and journeys
# ---------------------------------------------------------------------------
def customer_state(db: Session, customer_ids: list[int] | None = None) -> dict[int, dict]:
    """Latest pipeline state per customer, derived from the log."""
    q = db.query(Decision).order_by(Decision.decided_at)
    if customer_ids is not None:
        q = q.filter(Decision.customer_id.in_(customer_ids))
    latest: dict[int, Decision] = {}
    for d in q:
        latest[d.customer_id] = d
    ids = [d.decision_id for d in latest.values()]
    outcomes = {o.decision_id: o for o in db.query(Outcome).filter(Outcome.decision_id.in_(ids))} if ids else {}
    nudges: dict[str, list[Nudge]] = defaultdict(list)
    if ids:
        for n in db.query(Nudge).filter(Nudge.decision_id.in_(ids)):
            nudges[n.decision_id].append(n)
    events: dict[int, set] = defaultdict(set)
    cust = list(latest)
    if cust:
        for e in db.query(EngagementEvent).filter(EngagementEvent.customer_id.in_(cust)):
            events[e.customer_id].add(e.event)
    last_contact: dict[int, str] = {}
    if cust:
        for r in db.query(ContactRecord).filter(ContactRecord.customer_id.in_(cust)):
            if r.at > last_contact.get(r.customer_id, ""):
                last_contact[r.customer_id] = r.at
    out = {}
    for cid, d in latest.items():
        o = outcomes.get(d.decision_id)
        ev = events.get(cid, set())
        snap = json.loads(d.snapshot or "{}")
        due = snap.get("arrears") or 0
        if d.group == "Control":
            status, progress = ("Resolved", 100) if o and o.paid else ("Holdout", 0)
        elif d.overridden and not d.treatment_code:
            status, progress = "Held by override", 0
        elif d.review_status == "pending":
            status, progress = "Pending review", 5
        elif o is None:
            status, progress = "In window", 20
        elif o and o.paid:
            if d.treatment_code in ("S3", "S4"):
                status = "Accepted"
            else:
                status = "Resolved" if o.amount >= due else "Responding"
            progress = 100 if o.amount >= due else int(100 * o.amount / max(due, 1))
        elif o and o.escalated:
            status, progress = "Escalated", 15
        elif "Clicked" in ev or "FormCompleted" in ev or "Answered" in ev:
            status, progress = "Engaged", 45
        elif "Opened" in ev:
            status, progress = "Responding", 25
        elif any(n.status == "Held" for n in nudges[d.decision_id]):
            status, progress = "Suppressed", 0
        else:
            status, progress = "Unresponsive", 10
        out[cid] = {"decision_id": d.decision_id, "campaign_id": d.campaign_id, "group": d.group,
                    "treatment_code": d.treatment_code, "status": status, "progress": progress,
                    "last_contact": last_contact.get(cid), "decided_at": d.decided_at}
    return out


def journey(db: Session, customer_id: int) -> dict:
    c = db.get(models.Customer, customer_id)
    if not c:
        return {}
    treatments = {s.code: s.name for s in db.query(models.Strategy)}
    camps = {k.campaign_id: k for k in db.query(Campaign)}
    events: list[dict] = []
    decisions = db.query(Decision).filter(Decision.customer_id == customer_id).order_by(Decision.decided_at).all()
    first = decisions[0].decided_at if decisions else None
    if first:
        events.append({"at": (_dt(first) - timedelta(hours=2)).isoformat(timespec="seconds"),
                       "kind": "system", "title": "Account entered recovery pipeline",
                       "detail": f"{c.days_past_due} days past due · balance ${c.balance:,.0f} · "
                                 f"client risk {c.client_risk_band.lower()} ({c.client_risk_score:.0f})",
                       "tag": "Handoff"})
    nudge_ids = []
    for d in decisions:
        k = camps.get(d.campaign_id)
        events.append({"at": d.decided_at, "kind": "decision",
                       "title": (f"Strategy assigned: {d.campaign_id}" if d.group != "Control"
                                 else f"Control holdout: {d.campaign_id}"),
                       "detail": (f"{k.name if k else ''} · " + (
                           f"{treatments.get(d.treatment_code, '')} selected ({d.decision_id})"
                           if d.group == "Treatment" else "business-as-usual comparison group")),
                       "tag": "Review pending" if d.review_status == "pending" else
                       ("Override" if d.overridden else d.group), "decision_id": d.decision_id})
        for n in db.query(Nudge).filter(Nudge.decision_id == d.decision_id).order_by(Nudge.scheduled_at):
            nudge_ids.append(n.nudge_id)
            events.append({"at": n.sent_at or n.scheduled_at, "kind": "nudge",
                           "title": f"{n.channel}: {treatments.get(n.treatment_code, n.treatment_code)}"
                                    + (" (escalation)" if n.is_escalation else
                                       (f" · touch {n.touch_number}" if n.touch_number > 1 else "")),
                           "detail": n.failure_reason if n.status in ("Held", "Failed") else n.content,
                           "tag": n.status, "nudge_id": n.nudge_id})
        o = db.query(Outcome).filter(Outcome.decision_id == d.decision_id).first()
        if o and o.paid:
            events.append({"at": o.observed_at, "kind": "payment",
                           "title": f"Payment received: ${o.amount:,.2f}",
                           "detail": f"{o.days_to_pay} days after decision · "
                                     + ("full arrears" if o.amount >= arrears(c) else "partial"),
                           "tag": "Paid"})
    if nudge_ids:
        for e in db.query(EngagementEvent).filter(EngagementEvent.nudge_id.in_(nudge_ids)):
            label = {"Opened": "Message opened", "Clicked": "Clicked payment link",
                     "FormCompleted": "Completed payment form", "Answered": "Call answered",
                     "OptOut": "Opted out of messages"}.get(e.event, e.event)
            events.append({"at": e.at, "kind": "engagement", "title": label,
                           "detail": f"via {e.nudge_id}", "tag": e.event, "nudge_id": e.nudge_id})
    for r in db.query(ContactRecord).filter(ContactRecord.customer_id == customer_id,
                                            ContactRecord.source == "BAU"):
        events.append({"at": r.at, "kind": "bau", "title": f"BAU {r.channel.lower()}",
                       "detail": "Bank's existing collections system (not ARI)", "tag": "BAU"})
    events.sort(key=lambda e: e["at"], reverse=True)

    state = customer_state(db, [customer_id]).get(customer_id)
    nxt = None
    if decisions and state and state["status"] in ("Unresponsive", "Responding", "Engaged"):
        d = decisions[-1]
        k = camps.get(d.campaign_id)
        if k and k.escalate_to and d.group == "Treatment":
            when = _dt(d.decided_at) + timedelta(days=k.escalate_after_days)
            nxt = {"action": f"Escalate to {treatments.get(k.escalate_to)}",
                   "when": when.isoformat(timespec="seconds"),
                   "reason": f"No payment {k.escalate_after_days} days after the first touch, "
                             f"per {k.campaign_id}'s escalation rule."}
    nudges = db.query(Nudge).filter(Nudge.customer_id == customer_id).all()
    paid = db.query(Outcome).filter(Outcome.customer_id == customer_id, Outcome.paid.is_(True)).all()
    eng = db.query(EngagementEvent).filter(EngagementEvent.customer_id == customer_id).count()
    days_active = ((datetime.now(UTC) - _dt(first)).days if first else 0)
    return {
        "customer": {k: getattr(c, k) for k in (
            "customer_id", "name", "cohort_id", "balance", "credit_limit", "days_past_due",
            "client_risk_band", "client_risk_score", "segment", "nudge_score", "self_cure_score",
            "sms_responsive", "app_user", "hardship_flag", "missed_payments", "payment_history",
            "tenure_years", "utilization")} | {"arrears": arrears(c)},
        "events": events,
        "summary": {"days_active": days_active, "nudges_sent": sum(1 for n in nudges if n.sent_at),
                    "decisions": len(decisions), "engagement_events": eng,
                    "response_rate": round(eng / max(1, sum(1 for n in nudges if n.sent_at)), 2),
                    "amount_recovered": round(sum(o.amount for o in paid), 2),
                    "status": state["status"] if state else "Not in a strategy"},
        "next_action": nxt,
    }
