"""Recovery: charged-off accounts, after collections has ended.

Collections works delinquent accounts before charge-off (under 180 days past
due) with reminders, calls and payment plans. Recovery works accounts the bank
has charged off, around 180 days, with settlements, one-time payments, legal
recovery and agencies. The data is different too: a recovery account carries
its balance at charge-off, what has been recovered and what remains, not days
past due.

ARI decides which process an account belongs to from its status, so nobody
classifies accounts by hand: charged off, or 180 days past due or more, means
recovery; anything else is collections.

The accounts generated here are placeholders until the bank's reference
workbook (Data Example tab) is loaded; their ranges follow its business
categories.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from .models import RecoveryAccount, RecoveryPayment, User
from .platform import audit, now

UTC = timezone.utc
CHARGE_OFF_DPD = 180
RECOVERY_NUMBER_BASE = 7051500000   # recovery account numbers, apart from collections accounts

STATUSES = ["In Recovery", "Settlement Review", "Specialist Review", "Payment Arranged", "Settled", "Paid in Full",
            "With Agency", "Legal"]
OPEN = ("In Recovery", "Settlement Review", "Specialist Review", "Payment Arranged")

# The recovery treatments a strategist can assign. Settlements change what
# the customer owes, so they wait for a reviewer (Settlement Review).
TREATMENTS = [
    {"code": "R1", "name": "Settlement Offer", "tag": "Recommended",
     "description": "Offer a reduced payoff to encourage near-term resolution.", "status": "Settlement Review"},
    {"code": "R2", "name": "One-time Payment", "tag": "Targeted",
     "description": "Request a full balance payment with structured outreach.", "status": "Payment Arranged"},
    {"code": "R3", "name": "Human Review", "tag": "Special Handling",
     "description": "Route to a specialist for individual review and negotiation.", "status": "Specialist Review"},
]
TREATMENT_BY_CODE = {t["code"]: t for t in TREATMENTS}

# Placeholder ranges by card business until the workbook's values are loaded:
# (share of accounts, charge-off balance range).
MIX = {
    "Consumer Credit Card": (0.42, (1500, 24000)),
    "Small Business Card": (0.18, (8000, 65000)),
    "Retail Card": (0.22, (400, 6500)),
    "Co-brand Card": (0.18, (1800, 21000)),
}
FIRST = ["Aisha", "Carlos", "Dana", "Ethan", "Fatima", "Grace", "Hiro", "Isabel", "Jamal", "Kara", "Liam", "Maya",
         "Noah", "Olivia", "Pablo", "Quinn", "Rosa", "Sam", "Tara", "Umar", "Vera", "Wyatt", "Yusuf", "Zoe"]
LAST = ["Okafor", "Nguyen", "Patel", "Brooks", "Silva", "Kim", "Rossi", "Haddad", "Fischer", "Novak", "Ali", "Dubois",
        "Santos", "Larsen", "Moreau", "Reyes", "Chen", "Walsh"]
BUSINESSES = ["Harbour Line Logistics", "Cedar & Pine Interiors", "Northfield Dental Group", "Brightway Print Co.",
              "Summit Peak Outfitters", "Riverbend Bakery", "Ironclad Auto Repair", "Bluefin Seafood Supply"]


def classify(account_status: str | None, days_past_due: int | None) -> str:
    """Collections or recovery, from the account's own status."""
    if account_status and "charge" in account_status.lower():
        return "recovery"
    if days_past_due is not None and days_past_due >= CHARGE_OFF_DPD:
        return "recovery"
    return "collections"


def account_number(recovery_id: int) -> str:
    return str(RECOVERY_NUMBER_BASE + recovery_id)


def recommend(a: RecoveryAccount) -> dict:
    """ARI's suggested treatment, with the reason. Large or disputed balances go
    to a specialist; customers who are already paying are asked to finish; the
    rest get a settlement offer."""
    remaining = a.charge_off_balance - a.recovered
    if remaining >= 25_000:
        return {"code": "R3", "reason": f"${remaining:,.0f} remaining is above the $25,000 specialist threshold"}
    if a.recovered > 0 and remaining <= 0.5 * a.charge_off_balance:
        return {"code": "R2", "reason": "Already paid more than half since charge-off; ask for the rest in one payment"}
    return {"code": "R1", "reason": "No recent payment; a reduced payoff is the likeliest resolution"}


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def seed(db: Session, now_: datetime, n: int = 920) -> None:
    """Placeholder charged-off accounts and their recovery payments."""
    if db.query(RecoveryAccount).count():
        return
    rng = random.Random(5_505)
    products = list(MIX)
    weights = [MIX[p][0] for p in products]
    for _ in range(n):
        product = rng.choices(products, weights)[0]
        lo, hi = MIX[product][1]
        balance = round(rng.uniform(lo, hi) / 10) * 10
        charged = now_ - timedelta(days=rng.randint(5, 540))
        name = rng.choice(BUSINESSES) if product == "Small Business Card" and rng.random() < 0.6 else \
            f"{rng.choice(FIRST)} {rng.choice(LAST)}"
        a = RecoveryAccount(name=name, product=product, charge_off_date=charged.date().isoformat(),
                            charge_off_balance=float(balance), recovered=0.0, status="In Recovery",
                            source="placeholder", created_at=_iso(charged))
        db.add(a)
        db.flush()
        # Payments since charge-off: most pay nothing, some pay in parts, a few settle.
        age = (now_ - charged).days
        roll = rng.random()
        if roll < 0.45 and age > 20:
            parts = rng.randint(1, 5)
            share = rng.uniform(0.08, 0.6)
            for k in range(parts):
                paid_on = charged + timedelta(days=rng.randint(15, max(16, age - 1)))
                amt = round(balance * share / parts, 2)
                db.add(RecoveryPayment(recovery_id=a.recovery_id, amount=amt, paid_at=_iso(paid_on)))
                a.recovered = round(a.recovered + amt, 2)
        if roll > 0.93 and age > 60:
            a.status = rng.choice(["Settled", "Paid in Full"])
            rest = round(a.charge_off_balance * (0.55 if a.status == "Settled" else 1.0) - a.recovered, 2)
            if rest > 0:
                db.add(RecoveryPayment(recovery_id=a.recovery_id, amount=rest,
                                       paid_at=_iso(charged + timedelta(days=rng.randint(30, age)))))
                a.recovered = round(a.recovered + rest, 2)
        elif roll > 0.86:
            a.status = rng.choice(["With Agency", "Legal"])
        elif roll > 0.74:
            a.status = "Settlement Review"
            a.assigned_treatment, a.assigned_by, a.assigned_at = "R1", "u-maya", _iso(now_ - timedelta(days=rng.randint(1, 9)))
    db.flush()


def _remaining(a: RecoveryAccount) -> float:
    if a.status in ("Settled", "Paid in Full"):
        return 0.0
    return round(max(0.0, a.charge_off_balance - a.recovered), 2)


def _stock(db: Session, product: str | None, as_of: str) -> dict:
    """The charged-off book as it stood at a point in time."""
    q = db.query(RecoveryAccount).filter(RecoveryAccount.created_at <= as_of)
    if product:
        q = q.filter(RecoveryAccount.product == product)
    accts = q.all()
    ids = [a.recovery_id for a in accts]
    paid = 0.0
    if ids:
        paid = db.query(func.coalesce(func.sum(RecoveryPayment.amount), 0.0)).filter(
            RecoveryPayment.recovery_id.in_(ids), RecoveryPayment.paid_at <= as_of).scalar() or 0.0
    balance = sum(a.charge_off_balance for a in accts)
    return {"accounts": len(accts), "balance": round(balance, 2), "recovered": round(float(paid), 2)}


def summary(db: Session, product: str | None = None) -> dict:
    """The four Recovery tiles, each against the month before."""
    now_ = datetime.now(UTC)
    cur, prev = _stock(db, product, _iso(now_)), _stock(db, product, _iso(now_ - timedelta(days=30)))
    q = db.query(RecoveryAccount)
    if product:
        q = q.filter(RecoveryAccount.product == product)
    remaining = sum(_remaining(a) for a in q)
    prev_remaining = max(0.0, prev["balance"] - prev["recovered"])

    def delta(a: float, b: float) -> float | None:
        return round((a - b) / b, 4) if b else None

    return {
        "product": product,
        "charged_off_accounts": {"value": cur["accounts"], "delta": delta(cur["accounts"], prev["accounts"])},
        "charge_off_balance": {"value": cur["balance"], "delta": delta(cur["balance"], prev["balance"])},
        "amount_recovered": {"value": cur["recovered"], "delta": delta(cur["recovered"], prev["recovered"])},
        "remaining_balance": {"value": round(remaining, 2), "delta": delta(remaining, prev_remaining)},
        "by_status": dict(q.with_entities(RecoveryAccount.status, func.count()).group_by(RecoveryAccount.status).all()),
        "source": "placeholder" if q.filter(RecoveryAccount.source == "placeholder").count() else "bank",
    }


def accounts(db: Session, product: str | None = None, status: str | None = None, page: int = 1,
             page_size: int = 25) -> dict:
    q = db.query(RecoveryAccount)
    if product:
        q = q.filter(RecoveryAccount.product == product)
    if status:
        q = q.filter(RecoveryAccount.status == status)
    total = q.count()
    rows = (q.order_by(RecoveryAccount.charge_off_date.desc(), RecoveryAccount.recovery_id.desc()).offset((max(1, page) - 1) * page_size)
            .limit(page_size).all())
    names = {u.user_id: u.name for u in db.query(User)}
    out = []
    for a in rows:
        rec = recommend(a)
        out.append({"recovery_id": a.recovery_id, "account_number": account_number(a.recovery_id), "name": a.name,
                    "product": a.product, "charge_off_date": a.charge_off_date,
                    "charge_off_balance": a.charge_off_balance, "recovered": a.recovered, "remaining": _remaining(a),
                    "status": a.status, "recommended": {**TREATMENT_BY_CODE[rec["code"]], "reason": rec["reason"]},
                    "assigned": TREATMENT_BY_CODE.get(a.assigned_treatment or "", None),
                    "assigned_by": names.get(a.assigned_by or ""), "assigned_at": a.assigned_at,
                    "eligible": a.status == "In Recovery"})
    return {"total": total, "page": page, "page_size": page_size, "rows": out}


def assign(db: Session, recovery_ids: list[int], code: str, actor: str) -> dict:
    """Assign a recovery treatment. Only open accounts not already assigned can take one."""
    t = TREATMENT_BY_CODE.get(code)
    if t is None:
        raise ValueError(f"Unknown recovery treatment {code}.")
    if not recovery_ids:
        raise ValueError("Select at least one account.")
    done, skipped = [], []
    for a in db.query(RecoveryAccount).filter(RecoveryAccount.recovery_id.in_(recovery_ids)):
        if a.status != "In Recovery":
            skipped.append(account_number(a.recovery_id))
            continue
        a.assigned_treatment, a.assigned_by, a.assigned_at, a.status = code, actor, now(), t["status"]
        done.append(account_number(a.recovery_id))
    if done:
        audit(db, actor, "UPDATE", "recovery", t["code"], f"Assigned {t['name']} to {len(done)} recovery accounts",
              {"accounts": done})
    db.commit()
    return {"assigned": len(done), "skipped": skipped, "treatment": t["name"], "status": t["status"]}


def treatments() -> list[dict]:
    return [dict(t) for t in TREATMENTS]
