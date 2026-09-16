const BASE = import.meta.env.VITE_API_URL ?? "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return res.json() as Promise<T>;
}

const post = <T,>(path: string, body?: unknown) =>
  req<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });

// ----------------------------------------------------------------- types
export interface Customer {
  customer_id: number;
  name: string;
  balance: number;
  credit_limit: number;
  utilization: number;
  tenure_years: number;
  sms_responsive: boolean;
  app_user: boolean;
  hardship_flag: boolean;
  missed_payments: number;
  payment_history: number;
  days_past_due: number;
  risk_score: number;
  nudge_score: number;
  self_cure_score: number;
  segment: Segment;
  treatment: string;
  outcome: string;
  is_persona: boolean;
  persona_note: string;
}

export type Segment = "Persuadable" | "Sure Thing" | "Lost Cause" | "Sleeping Dog";

export interface Dashboard {
  total_customers: number;
  high_risk: number;
  persuadables: number;
  expected_recovery: number;
  projected_savings: number;
  annual_savings: number;
  contacts_avoided: number;
  contact_reduction_pct: number;
  segments: { segment: Segment; count: number; balance: number }[];
  funnel: { stage: string; value: number }[];
  risk_distribution: { band: string; count: number }[];
  outcomes: { outcome: string; count: number }[];
}

export interface RiskResult {
  customer_id: number;
  name: string;
  risk_score: number;
  band: string;
  drivers: { feature: string; contribution: number; direction: string }[];
}

export interface NudgeResult {
  customer_id: number;
  name: string;
  nudge_score: number;
  self_cure_score: number;
  segment: Segment;
  recommended_action: string;
  contributions: { factor: string; points: number; max_points: number }[];
  severity_penalty: number;
}

export interface JourneyArm {
  journey_id: number;
  journey_code: string;
  journey_name: string;
  description: string;
  successes: number;
  failures: number;
  posterior_mean: number;
  base_sample: number;
  context_multiplier: number;
  score: number;
}

export interface Recommendation {
  customer_id: number;
  name: string;
  segment: Segment;
  eligible_for_bandit: boolean;
  gate_reason: string | null;
  journey: string;
  journey_id: number;
  score: number;
  ranking: JourneyArm[];
  context_multipliers: Record<string, number>;
}

export interface JourneyStat {
  journey_id: number;
  journey_code: string;
  journey_name: string;
  description: string;
  cost_per_contact: number;
  successes: number;
  failures: number;
  trials: number;
  posterior_mean: number;
  ci_low: number;
  ci_high: number;
}

export interface SimResult {
  rounds: number;
  successes: number;
  conversion_rate: number;
  allocation: Record<string, number>;
}

export interface JourneyStep {
  day: string;
  title: string;
  detail: string;
  kind: "trigger" | "action" | "positive" | "neutral" | "success";
}

// ----------------------------------------------------------------- calls
export const api = {
  dashboard: () => req<Dashboard>("/dashboard"),
  personas: () => req<Customer[]>("/personas"),
  customer: (id: number) => req<Customer>(`/customers/${id}`),
  customers: (p: { segment?: string; search?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (p.segment && p.segment !== "All") q.set("segment", p.segment);
    if (p.search) q.set("search", p.search);
    q.set("limit", String(p.limit ?? 300));
    return req<Customer[]>(`/customers?${q}`);
  },
  risk: (customer_id: number) => post<RiskResult>("/risk-score", { customer_id }),
  nudge: (customer_id: number) => post<NudgeResult>("/nudge-score", { customer_id }),
  recommend: (customer_id: number) => post<Recommendation>("/recommend-journey", { customer_id }),
  journeys: () => req<JourneyStat[]>("/journeys"),
  posterior: () => req<{ series: string[]; data: Record<string, number>[] }>("/bandit/posterior"),
  simulate: (rounds: number) => post<SimResult>(`/bandit/simulate?rounds=${rounds}`),
  resetBandit: (flat: boolean) => post<{ status: string }>(`/bandit/reset?flat=${flat}`),
  recordOutcome: (customer_id: number, journey_id: number, success: boolean) =>
    post<{ successes: number; failures: number; posterior_mean: number }>("/record-outcome", {
      customer_id,
      journey_id,
      success,
    }),
  journeySimulation: (id: number) =>
    req<{ customer_id: number; name: string; segment: Segment; steps: JourneyStep[] }>(
      `/journey-simulation/${id}`,
    ),
};

// ----------------------------------------------------------------- formatting
export const money = (n: number) =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1000
      ? `$${(n / 1000).toFixed(1)}K`
      : `$${n.toFixed(0)}`;

export const exactMoney = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const SEGMENT_COLOR: Record<Segment, string> = {
  Persuadable: "#6366f1",
  "Sure Thing": "#10b981",
  "Lost Cause": "#f59e0b",
  "Sleeping Dog": "#64748b",
};

export const SEGMENT_BLURB: Record<Segment, string> = {
  Persuadable: "Behaviour can be changed - treatment decides the outcome.",
  "Sure Thing": "Would pay anyway - a reminder is all the spend that is justified.",
  "Lost Cause": "Cannot pay - route to hardship, no nudge substitutes for income.",
  "Sleeping Dog": "Contact risks a negative reaction - suppress from outreach.",
};

export const JOURNEY_COLOR: Record<string, string> = {
  J1: "#38bdf8",
  J2: "#6366f1",
  J3: "#f59e0b",
  J4: "#f43f5e",
  J5: "#10b981",
};
