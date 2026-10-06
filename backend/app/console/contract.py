"""RecoveryContext: the integration contract between Nova and ARI.

Nova (Vishal's platform) owns what is true about a customer and resolves it
from the bank's source systems. ARI owns the decision. This module is the
whole boundary between them: what Nova may send, how each version is read,
and what ARI records about what it received. ARI keeps no copy of Nova's
source layers - only the context of each request, frozen with the decision.

Two versions, both accepted:

  v0  the flat account ARI has accepted since the first MCP release
      (NovaAccount, sent as `account`). Unchanged; nothing new is required.
      Freshness is measured and logged but never blocks a decision.
  v1  the nested RecoveryContext (RecoveryContextV1, sent as `context`):
      request id, as-of time, party, account, delinquency, arrangement,
      per-channel contact context, restrictions and freshness timestamps.
      Critical guardrail data that is missing or stale fails closed.

Both are normalised to one NovaAccount, so the engine has a single input.
What ARI cannot use is never silently lost: unknown fields, aliases used and
values it had to assume are all recorded with the decision.
"""
from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, PrivateAttr, field_validator, model_validator

FEATURE_SET_VERSION = "ari-features/1"

RESTRICTION_FLAGS = ("cease_communication", "bankruptcy", "attorney_represented", "deceased",
                     "scra_protected", "dispute_pending", "agency_placed")

# Accepted and stored with the decision, but not used to decide. Listed back
# so nobody assumes ARI acted on them.
LINEAGE_ONLY = ("customer_id", "risk_score", "product", "account_status", "source_system", "party_segment",
                "delinquency_bucket", "preferred_channel")


def _tz(v: str | None) -> str | None:
    if v is None:
        return v
    try:
        ZoneInfo(v)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError(f"Unknown time zone '{v}'. Use an IANA name such as America/Chicago.")
    return v


class _Input(BaseModel):
    """Keeps the raw input it was built from, so ARI can record exactly what
    was sent, which aliases were used and which fields it ignored."""
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    _raw: Any = PrivateAttr(default=None)

    @model_validator(mode="wrap")
    @classmethod
    def _keep_raw(cls, data, handler):
        obj = handler(data)
        if isinstance(data, dict):
            obj._raw = json.loads(json.dumps(data, default=str))
        return obj


# ---------------------------------------------------------------------------
# Building blocks shared by v0 and v1
# ---------------------------------------------------------------------------
class Consent(_Input):
    sms: bool | None = Field(None, validation_alias=AliasChoices("sms", "sms_allowed"),
                             description="May ARI send SMS? false blocks SMS and SMS + App treatments.")
    email: bool | None = Field(None, validation_alias=AliasChoices("email", "email_allowed"),
                               description="May ARI send email?")
    call: bool | None = Field(None, validation_alias=AliasChoices("call", "call_allowed"),
                              description="May ARI call? false blocks agent-call treatments.")


class ContactCounts(_Input):
    """Contacts in the last 7 days made by systems other than ARI, by channel."""
    sms: int | None = Field(None, ge=0, validation_alias=AliasChoices("sms", "recent_sms"))
    email: int | None = Field(None, ge=0, validation_alias=AliasChoices("email", "recent_email"))
    call: int | None = Field(None, ge=0, validation_alias=AliasChoices("call", "calls", "recent_calls"))
    other: int | None = Field(None, ge=0, validation_alias=AliasChoices("other", "recent_other"),
                              description="Letters, visits and anything else that counts toward the cap.")


class Arrangement(_Input):
    active: bool | None = Field(None, description="An arrangement (plan, deferral) is in force.")
    type: str | None = Field(None, max_length=40, description="e.g. PAYMENT_PLAN, DEFERRAL.")
    promise_to_pay_status: Literal["NONE", "PENDING", "KEPT", "BROKEN"] | None = None
    promise_to_pay_date: date | None = None
    promise_to_pay_amount: float | None = Field(None, ge=0)


class Restrictions(_Input):
    """Hard-stop flags. Any true flag stops automated treatment. Which of them
    should stop which treatments is for compliance to approve; until then the
    most conservative reading applies: all of them stop everything."""
    cease_communication: bool | None = None
    bankruptcy: bool | None = None
    attorney_represented: bool | None = None
    deceased: bool | None = None
    scra_protected: bool | None = None
    dispute_pending: bool | None = None
    agency_placed: bool | None = None


class DataFreshness(_Input):
    """When each guardrail input was last confirmed true in Nova."""
    consent_as_of: datetime | None = None
    contact_history_as_of: datetime | None = None
    restrictions_as_of: datetime | None = None
    arrangement_as_of: datetime | None = None


# ---------------------------------------------------------------------------
# v0: the flat account (the normalised form of every request)
# ---------------------------------------------------------------------------
class NovaAccount(_Input):
    """One delinquent account as Nova describes it (data contract C1-C6).
    Only account_id, days_past_due and current_balance are required; anything
    missing is filled with a stated, conservative default and listed back.
    The v1 fields at the end are optional here; a v1 caller sends `context`."""

    contract_version: Literal["v0", "v1"] = Field("v0", description="v0 unless the request came as a v1 context.")
    request_id: str | None = Field(None, max_length=64, description="The caller's id for this request. A repeated "
                                                                     "request_id returns the decision already made.")
    account_id: str = Field(min_length=1, max_length=64,
                            description="Nova account id. The key for every later call: outcome reports and look-ups.")
    customer_id: str | None = Field(None, max_length=64, validation_alias=AliasChoices("customer_id", "party_id"),
                                    description="Nova party (customer) id, if it differs from the account.")
    customer_name: str | None = Field(None, max_length=60,
                                      description="Optional. Only used to greet the customer; never needed to decide.")
    days_past_due: int = Field(ge=0, le=720, description="Days past due on the as-of date (C3).")
    current_balance: float = Field(ge=0, validation_alias=AliasChoices("current_balance", "balance"),
                                   description="Outstanding balance (C2).")
    credit_limit: float | None = Field(None, gt=0, description="Credit limit (C2), for utilisation.")
    amount_past_due: float | None = Field(None, ge=0, description="Arrears amount (C3). Quoted in messages; never "
                                                                  "estimated when missing.")
    opened_date: date | None = Field(None, description="Account opened date (C2). Gives tenure.")
    prior_delinquencies_12m: int | None = Field(None, ge=0, le=12,
                                                description="Missed payments in the last 12 months (C3).")
    on_time_payment_ratio: float | None = Field(None, ge=0, le=1,
                                                description="Share of the last 12 months' payments made on time (C4).")
    risk_segment: Literal["Low", "Medium", "High", "Very high"] | None = Field(
        None, description="The bank's own risk band (C1). ARI does not recompute it.")
    risk_score: float | None = Field(None, ge=0, le=100,
                                     description="The bank's risk score on a 0-100 scale, higher is riskier. Stored, "
                                                 "not used to decide.")
    preferred_channel: str | None = Field(None, description="C1 preferred channel, e.g. App, SMS, Email, Phone.")
    app_user: bool | None = Field(None, description="Active mobile-app user (C6 AppLogin signals).")
    sms_responsive: bool | None = Field(None, description="Has responded to SMS before (C5 outcomes).")
    hardship_flag: bool | None = Field(None, description="A hardship indicator is on file.")
    vulnerability_flag: bool | None = Field(None, description="C1. A vulnerable customer is never contacted by an "
                                                              "automated treatment; ARI refers them to a person. In "
                                                              "v0 a missing flag means not vulnerable.")
    consent: Consent | None = Field(None, description="C1 consent by channel.")
    contacts_last_7d: int | None = Field(None, ge=0, description="Contacts in the last 7 days made by systems other "
                                                                 "than ARI (C5 counts). Counted against the contact cap.")
    as_of_timestamp: datetime | None = Field(None, description="When the data was true in Nova.")
    source_system: str | None = Field(None, max_length=40, description="Nova's source system (lineage).")
    # v1 additions - optional in v0.
    product: str | None = Field(None, max_length=40, validation_alias=AliasChoices("product", "product_type"))
    account_status: str | None = Field(None, max_length=30, description="Stored, not used to decide.")
    cycles_delinquent: int | None = Field(None, ge=0, le=24)
    party_segment: str | None = Field(None, max_length=40, validation_alias=AliasChoices("party_segment",
                                                                                         "customer_segment"))
    delinquency_bucket: str | None = Field(None, max_length=20)
    arrangement: Arrangement | None = None
    timezone: str | None = Field(None, description="IANA time zone, e.g. America/Chicago. Send times use it.")
    contacts_by_channel: ContactCounts | None = None
    restrictions: Restrictions | None = None
    data_freshness: DataFreshness | None = None

    @field_validator("timezone")
    @classmethod
    def _check_timezone(cls, v):
        return _tz(v)


# ---------------------------------------------------------------------------
# v1: the nested RecoveryContext
# ---------------------------------------------------------------------------
class PartyV1(_Input):
    party_id: str | None = Field(None, max_length=64)
    name: str | None = Field(None, max_length=60, description="Only used to greet the customer.")
    segment: str | None = Field(None, max_length=40, validation_alias=AliasChoices("segment", "customer_segment"),
                                description="Stored, not used to decide.")


class AccountV1(_Input):
    account_id: str = Field(min_length=1, max_length=64)
    product: str | None = Field(None, max_length=40, validation_alias=AliasChoices("product", "product_type"))
    status: str | None = Field(None, max_length=30, description="Stored, not used to decide.")
    current_balance: float = Field(ge=0, validation_alias=AliasChoices("current_balance", "balance"))
    credit_limit: float | None = Field(None, gt=0)
    opened_date: date | None = None


class DelinquencyV1(_Input):
    days_past_due: int = Field(ge=0, le=720, validation_alias=AliasChoices("days_past_due", "dpd"))
    amount_past_due: float | None = Field(None, ge=0)
    cycles_delinquent: int | None = Field(None, ge=0, le=24)
    prior_delinquencies_12m: int | None = Field(None, ge=0, le=12)
    on_time_payment_ratio: float | None = Field(None, ge=0, le=1)
    bucket: str | None = Field(None, max_length=20, validation_alias=AliasChoices("bucket", "delinquency_bucket"))


class RiskV1(_Input):
    segment: Literal["Low", "Medium", "High", "Very high"] | None = Field(
        None, validation_alias=AliasChoices("segment", "risk_segment"))
    score: float | None = Field(None, ge=0, le=100, validation_alias=AliasChoices("score", "risk_score"))


class BehaviorV1(_Input):
    app_user: bool | None = None
    sms_responsive: bool | None = None
    hardship_flag: bool | None = None
    preferred_channel: str | None = None


class ContactContextV1(_Input):
    timezone: str | None = None
    sms_allowed: bool | None = Field(None, validation_alias=AliasChoices("sms_allowed", "sms"))
    email_allowed: bool | None = Field(None, validation_alias=AliasChoices("email_allowed", "email"))
    call_allowed: bool | None = Field(None, validation_alias=AliasChoices("call_allowed", "call"))
    recent_sms: int | None = Field(None, ge=0)
    recent_email: int | None = Field(None, ge=0)
    recent_calls: int | None = Field(None, ge=0)
    recent_other: int | None = Field(None, ge=0)
    contacts_last_7d: int | None = Field(None, ge=0, description="Total, if Nova counts it. Otherwise the sum of "
                                                                 "the per-channel counts is used.")

    @field_validator("timezone")
    @classmethod
    def _check_timezone(cls, v):
        return _tz(v)


class RestrictionsV1(Restrictions):
    vulnerable: bool | None = Field(None, validation_alias=AliasChoices("vulnerable", "vulnerability_flag"))


class RecoveryContextV1(_Input):
    """RecoveryContext v1: one account's point-in-time recovery context, as
    resolved by Nova. request_id, as_of_timestamp, account and delinquency are
    required. Missing or stale consent, contact history or restrictions block
    the affected treatments rather than being assumed safe."""
    contract_version: Literal["v1"] = "v1"
    request_id: str = Field(min_length=1, max_length=64)
    as_of_timestamp: datetime
    source_system: str | None = Field(None, max_length=40)
    party: PartyV1 | None = None
    account: AccountV1
    delinquency: DelinquencyV1
    risk: RiskV1 | None = None
    behavior: BehaviorV1 | None = None
    arrangement: Arrangement | None = None
    contact_context: ContactContextV1 | None = None
    restrictions: RestrictionsV1 | None = None
    data_freshness: DataFreshness | None = None

    def to_account(self) -> NovaAccount:
        party, risk = self.party or PartyV1(), self.risk or RiskV1()
        beh, cc, d, a = self.behavior or BehaviorV1(), self.contact_context, self.delinquency, self.account
        consent = counts = None
        if cc is not None:
            consent = Consent(sms=cc.sms_allowed, email=cc.email_allowed, call=cc.call_allowed)
            counts = ContactCounts(sms=cc.recent_sms, email=cc.recent_email, call=cc.recent_calls,
                                   other=cc.recent_other)
        total = None
        if cc is not None:
            parts = [x for x in (cc.recent_sms, cc.recent_email, cc.recent_calls, cc.recent_other) if x is not None]
            total = cc.contacts_last_7d if cc.contacts_last_7d is not None else (sum(parts) if parts else None)
        r = self.restrictions
        return NovaAccount(
            contract_version="v1", request_id=self.request_id, account_id=a.account_id,
            customer_id=party.party_id, customer_name=party.name, days_past_due=d.days_past_due,
            current_balance=a.current_balance, credit_limit=a.credit_limit, amount_past_due=d.amount_past_due,
            opened_date=a.opened_date, prior_delinquencies_12m=d.prior_delinquencies_12m,
            on_time_payment_ratio=d.on_time_payment_ratio, risk_segment=risk.segment, risk_score=risk.score,
            preferred_channel=beh.preferred_channel, app_user=beh.app_user, sms_responsive=beh.sms_responsive,
            hardship_flag=beh.hardship_flag, vulnerability_flag=r.vulnerable if r else None, consent=consent,
            contacts_last_7d=total, as_of_timestamp=self.as_of_timestamp, source_system=self.source_system,
            product=a.product, account_status=a.status, cycles_delinquent=d.cycles_delinquent,
            party_segment=party.segment, delinquency_bucket=d.bucket, arrangement=self.arrangement,
            timezone=cc.timezone if cc else None, contacts_by_channel=counts,
            restrictions=Restrictions(**{k: getattr(r, k) for k in RESTRICTION_FLAGS}) if r else None,
            data_freshness=self.data_freshness)


# ---------------------------------------------------------------------------
# What was received
# ---------------------------------------------------------------------------
class Received(BaseModel):
    """A request, normalised, with the record of how it was read."""
    account: NovaAccount
    raw: dict
    ignored_fields: list[str]
    aliases_used: list[str]


def _inspect(model: BaseModel, raw: Any, path: str, ignored: list[str], aliases: list[str]) -> None:
    if not isinstance(raw, dict):
        return
    seen: set[str] = set()
    for name, f in type(model).model_fields.items():
        keys = [name]
        if isinstance(f.validation_alias, AliasChoices):
            keys += [k for k in f.validation_alias.choices if isinstance(k, str) and k != name]
        hit = next((k for k in keys if k in raw), None)
        if hit is None:
            continue
        seen.add(hit)
        if hit != name:
            aliases.append(f"{path}{hit} -> {path}{name}")
        sub = getattr(model, name)
        if isinstance(sub, BaseModel):
            _inspect(sub, raw[hit], f"{path}{name}.", ignored, aliases)
    ignored += [f"{path}{k}" for k in raw if k not in seen]


def receive(model: NovaAccount | RecoveryContextV1) -> Received:
    raw = model._raw if model._raw is not None else model.model_dump(mode="json", exclude_none=True)
    ignored: list[str] = []
    aliases: list[str] = []
    _inspect(model, raw, "", ignored, aliases)
    account = model.to_account() if isinstance(model, RecoveryContextV1) else model
    return Received(account=account, raw=raw, ignored_fields=ignored, aliases_used=aliases)


def lineage_only(acc: NovaAccount) -> list[str]:
    return [k for k in LINEAGE_ONLY if getattr(acc, k) is not None]


def guard_context(acc: NovaAccount) -> dict:
    """The guardrail inputs, frozen with the decision and re-read at send time.
    None means Nova did not say."""
    consent = acc.consent or Consent()
    counts = acc.contacts_by_channel or ContactCounts()
    fresh = acc.data_freshness or DataFreshness()
    ts = lambda v: v.isoformat() if v else None  # noqa: E731
    return {
        "contract_version": acc.contract_version,
        "consent": {"sms": consent.sms, "email": consent.email, "call": consent.call},
        "contacts": {"total": acc.contacts_last_7d, "sms": counts.sms, "email": counts.email, "call": counts.call,
                     "other": counts.other},
        "vulnerability_flag": acc.vulnerability_flag,
        "restrictions": acc.restrictions.model_dump() if acc.restrictions else None,
        "arrangement": acc.arrangement.model_dump(mode="json") if acc.arrangement else None,
        "timezone": acc.timezone,
        "as_of": {"as_of_timestamp": ts(acc.as_of_timestamp), "consent_as_of": ts(fresh.consent_as_of),
                  "contact_history_as_of": ts(fresh.contact_history_as_of),
                  "restrictions_as_of": ts(fresh.restrictions_as_of),
                  "arrangement_as_of": ts(fresh.arrangement_as_of)},
    }
