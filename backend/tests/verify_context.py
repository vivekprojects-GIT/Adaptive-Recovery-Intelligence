"""End-to-end check of RecoveryContext v1, the frozen feature snapshot, the
per-rule eligibility record and the freshness checks - over the real MCP
protocol, on a throwaway database. The v0 payload must keep working exactly
as before.

    cd backend
    .venv/Scripts/python.exe tests/verify_context.py      (Windows)
    .venv/bin/python tests/verify_context.py              (macOS / Linux)

Exits non-zero if any check fails.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import socket
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TMP = tempfile.mkdtemp(prefix="ari-context-")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(TMP, 'context.db')}"
os.environ.pop("ARI_MCP_TOKEN", None)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from mcp import ClientSession  # noqa: E402
from mcp.client.streamable_http import streamablehttp_client  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import models  # noqa: E402
from app.console import mcp_server  # noqa: E402
from app.console.models import ContactRecord, Decision, EligibilityEval, FeatureSnapshot, Nudge, Outcome  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402

UTC = timezone.utc
NOW = datetime.now(UTC)
failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


def ago(hours: float) -> str:
    return (NOW - timedelta(hours=hours)).isoformat()


def merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in over.items():
        out[k] = merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def v1(tag: str, **over) -> dict:
    """A complete, fresh RecoveryContext v1 - a 31 DPD account that can be helped."""
    base = {
        "contract_version": "v1", "request_id": f"REQ-{tag}", "as_of_timestamp": ago(1), "source_system": "NOVA_TEST",
        "party": {"party_id": f"P-{tag}", "name": "Priya Sharma"},
        "account": {"account_id": f"V1-{tag}", "balance": 4180, "credit_limit": 5000, "status": "DELINQUENT",
                    "opened_date": "2020-03-01", "product_type": "CREDIT_CARD"},
        "delinquency": {"dpd": 31, "amount_past_due": 620, "cycles_delinquent": 1, "prior_delinquencies_12m": 1,
                        "on_time_payment_ratio": 0.94},
        "risk": {"segment": "Medium", "score": 62},
        "behavior": {"app_user": True, "sms_responsive": True, "hardship_flag": True},
        "arrangement": {"active": False, "promise_to_pay_status": "NONE"},
        "contact_context": {"timezone": "America/Chicago", "sms_allowed": True, "email_allowed": True,
                            "call_allowed": False, "recent_sms": 1, "recent_calls": 0},
        "restrictions": {"cease_communication": False, "bankruptcy": False, "attorney_represented": False,
                         "deceased": False, "scra_protected": False, "dispute_pending": False,
                         "agency_placed": False, "vulnerable": False},
        "data_freshness": {"consent_as_of": ago(2), "contact_history_as_of": ago(2), "restrictions_as_of": ago(2),
                           "arrangement_as_of": ago(2)},
    }
    return merge(base, over)


V0 = {"customer_name": "Priya Sharma", "days_past_due": 31, "current_balance": 4180, "credit_limit": 5000,
      "opened_date": "2020-03-01", "prior_delinquencies_12m": 1, "on_time_payment_ratio": 0.94, "risk_segment": "Medium",
      "risk_score": 62, "app_user": True, "sms_responsive": True, "hardship_flag": True,
      "consent": {"sms": True, "email": True, "call": False}, "contacts_last_7d": 1}


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


def evals_of(decision_id: str) -> list[EligibilityEval]:
    db = SessionLocal()
    try:
        return db.query(EligibilityEval).filter(EligibilityEval.decision_id == decision_id).all()
    finally:
        db.close()


def snapshot_of(decision_id: str) -> FeatureSnapshot | None:
    db = SessionLocal()
    try:
        return db.query(FeatureSnapshot).filter(FeatureSnapshot.decision_id == decision_id).first()
    finally:
        db.close()


async def main(port: int) -> None:
    db = SessionLocal()
    token = mcp_server.access_token(db)[0]
    db.close()
    async with streamablehttp_client(f"http://127.0.0.1:{port}/mcp", headers={"Authorization": f"Bearer {token}"}) as (r, w, _):
        async with ClientSession(r, w) as s:
            await s.initialize()

            async def ask(tool="get_recovery_strategy", **args):
                return result(await s.call_tool(tool, args))

            print("\n1. v0 keeps working, and says how it was read")
            out = await ask(account={**V0, "account_id": "V0-1", "eligible_strategies": ["S9"]})
            check(out["contract_version"] == "v0" and out["strategy"]["strategy_id"] == "STR-021"
                  and out["action"] in ("awaiting_approval", "contact", "contact_failed", "control_bau"),
                  f"v0 account decided as before: {out['action']} in {out['strategy']['strategy_id']}")
            check(out["ignored_fields"] == ["eligible_strategies"],
                  f"a field outside the contract is listed back, not silently dropped: {out['ignored_fields']}")
            fs = snapshot_of(out["decision_id"])
            check(fs is not None and fs.contract_version == "v0" and json.loads(fs.raw_payload)["eligible_strategies"]
                  == ["S9"], "v0 decision has a frozen snapshot holding the raw payload as sent")
            r0 = await s.call_tool("get_recovery_strategy", {})
            check(r0.isError, "a request with neither `account` nor `context` is refused")

            print("\n2. RecoveryContext v1")
            ctx = v1("A", bogus=1, account={"foo": 2})
            out = await ask(context=ctx)
            did = out["decision_id"]
            check(out["contract_version"] == "v1" and out["request_id"] == "REQ-A" and did,
                  f"v1 context decided: {out['action']}, {did}")
            check({"bogus", "account.foo"} <= set(out["ignored_fields"]),
                  f"unknown v1 fields listed: {out['ignored_fields']}")
            check("account.balance -> account.current_balance" in out["aliases_used"]
                  and "delinquency.dpd -> delinquency.days_past_due" in out["aliases_used"],
                  f"aliases recorded: {out['aliases_used']}")
            fs = snapshot_of(did)
            raw = json.loads(fs.raw_payload)
            lineage = json.loads(fs.source_lineage)
            stale = json.loads(fs.staleness)
            check(raw["account"]["balance"] == 4180 and raw["bogus"] == 1, "raw v1 payload stored verbatim")
            check(fs.as_of_ts is not None and fs.request_id == "REQ-A" and fs.feature_set_version == "ari-features/1",
                  f"snapshot: as-of {fs.as_of_ts[:16]}, request REQ-A, {fs.feature_set_version}")
            check(lineage["source_system"] == "NOVA_TEST" and lineage["contract_version"] == "v1",
                  f"source lineage: {lineage['source']} / {lineage['source_system']}")
            check(all(v["status"] == "fresh" for v in stale.values()), "staleness flags: "
                  + ", ".join(f"{k} {v['status']}" for k, v in stale.items()))
            check({"risk_score", "product", "account_status"} <= set(json.loads(fs.lineage_only)),
                  "fields stored but not used to decide are listed as lineage-only")
            again = await ask(context=ctx)
            check(again["decision_id"] == did and again["existing"], "the same request_id returns the same decision")

            print("\n3. Every rule, for every candidate treatment")
            rows = evals_of(did)
            arms = {e.arm_id for e in rows}
            check(arms == {"S3", "S1", "S2"}, f"rules evaluated for all of STR-021's treatments: {sorted(arms)}")
            per_arm = {a: [e for e in rows if e.arm_id == a] for a in arms}
            check(all(len(v) >= 14 for v in per_arm.values()),
                  "each treatment has its playbook, business, hard-stop, contact and context rules: "
                  + ", ".join(f"{a} {len(v)}" for a, v in sorted(per_arm.items())))
            check(all(e.rule_version and e.evaluated_at and e.input_refs for e in rows),
                  "every row carries rule version, evaluation time and the inputs it read")
            # SMS consent withdrawn AND consent stale: both reasons must be kept, nothing short-circuits.
            out = await ask(context=v1("B", contact_context={"sms_allowed": False},
                                       data_freshness={"consent_as_of": ago(72)}))
            sms_rows = [e for e in evals_of(out["decision_id"]) if e.arm_id == "S1" and e.result == "BLOCK"]
            codes = {e.reason_code for e in sms_rows}
            check({"NO_SMS_CONSENT", "CONSENT_STALE"} <= codes,
                  "a blocked treatment keeps every reason: S1 blocked by {sorted(codes)}")
            b = next(x for x in out["blocked_treatments"] if x["code"] == "S1")
            check(len(b["reasons"]) >= 2, f"the answer lists them too: {[x['reason_code'] for x in b['reasons']]}")
            s2 = [e for e in evals_of(out["decision_id"]) if e.arm_id == "S2"]
            check(s2 and all(e.result == "PASS" for e in s2) and out["group"] != "Excluded",
                  f"the app push, which needs no SMS consent, passes all {len(s2)} of its rules and stays allowed "
                  f"({out['action']})")

            print("\n4. Freshness: fails closed for v1 only")
            out = await ask(context=v1("C", data_freshness={"contact_history_as_of": ago(100)}))
            check(out["action"] == "blocked_stale_data" and out["group"] == "Excluded",
                  f"v1 contact history 100h old (placeholder limit 24h) -> {out['action']}: {out['summary'][:90]}")
            out0 = await ask(account={**V0, "account_id": "V0-STALE", "as_of_timestamp": ago(100),
                                      "data_freshness": {"consent_as_of": ago(100)}})
            codes0 = {e.reason_code for e in evals_of(out0["decision_id"]) if "FRESHNESS" in e.rule_id}
            check(out0["action"] != "blocked_stale_data" and codes0 == {"NOT_ENFORCED_V0"},
                  f"the same staleness on a v0 request is logged, not enforced: {out0['action']}, {sorted(codes0)}")
            ctx_d = v1("D")
            del ctx_d["restrictions"]
            out = await ask(context=ctx_d)
            check(out["action"] == "blocked_stale_data" and all(
                any(e.reason_code == "RESTRICTIONS_MISSING" for e in evals_of(out["decision_id"]) if e.arm_id == a)
                for a in ("S1", "S2", "S3")),
                f"v1 without a restrictions block -> {out['action']}, RESTRICTIONS_MISSING on every treatment")
            ctx_e = v1("E")
            del ctx_e["contact_context"]["sms_allowed"]
            out = await ask(context=ctx_e)
            s1 = {e.reason_code for e in evals_of(out["decision_id"]) if e.arm_id == "S1" and e.result == "BLOCK"}
            check("CONSENT_MISSING" in s1, f"v1 without an SMS consent flag blocks SMS treatments: {sorted(s1)}")

            print("\n5. Hard stops and business context")
            out = await ask(context=v1("F", restrictions={"bankruptcy": True}))
            rows_f = evals_of(out["decision_id"])
            check(out["action"] == "restricted" and out["group"] == "Excluded" and all(
                any(e.reason_code == "RESTRICTION_BANKRUPTCY" for e in rows_f if e.arm_id == a) for a in ("S1", "S2", "S3")),
                f"bankruptcy -> {out['action']}, recorded against every treatment")
            pend = None
            for i in range(30):
                o = await ask(context=v1(f"G{i}"))
                if o["action"] == "awaiting_approval":
                    pend = o
                    break
            if pend:
                stop = await ask(context=v1(f"G{i}-2", account={"account_id": pend["customer"]["account_id"]},
                                            restrictions={"cease_communication": True}))
                check(stop["action"] == "restricted" and stop.get("cancelled_decisions") == [pend["decision_id"]],
                      f"cease communication arrives -> {stop['action']}, {pend['decision_id']} cancelled")
            else:
                check(False, "no offer waiting for review to cancel")
            # The arrangement / PTP rule is PENDING_BUSINESS_CONFIRMATION: off by default, recorded, never blocking.
            out = await ask(context=v1("H", arrangement={"active": True, "type": "PAYMENT_PLAN"}))
            arr = [e for e in evals_of(out["decision_id"]) if e.arm_id == "S3" and e.rule_id == "ARRANGEMENT"]
            check(len(arr) == 1 and arr[0].result == "PASS" and arr[0].reason_code == "PENDING_BUSINESS_CONFIRMATION"
                  and "would block" in arr[0].reason,
                  f"by default the arrangement rule does not block: {arr and arr[0].reason_code} - "
                  f"{arr and arr[0].reason}")
            async with httpx.AsyncClient() as h:
                cfg_url = f"http://127.0.0.1:{port}/console/admin/config"
                admin = {"X-User-Id": "u-priya"}
                await h.put(cfg_url, json={"values": {"arrangement_blocks_new_offers": "true"}}, headers=admin)
                out = await ask(context=v1("H2", arrangement={"active": True, "type": "PAYMENT_PLAN"}))
                s3 = {e.reason_code for e in evals_of(out["decision_id"]) if e.arm_id == "S3" and e.result == "BLOCK"}
                check(s3 == {"ACTIVE_ARRANGEMENT"} and (out["treatment"] or {}).get("code") != "S3",
                      f"switched on by an admin, an arrangement in force blocks a new plan offer: {sorted(s3)}")
                out = await ask(context=v1("I", arrangement={"promise_to_pay_status": "PENDING",
                                                             "promise_to_pay_date": "2026-10-20"}))
                s3 = {e.reason_code for e in evals_of(out["decision_id"]) if e.arm_id == "S3" and e.result == "BLOCK"}
                check(s3 == {"PTP_PENDING"}, f"and a pending promise to pay blocks it too: {sorted(s3)}")
                await h.put(cfg_url, json={"values": {"arrangement_blocks_new_offers": "false"}}, headers=admin)
            out = await ask(context=v1("I2", data_freshness={"consent_as_of": ago(72)}))
            stale = next(e for e in evals_of(out["decision_id"]) if e.rule_id == "CONSENT_FRESHNESS" and e.result == "BLOCK")
            check("placeholder" in stale.reason and json.loads(stale.input_refs)["sla_status"] == "COMPLIANCE_PLACEHOLDER",
                  f"a freshness block says its limit is a placeholder: {stale.reason}")

            print("\n6. Time zone")
            sent = None
            for i in range(30):
                o = await ask(context=v1(f"TZ{i}", account={"balance": 1200, "credit_limit": 2000,
                                                            "opened_date": "2015-01-01"},
                                         delinquency={"dpd": 12, "amount_past_due": 85, "prior_delinquencies_12m": 0,
                                                      "on_time_payment_ratio": 0.95},
                                         contact_context={"timezone": "Asia/Tokyo"}))
                if o["action"] == "contact":
                    sent = o
                    break
            if sent:
                db = SessionLocal()
                n = db.query(Nudge).filter(Nudge.decision_id == sent["decision_id"]).first()
                cr = db.query(ContactRecord).filter(ContactRecord.nudge_id == n.nudge_id).first()
                db.close()
                local = datetime.fromisoformat(n.scheduled_at).astimezone(__import__("zoneinfo").ZoneInfo("Asia/Tokyo"))
                check(cr.local_hour == local.hour and 9 <= local.hour < 19,
                      f"send time is in the customer's time zone: {n.scheduled_at} UTC = {local:%H:%M} Tokyo")
            else:
                check(False, "no automatic contact to check the send time on")

            print("\n7. The snapshot is the record of the decision")
            first = await ask(context=v1("J"))
            fid = first["decision_id"]
            later = await ask(context=v1("J-2", account={"account_id": "V1-J", "balance": 9000, "credit_limit": 9500},
                                         delinquency={"dpd": 95}))
            db = SessionLocal()
            fs = db.query(FeatureSnapshot).filter(FeatureSnapshot.decision_id == fid).first()
            cust_dpd = db.get(models.Customer, db.get(Decision, fid).customer_id).days_past_due
            feats = json.loads(fs.features)
            try:
                fs.features = "{}"
                db.commit()
                immutable = False
            except ValueError:
                db.rollback()
                immutable = True
            db.close()
            check(later["existing"] and feats["days_past_due"] == 31 and cust_dpd == 95,
                  f"re-sent at 95 DPD: snapshot still says {feats['days_past_due']} DPD, today's record says "
                  f"{cust_dpd}")
            check(immutable, "a snapshot cannot be rewritten (the ORM refuses the update)")
            async with httpx.AsyncClient() as h:
                audit = (await h.get(f"http://127.0.0.1:{port}/console/decisions/{fid}",
                                     headers={"X-User-Id": "u-maya"})).json()
            check(audit["snapshot"]["days_past_due"] == 31 and audit["context"]["request_id"] == "REQ-J"
                  and len(audit["evaluations"]) == len(evals_of(fid)),
                  "the decision audit screen reads the snapshot and the rule results, not today's record")

            print("\n8. Outcomes: report_payment_outcome unchanged")
            contact = None
            for i in range(30):
                o = await ask(context=v1(f"K{i}", behavior={"hardship_flag": False},
                                         account={"balance": 1200, "credit_limit": 2000, "opened_date": "2015-01-01"},
                                         delinquency={"dpd": 12, "amount_past_due": 85, "prior_delinquencies_12m": 0,
                                                      "on_time_payment_ratio": 0.95}))
                if o["action"] == "contact":
                    contact = o
                    break
            rep = await ask("report_payment_outcome", decision_id=contact["decision_id"], paid=True)
            db = SessionLocal()
            o = db.query(Outcome).filter(Outcome.decision_id == contact["decision_id"]).first()
            db.close()
            check(rep["learned"] and o.reward == 1.0 and o.amount == 85 and o.reward_policy == "binary-paid-in-window/1",
                  f"paid -> learned, amount defaults to Nova's amount_past_due ({o.amount:g}), policy {o.reward_policy}")
            excl = await s.call_tool("report_payment_outcome", {"decision_id": (await ask(
                context=v1("L", restrictions={"deceased": True})))["decision_id"], "paid": True})
            check(excl.isError, "an excluded decision has no outcome to report (refused with a reason)")

            print("\n9. Preview records nothing")
            db = SessionLocal()
            before = (db.query(Decision).count(), db.query(FeatureSnapshot).count(), db.query(EligibilityEval).count())
            db.close()
            pv = await ask("preview_recovery_strategy", context=v1("M"))
            db = SessionLocal()
            after = (db.query(Decision).count(), db.query(FeatureSnapshot).count(), db.query(EligibilityEval).count())
            db.close()
            check(before == after and pv["decision_id"] is None and pv["context"]["contract_version"] == "v1",
                  f"v1 preview: {pv['action']}, nothing stored")


def migration() -> None:
    """A database from before P1: no snapshot or rule tables, none of the new
    columns. Startup must bring it up to date without losing a decision."""
    print("\n10. Migration of a pre-P1 database")
    from app.console.seed import ensure_console
    from app.core.database import Base, engine
    db = SessionLocal()
    decisions = db.query(Decision).count()
    for stmt in ("DROP TABLE eligibility_evals", "DROP TABLE feature_snapshots",
                 "DROP INDEX IF EXISTS ix_decisions_request_id",
                 "ALTER TABLE decisions DROP COLUMN contract_version", "ALTER TABLE decisions DROP COLUMN request_id",
                 "ALTER TABLE decisions DROP COLUMN context_as_of", "ALTER TABLE decisions DROP COLUMN feature_snapshot_id",
                 "ALTER TABLE outcomes DROP COLUMN reward_policy"):
        db.execute(text(stmt))
    db.commit()
    db.close()
    Base.metadata.create_all(engine)  # what startup does first
    db = SessionLocal()
    ensure_console(db)
    cols = {r[1] for r in db.execute(text("PRAGMA table_info(decisions)"))}
    legacy = db.query(FeatureSnapshot).filter(FeatureSnapshot.contract_version == "legacy").count()
    linked = db.query(Decision).filter(Decision.feature_snapshot_id.isnot(None)).count()
    scored = db.query(Outcome).filter(Outcome.reward.isnot(None), Outcome.reward_policy.is_(None)).count()
    after = db.query(Decision).count()
    ensure_console(db)  # a second start changes nothing
    twice = db.query(FeatureSnapshot).count()
    db.close()
    check({"contract_version", "request_id", "context_as_of", "feature_snapshot_id"} <= cols,
          "the new decision columns are added")
    check(after == decisions and linked == decisions and legacy == decisions,
          f"all {decisions} existing decisions kept, each given a legacy snapshot")
    check(scored == 0, "existing outcomes are tagged with the binary reward policy")
    check(twice == legacy, "running the migration again is a no-op")


if __name__ == "__main__":
    server, port = start_server()
    try:
        asyncio.run(main(port))
    finally:
        server.should_exit = True
        time.sleep(1)
    migration()
    print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}. Database: {TMP}")
    sys.exit(1 if failures else 0)
