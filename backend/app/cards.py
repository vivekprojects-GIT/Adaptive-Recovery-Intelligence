"""The bank's four card businesses, as set out in its reference workbook
(Kumar, Oct 2026): balance ranges, account ID formats, and the sample
collections and recovery accounts, which are loaded exactly as written.

Generated accounts follow the same ranges, so every account on screen reads
like one of the bank's own.
"""
from __future__ import annotations

import random

# Typical total balance, the most a demo account may carry, the smallest
# delinquent amount, and the credit limits the business issues (most common
# first). Account IDs are the prefix and a five-digit number in the business's
# series: CC10001, SB20001, RP30001, RC40001; recovery accounts are REC10001...
TERMS = {
    "Consumer Credit Card": dict(prefix="CC", series=1, typical=(100, 15_000), maximum=25_000, min_delinquent=25,
                                 limits=(1_500, 2_500, 5_000, 7_500, 10_000, 12_000, 15_000, 20_000, 25_000)),
    "Small Business Card": dict(prefix="SB", series=2, typical=(500, 50_000), maximum=100_000, min_delinquent=100,
                                limits=(5_000, 10_000, 15_000, 25_000, 35_000, 50_000, 75_000, 100_000, 120_000)),
    "Retail Card": dict(prefix="RP", series=3, typical=(50, 5_000), maximum=15_000, min_delinquent=15,
                        limits=(500, 1_000, 1_500, 2_500, 5_000, 7_500, 10_000, 12_000, 15_000)),
    "Co-Brand Card": dict(prefix="RC", series=4, typical=(100, 20_000), maximum=35_000, min_delinquent=25,
                          limits=(1_500, 2_500, 5_000, 7_500, 10_000, 12_000, 15_000, 20_000, 25_000, 35_000, 40_000)),
}
DEFAULT_PRODUCT = "Consumer Credit Card"
LIMIT_WEIGHTS = (16, 20, 20, 14, 10, 8, 6, 4, 2, 1, 1)

# Delinquent amount as a share of the total balance, by days past due, read off
# the workbook's sample accounts: about 5% at 30 days, 15% at 60, 25% at 90,
# 40% at 120 and 70% at 160.
DELINQUENT_CURVE = ((0, 0.02), (30, 0.05), (60, 0.15), (90, 0.25), (120, 0.40), (160, 0.70), (180, 0.75))

# The workbook's collections accounts:
# account ID, card business, total balance, delinquent amount, days past due, credit limit.
COLLECTIONS_SAMPLE = [
    ("CC10001", "Consumer Credit Card", 2_450, 125, 30, 5_000),
    ("CC10002", "Consumer Credit Card", 7_825, 950, 60, 10_000),
    ("CC10003", "Consumer Credit Card", 18_300, 3_200, 90, 25_000),
    ("CC10004", "Consumer Credit Card", 12_400, 4_960, 120, 15_000),
    ("CC10005", "Consumer Credit Card", 9_500, 6_650, 160, 12_000),
    ("SB20001", "Small Business Card", 12_500, 625, 30, 25_000),
    ("SB20002", "Small Business Card", 34_850, 5_228, 60, 50_000),
    ("SB20003", "Small Business Card", 58_200, 14_550, 90, 75_000),
    ("SB20004", "Small Business Card", 78_250, 31_300, 120, 100_000),
    ("SB20005", "Small Business Card", 94_500, 66_150, 160, 120_000),
    ("RP30001", "Retail Card", 850, 43, 30, 1_500),
    ("RP30002", "Retail Card", 2_450, 490, 60, 5_000),
    ("RP30003", "Retail Card", 6_200, 1_550, 90, 10_000),
    ("RP30004", "Retail Card", 9_500, 3_800, 120, 12_000),
    ("RP30005", "Retail Card", 12_500, 8_750, 160, 15_000),
    ("RC40001", "Co-Brand Card", 2_350, 118, 30, 5_000),
    ("RC40002", "Co-Brand Card", 8_450, 1_268, 60, 12_000),
    ("RC40003", "Co-Brand Card", 18_250, 4_563, 90, 25_000),
    ("RC40004", "Co-Brand Card", 27_500, 11_000, 120, 35_000),
    ("RC40005", "Co-Brand Card", 32_000, 22_400, 170, 40_000),
]

# The workbook's recovery accounts:
# account ID, card business, charge-off balance, amount recovered, recovery status.
# Current recovery balance and recovery rate follow from these two amounts.
RECOVERY_SAMPLE = [
    ("REC10001", "Consumer Credit Card", 10_000, 2_500, "Payment Plan"),
    ("REC10002", "Consumer Credit Card", 15_000, 9_000, "Partial Recovery"),
    ("REC10003", "Consumer Credit Card", 20_000, 0, "Active Collections"),
    ("REC10004", "Consumer Credit Card", 12_500, 12_500, "Paid in Full"),
    ("REC10005", "Consumer Credit Card", 8_000, 4_000, "Settlement Agreement"),
    ("REC20001", "Small Business Card", 50_000, 10_000, "Payment Plan"),
    ("REC20002", "Small Business Card", 75_000, 30_000, "Partial Recovery"),
    ("REC20003", "Small Business Card", 90_000, 0, "Active Collections"),
    ("REC20004", "Small Business Card", 120_000, 84_000, "Settlement Agreement"),
    ("REC20005", "Small Business Card", 100_000, 100_000, "Paid in Full"),
    ("REC30001", "Retail Card", 5_000, 1_000, "Payment Plan"),
    ("REC30002", "Retail Card", 8_000, 4_000, "Partial Recovery"),
    ("REC30003", "Retail Card", 12_000, 0, "Active Collections"),
    ("REC30004", "Retail Card", 10_000, 8_000, "Settlement Agreement"),
    ("REC30005", "Retail Card", 15_000, 15_000, "Paid in Full"),
    ("REC40001", "Co-Brand Card", 12_000, 3_000, "Payment Plan"),
    ("REC40002", "Co-Brand Card", 18_000, 9_000, "Partial Recovery"),
    ("REC40003", "Co-Brand Card", 30_000, 0, "Active Collections"),
    ("REC40004", "Co-Brand Card", 35_000, 24_500, "Settlement Agreement"),
    ("REC40005", "Co-Brand Card", 25_000, 25_000, "Paid in Full"),
]

# Fictional small businesses that hold small business cards.
SMALL_BUSINESSES = ["Harbour Line Logistics", "Cedar & Pine Interiors", "Northfield Dental Group",
                    "Brightway Print Co.", "Summit Peak Outfitters", "Riverbend Bakery", "Ironclad Auto Repair",
                    "Bluefin Seafood Supply", "Maple Row Veterinary", "Granite Ridge Builders"]


def terms(product: str | None) -> dict:
    return TERMS.get(product or DEFAULT_PRODUCT, TERMS[DEFAULT_PRODUCT])


def account_id(product: str | None, seq: int, recovery: bool = False) -> str:
    """CC10001 for the first consumer card account; REC10001 in recovery."""
    t = terms(product)
    return f"{'REC' if recovery else t['prefix']}{t['series'] * 10_000 + seq}"


def sequence(account: str | None) -> int:
    """The running number inside a business's series: CC10027 -> 27."""
    digits = "".join(ch for ch in (account or "") if ch.isdigit())
    return int(digits) % 10_000 if len(digits) == 5 else 0


def assign_account_numbers(db, customers) -> None:
    """Give accounts without an ID the next numbers in their business's series,
    after every number already stored or already given in this batch."""
    from .models import Customer
    seqs = {p: 0 for p in TERMS}
    stored = db.query(Customer.product, Customer.account_number).filter(Customer.account_number.isnot(None))
    for product, acct in [*stored, *((c.product, c.account_number) for c in customers if c.account_number)]:
        p = product or DEFAULT_PRODUCT
        if acct.startswith(terms(p)["prefix"]):
            seqs[p] = max(seqs.get(p, 0), sequence(acct))
    for c in customers:
        if not c.account_number:
            p = c.product or DEFAULT_PRODUCT
            seqs[p] = seqs.get(p, 0) + 1
            c.account_number = account_id(p, seqs[p])


def limit_and_balance(product: str | None, utilization: float, rng: random.Random) -> tuple[float, float]:
    """A credit limit the business issues and a total balance inside its range."""
    t = terms(product)
    limit = rng.choices(t["limits"], LIMIT_WEIGHTS[:len(t["limits"])])[0]
    balance = min(max(round(limit * utilization), t["typical"][0]), t["maximum"])
    return float(limit), float(balance)


def delinquent_share(days_past_due: int) -> float:
    d = max(0, days_past_due)
    for (d0, s0), (d1, s1) in zip(DELINQUENT_CURVE, DELINQUENT_CURVE[1:]):
        if d <= d1:
            return s0 + (s1 - s0) * (d - d0) / (d1 - d0)
    return DELINQUENT_CURVE[-1][1]


def delinquent_amount(product: str | None, balance: float, days_past_due: int, spread: float = 1.0) -> float:
    """What the account is behind by: a share of the balance that grows with
    days past due, never under the business's smallest delinquent amount and
    never over the balance."""
    amount = max(terms(product)["min_delinquent"], round(balance * delinquent_share(days_past_due) * spread))
    return float(min(amount, round(balance)))
