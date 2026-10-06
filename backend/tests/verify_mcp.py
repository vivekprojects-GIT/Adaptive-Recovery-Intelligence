"""End-to-end check of ARI's MCP server, over the real protocol, on a
throwaway database: the official MCP Python client plays the Nova agent.

    cd backend
    .venv/Scripts/python.exe tests/verify_mcp.py      (Windows)
    .venv/bin/python tests/verify_mcp.py              (macOS / Linux)

Starts the API on a free local port, so nothing else needs to be running.
Exits non-zero if any check fails.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import tempfile
import threading
import time

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TMP = tempfile.mkdtemp(prefix="ari-mcp-")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(TMP, 'mcp.db')}"
os.environ.pop("ARI_MCP_TOKEN", None)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from mcp import ClientSession  # noqa: E402
from mcp.client.streamable_http import streamablehttp_client  # noqa: E402

from app.console import mcp_server  # noqa: E402
from app.console.models import Decision, Outcome  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


# Nova-shaped accounts. Same cohort and risk band; different right answers.
PRIYA = {"account_id": "NOVA-ACC-1001", "customer_name": "Priya Sharma", "days_past_due": 31,
         "current_balance": 4180, "credit_limit": 5000, "opened_date": "2020-03-01", "prior_delinquencies_12m": 1,
         "on_time_payment_ratio": 0.94, "risk_segment": "Medium", "risk_score": 62, "app_user": True,
         "sms_responsive": True, "hardship_flag": True, "consent": {"sms": True, "email": True, "call": False},
         "contacts_last_7d": 1, "source_system": "CRM_PROD"}
JOHN = {"account_id": "NOVA-ACC-1002", "customer_name": "John Mitchell", "days_past_due": 30,
        "current_balance": 7920, "credit_limit": 9000, "opened_date": "2018-01-15", "prior_delinquencies_12m": 1,
        "on_time_payment_ratio": 0.85, "risk_segment": "Medium", "risk_score": 58, "app_user": False,
        "sms_responsive": False, "hardship_flag": False}
MIKE_C3 = {"account_id": "NOVA-ACC-1003", "customer_name": "Mike Torres", "days_past_due": 62,
           "current_balance": 7640, "credit_limit": 8000, "opened_date": "2023-02-01", "prior_delinquencies_12m": 4,
           "on_time_payment_ratio": 0.44, "risk_segment": "High", "risk_score": 77, "app_user": False,
           "sms_responsive": False, "hardship_flag": True}


def start_server() -> tuple[uvicorn.Server, int]:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config("app.main:app", host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(1200):  # startup seeds a database; allow for a busy machine
        if server.started:
            return server, port
        time.sleep(0.05)
    raise SystemExit("API did not start")


def result(r) -> dict:
    if r.isError:
        raise AssertionError(r.content[0].text if r.content else "tool error")
    return r.structuredContent if r.structuredContent is not None else json.loads(r.content[0].text)


async def main(port: int) -> None:
    url = f"http://127.0.0.1:{port}/mcp"
    db = SessionLocal()
    token = mcp_server.access_token(db)[0]
    db.close()

    print("\n1. Access")
    async with httpx.AsyncClient() as h:
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        accept = {"Accept": "application/json, text/event-stream"}
        r = await h.post(url, json=body, headers=accept)
        check(r.status_code == 401, "no token: 401")
        r = await h.post(url, json=body, headers={**accept, "Authorization": "Bearer wrong"})
        check(r.status_code == 401, "wrong token: 401")
        r = await h.post(url, json=body, headers={**accept, "Authorization": f"Bearer {token}"})
        check(r.status_code == 200 and len(r.json()["result"]["tools"]) == 7,
              "right token: 200, 7 tools (plain JSON-RPC over HTTP, no SDK needed)")

    async with streamablehttp_client(url, headers={"Authorization": f"Bearer {token}"}) as (read, write, _):
        async with ClientSession(read, write) as s:
            init = await s.initialize()
            check(init.serverInfo.name == "ari-recovery-agent", f"MCP handshake with {init.serverInfo.name}")
            names = {t.name for t in (await s.list_tools()).tools}
            check({"get_recovery_strategy", "report_payment_outcome", "preview_recovery_strategy"} <= names,
                  f"tools listed: {', '.join(sorted(names))}")

            print("\n2. Decisions")
            db = SessionLocal()
            before = db.query(Decision).count()
            db.close()
            prev = result(await s.call_tool("preview_recovery_strategy", {"account": PRIYA}))
            db = SessionLocal()
            after = db.query(Decision).count()
            db.close()
            check(prev["decision_id"] is None and before == after,
                  f"preview records nothing ({prev['action']}: {prev['summary'][:70]}...)")

            priya = result(await s.call_tool("get_recovery_strategy", {"account": PRIYA}))
            check(priya["strategy"]["strategy_id"] == "STR-021",
                  f"30 DPD, can be helped -> the most specific strategy, {priya['strategy']['strategy_id']} "
                  f"{priya['strategy']['name']}")
            check(priya["customer"]["intervention_fit"] == "Likely responsive", "fit group: Likely responsive")
            check(priya["action"] in ("awaiting_approval", "contact", "contact_failed", "contact_blocked", "control_bau"),
                  f"action {priya['action']}: {priya['summary'][:90]}")
            again = result(await s.call_tool("get_recovery_strategy", {"account": PRIYA}))
            check(again["existing"] and again["decision_id"] == priya["decision_id"],
                  "asking twice returns the same decision - no second contact")

            john = result(await s.call_tool("get_recovery_strategy", {"account": JOHN}))
            check(john["action"] == "no_action" and "self-cure" in john["summary"].lower(),
                  f"will pay anyway -> {john['action']}: {john['summary'][:80]}")
            mike = result(await s.call_tool("get_recovery_strategy", {"account": MIKE_C3}))
            check(mike["strategy"] and mike["strategy"]["strategy_id"] == "STR-018",
                  f"60 DPD, severe hardship -> {mike['strategy'] and mike['strategy']['strategy_id']}, "
                  f"{(mike['treatment'] or {}).get('name') or mike['action']}")
            vul = result(await s.call_tool("get_recovery_strategy",
                                           {"account": {**PRIYA, "account_id": "NOVA-ACC-1004",
                                                        "vulnerability_flag": True}}))
            check(vul["action"] == "refer_to_specialist", "vulnerability flag -> refer to a specialist, no contact")
            cur = result(await s.call_tool("get_recovery_strategy",
                                           {"account": {"account_id": "NOVA-ACC-1005", "days_past_due": 0,
                                                        "current_balance": 900}}))
            check(cur["action"] == "no_action", "0 days past due -> no action")
            minimal = result(await s.call_tool("get_recovery_strategy",
                                               {"account": {"account_id": "NOVA-ACC-1006", "days_past_due": 33,
                                                            "current_balance": 2400}}))
            check(len(minimal.get("assumed", [])) >= 5,
                  f"only the 3 required fields: decided, with {len(minimal.get('assumed', []))} stated assumptions")

            print("\n3. Contact rules decide what may be chosen, before Thompson sampling")
            # C1 app users who withdrew SMS consent: the SMS reminder and the app push are both
            # eligible. The SMS arm must never be sampled; every treated account gets the push.
            sms_drawn, treated, sample = 0, 0, None
            for i in range(20):
                acc = {"account_id": f"NOVA-APP-{i}", "days_past_due": 12, "current_balance": 1200,
                       "credit_limit": 2000, "opened_date": "2015-01-01", "prior_delinquencies_12m": 0,
                       "on_time_payment_ratio": 0.95, "app_user": True, "sms_responsive": True,
                       "hardship_flag": True, "consent": {"sms": False}}
                r = result(await s.call_tool("get_recovery_strategy", {"account": acc}))
                if r["group"] != "Treatment":
                    continue
                treated += 1
                sample = sample or r
                considered = {x["code"] for x in r["alternatives"]}
                if "S1" in considered or r["action"] == "contact_blocked":
                    sms_drawn += 1
            check(treated > 0 and sms_drawn == 0 and sample["treatment"]["code"] == "S2"
                  and sample["blocked_treatments"][0]["reason_code"] == "NO_SMS_CONSENT",
                  f"no SMS consent, app user: {treated} treated, SMS never sampled, all got "
                  f"{sample and sample['treatment']['name']} ({sample and sample['blocked_treatments'][0]['reason']})")
            blocked = None
            for i in range(12):  # C1, no app: only the SMS reminder is eligible
                acc = {"account_id": f"NOVA-SMS-{i}", "days_past_due": 12, "current_balance": 1200,
                       "credit_limit": 2000, "opened_date": "2016-05-01", "prior_delinquencies_12m": 0,
                       "on_time_payment_ratio": 0.95, "app_user": False, "sms_responsive": True,
                       "hardship_flag": True, "consent": {"sms": False}}
                r = result(await s.call_tool("get_recovery_strategy", {"account": acc}))
                if r["group"] != "Control":
                    blocked = r
                    break
            check(blocked is not None and blocked["action"] == "contact_blocked" and blocked["treatment"] is None
                  and blocked["group"] == "Excluded" and blocked["selection_probability"] is None
                  and blocked["contact"] is None,
                  f"no allowed treatment -> {blocked and blocked['action']}, excluded before the control split, "
                  f"no draw, nothing sent: "
                  f"{blocked and blocked['summary'][:80]}")
            capped = None
            for i in range(12):
                acc = {**PRIYA, "account_id": f"NOVA-CAP-{i}", "contacts_last_7d": 7, "consent": None}
                r = result(await s.call_tool("get_recovery_strategy", {"account": acc}))
                if r["group"] != "Control":
                    capped = r
                    break
            check(capped is not None and capped["action"] == "contact_blocked"
                  and {b["reason_code"] for b in capped["blocked_treatments"]} == {"CONTACT_CAP"},
                  f"7 contacts already made elsewhere -> {capped and capped['blocked_treatments'][0]['reason']}")

            print("\n3b. Messages quote only what Nova sent")
            quoted = unquoted = None
            for i in range(30):
                base = {**PRIYA, "consent": None, "contacts_last_7d": 0, "hardship_flag": False}
                if quoted is None:
                    r = result(await s.call_tool("get_recovery_strategy", {"account": {
                        **base, "account_id": f"NOVA-AMT-{i}", "amount_past_due": 620}}))
                    quoted = r if r.get("message") else None
                if unquoted is None:
                    r = result(await s.call_tool("get_recovery_strategy", {"account": {
                        **base, "account_id": f"NOVA-NOAMT-{i}"}}))
                    unquoted = r if r.get("message") else None
                if quoted and unquoted:
                    break
            check(quoted is not None and "$620" in quoted["message"] and "card ending" not in quoted["message"],
                  f"amount_past_due 620 is quoted, no card number: {quoted and quoted['message'][:90]}")
            check(unquoted is not None and "$" not in unquoted["message"],
                  f"no amount sent -> the message names no figure: {unquoted and unquoted['message'][:90]}")

            print("\n4. Outcomes teach the model")
            contacted = None
            for i in range(30):
                # C1, low balance: a strategy whose treatments (SMS reminder, app push) send without review.
                acc = {"account_id": f"NOVA-LEARN-{i}", "days_past_due": 12, "current_balance": 1200,
                       "credit_limit": 2000, "opened_date": "2015-01-01", "prior_delinquencies_12m": 0,
                       "on_time_payment_ratio": 0.95, "app_user": True, "sms_responsive": True, "hardship_flag": True}
                r = result(await s.call_tool("get_recovery_strategy", {"account": acc}))
                if r["action"] == "contact":
                    contacted = r
                    break
            check(contacted is not None, f"an automatic treatment was sent: {contacted and contacted['treatment']['name']}")
            if contacted:
                rep = result(await s.call_tool("report_payment_outcome", {
                    "decision_id": contacted["decision_id"], "paid": True, "amount": 150,
                    "payment_date": contacted["decided_at"][:10]}))
                lr = rep["learning"]
                check(rep["learned"] and lr["belief_after"] > lr["belief_before"],
                      f"paid -> learned: {lr['treatment']['name']} {lr['belief_before']:.3f} -> {lr['belief_after']:.3f}")
                fix = result(await s.call_tool("report_payment_outcome", {
                    "decision_id": contacted["decision_id"], "paid": True, "payment_status": "Reversed"}))
                check(fix["corrected"] and not fix["paid"] and fix["learning"]["belief_after"] < lr["belief_after"],
                      "a reversal corrects the report and the belief falls back")
            ctrl = None
            for i in range(30):
                r = result(await s.call_tool("get_recovery_strategy",
                                             {"account": {**PRIYA, "account_id": f"NOVA-CTRL-{i}", "consent": None}}))
                if r["action"] == "control_bau":
                    ctrl = r
                    break
            if ctrl:
                rep = result(await s.call_tool("report_payment_outcome", {"account_id": ctrl["customer"]["account_id"],
                                                                          "paid": False}))
                check(rep["recorded"] and not rep["learned"], "control outcome recorded as the comparison, not learned")
            r = await s.call_tool("report_payment_outcome", {"decision_id": "D-0001", "paid": True})
            check(r.isError, "an unknown decision is refused with a reason")

            print("\n5. Human approval, then the real outcome")
            pending = priya if priya["action"] == "awaiting_approval" else (mike if mike["action"] == "awaiting_approval" else None)
            if pending is None:
                for i in range(30):
                    r = result(await s.call_tool("get_recovery_strategy",
                                                 {"account": {**MIKE_C3, "account_id": f"NOVA-HARD-{i}"}}))
                    if r["action"] == "awaiting_approval":
                        pending = r
                        break
            check(pending is not None, f"a forbearance offer waits for a person: {pending and pending['decision_id']}")
            if pending:
                async with httpx.AsyncClient() as h:
                    rv = await h.post(f"http://127.0.0.1:{port}/console/decisions/{pending['decision_id']}/review",
                                      json={"approve": True, "note": ""}, headers={"X-User-Id": "u-maya"})
                check(rv.status_code == 200, f"Maya approves it in the console ({rv.json()})")
                db = SessionLocal()
                o = db.query(Outcome).filter(Outcome.decision_id == pending["decision_id"]).first()
                db.close()
                check(o is None, "approval sends the offer but does not invent an outcome - Nova reports it")
                got = result(await s.call_tool("get_decision", {"decision_id": pending["decision_id"]}))
                check(got["review"]["status"] == "approved" and got["contact"] is not None,
                      f"get_decision sees the approval and the contact ({got['action']})")
                rep = result(await s.call_tool("report_payment_outcome",
                                               {"decision_id": pending["decision_id"], "paid": True}))
                check(rep["learned"], f"approved and delivered -> learned ({rep['note'][:70]}...)")

            print("\n5b. Approval re-checks Nova's newest data")
            pend = []
            for i in range(40):
                r = result(await s.call_tool("get_recovery_strategy", {"account": {
                    **PRIYA, "account_id": f"NOVA-RECHECK-{i}", "contacts_last_7d": 0,
                    "consent": {"sms": True, "email": True, "call": True}}}))
                if r["action"] == "awaiting_approval":
                    pend.append(r)
                    if len(pend) == 2:
                        break
            check(len(pend) == 2, f"two offers waiting for review: {', '.join(p['decision_id'] for p in pend)}")
            if len(pend) == 2:
                a, b = pend
                again = result(await s.call_tool("get_recovery_strategy", {"account": {
                    **PRIYA, "account_id": a["customer"]["account_id"],
                    "consent": {"sms": False, "email": False, "call": False}}}))
                check(again["existing"] and again["action"] == "awaiting_approval",
                      "consent withdrawn while waiting: the offer is still awaiting approval")
                async with httpx.AsyncClient() as h:
                    rv = (await h.post(f"http://127.0.0.1:{port}/console/decisions/{a['decision_id']}/review",
                                       json={"approve": True, "note": ""}, headers={"X-User-Id": "u-maya"})).json()
                check(rv["status"] == "Held" and "consent" in (rv.get("note") or "").lower(),
                      f"approved afterwards -> held by the send-time check: {rv.get('note')}")
                v = result(await s.call_tool("get_recovery_strategy", {"account": {
                    **PRIYA, "account_id": b["customer"]["account_id"], "vulnerability_flag": True}}))
                check(v["action"] == "refer_to_specialist" and v.get("cancelled_decisions") == [b["decision_id"]],
                      f"vulnerability flag arrives -> referred, and {b['decision_id']} is cancelled")
                async with httpx.AsyncClient() as h:
                    rv = await h.post(f"http://127.0.0.1:{port}/console/decisions/{b['decision_id']}/review",
                                      json={"approve": True, "note": ""}, headers={"X-User-Id": "u-maya"})
                check(rv.status_code == 409, "the cancelled offer can no longer be approved (409)")
                got = result(await s.call_tool("get_decision", {"decision_id": b["decision_id"]}))
                check(got["action"] == "cancelled", f"get_decision reports it: {got['action']}")

            print("\n6. Batch and reference data")
            batch = result(await s.call_tool("get_recovery_strategies", {"accounts": [
                {"account_id": f"NOVA-BATCH-{i}", "days_past_due": d, "current_balance": b}
                for i, (d, b) in enumerate([(15, 900), (35, 3100), (64, 6000), (95, 9000), (31, 2500)])]}))
            check(batch["accounts"] == 5, f"batch of 5: {batch['by_action']}")
            strategies = result(await s.call_tool("list_live_strategies", {}))
            check(len(strategies["strategies"]) == 5, f"{len(strategies['strategies'])} live strategies listed")
            treatments = result(await s.call_tool("list_treatments", {}))
            check(len(treatments["treatments"]) == 6, f"{len(treatments['treatments'])} treatments listed")

    print("\n7. The console sees it")
    async with httpx.AsyncClient() as h:
        st = (await h.get(f"http://127.0.0.1:{port}/console/admin/mcp", headers={"X-User-Id": "u-priya"})).json()
        check(st["stats"]["decisions"] >= 5 and st["stats"]["calls_total"] >= 20,
              f"API & Integrations: {st['stats']['calls_total']} calls, {st['stats']['decisions']} decisions, "
              f"{st['stats']['accounts']} Nova accounts")
        rows = (await h.get(f"http://127.0.0.1:{port}/console/decisions?page_size=5",
                            headers={"X-User-Id": "u-maya"})).json()["rows"]
        check(any(r["origin"] == "mcp" for r in rows), "decisions list marks Nova's decisions")
        denied = await h.get(f"http://127.0.0.1:{port}/console/admin/mcp", headers={"X-User-Id": "u-maya"})
        check(denied.status_code == 403, "a strategist cannot see the token page (403)")
        rot = (await h.post(f"http://127.0.0.1:{port}/console/admin/mcp/token/rotate",
                            headers={"X-User-Id": "u-priya"})).json()["token"]
        old = await h.post(f"http://127.0.0.1:{port}/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                           headers={"Accept": "application/json, text/event-stream", "Authorization": f"Bearer {token}"})
        new = await h.post(f"http://127.0.0.1:{port}/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                           headers={"Accept": "application/json, text/event-stream", "Authorization": f"Bearer {rot}"})
        check(old.status_code == 401 and new.status_code == 200, "rotating the token cuts the old one off at once")
        r = await h.put(f"http://127.0.0.1:{port}/console/admin/config", json={"values": {"shadow_mode": "false"}},
                        headers={"X-User-Id": "u-priya"})
        check(r.status_code == 409, "shadow mode cannot be switched off: no channel gateway is connected (409)")
        r = await h.post(f"http://127.0.0.1:{port}/console/admin/reseed")
        check(r.status_code == 401, "wiping the data without a signed-in user is refused (401)")
        r = await h.post(f"http://127.0.0.1:{port}/console/admin/reseed", headers={"X-User-Id": "u-maya"})
        check(r.status_code == 403, "a strategist cannot wipe the data (403)")


if __name__ == "__main__":
    server, port = start_server()
    try:
        asyncio.run(main(port))
    finally:
        server.should_exit = True
    print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}. Database: {TMP}")
    sys.exit(1 if failures else 0)
