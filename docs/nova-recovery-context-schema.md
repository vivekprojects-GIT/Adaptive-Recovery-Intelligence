# Recovery Agent data schema for Nova

As of 6 November 2026. The source of truth is the code: `backend/app/console/contract.py` (what Nova sends), `backend/app/console/nova.py` (payment outcome) and `backend/app/console/mcp_server.py` (the tools).

## Purpose

Nova sends one delinquent account's context per request, as **RecoveryContext v1**. The Recovery Agent sends back the recovery action. Later, Nova reports whether the customer paid. That is the whole boundary between the two systems.

- **Nova owns what is true about the customer.** That covers balances, arrears, risk band, consent, restrictions and contact history. The Recovery Agent never recomputes these. It also keeps no copy of Nova's source tables. It only freezes the context of each request together with its decision.
- **The Recovery Agent owns the decision.** That covers eligibility rules, Thompson sampling over the treatments the business approved, the decision log, outcomes and learning.
- **Transport:** MCP tools at `/mcp`, authenticated with a bearer token. A REST facade would call the same functions.
- **Two versions are accepted:** v1 (nested, below) and v0 (the original flat `account`). Both are normalised to one record. For v1, missing or stale guardrail data **fails closed**. For v0 the same checks are logged, but they never block.

Only three things are strictly required: `account.account_id`, `account.current_balance` and `delinquency.days_past_due`. A v1 request also needs `request_id` and `as_of_timestamp`. Anything else that is missing gets a stated, conservative default, and that default is listed back in the response under `assumed`.

## What Nova sends: RecoveryContext v1

One JSON object per account, with eight blocks. **Use** says what the Recovery Agent does with each field. *Decide* means it changes the action. *Guardrail* means it can block a treatment. *Stored* means it is kept for lineage but not used to decide.

### Envelope

| Field | Type | Required | Use |
| --- | --- | --- | --- |
| `contract_version` | `"v1"` | yes | Selects the v1 reader |
| `request_id` | string, max 64 | yes | Idempotency: a repeated id returns the decision already made |
| `as_of_timestamp` | ISO 8601 datetime | yes | When the data was true in Nova |
| `source_system` | string, max 40 | no | Stored (lineage) |

### party

| Field | Type | Required | Use |
| --- | --- | --- | --- |
| `party_id` | string, max 64 | no | Stored: the Nova customer id |
| `name` | string, max 60 | no | Only to greet the customer in a message |
| `segment` | string, max 40 | no | Stored |

### account

| Field | Type | Required | Use |
| --- | --- | --- | --- |
| `account_id` | string, max 64 | **yes** | Key for every later call |
| `current_balance` | number ≥ 0 | **yes** | Decide: balance and utilisation |
| `credit_limit` | number > 0 | no | Decide: utilisation. Missing → 80% assumed |
| `opened_date` | date | no | Decide: tenure. Missing → 3 years assumed |
| `product` | enum (see Allowed values) | no | Decide: how arrears are counted, which agencies may take it |
| `status` | string, max 30 | no | Stored |

### delinquency

| Field | Type | Required | Use |
| --- | --- | --- | --- |
| `days_past_due` | integer 0–720 | **yes** | Decide: the DPD group and the strategy it routes to |
| `amount_past_due` | number ≥ 0 | no | Quoted in messages. Never estimated when missing |
| `prior_delinquencies_12m` | integer 0–12 | no | Decide: risk spread. Missing → 1 if DPD ≥ 30, else 0 |
| `on_time_payment_ratio` | number 0–1 | no | Decide: risk spread. Missing → 0.8 |
| `cycles_delinquent` | integer 0–24 | no | Stored |
| `bucket` | string, max 20 | no | Stored (the agent computes its own group from DPD) |

### risk

| Field | Type | Required | Use |
| --- | --- | --- | --- |
| `segment` | Low · Medium · High · Very high | no | Decide: the bank's band, never recomputed. Missing → taken from DPD |
| `score` | number 0–100, higher is riskier | no | Stored |

### behavior

| Field | Type | Required | Use |
| --- | --- | --- | --- |
| `app_user` | boolean | no | Decide: customer fit for app treatments |
| `sms_responsive` | boolean | no | Decide: customer fit for SMS |
| `hardship_flag` | boolean | no | Decide: hardship offers. Missing → none on file |
| `preferred_channel` | App · SMS · Email · Phone | no | Fallback for the two flags above, otherwise stored |

### contact_context

| Field | Type | Required | Use |
| --- | --- | --- | --- |
| `timezone` | IANA name, e.g. America/Chicago | no | Send times and quiet hours |
| `sms_allowed` | boolean | v1: yes for SMS | Guardrail: false or missing blocks SMS and SMS + App |
| `email_allowed` | boolean | v1: yes for email | Guardrail |
| `call_allowed` | boolean | v1: yes for calls | Guardrail: blocks agent calls |
| `recent_sms`, `recent_email`, `recent_calls`, `recent_other` | integer ≥ 0 | v1: yes | Guardrail: contacts in the last 7 days by **other** systems, counted against the 7-in-7 cap |
| `contacts_last_7d` | integer ≥ 0 | no | Total, if Nova counts it. Otherwise the four counts are added up |
| `last_contact_at` | datetime | no | Stored |

### restrictions

Any `true` stops all automated treatment. In v1 a missing block or a missing flag also stops it.

| Field | Type | Use |
| --- | --- | --- |
| `vulnerable` | boolean | Guardrail: referred to a person, never contacted automatically |
| `cease_communication` | boolean | Guardrail |
| `bankruptcy` | boolean | Guardrail |
| `attorney_represented` | boolean | Guardrail |
| `deceased` | boolean | Guardrail |
| `scra_protected` | boolean | Guardrail |
| `dispute_pending` | boolean | Guardrail |
| `agency_placed` | boolean | Guardrail |

### arrangement

| Field | Type | Use |
| --- | --- | --- |
| `active` | boolean | Guardrail for plan and deferral offers |
| `type` | string, e.g. PAYMENT_PLAN, DEFERRAL | Guardrail for plan and deferral offers |
| `promise_to_pay_status` | NONE · PENDING · KEPT · BROKEN | Guardrail for plan and deferral offers |
| `promise_to_pay_date` | date | Guardrail for plan and deferral offers |
| `promise_to_pay_amount` | number ≥ 0 | Guardrail for plan and deferral offers |
| `arrangement_id` | string, max 64 | Stored |

### data_freshness

These record when each guardrail input was last confirmed in Nova. In v1, if consent, contact history or restrictions are older than the limit, or have no as-of time, the request fails closed. The placeholder limit is 24 hours, and compliance has not approved it yet. A stale arrangement is logged only.

| Field | Type | Critical |
| --- | --- | --- |
| `consent_as_of` | datetime | yes |
| `contact_history_as_of` | datetime | yes |
| `restrictions_as_of` | datetime | yes |
| `arrangement_as_of` | datetime | no |

### Example

```json
{
  "contract_version": "v1",
  "request_id": "nova-20261106-000184",
  "as_of_timestamp": "2026-11-06T06:00:00Z",
  "source_system": "nova-cards",
  "party": { "party_id": "P-55210", "name": "Whitney Callahan" },
  "account": { "account_id": "A-90031", "product": "Consumer Credit Card",
               "current_balance": 2840.15, "credit_limit": 4000, "opened_date": "2019-03-12" },
  "delinquency": { "days_past_due": 34, "amount_past_due": 165.00,
                   "prior_delinquencies_12m": 2, "on_time_payment_ratio": 0.83 },
  "risk": { "segment": "Medium", "score": 52 },
  "behavior": { "app_user": true, "sms_responsive": true, "hardship_flag": false },
  "contact_context": { "timezone": "America/Chicago", "sms_allowed": true, "email_allowed": true,
                       "call_allowed": false, "recent_sms": 1, "recent_email": 0,
                       "recent_calls": 0, "recent_other": 0 },
  "restrictions": { "vulnerable": false, "cease_communication": false, "bankruptcy": false,
                    "attorney_represented": false, "deceased": false, "scra_protected": false,
                    "dispute_pending": false, "agency_placed": false },
  "arrangement": { "active": false, "promise_to_pay_status": "NONE" },
  "data_freshness": { "consent_as_of": "2026-11-06T05:40:00Z",
                      "contact_history_as_of": "2026-11-06T05:40:00Z",
                      "restrictions_as_of": "2026-11-06T05:40:00Z" }
}
```

The agent drops protected attributes (race, religion, and so on) and sensitive identifiers (card numbers, SSNs) on arrival. Nova should not send them.

## Calls and what comes back

Nova calls six MCP tools. The contact itself is recorded, but no channel gateway is connected yet, so nothing is delivered.

| Tool | Nova sends | Records? |
| --- | --- | --- |
| `get_recovery_strategy` | one `context` (v1) or `account` (v0) | yes |
| `preview_recovery_strategy` | the same | no, it is a what-if |
| `get_recovery_strategies` | `contexts` and/or `accounts`, up to 100 per call | yes; one bad account does not fail the batch |
| `report_payment_outcome` | the payment report below | yes, and this is how the model learns |
| `get_decision` | `decision_id` or `account_id` | no |
| `get_decision_updates` | `after` cursor, `limit` 1–500 | no; returns approvals, rejections and overrides made by people |

Two more tools are read-only: `list_live_strategies` and `list_treatments`.

### Decision response (main fields)

| Field | Meaning |
| --- | --- |
| `decision_id` | Keep it. It is used to report the outcome |
| `action` | What Nova should do (values in the next section) |
| `summary` | One plain sentence explaining the action |
| `strategy` | `strategy_id`, `name`, `version`, `evaluation_days` |
| `group` | Treatment, Control or Excluded |
| `treatment` | Code, name and channel of the chosen treatment |
| `selection_probability` | How often Thompson sampling picks this treatment for accounts like this one |
| `alternatives` | The other allowed treatments, with their probabilities |
| `blocked_treatments` | Each treatment the rules removed, with `reason_code` and reason |
| `message` | The text of the contact |
| `contact` | Channel, `send_at`, status and the send-time guard result |
| `review` | Whether a person must approve, and the approval status |
| `assumed` | Every default the agent filled in |
| `next_step` | What to call next, and when |

### Payment outcome (Nova → Recovery Agent)

Nova reports this after the strategy's `evaluation_days` window, for treated **and** control accounts. Control outcomes are the baseline that uplift is measured against.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `decision_id` | string | one of these two | Preferred |
| `account_id` | string | one of these two | The latest decision for the account is used |
| `paid` | boolean | yes | |
| `amount` | number ≥ 0 | no | Defaults to the `amount_past_due` that was sent |
| `payment_date` | date | no | Decides whether the payment fell inside the window |
| `payment_status` | Posted · Reversed | no, default Posted | A reversal counts as not paid |
| `payment_id` | string, max 64 | no | Each id counts once, and partial payments add up. Without an id, a new report replaces the last one |
| `cure_flag` | boolean | no | Nova's own view. It is recorded next to the agent's own, which is calculated from payments and arrears |

## Allowed values and rules

| Field | Values |
| --- | --- |
| `account.product` | Consumer Credit Card · Small Business Card · Retail Card · Co-Brand Card. Free text is also read: a value containing "business", "retail" or "co-brand" maps to that product; anything else maps to Consumer Credit Card |
| `risk.segment` | Low · Medium · High · Very high |
| `arrangement.promise_to_pay_status` | NONE · PENDING · KEPT · BROKEN |
| `payment_status` | Posted · Reversed |
| Days-past-due group (computed) | C1: 1–29 · C2: 30–59 · C3: 60–89 · C4: 90+ |

### Action values Nova must handle

| `action` | What Nova does |
| --- | --- |
| `contact` | Send the treatment. Report the outcome after the window |
| `awaiting_approval` | Wait. A person approves plans, deferrals and hardship offers. Poll `get_decision_updates` |
| `control_bau` | Keep the account on business as usual. Still report the outcome |
| `contact_blocked` | No allowed treatment, or the send-time check held it |
| `contact_failed` | The delivery check failed |
| `restricted` | A restriction is on file. No automated contact |
| `refer_to_specialist` | Vulnerable customer. Route the account to a person |
| `blocked_stale_data` | v1 only: guardrail data is missing or too old. Refresh it and resend |
| `rejected` · `cancelled` | A reviewer declined the offer, or it was withdrawn. Nothing was sent |
| `no_action` | No live strategy covers this account |

### Rules worth knowing

- **Idempotent.** Sending the same `account_id` while a decision is still open, or repeating a `request_id`, returns the existing decision. The customer is not contacted twice.
- **Contact cap.** No more than 7 contacts in 7 days across all systems. Nova's counts are added to the agent's own contacts.
- **Nothing is lost silently.** Unknown fields, aliases used and assumed values are all recorded with the decision. Accepted aliases include `dpd`, `balance`, `risk_score`, `customer_segment` and `product_type`.
- **Compliance placeholders.** The 24-hour freshness limits, and the rule that every restriction stops every treatment, are the most conservative reading. Compliance still has to approve them.
