"""The executive dashboard: one screen from intake to recovery.

  Intake        accounts the bank's collections system has handed over, by
                product and delinquency bucket
  Routing       where the Propensity Router sent them
  Pipeline      in ARI strategies, waiting for a person, with an agency
  Recovery      dollars and accounts recovered, experiment against control
  Deviations    expected against actual: each strategy's target, each
                bucket's expected time to pay, each treatment's track record
  Exceptions    what needs attention now
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models
from . import agencies, performance
from .engine import arrears
from .models import Campaign, ComplianceViolation, Decision, Handoff, Nudge, Outcome, Placement

UTC = timezone.utc
ROUTES = [("strategy", "ARI strategies"), ("bau", "Business as usual"), ("hardship", "Hardship team"),
          ("suppress", "Do not contact")]
REVIEW_SLA_HOURS = 24


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


def _expected_days(text: str) -> tuple[int, int] | None:
    """'7-10 days' -> (7, 10). None when the bank gives no number."""
    import re
    m = re.match(r"\s*(\d+)\s*-\s*(\d+)\s*days", text or "")
    return (int(m.group(1)), int(m.group(2))) if m else None


def intake(db: Session) -> dict:
    customers = db.query(models.Customer).all()
    by_product = Counter((c.product or "Retail card") for c in customers)
    by_cohort = Counter(c.cohort_id for c in customers)
    cohorts = db.query(models.Cohort).order_by(models.Cohort.sort_order).all()
    handoffs = db.query(Handoff).order_by(Handoff.at.desc()).all()
    return {
        "accounts": len(customers),
        "balance": round(sum(c.balance for c in customers), 2),
        "arrears": round(sum(arrears(c) for c in customers), 2),
        "by_product": [{"product": p, "accounts": n,
                        "balance": round(sum(c.balance for c in customers if (c.product or "Retail card") == p), 2)}
                       for p, n in by_product.most_common()],
        "by_bucket": [{"cohort_id": co.cohort_id, "bucket": co.dpd_bucket, "name": co.name,
                       "accounts": by_cohort.get(co.cohort_id, 0)} for co in cohorts],
        "handoffs": len(handoffs),
        "last_handoff": {"at": handoffs[0].at, "total": handoffs[0].total} if handoffs else None,
    }


def routing(db: Session) -> list[dict]:
    counts = Counter(r for (r,) in db.query(models.Customer.route))
    total = sum(counts.values()) or 1
    return [{"route": k, "label": label, "accounts": counts.get(k, 0), "share": round(counts.get(k, 0) / total, 4)}
            for k, label in ROUTES]


def pipeline(db: Session) -> dict:
    active = [k for (k,) in db.query(Campaign.campaign_id).filter(Campaign.status.in_(["Live", "Paused"]))]
    in_strategies = db.query(func.count(func.distinct(Decision.customer_id))).filter(
        Decision.campaign_id.in_(active)).scalar() or 0
    return {
        "in_strategies": in_strategies,
        "live_strategies": db.query(Campaign).filter(Campaign.status == "Live").count(),
        "awaiting_review": db.query(Decision).filter(Decision.review_status == "pending").count(),
        "placements_awaiting_approval": db.query(Placement).filter(Placement.status == "Proposed").count(),
        "with_agencies": db.query(Placement).filter(Placement.status == "Placed").count(),
    }


def recovery(db: Session) -> dict:
    ids = [k for (k,) in db.query(Campaign.campaign_id)]
    cmp = performance.comparison(db, ids)
    now = datetime.now(UTC).isoformat(timespec="seconds")
    ari = db.query(func.coalesce(func.sum(Outcome.amount), 0.0)).filter(
        Outcome.paid.is_(True), Outcome.observed_at <= now).scalar()
    perf = agencies.performance(db)["totals"]
    return {"comparison": cmp, "timeline": performance.timeline(db, ids, "week"),
            "ari_recovered": round(float(ari or 0.0), 2), "agency_recovered": perf["recovered"],
            "agency_net_recovered": perf["net_recovered"]}


def deviations(db: Session) -> dict:
    """Expected against actual, three ways."""
    rows = performance._rows(db, None)
    # 1. Each live strategy against the payment rate it was approved with.
    strategies = []
    for c in db.query(Campaign).filter(Campaign.status.in_(["Live", "Paused"])).order_by(Campaign.campaign_id):
        mine = [(d, o) for d, o in rows if d.campaign_id == c.campaign_id and d.group == "Treatment"]
        g = performance._group(mine, None)
        actual = g["payment_rate"]
        gap = round(actual - c.recovery_target, 4) if actual is not None else None
        strategies.append({"campaign_id": c.campaign_id, "name": c.name, "status": c.status,
                           "target": c.recovery_target, "actual": actual, "deviation": gap, "accounts": g["accounts"],
                           "state": None if gap is None else "on_track" if gap >= 0 else
                           "watch" if gap >= -0.05 else "off_track"})
    # 2. Each delinquency bucket against the bank's own expected time to pay.
    customers = {c.customer_id: c.cohort_id for c in db.query(models.Customer.customer_id, models.Customer.cohort_id)}
    days_by: dict[str, list[int]] = defaultdict(list)
    paid_by: Counter = Counter()
    n_by: Counter = Counter()
    for d, o in rows:
        co = customers.get(d.customer_id)
        n_by[co] += 1
        if o.paid:
            paid_by[co] += 1
            if o.days_to_pay:
                days_by[co].append(o.days_to_pay)
    buckets = []
    for co in db.query(models.Cohort).order_by(models.Cohort.sort_order):
        exp = _expected_days(co.expected_payment)
        days = days_by.get(co.cohort_id, [])
        avg = round(sum(days) / len(days), 1) if days else None
        state = None
        if exp and avg is not None:
            state = "on_track" if avg <= exp[1] else "watch" if avg <= exp[1] * 1.25 else "off_track"
        buckets.append({"cohort_id": co.cohort_id, "bucket": co.dpd_bucket, "risk_band": co.client_risk_band,
                        "expected": co.expected_payment, "expected_days": exp, "actual_days": avg,
                        "paid": paid_by.get(co.cohort_id, 0), "accounts": n_by.get(co.cohort_id, 0),
                        "payment_rate": round(paid_by[co.cohort_id] / n_by[co.cohort_id], 4) if n_by.get(co.cohort_id) else None,
                        "state": state})
    # 3. Each treatment against its record in the playbook before ARI.
    treatments = []
    hist = {s.code: s for s in db.query(models.Strategy)}
    for t in performance.treatments(db, None):
        s = hist.get(t["code"])
        exp = s.hist_successes / (s.hist_successes + s.hist_failures) if s and (s.hist_successes + s.hist_failures) else None
        gap = round(t["payment_rate"] - exp, 4) if exp is not None and t["payment_rate"] is not None else None
        treatments.append({"code": t["code"], "name": t["name"], "expected": round(exp, 4) if exp is not None else None,
                           "actual": t["payment_rate"], "deviation": gap, "accounts": t["accounts"],
                           "state": None if gap is None else "on_track" if gap >= -0.02 else
                           "watch" if gap >= -0.07 else "off_track"})
    return {"strategies": strategies, "buckets": buckets, "treatments": treatments,
            "notes": {"strategies": "Payment rate of treated accounts against the target set when the strategy was "
                                    "approved. Within 5 points below target is shown as watch.",
                      "buckets": "Average days from decision to payment against the time to pay the bank's "
                                 "collections system expects for the bucket.",
                      "treatments": "Payment rate under ARI against the treatment's track record in the playbook "
                                    "before ARI."}}


def exceptions(db: Session, alerts: list[dict]) -> list[dict]:
    now = datetime.now(UTC)
    stale = (now - timedelta(hours=REVIEW_SLA_HOURS)).isoformat(timespec="seconds")
    out = []

    def add(kind: str, severity: str, count: int, title: str, detail: str, link: str) -> None:
        if count:
            out.append({"kind": kind, "severity": severity, "count": count, "title": title, "detail": detail,
                        "link": link})

    week = (now - timedelta(days=7)).isoformat(timespec="seconds")
    failed = db.query(Nudge).filter(Nudge.status == "Failed", Nudge.scheduled_at >= week).count()
    held = db.query(Nudge).filter(Nudge.status == "Held", Nudge.scheduled_at >= week).count()
    overdue = db.query(Decision).filter(Decision.review_status == "pending", Decision.decided_at <= stale).count()
    pl_overdue = db.query(Placement).filter(Placement.status == "Proposed", Placement.proposed_at <= stale).count()
    critical = db.query(ComplianceViolation).filter(ComplianceViolation.status != "Resolved",
                                                    ComplianceViolation.severity == "Critical").count()
    open_v = db.query(ComplianceViolation).filter(ComplianceViolation.status != "Resolved").count()
    add("violations", "Critical", critical, "Critical compliance violations open",
        f"{open_v} open in total. Each needs an investigation and a resolution note.", "/compliance")
    add("reviews", "High", overdue, f"Decisions waiting more than {REVIEW_SLA_HOURS} hours for review",
        "Nothing is sent to these customers until a person decides.", "/review")
    add("placements", "High", pl_overdue, f"Agency placements waiting more than {REVIEW_SLA_HOURS} hours",
        "Proposed by ARI; a person approves every placement.", "/agencies")
    add("failed", "Medium", failed, "Messages that failed to send, last 7 days",
        "Usually an unreachable number or a channel outage.", "/customers")
    add("held", "Low", held, "Messages held by the contact rules, last 7 days",
        "Held for the contact cap, the send window or consent. Working as intended; watch for spikes.", "/customers")
    # Alerts already shown above as a count are not repeated.
    for a in [a for a in alerts if a["metric"] not in ("critical_violations", "pending_review")][:5]:
        out.append({"kind": "alert", "severity": a["severity"], "count": 1, "title": a["name"],
                    "detail": a["message"], "link": f"/strategies/{a['campaign_id']}" if a.get("campaign_id") else "/kpis"})
    order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}
    return sorted(out, key=lambda x: order.get(x["severity"], 9))


def dashboard(db: Session, alerts: list[dict]) -> dict:
    return {"intake": intake(db), "routing": routing(db), "pipeline": pipeline(db), "recovery": recovery(db),
            "deviations": deviations(db), "exceptions": exceptions(db, alerts),
            "formulas": performance.FORMULAS}
