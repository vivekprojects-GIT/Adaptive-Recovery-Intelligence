"""Outsourced collections: the bank's agency panel, placements and their results.

Late-stage accounts that ARI's own treatments have not recovered can be
placed with an external collection agency. ARI matches the account to an
agency on the panel and proposes the placement; a person always approves it.
Once placed, ARI stops contacting the account (the agency now owns contact)
until it is recovered, returned at the end of the placement, or recalled.

Agencies are paid a contingency fee on what they recover, so the measure that
matters is net recovery: dollars recovered minus the fee, over dollars placed.
"""
from __future__ import annotations

import json
import random
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models
from .models import Agency, Decision, Outcome, Placement, Routing, User
from .platform import audit, customer_ref, now

UTC = timezone.utc
OPEN = ("Proposed", "Placed")

# Fictional panel. Fees are contingency rates on recoveries.
PANEL = [
    dict(agency_id="AGY-01", name="Harbor Point Recovery", fee_rate=0.22,
         products=["Consumer Credit Card", "Co-brand Card"], min_dpd=90, capacity=120, placement_days=90,
         contract_ref="MSA-2025-114"),
    dict(agency_id="AGY-02", name="Summit Ridge Collections", fee_rate=0.18,
         products=["Retail Card", "Consumer Credit Card"], min_dpd=90, capacity=80, placement_days=120,
         contract_ref="MSA-2025-131"),
    dict(agency_id="AGY-03", name="Lakeshore Commercial Recovery", fee_rate=0.25,
         products=["Small Business Card"], min_dpd=60, capacity=40, placement_days=120,
         contract_ref="MSA-2026-007"),
]

# Matching prior: a 15% net recovery, worth $25,000 of placed balances.
PRIOR_NET, PRIOR_DOLLARS = 0.15, 25_000.0

# How well each agency recovers in the seeded history (share of placed dollars).
_TRUE_RATE = {"AGY-01": 0.17, "AGY-02": 0.26, "AGY-03": 0.13}

POLICY = ("An account can be placed when it is at least the agency's minimum days past due, has no hardship "
          "on file, has not paid in the last 30 days, and is not already with an agency. ARI proposes; a person "
          "approves every placement, and nobody approves a placement they proposed.")


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def _next_id(db: Session) -> str:
    n = db.query(func.count(Placement.placement_id)).scalar() or 0
    return f"PLC-{n + 1:04d}"


def open_customer_ids(db: Session) -> set[int]:
    """Accounts proposed to or held by an agency. ARI does not treat them."""
    return {cid for (cid,) in db.query(Placement.customer_id).filter(Placement.status.in_(OPEN))}


def _paid_recently(db: Session, customer_id: int, at: datetime) -> bool:
    since, until = _iso(at - timedelta(days=30)), _iso(at)
    if db.query(Outcome).filter(Outcome.customer_id == customer_id, Outcome.paid.is_(True),
                                Outcome.observed_at >= since, Outcome.observed_at <= until).count():
        return True
    return db.query(Routing).filter(Routing.customer_id == customer_id, Routing.paid.is_(True),
                                    Routing.observed_at >= since, Routing.observed_at <= until).count() > 0


def eligibility(db: Session, c, at: datetime | None = None, held: set[int] | None = None) -> tuple[bool, str]:
    at = at or datetime.now(UTC)
    held = open_customer_ids(db) if held is None else held
    if c.customer_id in held:
        return False, "Already with an agency or waiting for approval"
    if c.hardship_flag:
        return False, "Hardship on file: stays with the bank's hardship team"
    floor = min((a.min_dpd for a in db.query(Agency).filter_by(status="Active")
                 if (c.product or "Consumer Credit Card") in json.loads(a.products)), default=None)
    if floor is None:
        return False, f"No agency on the panel takes {c.product or 'Consumer Credit Card'} accounts"
    if c.days_past_due < floor:
        return False, f"{c.days_past_due} days past due; placement starts at {floor}"
    if _paid_recently(db, c.customer_id, at):
        return False, "Paid in the last 30 days"
    return True, "Eligible for placement"


def _results(db: Session) -> dict[str, dict]:
    """Closed-placement net recovery by agency, the basis for matching."""
    out: dict[str, dict] = defaultdict(lambda: {"amount": 0.0, "net": 0.0})
    for p in db.query(Placement).filter(Placement.status.in_(["Recovered", "Returned", "Placed"])):
        out[p.agency_id]["amount"] += p.amount
        out[p.agency_id]["net"] += p.recovered - p.fee
    return out


def match(db: Session, c) -> tuple[Agency | None, str]:
    """The agency for this account: contracted for the product, open capacity,
    best net recovery so far; the lower fee breaks a tie."""
    product = c.product or "Consumer Credit Card"
    load = dict(db.query(Placement.agency_id, func.count()).filter(Placement.status.in_(OPEN))
                .group_by(Placement.agency_id).all())
    res = _results(db)
    options = []
    for a in db.query(Agency).filter_by(status="Active"):
        products = json.loads(a.products)
        if product not in products or c.days_past_due < a.min_dpd:
            continue
        if load.get(a.agency_id, 0) >= a.capacity:
            continue
        r = res.get(a.agency_id) or {"net": 0.0, "amount": 0.0}
        # Net recovery so far, pulled toward a panel norm until enough has been
        # placed to judge, so a new agency is not starved of accounts.
        net = (r["net"] + PRIOR_NET * PRIOR_DOLLARS) / (r["amount"] + PRIOR_DOLLARS)
        score = net - 0.05 * load.get(a.agency_id, 0) / a.capacity
        options.append((products.index(product) < 2, score, -a.fee_rate, net, a))
    if not options:
        return None, f"No agency on the panel has capacity for {product} accounts"
    options.sort(key=lambda x: x[:3], reverse=True)
    specialist, _, _, net, a = options[0]
    why = (f"{a.name} {'specialises in' if specialist else 'is contracted for'} {product} accounts, with an "
           f"expected net recovery of {net:.0%} of the balance after its {a.fee_rate:.0%} fee")
    return a, why


def propose(db: Session, c, actor: str, at: datetime | None = None, reason: str = "") -> Placement:
    at = at or datetime.now(UTC)
    ok, why = eligibility(db, c, at)
    if not ok:
        raise ValueError(why)
    agency, match_why = match(db, c)
    if agency is None:
        raise ValueError(match_why)
    p = Placement(placement_id=_next_id(db), customer_id=c.customer_id, agency_id=agency.agency_id,
                  status="Proposed", amount=round(float(c.balance), 2), proposed_by=actor, proposed_at=_iso(at),
                  reason=(reason + " " if reason else "") + match_why + ".")
    db.add(p)
    db.flush()
    audit(db, actor, "CREATE", "placement", p.placement_id,
          f"Proposed {customer_ref(c.customer_id)} for placement with {agency.name}", at=_iso(at))
    return p


def propose_batch(db: Session, actor: str, limit: int = 10, at: datetime | None = None) -> list[Placement]:
    """ARI's scan: eligible late-stage accounts its treatments have not recovered."""
    at = at or datetime.now(UTC)
    held = open_customer_ids(db)
    treated = {cid for (cid,) in db.query(Decision.customer_id)}
    out: list[Placement] = []
    for c in (db.query(models.Customer).filter(models.Customer.days_past_due >= 60)
              .order_by(models.Customer.days_past_due.desc(), models.Customer.customer_id)):
        if len(out) >= limit:
            break
        if not eligibility(db, c, at, held)[0] or match(db, c)[0] is None:
            continue
        note = ("ARI's treatments have not recovered this account." if c.customer_id in treated
                else f"Not in an ARI strategy and still unpaid at {c.days_past_due} days past due.")
        out.append(propose(db, c, actor, at, note))
        held.add(c.customer_id)
    return out


def review(db: Session, placement_id: str, approve: bool, actor: str, note: str = "") -> Placement:
    p = db.get(Placement, placement_id)
    if p is None:
        raise LookupError(f"Placement {placement_id} not found")
    if p.status != "Proposed":
        raise ValueError(f"{placement_id} is {p.status.lower()}, not waiting for approval")
    if approve and p.proposed_by == actor:
        raise PermissionError("You proposed this placement, so someone else must approve it")
    if not approve and not note.strip():
        raise ValueError("Say why the placement is declined")
    at = now()
    p.status = "Placed" if approve else "Declined"
    p.reviewed_by, p.reviewed_at, p.review_note = actor, at, note.strip()
    if approve:
        p.placed_at = at
    agency = db.get(Agency, p.agency_id)
    audit(db, actor, "APPROVE" if approve else "REJECT", "placement", p.placement_id,
          f"{'Approved' if approve else 'Declined'} placement of {customer_ref(p.customer_id)} with {agency.name}"
          + (f": {note.strip()}" if note.strip() else ""))
    return p


def recall(db: Session, placement_id: str, actor: str, note: str) -> Placement:
    p = db.get(Placement, placement_id)
    if p is None:
        raise LookupError(f"Placement {placement_id} not found")
    if p.status != "Placed":
        raise ValueError(f"{placement_id} is {p.status.lower()}; only a placed account can be recalled")
    if not note.strip():
        raise ValueError("Say why the account is recalled")
    p.status, p.closed_at, p.review_note = "Recalled", now(), note.strip()
    audit(db, actor, "UPDATE", "placement", p.placement_id,
          f"Recalled {customer_ref(p.customer_id)} from {db.get(Agency, p.agency_id).name}: {note.strip()}")
    return p


def _row(db: Session, p: Placement, names: dict[str, str], customers: dict[int, models.Customer],
         agencies: dict[str, Agency]) -> dict:
    c = customers.get(p.customer_id)
    return {"placement_id": p.placement_id, "customer_id": p.customer_id, "customer_ref": customer_ref(p.customer_id),
            "customer_name": c.name if c else None, "product": (c.product if c else None) or "Consumer Credit Card",
            "days_past_due": c.days_past_due if c else None, "agency_id": p.agency_id,
            "agency": agencies[p.agency_id].name, "fee_rate": agencies[p.agency_id].fee_rate, "status": p.status,
            "amount": p.amount, "recovered": p.recovered, "fee": p.fee, "net": round(p.recovered - p.fee, 2),
            "reason": p.reason, "proposed_by": names.get(p.proposed_by, "ARI"), "proposed_by_id": p.proposed_by,
            "proposed_at": p.proposed_at, "reviewed_by": names.get(p.reviewed_by or "", None),
            "reviewed_at": p.reviewed_at, "review_note": p.review_note, "placed_at": p.placed_at,
            "closed_at": p.closed_at, "first_payment_days": p.first_payment_days}


def placements(db: Session, status: str | None = None, agency_id: str | None = None) -> list[dict]:
    q = db.query(Placement)
    if status:
        q = q.filter(Placement.status == status)
    if agency_id:
        q = q.filter(Placement.agency_id == agency_id)
    rows = q.order_by(Placement.proposed_at.desc()).all()
    names = {u.user_id: u.name for u in db.query(User)}
    names["system"] = "ARI"
    ids = {p.customer_id for p in rows}
    customers = {c.customer_id: c for c in db.query(models.Customer).filter(models.Customer.customer_id.in_(ids))}
    agencies = {a.agency_id: a for a in db.query(Agency)}
    return [_row(db, p, names, customers, agencies) for p in rows]


def performance(db: Session) -> dict:
    """Per agency: what was placed, what came back, what it cost."""
    rows = db.query(Placement).filter(Placement.status.notin_(["Proposed", "Declined"])).all()
    by: dict[str, list[Placement]] = defaultdict(list)
    for p in rows:
        by[p.agency_id].append(p)
    out = []
    for a in db.query(Agency).order_by(Agency.agency_id):
        mine = by.get(a.agency_id, [])
        placed = sum(p.amount for p in mine)
        recovered = sum(p.recovered for p in mine)
        fees = sum(p.fee for p in mine)
        paying = [p for p in mine if p.recovered > 0]
        days = [p.first_payment_days for p in paying if p.first_payment_days]
        out.append({
            "agency_id": a.agency_id, "name": a.name, "fee_rate": a.fee_rate, "products": json.loads(a.products),
            "min_dpd": a.min_dpd, "capacity": a.capacity, "placement_days": a.placement_days, "status": a.status,
            "contract_ref": a.contract_ref, "audited_at": a.audited_at,
            "placements": len(mine), "open": sum(p.status == "Placed" for p in mine),
            "recovered_in_full": sum(p.status == "Recovered" for p in mine),
            "returned": sum(p.status == "Returned" for p in mine), "recalled": sum(p.status == "Recalled" for p in mine),
            "placed_amount": round(placed, 2), "recovered": round(recovered, 2), "fees": round(fees, 2),
            "net_recovered": round(recovered - fees, 2),
            "liquidation_rate": round(recovered / placed, 4) if placed else None,
            "net_liquidation_rate": round((recovered - fees) / placed, 4) if placed else None,
            "paying_rate": round(len(paying) / len(mine), 4) if mine else None,
            "avg_days_to_first_payment": round(sum(days) / len(days), 1) if days else None,
        })
    tot = {k: round(sum(x[k] for x in out), 2) for k in ("placed_amount", "recovered", "fees", "net_recovered")}
    tot["placements"] = sum(x["placements"] for x in out)
    tot["open"] = sum(x["open"] for x in out)
    tot["pending"] = db.query(Placement).filter(Placement.status == "Proposed").count()
    tot["liquidation_rate"] = round(tot["recovered"] / tot["placed_amount"], 4) if tot["placed_amount"] else None
    tot["net_liquidation_rate"] = (round(tot["net_recovered"] / tot["placed_amount"], 4)
                                   if tot["placed_amount"] else None)
    return {"agencies": out, "totals": tot, "policy": POLICY,
            "formulas": {"liquidation_rate": "Dollars the agency recovered ÷ dollars placed with it",
                         "net_liquidation_rate": "(Dollars recovered − agency fees) ÷ dollars placed",
                         "fees": "Recovered × the agency's contingency fee rate",
                         "paying_rate": "Placements with any payment ÷ placements"}}


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------
def seed_panel(db: Session, at: datetime) -> None:
    for a in PANEL:
        if db.get(Agency, a["agency_id"]) is None:
            db.add(Agency(**{**a, "products": json.dumps(a["products"])}, status="Active",
                          audited_at=_iso(at - timedelta(days=45))))
    db.flush()


def seed_history(db: Session, now_: datetime) -> None:
    """Placements made since the accounts arrived, approved by the leadership
    team, with what each agency has recovered so far. Then a fresh batch from
    ARI's scan, waiting for approval."""
    rng = random.Random(3_303)
    seed_panel(db, now_)
    pool = [c for c in db.query(models.Customer).filter(models.Customer.days_past_due >= 60)
            .order_by(models.Customer.customer_id)]
    rng.shuffle(pool)
    made = 0
    for c in pool:
        if made >= 34:
            break
        at = now_ - timedelta(days=rng.randint(6, 38))
        if not eligibility(db, c, at)[0]:
            continue
        agency, _ = match(db, c)
        if agency is None:
            continue
        p = propose(db, c, "system", at, "ARI's treatments have not recovered this account.")
        p.status, p.reviewed_by, p.reviewed_at, p.placed_at = "Placed", "u-james", _iso(at + timedelta(hours=20)), \
            _iso(at + timedelta(hours=20))
        audit(db, "u-james", "APPROVE", "placement", p.placement_id,
              f"Approved placement of {customer_ref(c.customer_id)} with {agency.name}", at=p.reviewed_at)
        age = (now_ - at).days
        if rng.random() < _TRUE_RATE[agency.agency_id] * 2.4 and age > 6:
            p.first_payment_days = rng.randint(4, age - 1)
            share = 1.0 if rng.random() < 0.15 else round(rng.uniform(0.08, 0.45), 2)
            p.recovered = round(p.amount * share, 2)
            p.fee = round(p.recovered * agency.fee_rate, 2)
            if share == 1.0:
                p.status, p.closed_at = "Recovered", _iso(at + timedelta(days=p.first_payment_days))
        if p.status == "Placed" and age > agency.placement_days:
            p.status, p.closed_at = "Returned", _iso(at + timedelta(days=agency.placement_days))
        made += 1
    db.flush()
    propose_batch(db, "system", limit=6, at=now_ - timedelta(hours=6))
    db.flush()
