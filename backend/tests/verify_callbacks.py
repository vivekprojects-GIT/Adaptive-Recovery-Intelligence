"""Check what Nova is told when a person changes one of its decisions, and what
CARE refuses to keep, through the real API on a throwaway database:

  * with no callback URL set, events wait in the outbox and Nova reads them
    with get_decision_updates
  * with a URL, an approval is POSTed to Nova, signed with HMAC-SHA256
  * a failed delivery is kept and goes out on retry
  * card numbers, SSNs and government IDs are dropped on arrival
  * product is reported as used to decide, not as stored only

    cd backend
    .venv/Scripts/python.exe tests/verify_callbacks.py      (Windows)
    .venv/bin/python tests/verify_callbacks.py              (macOS / Linux)

Exits non-zero if any check fails.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TMP = tempfile.mkdtemp(prefix="ari-callbacks-")
os.environ["DATABASE_URL"] = os.environ.get("ARI_TEST_DATABASE_URL") or f"sqlite:///{os.path.join(TMP, 'callbacks.db')}"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from app.console import callbacks, nova  # noqa: E402
from app.console.contract import NovaAccount, receive  # noqa: E402
from app.console.models import DecisionEvent, PlatformConfig  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402

failures: list[str] = []
received: list[dict] = []
status_to_return = [200]


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


class Nova(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers["Content-Length"]))
        received.append({"body": body, "headers": dict(self.headers)})
        self.send_response(status_to_return[0])
        self.end_headers()

    def log_message(self, *a):
        pass


server = HTTPServer(("127.0.0.1", 0), Nova)
threading.Thread(target=server.serve_forever, daemon=True).start()
HOOK = f"http://127.0.0.1:{server.server_address[1]}/ari-events"


def wait_for(cond, seconds: float = 8.0) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.1)
    return False


def account(i: int, **over) -> NovaAccount:
    base = {"account_id": f"NOVA-CB-{i}", "days_past_due": 31, "current_balance": 12500, "credit_limit": 15000,
            "amount_past_due": 450, "opened_date": "2019-03-01", "prior_delinquencies_12m": 1,
            "on_time_payment_ratio": 0.94, "risk_segment": "Medium", "app_user": True, "sms_responsive": True,
            "hardship_flag": True, "consent": {"sms": True, "email": True, "call": True}, "contacts_last_7d": 0}
    return NovaAccount.model_validate({**base, **over})


def as_(uid: str) -> dict:
    return {"X-User-Id": uid}


with TestClient(app) as api:
    db = SessionLocal()
    db.get(PlatformConfig, "router_validation_share").value = "0"
    db.commit()
    pending = []
    for i in range(80):
        r = nova.recovery_strategy(db, account(i))
        if r.get("action") == "awaiting_approval":
            pending.append(r)
        if len(pending) == 3:
            break
    check(len(pending) == 3, f"three Nova decisions are waiting for review ({[p['decision_id'] for p in pending]})")

    print("\n1. No callback URL: events wait and Nova reads them")
    r = api.post(f"/console/decisions/{pending[0]['decision_id']}/review",
                 json={"approve": False, "note": "Customer called in with a payment offer"}, headers=as_("u-maya"))
    check(r.status_code == 200, "a reviewer rejects the first offer")
    wait_for(lambda: db.query(DecisionEvent).filter_by(status="not_configured").count() == 1)
    db.expire_all()
    ev = db.query(DecisionEvent).one()
    check(ev.event == "decision.rejected" and ev.status == "not_configured",
          f"the event is kept as {ev.event}, {ev.status}")
    up = callbacks.updates(db, 0)
    first = up["events"][0] if up["events"] else {}
    check(first.get("decision_id") == pending[0]["decision_id"] and first.get("account_id", "").startswith("NOVA-CB-"),
          f"get_decision_updates returns it with Nova's account id ({first.get('account_id')})")
    check(first.get("decision", {}).get("action") == "rejected" and first.get("note"),
          f"it carries the decision as Nova would read it (action {first.get('decision', {}).get('action')})")
    check(callbacks.updates(db, up["next_cursor"])["events"] == [], "the cursor moves past it")

    print("\n2. With a URL, an approval is pushed to Nova and signed")
    r = api.put("/console/admin/config", json={"values": {"nova_callback_url": "http://example.com/hook"}},
                headers=as_("u-priya"))
    check(r.status_code == 400, "a plain-http URL other than localhost is refused")
    r = api.put("/console/admin/config", json={"values": {"nova_callback_url": HOOK}}, headers=as_("u-priya"))
    check(r.status_code == 200, "a localhost URL is accepted")
    r = api.post(f"/console/decisions/{pending[1]['decision_id']}/review", json={"approve": True},
                 headers=as_("u-maya"))
    check(r.status_code == 200, "a reviewer approves the second offer")
    check(wait_for(lambda: any(json.loads(x["body"])["decision_id"] == pending[1]["decision_id"] for x in received)),
          "Nova receives the approval")
    hit = next(x for x in received if json.loads(x["body"])["decision_id"] == pending[1]["decision_id"])
    secret = api.post("/console/admin/callbacks/secret", headers=as_("u-priya")).json()["secret"]
    expected = "sha256=" + hmac.new(secret.encode(), hit["body"], hashlib.sha256).hexdigest()
    check(hit["headers"].get("X-ARI-Signature") == expected, "the signature verifies with the shared secret")
    body = json.loads(hit["body"])
    check(body["event"] == "decision.approved" and hit["headers"].get("X-ARI-Event") == "decision.approved",
          "event type in the body and the header")
    check(any(json.loads(x["body"])["decision_id"] == pending[0]["decision_id"] for x in received),
          "the earlier event that was waiting goes out too")
    check(api.post("/console/admin/callbacks/secret", headers=as_("u-maya")).status_code == 403,
          "only an integrations admin can read the secret")

    print("\n3. A failed delivery is kept and retried")
    status_to_return[0] = 503
    r = api.post(f"/console/decisions/{pending[2]['decision_id']}/review", json={"approve": True},
                 headers=as_("u-maya"))

    def failed() -> bool:
        db.expire_all()
        e = db.query(DecisionEvent).filter_by(decision_id=pending[2]["decision_id"]).first()
        return e is not None and e.status == "failed"
    check(wait_for(failed), "Nova answers 503: the event is marked failed, not lost")
    status_to_return[0] = 200
    out = api.post("/console/admin/callbacks/retry", headers=as_("u-priya")).json()
    check(out["delivered"] >= 1, f"retry delivers it ({out['delivered']} delivered)")
    st = api.get("/console/admin/callbacks", headers=as_("u-priya")).json()
    check(st["by_status"].get("delivered") == 3 and not st["by_status"].get("failed"),
          f"all three events delivered ({st['by_status']})")

    print("\n4. Card numbers, SSNs and government IDs are dropped on arrival")
    got = receive(NovaAccount.model_validate({
        "account_id": "4111111111111111", "days_past_due": 31, "current_balance": 2000, "ssn": "123-45-6789",
        "card_number": "4111111111111111", "drivers_license": "D1234567",
        "source_system": "card 4111 1111 1111 1111 on file"}))
    check(set(got.sensitive_dropped) == {"ssn", "card_number", "drivers_license", "source_system"},
          f"dropped {sorted(got.sensitive_dropped)}")
    check(got.raw.get("account_id") == "4111111111111111", "Nova's own account id is never mistaken for a card")
    check("ssn" not in got.ignored_fields and "card_number" not in got.raw, "nothing sensitive is stored")
    out = nova.recovery_strategy(db, account(900, ssn="123-45-6789"))
    check(out.get("sensitive_fields_dropped") == ["ssn"], "the answer to Nova lists what was dropped")
    g = api.get("/console/governance", headers=as_("u-james")).json()
    check(g["fairness"]["sensitive_dropped"]["requests"] >= 1 and "Card number" in g["fairness"]["sensitive"],
          "the governance page counts it")

    print("\n5. Product is reported as used")
    out = nova.recovery_strategy(db, account(901, product="Co-brand Card"))
    lineage = out.get("lineage_only") or out.get("received", {}).get("lineage_only") or []
    check("product" not in lineage, f"product is not listed as stored only ({lineage})")
    check("used" in (NovaAccount.model_fields["product"].description or "").lower(),
          "the contract says how product is used")
    db.close()

server.shutdown()
print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}")
sys.exit(1 if failures else 0)
