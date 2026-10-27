"""Fair treatment: what CARE decides on, and what it refuses to see.

CARE decides from repayment behaviour and engagement only. Attributes that are
protected under fair-lending law (ECOA / Regulation B, the Fair Housing Act)
and the usual proxies for them - ZIP or postcode, address, date of birth - are
never used. If an upstream system sends one, CARE drops it before anything is
stored or scored, and records that it did, so the data owner can stop sending it.
"""
from __future__ import annotations

import json
import re
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

# Identifiers CARE never needs and must never hold: dropped on arrival like the
# protected attributes, and reported separately.
SENSITIVE: dict[str, str] = {
    "ssn": "Social Security number", "socialsecuritynumber": "Social Security number", "sin": "Social insurance number",
    "taxid": "Tax ID", "tin": "Tax ID", "itin": "Tax ID", "ein": "Tax ID", "nationalid": "National ID",
    "nationalidnumber": "National ID", "passport": "Passport number", "passportnumber": "Passport number",
    "driverslicense": "Driver's license number", "driverlicense": "Driver's license number",
    "driverslicensenumber": "Driver's license number", "governmentid": "Government ID",
    "cardnumber": "Card number", "pan": "Card number", "primaryaccountnumber": "Card number",
    "cvv": "Card security code", "cvc": "Card security code", "cvv2": "Card security code",
    "cardexpiry": "Card expiry", "expirydate": "Card expiry", "bankaccountnumber": "Bank account number",
    "accountnumber": "Bank account number", "routingnumber": "Bank routing number", "iban": "Bank account number",
    "sortcode": "Bank routing number", "password": "Password", "pin": "PIN", "otp": "One-time code",
    "securityanswer": "Security answer", "mothersmaidenname": "Security answer",
}

# Values that look like a card number or an SSN are removed from any text field.
_SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_DIGITS = re.compile(r"\b(?:\d[ -]?){13,19}\b")
# Fields that carry Nova's own identifiers: never scanned, so a numeric id is never mistaken for a card.
_ID_FIELDS = {"accountid", "partyid", "customerid", "requestid", "arrangementid", "paymentid", "decisionid"}


def _luhn(number: str) -> bool:
    digits = [int(c) for c in number if c.isdigit()]
    if not 13 <= len(digits) <= 19:
        return False
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


def _sensitive_value(v: str) -> str | None:
    if _SSN.search(v):
        return "Social Security number"
    if any(_luhn(m.group()) for m in _DIGITS.finditer(v)):
        return "Card number"
    return None


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
    clean, protected, _ = scrub_all(raw, path)
    return clean, protected


def scrub_all(raw: Any, path: str = "") -> tuple[Any, list[str], list[str]]:
    """The payload without protected attributes or sensitive identifiers.
    Returns (clean payload, protected paths dropped, sensitive paths dropped)."""
    protected: list[str] = []
    sensitive: list[str] = []
    if isinstance(raw, dict):
        out = {}
        for k, v in raw.items():
            key = _norm(k) if isinstance(k, str) else ""
            if key in PROTECTED:
                protected.append(f"{path}{k}")
                continue
            if key in SENSITIVE:
                sensitive.append(f"{path}{k}")
                continue
            if isinstance(v, str) and key not in _ID_FIELDS and _sensitive_value(v):
                sensitive.append(f"{path}{k}")
                continue
            out[k], p_, s_ = scrub_all(v, f"{path}{k}.")
            protected += p_
            sensitive += s_
        return out, protected, sensitive
    if isinstance(raw, list):
        out_list = []
        for i, v in enumerate(raw):
            if isinstance(v, str) and _sensitive_value(v):
                sensitive.append(f"{path}{i}")
                continue
            clean, p_, s_ = scrub_all(v, f"{path}{i}.")
            out_list.append(clean)
            protected += p_
            sensitive += s_
        return out_list, protected, sensitive
    return raw, protected, sensitive


def summary(db: Session) -> dict:
    """The fairness panel: features used, attributes excluded, and what was dropped."""
    dropped: Counter = Counter()
    sens: Counter = Counter()
    requests = sens_requests = 0
    for (lineage,) in db.query(FeatureSnapshot.source_lineage):
        lin = json.loads(lineage or "{}")
        got = lin.get("protected_dropped") or []
        if got:
            requests += 1
            for path in got:
                dropped[PROTECTED.get(_norm(path.rsplit(".", 1)[-1]), path)] += 1
        got = lin.get("sensitive_dropped") or []
        if got:
            sens_requests += 1
            for path in got:
                sens[SENSITIVE.get(_norm(path.rsplit(".", 1)[-1]), "Sensitive value")] += 1
    excluded = sorted(set(PROTECTED.values()))
    return {
        "features_used": [{"field": f, "label": l, "used_for": u} for f, l, u in FEATURES_USED],
        "guardrail_only": [{"field": f, "label": l} for f, l in GUARDRAIL_ONLY],
        "excluded": excluded,
        "dropped": {"requests": requests, "by_attribute": [{"attribute": a, "count": n} for a, n in dropped.most_common()]},
        "sensitive": sorted(set(SENSITIVE.values())),
        "sensitive_dropped": {"requests": sens_requests,
                              "by_identifier": [{"identifier": a, "count": n} for a, n in sens.most_common()]},
        "policy": "Decisions use repayment behaviour and engagement only. Protected attributes and their proxies, "
                  "including ZIP code and address, are dropped on arrival and never stored or scored.",
    }
