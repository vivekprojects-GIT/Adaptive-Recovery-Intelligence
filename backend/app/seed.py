"""Demo data: four client-handed-off cohorts, three named personas, a strategy playbook."""
from __future__ import annotations
import random

from .db import Base, engine, SessionLocal
from . import models
from .scoring import nudge_score, self_cure_score, segment_for

FIRST = ["Aisha", "Carlos", "Dana", "Ethan", "Fatima", "Grace", "Hiro", "Isabel", "Jamal", "Kara",
         "Liam", "Maya", "Noah", "Olivia", "Pablo", "Quinn", "Rosa", "Sam", "Tara", "Umar", "Vera",
         "Wyatt", "Yusuf", "Zoe", "Adam", "Bianca", "Leo", "Nina", "Omar", "Ruth"]
LAST = ["Okafor", "Nguyen", "Patel", "Brooks", "Silva", "Kim", "Rossi", "Haddad", "Fischer",
        "Novak", "Ali", "Dubois", "Santos", "Larsen", "Moreau", "Reyes", "Chen", "Walsh"]

# What the client's collections system hands over. ARI does not recompute these.
COHORTS = [
    dict(cohort_id="C1", name="Early arrears", dpd_bucket="1-29 DPD", client_risk_band="Low",
         expected_payment="3-5 days", sort_order=1, size=380,
         mix={"Persuadable": 0.20, "Sure Thing": 0.70, "Lost Cause": 0.03, "Sleeping Dog": 0.07},
         dpd=(3, 29), risk=(18, 38),
         description="Mostly forgetful payers. Most will cure on their own."),
    dict(cohort_id="C2", name="30 DPD - medium risk", dpd_bucket="30 DPD", client_risk_band="Medium",
         expected_payment="7-10 days", sort_order=2, size=509,
         mix={"Persuadable": 0.35, "Sure Thing": 0.45, "Lost Cause": 0.12, "Sleeping Dog": 0.08},
         dpd=(28, 35), risk=(42, 66),
         description="The client's model rates these medium risk with payment expected in 7-10 days. "
                     "The intervention decision starts here."),
    dict(cohort_id="C3", name="60 DPD - high risk", dpd_bucket="60 DPD", client_risk_band="High",
         expected_payment="14-21 days", sort_order=3, size=290,
         mix={"Persuadable": 0.30, "Sure Thing": 0.20, "Lost Cause": 0.35, "Sleeping Dog": 0.15},
         dpd=(58, 66), risk=(66, 84),
         description="Two cycles behind. A real split between the recoverable and the distressed."),
    dict(cohort_id="C4", name="90+ DPD - very high risk", dpd_bucket="90+ DPD", client_risk_band="Very high",
         expected_payment="Unlikely without help", sort_order=4, size=160,
         mix={"Persuadable": 0.10, "Sure Thing": 0.05, "Lost Cause": 0.70, "Sleeping Dog": 0.15},
         dpd=(90, 125), risk=(84, 98),
         description="Pre charge-off. Mostly hardship cases."),
]

STRATEGIES = [
    dict(code="S1", name="Reminder SMS", channel="SMS",
         offer="Balance-due reminder with a pay-now link.", timing="Day 1",
         eligibility_rule="All contactable customers", cost_per_contact=0.08,
         hist_successes=71, hist_failures=169),
    dict(code="S2", name="In-app nudge", channel="App push",
         offer="Personalised push at the customer's usual app time, one tap to pay.", timing="Day 1, preferred hour",
         eligibility_rule="Active mobile-app users", cost_per_contact=0.02,
         hist_successes=60, hist_failures=140),
    dict(code="S3", name="Split Payment Plan", channel="SMS + App",
         offer="Split the arrears into 3 instalments, no fee.", timing="Day 3",
         eligibility_rule="Balance ≥ $500 and no more than 2 missed payments in 12 months",
         cost_per_contact=1.20, hist_successes=96, hist_failures=144),
    dict(code="S4", name="Payment Deferral", channel="SMS + App",
         offer="Move the due date by 30 days, no fee.", timing="Day 3",
         eligibility_rule="Tenure ≥ 2 years and on-time history ≥ 70%", cost_per_contact=0.90,
         hist_successes=55, hist_failures=95),
    dict(code="S5", name="Agent Call", channel="Outbound call",
         offer="Collector call to agree a promise to pay.", timing="Day 5",
         eligibility_rule="All customers", cost_per_contact=4.80,
         hist_successes=45, hist_failures=195),
    dict(code="S6", name="Hardship Review", channel="Specialist team",
         offer="Affordability review and a reduced payment plan.", timing="Day 2",
         eligibility_rule="Hardship flag on file", cost_per_contact=6.50,
         hist_successes=85, hist_failures=155),
]


def _draw(target: str, rng: random.Random) -> dict:
    """Behavioural profile shaped toward a target intervention-fit group."""
    if target == "Persuadable":
        return dict(tenure_years=rng.randint(4, 12), sms_responsive=True, app_user=rng.random() < 0.85,
                    hardship_flag=rng.random() < 0.7, missed_payments=rng.choice([0, 1, 1]),
                    payment_history=round(rng.uniform(0.82, 0.98), 2),
                    utilization=round(rng.uniform(0.55, 0.95), 2))
    if target == "Sure Thing":
        return dict(tenure_years=rng.randint(2, 9), sms_responsive=rng.random() < 0.55,
                    app_user=rng.random() < 0.35, hardship_flag=False, missed_payments=rng.choice([0, 0, 1]),
                    payment_history=round(rng.uniform(0.84, 0.99), 2),
                    utilization=round(rng.uniform(0.30, 0.90), 2))
    if target == "Lost Cause":
        return dict(tenure_years=rng.randint(1, 8), sms_responsive=rng.random() < 0.6,
                    app_user=rng.random() < 0.5, hardship_flag=True, missed_payments=rng.randint(3, 6),
                    payment_history=round(rng.uniform(0.35, 0.70), 2),
                    utilization=round(rng.uniform(0.80, 1.0), 2))
    return dict(tenure_years=rng.randint(1, 3), sms_responsive=False, app_user=False,  # Sleeping Dog
                hardship_flag=False, missed_payments=rng.randint(2, 4),
                payment_history=round(rng.uniform(0.28, 0.48), 2),
                utilization=round(rng.uniform(0.40, 0.90), 2))


# Same client cohort, same client risk band - three different right answers.
PERSONAS = [
    dict(name="Priya Sharma", balance=4180.0, credit_limit=5000.0, utilization=0.84, tenure_years=6,
         sms_responsive=True, app_user=True, hardship_flag=True, missed_payments=1,
         payment_history=0.94, days_past_due=30, client_risk_score=62.0,
         persona_note="Hours reduced at work - temporary hardship. Opens SMS, uses the mobile app around 6 PM."),
    dict(name="John Mitchell", balance=7920.0, credit_limit=9000.0, utilization=0.88, tenure_years=8,
         sms_responsive=False, app_user=False, hardship_flag=False, missed_payments=1,
         payment_history=0.85, days_past_due=30, client_risk_score=58.0,
         persona_note="Forgot to pay. Eight years of on-time payments and no hardship - "
                      "he ignores outreach and settles the balance on his own."),
    dict(name="Mike Torres", balance=7640.0, credit_limit=8000.0, utilization=0.955, tenure_years=3,
         sms_responsive=False, app_user=False, hardship_flag=True, missed_payments=4,
         payment_history=0.44, days_past_due=31, client_risk_score=64.0,
         persona_note="Recent unemployment, several missed payments this year. "
                      "No reminder or payment plan substitutes for lost income."),
]


def seed(reset: bool = True) -> dict:
    if reset:
        Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    rng = random.Random(42)
    db = SessionLocal()
    try:
        if db.query(models.Customer).count() > 0:
            return {"status": "already seeded"}

        for s in STRATEGIES:
            db.add(models.Strategy(**s))
        for co in COHORTS:
            db.add(models.Cohort(**{k: co[k] for k in (
                "cohort_id", "name", "dpd_bucket", "client_risk_band", "expected_payment",
                "description", "sort_order")}))

        rows: list[models.Customer] = []
        for p in PERSONAS:
            rows.append(models.Customer(cohort_id="C2", client_risk_band="Medium", is_persona=True, **p))

        for co in COHORTS:
            n = co["size"] - (len(PERSONAS) if co["cohort_id"] == "C2" else 0)
            targets: list[str] = []
            for seg, share in co["mix"].items():
                targets += [seg] * int(round(share * n))
            while len(targets) < n:
                targets.append("Sure Thing")
            targets = targets[:n]
            rng.shuffle(targets)
            for target in targets:
                for _ in range(60):  # rejection-sample until the profile lands in its group
                    f = _draw(target, rng)
                    limit = rng.choice([2000, 3000, 5000, 8000, 12000, 15000])
                    cand = models.Customer(
                        cohort_id=co["cohort_id"],
                        name=f"{rng.choice(FIRST)} {rng.choice(LAST)}",
                        balance=round(limit * f["utilization"], 2),
                        credit_limit=float(limit),
                        days_past_due=rng.randint(*co["dpd"]),
                        client_risk_band=co["client_risk_band"],
                        client_risk_score=round(rng.uniform(*co["risk"]), 1),
                        **f,
                    )
                    if segment_for(cand) == target:
                        break
                rows.append(cand)

        for c in rows:
            c.nudge_score = nudge_score(c)
            c.self_cure_score = self_cure_score(c)
            c.segment = segment_for(c)
            db.add(c)
        db.commit()
        return {"status": "seeded", "customers": len(rows), "cohorts": len(COHORTS),
                "strategies": len(STRATEGIES)}
    finally:
        db.close()


if __name__ == "__main__":
    print(seed())
