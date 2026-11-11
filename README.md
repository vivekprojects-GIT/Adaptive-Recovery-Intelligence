# CARE: Collection and Recovery Agent

A prototype of the **intervention layer** for collections and recovery. The repository is still named
Adaptive Recovery Intelligence (ARI); the app is now called CARE, and a few environment variables keep
the old `ARI_` prefix.

The bank, the fictional Meridian Valley Bank, already has a collections dashboard, days-late buckets,
a risk model and a way to find which customers need action. CARE does not rebuild any of that. It
starts where those systems stop: once an account needs action, CARE decides **which treatment to
run**, tests it against a randomised control group, and learns from the results.

```
Nova (the bank's data layer)          customer, account, delinquency, consent, contacts, payments
  → Days-late group and Propensity Router
  → Live strategy written by the business
  → Rules: consent, restrictions, contact caps, eligibility
  → Thompson sampling among the allowed treatments
  → Contact, outcome, learning
```

## Nova is the data source

Nova, the bank's enterprise data layer, owns what is true about the customer. CARE only reads from it
and keeps its own decisions, strategies and results.

| Document | What it covers |
| --- | --- |
| [docs/prd.md](docs/prd.md) | Product requirements: the problem, goals, users, every requirement with its status, dependencies, release plan and open items |
| [docs/product-guide.md](docs/product-guide.md) | How CARE works: roles, every page, and the main flows from account to outcome, with diagrams |
| [docs/data-schema.md](docs/data-schema.md) | How the data is organised: Nova against CARE, the tables, how they link, and which step writes each one |
| [docs/nova-data-model.md](docs/nova-data-model.md) | The 11 tables CARE needs from Nova, with an ER diagram, column descriptions and sample rows |
| [docs/data/](docs/data/) | One CSV of sample rows per table, plus `data_dictionary.csv` (every column) and `tables.csv` (every table) |
| [docs/nova-recovery-context-schema.md](docs/nova-recovery-context-schema.md) | One account as CARE reads it: every field, its type, and what CARE does with it |
| [docs/care-database-schema.md](docs/care-database-schema.md) | CARE's own database: all 30 tables and their columns, keys and types |

Today CARE runs on its own SQLite database, seeded with synthetic accounts. The Nova tables replace
that source data.

## The console

CARE is an operating console with three role-based workspaces. Sign in by choosing a demo persona, a
stand-in for single sign-on. Switch persona or sign out from the user menu in the top right.

| Role | Persona | Sidebar |
| --- | --- | --- |
| Strategy analyst | Morgan Ellsworth (also Ryan Holcomb) | **Overview:** Dashboard · **Accounts:** Customers, Journeys, Cohorts and handoffs · **Strategy workspace:** Strategy workspace, Collections journey, Strategy builder, My strategies, Treatment playbook · **Analysis:** Strategy analytics, Scorecards, Decisions · **Execution:** Live campaigns, Live run, Review queue, Collection agencies, Nudges, Activity |
| Executive | Jordan Whitcomb | **Overview:** Dashboard, Portfolio health · **Accounts:** Customers, Decisions · **Strategy workspace:** Strategy workspace, Collections journey, Approvals, Strategy compare, Treatment playbook, Strategy workbench · **Analysis:** Strategy analytics, Scorecards, Team performance, Reports · **Execution:** Collection agencies, Compliance, Security and governance |
| Platform admin | Patricia Vaughn | **Overview:** Admin dashboard, User management, Roles and permissions · **Configuration:** Platform configuration, API and integrations, Audit log, Security and governance · **Monitor:** System health, Observability, Alert rules |

- **Permissions are enforced by the API** on every request, not just hidden in the UI (`console/rbac.py`).
- **The admin never sees customer data.** The role holds no data permissions and cannot be granted them.
- **Header search** (`/` or Ctrl+K) finds pages, strategies, customers, decisions and messages, limited to
  what the role may open.

**Branding.** The theme follows Capgemini's Zodiak design system: the Ubuntu typeface, navy primary
actions (#1D365A), azure (#0058AB) for active states, and status colours from Zodiak's green, orange and
red scales. Values live in `frontend/tailwind.config.js` and the `:root` block of
`frontend/src/index.css`. Replace the logo in `frontend/public/brand/` before any external release.

## What the console does

**Live run** (Execution > Live run). Follows one customer through a live strategy step by step: pick
the customer, weigh the treatments (explore or exploit), send, the customer responds, record the
outcome, learn. It uses the same engine as every other decision and stores the result, so the run then
appears in the customer's journey, the decision audit and the strategy's results. Two scenarios: *pays
on the first message*, and *no answer, then a second try*, where the engine sets the first treatment
aside for that customer and picks again.

**Collections and recovery.**
- Accounts fall into four days-late groups: 1–29, 30, 60 and 90+ days late (C1–C4). Risk bands vary
  within a group, using the bank's risk score.
- Charged-off accounts, or accounts 180 or more days past due, move to **Recovery**: a tab in Collections
  Journey and Strategy workspace. They are tracked by what remains of the charged-off balance.
- **Collection agencies** proposes placements with the bank's agencies. A person always approves a
  placement, and whoever proposed it cannot approve it.

**Propensity Router.** Before strategies, each customer is routed by fit group:
- Likely responsive goes to a strategy.
- Likely self-cure stays on business as usual.
- Needs support goes to the hardship team.
- Do not contact is suppressed.

A small validation share is sent against its route so the router itself can be scored (Scorecards).

**Plain-English questions.** The Customers page answers questions about the accounts in plain English.
It is rule-based, uses only allowed fields and shows the conditions it ran. A result can become a
strategy's target audience.

**Thompson sampling.**
- One Beta belief per treatment per strategy, learned from outcomes. A treatment with a track record
  starts from it, weighted lightly. A new treatment starts flat, so it is explored on equal terms.
- A fixed customer-fit table tilts each draw toward the customer's profile; the learner does not
  estimate those effects itself.
- A strategy's **Arms and learning** tab shows each treatment's belief and 95% band wave by wave, and the
  chance that each is the best.

**Governance.**
- A strategy runs only after someone other than its author approves it (maker-checker).
- A strategy that has run is never edited in place. **Edit** opens the next version as a draft. The
  running version keeps going until the new one is approved and launched.
- Strategies and treatments with history are archived or retired, never deleted.
- The treatment playbook is data, not code. Each treatment has a kind, eligibility rules, a channel, a
  cost and an approval policy.
- Payment plans, deferrals and hardship reviews wait in the Review queue for a person.
- Contact rules run before Thompson sampling: consent, permanent opt-outs and the 7-in-7 contact cap
  remove treatments the customer may not receive. Each blocked treatment is recorded with a reason
  code, and the same rules run again at send time.
- Overrides require a reason and stop the model learning from that customer.

**Measurement.**
- Every result is reported as uplift over the strategy's own randomised control group.
- Results come with a 95% interval (Agresti–Caffo) and the smallest effect the sample can detect.
- Per-treatment rates are shown raw and reweighted by the logged selection probability.

**What is simulated.** Customer behaviour (`app/simulation.py`) and channel delivery. No channel gateway
is connected, so delivery is off: decisions are made and logged, and no customer is contacted. Messages
quote only amounts the bank supplied, never a card number. All customer data is synthetic.

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

Open <http://localhost:5173>. The database seeds itself on first boot: about 1,360 accounts across the
four card businesses (Consumer Credit Card, Retail Card, Co-Brand Card, Small Business Card). API docs
are at <http://localhost:8000/docs>. A platform admin can reset the data with
`POST /console/admin/reseed`.

**Tests.** One command runs every end-to-end suite, each on its own throwaway database, plus a pyflakes
static check:

```bash
cd backend && .venv/Scripts/python.exe -m pip install -r requirements-dev.txt && .venv/Scripts/python.exe -m pytest -q
```

| Suite | Covers |
| --- | --- |
| `verify_callbacks.py` | What an agent is told when a person changes its decision: outbox, signed POST, retry, no card numbers |
| `verify_context.py` | RecoveryContext v1, frozen snapshots, per-rule eligibility records, freshness, older databases |
| `verify_governance.py` | Executive dashboard, agency placements (proposer cannot approve), protected attributes, encryption at rest |
| `verify_journey.py` | One customer's journey: decision, contact, outcome, reward, score change |
| `verify_mcp.py` | The MCP server over the real protocol |
| `verify_mcp_questions.py` | The question tools: plain-English answers match a direct query, the knowledge graph, no names returned |
| `verify_payments.py` | Payment outcomes: partial payments, duplicates, reversals, out-of-window, cure flag |
| `verify_query.py` | Plain-English questions: allowed fields only, exact matches, result becomes a target |
| `verify_router.py` | Propensity Router routing, the validation share, scorecards |
| `verify_search.py` | Header search: each role finds only what it may open |
| `verify_schema.py` | Table names, enforced foreign keys, real time types, and the upgrade of an older database |
| `verify_suggestions.py` | Suggested strategies: evidence, drafting, approval |
| `verify_thompson.py` | Treatment playbook, strategy lifecycle and versions, Thompson sampling |

GitHub Actions (`.github/workflows/ci.yml`) runs the backend tests and the frontend type-check and build
on every push to `main` and on pull requests.

---

### The example customers

Three named customers sit in the 30-days-late group with the same risk band, but need completely
different handling:

| | Intervention fit | What CARE does |
| --- | --- | --- |
| **Rachel Whitfield** | Can be helped | Enters a strategy: split plan, deferral or in-app nudge |
| **Garrett Holloway** | Will pay anyway | Stays on business as usual, kept out of costly treatments |
| **Dustin Kincaid** | Needs hardship support | Routed to the hardship team, outside the strategies |

---

## Open item: delayed outcomes

A payment can arrive days after the contact. How long to wait before calling a result, and how to treat
customers whose outcome is still pending, is not decided yet. The prototype records each wave's outcome
when the wave runs, so the flow can be shown. The screens flag this where it matters.

---

## How it works

**What CARE does not compute.** Delinquency risk. The bank's risk band and score arrive with the account
and are shown as the bank's data.

**Intervention fit** (`app/scoring.py`). Two scores per customer:
- *Influenceability*: SMS response, app use, tenure, temporary hardship, payment history. Severe arrears
  discount it, because a message can't replace lost income.
- *Self-cure*: how likely they are to pay without help.

**Rules before learning** (`app/console/rules.py`). Every candidate treatment is checked against every
rule (playbook status, its own eligibility rules, hard stops, consent, opt-out, contact caps,
freshness), and every result is stored. Only treatments that pass every rule can be chosen.

**Decisions** (`app/console/engine.py`). A random share of each strategy's accounts is held out as its
control group. For the rest, Thompson sampling draws once per allowed treatment, tilts the draw by
customer fit, and the highest draw wins.

---

## Code layout

```
backend/app/
  core/            settings and database access
  console/
    routes/        the console API, one module per area
    contract.py    RecoveryContext v0 / v1: one account's data
    rules.py       guardrails and eligibility, every rule for every candidate treatment
    engine.py      control split, Thompson sampling, execution, learning
    router.py      Propensity Router
    liverun.py     Live run
    recovery.py    charged-off accounts
    agencies.py    collection agencies and placements
    nlq.py         plain-English questions
    nova.py        the agent service: decisions and outcome reports
    mcp_server.py  the MCP transport and access
    suggest.py     suggested strategies from the decision log
    analytics.py   uplift, results and learning read models
  scoring.py       intervention fit and eligibility rules
  simulation.py    customer responses for test environments
docs/              Nova data model, account schema, sample CSVs
frontend/src/console/
  shell/           header, sidebar, menus, search
  routes.tsx       every page and the permission it needs
  pages/           one folder per workspace
  ui/              shared components and charts
```

---

## Agent access (MCP)

CARE is also an **MCP server**. Another agent can send one account and get the recovery action back,
or ask questions about the data, without the console.

| | |
| --- | --- |
| Endpoint | `http://localhost:8000/mcp` locally, `https://<host>/api/mcp` on Render |
| Transport | Streamable HTTP, stateless, JSON responses |
| Auth | `Authorization: Bearer <token>`. An admin reveals, copies or rotates it under **API and integrations**; `ARI_MCP_TOKEN` overrides it |
| Input | One account as described in [docs/nova-recovery-context-schema.md](docs/nova-recovery-context-schema.md). Only `account_id`, `days_past_due` and `current_balance` are required; anything missing is defaulted and listed back under `assumed` |

| Tool | What it does |
| --- | --- |
| `get_recovery_strategy` | Decide and record the action for one account |
| `preview_recovery_strategy` | The same answer without recording anything |
| `get_recovery_strategies` | Up to 100 accounts in one call |
| `report_payment_outcome` | The payment result, which the model learns from |
| `get_decision`, `get_decision_updates` | A decision's current state, and the decisions a person changed |
| `list_live_strategies`, `list_treatments` | What CARE is running, and the treatments it chooses from |

**Questions about the data** (all read-only, and none returns a customer's name):

| Tool | What it does |
| --- | --- |
| `ask_portfolio` | A plain-English question about the accounts. Returns how many match, what they owe, a breakdown by days late and card business, the largest balances by account number, and the SQL it ran. Only known fields can be queried, and words it cannot read are reported back, not guessed |
| `get_taxonomy` | The class tree of the recovery knowledge graph (e.g. Retail Card < Card < Product) and every relationship type |
| `search_graph` | Find customers, strategies, treatments, decisions, agencies or segments by text and class |
| `get_node` | One node, where it sits in the taxonomy, and everything it is linked to |
| `traverse_graph` | Follow relationships hop by hop, e.g. from a treatment to the decisions that chose it to their outcomes |
| `count_by` | Count a class grouped by a relationship or property, e.g. decisions by treatment |
| `how_connected` | The shortest chain of relationships between two things |

The knowledge graph (`console/graph.py`) is rebuilt from the tables whenever they change, so it always
matches what the console shows. **API and integrations → Try it: ask about the data** runs these tools from
the console.

The same rules apply as in the console. `tests/verify_mcp.py` checks the whole path over the real
protocol, and `tools/nova_agent_demo.py` plays a caller against the running app.

---

## Deploy to Render (free tier)

One Docker web service: the build compiles the React app, and FastAPI serves it at `/` with the API
under `/api`. In Render, go to **New → Blueprint**, pick this repository, and apply. `render.yaml` sets
the Docker runtime, free plan, a `/healthz` health check and auto-deploy on push to `main`.

On the free tier:
- **It sleeps after 15 minutes idle.** The first request after that takes about a minute.
- **Restarts wipe local state.** The SQLite database re-seeds on every restart or deploy unless
  `DATABASE_URL` points at Postgres.
- **The console API trusts the persona switcher.** Fine for synthetic data, but don't put real data
  behind it. The MCP endpoint always requires its token.

---

## Stack

**Backend:** Python 3.12, FastAPI, SQLAlchemy 2.0, NumPy, the MCP Python SDK. SQLite locally; set
`DATABASE_URL` for Postgres. Every link between tables is a declared foreign key, enforced on SQLite too; times are
real `TIMESTAMP WITH TIME ZONE` and `DATE` columns on Postgres. Startup upgrades an older database in place
(`app/core/migrate.py`).
**Frontend:** React 19 + TypeScript, Vite, Tailwind CSS, Recharts, React Router.
