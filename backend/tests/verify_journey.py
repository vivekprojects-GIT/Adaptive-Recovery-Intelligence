"""Check the customer journey's strategy flow through the real API, on a
throwaway database: decision, contact, outcome, reward and how the reward moved
the treatment's score.

    cd backend
    .venv/Scripts/python.exe tests/verify_journey.py      (Windows)
    .venv/bin/python tests/verify_journey.py              (macOS / Linux)

Exits non-zero if any check fails.
"""
from __future__ import annotations

import os
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TMP = tempfile.mkdtemp(prefix="ari-journey-")
# ARI_TEST_DATABASE_URL runs the suite against another database (an empty Postgres, say).
os.environ["DATABASE_URL"] = os.environ.get("ARI_TEST_DATABASE_URL") or f"sqlite:///{os.path.join(TMP, 'journey.db')}"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from app.console.models import Campaign, Decision, Outcome  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402

RAVI = {"X-User-Id": "u-ravi"}
failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


def flow_for(api, customer_id: int, decision_id: str) -> dict:
    j = api.get(f"/console/customers/{customer_id}/journey", headers=RAVI).json()
    return next(f for f in j["flows"] if f["decision_id"] == decision_id), j


with TestClient(app) as api:
    with SessionLocal() as db:
        learned = (db.query(Decision, Outcome).join(Outcome, Outcome.decision_id == Decision.decision_id)
                   .filter(Outcome.learned.is_(True)).order_by(Outcome.outcome_id).all())
        paid = next((d, o) for d, o in learned if o.paid)
        unpaid = next((d, o) for d, o in learned if not o.paid)
        control = (db.query(Decision).join(Outcome, Outcome.decision_id == Decision.decision_id)
                   .filter(Decision.group == "Control").first())
        # The last learned outcome of a live strategy: after it, nothing else has counted.
        live = {c.campaign_id for c in db.query(Campaign).filter(Campaign.status == "Live")}
        last = next((d, o) for d, o in reversed(learned) if d.campaign_id in live)
        pairs = [(d.decision_id, d.customer_id) for d, _ in (paid, unpaid, last)]
        control_ids = (control.decision_id, control.customer_id)

    print("\n1. A payment raises the treatment's score")
    f, j = flow_for(api, pairs[0][1], pairs[0][0])
    lr = f["learning"]
    check(f["outcome"]["state"] == "paid" and f["outcome"]["amount"] > 0, f"{f['decision_id']}: paid ${f['outcome']['amount']}")
    check(lr["state"] == "learned" and lr["reward"] == 1, "reward 1 is recorded as learned")
    check(lr["after"]["mean"] > lr["before"]["mean"],
          f"estimated payment rate rises: {lr['before']['mean']:.3f} -> {lr['after']['mean']:.3f}")
    check(lr["after"]["learned"] == lr["before"]["learned"] + 1, "the result counts once")
    check(f["why"] and f["why"]["score"] > 0 and f["why"]["allowed"] >= 1, "the decision shows the score that chose it")
    check(any(e["kind"] == "learning" and e.get("decision_id") == f["decision_id"] for e in j["events"]),
          "the timeline has the learning update")

    print("\n2. No payment lowers it")
    f, _ = flow_for(api, pairs[1][1], pairs[1][0])
    lr = f["learning"]
    check(f["outcome"]["state"] == "not_paid" and lr["reward"] == 0, f"{f['decision_id']}: no payment, reward 0")
    check(lr["after"]["mean"] < lr["before"]["mean"],
          f"estimated payment rate falls: {lr['before']['mean']:.3f} -> {lr['after']['mean']:.3f}")

    print("\n3. Step by step adds up to the strategy's current score")
    f, _ = flow_for(api, pairs[2][1], pairs[2][0])
    lr = f["learning"]
    check(abs(lr["after"]["mean"] - lr["now"]["mean"]) < 1e-3 and lr["after"]["learned"] == lr["now"]["learned"],
          f"{f['campaign_id']}'s last result leaves {lr['name']} at its current score "
          f"({lr['after']['mean']:.4f} = {lr['now']['mean']:.4f}, {lr['now']['learned']} results)")

    print("\n4. Control customers never change the scores")
    f, _ = flow_for(api, control_ids[1], control_ids[0])
    check(f["group"] == "Control" and f["learning"]["state"] == "control" and f["why"] is None,
          f"{f['decision_id']}: control group, not learned from")

print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}. Database: {TMP}")
sys.exit(1 if failures else 0)
