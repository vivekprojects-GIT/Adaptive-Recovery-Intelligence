"""Play Nova's agent against a running ARI: send accounts over MCP, get the
recovery strategy back, then report payments so ARI learns.

    cd backend
    .venv/Scripts/python.exe tools/nova_agent_demo.py
    .venv/Scripts/python.exe tools/nova_agent_demo.py --url https://<render-host>/api/mcp --token <token>

Without --token it reads the token from the local database, which works when
ARI runs on this machine. Every account gets a fresh id, so the demo can be
run again and again; everything it records shows up in the ARI Console.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import random
import sys
import textwrap
from datetime import date

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp import ClientSession  # noqa: E402
from mcp.client.streamable_http import streamablehttp_client  # noqa: E402

RUN = random.randint(100, 999)

ACCOUNTS = [
    ("Temporary hardship, 31 days past due", {
        "account_id": f"NOVA-{RUN}-01", "customer_name": "Priya Sharma", "days_past_due": 31,
        "current_balance": 4180, "credit_limit": 5000, "opened_date": "2020-03-01", "prior_delinquencies_12m": 1,
        "on_time_payment_ratio": 0.94, "risk_segment": "Medium", "risk_score": 62, "app_user": True,
        "sms_responsive": True, "hardship_flag": True, "consent": {"sms": True, "email": True, "call": False},
        "contacts_last_7d": 1, "source_system": "CRM_PROD"}),
    ("Forgot to pay, 30 days past due", {
        "account_id": f"NOVA-{RUN}-02", "customer_name": "John Mitchell", "days_past_due": 30,
        "current_balance": 7920, "credit_limit": 9000, "opened_date": "2018-01-15", "prior_delinquencies_12m": 1,
        "on_time_payment_ratio": 0.85, "risk_segment": "Medium", "risk_score": 58, "app_user": False,
        "sms_responsive": False, "hardship_flag": False, "source_system": "CRM_PROD"}),
    ("Severe hardship, 62 days past due", {
        "account_id": f"NOVA-{RUN}-03", "customer_name": "Mike Torres", "days_past_due": 62,
        "current_balance": 7640, "credit_limit": 8000, "opened_date": "2023-02-01", "prior_delinquencies_12m": 4,
        "on_time_payment_ratio": 0.44, "risk_segment": "High", "risk_score": 77, "app_user": False,
        "sms_responsive": False, "hardship_flag": True, "source_system": "CRM_PROD"}),
    ("Vulnerable customer", {
        "account_id": f"NOVA-{RUN}-04", "days_past_due": 35, "current_balance": 2200,
        "vulnerability_flag": True, "source_system": "CRM_PROD"}),
]


def local_token() -> str:
    from app.console.mcp_server import access_token
    from app.db import SessionLocal
    db = SessionLocal()
    try:
        return access_token(db)[0]
    finally:
        db.close()


def out(r) -> dict:
    if r.isError:
        raise RuntimeError(r.content[0].text)
    return r.structuredContent


def show(label: str, d: dict) -> None:
    head = d["action"].replace("_", " ").upper()
    print(f"\n  {label}  [{d['customer']['account_id']}]")
    print(f"    -> {head}")
    for line in textwrap.wrap(d["summary"], 92):
        print(f"       {line}")
    if d.get("strategy"):
        print(f"       strategy: {d['strategy']['strategy_id']} {d['strategy']['name']}")
    if d.get("message"):
        print(f"       message:  \"{d['message'][:110]}{'...' if len(d['message']) > 110 else ''}\"")
    if d.get("decision_id"):
        print(f"       decision: {d['decision_id']}")


async def main(url: str, token: str) -> None:
    async with streamablehttp_client(url, headers={"Authorization": f"Bearer {token}"}) as (read, write, _):
        async with ClientSession(read, write) as s:
            init = await s.initialize()
            tools = (await s.list_tools()).tools
            print(f"Connected to {init.serverInfo.name} over MCP {init.protocolVersion}: {len(tools)} tools")
            print("  " + ", ".join(t.name for t in tools))

            print("\n1. Nova sends accounts; ARI returns the recovery strategy")
            decided = []
            for label, account in ACCOUNTS:
                d = out(await s.call_tool("get_recovery_strategy", {"account": account}))
                show(label, d)
                decided.append(d)

            print("\n2. A cohort handoff: ten accounts in one call")
            batch = [{"account_id": f"NOVA-{RUN}-B{i:02d}", "days_past_due": random.choice([12, 31, 33, 45, 61, 64]),
                      "current_balance": random.choice([900, 1800, 3200, 4600, 6400]),
                      "app_user": random.random() < 0.6, "sms_responsive": random.random() < 0.7,
                      "hardship_flag": random.random() < 0.5, "on_time_payment_ratio": round(random.uniform(0.6, 0.98), 2),
                      "opened_date": f"{random.randint(2012, 2022)}-06-01"} for i in range(10)]
            b = out(await s.call_tool("get_recovery_strategies", {"accounts": batch}))
            print("  " + ", ".join(f"{n} {k.replace('_', ' ')}" for k, n in b["by_action"].items()))
            decided += b["results"]

            print("\n3. Nova reports what happened; ARI learns")
            reported = 0
            for d in decided:
                if d.get("action") not in ("contact", "control_bau") or not d.get("decision_id"):
                    continue
                paid = random.random() < 0.45
                r = out(await s.call_tool("report_payment_outcome", {
                    "decision_id": d["decision_id"], "paid": paid,
                    **({"payment_date": date.today().isoformat()} if paid else {})}))
                reported += 1
                print(f"  {d['decision_id']}: {'paid' if paid else 'not paid'} - {r['note']}")
            if not reported:
                print("  (nothing contacted automatically this run - forbearance offers wait in the Review Queue)")

            print("\n4. The live strategies, as Nova sees them")
            for st in out(await s.call_tool("list_live_strategies", {}))["strategies"]:
                res, lead = st["results"], st["leading_treatment"]
                up = f"{res['uplift'] * 100:+.1f} pp vs control" if res["uplift"] is not None else "no control yet"
                print(f"  {st['strategy_id']} {st['name']}: {res['treated']} treated, {up}"
                      + (f"; most likely best: {lead['code']} ({lead['probability_best']:.0%})" if lead else ""))
    print("\nOpen the ARI Console: Decisions (Nova's are marked), Review Queue, API & Integrations.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--url", default="http://127.0.0.1:8000/mcp", help="ARI's MCP endpoint")
    ap.add_argument("--token", default=os.getenv("ARI_MCP_TOKEN"), help="Access token (default: read locally)")
    args = ap.parse_args()
    asyncio.run(main(args.url, args.token or local_token()))
