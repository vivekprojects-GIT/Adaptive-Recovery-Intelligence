"""Platform configuration, audit trail and live request metrics."""
from __future__ import annotations

import json
import time
from collections import deque
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from .models import AuditEvent, PlatformConfig

UTC = timezone.utc
STARTED_AT = datetime.now(UTC)

# (key, default, label, group, kind, help)
CONFIG_DEFAULTS: list[tuple[str, str, str, str, str, str]] = [
    ("default_control_pct", "0.20", "Default control share", "Experiment design", "percent",
     "Randomised holdout on business as usual. Fixed for the life of a strategy."),
    ("default_wave_size", "40", "Default wave size", "Experiment design", "number",
     "Treated customers decided per wave."),
    ("evaluation_days", "7", "Evaluation window (days)", "Experiment design", "number",
     "How long to wait for a payment before scoring a decision. Delayed-outcome handling is an open design item."),
    ("prior_strength", "10", "Prior strength (pseudo-observations)", "Experiment design", "number",
     "How much weight the playbook's historical success rate gets before live evidence."),
    ("router_validation_share", "0.05", "Validation share", "Propensity Router", "percent",
     "Share of the Likely self-cure and Needs support groups sent to strategies against their route, so the "
     "router can be scored. Never taught to Thompson sampling and kept out of strategy results. Do not contact "
     "is never included. At most 10%."),
    ("contact_cap_7d", "7", "Max contacts per customer per 7 days", "Contact policy", "number",
     "All channels, ARI and business-as-usual combined. Aligned to Reg F's 7-in-7."),
    ("call_cap_7d", "7", "Max call attempts per 7 days", "Contact policy", "number",
     "Reg F presumption: 7 call attempts in 7 days per debt."),
    ("contact_hour_start", "8", "Earliest contact (local hour)", "Contact policy", "hour",
     "FDCPA presumes 8am-9pm local time is convenient."),
    ("contact_hour_end", "21", "Latest contact (local hour)", "Contact policy", "hour", ""),
    ("optout_sla_hours", "24", "Opt-out suppression SLA (hours)", "Contact policy", "number",
     "Maximum lag between an opt-out and suppression across every system."),
    # COMPLIANCE PLACEHOLDERS. 24 hours is a stand-in so the mechanism can be
    # demonstrated - not an approved or recommended threshold. Compliance sets
    # the real values before any production use. They fail closed for
    # contract v1 requests only; for v0 staleness is logged, never enforced.
    ("freshness_sla_consent_hours", "24", "Consent freshness limit (hours) - COMPLIANCE PLACEHOLDER, not approved",
     "Data freshness", "number",
     "COMPLIANCE PLACEHOLDER - not an approved requirement. Compliance must set this value. Consent older than "
     "this blocks the channels that need it, for contract v1 requests only."),
    ("freshness_sla_contact_history_hours", "24",
     "Contact history freshness limit (hours) - COMPLIANCE PLACEHOLDER, not approved", "Data freshness", "number",
     "COMPLIANCE PLACEHOLDER - not an approved requirement. Compliance must set this value. Contact counts older "
     "than this block every contact, for contract v1 requests only."),
    ("freshness_sla_restrictions_hours", "24",
     "Restrictions freshness limit (hours) - COMPLIANCE PLACEHOLDER, not approved", "Data freshness", "number",
     "COMPLIANCE PLACEHOLDER - not an approved requirement. Compliance must set this value. Restrictions and "
     "vulnerability older than this stop all automated treatment, for contract v1 requests only."),
    ("freshness_sla_arrangement_hours", "24",
     "Arrangement freshness limit (hours) - PLACEHOLDER, not approved", "Data freshness", "number",
     "PLACEHOLDER - not an approved requirement. Measured and logged only; never blocks."),
    # PENDING_BUSINESS_CONFIRMATION: implemented, but off until Vishal / the
    # business confirm that an active arrangement or promise to pay must block
    # a new plan or deferral offer. While off, the rule is still evaluated and
    # recorded - it passes, with what it would have done.
    ("arrangement_blocks_new_offers", "false",
     "Block new plan / deferral offers over an active arrangement or PTP - PENDING_BUSINESS_CONFIRMATION",
     "Data freshness", "bool",
     "PENDING_BUSINESS_CONFIRMATION - off by default. Do not switch on until the business confirms the rule. "
     "When on, plan and deferral offers are not made while an arrangement is active or a promise to pay is "
     "pending. When off, each decision still records what the rule would have done."),
    ("recovery_rate_target", "0.40", "Portfolio recovery-rate target", "Targets", "percent", ""),
    ("cost_per_recovery_target", "8.00", "Cost-per-recovery target ($)", "Targets", "number", ""),
    ("escalation_rate_target", "0.08", "Escalation-rate ceiling", "Targets", "percent", ""),
    ("shadow_mode", "true", "Pilot mode (channel delivery off)", "Operations", "bool",
     "Locked on until a channel gateway is connected. Decisions, approvals and compliance checks are recorded; "
     "no message is sent to a customer."),
    ("auto_handoff", "true", "Receive next handoff automatically", "Operations", "bool",
     "When a strategy's audience is too small for a full wave, pull the next cohort handoff from the "
     "collections system before the wave runs."),
    ("model_version", "ARI-v4.2.1", "Decision model version", "Operations", "text",
     "Shown with each decision. Not yet stored per decision; that comes with policy versioning."),
]


def cfg(db: Session, key: str) -> str:
    row = db.get(PlatformConfig, key)
    if row:
        return row.value
    return next(d for k, d, *_ in CONFIG_DEFAULTS if k == key)


def cfg_float(db: Session, key: str) -> float:
    return float(cfg(db, key))


# Customers are shown as CUS-<offset + internal id> (frontend lib/format customerRef).
CUSTOMER_REF_OFFSET = 10000


def customer_ref(customer_id: int) -> str:
    """The customer ID as people see and search it, e.g. CUS-10517."""
    return f"CUS-{CUSTOMER_REF_OFFSET + customer_id}"


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def audit(db: Session, actor: str, action: str, entity: str, entity_id: str, summary: str,
          detail: dict | None = None, at: str | None = None) -> None:
    db.add(AuditEvent(at=at or now(), actor=actor, action=action, entity=entity,
                      entity_id=entity_id, summary=summary, detail=json.dumps(detail or {})))


# ---------------------------------------------------------------------------
# Request metrics: measured, not invented. System Health reads from here.
# ---------------------------------------------------------------------------
class Metrics:
    def __init__(self, size: int = 5000):
        self.samples: deque[tuple[float, float, int, str]] = deque(maxlen=size)  # (ts, ms, status, path)
        self.total = 0
        self.errors = 0

    def record(self, ms: float, status: int, path: str) -> None:
        self.total += 1
        if status >= 500:
            self.errors += 1
        self.samples.append((time.time(), ms, status, path))

    def snapshot(self) -> dict:
        lat = sorted(s[1] for s in self.samples)
        recent = [s for s in self.samples if s[0] > time.time() - 3600]
        p = lambda q: round(lat[min(len(lat) - 1, int(q * len(lat)))], 1) if lat else 0.0  # noqa: E731
        uptime = (datetime.now(UTC) - STARTED_AT).total_seconds()
        return {
            "started_at": STARTED_AT.isoformat(timespec="seconds"),
            "uptime_seconds": round(uptime),
            "requests_total": self.total,
            "requests_last_hour": len(recent),
            "errors_total": self.errors,
            "error_rate": round(self.errors / self.total, 4) if self.total else 0.0,
            "latency_avg_ms": round(sum(lat) / len(lat), 1) if lat else 0.0,
            "latency_p50_ms": p(0.50),
            "latency_p95_ms": p(0.95),
            "latency_p99_ms": p(0.99),
            "availability": round(1 - self.errors / self.total, 5) if self.total else 1.0,
        }


METRICS = Metrics()


async def metrics_middleware(request, call_next):
    t0 = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        METRICS.record((time.perf_counter() - t0) * 1000, status, request.url.path)
