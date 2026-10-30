/** Every recovery metric the console shows: what it means, how it is calculated,
 *  and how to read it. Used by the info tips on KPI tiles and the Metric
 *  definitions page, so a number always has the same definition everywhere. */
export interface MetricDef { label: string; group: string; meaning: string; formula: string; read: string }

export const METRICS: Record<string, MetricDef> = {
  accounts_imported: {
    label: "Accounts imported", group: "Intake",
    meaning: "Delinquent accounts the bank's collections system has handed over to CARE.",
    formula: "Count of accounts received across all handoffs",
    read: "Grows with each handoff. Broken down by product and delinquency bucket.",
  },
  arrears: {
    label: "Arrears", group: "Intake",
    meaning: "The amount past due, not the whole balance.",
    formula: "One minimum payment or instalment per missed cycle. A corporate charge card is due in full",
    read: "This is what a strategy tries to recover. Agencies are placed the whole balance.",
  },
  routing_share: {
    label: "Routing share", group: "Intake",
    meaning: "Where the Propensity Router sent each account.",
    formula: "Accounts on a route ÷ all routed accounts",
    read: "Only accounts a contact is likely to help are put in a strategy. The rest go to business as usual, the hardship team, or are not contacted.",
  },
  payment_rate: {
    label: "Payment rate", group: "Recovery",
    meaning: "How many accounts paid something.",
    formula: "Accounts that paid anything within the evaluation window ÷ accounts in the group",
    read: "Includes customers who would have paid anyway. Compare it with the control group to see what the strategy caused.",
  },
  cure_rate: {
    label: "Cure rate", group: "Recovery",
    meaning: "How many accounts paid all their arrears and are back up to date.",
    formula: "Accounts that paid their full arrears within the window ÷ accounts in the group",
    read: "Always at or below the payment rate. A partial payment counts toward payment rate, not cure rate.",
  },
  liquidation_rate: {
    label: "Liquidation rate", group: "Recovery",
    meaning: "How many of the dollars owed came back.",
    formula: "Dollars recovered ÷ dollars in arrears when the decision was made",
    read: "The money view of performance. A strategy can have a high payment rate and a low liquidation rate if payments are small.",
  },
  recovered: {
    label: "Dollars recovered", group: "Recovery",
    meaning: "Payments received within the evaluation window.",
    formula: "Sum of payments received within the window",
    read: "Agency recoveries are shown separately, before and after the agency's fee.",
  },
  avg_days_to_pay: {
    label: "Average days to pay", group: "Recovery",
    meaning: "How quickly paying customers paid.",
    formula: "Average days from the decision to the payment, for accounts that paid",
    read: "Compared with the bank's expected time to pay for each delinquency bucket.",
  },
  control_group: {
    label: "Control group", group: "Experiment",
    meaning: "Customers picked at random and left on business as usual.",
    formula: "A fixed share of each strategy's audience, usually 20%, chosen before any treatment",
    read: "Shows what would have happened without the strategy. Every lift figure is measured against it.",
  },
  lift: {
    label: "Lift over control", group: "Experiment",
    meaning: "The extra payment rate the strategy caused, in points: +11 points means 11 more customers in every 100 paid than with no contact.",
    formula: "Experiment payment rate − control payment rate, with a 95% range (Agresti-Caffo)",
    read: "If the whole range is above zero, the strategy is proven to help. A range that crosses zero is not proven yet.",
  },
  incremental_recoveries: {
    label: "Incremental recoveries", group: "Experiment",
    meaning: "Paying accounts that would not have paid without the strategy.",
    formula: "Lift × accounts in the experiment",
    read: "The number that justifies the cost of a strategy.",
  },
  recovery_target: {
    label: "Target payment rate", group: "Experiment",
    meaning: "The payment rate a strategy was approved to reach.",
    formula: "Set by the strategy analyst; approved by an executive",
    read: "Deviation is actual minus target. Within 5 points below target is shown as watch.",
  },
  cost_per_recovery: {
    label: "Cost per recovery", group: "Cost",
    meaning: "What it cost in contacts to get one paying account.",
    formula: "Contact cost ÷ paying accounts",
    read: "Lower is better. Payment plans and calls cost more than SMS but can recover more.",
  },
  cost_to_collect: {
    label: "Cost to collect", group: "Cost",
    meaning: "Contact cost for each dollar recovered.",
    formula: "Contact cost ÷ dollars recovered",
    read: "Shown as cents per dollar. The industry benchmark for early-stage collections is a few cents.",
  },
  escalation_rate: {
    label: "Escalation rate", group: "Cost",
    meaning: "How often a strategy had to move to a stronger, costlier treatment.",
    formula: "Treated accounts escalated ÷ treated accounts",
    read: "A rising rate means the first treatment is not working for these customers.",
  },
  mde: {
    label: "Smallest detectable lift", group: "Experiment",
    meaning: "The smallest improvement over control this experiment can reliably prove.",
    formula: "2.8 × √(2 × p × (1 − p) ÷ the smaller group size), with p = 30%; 80% power at 95% confidence",
    read: "If you expect a smaller effect than this, widen the audience or run the strategy for longer.",
  },
  balance_placed: {
    label: "Balance placed", group: "Agencies",
    meaning: "The full outstanding balance of accounts handed to collection agencies.",
    formula: "Sum of the balance of every account at the time it was placed",
    read: "Agencies work the whole balance, not just the amount past due.",
  },
  placement_approval: {
    label: "Placements waiting for approval", group: "Governance",
    meaning: "Accounts CARE has proposed for an agency that a person has not yet approved.",
    formula: "Placements with status proposed",
    read: "Nothing is sent to an agency until approved. Over 24 hours is flagged as an exception.",
  },
  awaiting_review: {
    label: "Waiting for review", group: "Governance",
    meaning: "Decisions held until a person approves them.",
    formula: "Decisions with review status pending",
    read: "Nothing is sent to these customers until someone decides. Over 24 hours is flagged as an exception.",
  },
  agency_liquidation: {
    label: "Agency liquidation rate", group: "Agencies",
    meaning: "How much of the balance placed with an agency came back.",
    formula: "Dollars the agency recovered ÷ dollars placed with it",
    read: "Gross of the agency's fee.",
  },
  net_liquidation: {
    label: "Net liquidation rate", group: "Agencies",
    meaning: "What the bank keeps after paying the agency.",
    formula: "(Dollars recovered − agency fees) ÷ dollars placed",
    read: "The fair way to compare agencies with different fee rates.",
  },
  agency_fee: {
    label: "Agency fee", group: "Agencies",
    meaning: "The agency's contingency fee: a share of what it recovers, nothing if it recovers nothing.",
    formula: "Recovered × the agency's contingency fee rate",
    read: "Set in each agency's contract.",
  },
};

export const METRIC_GROUPS = ["Intake", "Recovery", "Experiment", "Cost", "Agencies", "Governance"];
