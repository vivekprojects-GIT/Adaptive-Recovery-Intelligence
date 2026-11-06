# Recovery Agent data schema for Nova

As of 6 November 2026.

## Purpose

Nova is the Recovery Agent's data source, and nothing more. For each account, the agent reads the view below from Nova's tables and makes its decisions on its own side. Nova does not call the agent, and it does not act on the agent's decisions.

The tables behind this view, with an ER diagram and sample rows, are in [Nova data model for the Recovery Agent](nova-data-model.md). One CSV per table is in [`data/`](data/).

Only three fields are strictly required: `account.account_id`, `account.current_balance` and `delinquency.days_past_due`. If an optional field is missing, the agent fills in a stated, conservative default. If guardrail data is missing or stale, the agent fails closed: it blocks the affected treatments rather than contacting the customer.

## One account, as the agent reads it from Nova

One JSON object per account, with eight blocks. **Use** says what the Recovery Agent does with each field. *Decide* means it changes the action. *Guardrail* means it can block a treatment. *Stored* means it is kept for lineage but not used to decide.

### Envelope

| Field | Type | Required | Use |
| --- | --- | --- | --- |
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

## Allowed values and rules

| Field | Values |
| --- | --- |
| `account.product` | Consumer Credit Card · Small Business Card · Retail Card · Co-Brand Card. Free text is also read: a value containing "business", "retail" or "co-brand" maps to that product; anything else maps to Consumer Credit Card |
| `risk.segment` | Low · Medium · High · Very high |
| `arrangement.promise_to_pay_status` | NONE · PENDING · KEPT · BROKEN |
| `payment_status` | Posted · Reversed |
| Days-past-due group (computed) | C1: 1–29 · C2: 30–59 · C3: 60–89 · C4: 90+ |

### Rules worth knowing

- **Contact cap.** No more than 7 contacts in 7 days across all systems. Nova's contact history counts toward the cap together with the agent's own contacts.
- **Nothing is lost silently.** Unknown fields and assumed values are recorded with each decision.
- **Compliance placeholders.** The 24-hour freshness limits, and the rule that every restriction stops every treatment, are the most conservative reading. Compliance still has to approve them.
