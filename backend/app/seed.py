"""Generate the demo population: 3 named personas + 1000 synthetic customers."""
from __future__ import annotations
import random

from .db import Base, engine, SessionLocal
from . import models
from .scoring import risk_score, nudge_score, self_cure_score, segment_for

FIRST = ["Priya", "John", "Mike", "Aisha", "Carlos", "Dana", "Ethan", "Fatima", "Grace", "Hiro",
         "Isabel", "Jamal", "Kara", "Liam", "Maya", "Noah", "Olivia", "Pablo", "Quinn", "Rosa",
         "Sam", "Tara", "Umar", "Vera", "Wyatt", "Xena", "Yusuf", "Zoe", "Adam", "Bianca"]
LAST = ["Sharma", "Mitchell", "Torres", "Okafor", "Nguyen", "Patel", "Brooks", "Silva", "Kim",
        "Rossi", "Haddad", "Fischer", "Novak", "Ali", "Dubois", "Santos", "Larsen", "Moreau"]

JOURNEYS = [
    ("J1", "Reminder SMS", "Low-cost automated SMS nudge with a pay-now deep link.", 0.08),
    ("J2", "Split Payment Plan", "Break the arrears into 2-3 affordable instalments.", 1.20),
    ("J3", "Hardship Plan", "Reduced payment / interest freeze with hardship-team review.", 6.50),
    ("J4", "Call", "Outbound agent call from the collections desk.", 4.80),
    ("J5", "Payment Deferral", "Defer the due date by 30 days, no fee.", 0.90),
]

# Seeded priors - what the bandit has learned so far from historical outcomes.
BANDIT_PRIOR = {"J1": (71, 169), "J2": (96, 144), "J3": (85, 155), "J4": (45, 195), "J5": (55, 95)}

SEGMENT_MIX = [("Persuadable", 0.30), ("Sure Thing", 0.50), ("Lost Cause", 0.15), ("Sleeping Dog", 0.05)]


def _draw(target: str, rng: random.Random) -> dict:
    """Feature draw shaped toward a target segment."""
    if target == "Persuadable":
        return dict(
            tenure_years=rng.randint(4, 12),
            sms_responsive=True,
            app_user=rng.random() < 0.85,
            hardship_flag=rng.random() < 0.7,
            missed_payments=rng.choice([0, 1, 1]),
            payment_history=round(rng.uniform(0.82, 0.98), 2),
            utilization=round(rng.uniform(0.55, 0.95), 2),
            days_past_due=rng.choice([3, 7, 14, 21]),
        )
    if target == "Sure Thing":
        return dict(
            tenure_years=rng.randint(2, 9),
            sms_responsive=rng.random() < 0.55,
            app_user=rng.random() < 0.35,
            hardship_flag=False,
            missed_payments=rng.choice([0, 0, 1]),
            payment_history=round(rng.uniform(0.80, 0.99), 2),
            utilization=round(rng.uniform(0.30, 0.90), 2),
            days_past_due=rng.choice([1, 3, 7, 14, 21, 30]),
        )
    if target == "Lost Cause":
        return dict(
            tenure_years=rng.randint(1, 8),
            sms_responsive=rng.random() < 0.6,
            app_user=rng.random() < 0.5,
            hardship_flag=True,
            missed_payments=rng.randint(3, 6),
            payment_history=round(rng.uniform(0.35, 0.70), 2),
            utilization=round(rng.uniform(0.80, 1.0), 2),
            days_past_due=rng.choice([45, 60, 75, 90]),
        )
    return dict(  # Sleeping Dog - disengaged, no hardship, poor record, contact backfires
        tenure_years=rng.randint(1, 3),
        sms_responsive=False,
        app_user=False,
        hardship_flag=False,
        missed_payments=rng.randint(2, 4),
        payment_history=round(rng.uniform(0.28, 0.48), 2),
        utilization=round(rng.uniform(0.40, 0.90), 2),
        days_past_due=rng.choice([30, 40, 50, 60]),
    )


PERSONAS = [
    dict(
        name="Priya Sharma", balance=4180.0, credit_limit=5000.0, utilization=0.84, tenure_years=6,
        sms_responsive=True, app_user=True, hardship_flag=True, missed_payments=1,
        payment_history=0.94, days_past_due=7, is_persona=True,
        persona_note="Hours reduced at work - temporary hardship. Opens SMS, uses the mobile app around 6 PM.",
    ),
    dict(
        name="John Mitchell", balance=7920.0, credit_limit=9000.0, utilization=0.88, tenure_years=8,
        sms_responsive=False, app_user=False, hardship_flag=False, missed_payments=1,
        payment_history=0.85, days_past_due=33, is_persona=True,
        persona_note="Forgot to pay on a high-utilisation card. Eight years of on-time payments and "
                     "no hardship - he ignores outreach and settles the balance on his own.",
    ),
    dict(
        name="Mike Torres", balance=7640.0, credit_limit=8000.0, utilization=0.955, tenure_years=3,
        sms_responsive=False, app_user=False, hardship_flag=True, missed_payments=4,
        payment_history=0.44, days_past_due=72, is_persona=True,
        persona_note="Recent unemployment, multiple missed payments. Severe, not temporary, hardship - "
                     "no reminder or payment plan substitutes for lost income.",
    ),
]

PERSONA_OUTCOME = {
    "Priya Sharma": "Recovered",
    "John Mitchell": "Self Recovered",
    "Mike Torres": "Assisted Route",
}

# Which journey each segment ends up treated with, and how it resolves.
TREATMENT_BY_SEGMENT = {
    "Persuadable": ("Split Payment Plan", ["Recovered", "Recovered", "Recovered", "Not Recovered"]),
    "Sure Thing": ("Reminder SMS", ["Self Recovered", "Self Recovered", "Self Recovered", "Not Recovered"]),
    "Lost Cause": ("Hardship Plan", ["Assisted Route", "Assisted Route", "Not Recovered"]),
    "Sleeping Dog": ("No Contact", ["Not Recovered", "Self Recovered"]),
}


def seed(n: int = 1000, reset: bool = True) -> dict:
    if reset:
        Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    rng = random.Random(42)
    db = SessionLocal()
    try:
        if db.query(models.Journey).count() == 0:
            for code, name, desc, cost in JOURNEYS:
                j = models.Journey(journey_code=code, journey_name=name, description=desc, cost_per_contact=cost)
                db.add(j)
                db.flush()
                s, f = BANDIT_PRIOR[code]
                db.add(models.BanditStat(journey_id=j.journey_id, successes=s, failures=f))
            db.commit()

        if db.query(models.Customer).count() > 0:
            return {"status": "already seeded", "customers": db.query(models.Customer).count()}

        rows: list[models.Customer] = []
        for p in PERSONAS:
            rows.append(models.Customer(**p))

        targets: list[str] = []
        for seg, share in SEGMENT_MIX:
            targets += [seg] * int(round(share * (n - len(PERSONAS))))
        while len(targets) < n - len(PERSONAS):
            targets.append("Sure Thing")
        rng.shuffle(targets)

        for i, target in enumerate(targets):
            for _ in range(40):  # rejection-sample until the draw lands in the target band
                f = _draw(target, rng)
                limit = rng.choice([2000, 3000, 5000, 8000, 12000, 15000])
                cand = models.Customer(
                    name=f"{rng.choice(FIRST)} {rng.choice(LAST)}",
                    balance=round(limit * f["utilization"], 2),
                    credit_limit=float(limit),
                    **f,
                )
                if segment_for(cand) == target:
                    break
            rows.append(cand)

        for c in rows:
            c.risk_score = risk_score(c)
            c.nudge_score = nudge_score(c)
            c.self_cure_score = self_cure_score(c)
            c.segment = segment_for(c)
            treatment, outcomes = TREATMENT_BY_SEGMENT[c.segment]
            c.treatment = treatment
            # Personas carry the fixed demo narrative; the population is sampled.
            c.outcome = PERSONA_OUTCOME.get(c.name, rng.choice(outcomes)) if c.is_persona \
                else rng.choice(outcomes)
            db.add(c)
        db.commit()
        return {"status": "seeded", "customers": len(rows), "journeys": len(JOURNEYS)}
    finally:
        db.close()


if __name__ == "__main__":
    print(seed())
