"""Recovery: charged-off accounts, after collections has ended.

Collections works delinquent accounts before charge-off (under 180 days past
due) with reminders, calls and payment plans. Recovery works accounts the bank
has charged off, around 180 days, with settlements, one-time payments, legal
recovery and agencies. The data is different too: a recovery account carries
its balance at charge-off, what has been recovered and what remains, not days
past due.

CARE decides which process an account belongs to from its status, so nobody
classifies accounts by hand: charged off, or 180 days past due or more, means
recovery; anything else is collections.

The book holds the bank's sample recovery accounts exactly as its reference
workbook gives them, and further accounts inside the same ranges and statuses
(app/cards.py).
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import cards
from .models import RecoveryAccount, RecoveryPayment, User
from .platform import audit, now

UTC = timezone.utc
CHARGE_OFF_DPD = 180

# The bank's recovery statuses, from its workbook ("Active Collections" there is
# "Active Recovery" here, as the bank asked).
BANK_STATUSES = ["Active Recovery", "Partial Recovery", "Payment Plan", "Settlement Agreement", "Paid in Full"]
# Accounts with no arrangement yet, which a strategist can assign a treatment to.
ELIGIBLE = ("Active Recovery", "Partial Recovery")
# A balance this large always goes to a specialist, never an automated offer.
SPECIALIST_THRESHOLD = 25_000
# A settlement offer asks for this share of what remains.
SETTLEMENT_SHARE = 0.6

# The recovery treatments a strategist can assign. Settlements change what
# the customer owes, so they wait for a reviewer (Settlement Review). Each
# carries the bank's track record for it (accounts that paid within 30 days,
# out of accounts that got it): the decision engine starts from that as a weak
# belief and learns from every outcome after.
TREATMENTS = [
    {"code": "R1", "name": "Settlement Offer", "tag": "Recommended",
     "description": "Offer a reduced payoff to encourage near-term resolution.", "status": "Settlement Review",
     "channel": "Letter and SMS", "timing": "Within 2 days of approval", "successes": 38, "attempts": 120},
    {"code": "R2", "name": "One-time Payment", "tag": "Targeted",
     "description": "Request a full balance payment with structured outreach.", "status": "Payment Arranged",
     "channel": "SMS and email with a payment link", "timing": "Day 1", "successes": 14, "attempts": 80},
    {"code": "R3", "name": "Human Review", "tag": "Special Handling",
     "description": "Route to a specialist for individual review and negotiation.", "status": "Specialist Review",
     "channel": "Specialist phone call", "timing": "Within 2 working days", "successes": 27, "attempts": 90},
]
TREATMENT_BY_CODE = {t["code"]: t for t in TREATMENTS}

# Charge-off balances by card business, around the workbook's sample accounts:
# (share of accounts, lowest, highest, most common).
MIX = {
    "Consumer Credit Card": (0.42, 1_000, 25_000, 10_000),
    "Small Business Card": (0.18, 5_000, 120_000, 50_000),
    "Retail Card": (0.22, 500, 15_000, 5_000),
    "Co-Brand Card": (0.18, 1_000, 35_000, 15_000),
}
# How the book splits across the statuses, and the share of the charge-off
# balance recovered so far in each. Settlement Review accounts have just been
# offered a settlement that waits for a reviewer.
STATUS_MIX = [("Active Recovery", 0.36, (0.0, 0.0)), ("Partial Recovery", 0.20, (0.10, 0.60)),
              ("Payment Plan", 0.18, (0.05, 0.50)), ("Settlement Agreement", 0.10, (0.40, 0.85)),
              ("Paid in Full", 0.08, (1.0, 1.0)), ("Settlement Review", 0.08, (0.0, 0.0))]
INSTALMENTS = {"Partial Recovery": (1, 3), "Payment Plan": (3, 8), "Settlement Agreement": (2, 4),
               "Paid in Full": (1, 3)}
FIRST = ["Amber", "Bradley", "Carly", "Dalton", "Emily", "Forrest", "Gretchen", "Hunter", "Jillian", "Kyle",
         "Lindsey", "Mason", "Natalie", "Owen", "Peyton", "Riley", "Savannah", "Trent", "Vanessa", "Wade",
         "Allison", "Chase", "Molly", "Spencer"]
LAST = ["Abernathy", "Beckett", "Crawford", "Dunham", "Fletcher", "Gentry", "Hadley", "Jarrett", "Lockhart",
        "Maddox", "Norwood", "Pendleton", "Ramsey", "Stanton", "Tolliver", "Vance", "Wheeler", "Yardley"]


def classify(account_status: str | None, days_past_due: int | None) -> str:
    """Collections or recovery, from the account's own status."""
    if account_status and "charge" in account_status.lower():
        return "recovery"
    if days_past_due is not None and days_past_due >= CHARGE_OFF_DPD:
        return "recovery"
    return "collections"


def recommend(a: RecoveryAccount) -> dict:
    """CARE's suggested treatment, with the reason. Large or disputed balances go
    to a specialist; customers who are already paying are asked to finish; the
    rest get a settlement offer."""
    remaining = a.charge_off_balance - a.recovered
    if remaining >= SPECIALIST_THRESHOLD:
        return {"code": "R3", "reason": f"${remaining:,.0f} remaining is above the ${SPECIALIST_THRESHOLD:,} specialist threshold"}
    if a.recovered > 0 and remaining <= 0.5 * a.charge_off_balance:
        return {"code": "R2", "reason": "Already paid more than half since charge-off; ask for the rest in one payment"}
    return {"code": "R1", "reason": "No recent payment; a reduced payoff is the likeliest resolution"}


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def _name(product: str, rng: random.Random) -> str:
    if product == "Small Business Card" and rng.random() < 0.6:
        return rng.choice(cards.SMALL_BUSINESSES)
    return f"{rng.choice(FIRST)} {rng.choice(LAST)}"


def _pay(db: Session, a: RecoveryAccount, amount: float, charged: datetime, age: int, parts: int,
         rng: random.Random) -> None:
    """Payments since charge-off that add up to the amount recovered, oldest first."""
    if amount <= 0:
        return
    days = sorted(rng.randint(15, max(16, age - 1)) for _ in range(parts))
    left = round(amount, 2)
    for k, day in enumerate(days):
        amt = left if k == parts - 1 else round(amount / parts, 2)
        db.add(RecoveryPayment(recovery_id=a.recovery_id, amount=amt, paid_at=_iso(charged + timedelta(days=day))))
        left = round(left - amt, 2)
    a.recovered = round(amount, 2)


def _next_numbers(db: Session) -> dict[str, int]:
    seqs = {p: 0 for p in cards.TERMS}
    for product, acct in db.query(RecoveryAccount.product, RecoveryAccount.account_number).filter(
            RecoveryAccount.account_number.like("REC%")):
        seqs[product] = max(seqs.get(product, 0), cards.sequence(acct))
    return seqs


def seed(db: Session, now_: datetime, n: int = 920) -> None:
    """The bank's sample recovery accounts, then the rest of the charged-off
    book inside the same ranges, with the payments received since charge-off."""
    if db.query(RecoveryAccount).count():
        return
    rng = random.Random(5_505)
    for acct, product, balance, recovered, status in cards.RECOVERY_SAMPLE:
        age = rng.randint(90, 420)
        charged = now_ - timedelta(days=age)
        a = RecoveryAccount(account_number=acct, name=_name(product, rng), product=product,
                            charge_off_date=charged.date().isoformat(), charge_off_balance=float(balance),
                            recovered=0.0, status=status, source="workbook", created_at=_iso(charged))
        db.add(a)
        db.flush()
        _pay(db, a, float(recovered), charged, age, rng.randint(*INSTALMENTS.get(status, (1, 1))), rng)

    seqs = _next_numbers(db)
    products = list(MIX)
    weights = [MIX[p][0] for p in products]
    statuses = [s for s, _, _ in STATUS_MIX]
    for _ in range(n - len(cards.RECOVERY_SAMPLE)):
        product = rng.choices(products, weights)[0]
        _, lo, hi, mode = MIX[product]
        balance = round(rng.triangular(lo, hi, mode) / 50) * 50
        age = rng.randint(5, 540)
        charged = now_ - timedelta(days=age)
        status = rng.choices(statuses, [w for _, w, _ in STATUS_MIX])[0]
        if age < 60 and status not in ("Active Recovery", "Settlement Review"):
            status = "Active Recovery"   # too soon after charge-off for payments to have come in
        seqs[product] += 1
        a = RecoveryAccount(account_number=cards.account_id(product, seqs[product], recovery=True),
                            name=_name(product, rng), product=product, charge_off_date=charged.date().isoformat(),
                            charge_off_balance=float(balance), recovered=0.0, status=status, source="generated",
                            created_at=_iso(charged))
        db.add(a)
        db.flush()
        share = rng.uniform(*dict((s, r) for s, _, r in STATUS_MIX)[status])
        _pay(db, a, round(balance * share, 2), charged, age, rng.randint(*INSTALMENTS.get(status, (1, 1))), rng)
        if status == "Settlement Review":
            a.assigned_treatment, a.assigned_by, a.assigned_at = "R1", "u-maya", _iso(now_ - timedelta(days=rng.randint(1, 9)))
    db.flush()


def adopt_workbook(db: Session) -> None:
    """Move recovery accounts stored before the bank's workbook onto its
    statuses and account IDs."""
    old = {"In Recovery": None, "Settled": "Settlement Agreement", "With Agency": "Active Recovery",
           "Legal": "Active Recovery", "Active Collections": "Active Recovery"}
    for a in db.query(RecoveryAccount).filter(RecoveryAccount.status.in_(list(old))):
        a.status = old[a.status] or ("Partial Recovery" if a.recovered > 0 else "Active Recovery")
    seqs = _next_numbers(db)
    for a in db.query(RecoveryAccount).filter(RecoveryAccount.account_number.is_(None)).order_by(
            RecoveryAccount.recovery_id):
        if a.external_ref:
            a.account_number = a.external_ref
            continue
        seqs[a.product] = seqs.get(a.product, 0) + 1
        a.account_number = cards.account_id(a.product, seqs[a.product], recovery=True)
    db.query(RecoveryAccount).filter(RecoveryAccount.source == "placeholder").update(
        {RecoveryAccount.source: "generated"}, synchronize_session=False)


def _remaining(a: RecoveryAccount) -> float:
    """The current recovery balance: charged off, less what has come in."""
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
        "recovery_rate": round(cur["recovered"] / cur["balance"], 4) if cur["balance"] else None,
        "by_status": dict(q.with_entities(RecoveryAccount.status, func.count()).group_by(RecoveryAccount.status).all()),
    }


def accounts(db: Session, product: str | None = None, status: str | None = None, page: int = 1,
             page_size: int = 25) -> dict:
    q = db.query(RecoveryAccount)
    if product:
        q = q.filter(RecoveryAccount.product == product)
    if status:
        q = q.filter(RecoveryAccount.status == status)
    total = q.count()
    rows = (q.order_by(RecoveryAccount.account_number, RecoveryAccount.recovery_id).offset((max(1, page) - 1) * page_size)
            .limit(page_size).all())
    names = {u.user_id: u.name for u in db.query(User)}
    out = []
    for a in rows:
        rec = recommend(a)
        out.append({"recovery_id": a.recovery_id, "account_number": a.account_number, "name": a.name,
                    "product": a.product, "charge_off_date": a.charge_off_date,
                    "charge_off_balance": a.charge_off_balance, "recovered": a.recovered, "remaining": _remaining(a),
                    "recovery_rate": round(a.recovered / a.charge_off_balance, 4) if a.charge_off_balance else 0.0,
                    "status": a.status, "recommended": {**TREATMENT_BY_CODE[rec["code"]], "reason": rec["reason"]},
                    "assigned": TREATMENT_BY_CODE.get(a.assigned_treatment or "", None),
                    "assigned_by": names.get(a.assigned_by or ""), "assigned_at": a.assigned_at,
                    "eligible": a.status in ELIGIBLE and not a.assigned_treatment})
    return {"total": total, "page": page, "page_size": page_size, "rows": out}


def assign(db: Session, recovery_ids: list[int], code: str, actor: str) -> dict:
    """Assign a recovery treatment. Only accounts with no arrangement and no treatment yet can take one."""
    t = TREATMENT_BY_CODE.get(code)
    if t is None:
        raise ValueError(f"Unknown recovery treatment {code}.")
    if not recovery_ids:
        raise ValueError("Select at least one account.")
    done, skipped = [], []
    for a in db.query(RecoveryAccount).filter(RecoveryAccount.recovery_id.in_(recovery_ids)):
        if a.status not in ELIGIBLE or a.assigned_treatment:
            skipped.append(a.account_number)
            continue
        a.assigned_treatment, a.assigned_by, a.assigned_at, a.status = code, actor, now(), t["status"]
        done.append(a.account_number)
    if done:
        audit(db, actor, "UPDATE", "recovery", t["code"], f"Assigned {t['name']} to {len(done)} recovery accounts",
              {"accounts": done})
    db.commit()
    return {"assigned": len(done), "skipped": skipped, "treatment": t["name"], "status": t["status"]}


def treatments() -> list[dict]:
    return [dict(t) for t in TREATMENTS]


def segment(a: RecoveryAccount, now_: datetime) -> dict:
    """The segment a recovery account falls in, from what the bank holds on it:
    who holds the card, how much is left, whether anything has come in since
    charge-off, and how long ago it was charged off."""
    remaining = _remaining(a)
    days = (now_.date() - datetime.fromisoformat(a.charge_off_date).date()).days
    share = a.recovered / a.charge_off_balance if a.charge_off_balance else 0.0
    band = ("Large balance" if remaining >= SPECIALIST_THRESHOLD else
            "Medium balance" if remaining >= 5_000 else "Small balance")
    paying = "paying since charge-off" if a.recovered > 0 else "no payment since charge-off"
    return {
        "name": f"{band}, {paying}",
        "factors": [
            {"label": "Holder", "value": "Business" if a.product == "Small Business Card" else "Individual",
             "why": "Business cards are negotiated with the business owner."},
            {"label": "Balance left", "value": f"${remaining:,.0f}",
             "why": f"{band}: at ${SPECIALIST_THRESHOLD:,} or more a specialist handles the account."},
            {"label": "Paid since charge-off", "value": f"{share:.0%}",
             "why": "Customers already paying respond to different offers than customers who have not paid."},
            {"label": "Time in recovery", "value": f"{days} days",
             "why": "The longer an account sits in recovery, the less likely a full payment becomes."},
        ],
    }


def journey(db: Session) -> dict:
    """What the Strategy Journey page walks through: the bank's sample recovery
    accounts, each with its segment and the treatment CARE recommends, and the
    treatments with their track record and the rules that limit them."""
    now_ = datetime.now(UTC)
    ids = [s[0] for s in cards.RECOVERY_SAMPLE if s[4] in ELIGIBLE]
    rows = (db.query(RecoveryAccount).filter(RecoveryAccount.account_number.in_(ids))
            .order_by(RecoveryAccount.account_number).all())
    paid = {rid: (n, last) for rid, n, last in db.query(
        RecoveryPayment.recovery_id, func.count(), func.max(RecoveryPayment.paid_at)).filter(
        RecoveryPayment.recovery_id.in_([a.recovery_id for a in rows])).group_by(RecoveryPayment.recovery_id)}
    accounts = []
    for a in rows:
        rec = recommend(a)
        n, last = paid.get(a.recovery_id, (0, None))
        accounts.append({"recovery_id": a.recovery_id, "account_number": a.account_number, "name": a.name,
                         "product": a.product, "charge_off_date": a.charge_off_date,
                         "charge_off_balance": a.charge_off_balance, "recovered": a.recovered,
                         "remaining": _remaining(a), "status": a.status, "payments": n, "last_payment": last,
                         "segment": segment(a, now_),
                         "recommended": {**TREATMENT_BY_CODE[rec["code"]], "reason": rec["reason"]}})
    return {"accounts": accounts, "treatments": treatments(),
            "rules": {"specialist_threshold": SPECIALIST_THRESHOLD, "settlement_share": SETTLEMENT_SHARE,
                      "charge_off_dpd": CHARGE_OFF_DPD}}
