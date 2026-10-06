# Adaptive Recovery Intelligence (ARI)

A prototype of the **intervention layer** for collections.

The client already has a collections dashboard, DPD buckets, a risk model and a way to identify
which customers or cohorts need action. ARI does not rebuild any of that. It starts where those
systems stop: once a customer or cohort has been identified, ARI decides **what intervention to
run**, tests it properly, and learns from the results.

```
Client dashboard / risk model        (existing - shown as context only)
  → Customer or cohort handoff
  → Intervention strategy sheet
  → Select strategies
  → Experiment: eligible population → sampling & groups → strategy assignment
  → Outcome tracking & learning
```

## ARI Console

The app is an operating console with three role-based workspaces. Sign in by choosing a demo persona (a stand-in for single sign-on); switch persona or sign out from the user menu in the top-right.

**Branding.** The theme follows Capgemini's live Zodiak design system (capgemini.com):
- **Type and colour:** Ubuntu typeface, navy primary actions (#1D365A), the Capgemini blue scale with azure (#0058AB) for active states, and peacock teal for AI accents.
- **Status:** colours come from Zodiak's green, orange and red scales.
- **Charts:** a categorical palette drawn from the same hues and validated for colour-blind separation.

All values live in `frontend/tailwind.config.js` and the `:root` block of `frontend/src/index.css`. The official logo is not bundled: drop the approved files from the brand portal into `frontend/public/brand/` (see the README there). Until then a typographic wordmark is shown.

| Workspace | Persona | Screens |
|---|---|---|
| Strategist | Maya Patel | My Dashboard, Strategy Builder (library · 6-step guided build · AI draft from a brief), My Strategies, Strategy Analytics, Treatment Playbook, Customers, Live Campaigns, Review Queue, AI Activity, Journeys, Nudges, Decisions, Cohorts & Handoffs |
| Strategy Leader | James Thornton | KPI Dashboard, Strategy Analytics, Portfolio Health, Strategy Compare, Approvals, Compliance, AI Workbench, Treatment Playbook (read-only), Team Performance, Reports |
| Platform Admin | Priya Nair | Admin Dashboard, User Management, Roles & Permissions, Platform Config, Treatment Playbook, API & Integrations, Audit Log, System Health, Alert Rules |

**What is real.** Every decision, nudge, engagement event, outcome, violation and audit entry is written by the engine to SQLite, and every screen reads from that log. Five weeks of history are produced on first start by running the real engine week by week. Permissions are enforced by the API on every request, not just hidden in the UI. System Health latency is measured from live requests.

**What is simulated.** Customer behaviour (`app/simulation.py`) and channel delivery. No channel gateway is connected, so shadow mode is locked on: decisions are made and logged, every send is simulated, and no customer is contacted. Messages quote only amounts the bank supplied and never a card number.

**Thompson sampling, precisely.** One Beta posterior per treatment per strategy, learned from outcomes. A fixed, hand-written customer-fit table tilts each draw toward the customer's profile; the learner does not estimate those effects itself. A learned contextual model is a later phase.

**Governance built in.**
- A strategy runs only after someone other than its author approves it (maker-checker).
- A strategy that has run is never edited in place. **Edit** opens the next version as a draft; the running version keeps going as approved until the new one is approved and launched, which archives the old one. Customers already in the old version stay with it, and the new version gets its own control group.
- A material change to a strategy that has not run yet (approved, in review, paused) bumps the version and sends it back for approval.
- Delete is only for strategies and treatments that have never decided a customer. Anything with history is archived (strategies) or retired (treatments), so every past result keeps its evidence.
- The treatment playbook is data, not code: each treatment has a kind (which decides how customer fit is judged), eligibility rules, a channel, a cost and an approval policy. Strategists add, edit, retire and delete treatments on **Treatment Playbook**, with a live preview of who a rule set reaches.
- Forbearance offers (split plan, deferral, hardship review) wait in a review queue for a person before anything is sent.
- Contact rules run before Thompson sampling: consent, opt-outs (permanent) and the 7-in-7 cap remove the treatments a customer may not receive, so the bandit only ever chooses among allowed ones. Each blocked treatment is recorded on the decision with a reason code. The same rules run again at send time.
- Contact hours are enforced when a strategy is built: its send window must sit inside the permitted hours (UTC; customer time zones are not yet supplied).
- The compliance monitor scans ARI messages and the bank's BAU contacts together.
- Overrides require a reason and stop the model learning from that customer.

**Measurement honesty.**
- Every result is reported as uplift over the strategy's own randomised control.
- Results come with a 95% interval (Agresti–Caffo, sound at small samples) and the smallest effect the sample can detect.
- Per-treatment rates are shown raw and reweighted by the logged selection probability.
- Intervention-fit groups are labelled by what the scores estimate ("Likely responsive", "Likely self-cure"); the quadrant names are kept as provisional hints.

**Thompson sampling you can watch.**
- Each wave is decided with everything learned before it. A strategy's **Arms & learning** tab shows each treatment's belief and 95% band wave by wave, the share of customers each treatment received, and the probability that each is the best.
- A treatment with a track record starts from it, weighted lightly. A new treatment with none starts from a flat prior, so it is explored on equal terms.
- **Run 5** runs five waves in a row. When a strategy's audience is too small for a full wave, the next cohort handoff arrives automatically (Platform Config can switch this off; **Receive next handoff** does it by hand).
- **Strategy Analytics** puts every strategy side by side: its result against its own control group, and where Thompson sampling stands in it (settled, leaning or exploring, and on which treatment). Each row opens to the per-treatment detail. When a favourite reaches few customers, the verdict says why: few are eligible for it, or customer fit sends people elsewhere.

---

## Quick start

Two terminals.

**Backend** (FastAPI, port 8000):

```bash
cd backend && python -m venv .venv && .venv/Scripts/python.exe -m pip install -r requirements.txt && .venv/Scripts/python.exe -m uvicorn app.main:app --port 8000
```

**Frontend** (Vite, port 5173):

```bash
cd frontend && npm install && npm run dev
```

Open <http://localhost:5173>. The database seeds itself on first boot. API docs are at
<http://localhost:8000/docs>. A platform admin can put the data back to its starting state with
`POST /console/admin/reseed`.

**Tests.** One command runs every end-to-end suite (each starts the real API on a throwaway
database) and a static check:

```bash
cd backend && .venv/Scripts/python.exe -m pip install -r requirements-dev.txt && .venv/Scripts/python.exe -m pytest -q
```

| Suite | Covers |
| --- | --- |
| `tests/verify_mcp.py` | The MCP server over the real protocol: access, routing, consent and caps, learning, approvals, batch |
| `tests/verify_thompson.py` | Treatment playbook, strategy lifecycle and versions, and that Thompson sampling finds a better treatment and drops a weak one |
| `tests/verify_context.py` | RecoveryContext v1, frozen snapshots, per-rule eligibility records, freshness, migration of an older database |
| `tests/verify_suggestions.py` | Suggested strategies: evidence, drafting, versioning and approval |

GitHub Actions (`.github/workflows/ci.yml`) runs the same tests and the frontend type-check and
build on every push to `main` and on pull requests.

---

### The example cohort

The seeded data is built around the handoff example: **30 DPD → medium risk → payment expected in
7–10 days → 509 customers**. Three named customers sit in that cohort with the same DPD and the
same client risk band, but need completely different handling:

| | Intervention fit | What ARI does |
| --- | --- | --- |
| **Priya Sharma** | Can be helped | Enters the experiment - split plan, deferral or in-app nudge |
| **John Mitchell** | Will pay anyway | Cheapest reminder only - kept out of costly treatments |
| **Mike Torres** | Needs hardship support | Routed to the hardship team, outside the experiment |

---

## Open item: delayed outcomes

A payment can arrive days after the intervention (the example cohort expects 7–10 days). How to
handle that isn't decided yet: how long to wait before calling a result, how to treat customers
whose outcome is still pending, and when late results feed back into the learning.

**The prototype does not settle this.** It records each wave's outcome as soon as the wave runs,
so the flow can be demonstrated. The screens flag this as an open item wherever it matters.

---

## How it works

**What ARI does not compute.** Delinquency risk. `client_risk_band` and `client_risk_score` arrive
with the handoff and are shown as client data.

**Intervention fit** (`app/scoring.py`). Two scores per customer:
- *Influenceability* - SMS response, app usage, tenure, temporary hardship, payment history. Severe
  arrears discount it, because a nudge can't replace lost income.
- *Self-cure* - how likely they are to pay without help.

Together they give four groups: can be helped, will pay anyway, needs hardship support, leave alone.
Strategies target the groups an intervention can change.

**Rules before learning** (`app/console/rules.py`). Every candidate treatment is checked against
every rule - playbook status, its own eligibility rules, hard stops, consent, opt-out, contact caps,
freshness - and every result is stored. Only treatments that pass every rule can be chosen.

**Decisions** (`app/console/engine.py`). A deterministic share of each strategy's accounts is held
out as its control group. For the rest, Thompson sampling draws once per allowed treatment from its
belief (a Beta distribution seeded lightly from the playbook's historical rate), tilts the draw by
customer fit, and the highest draw wins. Console waves learn in batches; agent decisions learn as
outcomes are reported.

**Outcomes in test environments** (`app/simulation.py`). Customer responses come from a simulator
with hidden true response rates per fit group and treatment kind. The engine never reads them; it
only sees paid / not-paid results.

---

## Code layout

```
backend/app/
  core/            settings (environment) and database access
  console/
    routes/        the console API, one module per area: session, strategies, treatments, handoffs,
                   dashboards, customers, decisions, compliance, workbench, reports, alerts, admin
    contract.py    RecoveryContext v0 / v1: what Nova may send
    rules.py       guardrails and eligibility, every rule for every candidate treatment
    engine.py      control split, Thompson sampling, execution, learning
    nova.py        the agent (MCP) service: decisions and outcome reports
    mcp_server.py  the MCP transport and access
    suggest.py     suggested strategies from the decision log
    analytics.py   uplift, results and learning read models
  scoring.py       intervention fit and eligibility rules
  simulation.py    customer responses for test environments
frontend/src/console/
  shell/           header, sidebar, menus, environment panel
  routes.tsx       every page and the permission it needs
  pages/           one folder per workspace; large pages split by feature (strategist/builder/)
  ui/              shared components and charts
```

Every console route names the permission it needs (`console/rbac.py`); the UI hiding a control is
never the only check.

---

## Agent access (MCP)

ARI is also an **MCP server**, so an agent such as Nova's can send an account and get the recovery
strategy back, with no console in between. Nova owns the data; ARI owns the decision.

| | |
| --- | --- |
| Endpoint | `http://localhost:8000/mcp` locally, `https://<host>/api/mcp` on Render |
| Transport | Streamable HTTP, stateless, JSON responses: any MCP client, no session affinity |
| Auth | `Authorization: Bearer <token>`. An admin reveals, copies or rotates the token under **API & Integrations**; `ARI_MCP_TOKEN` in the environment overrides it |
| Input | The account in the Nova data contract's terms (`RecoveryStrategy_Nova_Contract/05-nova-api-contract.md`). Only `account_id`, `days_past_due` and `current_balance` are required; anything missing is defaulted and listed back under `assumed` |

| Tool | What it does |
| --- | --- |
| `get_recovery_strategy` | Decide and record the action for one account: strategy, treatment, message, reasons, alternatives with selection probabilities, next step |
| `preview_recovery_strategy` | The same answer without recording, contacting or reserving anything |
| `get_recovery_strategies` | Up to 100 accounts in one call (a cohort handoff) |
| `report_payment_outcome` | The payment result. Treated outcomes update the model; control outcomes measure uplift; a second report corrects the first (a reversal) |
| `get_decision` | A decision's current state: was the offer approved, was the contact sent, what was the outcome |
| `list_live_strategies`, `list_treatments` | What ARI is running, and the approved treatments it chooses from |

**The same rules apply as in the console.**
- The account goes to the live strategy written most specifically for it.
- A random share is held out as control, and Nova should keep those accounts on business as usual.
- Payment plans, deferrals and hardship offers wait in the Review Queue for a person to approve.
- Nova's consent flags and its count of recent contacts are applied before Thompson sampling, so a treatment the customer may not receive is never chosen.
- A vulnerability flag means no automated treatment: the customer is referred to a specialist, and any offer still waiting for review is cancelled.
- Approving a waiting offer re-checks consent, contact limits and vulnerability against the newest data Nova sent for the account.
- Asking twice about the same account returns the same decision; the customer is not contacted twice.
- Outcomes for agent decisions are never simulated; ARI waits for Nova to report them.

**The contract: RecoveryContext v0 and v1** (`backend/app/console/contract.py`). The tools take either
`account` (v0, the original flat payload, unchanged) or `context` (v1: `request_id`, `as_of_timestamp`,
party, account, delinquency, arrangement / promise to pay, per-channel contact context with time zone,
restrictions and freshness timestamps). Both are read into one account; aliases are accepted
(`balance`, `dpd`, `product_type`, `sms` ...) and every answer lists the fields ARI ignored and the
values it assumed. A repeated `request_id` returns the decision already made.

- **Every rule, for every treatment** (`rules.py`): playbook status, business rules, hard stops
  (vulnerability, restrictions), contact rules (consent, opt-out, caps) and arrangement context are all
  evaluated - none stops at the first failure - and stored in `eligibility_evals`. An account with no
  allowed treatment is recorded as `Excluded`, before the control split.
- **Arrangement / promise-to-pay rule: off, `PENDING_BUSINESS_CONFIRMATION`.** Implemented and switchable
  (`arrangement_blocks_new_offers`), but it does not block anything until the business confirms that an
  active arrangement or pending promise to pay must stop a new plan or deferral offer. Each decision still
  records what it would have done.
- **Frozen context** (`feature_snapshots`): the raw request, the normalised values used, as-of time,
  feature-set version, lineage, assumed and ignored fields, and freshness. Written once; the ORM refuses
  updates. The decision audit screen reads it, never today's customer record.
- **Freshness**: consent, contact history and restrictions are measured against per-field limits in
  Platform Configuration. The 24-hour values there are **compliance placeholders, not approved
  requirements** - they exist so the mechanism can be shown, and compliance must set the real limits. Only
  v1 requests fail closed; for v0 staleness is logged as `NOT_ENFORCED_V0`.

Check it with `tests/verify_context.py` (v1, snapshots, rule records, freshness, migration).

Every call is in the audit log as the Nova agent. Nova's decisions are marked in **Decisions**, and
**API & Integrations** shows the traffic and has a "Try it" panel that sends a real request.

```bash
cd backend && .venv/Scripts/python.exe tools/nova_agent_demo.py
```

That plays Nova against the running app: four accounts, a batch of ten, then the payment reports.
To connect Claude Code instead, copy the command from **API & Integrations → Connect an agent**.

```bash
cd backend && .venv/Scripts/python.exe tests/verify_mcp.py
```

That checks the whole path over the real protocol on a throwaway database: access, routing, consent,
contact caps, approval, learning, batch, and token rotation.

---

## Deploy to Render (free tier)

One Docker web service: the build compiles the React app, and FastAPI serves it at `/` with the API
under `/api`.

In Render, go to **New → Blueprint**, pick this repository, and apply. `render.yaml` sets the
Docker runtime, free plan, a `/healthz` health check and auto-deploy on push. Set `ARI_MCP_TOKEN`
if an agent will call the MCP endpoint: the free tier re-seeds on every restart, and a generated
token would change with it.

On the free tier:
- **It sleeps after 15 minutes idle.** The first request after that takes about a minute.
- **Restarts wipe local state.** The database re-seeds on boot, and any running experiment is lost.
  The app shows a "set it up again" message when that happens.
- **The console API is unauthenticated** (the persona switcher sets the user). Fine for synthetic
  data, but don't put real data behind it. The MCP endpoint always requires its token.

---

## Stack

**Backend:** Python 3.12, FastAPI, SQLAlchemy 2.0, NumPy, the MCP Python SDK. SQLite locally. Set
`DATABASE_URL` for Postgres.
**Frontend:** React 19 + TypeScript, Vite, Tailwind CSS, Recharts, React Router.

All customer data is synthetic.
