# CARE database schema

CARE's own database today: 30 tables, generated from the SQLAlchemy models in `backend/app/models.py` and `backend/app/console/models.py`. SQLite locally; Postgres when `DATABASE_URL` is set. Every link between tables is a declared foreign key, enforced on SQLite too and checked when each transaction commits. Times are TIMESTAMP WITH TIME ZONE and dates DATE on Postgres; SQLite has no date type, so there they are ISO 8601 text. The tables Nova will provide instead of the account tables are in [nova-data-model.md](nova-data-model.md).

## Accounts (today's source data; Nova replaces it)

### cohorts

The four days-late groups (1-29, 30, 60, 90+ days late).

| Column | Type | Key |
| --- | --- | --- |
| `cohort_id` | VARCHAR(10) | PK |
| `name` | VARCHAR(100) |  |
| `dpd_bucket` | VARCHAR(20) |  |
| `client_risk_band` | VARCHAR(20) |  |
| `expected_payment` | VARCHAR(60) |  |
| `description` | TEXT |  |
| `sort_order` | INTEGER |  |

### customers

One delinquent account: balance, arrears, days past due, the bank's risk band, and CARE's fit group and route. Holds a name, which agents never receive.

| Column | Type | Key |
| --- | --- | --- |
| `customer_id` | INTEGER | PK |
| `cohort_id` | VARCHAR(10) | FK → cohorts.cohort_id |
| `name` | VARCHAR(60) |  |
| `balance` | FLOAT |  |
| `credit_limit` | FLOAT |  |
| `utilization` | FLOAT |  |
| `tenure_years` | INTEGER |  |
| `sms_responsive` | BOOLEAN |  |
| `app_user` | BOOLEAN |  |
| `hardship_flag` | BOOLEAN |  |
| `missed_payments` | INTEGER |  |
| `payment_history` | FLOAT |  |
| `days_past_due` | INTEGER |  |
| `client_risk_band` | VARCHAR(20) |  |
| `client_risk_score` | FLOAT |  |
| `nudge_score` | FLOAT |  |
| `self_cure_score` | FLOAT |  |
| `segment` | VARCHAR(40) |  |
| `route` | VARCHAR(12) |  |
| `route_validation` | BOOLEAN |  |
| `product` | VARCHAR(20) |  |
| `account_number` | VARCHAR(64) |  |
| `delinquent_amount` | FLOAT |  |
| `is_persona` | BOOLEAN |  |
| `persona_note` | TEXT |  |

### contact_records

Every outbound contact the customer received, CARE's and the bank's business-as-usual systems'.

| Column | Type | Key |
| --- | --- | --- |
| `contact_id` | INTEGER | PK |
| `customer_id` | INTEGER | FK → customers.customer_id |
| `channel` | VARCHAR(30) |  |
| `source` | VARCHAR(12) |  |
| `nudge_id` | VARCHAR(12) | FK → nudges.nudge_id |
| `at` | TIMESTAMP WITH TIME ZONE |  |
| `local_hour` | INTEGER |  |
| `opted_out` | BOOLEAN |  |

### external_customers

Links an account Nova sent (its account_id) to CARE's customer record.

| Column | Type | Key |
| --- | --- | --- |
| `link_id` | INTEGER | PK |
| `source` | VARCHAR(20) |  |
| `external_ref` | VARCHAR(64) |  |
| `customer_id` | INTEGER | FK → customers.customer_id |
| `first_seen` | TIMESTAMP WITH TIME ZONE |  |
| `last_seen` | TIMESTAMP WITH TIME ZONE |  |
| `payload` | TEXT |  |

### recovery_accounts

A charged-off account in recovery: charge-off balance, recovered so far, recovery status.

| Column | Type | Key |
| --- | --- | --- |
| `recovery_id` | INTEGER | PK |
| `external_ref` | VARCHAR(64) |  |
| `account_number` | VARCHAR(64) |  |
| `name` | VARCHAR(80) |  |
| `product` | VARCHAR(20) |  |
| `charge_off_date` | DATE |  |
| `charge_off_balance` | FLOAT |  |
| `recovered` | FLOAT |  |
| `status` | VARCHAR(20) |  |
| `assigned_treatment` | VARCHAR(10) |  |
| `assigned_by` | VARCHAR(20) |  |
| `assigned_at` | TIMESTAMP WITH TIME ZONE |  |
| `source` | VARCHAR(12) |  |
| `created_at` | TIMESTAMP WITH TIME ZONE |  |

### recovery_payments

A payment received on a recovery account after charge-off.

| Column | Type | Key |
| --- | --- | --- |
| `payment_id` | INTEGER | PK |
| `recovery_id` | INTEGER | FK → recovery_accounts.recovery_id |
| `amount` | FLOAT |  |
| `paid_at` | TIMESTAMP WITH TIME ZONE |  |

### agencies

External collection agencies on the bank's panel.

| Column | Type | Key |
| --- | --- | --- |
| `agency_id` | VARCHAR(12) | PK |
| `name` | VARCHAR(80) |  |
| `fee_rate` | FLOAT |  |
| `products` | TEXT |  |
| `min_dpd` | INTEGER |  |
| `capacity` | INTEGER |  |
| `placement_days` | INTEGER |  |
| `status` | VARCHAR(10) |  |
| `contract_ref` | VARCHAR(30) |  |
| `audited_at` | TIMESTAMP WITH TIME ZONE |  |

### handoffs

A batch of new delinquent accounts arriving from the collections system.

| Column | Type | Key |
| --- | --- | --- |
| `handoff_id` | INTEGER | PK |
| `at` | TIMESTAMP WITH TIME ZONE |  |
| `by` | VARCHAR(20) |  |
| `counts` | TEXT |  |
| `total` | INTEGER |  |
| `trigger` | VARCHAR(12) |  |

## Treatments and strategies

### treatments

The treatment playbook (S1 Reminder SMS ...): offer, channel, cost, track record. Class models.Strategy.

| Column | Type | Key |
| --- | --- | --- |
| `code` | VARCHAR(10) | PK |
| `name` | VARCHAR(80) |  |
| `channel` | VARCHAR(60) |  |
| `offer` | TEXT |  |
| `timing` | VARCHAR(60) |  |
| `eligibility_rule` | TEXT |  |
| `cost_per_contact` | FLOAT |  |
| `hist_successes` | INTEGER |  |
| `hist_failures` | INTEGER |  |

### treatment_meta

Each treatment's kind, eligibility rules, approval policy and version.

| Column | Type | Key |
| --- | --- | --- |
| `code` | VARCHAR(10) | PK, FK → treatments.code |
| `kind` | VARCHAR(20) |  |
| `rules` | TEXT |  |
| `status` | VARCHAR(10) |  |
| `human_review` | BOOLEAN |  |
| `version` | INTEGER |  |
| `builtin` | BOOLEAN |  |
| `created_by` | VARCHAR(20) |  |
| `updated_by` | VARCHAR(20) |  |
| `updated_at` | TIMESTAMP WITH TIME ZONE |  |

### strategies

A strategy (STR-021): audience, treatments, control share, lifecycle and version. Class Campaign.

| Column | Type | Key |
| --- | --- | --- |
| `campaign_id` | VARCHAR(12) | PK |
| `name` | VARCHAR(100) |  |
| `description` | TEXT |  |
| `owner_id` | VARCHAR(20) | FK → users.user_id |
| `status` | VARCHAR(12) |  |
| `version` | INTEGER |  |
| `source` | VARCHAR(12) |  |
| `steps_completed` | INTEGER |  |
| `target_cohorts` | TEXT |  |
| `include_segments` | TEXT |  |
| `min_balance` | FLOAT |  |
| `max_balance` | FLOAT |  |
| `risk_bands` | TEXT |  |
| `min_dpd` | INTEGER |  |
| `target_query` | TEXT |  |
| `max_dpd` | INTEGER |  |
| `treatment_codes` | TEXT |  |
| `cadence_days` | INTEGER |  |
| `max_touches` | INTEGER |  |
| `tone` | VARCHAR(20) |  |
| `send_window_start` | INTEGER |  |
| `send_window_end` | INTEGER |  |
| `escalate_after_days` | INTEGER |  |
| `escalate_to` | VARCHAR(10) | FK → treatments.code |
| `control_pct` | FLOAT |  |
| `wave_size` | INTEGER |  |
| `evaluation_days` | INTEGER |  |
| `recovery_target` | FLOAT |  |
| `created_by` | VARCHAR(20) |  |
| `created_at` | TIMESTAMP WITH TIME ZONE |  |
| `updated_at` | TIMESTAMP WITH TIME ZONE |  |
| `submitted_at` | TIMESTAMP WITH TIME ZONE |  |
| `approved_by` | VARCHAR(20) |  |
| `approved_at` | TIMESTAMP WITH TIME ZONE |  |
| `launched_at` | TIMESTAMP WITH TIME ZONE |  |
| `waves_run` | INTEGER |  |
| `seed` | INTEGER |  |
| `parent_id` | VARCHAR(12) |  |

## Decisions and learning

### routings

One pass through the Propensity Router: fit group, scores, route, and the outcome for accounts kept off strategies.

| Column | Type | Key |
| --- | --- | --- |
| `routing_id` | INTEGER | PK |
| `customer_id` | INTEGER | FK → customers.customer_id |
| `origin` | VARCHAR(12) |  |
| `policy` | VARCHAR(30) |  |
| `fit_group` | VARCHAR(20) |  |
| `nudge_score` | FLOAT |  |
| `self_cure_score` | FLOAT |  |
| `route` | VARCHAR(12) |  |
| `validation` | BOOLEAN |  |
| `reason` | TEXT |  |
| `routed_at` | TIMESTAMP WITH TIME ZONE |  |
| `paid` | BOOLEAN |  |
| `amount` | FLOAT |  |
| `window_days` | INTEGER |  |
| `observed_at` | TIMESTAMP WITH TIME ZONE |  |

### decisions

One decision for one account: group, treatment chosen, selection probability, review, explanation.

| Column | Type | Key |
| --- | --- | --- |
| `decision_id` | VARCHAR(12) | PK |
| `campaign_id` | VARCHAR(12) | FK → strategies.campaign_id |
| `customer_id` | INTEGER | FK → customers.customer_id |
| `wave` | INTEGER |  |
| `origin` | VARCHAR(12) |  |
| `group` | VARCHAR(12) |  |
| `treatment_code` | VARCHAR(10) | FK → treatments.code |
| `eligible_arms` | TEXT |  |
| `blocked_arms` | TEXT |  |
| `ranking` | TEXT |  |
| `selection_probability` | FLOAT |  |
| `explanation` | TEXT |  |
| `exclusion_reason` | TEXT |  |
| `review_policy` | VARCHAR(16) |  |
| `review_status` | VARCHAR(12) |  |
| `reviewed_by` | VARCHAR(20) |  |
| `overridden` | BOOLEAN |  |
| `override_reason` | TEXT |  |
| `original_treatment` | VARCHAR(10) | FK → treatments.code |
| `snapshot` | TEXT |  |
| `validation` | BOOLEAN |  |
| `decided_at` | TIMESTAMP WITH TIME ZONE |  |
| `latency_ms` | FLOAT |  |
| `contract_version` | VARCHAR(10) |  |
| `request_id` | VARCHAR(64) |  |
| `context_as_of` | TIMESTAMP WITH TIME ZONE |  |
| `feature_snapshot_id` | INTEGER |  |

### feature_snapshots

The exact data a decision was made on, frozen. Write-once.

| Column | Type | Key |
| --- | --- | --- |
| `snapshot_id` | INTEGER | PK |
| `decision_id` | VARCHAR(12) | FK → decisions.decision_id |
| `account_ref` | VARCHAR(64) |  |
| `party_ref` | VARCHAR(64) |  |
| `contract_version` | VARCHAR(10) |  |
| `request_id` | VARCHAR(64) |  |
| `as_of_ts` | TIMESTAMP WITH TIME ZONE |  |
| `received_at` | TIMESTAMP WITH TIME ZONE |  |
| `feature_set_version` | VARCHAR(30) |  |
| `raw_payload` | TEXT |  |
| `features` | TEXT |  |
| `guard_context` | TEXT |  |
| `assumed` | TEXT |  |
| `ignored_fields` | TEXT |  |
| `aliases_used` | TEXT |  |
| `lineage_only` | TEXT |  |
| `source_lineage` | TEXT |  |
| `staleness` | TEXT |  |

### eligibility_evals

Every rule checked for every candidate treatment of a decision. Write-once.

| Column | Type | Key |
| --- | --- | --- |
| `eval_id` | INTEGER | PK |
| `decision_id` | VARCHAR(12) | FK → decisions.decision_id |
| `arm_id` | VARCHAR(10) | FK → treatments.code |
| `arm_version` | INTEGER |  |
| `stage` | VARCHAR(20) |  |
| `rule_id` | VARCHAR(40) |  |
| `rule_version` | VARCHAR(30) |  |
| `result` | VARCHAR(5) |  |
| `reason_code` | VARCHAR(40) |  |
| `reason` | TEXT |  |
| `input_refs` | TEXT |  |
| `evaluated_at` | TIMESTAMP WITH TIME ZONE |  |

### nudges

A contact CARE scheduled for a decision: channel, message, status.

| Column | Type | Key |
| --- | --- | --- |
| `nudge_id` | VARCHAR(12) | PK |
| `decision_id` | VARCHAR(12) | FK → decisions.decision_id |
| `campaign_id` | VARCHAR(12) | FK → strategies.campaign_id |
| `customer_id` | INTEGER | FK → customers.customer_id |
| `treatment_code` | VARCHAR(10) | FK → treatments.code |
| `channel` | VARCHAR(30) |  |
| `touch_number` | INTEGER |  |
| `status` | VARCHAR(12) |  |
| `content` | TEXT |  |
| `pipeline` | TEXT |  |
| `scheduled_at` | TIMESTAMP WITH TIME ZONE |  |
| `sent_at` | TIMESTAMP WITH TIME ZONE |  |
| `failure_reason` | TEXT |  |
| `is_escalation` | BOOLEAN |  |
| `manual` | BOOLEAN |  |

### engagement_events

A customer response to a contact: opened, clicked, replied, opted out.

| Column | Type | Key |
| --- | --- | --- |
| `event_id` | INTEGER | PK |
| `nudge_id` | VARCHAR(12) | FK → nudges.nudge_id |
| `customer_id` | INTEGER | FK → customers.customer_id |
| `event` | VARCHAR(20) |  |
| `at` | TIMESTAMP WITH TIME ZONE |  |

### outcomes

What happened within the evaluation window: paid, amount, reward, learned.

| Column | Type | Key |
| --- | --- | --- |
| `outcome_id` | INTEGER | PK |
| `decision_id` | VARCHAR(12) | FK → decisions.decision_id |
| `campaign_id` | VARCHAR(12) | FK → strategies.campaign_id |
| `customer_id` | INTEGER | FK → customers.customer_id |
| `paid` | BOOLEAN |  |
| `amount` | FLOAT |  |
| `days_to_pay` | INTEGER |  |
| `escalated` | BOOLEAN |  |
| `window_days` | INTEGER |  |
| `reward` | FLOAT |  |
| `reward_policy` | VARCHAR(40) |  |
| `learned` | BOOLEAN |  |
| `observed_at` | TIMESTAMP WITH TIME ZONE |  |

### payment_records

Each payment reported for a decision; the outcome is their total inside the window.

| Column | Type | Key |
| --- | --- | --- |
| `record_id` | INTEGER | PK |
| `subject` | VARCHAR(40) |  |
| `payment_id` | VARCHAR(64) |  |
| `customer_id` | INTEGER | FK → customers.customer_id |
| `paid` | BOOLEAN |  |
| `amount` | FLOAT |  |
| `payment_date` | DATE |  |
| `status` | VARCHAR(10) |  |
| `nova_cure_flag` | BOOLEAN |  |
| `first_reported_at` | TIMESTAMP WITH TIME ZONE |  |
| `reported_at` | TIMESTAMP WITH TIME ZONE |  |

### decision_events

Changes a person made to an agent's decision, for the agent to read or receive.

| Column | Type | Key |
| --- | --- | --- |
| `event_id` | INTEGER | PK |
| `decision_id` | VARCHAR(12) | FK → decisions.decision_id |
| `account_ref` | VARCHAR(64) |  |
| `event` | VARCHAR(30) |  |
| `actor` | VARCHAR(20) |  |
| `payload` | TEXT |  |
| `created_at` | TIMESTAMP WITH TIME ZONE |  |
| `status` | VARCHAR(16) |  |
| `attempts` | INTEGER |  |
| `last_attempt_at` | TIMESTAMP WITH TIME ZONE |  |
| `delivered_at` | TIMESTAMP WITH TIME ZONE |  |
| `last_error` | TEXT |  |

### placements

An account proposed to or placed with a collection agency.

| Column | Type | Key |
| --- | --- | --- |
| `placement_id` | VARCHAR(12) | PK |
| `customer_id` | INTEGER | FK → customers.customer_id |
| `agency_id` | VARCHAR(12) | FK → agencies.agency_id |
| `status` | VARCHAR(10) |  |
| `reason` | TEXT |  |
| `amount` | FLOAT |  |
| `recovered` | FLOAT |  |
| `fee` | FLOAT |  |
| `proposed_by` | VARCHAR(20) |  |
| `proposed_at` | TIMESTAMP WITH TIME ZONE |  |
| `reviewed_by` | VARCHAR(20) |  |
| `reviewed_at` | TIMESTAMP WITH TIME ZONE |  |
| `review_note` | TEXT |  |
| `placed_at` | TIMESTAMP WITH TIME ZONE |  |
| `closed_at` | TIMESTAMP WITH TIME ZONE |  |
| `first_payment_days` | INTEGER |  |

## Governance and platform

### users

Console users and their role.

| Column | Type | Key |
| --- | --- | --- |
| `user_id` | VARCHAR(20) | PK |
| `name` | VARCHAR(80) |  |
| `email` | VARCHAR(120) |  |
| `role` | VARCHAR(20) |  |
| `status` | VARCHAR(12) |  |
| `last_login` | TIMESTAMP WITH TIME ZONE |  |
| `created_at` | TIMESTAMP WITH TIME ZONE |  |

### role_permissions

Which permissions each role holds.

| Column | Type | Key |
| --- | --- | --- |
| `role` | VARCHAR(20) | PK |
| `permission` | VARCHAR(40) | PK |
| `granted` | BOOLEAN |  |

### audit_events

Every action, by whom, on what.

| Column | Type | Key |
| --- | --- | --- |
| `audit_id` | INTEGER | PK |
| `at` | TIMESTAMP WITH TIME ZONE |  |
| `actor` | VARCHAR(20) |  |
| `action` | VARCHAR(10) |  |
| `entity` | VARCHAR(30) |  |
| `entity_id` | VARCHAR(64) |  |
| `summary` | TEXT |  |
| `detail` | TEXT |  |

### compliance_violations

Breaches the compliance monitor found, and how they were resolved.

| Column | Type | Key |
| --- | --- | --- |
| `violation_id` | VARCHAR(12) | PK |
| `policy_area` | VARCHAR(40) |  |
| `rule` | VARCHAR(80) |  |
| `severity` | VARCHAR(10) |  |
| `campaign_id` | VARCHAR(12) | FK → strategies.campaign_id |
| `customer_id` | INTEGER | FK → customers.customer_id |
| `nudge_id` | VARCHAR(12) | FK → nudges.nudge_id |
| `description` | TEXT |  |
| `detected_at` | TIMESTAMP WITH TIME ZONE |  |
| `status` | VARCHAR(12) |  |
| `resolved_by` | VARCHAR(20) |  |
| `resolved_at` | TIMESTAMP WITH TIME ZONE |  |
| `resolution_note` | TEXT |  |

### insights

Recommendations an executive sends to a strategist.

| Column | Type | Key |
| --- | --- | --- |
| `insight_id` | VARCHAR(12) | PK |
| `campaign_id` | VARCHAR(12) | FK → strategies.campaign_id |
| `from_user` | VARCHAR(20) | FK → users.user_id |
| `to_user` | VARCHAR(20) | FK → users.user_id |
| `title` | VARCHAR(160) |  |
| `body` | TEXT |  |
| `evidence` | TEXT |  |
| `priority` | VARCHAR(10) |  |
| `status` | VARCHAR(12) |  |
| `proposed_change` | TEXT |  |
| `created_at` | TIMESTAMP WITH TIME ZONE |  |
| `responded_at` | TIMESTAMP WITH TIME ZONE |  |
| `response_note` | TEXT |  |

### alert_rules

Thresholds that raise alerts.

| Column | Type | Key |
| --- | --- | --- |
| `rule_id` | INTEGER | PK |
| `name` | VARCHAR(100) |  |
| `metric` | VARCHAR(40) |  |
| `comparator` | VARCHAR(2) |  |
| `threshold` | FLOAT |  |
| `scope` | VARCHAR(20) |  |
| `severity` | VARCHAR(10) |  |
| `enabled` | BOOLEAN |  |
| `notify` | VARCHAR(120) |  |
| `created_by` | VARCHAR(20) |  |
| `updated_at` | TIMESTAMP WITH TIME ZONE |  |

### platform_config

Settings an admin can change, plus internal markers.

| Column | Type | Key |
| --- | --- | --- |
| `key` | VARCHAR(40) | PK |
| `value` | TEXT |  |
| `label` | VARCHAR(100) |  |
| `group` | VARCHAR(30) |  |
| `kind` | VARCHAR(10) |  |
| `help` | TEXT |  |
| `updated_by` | VARCHAR(20) |  |
| `updated_at` | TIMESTAMP WITH TIME ZONE |  |

## Knowledge graph (rebuilt from the tables above)

### kg_nodes

One node per customer, strategy, treatment, decision, outcome, agency or segment.

| Column | Type | Key |
| --- | --- | --- |
| `node_id` | VARCHAR(64) | PK |
| `cls` | VARCHAR(40) |  |
| `label` | VARCHAR(160) |  |
| `props` | TEXT |  |

### kg_edges

Typed links between nodes, e.g. customer HOLDS product.

| Column | Type | Key |
| --- | --- | --- |
| `edge_id` | INTEGER | PK |
| `src` | VARCHAR(64) | FK → kg_nodes.node_id |
| `rel` | VARCHAR(30) |  |
| `dst` | VARCHAR(64) | FK → kg_nodes.node_id |
