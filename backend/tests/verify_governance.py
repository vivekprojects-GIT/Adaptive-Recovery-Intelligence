"""Check the executive dashboard, agency placements and data protection through
the real API, on a throwaway database:

  * every role opens the executive dashboard, and its numbers add up
  * a placement waits for a person, and the person who proposed it cannot approve it
  * a placed account is never picked by a strategy wave
  * protected attributes (ZIP code, date of birth...) are dropped on arrival
  * inbound payloads are encrypted at rest, and traces carry tokens, not IDs

    cd backend
    .venv/Scripts/python.exe tests/verify_governance.py      (Windows)
    .venv/bin/python tests/verify_governance.py              (macOS / Linux)

Exits non-zero if any check fails.
"""
from __future__ import annotations

import os
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TMP = tempfile.mkdtemp(prefix="ari-governance-")
os.environ["DATABASE_URL"] = os.environ.get("ARI_TEST_DATABASE_URL") or f"sqlite:///{os.path.join(TMP, 'governance.db')}"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import models  # noqa: E402
from app.console import agencies, engine  # noqa: E402
from app.console.contract import NovaAccount, receive  # noqa: E402
from app.console.models import Campaign, Placement, User  # noqa: E402
from app.core import pii, telemetry  # noqa: E402
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
    with SessionLocal() as db:
        db.get(User, "u-tom").status = "Active"
        db.commit()

    print("\n1. Every business role lands on the executive dashboard, and its numbers add up")
    for uid in ("u-ravi", "u-james", "u-tom"):
        r = api.get("/console/executive", headers=as_(uid))
        check(r.status_code == 200, f"{uid} opens the executive dashboard")
    d = api.get("/console/executive", headers=as_("u-james")).json()
    with SessionLocal() as db:
        n = db.query(models.Customer).count()
    check(d["intake"]["accounts"] == n, f"accounts imported ({d['intake']['accounts']}) match the customer count ({n})")
    check(sum(x["accounts"] for x in d["intake"]["by_product"]) == n, "the product split adds up to every account")
    check({x["product"] for x in d["intake"]["by_product"]} == {"Consumer Credit Card", "Small Business Card",
                                                                "Retail Card", "Co-brand Card"},
          "the book holds exactly the bank's four card businesses")
    check(sum(x["accounts"] for x in d["routing"]) == n, "every account has a route")
    check(all(s["state"] in ("on_track", "watch", "off_track", None) for s in d["deviations"]["strategies"]),
          "each live strategy is compared with its target")
    check(any(x["kind"] == "reviews" or x["kind"] == "violations" for x in d["exceptions"]), "exceptions are listed")

    print("\n2. Agency placements always wait for a person")
    pending = api.get("/console/placements?status=Proposed", headers=as_("u-james")).json()
    check(len(pending) > 0, f"ARI's proposals are waiting for approval ({len(pending)})")
    p = pending[0]
    r = api.post(f"/console/placements/{p['placement_id']}/review", json={"approve": True}, headers=as_("u-ravi"))
    check(r.status_code == 403, "a strategist cannot approve a placement")
    r = api.post(f"/console/placements/{p['placement_id']}/review", json={"approve": False}, headers=as_("u-james"))
    check(r.status_code == 400, "declining needs a reason")
    r = api.post(f"/console/placements/{p['placement_id']}/review", json={"approve": True}, headers=as_("u-james"))
    check(r.status_code == 200 and r.json()["status"] == "Placed", "a leader approves it and it is placed")
    # A person's own proposal needs someone else.
    with SessionLocal() as db:
        held = agencies.open_customer_ids(db)
        c = next(c for c in db.query(models.Customer).filter(models.Customer.days_past_due >= 90)
                 if agencies.eligibility(db, c, held=held)[0] and agencies.match(db, c)[0] is not None)
        cid = c.customer_id
    r = api.post("/console/placements", json={"customer_id": cid, "reason": "Broken promise to pay"}, headers=as_("u-ravi"))
    check(r.status_code == 200 and r.json()["status"] == "Proposed", "a strategist proposes an account")
    with SessionLocal() as db:   # a leader's own proposal (proposed directly, as no default role holds both rights)
        held = agencies.open_customer_ids(db)
        c2 = next(c for c in db.query(models.Customer).filter(models.Customer.days_past_due >= 90)
                  if agencies.eligibility(db, c, held=held)[0] and agencies.match(db, c)[0] is not None)
        own = agencies.propose(db, c2, "u-james").placement_id
        db.commit()
    r = api.post(f"/console/placements/{own}/review", json={"approve": True}, headers=as_("u-james"))
    check(r.status_code == 403, "the person who proposed it cannot approve it")
    with SessionLocal() as db:
        agencies.review(db, own, False, "u-james", "test cleanup")
        db.commit()

    print("\n2b. Platform Admin manages people and access, never customer data")
    for path in ("/console/executive", "/console/customers", "/console/decisions", "/console/placements",
                 "/console/kpis", "/console/treatments"):
        check(api.get(path, headers=as_("u-priya")).status_code == 403, f"admin is refused {path}")
    r = api.get("/console/search?q=a", headers=as_("u-priya")).json()
    check("customers" not in r.get("scopes", []), "admin's search has no customer scope")
    r = api.put("/console/admin/roles", json={"matrix": {"admin": {"view_customer_list": True}}}, headers=as_("u-priya"))
    check(r.status_code == 409, "admin cannot grant itself customer access")
    log = api.get("/console/admin/audit?entity=placement", headers=as_("u-priya")).json()
    check(log["restricted"] and log["rows"] and all(x["entity_id"] == "Restricted" and "restricted" in x["summary"]
                                                    and "70510" not in x["summary"] for x in log["rows"]),
          f"the audit log shows admin what happened to placements, not which accounts ({len(log['rows'])} rows)")
    log = api.get("/console/admin/audit?entity=strategy", headers=as_("u-priya")).json()
    check(log["rows"] and all(x["entity_id"] != "Restricted" for x in log["rows"]),
          "strategy records, which name no customer, stay readable")
    check(api.get("/console/admin/users", headers=as_("u-priya")).status_code == 200, "admin still manages users")
    check(api.get("/console/governance", headers=as_("u-priya")).status_code == 200,
          "admin can read the security and governance summary")

    print("\n3. A placed account is never picked by a strategy")
    with SessionLocal() as db:
        placed = {x for (x,) in db.query(Placement.customer_id).filter(Placement.status.in_(agencies.OPEN))}
        live = db.query(Campaign).filter(Campaign.status == "Live").all()
        picked = {c.customer_id for camp in live for c in engine.undecided_pool(db, camp)}
    check(placed and not (placed & picked), f"none of the {len(placed)} placed accounts is in any live strategy's pool")

    print("\n4. Protected attributes are dropped on arrival")
    raw = {"account_id": "NV-FAIR-1", "days_past_due": 32, "current_balance": 2400, "zip_code": "60614",
           "Date_Of_Birth": "1984-02-11", "gender": "F", "preferred_channel": "SMS"}
    got = receive(NovaAccount.model_validate(raw))
    check(set(got.protected_dropped) == {"zip_code", "Date_Of_Birth", "gender"}, f"dropped {got.protected_dropped}")
    check("zip_code" not in got.raw and "gender" not in got.raw, "the stored request no longer holds them")
    check("zip_code" not in got.ignored_fields, "they are reported as protected, not merely ignored")
    g = api.get("/console/governance", headers=as_("u-james")).json()
    check("ZIP code" in g["fairness"]["excluded"], "the governance page lists ZIP code as never used")
    check(api.get("/console/governance", headers=as_("u-ravi")).status_code == 403,
          "governance needs the compliance permission")

    print("\n5. Inbound data is encrypted at rest; traces carry tokens")
    with SessionLocal() as db:
        stored = [v for (v,) in db.execute(text("SELECT raw_payload FROM feature_snapshots"))]
    check(stored and all(pii.is_encrypted(v) for v in stored), f"all {len(stored)} stored requests are ciphertext")
    check(pii.decrypt(pii.encrypt('{"a": 1}')) == '{"a": 1}', "ciphertext decrypts back with the key")
    enc = g["encryption"]["fields"][0]
    check(enc["encrypted"] == enc["rows"], "the governance page reports every row encrypted")
    spans = [s for s in telemetry.spans.spans() if s.name in ("ari.decide", "ari.router.route")]
    check(len(spans) > 0, f"decision and routing traces were recorded ({len(spans)})")
    check(all("ari.customer_id" not in dict(s.attributes) for s in spans), "they carry no customer id")
    check(all(str(dict(s.attributes).get("ari.customer", "")).startswith("tok_") for s in spans),
          "they carry a token instead")
    check(pii.token(5, "customer") == pii.token(5, "customer") != pii.token(6, "customer"),
          "a token is stable for one customer and different for another")

print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}")
sys.exit(1 if failures else 0)
