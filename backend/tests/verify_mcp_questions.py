"""End-to-end check of the MCP question tools, over the real protocol, on a
throwaway database: plain-English questions about the accounts, and the
recovery knowledge graph (taxonomy, search, node, traverse, count, path).

    cd backend
    .venv/Scripts/python.exe tests/verify_mcp_questions.py      (Windows)
    .venv/bin/python tests/verify_mcp_questions.py              (macOS / Linux)

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

TMP = tempfile.mkdtemp(prefix="ari-mcpq-")
os.environ["DATABASE_URL"] = os.environ.get("ARI_TEST_DATABASE_URL") or f"sqlite:///{os.path.join(TMP, 'q.db')}"
os.environ.pop("ARI_MCP_TOKEN", None)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import uvicorn  # noqa: E402
from mcp import ClientSession  # noqa: E402
from mcp.client.streamable_http import streamablehttp_client  # noqa: E402

from app import models  # noqa: E402
from app.console import mcp_server  # noqa: E402
from app.console.models import AuditEvent  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402

failures: list[str] = []
QUESTION_TOOLS = {"ask_portfolio", "get_taxonomy", "search_graph", "get_node", "traverse_graph", "count_by",
                  "how_connected"}


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


def start_server() -> tuple[uvicorn.Server, int]:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config("app.main:app", host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(1200):
        if server.started:
            return server, port
        time.sleep(0.05)
    raise SystemExit("API did not start")


def result(r) -> dict:
    if r.isError:
        raise AssertionError(r.content[0].text if r.content else "tool error")
    return r.structuredContent if r.structuredContent is not None else json.loads(r.content[0].text)


async def main(port: int) -> None:
    db = SessionLocal()
    token = mcp_server.access_token(db)[0]
    names = [n for (n,) in db.query(models.Customer.name)]
    retail_60 = db.query(models.Customer).filter(models.Customer.product == "Retail Card",
                                                 models.Customer.days_past_due > 60).count()
    db.close()

    async with streamablehttp_client(f"http://127.0.0.1:{port}/mcp",
                                     headers={"Authorization": f"Bearer {token}"}) as (read, write, _):
        async with ClientSession(read, write) as s:
            await s.initialize()
            tools = {t.name: t for t in (await s.list_tools()).tools}
            check(QUESTION_TOOLS <= set(tools), "all seven question tools are listed")
            check(all(tools[n].annotations.readOnlyHint for n in QUESTION_TOOLS), "every question tool is read-only")

            print("\n1. Plain-English questions")
            r = result(await s.call_tool("ask_portfolio", {"question": "retail card accounts over 60 days past due"}))
            check(r["accounts"] == retail_60, f"retail card, over 60 days past due: {r['accounts']} accounts, "
                                              f"the same as a direct query ({retail_60})")
            check("WHERE" in r["sql"] and "days_past_due > 60" in r["sql"], "the answer shows the SQL it ran")
            check(r["answer"].startswith(f"{retail_60:,} accounts match"), f"plain answer: {r['answer'][:90]}...")
            check(sum(r["by_card_business"].values()) == retail_60 and set(r["by_card_business"]) == {"Retail Card"},
                  "the breakdown by card business adds up")
            text = json.dumps(r)
            check(not any(n and n in text for n in names[:300]), "no customer name appears in the answer")
            r = result(await s.call_tool("ask_portfolio", {"question": "high risk customers who use the app "
                                                                       "and like purple"}))
            check(r["not_understood"] and "purple" in r["not_understood"], "words it cannot read are reported, not guessed")
            r = await s.call_tool("ask_portfolio", {"question": "which strategy works best"})
            check(r.isError and "No conditions" in r.content[0].text and "count_by" in r.content[0].text,
                  "a question with no conditions is refused, pointing to the graph tools")
            for q, want in (("likely self-cure customers in the 30 days late group",
                             ["Days late: 30 days late", "Fit group: Likely self-cure"]),
                            ("customers who have been with us more than 10 years", ["Years as a customer over 10"]),
                            ("customers who missed more than 2 payments in the last year",
                             ["Missed payments, last 12 months over 2"]),
                            ("how many customers owe more than 20000", ["Total balance over $20,000"])):
                r = result(await s.call_tool("ask_portfolio", {"question": q, "limit": 1}))
                check(sorted(r["understood"]) == sorted(want) and not r["not_understood"],
                      f"'{q}' -> {', '.join(r['understood'])}, nothing left over")

            print("\n2. Taxonomy and search")
            t = result(await s.call_tool("get_taxonomy", {}))
            check(t["taxonomy"]["class"] == "Thing" and t["nodes"] > 1000 and t["edges"] > t["nodes"],
                  f"taxonomy: {t['nodes']} nodes, {t['edges']} edges")
            check({"HOLDS", "CHOSE", "RESULTED_IN", "WITH_AGENCY"} <= {x["name"] for x in t["relationships"]},
                  "relationship types listed")
            r = result(await s.call_tool("search_graph", {"node_class": "Treatment"}))
            check(r["returned"] >= 6 and all(m["id"].startswith("treatment:") for m in r["matches"]),
                  f"search by class: {r['returned']} treatments")
            r = result(await s.call_tool("search_graph", {"text": "payment plan", "node_class": "Treatment"}))
            check(any(m["id"] == "treatment:S3" for m in r["matches"]), "search by text finds Split Payment Plan")

            print("\n3. Node, traverse, count, path")
            n = result(await s.call_tool("get_node", {"node_id": "treatment:S3"}))
            check(n["is_a"][:3] == ["Thing", "Treatment", "Arrangement"], f"S3 is a {' > '.join(n['is_a'])}")
            check(any(x["rel"] == "CHOSE" for x in n["incoming"]), "S3 shows the decisions that chose it")
            r = await s.call_tool("get_node", {"node_id": "treatment:NOPE"})
            check(r.isError and "No node" in r.content[0].text, "an unknown node is refused with the reason")
            r = result(await s.call_tool("traverse_graph", {"start": "treatment:S3", "path": ["~CHOSE", "RESULTED_IN"],
                                                            "where": {"paid": True}}))
            check(r["total"] >= 0 and all(x["props"]["paid"] for x in r["nodes"]),
                  f"S3 > decisions > paid outcomes: {r['total']}")
            r = result(await s.call_tool("count_by", {"node_class": "Customer", "group_by": "HOLDS"}))
            check({g["group"] for g in r["groups"]} >= {"Consumer Credit Card", "Retail Card"}
                  and sum(g["count"] for g in r["groups"]) == r["total"], "customers counted by card business")
            r = result(await s.call_tool("how_connected", {"a": "agency:AGY-01", "b": "product:consumer-credit-card"}))
            check(r["connected"] and len(r["steps"]) >= 1, f"agency to product: {len(r['steps'])} hop(s)")

    db = SessionLocal()
    audited = {e.entity_id for e in db.query(AuditEvent).filter(AuditEvent.entity == "mcp")}
    db.close()
    check(QUESTION_TOOLS <= audited, "every question is in the audit log")


if __name__ == "__main__":
    server, port = start_server()
    try:
        asyncio.run(main(port))
    finally:
        server.should_exit = True
    print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}. Database: {TMP}")
    sys.exit(1 if failures else 0)
