const BASE = import.meta.env.VITE_API_URL ?? "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).detail ?? "";
    } catch {
      /* not JSON */
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

const post = <T,>(path: string, body?: unknown) =>
  req<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });

// ----------------------------------------------------------------- types
export type Segment = "Persuadable" | "Sure Thing" | "Lost Cause" | "Sleeping Dog";

export interface Customer {
  customer_id: number;
  cohort_id: string;
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
  client_risk_band: string;
  client_risk_score: number;
  nudge_score: number;
  self_cure_score: number;
  segment: Segment;
  is_persona: boolean;
  persona_note: string;
}

export interface CohortSummary {
  cohort_id: string;
  name: string;
  dpd_bucket: string;
  client_risk_band: string;
  expected_payment: string;
  description: string;
  customers: number;
  balance: number;
}

export interface CohortDetail extends CohortSummary {
  profile: {
    avg_balance: number;
    sms_responsive_pct: number;
    app_user_pct: number;
    hardship_pct: number;
    avg_tenure: number;
    avg_nudge: number;
  };
  segments: { segment: Segment; count: number; balance: number; action: string }[];
  personas: Customer[];
}

export interface Fit {
  customer_id: number;
  name: string;
  nudge_score: number;
  self_cure_score: number;
  segment: Segment;
  recommended_action: string;
  contributions: { factor: string; points: number; max_points: number }[];
  severity_penalty: number;
}

export interface StrategyBase {
  code: string;
  name: string;
  channel: string;
  offer: string;
  timing: string;
  eligibility_rule: string;
  cost_per_contact: number;
  hist_success_rate: number;
  hist_trials: number;
  best_for: string;
  status: string;
  note: string;
}

export interface CohortSheetRow extends StrategyBase {
  eligible_in_cohort: number;
  eligible_in_target: number;
  reach_in_target: number;
  avg_fit: number;
  expected_score: number;
  value_score: number;
  est_cost: number;
}

export interface CohortSheet {
  scope: "cohort";
  cohort_id: string;
  cohort_name: string;
  dpd_bucket: string;
  client_risk_band: string;
  expected_payment: string;
  customers: number;
  target_group: string;
  target_customers: number;
  rows: CohortSheetRow[];
}

export interface CustomerSheetRow extends StrategyBase {
  eligible: boolean;
  eligibility_reason: string;
  fit: number;
  fit_reasons: string[];
  expected_score: number;
}

export interface CustomerSheet {
  scope: "customer";
  customer_id: number;
  name: string;
  cohort_id: string;
  segment: Segment;
  recommended_action: string;
  rows: CustomerSheetRow[];
}

export interface Arm {
  code: string;
  name: string;
  cost: number;
  eligible: number;
  assigned: number;
  paid: number;
  pay_rate: number | null;
  uplift_vs_control: number | null;
  cost_per_payment: number | null;
  prior_mean: number;
  belief: number;
  belief_low: number;
  belief_high: number;
  share: number;
}

export interface Wave {
  wave: number;
  treatment_n: number;
  control_n: number;
  allocation: Record<string, number>;
  treatment_paid: number;
  control_paid: number;
  treatment_rate: number;
  control_rate: number | null;
  cum_treatment_rate: number;
  cum_control_rate: number | null;
  beliefs: Record<string, number>;
}

export interface Assignment {
  wave: number;
  customer_id: number;
  name: string;
  segment: Segment;
  group: "Treatment" | "Control";
  strategy: string | null;
  strategy_name: string;
  score: number | null;
  why: string;
  outcome: string;
}

export interface Experiment {
  id: string;
  created_at: string;
  cohort: {
    cohort_id: string;
    name: string;
    dpd_bucket: string;
    client_risk_band: string;
    expected_payment: string;
  };
  strategies: { code: string; name: string }[];
  settings: { control_pct: number; mode: "adaptive" | "fixed"; include_segments: string[]; wave_size: number };
  population: {
    total: number;
    segments: Record<string, number>;
    exclusions: { reason: string; count: number }[];
    eligible: number;
    control: number;
    treatment: number;
  };
  progress: { waves_run: number; total_waves: number; treated: number; control_observed: number; done: boolean };
  results: {
    treatment_rate: number | null;
    control_rate: number | null;
    uplift: number | null;
    treated_paid: number;
    control_paid: number;
  };
  arms: Arm[];
  waves: Wave[];
  recent_assignments: Assignment[];
}

export interface ExperimentIn {
  cohort_id: string;
  strategies: string[];
  control_pct: number;
  mode: "adaptive" | "fixed";
  include_segments: string[];
  wave_size: number;
}

export interface RankedArm {
  code: string;
  name: string;
  belief: number;
  base_sample: number;
  fit: number;
  score: number;
  fit_reasons: string[];
}

export interface AssignmentPreview {
  customer_id: number;
  name: string;
  segment: Segment;
  cohort_id: string;
  in_test_population: boolean;
  gate_reason: string | null;
  eligibility: { code: string; name: string; eligible: boolean; reason: string }[];
  ranking: RankedArm[];
  selected: RankedArm | null;
}

export interface ExperimentCustomerStatus {
  customer_id: number;
  state: "excluded" | "control" | "queued" | "treated";
  reason?: string;
  strategy?: string;
  strategy_name?: string;
  wave?: number;
  outcome?: string;
}

// ----------------------------------------------------------------- calls
export const api = {
  cohorts: () => req<CohortSummary[]>("/cohorts"),
  cohort: (id: string) => req<CohortDetail>(`/cohorts/${id}`),
  customer: (id: number) => req<Customer>(`/customers/${id}`),
  customers: (p: { cohort_id?: string; segment?: string; search?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (p.cohort_id) q.set("cohort_id", p.cohort_id);
    if (p.segment && p.segment !== "All") q.set("segment", p.segment);
    if (p.search) q.set("search", p.search);
    q.set("limit", String(p.limit ?? 300));
    return req<Customer[]>(`/customers?${q}`);
  },
  fit: (id: number) => req<Fit>(`/customers/${id}/fit`),
  cohortSheet: (id: string) => req<CohortSheet>(`/strategy-sheet/cohort/${id}`),
  customerSheet: (id: number) => req<CustomerSheet>(`/strategy-sheet/customer/${id}`),
  createExperiment: (body: ExperimentIn) => post<Experiment>("/experiments", body),
  experiment: (id: string) => req<Experiment>(`/experiments/${id}`),
  runWaves: (id: string, count: number) => post<Experiment>(`/experiments/${id}/waves?count=${count}`),
  experimentCustomer: (expId: string, cid: number) =>
    req<ExperimentCustomerStatus>(`/experiments/${expId}/customers/${cid}`),
  assignmentPreview: (cid: number, strategies: string[]) =>
    req<AssignmentPreview>(`/customers/${cid}/assignment-preview?strategies=${strategies.join(",")}`),
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

export const pct = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? "—" : `${(n * 100).toFixed(digits)}%`;

export const SEGMENT_COLOR: Record<Segment, string> = {
  Persuadable: "#6366f1",
  "Sure Thing": "#10b981",
  "Lost Cause": "#f59e0b",
  "Sleeping Dog": "#64748b",
};

/** Plain-English label shown next to each intervention-fit group. */
export const SEGMENT_PLAIN: Record<Segment, string> = {
  Persuadable: "Can be helped",
  "Sure Thing": "Will pay anyway",
  "Lost Cause": "Needs hardship support",
  "Sleeping Dog": "Leave alone",
};

export const SEGMENT_BLURB: Record<Segment, string> = {
  Persuadable: "The choice of intervention changes the outcome. These customers go into the experiment.",
  "Sure Thing": "Expected to pay without help. A cheap reminder is all the spend that is justified.",
  "Lost Cause": "Cannot pay right now. Route to the hardship team - no nudge replaces lost income.",
  "Sleeping Dog": "Contact is likely to backfire. Suppress outreach.",
};

export const STRATEGY_COLOR: Record<string, string> = {
  S1: "#38bdf8",
  S2: "#a78bfa",
  S3: "#6366f1",
  S4: "#10b981",
  S5: "#f43f5e",
  S6: "#f59e0b",
};

export const STATUS_TONE: Record<string, "brand" | "emerald" | "slate" | "amber" | "rose"> = {
  Recommended: "brand",
  Applicable: "slate",
  "Limited reach": "amber",
  "Not eligible": "rose",
  "Not advised": "amber",
  Suppress: "rose",
};
