"""Compliance monitoring: detection of what slipped through.

The engine's guard PREVENTS ARI from breaching contact rules. This module
DETECTS breaches across everything the customer experienced - ARI's nudges and
the bank's business-as-usual dialler and letters - because the rules are about
the customer's experience, not about which system sent the message.

Every violation is computed from the contact and nudge records. None are
seeded directly.
"""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from .models import ComplianceViolation, ContactRecord, Nudge, PlatformConfig
from .platform import cfg

UTC = timezone.utc

POLICY_AREAS = [
    ("CFPB Contact Rules", "Reg F 7-in-7 call frequency"),
    ("FDCPA Hours & Frequency", "Contact inside 8am-9pm local time"),
    ("Opt-Out / Suppression", "Opt-outs honoured across every system"),
    ("Disclosure Requirements", "Opt-out instructions in every SMS"),
    ("AI Tone & Language Policy", "No threatening or pressuring language"),
    ("Data Privacy (PII)", "No full account numbers in messages"),
]

BANNED = ["final warning", "legal action", "garnish", "arrest", "we will sue", "last chance"]
PII = re.compile(r"\b\d{12,19}\b")


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


def _next_id(db: Session) -> int:
    return db.query(ComplianceViolation).count() + 1


def _attribute(nudges_by_customer: dict, customer_id: int, at: datetime) -> str | None:
    """Pin a BAU-caused breach to the ARI strategy that was also contacting the
    customer that week - that is the strategy whose contact plan has to change."""
    best = None
    for n in nudges_by_customer.get(customer_id, []):
        if n.sent_at and abs((_parse(n.sent_at) - at).days) <= 7:
            best = n.campaign_id
    return best


def scan(db: Session, until: datetime | None = None) -> int:
    """Incremental scan of records since the last scan. Returns violations found."""
    until = until or datetime.now(UTC)
    mark = db.get(PlatformConfig, "_compliance_scanned_until")
    since = _parse(mark.value) if mark else datetime(2000, 1, 1, tzinfo=UTC)
    seq = _next_id(db)
    found: list[ComplianceViolation] = []

    def add(area: str, rule: str, sev: str, desc: str, at: datetime, camp: str | None,
            cust: int | None, nudge: str | None = None):
        nonlocal seq
        found.append(ComplianceViolation(
            violation_id=f"VIO-{seq:03d}", policy_area=area, rule=rule, severity=sev,
            campaign_id=camp, customer_id=cust, nudge_id=nudge, description=desc,
            detected_at=at.isoformat(timespec="seconds"),
            status="Open"))
        seq += 1

    contacts = (db.query(ContactRecord)
                .filter(ContactRecord.at > since.isoformat(timespec="seconds"),
                        ContactRecord.at <= until.isoformat(timespec="seconds"))
                .order_by(ContactRecord.at).all())
    all_nudges = db.query(Nudge).filter(Nudge.sent_at.isnot(None)).all()
    by_customer: dict[int, list[Nudge]] = defaultdict(list)
    for n in all_nudges:
        by_customer[n.customer_id].append(n)

    start_h, end_h = int(cfg(db, "contact_hour_start")), int(cfg(db, "contact_hour_end"))
    call_cap = int(cfg(db, "call_cap_7d"))
    sla = timedelta(hours=int(cfg(db, "optout_sla_hours")))

    # Hours
    for r in contacts:
        if r.opted_out:
            continue
        if r.local_hour < start_h or r.local_hour >= end_h:
            at = _parse(r.at)
            camp = (next((n.campaign_id for n in by_customer[r.customer_id] if n.nudge_id == r.nudge_id), None)
                    if r.source == "ARI" else _attribute(by_customer, r.customer_id, at))
            add("FDCPA Hours & Frequency", "Contact outside permitted hours", "High",
                f"{r.source} {r.channel.lower()} to customer {r.customer_id} at "
                f"{r.local_hour:02d}:00 local time (permitted {start_h:02d}:00-{end_h:02d}:00).",
                at, camp, r.customer_id, r.nudge_id)

    # Call frequency: any rolling 7 days with more calls than the cap.
    calls: dict[int, list[datetime]] = defaultdict(list)
    for r in db.query(ContactRecord).filter(ContactRecord.channel == "Outbound call").order_by(ContactRecord.at):
        calls[r.customer_id].append(_parse(r.at))
    for cust, times in calls.items():
        for i, t in enumerate(times):
            window = [x for x in times[i:] if x - t <= timedelta(days=7)]
            last = window[-1]
            if len(window) > call_cap and since < last <= until:
                add("CFPB Contact Rules", "More than 7 call attempts in 7 days", "High",
                    f"Customer {cust} received {len(window)} call attempts between "
                    f"{t:%d %b} and {last:%d %b} across ARI and the BAU dialler.",
                    last, _attribute(by_customer, cust, last), cust)
                break

    # Opt-out lag: a contact on the opted-out channel after the SLA.
    # SMS, app push, combined offers and email are one digital channel for opt-out purposes.
    digital = ["SMS", "App push", "SMS + App", "Email"]
    optouts = db.query(ContactRecord).filter(ContactRecord.opted_out.is_(True)).all()
    for o in optouts:
        o_at = _parse(o.at)
        later = (db.query(ContactRecord)
                 .filter(ContactRecord.customer_id == o.customer_id, ContactRecord.opted_out.is_(False),
                         ContactRecord.channel.in_(digital), ContactRecord.at > o.at).all())
        for r in later:
            r_at = _parse(r.at)
            if r_at - o_at > sla and since < r_at <= until:
                lag = r_at - o_at
                add("Opt-Out / Suppression", "Contact after opt-out", "Critical",
                    f"{r.source} {r.channel} sent to customer {o.customer_id} "
                    f"{lag.days}d {lag.seconds // 3600}h after they opted out "
                    f"(SLA {int(sla.total_seconds() // 3600)}h).",
                    r_at, _attribute(by_customer, o.customer_id, r_at), o.customer_id, r.nudge_id)
                break

    # Content checks on ARI messages.
    for n in all_nudges:
        sent = _parse(n.sent_at)
        if not (since < sent <= until):
            continue
        text = (n.content or "").lower()
        if "SMS" in n.channel and "stop" not in text:
            add("Disclosure Requirements", "SMS missing opt-out instructions", "Medium",
                f"{n.nudge_id} to customer {n.customer_id} has no 'Reply STOP' instruction.",
                sent, n.campaign_id, n.customer_id, n.nudge_id)
        hit = next((b for b in BANNED if b in text), None)
        if hit:
            add("AI Tone & Language Policy", "Prohibited pressure language", "High",
                f"{n.nudge_id} contains '{hit}'.", sent, n.campaign_id, n.customer_id, n.nudge_id)
        if PII.search(n.content or ""):
            add("Data Privacy (PII)", "Full account number in message", "Critical",
                f"{n.nudge_id} includes an unmasked account number.", sent, n.campaign_id,
                n.customer_id, n.nudge_id)

    db.add_all(found)
    stamp = until.isoformat(timespec="seconds")
    if mark:
        mark.value = stamp
    else:
        db.add(PlatformConfig(key="_compliance_scanned_until", value=stamp, label="internal",
                              group="internal", kind="text"))
    db.commit()
    return len(found)


def area_scores(db: Session, since: datetime) -> list[dict]:
    """Compliance score per policy area = share of checked events with no breach."""
    s = since.isoformat(timespec="seconds")
    contacts = db.query(ContactRecord).filter(ContactRecord.at >= s).count() or 1
    sms = db.query(Nudge).filter(Nudge.sent_at >= s, Nudge.channel.like("%SMS%")).count() or 1
    msgs = db.query(Nudge).filter(Nudge.sent_at >= s).count() or 1
    call_customers = (db.query(ContactRecord.customer_id)
                      .filter(ContactRecord.at >= s, ContactRecord.channel == "Outbound call")
                      .distinct().count() or 1)
    optouts = db.query(ContactRecord).filter(ContactRecord.at >= s,
                                             ContactRecord.opted_out.is_(True)).count() or 1
    denominators = {
        "CFPB Contact Rules": call_customers, "FDCPA Hours & Frequency": contacts,
        "Opt-Out / Suppression": optouts, "Disclosure Requirements": sms,
        "AI Tone & Language Policy": msgs, "Data Privacy (PII)": msgs,
    }
    out = []
    for area, desc in POLICY_AREAS:
        n = (db.query(ComplianceViolation)
             .filter(ComplianceViolation.policy_area == area, ComplianceViolation.detected_at >= s).count())
        out.append({"area": area, "description": desc, "violations": n,
                    "checked": denominators[area],
                    "score": round(max(0.0, 1 - n / denominators[area]), 4)})
    return out
