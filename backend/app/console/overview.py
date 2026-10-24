"""The one dashboard: collections and recovery together, sliced by card
business, process, period and strategy owner. Every number is computed from
the decision log, the recovery ledger and the customer book on request.

  Slicers   product (card business), process (collections | recovery | all),
            period (days, for flows: money in, payment rate), mine (only the
            strategies the signed-in strategist owns)
  Stocks    accounts and balances as they stand now, compared with the same
            stock one period ago
  Trends    twelve weekly points behind every headline figure
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from .. import models
from ..seed import PRODUCTS
from .engine import arrears
from .models import Campaign, Decision, Outcome, Placement, RecoveryAccount, RecoveryPayment

UTC = timezone.utc
WEEKS = 12
MIN_WEEK = 10   # a weekly payment rate on fewer treated accounts is not shown
ROUTES = [("strategy", "In ARI strategies"), ("bau", "Business as usual"), ("hardship", "Hardship team"),
          ("suppress", "Do not contact")]


def _iso(d: datetime) -> str:
    return d.isoformat(timespec="seconds")


def _week_starts(now: datetime) -> list[datetime]:
    monday = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return [monday - timedelta(weeks=WEEKS - 1 - i) for i in range(WEEKS)]


def _bucket(ts: str, starts: list[datetime]) -> int | None:
    t = datetime.fromisoformat(ts)
    if t < starts[0]:
        return None
    for i in range(len(starts) - 1, -1, -1):
        if t >= starts[i]:
            return i
    return None


def _rate(paid: int, n: int) -> float | None:
    return round(paid / n, 4) if n else None


def _delta(cur: float | None, prev: float | None) -> float | None:
    if cur is None or not prev:
        return None
    return round((cur - prev) / prev, 4)


def dashboard(db: Session, user, product: str | None, process: str, period: int, mine: bool) -> dict:
    now = datetime.now(UTC)
    now_s = _iso(now)
    since, before = _iso(now - timedelta(days=period)), _iso(now - timedelta(days=2 * period))
    starts = _week_starts(now)
    show_c, show_r = process in ("all", "collections"), process in ("all", "recovery")

    # ---- collections book ------------------------------------------------------
    cq = db.query(models.Customer)
    if product:
        cq = cq.filter(models.Customer.product == product)
    customers = {c.customer_id: c for c in cq}
    camps = db.query(Campaign)
    if mine:
        camps = camps.filter(Campaign.owner_id == user.user_id)
    camps = {c.campaign_id: c for c in camps}
    decs = [d for d in db.query(Decision).filter(Decision.campaign_id.in_(list(camps)), Decision.validation.is_(False))
            if d.customer_id in customers]
    outs = {o.decision_id: o for o in db.query(Outcome).filter(Outcome.decision_id.in_([d.decision_id for d in decs]))}
    seen = [(d, outs.get(d.decision_id)) for d in decs]
    seen = [(d, o) for d, o in seen if o is not None and o.observed_at <= now_s]

    def money_in(lo: str, hi: str) -> float:
        return round(sum(o.amount for _, o in seen if o.paid and lo < o.observed_at <= hi), 2)

    def rates(lo: str, hi: str) -> tuple[float | None, float | None, int]:
        t = [(d, o) for d, o in seen if lo < d.decided_at <= hi and d.group == "Treatment"]
        c = [(d, o) for d, o in seen if lo < d.decided_at <= hi and d.group == "Control"]
        return _rate(sum(o.paid for _, o in t), len(t)), _rate(sum(o.paid for _, o in c), len(c)), len(t)

    collected, collected_prev = money_in(since, now_s), money_in(before, since)
    # A change is only meaningful when the prior period is fully inside the history.
    first = min((d.decided_at for d in decs), default=None)
    full_prior = first is not None and first <= before
    t_rate, c_rate, treated = rates(since, now_s)
    t_prev, _, _ = rates(before, since)
    w_cash_c, w_treat, w_ctrl, w_decided = [0.0] * WEEKS, [[0, 0] for _ in range(WEEKS)], [[0, 0] for _ in range(WEEKS)], [0] * WEEKS
    for d, o in seen:
        if o.paid:
            b = _bucket(o.observed_at, starts)
            if b is not None:
                w_cash_c[b] += o.amount
        b = _bucket(d.decided_at, starts)
        if b is not None:
            box = w_treat if d.group == "Treatment" else w_ctrl if d.group == "Control" else None
            if box is not None:
                box[b][0] += int(o.paid)
                box[b][1] += 1
    for d in decs:
        b = _bucket(d.decided_at, starts)
        if b is not None:
            w_decided[b] += 1
    in_strategy = {d.customer_id for d in decs}

    # ---- recovery book ----------------------------------------------------------
    rq = db.query(RecoveryAccount)
    if product:
        rq = rq.filter(RecoveryAccount.product == product)
    raccts = rq.all()
    rids = {a.recovery_id for a in raccts}
    pays = [p for p in db.query(RecoveryPayment) if p.recovery_id in rids]

    def remaining_at(ts: str) -> float:
        paid: dict[int, float] = defaultdict(float)
        for p in pays:
            if p.paid_at <= ts:
                paid[p.recovery_id] += p.amount
        return round(sum(max(0.0, a.charge_off_balance - paid[a.recovery_id]) for a in raccts if a.created_at <= ts), 2)

    recovered = round(sum(p.amount for p in pays if since < p.paid_at <= now_s), 2)
    recovered_prev = round(sum(p.amount for p in pays if before < p.paid_at <= since), 2)
    charged_now = sum(1 for a in raccts if a.created_at <= now_s)
    charged_prev = sum(1 for a in raccts if a.created_at <= since)
    remaining_now = round(sum(0.0 if a.status in ("Settled", "Paid in Full") else max(0.0, a.charge_off_balance - a.recovered)
                              for a in raccts), 2)
    w_cash_r, w_new_co = [0.0] * WEEKS, [0] * WEEKS
    for p in pays:
        b = _bucket(p.paid_at, starts)
        if b is not None:
            w_cash_r[b] += p.amount
    for a in raccts:
        b = _bucket(a.created_at, starts)
        if b is not None:
            w_new_co[b] += 1
    w_remaining = [remaining_at(_iso(s + timedelta(days=7))) for s in starts]

    # ---- composition ----------------------------------------------------------
    route = Counter(c.route for c in customers.values())
    placed = {p.customer_id for p in db.query(Placement).filter(Placement.status == "Placed")} & set(customers)
    stages = [{"stage": label, "accounts": route.get(key, 0), "process": "collections"} for key, label in ROUTES]
    stages.append({"stage": "With collection agencies", "accounts": len(placed), "process": "collections"})
    stages.append({"stage": "Charged off, in recovery", "accounts": sum(a.status not in ("Settled", "Paid in Full")
                                                                          for a in raccts), "process": "recovery"})
    status = Counter(a.status for a in raccts)

    businesses = []
    for b in ([product] if product else PRODUCTS):
        cs = [c for c in customers.values() if c.product == b]
        ids = {c.customer_id for c in cs}
        ra = [a for a in raccts if a.product == b]
        rset = {a.recovery_id for a in ra}
        businesses.append({
            "business": b, "collections_accounts": len(cs), "collections_balance": round(sum(c.balance for c in cs), 2),
            "past_due": round(sum(arrears(c) for c in cs), 2),
            "collected": round(sum(o.amount for d, o in seen if o.paid and d.customer_id in ids
                                   and since < o.observed_at <= now_s), 2),
            "charged_off_accounts": len(ra),
            "recovered": round(sum(p.amount for p in pays if p.recovery_id in rset and since < p.paid_at <= now_s), 2),
            "remaining": round(sum(0.0 if a.status in ("Settled", "Paid in Full") else max(0.0, a.charge_off_balance - a.recovered)
                                   for a in ra), 2)})

    strategies = []
    for cid, c in sorted(camps.items()):
        mine_rows = [(d, o) for d, o in seen if d.campaign_id == cid]
        t = [(d, o) for d, o in mine_rows if d.group == "Treatment"]
        k = [(d, o) for d, o in mine_rows if d.group == "Control"]
        tr, cr = _rate(sum(o.paid for _, o in t), len(t)), _rate(sum(o.paid for _, o in k), len(k))
        if not t and c.status not in ("Live", "Paused"):
            continue
        gap = round(tr - c.recovery_target, 4) if tr is not None else None
        strategies.append({"campaign_id": cid, "name": c.name, "status": c.status, "treated": len(t),
                           "payment_rate": tr, "control_rate": cr,
                           "lift": round(tr - cr, 4) if tr is not None and cr is not None else None,
                           "target": c.recovery_target, "deviation": gap,
                           "collected": round(sum(o.amount for _, o in t if o.paid), 2),
                           "state": None if gap is None else "on_track" if gap >= 0 else "watch" if gap >= -0.05 else "off_track"})

    # ---- account flow: book -> route or recovery status -> outcome ----------------
    nodes: dict[str, dict] = {}
    links: list[dict] = []

    def link(src: tuple[str, str, str], dst: tuple[str, str, str], value: int) -> None:
        if value <= 0:
            return
        for nid, label, proc in (src, dst):
            nodes.setdefault(nid, {"id": nid, "label": label, "process": proc})
        links.append({"source": src[0], "target": dst[0], "value": value})

    if show_c:
        book = ("c_book", "Collections book", "collections")
        for key, label in ROUTES:
            link(book, (f"route_{key}", label, "collections"), route.get(key, 0))
        latest: dict[int, Decision] = {}
        for d in decs:
            if d.customer_id not in latest or d.decided_at > latest[d.customer_id].decided_at:
                latest[d.customer_id] = d
        paid = unpaid = waiting = 0
        for cid_, d in latest.items():
            if customers[cid_].route != "strategy":
                continue
            o = outs.get(d.decision_id)
            if o is None or o.observed_at > now_s:
                waiting += 1
            elif o.paid:
                paid += 1
            else:
                unpaid += 1
        undecided = max(0, route.get("strategy", 0) - paid - unpaid - waiting)
        src = ("route_strategy", "In ARI strategies", "collections")
        link(src, ("out_paid", "Paid", "outcome"), paid)
        link(src, ("out_unpaid", "Not paid in window", "outcome"), unpaid)
        link(src, ("out_waiting", "Awaiting outcome", "outcome"), waiting)
        link(src, ("out_undecided", "Not yet decided", "outcome"), undecided)
    if show_r:
        book = ("r_book", "Charged-off book", "recovery")
        for st, n in status.most_common():
            link(book, (f"status_{st}", st, "recovery"), n)

    # ---- weekly cash by card business ------------------------------------------------
    heat = []
    for b in ([product] if product else PRODUCTS):
        ids = {c.customer_id for c in customers.values() if c.product == b}
        rset = {a.recovery_id for a in raccts if a.product == b}
        wc, wr = [0.0] * WEEKS, [0.0] * WEEKS
        for d, o in seen:
            if o.paid and d.customer_id in ids:
                i = _bucket(o.observed_at, starts)
                if i is not None:
                    wc[i] += o.amount
        for p in pays:
            if p.recovery_id in rset:
                i = _bucket(p.paid_at, starts)
                if i is not None:
                    wr[i] += p.amount
        heat.append({"business": b, "collected": [round(x, 2) for x in wc], "recovered": [round(x, 2) for x in wr]})

    return {
        "flow": {"nodes": list(nodes.values()), "links": links},
        "heatmap": heat,
        "filters": {"product": product, "process": process, "period": period, "mine": mine, "businesses": PRODUCTS},
        "weeks": [s.date().isoformat() for s in starts],
        "kpis": {
            "collections_accounts": {"value": len(customers), "sub": len(in_strategy), "trend": w_decided} if show_c else None,
            "collected": {"value": collected, "delta": _delta(collected, collected_prev) if full_prior else None,
                          "trend": [round(x, 2) for x in w_cash_c]} if show_c else None,
            "payment_rate": {"value": t_rate, "control": c_rate, "lift": round(t_rate - c_rate, 4)
                             if t_rate is not None and c_rate is not None else None, "treated": treated,
                             "delta": round(t_rate - t_prev, 4) if full_prior and t_rate is not None and t_prev is not None else None,
                             "trend": [_rate(p, n) if n >= MIN_WEEK else None for p, n in w_treat]} if show_c else None,
            "charged_off": {"value": charged_now, "delta": _delta(charged_now, charged_prev), "trend": w_new_co} if show_r else None,
            "recovered": {"value": recovered, "delta": _delta(recovered, recovered_prev),
                          "trend": [round(x, 2) for x in w_cash_r]} if show_r else None,
            "remaining": {"value": remaining_now, "delta": _delta(remaining_now, remaining_at(since)),
                          "trend": w_remaining} if show_r else None,
        },
        "cash_by_week": [{"week": starts[i].date().isoformat(),
                          "collections": round(w_cash_c[i], 2) if show_c else None,
                          "recovery": round(w_cash_r[i], 2) if show_r else None} for i in range(WEEKS)],
        "rate_by_week": [{"week": starts[i].date().isoformat(),
                          "treated": _rate(*w_treat[i]) if w_treat[i][1] >= MIN_WEEK else None,
                          "control": _rate(*w_ctrl[i]) if w_ctrl[i][1] >= 3 else None}
                         for i in range(WEEKS)] if show_c else [],
        "stages": [s for s in stages if (s["process"] == "collections" and show_c) or (s["process"] == "recovery" and show_r)],
        "recovery_status": [{"status": k, "accounts": v} for k, v in status.most_common()] if show_r else [],
        "businesses": businesses,
        "strategies": strategies if show_c else [],
    }
