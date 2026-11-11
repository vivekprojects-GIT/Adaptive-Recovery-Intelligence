# CARE product requirements document

| | |
| --- | --- |
| Product | CARE: Collection and Recovery Agent (repository: Adaptive Recovery Intelligence) |
| Client | Meridian Valley Bank (fictional), card collections and recovery |
| Stage | Working prototype on synthetic data |
| Companion documents | [product-guide.md](product-guide.md) · [data-schema.md](data-schema.md) · [nova-data-model.md](nova-data-model.md) |

---

## 1. Summary

The bank knows which card accounts are late and how risky they are. It does not know which action
will get each customer to pay, and today it treats a whole days-late group the same way. Some of that
contact is wasted on customers who would have paid anyway; some of it is the wrong action for
customers who could have been helped.

CARE is the **intervention layer** that sits on top of the bank's existing collections data. For every
account that needs action, it decides **which treatment to run**, checks every rule first, keeps a
person in charge of sensitive decisions, measures each strategy against its own randomised control
group, and learns from the results.

---

## 2. Problem

| Today | Effect |
| --- | --- |
| One treatment path per days-late group | The same reminder goes to a customer who would pay anyway and to one who needs a payment plan |
| No control group | Collections teams report what was collected, not what their strategy caused |
| Rules applied in separate systems | Consent, opt-outs, restrictions and contact caps are hard to prove for any single contact |
| Strategy changes made in place | Results from before and after a change are mixed together |
| Decisions not explained | Model risk and compliance cannot see why a customer got a given action |

---

## 3. Goals and measures

| Goal | Measure | Where it is shown |
| --- | --- | --- |
| Collect more because of the strategy, not alongside it | Uplift: treated payment rate minus control payment rate, with a 95% interval | Strategy page, Strategy analytics, Strategy compare |
| Spend less contact on customers who pay anyway | Share of likely self-cure customers kept on business as usual; contact cost per recovery | Scorecards, Strategy compare |
| Choose better treatments over time | Thompson sampling's beliefs narrowing; allocation shifting to the best treatment wave by wave | Strategy page (Arms and learning), Scorecards |
| Never break a contact rule | Zero critical compliance violations; every blocked treatment stored with a reason code | Compliance, decision trace |
| Keep people in charge | 100% of payment plans, deferrals, hardship reviews, settlements and large balances approved by a person | Review queue, Audit log |
| Explain every decision | Every decision has a stored trace and frozen data | Decisions |
| Recover more from charged-off accounts | Recovered amount against charge-off balance, by treatment, against a 10% control | Strategy workspace → Recovery |

---

## 4. Non-goals

- **Scoring delinquency risk.** The bank's risk band and score are inputs, shown as the bank's data.
- **Replacing the collections system.** CARE starts once an account needs action.
- **Owning customer data.** Nova is the source of truth; CARE reads it.
- **Sending messages itself.** CARE decides and schedules; a channel gateway delivers (not connected in
  the prototype).
- **Choosing who to contact in hardship.** Customers who need support go to the hardship team.

---

## 5. Users

| Role | Needs | Must not be able to |
| --- | --- | --- |
| **Strategy analyst** | Build and run strategies, see results against control, work the review queue, assign recovery treatments, ask questions about accounts | Approve their own strategy; approve their own agency proposal |
| **Executive** | Approve strategies, compare them, push improvements to analysts, approve placements, see compliance and governance | Edit a running strategy in place |
| **Platform admin** | Manage users, roles, settings, agent access, health and alerts | See customer data, or be granted permission to |
| **Calling agent** (another system, over MCP) | Get the action for one account, report payments, ask questions about the data | Receive a customer's name |

---

## 6. Functional requirements

Status: **Built** means working in the prototype and covered by an end-to-end test suite where one is
named. **Partly** and **Not yet** are explained in the row.

### 6.1 Accounts and data

| ID | Requirement | Status |
| --- | --- | --- |
| FR-1 | Accept delinquent accounts handed over by the collections system, in four days-late groups (C1 1–29, C2 30, C3 60, C4 90+) | Built |
| FR-2 | Show the bank's risk band and score as the bank's data; do not compute delinquency risk | Built |
| FR-3 | Move accounts that are charged off or 180+ days past due into recovery, tracked by what remains of the charged-off balance | Built |
| FR-4 | Read account data from Nova using the 11 tables in [nova-data-model.md](nova-data-model.md) | **Not yet**: the contract and sample data are defined; the prototype runs on its own seeded database |
| FR-5 | Freeze the exact data each decision was made on; never update it | Built (`verify_context.py`) |

### 6.2 Propensity Router

| ID | Requirement | Status |
| --- | --- | --- |
| FR-6 | Score each customer for intervention fit (influenceability and self-cure) and place them in a fit group | Built |
| FR-7 | Route likely responsive to a strategy, likely self-cure to business as usual, needs support to the hardship team, and do not contact to suppression | Built (`verify_router.py`) |
| FR-8 | Send a validation share (default 5%, at most 10%) of the self-cure and needs-support groups against their route, keep it out of strategy results and learning, and score the router with it | Built |

### 6.3 Treatment playbook

| ID | Requirement | Status |
| --- | --- | --- |
| FR-9 | Hold treatments as data, not code: kind, channel, offer, cost, eligibility rules, approval policy, version | Built (`verify_thompson.py`) |
| FR-10 | Retire treatments with history instead of deleting them | Built |
| FR-11 | Treat payment plans, deferrals and hardship reviews as always needing a person | Built |

### 6.4 Strategies

| ID | Requirement | Status |
| --- | --- | --- |
| FR-12 | Let an analyst build a strategy: audience, allowed treatments, control share, wave size; from a suggestion, the library, a guided build or a brief | Built |
| FR-13 | Require approval by someone other than the author before a strategy can launch; a returned strategy carries the reason | Built (`verify_governance.py`) |
| FR-14 | Never edit a strategy that has run: an edit creates the next version as a draft; the old version keeps running until the new one launches, then is archived | Built (`verify_thompson.py`) |
| FR-15 | Keep a randomised control group per strategy version | Built |
| FR-16 | Run strategies in waves, each wave using what the earlier waves learned | Built |
| FR-17 | Suggest strategies from the decision log, with the evidence behind each suggestion | Built (`verify_suggestions.py`) |

### 6.5 Rules and decisions

| ID | Requirement | Status |
| --- | --- | --- |
| FR-18 | Before choosing, check every rule for every candidate treatment: playbook status, eligibility, hard stops (vulnerability and seven legal restrictions), existing arrangements, consent, opt-out, the 7-in-7 contact cap, the call cap and data freshness | Built |
| FR-19 | Store every rule result with a reason code, the reason and the inputs it read | Built |
| FR-20 | Run the contact rules again at send time | Built |
| FR-21 | Choose among allowed treatments with Thompson sampling: one Beta belief per treatment per strategy, a prior from the treatment's track record weighted lightly, a fixed customer-fit tilt | Built (`verify_thompson.py`) |
| FR-22 | Log the selection probability of the chosen treatment so results can be reweighted | Built |
| FR-23 | Explain every decision in plain words: winner, runner-up, belief, fit, what was not allowed and why | Built |
| FR-24 | Count every contact, CARE's and the bank's, toward the contact cap | Built |

### 6.6 Human review

| ID | Requirement | Status |
| --- | --- | --- |
| FR-25 | Send decisions at or above the review threshold (default $10,000), and every plan, deferral and hardship review, to a review queue before anything is sent | Built |
| FR-26 | Let a reviewer approve, reject or override; an override needs a reason and stops the model learning from that customer | Built |
| FR-27 | Tell the calling agent when a person changes its decision: a signed callback with retries, and a tool to read the changes | Built (`verify_callbacks.py`) |

### 6.7 Outcomes and learning

| ID | Requirement | Status |
| --- | --- | --- |
| FR-28 | Record payments against decisions, including partial payments, duplicates, reversals and payments outside the window | Built (`verify_payments.py`) |
| FR-29 | Score each decision at the end of its evaluation window (default 7 days) and update the strategy's beliefs | Built |
| FR-30 | Decide how long to wait for delayed payments and how to treat outcomes still pending | **Not yet**: open design item (section 10) |
| FR-31 | Report uplift over control with a 95% interval (Agresti–Caffo) and the smallest detectable effect | Built |
| FR-32 | Show per-treatment results raw and reweighted by selection probability | Built |

### 6.8 Recovery and agencies

| ID | Requirement | Status |
| --- | --- | --- |
| FR-33 | Let an analyst assign a recovery treatment to selected charged-off accounts: R1 settlement offer, R2 one-time payment, R3 human review | Built |
| FR-34 | Send every settlement to a reviewer; route accounts with $25,000 or more remaining to a specialist only | Built |
| FR-35 | Hold back 10% of recovery accounts as a control | Built |
| FR-36 | Propose late-stage placements with the bank's agencies; a person approves each, never their own proposal | Built (`verify_governance.py`) |
| FR-37 | Never contact a placed account; compare agencies on net recovery after fees | Built |

### 6.9 Analysis and oversight

| ID | Requirement | Status |
| --- | --- | --- |
| FR-38 | Dashboards per role: portfolio, flows, collected and recovered by week, payment rate against control, strategies off track, items needing attention | Built |
| FR-39 | Compare up to three strategies on uplift, trend and cost per recovery | Built |
| FR-40 | Let an executive draft an improvement for an underperforming strategy and send it to its owner | Built |
| FR-41 | Monitor compliance across CARE's and the bank's contacts, with a resolution workflow | Built |
| FR-42 | Export CSV reports for model risk, compliance and management | Built |
| FR-43 | Show one customer's full journey: decisions, contacts, responses, payments, the bank's own contacts | Built (`verify_journey.py`) |
| FR-44 | Live run: follow one customer through the real engine step by step, and store the result | Built |

### 6.10 Questions about the data

| ID | Requirement | Status |
| --- | --- | --- |
| FR-45 | Answer plain-English questions about the accounts with fixed rules, allowed fields only, showing the conditions run and the words not understood | Built (`verify_query.py`) |
| FR-46 | Let a question's result become a strategy's audience | Built |
| FR-47 | Offer the same questions and a recovery knowledge graph to agents, returning account numbers and never names | Built (`verify_mcp_questions.py`) |
| FR-48 | Header search across pages, strategies, customers, decisions and messages, limited to what the role may open | Built (`verify_search.py`) |

### 6.11 Agent access

| ID | Requirement | Status |
| --- | --- | --- |
| FR-49 | Serve CARE as an MCP server (streamable HTTP, bearer token): decide one account or up to 100, preview, report payments, read decisions and updates, list strategies and treatments | Built (`verify_mcp.py`) |
| FR-50 | Accept partial account data: require only account ID, days past due and balance; default the rest and list it back as assumed | Built |
| FR-51 | Let an admin reveal, copy and rotate the token, and try the tools from the console | Built |

### 6.12 Administration

| ID | Requirement | Status |
| --- | --- | --- |
| FR-52 | Manage users and roles; grant or deny each permission per role, enforced by the API on every request | Built |
| FR-53 | Change platform settings: review threshold, contact caps, contact hours, wave size, evaluation window, prior strength, validation share, freshness limits | Built |
| FR-54 | Record every user, system and agent action in a read-only audit log | Built |
| FR-55 | Show system health, traces, metrics, events and logs from the decision engine | Built |
| FR-56 | Alert rules on live metrics, shown on the executive dashboard | Built |

---

## 7. Non-functional requirements

| Area | Requirement | Status |
| --- | --- | --- |
| Access | Permissions enforced by the API, not only hidden in the UI. Admin holds no data permissions and cannot be given them | Built |
| Sign-in | Single sign-on | **Not yet**: the prototype uses a persona switcher, fit only for synthetic data |
| Privacy | Agents, traces and logs never carry a customer's name; inbound customer data is encrypted before storage; messages quote only bank-supplied amounts, never a card number | Built (`verify_governance.py`, `verify_callbacks.py`) |
| Fairness | Protected attributes are not used to decide; they are accepted and stored only for checks | Built (`verify_governance.py`) |
| Traceability | Every decision keeps its frozen data, every rule result and its explanation; every action is audited | Built |
| Contact compliance | 7-in-7 contact cap and call cap across all systems; contact hours 8am–9pm local; opt-out suppression within 24 hours | Built (values set by the admin) |
| Data freshness | Stale consent, contact history or restrictions block the channels that depend on them | **Partly**: mechanism built; the 24-hour limits are placeholders until compliance sets them |
| Data integrity | Every link between tables is a declared, enforced foreign key; real date and time types on Postgres; older databases upgrade in place | Built (`verify_schema.py`) |
| Performance | API p95 latency under 800 ms (alert threshold) | Monitored on System health |
| Deployability | One Docker service; SQLite locally, Postgres via `DATABASE_URL`; CI runs backend tests and the frontend build on every push | Built |
| Language | UI copy in sentence case; plain English; no AI-style decoration | Built |

---

## 8. Dependencies

| Dependency | What CARE needs | Status |
| --- | --- | --- |
| **Nova** (the bank's data layer) | Party, account, daily snapshot, consent, restrictions, freshness, arrangements, contact history, payments, charge-offs, agencies | Contract and sample data defined in [nova-data-model.md](nova-data-model.md) |
| **Channel gateway** | Deliver SMS, app push, email and calls; return delivery and engagement events | Not connected: decisions are logged, no customer is contacted |
| **Single sign-on** | Real identities and roles | Not connected |
| **Agency panel** | Placement files and recovery returns | Simulated |

---

## 9. Release plan

| Phase | Scope |
| --- | --- |
| **Now: prototype** | Everything marked Built, on synthetic data, deployed to Render's free tier (sleeps when idle; resets on restart unless Postgres is set) |
| **Next: connect** | Read from Nova; Postgres; single sign-on; decide the delayed-outcome policy; compliance sets the freshness limits |
| **Then: pilot** | One card business, one days-late group, a channel gateway in test mode, real outcomes measured against control |
| **Then: scale** | All card businesses and groups; recovery and agency flows on live data |

---

## 10. Open items and risks

| Item | Why it matters | Current handling |
| --- | --- | --- |
| **Delayed outcomes** | A payment can arrive days after the contact. Calling results too early understates what worked | Each wave's outcome is recorded when the wave runs; screens flag this |
| **Freshness limits are placeholders** | Without approved limits, stale data could be relied on | 24 hours as a stand-in, labelled as not approved |
| **Customer-fit table is fixed** | The tilt toward a customer's profile is set, not learned | Documented; a candidate for later learning |
| **Persona sign-in** | Not secure for real data | Synthetic data only; MCP always needs its token |
| **Free hosting resets data** | Demo state is lost on restart | Seed data recreates on start; Postgres removes the issue |
| **Simulated behaviour** | Results in the prototype show the mechanics, not real effect sizes | All data synthetic; the pilot measures real effects |

---

## Appendix: default settings

| Setting | Default |
| --- | --- |
| Human review threshold | $10,000 |
| Contacts per customer per 7 days | 7 |
| Call attempts per 7 days | 7 |
| Contact hours | 8am to 9pm local |
| Opt-out suppression | Within 24 hours |
| Default wave size | 40 |
| Evaluation window | 7 days |
| Prior strength | 10 pseudo-observations |
| Router validation share | 5% (at most 10%) |
| Recovery control share | 10% |
| Specialist-only recovery balance | $25,000 |
| Settlement offer | 60% of what remains |
