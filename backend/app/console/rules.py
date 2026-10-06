"""Guardrails and eligibility: every rule, for every candidate treatment.

The safe decision space is fixed before any learning happens. Each candidate
treatment of a strategy is checked against every rule below, and every result
is kept - nothing stops at the first failure - so an audit can answer both
"why this treatment" and "why not that one, for every reason".

Stages (all evaluated, in this order):
  playbook   the treatment is active in the playbook
  business   the treatment's own eligibility rules (playbook data, versioned
             with the treatment)
  hard_stop  account level: vulnerability, restrictions, and how fresh the
             restrictions are
  contact    the treatment's channel: consent, opt-out, contact and call caps,
             and how fresh consent and contact history are
  context    arrangement / promise-to-pay context for plan and deferral offers

A treatment is allowed only when every row passes. Thompson sampling then
chooses among the allowed ones.

Fail-closed applies to RecoveryContext v1 requests only. For v0 requests and
console waves the same checks run and are recorded, but missing data keeps
its v0 meaning (no restriction known, consent not withheld) and staleness is
logged as NOT_ENFORCED_V0 rather than blocking - so the existing integration
behaves exactly as before.

What the rules do NOT decide: which restriction stops which treatment, the
freshness limits, and which inputs are critical. Those are compliance's to
approve. The defaults here are the most conservative reading and are marked
as placeholders in Platform Configuration.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from .. import models
from ..scoring import rule_results, treatment_active, treatment_kind, treatment_rules
from .contract import RESTRICTION_FLAGS
from .models import ContactRecord, TreatmentMeta
from .platform import cfg

UTC = timezone.utc
PLATFORM_RULES_VERSION = "platform-rules/1"

DIGITAL = {"SMS", "App push", "SMS + App", "Email"}
# Which consent a channel needs (Nova contract C1). App push and letters have
# no consent flag there; a specialist referral is not a contact.
CONSENT_FOR = {"SMS": "sms", "SMS + App": "sms", "Email": "email", "Outbound call": "call"}

# Guardrail inputs whose freshness is measured: (timestamp key, SLA setting,
# critical = fails closed for v1 when stale or missing).
FRESHNESS = {
    "consent": ("consent_as_of", "freshness_sla_consent_hours", True),
    "contact_history": ("contact_history_as_of", "freshness_sla_contact_history_hours", True),
    "restrictions": ("restrictions_as_of", "freshness_sla_restrictions_hours", True),
    "arrangement": ("arrangement_as_of", "freshness_sla_arrangement_hours", False),
}


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="seconds")


def _parse(ts: str) -> datetime:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)  # a time without a zone is read as UTC


def is_v1(guard: dict) -> bool:
    return guard.get("contract_version") == "v1"


def freshness(db: Session, guard: dict, at: datetime) -> dict:
    """How old each guardrail input is against its SLA. A field without its
    own timestamp falls back to the request's as_of_timestamp."""
    as_of = guard.get("as_of") or {}
    out = {}
    for name, (key, setting, critical) in FRESHNESS.items():
        ts, source = as_of.get(key), key
        if ts is None and as_of.get("as_of_timestamp"):
            ts, source = as_of["as_of_timestamp"], "as_of_timestamp"
        sla = float(cfg(db, setting))
        row = {"as_of": ts, "from": source if ts else None, "sla_hours": sla, "critical": critical,
               "enforced": critical and is_v1(guard), "sla_setting": setting, "sla_status": SLA_STATUS}
        if ts is None:
            row.update(status="missing", age_hours=None)
        else:
            age = max(0.0, (at - _parse(ts)).total_seconds() / 3600)
            row.update(status="stale" if age > sla else "fresh", age_hours=round(age, 1))
        out[name] = row
    return out


# Codes that explain a PASS. Any other code given to a passing rule is the
# code it would have blocked with, so the row records plain OK.
PASS_CODES = {"OK", "NOT_REQUIRED", "NOT_SUPPLIED", "NOT_ENFORCED_V0", "FRESH", "NO_RULES",
              "PENDING_BUSINESS_CONFIRMATION"}
SLA_STATUS = "COMPLIANCE_PLACEHOLDER"  # no freshness limit has been approved yet


def _r(stage: str, rule_id: str, ok: bool, code: str, reason: str, inputs: dict,
       version: str = PLATFORM_RULES_VERSION) -> dict:
    return {"stage": stage, "rule_id": rule_id, "rule_version": version, "result": "PASS" if ok else "BLOCK",
            "reason_code": code if not ok or code in PASS_CODES else "OK", "reason": reason, "input_refs": inputs}


def _fresh_rule(stage: str, name: str, fresh: dict) -> dict:
    f = fresh[name]
    inputs = {"as_of": f["as_of"], "from": f["from"], "age_hours": f["age_hours"], "sla_hours": f["sla_hours"],
              "sla_setting": f["sla_setting"], "sla_status": SLA_STATUS}
    label = name.replace("_", " ")
    rule_id = f"{name.upper()}_FRESHNESS"
    if f["status"] == "fresh":
        return _r(stage, rule_id, True, "FRESH", f"{label.capitalize()} confirmed {f['age_hours']}h ago "
                                                 f"(placeholder limit {f['sla_hours']:g}h, not approved)", inputs)
    code = f"{name.upper()}_STALE" if f["status"] == "stale" else f"{name.upper()}_AS_OF_MISSING"
    what = (f"{label.capitalize()} last confirmed {f['age_hours']}h ago, over the {f['sla_hours']:g}h placeholder "
            f"limit (pending compliance approval)"
            if f["status"] == "stale" else f"No as-of time for {label}")
    if f["enforced"]:
        return _r(stage, rule_id, False, code, what + " - fails closed", inputs)
    return _r(stage, rule_id, True, "NOT_ENFORCED_V0", what + " (logged, not enforced before contract v1)", inputs)


# ---------------------------------------------------------------------------
# Account level
# ---------------------------------------------------------------------------
def account_rules(guard: dict, fresh: dict) -> list[dict]:
    """Hard stops that apply to every treatment alike."""
    v1 = is_v1(guard)
    rows = []
    vul = guard.get("vulnerability_flag")
    if vul is True:
        rows.append(_r("hard_stop", "VULNERABILITY", False, "VULNERABLE",
                       "Vulnerability flag on file: no automated treatment", {"vulnerability_flag": True}))
    elif vul is False:
        rows.append(_r("hard_stop", "VULNERABILITY", True, "OK", "No vulnerability flag", {"vulnerability_flag": False}))
    elif v1:
        rows.append(_r("hard_stop", "VULNERABILITY", False, "VULNERABILITY_MISSING",
                       "Nova did not say whether the customer is vulnerable - fails closed", {"vulnerability_flag": None}))
    else:
        rows.append(_r("hard_stop", "VULNERABILITY", True, "NOT_SUPPLIED",
                       "Not supplied; v0 reads a missing flag as not vulnerable", {"vulnerability_flag": None}))
    restrictions = guard.get("restrictions")
    if restrictions is None:
        rows.append(_r("hard_stop", "RESTRICTIONS", not v1, "RESTRICTIONS_MISSING" if v1 else "NOT_SUPPLIED",
                       "No restrictions block sent - fails closed" if v1 else "Not supplied (v0)",
                       {"restrictions": None}))
    else:
        for flag in RESTRICTION_FLAGS:
            v = restrictions.get(flag)
            rid = f"RESTRICTION.{flag}"
            if v is True:
                rows.append(_r("hard_stop", rid, False, f"RESTRICTION_{flag.upper()}",
                               f"{flag.replace('_', ' ').capitalize()} on file: no automated treatment", {flag: True}))
            elif v is False:
                rows.append(_r("hard_stop", rid, True, "OK", f"No {flag.replace('_', ' ')}", {flag: False}))
            else:
                rows.append(_r("hard_stop", rid, not v1, "RESTRICTION_MISSING" if v1 else "NOT_SUPPLIED",
                               f"{flag.replace('_', ' ').capitalize()} not stated"
                               + (" - fails closed" if v1 else " (v0)"), {flag: None}))
    rows.append(_fresh_rule("hard_stop", "restrictions", fresh))
    return rows


# ---------------------------------------------------------------------------
# Channel level
# ---------------------------------------------------------------------------
def contact_rules(db: Session, customer_id: int | None, channel: str, guard: dict, fresh: dict,
                  at: datetime) -> list[dict]:
    v1 = is_v1(guard)
    rows = []
    need = CONSENT_FOR.get(channel)
    if need is None:
        rows.append(_r("contact", "CONSENT", True, "NOT_REQUIRED", f"{channel} needs no consent flag", {}))
    else:
        val = (guard.get("consent") or {}).get(need)
        key = f"consent.{need}"
        if val is False:
            rows.append(_r("contact", "CONSENT", False, f"NO_{need.upper()}_CONSENT", f"No {need} consent on file",
                           {key: False}))
        elif val is True:
            rows.append(_r("contact", "CONSENT", True, "OK", f"{need.upper()} consent on file", {key: True}))
        elif v1:
            rows.append(_r("contact", "CONSENT", False, "CONSENT_MISSING",
                           f"Nova did not say whether {need} contact is allowed - fails closed", {key: None}))
        else:
            rows.append(_r("contact", "CONSENT", True, "NOT_SUPPLIED", "Not supplied; v0 reads it as not withheld",
                           {key: None}))
        rows.append(_fresh_rule("contact", "consent", fresh))
    # The session runs with autoflush off. Without this, contacts and opt-outs
    # written earlier in the same wave are invisible here.
    db.flush()
    if channel in DIGITAL:
        out = (db.query(ContactRecord).filter(ContactRecord.customer_id == customer_id,
                                              ContactRecord.opted_out.is_(True), ContactRecord.at <= _iso(at)).first())
        rows.append(_r("contact", "OPT_OUT", out is None, "OPTED_OUT",
                       "Customer opted out of digital contact" if out else "No digital opt-out on record",
                       {"opted_out_at": out.at if out else None}))
    else:
        rows.append(_r("contact", "OPT_OUT", True, "NOT_REQUIRED", f"{channel} is not a digital channel", {}))
    recent = (db.query(ContactRecord)
              .filter(ContactRecord.customer_id == customer_id, ContactRecord.at >= _iso(at - timedelta(days=7)),
                      ContactRecord.opted_out.is_(False)).all())
    counts = guard.get("contacts") or {}
    reported = counts.get("total")
    cap = int(cfg(db, "contact_cap_7d"))
    if reported is None and v1:
        rows.append(_r("contact", "CONTACT_CAP", False, "CONTACT_HISTORY_MISSING",
                       "Nova sent no contact counts, so the 7-day cap cannot be checked - fails closed",
                       {"ari_contacts_7d": len(recent), "reported_contacts_7d": None, "cap": cap}))
    else:
        seen = len(recent) + (reported or 0)
        extra = f", {reported} of them reported by the caller" if reported else ""
        rows.append(_r("contact", "CONTACT_CAP", seen < cap, "CONTACT_CAP",
                       f"Contact cap reached ({seen} of {cap} in 7 days{extra})" if seen >= cap
                       else f"{seen} contacts in last 7 days{extra} (cap {cap})",
                       {"ari_contacts_7d": len(recent), "reported_contacts_7d": reported, "cap": cap}))
    rows.append(_fresh_rule("contact", "contact_history", fresh))
    if channel == "Outbound call":
        call_cap = int(cfg(db, "call_cap_7d"))
        ari_calls = sum(1 for r in recent if r.channel == "Outbound call")
        calls = ari_calls + (counts.get("call") or 0)
        rows.append(_r("contact", "CALL_CAP", calls < call_cap, "CALL_CAP",
                       f"Call cap reached ({calls} calls in 7 days)" if calls >= call_cap
                       else f"{calls} calls in 7 days (cap {call_cap})",
                       {"ari_calls_7d": ari_calls, "reported_calls_7d": counts.get("call"), "cap": call_cap}))
    return rows


def context_rules(code: str, guard: dict, db: Session) -> list[dict]:
    """Plan and deferral offers are not made on top of an arrangement in force
    or a pending promise to pay. PENDING_BUSINESS_CONFIRMATION: off by default
    (arrangement_blocks_new_offers). While off it still runs and records what
    it would have done, but always passes."""
    if treatment_kind(code) not in ("Arrangement", "Deferral"):
        return []
    a = guard.get("arrangement")
    if cfg(db, "arrangement_blocks_new_offers") != "true":
        would = ("would block: an arrangement is in force" if a and a.get("active") else
                 "would block: a promise to pay is pending" if a and a.get("promise_to_pay_status") == "PENDING"
                 else "would pass")
        return [_r("context", "ARRANGEMENT", True, "PENDING_BUSINESS_CONFIRMATION",
                   f"Not enforced - pending business confirmation ({would})", {"arrangement": a, "enforced": False})]
    if a is None:
        return [_r("context", "ARRANGEMENT", True, "NOT_SUPPLIED", "No arrangement context sent", {"arrangement": None})]
    if a.get("active"):
        return [_r("context", "ARRANGEMENT", False, "ACTIVE_ARRANGEMENT",
                   f"An arrangement is already in force ({a.get('type') or 'type not given'})", {"arrangement": a})]
    if a.get("promise_to_pay_status") == "PENDING":
        return [_r("context", "ARRANGEMENT", False, "PTP_PENDING",
                   f"A promise to pay is pending{' for ' + a['promise_to_pay_date'] if a.get('promise_to_pay_date') else ''}",
                   {"arrangement": a})]
    return [_r("context", "ARRANGEMENT", True, "OK", "No arrangement or pending promise to pay", {"arrangement": a})]


# ---------------------------------------------------------------------------
# All rules, all candidates
# ---------------------------------------------------------------------------
def evaluate(db: Session, codes: list[str], c, guard: dict, at: datetime) -> tuple[list[str], list[dict], dict]:
    """(allowed treatment codes, one row per rule per treatment, freshness)."""
    fresh = freshness(db, guard, at)
    account = account_rules(guard, fresh)
    rows: list[dict] = []
    allowed: list[str] = []
    for code in codes:
        meta = db.get(TreatmentMeta, code)
        version = f"{code}.rules/v{meta.version if meta else 1}"
        st = db.get(models.Strategy, code)
        channel = st.channel if st else "SMS"
        active = treatment_active(code)
        arm = [_r("playbook", "ACTIVE", bool(active), "TREATMENT_RETIRED" if active is False else "UNKNOWN_TREATMENT",
                  "Active in the playbook" if active else "Retired from the playbook" if active is False
                  else "Not in the playbook", {"status": meta.status if meta else None}, version)]
        results = rule_results(treatment_rules(code), c)
        arm += [_r("business", rule, ok, rc, reason, inputs, version) for rule, ok, rc, reason, inputs in results]
        if not results:
            arm.append(_r("business", "RULES", True, "NO_RULES", "No eligibility rules: everyone qualifies", {}, version))
        arm += [dict(x) for x in account]
        arm += contact_rules(db, c.customer_id, channel, guard, fresh, at)
        arm += context_rules(code, guard, db)
        for x in arm:
            x["arm_id"], x["arm_version"] = code, meta.version if meta else None
        rows += arm
        if all(x["result"] == "PASS" for x in arm):
            allowed.append(code)
    return allowed, rows, fresh


def send_check(db: Session, customer_id: int, channel: str, guard: dict, at: datetime) -> tuple[bool, str]:
    """The contact rules again at send time: (allowed, note). Contacts can
    change between a decision and its send - an offer approved a day later."""
    fresh = freshness(db, guard, at)
    rows = account_rules(guard, fresh) + contact_rules(db, customer_id, channel, guard, fresh, at)
    blocked = [x for x in rows if x["result"] == "BLOCK"]
    if blocked:
        return False, blocked[0]["reason"] + (f" (+{len(blocked) - 1} more)" if len(blocked) > 1 else "")
    cap = next(x for x in rows if x["rule_id"] == "CONTACT_CAP")
    return True, f"{cap['reason']}; consent and opt-out checked"


def blocked_summary(rows: list[dict]) -> list[dict]:
    """Every treatment that is not allowed, with all its reasons."""
    out: dict[str, dict] = {}
    for x in rows:
        if x["result"] != "BLOCK":
            continue
        b = out.setdefault(x["arm_id"], {"code": x["arm_id"], "reasons": []})
        b["reasons"].append({"rule_id": x["rule_id"], "reason_code": x["reason_code"], "reason": x["reason"]})
    for b in out.values():
        b["reason_code"], b["reason"] = b["reasons"][0]["reason_code"], b["reasons"][0]["reason"]
    return list(out.values())


def exclusion_action(rows: list[dict]) -> str:
    """When no treatment is allowed: the action that best describes why, most
    serious first."""
    codes = {x["reason_code"] for x in rows if x["result"] == "BLOCK"}
    if "VULNERABLE" in codes:
        return "refer_to_specialist"
    if any(c.startswith("RESTRICTION_") and c != "RESTRICTION_MISSING" for c in codes):
        return "restricted"
    if any(c.endswith("_MISSING") or c.endswith("_STALE") for c in codes):
        return "blocked_stale_data"
    return "contact_blocked"
