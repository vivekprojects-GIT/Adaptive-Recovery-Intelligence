"""ARI Console persistence.

The intervention engine (scoring.py) and the treatment playbook (models.Strategy,
S1-S6) are unchanged. This module adds what an operating console needs on top:

  * people and permissions   - User, RolePermission
  * campaigns                - Campaign: what a strategist builds and launches
  * a durable decision log   - Decision, Nudge, EngagementEvent, Outcome
  * governance               - ComplianceViolation, Insight, AlertRule,
                               PlatformConfig, AuditEvent

Vocabulary, kept deliberately distinct:
  treatment = one business-authored action in the playbook (S1 Reminder SMS ...)
  campaign  = a strategist's plan: a target segment, the treatments it may use
              as experiment arms, cadence and escalation. Shown in the UI as a
              "strategy" (STR-021) to match the bank's own language.
"""
from __future__ import annotations

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text, UniqueConstraint, event
from sqlalchemy.orm import Mapped, mapped_column

from ..core.database import Base


class User(Base):
    __tablename__ = "users"

    user_id: Mapped[str] = mapped_column(String(20), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    email: Mapped[str] = mapped_column(String(120), unique=True)
    role: Mapped[str] = mapped_column(String(20))            # strategist | leader | admin | viewer
    status: Mapped[str] = mapped_column(String(12), default="Active")   # Active | Inactive | Pending
    last_login: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[str] = mapped_column(String(32))


class RolePermission(Base):
    __tablename__ = "role_permissions"

    role: Mapped[str] = mapped_column(String(20), primary_key=True)
    permission: Mapped[str] = mapped_column(String(40), primary_key=True)
    granted: Mapped[bool] = mapped_column(Boolean, default=False)


class Campaign(Base):
    __tablename__ = "campaigns"

    campaign_id: Mapped[str] = mapped_column(String(12), primary_key=True)   # STR-021
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text, default="")
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.user_id"))
    # Draft -> In review -> Approved -> Live -> Paused -> Archived
    status: Mapped[str] = mapped_column(String(12), default="Draft")
    version: Mapped[int] = mapped_column(Integer, default=1)
    source: Mapped[str] = mapped_column(String(12), default="manual")       # manual | clone | ai_draft | revision | suggested
    steps_completed: Mapped[int] = mapped_column(Integer, default=0)        # guided build progress 0-6

    # 1. Segment
    target_cohorts: Mapped[str] = mapped_column(Text, default="[]")         # json list of cohort ids
    include_segments: Mapped[str] = mapped_column(Text, default='["Persuadable"]')
    min_balance: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_balance: Mapped[float | None] = mapped_column(Float, nullable=True)
    # 2. Risk rules
    risk_bands: Mapped[str] = mapped_column(Text, default="[]")             # client risk bands
    min_dpd: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_dpd: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 3. Channels = treatment arms the bandit may choose among
    treatment_codes: Mapped[str] = mapped_column(Text, default="[]")
    # 4. Nudge configuration
    cadence_days: Mapped[int] = mapped_column(Integer, default=3)
    max_touches: Mapped[int] = mapped_column(Integer, default=3)
    tone: Mapped[str] = mapped_column(String(20), default="Supportive")     # Supportive | Neutral | Direct
    send_window_start: Mapped[int] = mapped_column(Integer, default=9)      # local hour
    send_window_end: Mapped[int] = mapped_column(Integer, default=19)
    # 5. Escalation
    escalate_after_days: Mapped[int] = mapped_column(Integer, default=14)
    escalate_to: Mapped[str | None] = mapped_column(String(10), nullable=True)   # treatment code
    # 6. Experiment design
    control_pct: Mapped[float] = mapped_column(Float, default=0.20)
    wave_size: Mapped[int] = mapped_column(Integer, default=40)
    evaluation_days: Mapped[int] = mapped_column(Integer, default=7)
    recovery_target: Mapped[float] = mapped_column(Float, default=0.40)

    created_by: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[str] = mapped_column(String(32))
    submitted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(20), nullable=True)
    approved_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    launched_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    waves_run: Mapped[int] = mapped_column(Integer, default=0)
    seed: Mapped[int] = mapped_column(Integer, default=0)
    # A revision of a live strategy points at the version it replaces. When the
    # revision launches, the parent is archived - one live version at a time.
    parent_id: Mapped[str | None] = mapped_column(String(12), nullable=True)


class TreatmentMeta(Base):
    """Governance and rules for a playbook treatment (models.Strategy holds the
    offer text, cost and historical record). Kind and rules drive eligibility
    and customer fit, so treatments are added without code changes."""
    __tablename__ = "treatment_meta"

    code: Mapped[str] = mapped_column(String(10), primary_key=True)
    kind: Mapped[str] = mapped_column(String(20))
    rules: Mapped[str] = mapped_column(Text, default="{}")
    status: Mapped[str] = mapped_column(String(10), default="Active")   # Active | Retired
    human_review: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str] = mapped_column(String(20), default="system")
    updated_by: Mapped[str] = mapped_column(String(20), default="system")
    updated_at: Mapped[str] = mapped_column(String(32))


class Handoff(Base):
    """A cohort handoff from the client's collections system: new delinquent
    accounts arriving for the intervention layer to decide."""
    __tablename__ = "handoffs"

    handoff_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[str] = mapped_column(String(32))
    by: Mapped[str] = mapped_column(String(20))
    counts: Mapped[str] = mapped_column(Text)        # json {cohort_id: n}
    total: Mapped[int] = mapped_column(Integer)
    trigger: Mapped[str] = mapped_column(String(12))  # manual | auto


class ExternalCustomer(Base):
    """An account as an upstream system knows it (Nova), linked to ARI's record.
    The upstream reference is the join key for every later call - decisions,
    outcome reports - so ARI never has to invent one."""
    __tablename__ = "external_customers"
    __table_args__ = (UniqueConstraint("source", "external_ref"),)

    link_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source: Mapped[str] = mapped_column(String(20))              # nova
    external_ref: Mapped[str] = mapped_column(String(64), index=True)   # Nova account_id
    customer_id: Mapped[int] = mapped_column(Integer, index=True)
    first_seen: Mapped[str] = mapped_column(String(32))
    last_seen: Mapped[str] = mapped_column(String(32))
    payload: Mapped[str] = mapped_column(Text, default="{}")      # last record received, for lineage


class Decision(Base):
    __tablename__ = "decisions"

    decision_id: Mapped[str] = mapped_column(String(12), primary_key=True)   # D-4820
    campaign_id: Mapped[str] = mapped_column(ForeignKey("campaigns.campaign_id"), index=True)
    customer_id: Mapped[int] = mapped_column(Integer, index=True)
    wave: Mapped[int] = mapped_column(Integer)
    # wave: decided in a console wave. mcp: requested by an agent (Nova) for one
    # account; its outcome is reported back by that agent, never simulated.
    origin: Mapped[str] = mapped_column(String(12), default="wave")
    group: Mapped[str] = mapped_column(String(12))          # Treatment | Control | Excluded
    treatment_code: Mapped[str | None] = mapped_column(String(10), nullable=True)
    eligible_arms: Mapped[str] = mapped_column(Text, default="[]")   # passed the business rules
    # Eligible but blocked by the contact rules before sampling:
    # [{code, name, reason_code, reason}]. Never sampled.
    blocked_arms: Mapped[str] = mapped_column(Text, default="[]")
    ranking: Mapped[str] = mapped_column(Text, default="[]")   # allowed arms: belief / sample / fit / score
    selection_probability: Mapped[float | None] = mapped_column(Float, nullable=True)
    explanation: Mapped[str] = mapped_column(Text, default="")
    exclusion_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Forbearance-type treatments wait for a human; communications execute.
    review_policy: Mapped[str] = mapped_column(String(16), default="auto")     # auto | human_review
    # n/a | pending | approved | rejected | cancelled (withdrawn before review: e.g. a vulnerability flag arrived)
    review_status: Mapped[str] = mapped_column(String(12), default="n/a")
    reviewed_by: Mapped[str | None] = mapped_column(String(20), nullable=True)
    overridden: Mapped[bool] = mapped_column(Boolean, default=False)
    override_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    original_treatment: Mapped[str | None] = mapped_column(String(10), nullable=True)
    snapshot: Mapped[str] = mapped_column(Text, default="{}")   # customer context at decision time
    decided_at: Mapped[str] = mapped_column(String(32), index=True)
    latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    # RecoveryContext lineage (P1). Null on decisions made before it existed.
    contract_version: Mapped[str | None] = mapped_column(String(10), nullable=True)   # v0 | v1 | console
    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    context_as_of: Mapped[str | None] = mapped_column(String(32), nullable=True)
    feature_snapshot_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


class FeatureSnapshot(Base):
    """The exact context a decision was made on, frozen at decision time and
    never updated: what was received, how it was read, what was assumed, and
    how fresh it was. Historical screens read this, never today's customer
    record. ARI keeps the context of each request, not a copy of Nova's data."""
    __tablename__ = "feature_snapshots"

    snapshot_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    decision_id: Mapped[str] = mapped_column(ForeignKey("decisions.decision_id"), unique=True, index=True)
    account_ref: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)   # Nova account_id
    party_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)                 # Nova party id
    contract_version: Mapped[str] = mapped_column(String(10))       # v0 | v1 | console | legacy
    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    as_of_ts: Mapped[str | None] = mapped_column(String(32), nullable=True)   # when the data was true in Nova
    received_at: Mapped[str] = mapped_column(String(32))
    feature_set_version: Mapped[str] = mapped_column(String(30))
    raw_payload: Mapped[str] = mapped_column(Text, default="{}")    # as received, verbatim
    features: Mapped[str] = mapped_column(Text, default="{}")       # the normalised values the rules and model used
    guard_context: Mapped[str] = mapped_column(Text, default="{}")  # consent, contacts, restrictions, as-of times
    assumed: Mapped[str] = mapped_column(Text, default="[]")        # values ARI had to default
    ignored_fields: Mapped[str] = mapped_column(Text, default="[]")  # sent, but not part of the contract
    aliases_used: Mapped[str] = mapped_column(Text, default="[]")
    lineage_only: Mapped[str] = mapped_column(Text, default="[]")   # accepted and stored, not used to decide
    source_lineage: Mapped[str] = mapped_column(Text, default="{}")
    staleness: Mapped[str] = mapped_column(Text, default="{}")      # per guardrail input: fresh | stale | missing


class EligibilityEval(Base):
    """One rule, evaluated for one candidate treatment, for one decision. Every
    rule is evaluated - none stops at the first failure - so a blocked
    treatment shows every reason it was blocked. Written once, never updated."""
    __tablename__ = "eligibility_evals"

    eval_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    decision_id: Mapped[str] = mapped_column(ForeignKey("decisions.decision_id"), index=True)
    arm_id: Mapped[str] = mapped_column(String(10))              # treatment code
    arm_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    stage: Mapped[str] = mapped_column(String(20))               # playbook | business | hard_stop | contact | context
    rule_id: Mapped[str] = mapped_column(String(40))
    rule_version: Mapped[str] = mapped_column(String(30))
    result: Mapped[str] = mapped_column(String(5))               # PASS | BLOCK
    reason_code: Mapped[str] = mapped_column(String(40))
    reason: Mapped[str] = mapped_column(Text, default="")
    input_refs: Mapped[str] = mapped_column(Text, default="{}")  # the inputs the rule read, with their values
    evaluated_at: Mapped[str] = mapped_column(String(32))


def _immutable(mapper, connection, target):
    raise ValueError(f"{type(target).__name__} rows are immutable: a decision's context and rule results are "
                     f"never rewritten.")


event.listen(FeatureSnapshot, "before_update", _immutable)
event.listen(EligibilityEval, "before_update", _immutable)


class Nudge(Base):
    __tablename__ = "nudges"

    nudge_id: Mapped[str] = mapped_column(String(12), primary_key=True)      # N-4821
    decision_id: Mapped[str] = mapped_column(ForeignKey("decisions.decision_id"), index=True)
    campaign_id: Mapped[str] = mapped_column(String(12), index=True)
    customer_id: Mapped[int] = mapped_column(Integer, index=True)
    treatment_code: Mapped[str] = mapped_column(String(10))
    channel: Mapped[str] = mapped_column(String(30))
    touch_number: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(12))   # Scheduled | Delivered | Opened | Clicked | Failed | Held
    content: Mapped[str] = mapped_column(Text, default="")
    pipeline: Mapped[str] = mapped_column(Text, default="[]")   # [{stage, at, detail, ok}]
    scheduled_at: Mapped[str] = mapped_column(String(32))
    sent_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_escalation: Mapped[bool] = mapped_column(Boolean, default=False)
    manual: Mapped[bool] = mapped_column(Boolean, default=False)


class EngagementEvent(Base):
    __tablename__ = "engagement_events"

    event_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    nudge_id: Mapped[str] = mapped_column(ForeignKey("nudges.nudge_id"), index=True)
    customer_id: Mapped[int] = mapped_column(Integer, index=True)
    event: Mapped[str] = mapped_column(String(20))     # Opened | Clicked | FormCompleted | Replied | OptOut
    at: Mapped[str] = mapped_column(String(32))


class Outcome(Base):
    __tablename__ = "outcomes"

    outcome_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    decision_id: Mapped[str] = mapped_column(ForeignKey("decisions.decision_id"), index=True, unique=True)
    campaign_id: Mapped[str] = mapped_column(String(12), index=True)
    customer_id: Mapped[int] = mapped_column(Integer, index=True)
    paid: Mapped[bool] = mapped_column(Boolean, default=False)
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    days_to_pay: Mapped[int | None] = mapped_column(Integer, nullable=True)
    escalated: Mapped[bool] = mapped_column(Boolean, default=False)
    window_days: Mapped[int] = mapped_column(Integer, default=7)
    reward: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Which reward policy turned the reported facts into `reward`. Only one
    # exists so far (binary: paid inside the window). Recorded so a future
    # policy - a reward ladder - can be told apart from today's.
    reward_policy: Mapped[str | None] = mapped_column(String(40), nullable=True)
    learned: Mapped[bool] = mapped_column(Boolean, default=False)
    observed_at: Mapped[str] = mapped_column(String(32))


class ContactRecord(Base):
    """Every outbound contact the customer received - ARI's own nudges AND the
    bank's business-as-usual systems. Contact rules are about what the customer
    experienced, so compliance has to count both."""
    __tablename__ = "contact_records"

    contact_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[int] = mapped_column(Integer, index=True)
    channel: Mapped[str] = mapped_column(String(30))
    source: Mapped[str] = mapped_column(String(12))    # ARI | BAU
    nudge_id: Mapped[str | None] = mapped_column(String(12), nullable=True)
    at: Mapped[str] = mapped_column(String(32), index=True)
    local_hour: Mapped[int] = mapped_column(Integer)
    opted_out: Mapped[bool] = mapped_column(Boolean, default=False)


class ComplianceViolation(Base):
    __tablename__ = "compliance_violations"

    violation_id: Mapped[str] = mapped_column(String(12), primary_key=True)   # VIO-040
    policy_area: Mapped[str] = mapped_column(String(40))
    rule: Mapped[str] = mapped_column(String(80))
    severity: Mapped[str] = mapped_column(String(10))       # Critical | High | Medium | Low
    campaign_id: Mapped[str | None] = mapped_column(String(12), nullable=True, index=True)
    customer_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    nudge_id: Mapped[str | None] = mapped_column(String(12), nullable=True)
    description: Mapped[str] = mapped_column(Text)
    detected_at: Mapped[str] = mapped_column(String(32), index=True)
    status: Mapped[str] = mapped_column(String(12), default="Open")   # Open | Investigating | Resolved
    resolved_by: Mapped[str | None] = mapped_column(String(20), nullable=True)
    resolved_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    resolution_note: Mapped[str | None] = mapped_column(Text, nullable=True)


class Insight(Base):
    """A recommendation from the AI Workbench, sent by a leader to a strategist."""
    __tablename__ = "insights"

    insight_id: Mapped[str] = mapped_column(String(12), primary_key=True)     # IN-007
    campaign_id: Mapped[str | None] = mapped_column(String(12), nullable=True)
    from_user: Mapped[str] = mapped_column(String(20))
    to_user: Mapped[str] = mapped_column(String(20), index=True)
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(Text)
    evidence: Mapped[str] = mapped_column(Text, default="")
    priority: Mapped[str] = mapped_column(String(10), default="Medium")
    status: Mapped[str] = mapped_column(String(12), default="New")   # New | In review | Accepted | Declined | Applied
    proposed_change: Mapped[str] = mapped_column(Text, default="{}")  # json patch for the campaign
    created_at: Mapped[str] = mapped_column(String(32))
    responded_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    response_note: Mapped[str | None] = mapped_column(Text, nullable=True)


class AlertRule(Base):
    __tablename__ = "alert_rules"

    rule_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100))
    metric: Mapped[str] = mapped_column(String(40))
    comparator: Mapped[str] = mapped_column(String(2))       # lt | gt
    threshold: Mapped[float] = mapped_column(Float)
    scope: Mapped[str] = mapped_column(String(20), default="portfolio")   # portfolio | campaign
    severity: Mapped[str] = mapped_column(String(10), default="High")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    notify: Mapped[str] = mapped_column(String(120), default="")
    created_by: Mapped[str] = mapped_column(String(20))
    updated_at: Mapped[str] = mapped_column(String(32))


class PlatformConfig(Base):
    __tablename__ = "platform_config"

    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    label: Mapped[str] = mapped_column(String(100))
    group: Mapped[str] = mapped_column(String(30))
    kind: Mapped[str] = mapped_column(String(10))     # number | percent | bool | text | hour
    help: Mapped[str] = mapped_column(Text, default="")
    updated_by: Mapped[str | None] = mapped_column(String(20), nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    audit_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[str] = mapped_column(String(32), index=True)
    actor: Mapped[str] = mapped_column(String(20))
    action: Mapped[str] = mapped_column(String(10))        # CREATE | READ | UPDATE | DELETE | APPROVE | EXPORT
    entity: Mapped[str] = mapped_column(String(30))
    entity_id: Mapped[str] = mapped_column(String(30), default="")
    summary: Mapped[str] = mapped_column(Text)
    detail: Mapped[str] = mapped_column(Text, default="{}")
