"""Security and governance in one place: how personal data is protected, how
every decision can be traced, which decisions always wait for a person, and
what the audit log holds. Every figure is read from the live database."""
from __future__ import annotations

from collections import Counter

from sqlalchemy import func, text
from sqlalchemy.orm import Session

from ..core import pii
from . import fairness
from .models import AuditEvent, Decision, EligibilityEval, FeatureSnapshot, Placement, TreatmentMeta
from .platform import cfg_float, customer_ref
from .. import models

# (table, column, what it holds) - columns stored with EncryptedText.
ENCRYPTED = [("feature_snapshots", "raw_payload", "Inbound request as received from Nova, per decision"),
             ("external_customers", "payload", "Latest account record received from Nova")]


def encrypt_existing(db: Session) -> int:
    """Encrypt rows written before encryption was switched on. Safe to repeat."""
    done = 0
    for table, column, _ in ENCRYPTED:
        key = "snapshot_id" if table == "feature_snapshots" else "link_id"
        rows = db.execute(text(f"SELECT {key}, {column} FROM {table}")).all()
        for pk, value in rows:
            if value and not pii.is_encrypted(value):
                db.execute(text(f"UPDATE {table} SET {column} = :v WHERE {key} = :k"),
                           {"v": pii.encrypt(value), "k": pk})
                done += 1
    db.commit()
    return done


def encryption(db: Session) -> dict:
    fields = []
    for table, column, what in ENCRYPTED:
        values = [v for (v,) in db.execute(text(f"SELECT {column} FROM {table}"))]
        fields.append({"table": table, "column": column, "holds": what, "rows": len(values),
                       "encrypted": sum(pii.is_encrypted(v) for v in values)})
    return {"algorithm": "AES-256-GCM", "key_source": pii.KEY_SOURCE, "key_id": pii.KEY_ID,
            "in_transit": "HTTPS (TLS) for the console, the API and the MCP endpoint; the MCP endpoint also needs a "
                          "bearer token",
            "fields": fields,
            "production_note": None if pii.KEY_SOURCE == "environment" else
            "The key is in a local key file. In production it is set as ARI_PII_KEY from the bank's key vault."}


def tokenisation(db: Session) -> dict:
    sample = db.query(models.Customer.customer_id).order_by(models.Customer.customer_id).first()
    ref = customer_ref(db, sample[0] if sample else 1)
    return {"method": "Keyed hash (HMAC-SHA256), separate key from encryption",
            "example": {"identifier": ref, "token": pii.token(sample[0] if sample else 1, "customer")},
            "applied_to": ["Decision and routing traces (OpenTelemetry spans)", "Application logs",
                           "HTTP traces: query strings, such as a name typed into search, are redacted"],
            "note": "The same customer always gets the same token, so a trace can be followed end to end, but the "
                    "token cannot be turned back into a customer without the key."}


def traceability(db: Session) -> dict:
    total = db.query(Decision).count()
    with_snapshot = db.query(Decision).filter(Decision.feature_snapshot_id.isnot(None)).count()
    with_rules = db.query(func.count(func.distinct(EligibilityEval.decision_id))).scalar() or 0
    with_reason = db.query(Decision).filter(Decision.explanation != "").count()
    legacy = db.query(FeatureSnapshot).filter(FeatureSnapshot.contract_version == "legacy").count()
    pct = lambda n: round(n / total, 4) if total else None  # noqa: E731
    return {"decisions": total,
            "checks": [
                {"label": "Inputs frozen at decision time", "count": with_snapshot, "share": pct(with_snapshot),
                 "detail": "The exact data each decision used, kept unchanged."},
                {"label": "Every eligibility and contact rule recorded", "count": with_rules, "share": pct(with_rules),
                 "detail": "Pass or blocked, with the rule version and the reason."},
                {"label": "Plain-language reason recorded", "count": with_reason, "share": pct(with_reason),
                 "detail": "Why this treatment, for this customer, at this time."},
            ],
            "legacy": legacy}


def human_in_the_loop(db: Session) -> dict:
    threshold = cfg_float(db, "human_review_balance_threshold")
    names = {s.code: s.name for s in db.query(models.Strategy)}
    review_treatments = [names.get(t.code, t.code) for t in db.query(TreatmentMeta)
                         .filter(TreatmentMeta.human_review.is_(True), TreatmentMeta.status == "Active")]
    status = Counter(s for (s,) in db.query(Decision.review_status).filter(Decision.review_policy == "human_review"))
    placements = Counter(s for (s,) in db.query(Placement.status))
    return {
        "policies": [
            {"rule": f"Balance of ${threshold:,.0f} or more", "action": "Waits for a person before anything is sent",
             "where": "Review Queue", "configurable": True},
            {"rule": "Offers that change what the customer owes or when",
             "action": f"Always wait for a person: {', '.join(review_treatments) or 'none set'}",
             "where": "Review Queue", "configurable": True},
            {"rule": "Placement with a collection agency",
             "action": "Always approved by a person, never by the person who proposed it", "where": "Agencies",
             "configurable": False},
            {"rule": "Vulnerable customer or legal restriction",
             "action": "No automated contact; referred to a person", "where": "Decision record",
             "configurable": False},
            {"rule": "Changing ARI's choice", "action": "A person may override any decision, with a written reason",
             "where": "Decision record", "configurable": False},
            {"rule": "Launching or changing a strategy",
             "action": "Approved by a leader who is not the author", "where": "Approvals", "configurable": False},
        ],
        "decisions": {"pending": status.get("pending", 0), "approved": status.get("approved", 0),
                      "rejected": status.get("rejected", 0), "cancelled": status.get("cancelled", 0)},
        "placements": {"pending": placements.get("Proposed", 0), "approved": sum(
            placements.get(k, 0) for k in ("Placed", "Recovered", "Returned", "Recalled")),
            "declined": placements.get("Declined", 0)},
    }


def audit_summary(db: Session) -> dict:
    total = db.query(AuditEvent).count()
    first = db.query(func.min(AuditEvent.at)).scalar()
    last = db.query(func.max(AuditEvent.at)).scalar()
    by_action = Counter(a for (a,) in db.query(AuditEvent.action))
    by_entity = Counter(e for (e,) in db.query(AuditEvent.entity))
    return {"events": total, "first": first, "last": last,
            "by_action": [{"action": k, "count": v} for k, v in by_action.most_common()],
            "by_entity": [{"entity": k, "count": v} for k, v in by_entity.most_common(8)],
            "retention": "Append-only. No screen or API can edit or delete an audit event."}


def summary(db: Session) -> dict:
    return {"encryption": encryption(db), "tokenisation": tokenisation(db), "traceability": traceability(db),
            "human_review": human_in_the_loop(db), "audit": audit_summary(db), "fairness": fairness.summary(db)}
