"""Check payment outcomes reported by Nova, on a throwaway database:

  * two partial payments add up, and the outcome carries their total
  * the same payment_id reported twice is counted once
  * a reversal with a payment_id removes only that payment
  * a payment outside the evaluation window is held but not counted
  * a report without a payment_id still replaces the previous one (as before)
  * the same holds for accounts the Propensity Router kept off strategies

    cd backend
    .venv/Scripts/python.exe tests/verify_payments.py      (Windows)
    .venv/bin/python tests/verify_payments.py              (macOS / Linux)

Exits non-zero if any check fails.
"""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import date, datetime, timedelta

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TMP = tempfile.mkdtemp(prefix="ari-payments-")
os.environ["DATABASE_URL"] = os.environ.get("ARI_TEST_DATABASE_URL") or f"sqlite:///{os.path.join(TMP, 'payments.db')}"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from app.console import nova  # noqa: E402
from app.console.contract import NovaAccount  # noqa: E402
from app.console.models import Outcome, PaymentRecord, PlatformConfig  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


def account(i: int, **over) -> NovaAccount:
    base = {"account_id": f"NOVA-PAY-{i}", "days_past_due": 31, "current_balance": 4180, "credit_limit": 5000,
            "amount_past_due": 300, "opened_date": "2019-03-01", "prior_delinquencies_12m": 1,
            "on_time_payment_ratio": 0.94, "risk_segment": "Medium", "app_user": True, "sms_responsive": True,
            "hardship_flag": True, "consent": {"sms": True, "email": True, "call": True}, "contacts_last_7d": 0}
    return NovaAccount.model_validate({**base, **over})


def report(db, **kw) -> dict:
    return nova.report_outcome(db, nova.PaymentReport(**kw))


with TestClient(app):
    db = SessionLocal()
    db.get(PlatformConfig, "router_validation_share").value = "0"
    db.commit()

    # A decided account in a strategy (treated or control: both take payments).
    dec = None
    for i in range(40):
        r = nova.recovery_strategy(db, account(i))
        if r.get("decision_id") and r["action"] in ("contact", "control_bau", "awaiting_approval"):
            dec = r
            break
    check(dec is not None, f"a decision to report against ({dec and dec['decision_id']}, {dec and dec['action']})")
    did = dec["decision_id"]
    day0 = datetime.fromisoformat(dec["decided_at"]).date() if dec.get("decided_at") else date.today()

    print("\n1. Partial payments add up")
    a = report(db, decision_id=did, paid=True, amount=150, payment_date=day0 + timedelta(days=2), payment_id="PAY-1")
    check(a["paid"] and a["amount"] == 150, f"first payment: ${a['amount']}")
    b = report(db, decision_id=did, paid=True, amount=150, payment_date=day0 + timedelta(days=4), payment_id="PAY-2")
    check(b["amount"] == 300, f"second payment adds to it: ${b['amount']}")
    o = db.query(Outcome).filter_by(decision_id=did).one()
    check(o.amount == 300 and o.days_to_pay == 2, f"the outcome holds the total and the first day paid "
                                                   f"(${o.amount}, day {o.days_to_pay})")
    check(b["payments"]["payments"] == 2 and "2 posted" in b["note"], "the answer lists both payments")

    print("\n2. The same payment twice counts once")
    c = report(db, decision_id=did, paid=True, amount=150, payment_date=day0 + timedelta(days=4), payment_id="PAY-2")
    check(c["duplicate"] and c["amount"] == 300, f"repeat of PAY-2 is a duplicate; total stays ${c['amount']}")
    check(db.query(PaymentRecord).filter_by(subject=did).count() == 2, "two payment records held, not three")

    print("\n3. A reversal removes only that payment")
    d = report(db, decision_id=did, paid=True, amount=150, payment_status="Reversed", payment_id="PAY-1")
    check(d["paid"] and d["amount"] == 150, f"PAY-1 reversed: ${d['amount']} remains, still paid")
    o = db.query(Outcome).filter_by(decision_id=did).one()
    check(o.days_to_pay == 4, f"days to pay moves to the remaining payment (day {o.days_to_pay})")
    e = report(db, decision_id=did, paid=True, amount=150, payment_status="Reversed", payment_id="PAY-2")
    check(not e["paid"] and e["amount"] == 0, "both reversed: not paid")

    print("\n4. A late payment is held but not counted")
    window = dec.get("evaluation_days") or 7
    f = report(db, decision_id=did, paid=True, amount=300, payment_date=day0 + timedelta(days=window + 5),
               payment_id="PAY-3")
    check(not f["paid"] and f["payments"]["late"] == 1, "paid after the window: recorded, counted as not paid")

    print("\n5. Without a payment_id a report replaces the last one, as before")
    dec2 = None
    for i in range(40, 80):
        r = nova.recovery_strategy(db, account(i))
        if r.get("decision_id") and r["action"] in ("contact", "control_bau", "awaiting_approval"):
            dec2 = r
            break
    d2 = dec2["decision_id"]
    g = report(db, decision_id=d2, paid=True, amount=120)
    h = report(db, decision_id=d2, paid=True, amount=200)
    check(h["amount"] == 200 and h["corrected"], f"the second report corrects the first (${h['amount']}, not $320)")
    i_ = report(db, decision_id=d2, paid=True, payment_status="Reversed")
    check(not i_["paid"], "a reversal without an id cancels the report")
    check(g["paid"], "the first report counted when it arrived")

    print("\n6. Accounts kept off strategies add up the same way")
    routed, acc = None, None
    for i in range(80, 140):
        r = nova.recovery_strategy(db, account(i, hardship_flag=False, app_user=False, sms_responsive=False,
                                               prior_delinquencies_12m=0, on_time_payment_ratio=0.98,
                                               opened_date="2012-01-01"))
        if not r.get("decision_id"):
            routed, acc = r, f"NOVA-PAY-{i}"
            break
    check(routed is not None, f"an account the router kept on business as usual ({routed and routed['action']})")
    j = report(db, account_id=acc, paid=True, amount=100, payment_id="BAU-1")
    k = report(db, account_id=acc, paid=True, amount=80, payment_id="BAU-2")
    check(j["paid"] and k["routing"] is not None and k["payments"]["amount"] == 180,
          f"two payments on a routed-away account add up (${k['payments']['amount']})")
    db.close()

print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}")
sys.exit(1 if failures else 0)
