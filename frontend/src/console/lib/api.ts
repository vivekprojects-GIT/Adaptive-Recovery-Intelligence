const BASE = "/api/console";
const USER_KEY = "ari.console.user";

export function getUserId(): string | null {
  try {
    return localStorage.getItem(USER_KEY);
  } catch {
    return null;
  }
}

export function setUserId(id: string): void {
  try {
    localStorage.setItem(USER_KEY, id);
  } catch {
    /* storage blocked: the session lasts for this page load only */
  }
}

/** Any non-2xx. `message` is the API's own `detail`, which for permission and
 *  governance refusals is the rule that blocked the action - shown verbatim. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

let memoryUser: string | null = null;

export function setSessionUser(id: string) {
  memoryUser = id;
  setUserId(id);
}

export function clearSessionUser() {
  memoryUser = null;
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    /* storage blocked */
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const uid = memoryUser ?? getUserId();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(uid ? { "X-User-Id": uid } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      if (typeof j.detail === "string") detail = j.detail;
      else if (Array.isArray(j.detail)) detail = j.detail.map((d: { msg: string }) => d.msg).join("; ");
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T,>(p: string) => request<T>(p),
  post: <T,>(p: string, body?: unknown) =>
    request<T>(p, { method: "POST", body: JSON.stringify(body ?? {}) }),
  put: <T,>(p: string, body?: unknown) =>
    request<T>(p, { method: "PUT", body: JSON.stringify(body ?? {}) }),
  patch: <T,>(p: string, body?: unknown) =>
    request<T>(p, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  del: <T,>(p: string) => request<T>(p, { method: "DELETE" }),
  /** File download through the same auth header. */
  download: async (p: string, filename: string) => {
    const uid = memoryUser ?? getUserId();
    const res = await fetch(`${BASE}${p}`, { headers: uid ? { "X-User-Id": uid } : {} });
    if (!res.ok) throw new ApiError(res.status, (await res.text()).slice(0, 200));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};

/* --------------------------------------------------------------------- types */
export type Role = "strategist" | "leader" | "admin" | "viewer";

export interface PublicUser { user_id: string; name: string; role: Role; role_label: string; status: string }

export interface Me {
  user: { user_id: string; name: string; email: string; role: Role; role_label: string };
  permissions: string[];
  badges: { live_campaigns: number; open_violations: number; pending_review: number;
    awaiting_approval: number; new_insights: number };
  agent: { decisions_total: number; shadow_mode: boolean; model_version: string };
}

export interface Stats {
  decisions: number; treated: number; treated_paid: number; control: number; control_paid: number;
  recovery_rate: number | null; control_rate: number | null; uplift: number | null;
  uplift_ci: [number, number] | null; significant: boolean; mde: number | null; underpowered: boolean;
  recovered: number; contact_cost: number; contacts: number; cost_per_recovery: number | null;
  escalation_rate: number | null; avg_resolution_days: number | null; pending_review: number;
}

export interface Strategy {
  campaign_id: string; name: string; description: string; status: string; version: number;
  source: string; steps_completed: number; target_cohorts: string[]; include_segments: string[];
  risk_bands: string[]; min_balance: number | null; max_balance: number | null;
  min_dpd: number | null; max_dpd: number | null; treatment_codes: string[];
  cadence_days: number; max_touches: number; tone: string; send_window_start: number;
  send_window_end: number; escalate_after_days: number; escalate_to: string | null;
  control_pct: number; wave_size: number; evaluation_days: number; recovery_target: number;
  created_at: string; updated_at: string; submitted_at: string | null; approved_at: string | null;
  launched_at: string | null; waves_run: number; owner_id: string; owner: string;
  created_by: string; approved_by: string | null; approver: string | null; channels: string[];
  treatments: { code: string; name: string; channel: string; status: string }[];
  /** The version this one replaces, when it is a revision of a running strategy. */
  parent_id: string | null;
  has_history: boolean;
  /** What the console may offer. The API enforces the same rules. */
  editable: boolean; revisable: boolean; deletable: boolean;
  /** Draft of the next version, if one is open (live and paused strategies). */
  open_revision: string | null;
  /** Customers this strategy could still decide (live and paused, list views). */
  pool_remaining?: number | null;
  stats?: Stats; reapproval_required?: boolean; rationale?: string[]; population?: Population; created?: boolean;
}

export interface Population {
  matching: number; segments: Record<string, number>;
  exclusions: { reason: string; count: number }[];
  eligible: number; control: number; treatment: number; arm_eligibility: Record<string, number>;
}

export interface Belief {
  code: string; name: string; cost: number; a: number; b: number; prior_mean: number;
  /** "playbook": started from the treatment's track record. "uniform": no history, flat prior. */
  prior: "playbook" | "uniform";
  learned: number; mean: number; low: number; high: number;
}

export interface LearningPoint {
  wave: number; label: string; treated: number; learned: number;
  counts: Record<string, number>; allocation: Record<string, number>;
  posterior: Record<string, { mean: number; low: number; high: number; p_best: number }>;
}

export interface Learning { arms: { code: string; name: string; prior: string }[]; waves: LearningPoint[] }

export interface WaveSummary {
  wave: number | null; decided: number; treatment: number; control: number; held_for_review: number;
  blocked_by_guard: number; delivered: number; failed: number; learned: number;
  by_treatment: Record<string, number>; pool_before: number; pool_after: number;
}

export interface HandoffRow {
  handoff_id?: number; handoff?: number; at?: string; by?: string; total: number;
  counts: Record<string, number>; trigger: string;
}

export interface WaveRun {
  wave: number | null; first_wave: number | null; waves_run: number; by_treatment: Record<string, number>;
  decided: number; treatment: number; control: number;
  held_for_review: number; blocked_by_guard: number; delivered: number; failed: number; learned: number;
  waves: WaveSummary[]; handoffs: HandoffRow[]; message: string | null; pool_remaining: number;
}

export interface ArmResult {
  code: string; name: string; n: number; paid: number; rate: number | null;
  ipw_rate: number | null; ci: [number, number]; uplift: number | null;
}

export interface WeekPoint {
  week: string; recovery_rate: number | null; control_rate: number | null; uplift: number | null;
  recovered: number; treated: number; control: number; escalation_rate: number | null;
  cost_per_recovery: number | null; contacts: number;
}

/** Where Thompson sampling stands in one treatment of a strategy. */
export interface ArmState {
  code: string; name: string; prior: string; mean: number; low: number; high: number; p_best: number;
  learned: number; recent_share: number | null; eligible_share: number | null;
}

/** Where Thompson sampling stands in one strategy, with a plain-words verdict. */
export interface LearningState {
  state: "Settled" | "Leaning" | "Exploring" | "Not started" | "Single treatment" | "No treatments";
  verdict: string; lead: ArmState | null; runner: ArmState | null; arms: ArmState[];
  learned: number; waves: number; recent_waves: number;
}

/** A strategy's result against its own control group, as a verdict. */
export interface ResultsState { state: "Proven" | "Worse than control" | "Not proven yet" | "No results"; verdict: string }

export interface AnalyticsRow extends Strategy {
  stats: Stats; learning: Learning; learning_state: LearningState; results_state: ResultsState;
}

export interface StrategyDetail extends Strategy {
  stats: Stats; population: Population; beliefs: Belief[]; weekly: WeekPoint[];
  arms: ArmResult[]; waves: ({ wave: number } & Stats)[]; learning: Learning;
  learning_state: LearningState; results_state: ResultsState;
  pool_remaining: number | null;
  versions: { campaign_id: string; version: number; status: string; owner: string; created_at: string;
    launched_at: string | null; current: boolean }[];
}

export type Rules = Partial<{
  requires_app_user: boolean; requires_sms_responsive: boolean; requires_hardship_flag: boolean;
  min_balance: number; max_missed_payments: number; min_tenure_years: number; min_payment_history: number;
  min_dpd: number; max_dpd: number;
}>;

export interface Treatment {
  code: string; name: string; channel: string; offer: string; timing: string;
  eligibility_rule: string; rules: Rules; cost: number;
  /** Null when the treatment has no track record yet. */
  historical_rate: number | null; historical_n: number;
  kind: string; status: "Active" | "Retired"; human_review: boolean; version: number; builtin: boolean;
  updated_by: string | null; updated_at: string | null; material_change?: boolean;
  usage: { strategies: { campaign_id: string; name: string; status: string }[]; live_strategies: number;
    decisions: number; nudges: number; deletable: boolean };
}

export interface TreatmentSchema {
  kinds: { kind: string; help: string }[]; channels: string[];
  rules: { key: keyof Rules; label: string; type: "bool" | "money" | "int" | "number" | "percent" }[];
}

export interface RulePreview {
  rule: string; customers: number; eligible: number; persuadable: number;
  by_cohort: { cohort_id: string; customers: number; eligible: number; persuadable: number }[];
  excluded_by: { reason: string; count: number }[];
}

export interface Cohort {
  cohort_id: string; name: string; dpd_bucket: string; risk_band: string;
  expected_payment: string; description: string; customers: number; balance: number;
  segments: Record<string, number>; segment_action: Record<string, string>;
}

export interface InsightRow {
  insight_id: string; campaign_id: string | null; from: string; to: string; title: string;
  body: string; evidence: string; priority: string; status: string;
  change: Record<string, unknown>; created_at: string; response_note: string | null;
}

export interface CustomerRow {
  customer_id: number; name: string; cohort_id: string; balance: number; arrears: number;
  days_past_due: number; risk_score: number; risk_band: string; segment: string;
  status: string; progress: number; strategy: string | null; campaign_id: string | null;
  treatment: string | null; last_contact: string | null;
}

export interface DecisionRow {
  decision_id: string; campaign_id: string; strategy: string | null; customer_id: number;
  customer: string | null; wave: number; group: string; treatment_code: string | null;
  treatment: string | null; selection_probability: number | null; review_policy: string;
  review_status: string; overridden: boolean; decided_at: string; latency_ms: number;
  outcome: string | null; amount: number | null;
  /** wave: decided in a console wave. mcp: asked for by an agent (Nova) over MCP. */
  origin: "wave" | "mcp";
}

/* ------------------------------------------------------------ agent access (MCP) */
export interface McpStatus {
  path: string; transport: string; protocol_versions: string[]; auth: string;
  token_source: "generated" | "environment"; token_hint: string;
  tools: { name: string; title: string; description: string; read_only: boolean }[];
  stats: { calls_24h: number; calls_total: number; last_call_at: string | null; accounts: number;
    decisions: number; awaiting_approval: number; outcomes_reported: number };
  recent: { at: string; tool: string; action: string; summary: string }[];
}

/** What an agent gets back from get_recovery_strategy / preview_recovery_strategy. */
export interface AgentDecision {
  decision_id: string | null; action: string; summary: string; existing: boolean;
  customer: { account_id: string; ari_customer_id?: number | null; cohort?: string; days_past_due?: number;
    risk_band?: string; intervention_fit?: string; nudge_score?: number; self_cure_score?: number };
  strategy: { strategy_id: string; name: string; version: number; evaluation_days: number } | null;
  group?: string;
  treatment: { code: string; name: string; kind: string | null; channel: string | null; offer: string | null;
    timing: string | null; cost_per_contact: number | null } | null;
  selection_probability?: number | null;
  alternatives?: { code: string; name: string; selection_probability: number | null; belief: number;
    customer_fit: number; fit_reasons: string[] }[];
  blocked_treatments?: { code: string; name: string; reason_code: string; reason: string }[];
  cancelled_decisions?: string[];
  explanation?: string; message?: string | null;
  contact?: { nudge_id: string; channel: string; send_at: string; status: string; guard: string | null;
    simulated: boolean } | null;
  review?: { required: boolean; status: string };
  outcome?: { paid: boolean; amount: number; days_to_pay: number | null; learned: boolean } | null;
  decided_at?: string | null; next_step: string | null; note?: string; assumed?: string[];
  strategies_checked?: { strategy_id: string; name: string; matches: boolean; reason: string }[];
}

export interface OutcomeReport {
  decision_id: string; recorded: boolean; corrected: boolean; paid: boolean; counted_as_success: boolean;
  learned: boolean; note: string;
  learning: { treatment: { code: string; name: string }; belief_before: number; belief_after: number;
    outcomes_learned: number } | null;
}

export interface Alert {
  rule_id: number; name: string; severity: string; campaign_id: string | null;
  value: number; threshold: number; metric: string; message: string;
}
