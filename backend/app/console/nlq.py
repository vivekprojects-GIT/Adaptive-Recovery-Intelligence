"""Questions about the account portfolio in plain English, turned into query
conditions.

A person types what they are looking for, for example "consumer card accounts
over 60 days past due with a balance above $5,000 who use the app". This module
reads the question into conditions on known account fields, shows the same
conditions as SQL so it is clear what will run, and applies them to the
accounts. Only the fields and comparisons listed here can be queried, so a
question can never become arbitrary SQL; anything it does not recognise is
reported back rather than guessed.

The reading is rule-based: it knows the words the bank uses for each field.
"""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy import and_

from .. import models
from ..seed import PRODUCTS

C = models.Customer
GROUPS = {"Persuadable": "Likely responsive", "Sure Thing": "Likely self-cure", "Lost Cause": "Needs support",
          "Sleeping Dog": "Do not contact"}
ROUTES = {"strategy": "In a strategy", "bau": "Business as usual", "hardship": "Hardship team",
          "suppress": "Not contacted"}
BANDS = ["Low", "Medium", "High", "Very high"]
COHORTS = ["C1", "C2", "C3", "C4"]

# field: (column, label, kind, allowed values for an enum)
FIELDS: dict[str, tuple[Any, str, str, list[str] | None]] = {
    "product": (C.product, "Card business", "enum", PRODUCTS),
    "days_past_due": (C.days_past_due, "Days past due", "int", None),
    "balance": (C.balance, "Total balance", "money", None),
    "delinquent_amount": (C.delinquent_amount, "Delinquent amount", "money", None),
    "credit_limit": (C.credit_limit, "Credit limit", "money", None),
    "client_risk_band": (C.client_risk_band, "Bank risk band", "enum", BANDS),
    "cohort_id": (C.cohort_id, "Cohort", "enum", COHORTS),
    "segment": (C.segment, "Fit group", "enum", list(GROUPS)),
    "route": (C.route, "Route", "enum", list(ROUTES)),
    "hardship_flag": (C.hardship_flag, "Hardship flag", "bool", None),
    "app_user": (C.app_user, "Uses the app", "bool", None),
    "sms_responsive": (C.sms_responsive, "Replies to texts", "bool", None),
    "missed_payments": (C.missed_payments, "Missed payments, last 12 months", "int", None),
    "tenure_years": (C.tenure_years, "Years as a customer", "int", None),
    "utilization": (C.utilization, "Credit utilisation", "share", None),
    "payment_history": (C.payment_history, "On-time payment ratio", "share", None),
}
OPS = {"=", "in", ">", ">=", "<", "<=", "between"}
OP_WORDS = {">": "over", ">=": "at least", "<": "under", "<=": "at most", "=": "is", "in": "is"}

NUM = r"\$?\s*(\d+(?:\.\d+)?)\s*(k|m|thousand|million)?\b"
CMP = (r"(more than|greater than|over|above|exceeding|at least|minimum of|no less than|"
       r"less than|fewer than|under|below|at most|up to|maximum of|no more than|>=|<=|>|<)")
CMP_OP = {"more than": ">", "greater than": ">", "over": ">", "above": ">", "exceeding": ">", ">": ">",
          "at least": ">=", "minimum of": ">=", "no less than": ">=", ">=": ">=",
          "less than": "<", "fewer than": "<", "under": "<", "below": "<", "<": "<",
          "at most": "<=", "up to": "<=", "maximum of": "<=", "no more than": "<=", "<=": "<="}


def _num(value: str, unit: str | None) -> float:
    v = float(value)
    return v * 1_000 if unit in ("k", "thousand") else v * 1_000_000 if unit in ("m", "million") else v


def _clean(v: float) -> float | int:
    return int(v) if float(v).is_integer() else v


class Reader:
    """Reads one question, taking out each phrase it recognises."""

    def __init__(self, question: str):
        self.text = " " + re.sub(r"(?<=\d),(?=\d{3})", "", question.lower()).replace("’", "'") + " "
        self.conditions: list[dict] = []

    def take(self, pattern: str) -> re.Match | None:
        m = re.search(pattern, self.text)
        if m:
            self.text = self.text[:m.start()] + " " + self.text[m.end():]
        return m

    def add(self, field: str, op: str, value: Any) -> None:
        if not any(c["field"] == field for c in self.conditions):
            self.conditions.append({"field": field, "op": op, "value": value})

    def compare(self, field: str, lead: str, money: bool = False, share: bool = False, trail: str = "") -> None:
        """'<lead> between A and B', '<lead> over N', 'N+ <trail>' and similar."""
        scale = (lambda v: v / 100) if share else (lambda v: v)
        m = self.take(rf"{lead}\s*(?:is\s*|of\s*)?between\s*{NUM}\s*(?:and|to|-)\s*{NUM}{trail}")
        if m:
            self.add(field, "between", [_clean(scale(_num(m.group(1), m.group(2)))), _clean(scale(_num(m.group(3), m.group(4))))])
            return
        m = self.take(rf"{lead}\s*(?:is\s*|of\s*)?{CMP}\s*{NUM}%?{trail}")
        if m:
            self.add(field, CMP_OP[m.group(1)], _clean(scale(_num(m.group(2), m.group(3)))))


def read(question: str) -> dict:
    """The conditions a question asks for, what was not understood, and the SQL."""
    r = Reader(question)

    # Days past due: "over 60 days past due", "90+ dpd", "between 30 and 60 days late".
    days = r"\s*(?:days?|dpd)(?:\s*(?:past due|late|overdue|delinquent|behind))?"
    m = r.take(rf"between\s*(\d+)\s*(?:and|to|-)\s*(\d+){days}")
    if m:
        r.add("days_past_due", "between", [int(m.group(1)), int(m.group(2))])
    m = r.take(rf"{CMP}\s*(\d+){days}")
    if m:
        r.add("days_past_due", CMP_OP[m.group(1)], int(m.group(2)))
    m = r.take(r"(\d+)\s*(?:\+|or\s*more|and\s*(?:above|over))\s*(?:days?|dpd)")
    if m:
        r.add("days_past_due", ">=", int(m.group(1)))
    m = r.take(r"(\d+)\s*(?:or\s*(?:fewer|less)|and\s*(?:below|under))\s*(?:days?|dpd)")
    if m:
        r.add("days_past_due", "<=", int(m.group(1)))

    # Money fields, most specific first.
    r.compare("delinquent_amount", r"(?:delinquent|past[- ]due|overdue|arrears)\s*(?:amount|balance)?")
    r.compare("credit_limit", r"(?:credit\s*)?limit")
    r.compare("balance", r"(?:total\s*)?(?:balance|owes?|owing|outstanding)")
    m = r.take(rf"{CMP}\s*{NUM}\s*(?:total\s*)?balance")
    if m:
        r.add("balance", CMP_OP[m.group(1)], _clean(_num(m.group(2), m.group(3))))

    # Shares and counts.
    r.compare("utilization", r"utili[sz]ation", share=True)
    r.compare("payment_history", r"on[- ]time\s*(?:payment)?\s*(?:ratio|rate|history)?", share=True)
    if r.take(r"\b(?:no|zero|without)\s+missed\s+payments?"):
        r.add("missed_payments", "=", 0)
    m = r.take(rf"{CMP}\s*(\d+)\s*missed\s*payments?") or r.take(rf"missed\s*{CMP}\s*(\d+)\s*payments?")
    if m:
        r.add("missed_payments", CMP_OP[m.group(1)], int(m.group(2)))
    m = r.take(r"(\d+)\s*(\+|or\s*more|or\s*fewer|or\s*less)\s*missed\s*payments?")
    if m:
        r.add("missed_payments", ">=" if m.group(2) in ("+", "or more") or "more" in m.group(2) else "<=", int(m.group(1)))
    m = r.take(rf"(?:customers?\s*for|tenure(?:\s*of)?|with\s*(?:us|the bank)\s*for|been\s*with\s*us\s*for)\s*{CMP}?\s*(\d+)\s*\+?\s*years?")
    if m:
        r.add("tenure_years", CMP_OP.get(m.group(1) or "", ">="), int(m.group(2)))

    # Card business.
    cards = []
    for pattern, name in ((r"small[- ]business|business\s*cards?|\bsb\b", "Small Business Card"),
                          (r"co[- ]?brand(?:ed)?", "Co-Brand Card"), (r"\bretail", "Retail Card"),
                          (r"\bconsumer", "Consumer Credit Card")):
        if r.take(pattern):
            cards.append(name)
    if cards:
        r.add("product", "in" if len(cards) > 1 else "=", cards if len(cards) > 1 else cards[0])

    # The bank's risk band and cohort.
    bands = []
    for pattern, name in ((r"very\s*high[- ]risk", "Very high"), (r"\bhigh[- ]risk", "High"),
                          (r"medium[- ]risk|moderate[- ]risk", "Medium"), (r"low[- ]risk", "Low")):
        if r.take(pattern):
            bands.append(name)
    if bands:
        r.add("client_risk_band", "in" if len(bands) > 1 else "=", bands if len(bands) > 1 else bands[0])
    found = [f"C{n}" for n in re.findall(r"\bc([1-4])\b", r.text)]
    if found:
        r.take(r"\bc[1-4](?:\s*(?:,|and|or)\s*c[1-4])*\b")
        r.add("cohort_id", "in" if len(found) > 1 else "=", found if len(found) > 1 else found[0])

    # CARE's fit group and route.
    for pattern, group in ((r"likely\s*(?:to\s*)?respon\w*|persuadable", "Persuadable"),
                           (r"self[- ]?cure|sure\s*things?|pay\s*(?:anyway|on\s*their\s*own)", "Sure Thing"),
                           (r"needs?\s*support|lost\s*causes?", "Lost Cause"),
                           (r"do\s*not\s*contact|sleeping\s*dogs?", "Sleeping Dog")):
        if r.take(pattern):
            r.add("segment", "=", group)
    for pattern, route in ((r"in\s*an?\s*(?:care\s*)?strateg(?:y|ies)|in\s*strateg(?:y|ies)", "strategy"),
                           (r"business\s*as\s*usual|\bbau\b", "bau"), (r"hardship\s*team", "hardship"),
                           (r"not\s*contacted|suppressed", "suppress")):
        if r.take(pattern):
            r.add("route", "=", route)

    # Yes or no flags.
    if r.take(r"(?:not|no|without)\s+(?:in\s+|a\s+)?hardship(?:\s*flag)?"):
        r.add("hardship_flag", "=", False)
    elif r.take(r"(?:in\s+)?hardship(?:\s*flag)?"):
        r.add("hardship_flag", "=", True)
    if r.take(r"(?:don'?t|do\s*not|doesn'?t|does\s*not|never|not)\s+use\s+(?:the\s+)?(?:mobile\s+)?app|non[- ]app"):
        r.add("app_user", "=", False)
    elif r.take(r"app\s*users?|use\s+(?:the\s+)?(?:mobile\s+)?app|using\s+the\s+app|on\s+the\s+app"):
        r.add("app_user", "=", True)
    if r.take(r"(?:don'?t|do\s*not|doesn'?t|never|not)\s+(?:respond|reply|answer)\w*\s+to\s+(?:sms|texts?)"):
        r.add("sms_responsive", "=", False)
    elif r.take(r"(?:respond|reply|answer)\w*\s+to\s+(?:sms|texts?)|sms[- ]responsive|text\s*responders?"):
        r.add("sms_responsive", "=", True)

    # Words that only frame the question are fine to leave; anything else was not understood.
    left = re.sub(r"\b(show|me|find|list|give|get|all|the|a|an|accounts?|customers?|people|cards?|card|holders?|"
                  r"with|who|whose|that|are|is|have|has|and|or|in|on|of|for|to|by|their|they|them|which|where|"
                  r"any|our|we|please|account|from|plus|than|it|still|also|currently|only|those|these|"
                  r"credit|business|book|portfolio|segment|group|days?|past|due)\b", " ", r.text)
    left = re.sub(r"[^a-z0-9$%+.\- ]", " ", left)
    unread = " ".join(left.split())
    return {"conditions": r.conditions, "not_understood": unread or None,
            "sql": to_sql(r.conditions), "labels": [describe(c) for c in r.conditions]}


def validate(conditions: Any) -> list[dict]:
    """Conditions from a request, checked against the fields and comparisons
    allowed. Raises ValueError with the reason."""
    if not isinstance(conditions, list):
        raise ValueError("Conditions must be a list.")
    out = []
    for c in conditions:
        if not isinstance(c, dict) or c.get("field") not in FIELDS or c.get("op") not in OPS:
            raise ValueError(f"Not a condition this portfolio can be queried by: {c}")
        _, label, kind, options = FIELDS[c["field"]]
        op, v = c["op"], c.get("value")
        if kind in ("enum",):
            vals = v if op == "in" else [v]
            if op not in ("=", "in") or not isinstance(vals, list) or any(x not in (options or []) for x in vals):
                raise ValueError(f"{label} must be one of: {', '.join(options or [])}.")
        elif kind == "bool":
            if op != "=" or not isinstance(v, bool):
                raise ValueError(f"{label} is yes or no.")
        else:
            nums = v if op == "between" else [v]
            if op in ("in",) or not isinstance(nums, list) or len(nums) != (2 if op == "between" else 1) \
                    or not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in nums):
                raise ValueError(f"{label} needs a number to compare with.")
        out.append({"field": c["field"], "op": op, "value": v})
    return out


def apply(query, conditions: list[dict]):
    """The accounts query, narrowed by validated conditions."""
    parts = []
    for c in validate(conditions):
        col, v, op = FIELDS[c["field"]][0], c["value"], c["op"]
        parts.append(col.in_(v) if op == "in" else col.between(v[0], v[1]) if op == "between" else
                     col == v if op == "=" else col > v if op == ">" else col >= v if op == ">=" else
                     col < v if op == "<" else col <= v)
    return query.filter(and_(*parts)) if parts else query


def _sql_value(v: Any) -> str:
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    return str(_clean(v))


def to_sql(conditions: list[dict]) -> str:
    """The conditions as the SQL they amount to, for people to read."""
    where = []
    for c in conditions:
        f, op, v = c["field"], c["op"], c["value"]
        if op == "in":
            where.append(f"{f} IN ({', '.join(_sql_value(x) for x in v)})")
        elif op == "between":
            where.append(f"{f} BETWEEN {_sql_value(v[0])} AND {_sql_value(v[1])}")
        else:
            where.append(f"{f} {op} {_sql_value(v)}")
    return ("SELECT account_number, name, product, balance, delinquent_amount, days_past_due\nFROM accounts"
            + (f"\nWHERE {where[0]}" + "".join(f"\n  AND {w}" for w in where[1:]) if where else ""))


def describe(c: dict) -> str:
    """One condition in words, for a chip on screen."""
    _, label, kind, _ = FIELDS[c["field"]]
    op, v = c["op"], c["value"]
    show = {"enum": lambda x: GROUPS.get(x) or ROUTES.get(x) or x,
            "money": lambda x: f"${x:,.0f}", "share": lambda x: f"{x * 100:.0f}%"}.get(kind, lambda x: f"{x:,}")
    if kind == "bool":
        return f"{label}: {'yes' if v else 'no'}"
    if op == "in":
        return f"{label}: {', '.join(show(x) for x in v)}"
    if op == "between":
        return f"{label}: {show(v[0])} to {show(v[1])}"
    if op == "=":
        return f"{label}: {show(v)}"
    return f"{label} {OP_WORDS[op]} {show(v)}"
