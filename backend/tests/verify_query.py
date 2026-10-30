"""Check plain-English questions about the portfolio and the Collections Journey,
through the real API, on a throwaway database: a question is read into
conditions, only allowed fields can be queried, the matches are exactly the
accounts the conditions describe, and the result can become a strategy's target.

    cd backend
    .venv/Scripts/python.exe tests/verify_query.py      (Windows)
    .venv/bin/python tests/verify_query.py              (macOS / Linux)

Exits non-zero if any check fails.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TMP = tempfile.mkdtemp(prefix="care-query-")
os.environ["DATABASE_URL"] = os.environ.get("ARI_TEST_DATABASE_URL") or f"sqlite:///{os.path.join(TMP, 'query.db')}"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from app.console import nlq  # noqa: E402
from app.main import app  # noqa: E402

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


def as_(uid: str) -> dict:
    return {"X-User-Id": uid}


ANALYST = as_("u-maya")

print("\n1. Questions are read into conditions on known fields")
cases = {
    "consumer card accounts over 60 days past due with a balance above $5,000 who use the app":
        {("days_past_due", ">", 60), ("balance", ">", 5000), ("product", "=", "Consumer Credit Card"), ("app_user", "=", True)},
    "retail and co-brand customers between 30 and 60 days late with delinquent amount over 500":
        {("days_past_due", "between", (30, 60)), ("delinquent_amount", ">", 500), ("product", "in", ("Co-Brand Card", "Retail Card"))},
    "likely to respond customers in C2 who reply to texts and are not in hardship":
        {("cohort_id", "=", "C2"), ("segment", "=", "Persuadable"), ("sms_responsive", "=", True), ("hardship_flag", "=", False)},
    "accounts not contacted with utilisation above 90% and 3 or more missed payments":
        {("route", "=", "suppress"), ("utilization", ">", 0.9), ("missed_payments", ">=", 3)},
}
for q, want in cases.items():
    got = {(c["field"], c["op"], tuple(c["value"]) if isinstance(c["value"], list) else c["value"])
           for c in nlq.read(q)["conditions"]}
    check(got == want, f'"{q[:60]}..." reads as {len(want)} conditions')
check(nlq.read("customers who like pizza")["conditions"] == [], "a question with nothing it knows reads as no conditions")
check("WHERE days_past_due > 60" in nlq.read("over 60 days past due")["sql"], "the conditions are shown as SQL")

with TestClient(app) as api:
    print("\n2. Asking the portfolio")
    q = "consumer card accounts over 60 days past due with a balance above $5,000 who use the app"
    r = api.post("/console/customers/ask", headers=ANALYST, json={"question": q})
    a = r.json()
    check(r.status_code == 200 and a["accounts"] > 0, f"the question matches {a.get('accounts')} accounts")
    rows = api.get("/console/customers", headers=ANALYST,
                   params={"where": json.dumps(a["conditions"]), "page_size": 500}).json()
    check(rows["total"] == a["accounts"] and all(
        x["product"] == "Consumer Credit Card" and x["days_past_due"] > 60 and x["balance"] > 5000 for x in rows["rows"]),
        "the Customers list shows exactly the accounts the conditions describe")
    check(api.post("/console/customers/ask", headers=ANALYST, json={"question": "who likes pizza"}).status_code == 422,
          "a question with no conditions is refused with a hint")
    bad = '[{"field": "name", "op": "=", "value": "x"}]'
    check(api.get("/console/customers", headers=ANALYST, params={"where": bad}).status_code == 400,
          "a field outside the allowed list cannot be queried")
    sneaky = '[{"field": "balance", "op": ">", "value": "0; DROP TABLE customers"}]'
    check(api.get("/console/customers", headers=ANALYST, params={"where": sneaky}).status_code == 400,
          "a value that is not a number is refused, so text never reaches the SQL")
    check(api.post("/console/customers/ask", headers=as_("u-priya"), json={"question": q}).status_code == 403,
          "the platform admin cannot query customer accounts")

    print("\n3. The result becomes a campaign target")
    s = api.post("/console/strategies", headers=ANALYST, json={
        "name": "Target: consumer cards, app users", "target_cohorts": a["cohorts"],
        "target_query": {"question": q, "conditions": a["conditions"]}}).json()
    check(s.get("target_query", {}).get("question") == q, f"{s.get('campaign_id')} keeps the question as its target")
    est = api.get("/console/strategies/estimate", headers=ANALYST,
                  params={"cohorts": ",".join(a["cohorts"]), "query": json.dumps(s["target_query"])}).json()
    check(est["matching"] == a["accounts"], f"its audience is the {a['accounts']} matching accounts ({est['matching']})")
    plain = api.get("/console/strategies/estimate", headers=ANALYST, params={"cohorts": ",".join(a["cohorts"])}).json()
    check(plain["matching"] > est["matching"], "without the question the same cohorts reach more accounts")
    bad_target = api.post("/console/strategies", headers=ANALYST, json={
        "name": "Bad target", "target_cohorts": ["C2"], "target_query": {"question": "x", "conditions": json.loads(bad)}})
    check(bad_target.status_code == 400, "a strategy cannot target a field outside the allowed list")

    print("\n4. The Collections Journey")
    j = api.get("/console/journey/collections", headers=ANALYST).json()
    check(j["problem"]["accounts"] == sum(j["routes"].values()), "every account in the book has a route")
    check(len(j["personas"]) == 3 and len({p["route"] for p in j["personas"]}) == 3,
          "three customers in the same cohort get three different routes")
    check(api.get("/console/journey/collections", headers=as_("u-priya")).status_code == 403,
          "the platform admin cannot open the journey's account data")
    roles = {u["role"]: u["role_label"] for u in api.get("/console/users/public").json()} if \
        api.get("/console/users/public").status_code == 200 else {}
    if roles:
        check(roles.get("strategist") == "Strategy Analyst", "the strategist role is called Strategy Analyst")

print(f"\n{len(failures)} check(s) failed." if failures else "\nAll checks passed.")
sys.exit(1 if failures else 0)
