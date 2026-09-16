# Adaptive Recovery Intelligence (ARI)

A client-facing proof of concept for AI-driven collections. ARI answers three questions that a
conventional collections engine collapses into one:

| Question | Model |
| --- | --- |
| Who is likely to become delinquent? | **Risk Model** — logistic scorecard |
| Whose behaviour can we actually change? | **Nudge Propensity Model** — uplift segmentation |
| What treatment should we use? | **Contextual Thompson Sampling** — Bayesian bandit over 5 journeys |

The point of the product is the second question. Banks are already good at ranking risk; they spend
money on customers who would have paid anyway, and on customers no reminder can help.

---

## Quick start

Two terminals.

**Backend** (FastAPI, port 8000):

```bash
cd backend && python -m venv .venv && .venv/Scripts/python.exe -m pip install -r requirements.txt && .venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000
```

**Frontend** (Vite, port 5173):

```bash
cd frontend && npm install && npm run dev
```

Open <http://localhost:5173>. The database seeds itself on first boot (3 personas + 1,000 synthetic
customers). Interactive API docs are at <http://localhost:8000/docs>.

---

## Deploy to Render (free tier)

The repo ships as a single Docker web service. The build compiles the React app, and FastAPI serves
it at `/` with the API under `/api`. One URL, one cold start, no CORS.

**Option A: Blueprint (recommended).** In Render, go to **New → Blueprint**, pick this repository,
and apply. `render.yaml` configures everything: Docker runtime, free plan, health check at
`/healthz`, and auto-deploy on push.

**Option B: Manual.** Go to **New → Web Service**, pick this repository, and set:

| Setting | Value |
| --- | --- |
| Language | Docker |
| Instance type | Free |
| Health check path | `/healthz` |

No environment variables are required. Render sets `PORT`, and the container honours it.

### What the free tier means for a demo

- **It sleeps after 15 minutes idle.** The first request after that takes about a minute. Open
  the link a couple of minutes before a client call.
- **The disk resets on every restart or deploy.** The database re-seeds itself on boot, so the
  demo always starts clean. Any bandit learning from *Run 50 rounds* is lost when the instance
  sleeps. That is usually what you want before a demo.
- **All admin endpoints are public.** `/api/bandit/reset` and `/api/admin/reseed` have no
  authentication. That is fine for a demo link, but don't put real data behind this.

---

## The seven screens

| # | Screen | What it shows |
| --- | --- | --- |
| 01 | Executive Dashboard | Portfolio KPIs, targeting funnel, uplift segmentation, risk distribution |
| 02 | Customer Explorer | All 1,000 accounts, filterable, plotted on the uplift quadrant scatter |
| 03 | Customer 360 | Single account: features, risk/nudge gauges, log-odds risk drivers |
| 04 | Nudge Explanation | Point-by-point attribution of the nudge score, plus the segmentation rule |
| 05 | Bandit Decision | Live Thompson draw, context multipliers, Beta posteriors, learning loop |
| 06 | Journey Simulation | Animated 90-day pathway, segment-specific, feeding back into the bandit |
| 07 | Persona Comparison | Priya / John / Mike side by side — the argument in one table |

---

## The three personas

| | Risk | Nudge | Self-cure | Segment | Treatment | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| **Priya Sharma** | 70 | 91 | 80 | Persuadable | Split Payment Plan | Recovered |
| **John Mitchell** | 67 | 29 | 80 | Sure Thing | Reminder SMS | Self Recovered |
| **Mike Torres** | 100 | 4 | 24 | Lost Cause | Hardship Plan | Assisted Route |

Three comparably risky accounts, three different right answers. That gap is the product.

---

## Models

### Risk model (`app/scoring.py: risk_score`)

Logistic scorecard over utilisation, missed payments, days past due, hardship flag, payment history
and tenure. `risk_drivers()` returns each feature's log-odds contribution so the score is auditable.

### Nudge propensity (`nudge_score`)

The weighted blend from the brief:

```
0.30·sms_response + 0.20·app_usage + 0.20·tenure + 0.15·hardship + 0.15·payment_history
```

Two refinements that the naive formula needs:

- **Hardship only counts when it is temporary.** A hardship flag alongside three missed payments is
  not an opportunity to nudge — it is lost income. The feature fires only when `missed_payments ≤ 1`.
- **Severity discount.** Two missed payments scale the score by 0.70; three or more by 0.35.

### Segmentation — deviation from the brief

The brief specifies a single threshold chain (`≥70 Persuadable, ≥40 Sure Thing, ≥15 Lost Cause,
else Sleeping Dog`), but that chain contradicts the brief's own personas: John at nudge 20 lands in
*Lost Cause*, and Mike at 10 lands in *Sleeping Dog*. Neither is what the narrative intends.

The cause is structural. The four uplift quadrants are two-dimensional — *Sure Thing* and *Sleeping
Dog* are both low-influenceability, and what separates them is **baseline behaviour**, not
persuadability. So ARI scores a second axis, `self_cure_score` (payment history, missed payments,
days past due, hardship), and segments on both:

```
nudge ≥ 70                                   -> Persuadable
nudge < 70 and self_cure ≥ 55                -> Sure Thing
low self_cure + hardship + ≥2 missed         -> Lost Cause
otherwise (disengaged, poor record)          -> Sleeping Dog
```

All three personas now land where the narrative says they should. This is the only substantive
departure from the written spec, and it is visible in the UI on screens 02 and 04.

### Contextual Thompson Sampling (`thompson_sample`)

Five journeys (Reminder SMS, Split Payment Plan, Hardship Plan, Call, Payment Deferral), each with a
Beta posterior seeded from historical outcomes. Every decision draws one sample per arm and
multiplies it by a **context multiplier** derived from the customer — SMS responsiveness lifts J1,
temporary hardship lifts J2, severe hardship lifts J3, and so on. The highest product wins.

That multiplier is what makes the bandit contextual: Priya and a non-app-using customer with the
same posteriors get different recommendations.

**Watch it learn.** On screen 05, press *Cold start* (flat Beta(1,1) priors), then *Run 50 rounds*
repeatedly. The first batch spreads traffic across all five journeys at roughly 25% conversion; by
the third batch it has concentrated on Split Payment Plan at above 50% — with no rule rewritten and
no model retrained.

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/customers` | List/filter accounts (`segment`, `search`, `min_risk`, `limit`) |
| GET | `/customers/{id}` | Single account |
| GET | `/personas` | The three demo personas |
| POST | `/risk-score` | Risk score + log-odds drivers |
| POST | `/nudge-score` | Nudge score, self-cure, segment, attribution |
| POST | `/recommend-journey` | Thompson draw, full ranking, context multipliers |
| POST | `/record-outcome` | Feedback loop — updates the Beta posterior |
| GET | `/journeys` | Bandit stats with 95% intervals |
| GET | `/bandit/posterior` | Beta PDFs for the belief chart |
| POST | `/bandit/simulate?rounds=N` | Run N accounts through the bandit |
| POST | `/bandit/reset?flat=true` | Cold start, or restore historical priors |
| GET | `/dashboard` | Portfolio KPIs, funnel, segments, distributions |
| GET | `/journey-simulation/{id}` | Segment-specific 90-day pathway |
| POST | `/admin/reseed?n=1000` | Regenerate the population |

---

## Stack

**Backend** — Python 3.12, FastAPI, SQLAlchemy 2.0, NumPy, Pydantic v2.
**Frontend** — React 19 + TypeScript, Vite, Tailwind CSS, Recharts, React Router, lucide-react.

**Database is SQLite, not PostgreSQL.** The schema and SQLAlchemy models are exactly as specified;
SQLite just removes the setup step for a PoC. Point `DATABASE_URL` at Postgres and nothing else
changes:

```bash
export DATABASE_URL=postgresql+psycopg://user:pass@localhost/recovery
```

---

## What is real and what is demo data

**Real:** both scoring models, the Beta-Bernoulli bandit, the context multipliers, the posterior
updates, and the learning curve you see when you run simulated rounds.

**Synthetic:** the 1,000 customers (rejection-sampled to hit a 30/50/15/5 segment mix), the seeded
bandit priors, and the latent conversion rates the outcome simulator draws from. No customer data of
any kind is used.

The economics on the dashboard are modelled, not measured: expected recovery is uplift-weighted
balance, and projected savings is avoided contact cost at $6.50 per agent call across 12 cycles a
year. Both assumptions live at the top of `app/main.py` and should be replaced with the client's own
unit economics before this number goes in front of a committee.
