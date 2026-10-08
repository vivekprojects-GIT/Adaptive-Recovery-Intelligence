export const money = (v: number | null | undefined, compact = false) => {
  if (v === null || v === undefined) return "—";
  const cents = !compact && Math.abs(v) < 100 && v % 1 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD",
    notation: compact ? "compact" : "standard",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: compact ? 2 : cents ? 2 : 0,
  }).format(v);
};

export const pct = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(d)}%`;

export const pp = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(d)} pp`;

export const num = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : new Intl.NumberFormat("en-US").format(v);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const dateOnly = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (bare) return `${bare[3]} ${MONTHS[Number(bare[2]) - 1]} ${bare[1]}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: TZ });
};

/* Times are shown on the customer's clock (stored as UTC by the engine), so a
   message sent at 10:00 local reads 10:00 whatever the viewer's timezone is.
   Contact-hour rules are about the customer's time, not the reviewer's. */
const TZ = "UTC";

export const dateTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ });
};

export const timeOnly = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
};

export const ago = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 0) return "scheduled";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} days ago`;
  return dateOnly(iso);
};

export const weekLabel = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : iso;
};

export const initials = (name: string) =>
  name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

/** Where the Propensity Router sends each customer. */
export const ROUTE_LABEL: Record<string, string> = {
  strategy: "Strategy", bau: "Business as usual", hardship: "Hardship team", suppress: "Suppressed",
};
export const SEGMENTS = ["Persuadable", "Sure Thing", "Lost Cause", "Sleeping Dog"];
/** The colour that identifies each fit group in charts and their legends. */
export const SEGMENT_COLOR: Record<string, string> = {
  Persuadable: "var(--series-1)", "Sure Thing": "var(--series-3)", "Lost Cause": "var(--series-4)", "Sleeping Dog": "var(--control)",
};
export const SEGMENT_LABEL: Record<string, string> = {
  "Persuadable": "Likely responsive",
  "Sure Thing": "Likely self-cure",
  "Lost Cause": "Needs support",
  "Sleeping Dog": "Do not contact",
};

/** The customer ID as people see and search it (the API accepts CUS-11342 or 11342). */
export const customerRef = (id: number) => `CUS-${10000 + id}`;
