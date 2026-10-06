"""Check the header search through the real API, on a throwaway database:
every role can search, and each finds only what its role may open.

    cd backend
    .venv/Scripts/python.exe tests/verify_search.py      (Windows)
    .venv/bin/python tests/verify_search.py              (macOS / Linux)

Exits non-zero if any check fails.
"""
from __future__ import annotations

import os
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TMP = tempfile.mkdtemp(prefix="ari-search-")
# ARI_TEST_DATABASE_URL runs the suite against another database (an empty Postgres, say).
os.environ["DATABASE_URL"] = os.environ.get("ARI_TEST_DATABASE_URL") or f"sqlite:///{os.path.join(TMP, 'search.db')}"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from app.console.models import User  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


def as_(uid: str) -> dict:
    return {"X-User-Id": uid}


with TestClient(app) as api:
    # The seeded viewer is still pending; make them active for this check.
    with SessionLocal() as db:
        db.get(User, "u-tom").status = "Active"
        db.commit()

    customer = api.get("/console/customers?page_size=1", headers=as_("u-ravi")).json()["rows"][0]
    ref = f"CUS-{10000 + customer['customer_id']}"
    strategy = api.get("/console/strategies", headers=as_("u-ravi")).json()[0]
    decision = api.get("/console/decisions?page_size=1", headers=as_("u-ravi")).json()["rows"][0]

    print("\n1. A strategist finds customers, strategies, decisions and messages")
    r = api.get(f"/console/search?q={ref}", headers=as_("u-ravi")).json()
    check([c["name"] for c in r["customers"]] == [customer["name"]], f"{ref} finds {customer['name']}")
    first = customer["name"].split()[0]
    r = api.get(f"/console/search?q={first.lower()}", headers=as_("u-ravi")).json()
    check(len(r["customers"]) > 0 and all(first in c["name"] for c in r["customers"]),
          f"'{first.lower()}' finds customers named {first}, whatever the case")
    r = api.get(f"/console/search?q={strategy['campaign_id']}", headers=as_("u-ravi")).json()
    check(any(s["campaign_id"] == strategy["campaign_id"] for s in r["strategies"]), f"{strategy['campaign_id']} finds the strategy")
    r = api.get(f"/console/search?q={strategy['name'][:6]}", headers=as_("u-ravi")).json()
    check(any(s["campaign_id"] == strategy["campaign_id"] for s in r["strategies"]), "part of a strategy name finds it")
    r = api.get(f"/console/search?q={decision['decision_id']}", headers=as_("u-ravi")).json()
    check(any(d["decision_id"] == decision["decision_id"] for d in r["decisions"]), f"{decision['decision_id']} finds the decision")
    r = api.get("/console/search?q=N-4", headers=as_("u-ravi")).json()
    check(len(r["messages"]) > 0 and all(m["nudge_id"].startswith("N-4") for m in r["messages"]), "a message id finds messages")
    check(all(len(r[g]) <= 5 for g in ("strategies", "customers", "decisions", "messages")), "at most five matches per group")

    print("\n2. Each role searches only what it may open")
    r = api.get(f"/console/search?q={ref}", headers=as_("u-tom")).json()
    check(r["scopes"] == ["strategies"], f"a viewer searches strategies only ({r['scopes']})")
    check(r["customers"] == [] and r["decisions"] == [] and r["messages"] == [], "a viewer gets no customers, decisions or messages")
    r = api.get(f"/console/search?q={strategy['campaign_id']}", headers=as_("u-tom")).json()
    check(len(r["strategies"]) >= 1, "a viewer still finds strategies")
    r = api.get(f"/console/search?q={ref}", headers=as_("u-james")).json()
    check(set(r["scopes"]) == {"strategies", "customers", "decisions"} and len(r["customers"]) == 1,
          "a strategy leader finds customers too")
    r = api.get(f"/console/search?q={ref}", headers=as_("u-priya")).json()
    check(len(r["customers"]) == 1, "a platform admin finds customers too")

    print("\n3. Edges")
    r = api.get("/console/search?q=a", headers=as_("u-ravi")).json()
    check(all(r[g] == [] for g in ("strategies", "customers", "decisions", "messages")), "one character returns nothing yet")
    r = api.get("/console/search?q=zzzz-no-such-thing", headers=as_("u-ravi")).json()
    check(all(r[g] == [] for g in ("strategies", "customers", "decisions", "messages")), "no match returns empty groups")
    check(api.get("/console/search?q=ab").status_code == 401, "nobody signed in: 401")

print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}. Database: {TMP}")
sys.exit(1 if failures else 0)
