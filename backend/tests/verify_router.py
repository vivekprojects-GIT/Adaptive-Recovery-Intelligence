"""Check the Propensity Router and the scorecards through the real API, on a
throwaway database: every customer is routed by fit group, only strategy-routed
customers reach strategies, the validation share is scored but never taught,
a policy change re-routes undecided customers, and the scorecards add up.

    cd backend
    .venv/Scripts/python.exe tests/verify_router.py      (Windows)
    .venv/bin/python tests/verify_router.py              (macOS / Linux)

Exits non-zero if any check fails.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from collections import Counter

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TMP = tempfile.mkdtemp(prefix="ari-router-")
# ARI_TEST_DATABASE_URL runs the suite against another database (an empty Postgres, say).
os.environ["DATABASE_URL"] = os.environ.get("ARI_TEST_DATABASE_URL") or f"sqlite:///{os.path.join(TMP, 'router.db')}"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from app import models  # noqa: E402
from app.console import router  # noqa: E402
from app.console.models import Decision, Outcome, Routing  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402

RAVI, JAMES, PRIYA = {"X-User-Id": "u-ravi"}, {"X-User-Id": "u-james"}, {"X-User-Id": "u-priya"}
failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


with TestClient(app) as api:
    print("\n1. Every customer goes through the router")
    with SessionLocal() as db:
        customers = db.query(models.Customer).all()
        check(all(c.route for c in customers), f"all {len(customers)} customers have a route")
        check(all(c.route == router.ROUTES[c.segment] for c in customers if not c.route_validation),
              "each goes where its fit group is sent: responsive to strategies, self-cure to business as usual, "
              "needs support to the hardship team, do not contact suppressed")
        val = Counter(c.segment for c in customers if c.route_validation)
        check(set(val) <= set(router.VALIDATED) and all(c.route == "strategy" for c in customers if c.route_validation),
              f"the validation share is only self-cure and needs support, sent to strategies ({dict(val)})")
        for g in router.VALIDATED:
            n = sum(1 for c in customers if c.segment == g)
            check(0.01 <= val[g] / n <= 0.10, f"{g}: {val[g]} of {n} in the validation share (set to 5%)")
        check(db.query(Routing).count() == len(customers), "each routing is logged")
        away = db.query(Routing).filter(Routing.route != "strategy").all()
        check(all(r.paid is not None for r in away), "customers kept off strategies have an outcome, to score the router")

    print("\n2. Only strategy-routed customers reach strategies")
    with SessionLocal() as db:
        decided = db.query(Decision).filter(Decision.group.in_(["Treatment", "Control"])).all()
        segs = Counter(json.loads(d.snapshot)["segment"] for d in decided if not d.validation)
        check(set(segs) == {"Persuadable"}, f"every non-validation decision is a Likely responsive customer ({dict(segs)})")
        check(not any(json.loads(d.snapshot)["segment"] == "Sleeping Dog" for d in decided), "Do not contact is never decided")
        vd = [d for d in decided if d.validation]
        check(len(vd) > 0, f"{len(vd)} validation-share decisions were made")
        learned = (db.query(Outcome).join(Decision, Decision.decision_id == Outcome.decision_id)
                   .filter(Decision.validation.is_(True), Outcome.learned.is_(True)).count())
        check(learned == 0, "no validation-share outcome is ever taught to Thompson sampling")
        c1_routed = sum(1 for c in customers if c.cohort_id == "C1" and c.route == "strategy")
    est = api.get("/console/strategies/estimate?cohorts=C1&treatments=S1,S2", headers=RAVI).json()
    check(est["routed"] == c1_routed and all("Propensity Router" in x["reason"] for x in est["exclusions"]),
          f"the builder's estimate counts the router's split ({est['routed']} routed to strategies in C1)")
    rows = api.get("/console/customers?q=&page_size=2000", headers=RAVI).json()["rows"]
    bau = next(r for r in rows if r["route"] == "bau" and r["campaign_id"] is None)
    check(bau["status"] == "Business as usual", f"a customer kept on business as usual shows that status ({bau['name']})")
    j = api.get(f"/console/customers/{bau['customer_id']}/journey", headers=RAVI).json()
    check(j["routing"]["route"] == "bau" and any(e["kind"] == "routing" for e in j["events"]) and not j["flows"],
          "their journey shows the router's decision and no strategy flow")

    print("\n3. Scorecards")
    sc = api.get("/console/scorecards", headers=JAMES).json()
    groups = {g["fit_group"]: g for g in sc["router"]["groups"]}
    check(set(groups) == {"Persuadable", "Sure Thing", "Lost Cause", "Sleeping Dog"}, "one row per fit group")
    check(groups["Persuadable"]["treated"]["n"] > 0 and groups["Persuadable"]["untreated"]["n"] > 0,
          f"Likely responsive: treated {groups['Persuadable']['treated']['n']} vs control "
          f"{groups['Persuadable']['untreated']['n']} -> {groups['Persuadable']['state']}")
    check(groups["Sure Thing"]["treated"]["n"] > 0 and groups["Sure Thing"]["treated_from"] == "validation share",
          f"Likely self-cure is checked with its validation share: {groups['Sure Thing']['verdict'][:70]}")
    check(groups["Sleeping Dog"]["treated"]["n"] == 0 and groups["Sleeping Dog"]["state"] == "Not measured",
          "Do not contact is never treated, so it is marked not measured")
    eng = sc["engine"]
    check(eng["available"] and 0 <= eng["overall"]["picked_best"] <= 1 and eng["overall"]["regret"] >= 0,
          f"engine: picked the truly best treatment {eng['overall']['picked_best']:.0%} of the time, "
          f"average miss {eng['overall']['regret'] * 100:.1f} pp")
    s = api.get("/console/strategies/STR-021", headers=JAMES).json()
    card, st = s["scorecard"], s["stats"]
    check(card["treated"] == st["treated"] and abs(card["incremental_recoveries"] - st["uplift"] * st["treated"]) < 0.06,
          f"STR-021: {card['incremental_recoveries']} extra recoveries = uplift x treated")
    with SessionLocal() as db:
        n_val = db.query(Decision).filter(Decision.campaign_id == "STR-021", Decision.validation.is_(True),
                                          Decision.group == "Treatment").count()
        n_all = (db.query(Decision).join(Outcome, Outcome.decision_id == Decision.decision_id)
                 .filter(Decision.campaign_id == "STR-021", Decision.group == "Treatment",
                         Outcome.reward.isnot(None)).count())
    check(card["treated"] <= n_all - n_val, "the strategy's result leaves its validation-share customers out")

    print("\n4. Changing the policy re-routes customers not yet decided")
    with SessionLocal() as db:
        decided_ids = {cid for (cid,) in db.query(Decision.customer_id).distinct()}
        waiting = [c.customer_id for c in db.query(models.Customer).filter(models.Customer.route_validation.is_(True))
                   if c.customer_id not in decided_ids]
        kept = [c.customer_id for c in db.query(models.Customer).filter(models.Customer.route_validation.is_(True))
                if c.customer_id in decided_ids]
    r = api.put("/console/admin/config", headers=PRIYA, json={"values": {"router_validation_share": "0"}})
    check(r.status_code == 200 and r.json().get("rerouted") == len(waiting),
          f"share set to 0%: {r.json().get('rerouted')} undecided validation customers re-routed")
    with SessionLocal() as db:
        now_routes = {c.customer_id: (c.route, c.route_validation) for c in db.query(models.Customer)}
    check(all(now_routes[i][0] != "strategy" and not now_routes[i][1] for i in waiting),
          "they go back to their group's route")
    check(all(now_routes[i] == ("strategy", True) for i in kept), f"the {len(kept)} already decided keep theirs")
    bad = api.put("/console/admin/config", headers=RAVI, json={"values": {"router_validation_share": "0.05"}})
    check(bad.status_code == 403, "only a platform admin can change the routing policy (403)")

print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}. Database: {TMP}")
sys.exit(1 if failures else 0)
