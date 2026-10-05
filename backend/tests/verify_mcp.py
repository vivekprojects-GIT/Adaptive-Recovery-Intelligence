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
from app.db import SessionLocal  # noqa: E402

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
    for _ in range(600):
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
            check(priya["action"] in ("awaiting_approval", "contact", "contact_blocked", "control_bau"),
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

            print("\n3. Contact rules travel with the decision")
            blocked = None
            for i in range(12):  # C1, no app: only the SMS reminder is eligible; skip control draws
                acc = {"account_id": f"NOVA-SMS-{i}", "days_past_due": 12, "current_balance": 1200,
                       "credit_limit": 2000, "opened_date": "2016-05-01", "prior_delinquencies_12m": 0,
                       "on_time_payment_ratio": 0.95, "app_user": False, "sms_responsive": True,
                       "hardship_flag": True, "consent": {"sms": False}}
                r = result(await s.call_tool("get_recovery_strategy", {"account": acc}))
                if r["group"] == "Treatment":
                    blocked = r
                    break
            check(blocked is not None and blocked["action"] == "contact_blocked"
                  and "consent" in (blocked["contact"] or {}).get("guard", ""),
                  f"no SMS consent -> {blocked and blocked['action']}: {blocked and (blocked['contact'] or {}).get('guard')}")
            capped = None
            for i in range(12):
                acc = {**PRIYA, "account_id": f"NOVA-CAP-{i}", "contacts_last_7d": 7, "consent": None}
                r = result(await s.call_tool("get_recovery_strategy", {"account": acc}))
                if r["group"] == "Treatment" and r["action"] != "awaiting_approval":
                    capped = r
                    break
            check(capped is not None and capped["action"] == "contact_blocked"
                  and "cap" in (capped["contact"] or {}).get("guard", "").lower(),
                  f"7 contacts already made elsewhere -> {capped and (capped['contact'] or {}).get('guard')}")

            print("\n4. Outcomes teach the model")
            contacted = None
            for i in range(30):
                acc = {**PRIYA, "account_id": f"NOVA-LEARN-{i}", "consent": None, "contacts_last_7d": 0,
                       "hardship_flag": False}
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


if __name__ == "__main__":
    server, port = start_server()
    try:
        asyncio.run(main(port))
    finally:
        server.should_exit = True
    print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}. Database: {TMP}")
    sys.exit(1 if failures else 0)
