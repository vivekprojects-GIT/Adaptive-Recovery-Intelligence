"""Fair treatment: what ARI decides on, and what it refuses to see.

ARI decides from repayment behaviour and engagement only. Attributes that are
protected under fair-lending law (ECOA / Regulation B, the Fair Housing Act)
and the usual proxies for them - ZIP or postcode, address, date of birth - are
never used. If an upstream system sends one, ARI drops it before anything is
stored or scored, and records that it did, so the data owner can stop sending it.
"""
from __future__ import annotations

import json
from collections import Counter
from typing import Any

from sqlalchemy.orm import Session

from .models import FeatureSnapshot

# Matched on the field name with case, spaces, dashes and underscores removed.
PROTECTED: dict[str, str] = {
    "zip": "ZIP code", "zipcode": "ZIP code", "zip5": "ZIP code", "postcode": "Postcode", "postalcode": "Postcode",
    "address": "Address", "addressline1": "Address", "addressline2": "Address", "street": "Address",
    "city": "City", "county": "County", "censustract": "Census tract", "latitude": "Location", "longitude": "Location",
    "geolocation": "Location", "age": "Age", "dateofbirth": "Date of birth", "dob": "Date of birth",
    "birthdate": "Date of birth", "gender": "Gender", "sex": "Sex", "race": "Race", "ethnicity": "Ethnicity",
    "religion": "Religion", "maritalstatus": "Marital status", "nationality": "National origin",
    "nationalorigin": "National origin", "citizenship": "Citizenship", "disability": "Disability",
    "pregnancy": "Pregnancy", "sexualorientation": "Sexual orientation", "publicassistance": "Public assistance",
    "firstlanguage": "Language", "primarylanguage": "Language",
}

# What the Propensity Router and the treatment rules actually read.
FEATURES_USED = [
    ("days_past_due", "Days past due", "Delinquency bucket, treatment eligibility"),
    ("balance", "Balance", "Review threshold, payment-plan eligibility"),
    ("missed_payments", "Missed payments, last 12 months", "Fit group, payment-plan eligibility"),
    ("payment_history", "On-time payment ratio", "Fit group, deferral eligibility"),
    ("tenure_years", "Years as a customer", "Fit group, deferral eligibility"),
    ("utilization", "Credit utilisation", "Fit group"),
    ("sms_responsive", "Has answered SMS before", "Fit group, channel choice"),
    ("app_user", "Active app user", "Fit group, channel choice"),
    ("hardship_flag", "Hardship on file", "Fit group, hardship routing"),
    ("product", "Product", "Arrears calculation, agency matching"),
]

# Used only to stop or limit contact, never to choose a treatment.
GUARDRAIL_ONLY = [
    ("consent", "Consent by channel"), ("restrictions", "Legal restrictions (bankruptcy, cease contact, ...)"),
    ("vulnerability_flag", "Vulnerable customer"), ("contacts_last_7d", "Contacts by other systems"),
    ("timezone", "Time zone (send window)"),
]


def _norm(key: str) -> str:
    return "".join(ch for ch in key.lower() if ch.isalnum())


def scrub(raw: Any, path: str = "") -> tuple[Any, list[str]]:
    """The payload without protected attributes, and the paths that were dropped."""
    dropped: list[str] = []
    if isinstance(raw, dict):
        out = {}
        for k, v in raw.items():
            if isinstance(k, str) and _norm(k) in PROTECTED:
                dropped.append(f"{path}{k}")
                continue
            out[k], sub = scrub(v, f"{path}{k}.")
            dropped += sub
        return out, dropped
    if isinstance(raw, list):
        out_list = []
        for i, v in enumerate(raw):
            clean, sub = scrub(v, f"{path}{i}.")
            out_list.append(clean)
            dropped += sub
        return out_list, dropped
    return raw, dropped


def summary(db: Session) -> dict:
    """The fairness panel: features used, attributes excluded, and what was dropped."""
    dropped: Counter = Counter()
    requests = 0
    for (lineage,) in db.query(FeatureSnapshot.source_lineage):
        got = json.loads(lineage or "{}").get("protected_dropped") or []
        if got:
            requests += 1
            for path in got:
                dropped[PROTECTED.get(_norm(path.rsplit(".", 1)[-1]), path)] += 1
    excluded = sorted(set(PROTECTED.values()))
    return {
        "features_used": [{"field": f, "label": l, "used_for": u} for f, l, u in FEATURES_USED],
        "guardrail_only": [{"field": f, "label": l} for f, l in GUARDRAIL_ONLY],
        "excluded": excluded,
        "dropped": {"requests": requests, "by_attribute": [{"attribute": a, "count": n} for a, n in dropped.most_common()]},
        "policy": "Decisions use repayment behaviour and engagement only. Protected attributes and their proxies, "
                  "including ZIP code and address, are dropped on arrival and never stored or scored.",
    }
