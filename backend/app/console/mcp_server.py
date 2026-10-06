"""ARI as an MCP server: how an agent - Nova's, or any other - asks for a
recovery decision and reports what happened.

Transport: Streamable HTTP, stateless, plain JSON responses. Every call stands
alone, so any MCP client (the Python SDK, Claude, an enterprise agent
platform) can call it without session affinity. Served at /mcp, and at
/api/mcp behind the production entrypoint.

Auth: a bearer token. ARI_MCP_TOKEN in the environment wins; otherwise ARI
generates one on first use and keeps it in platform config, where an admin
reveals or rotates it under API & Integrations. DNS-rebinding protection is
left off: it exists for unauthenticated local servers, and a page in someone's
browser cannot present the token.

Every call is written to the audit log as the Nova agent.

No `from __future__ import annotations` here: FastMCP inspects the tool
signatures at registration and needs real types, not strings.
"""
import hmac
import os
import secrets
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Any, Literal

import anyio
from mcp.server.fastmcp import FastMCP
from mcp.shared.version import SUPPORTED_PROTOCOL_VERSIONS
from mcp.types import ToolAnnotations
from pydantic import Field
from sqlalchemy.orm import Session
from starlette.responses import JSONResponse

from ..db import SessionLocal
from . import nova
from .contract import NovaAccount, RecoveryContextV1
from .engine import ENGINE_LOCK
from .models import AuditEvent, Decision, ExternalCustomer, Outcome, PlatformConfig
from .platform import audit, now

UTC = timezone.utc
TOKEN_KEY = "_mcp_token"
ENDPOINT_PATH = "/mcp"
MAX_BATCH = 100

INSTRUCTIONS = """ARI (Adaptive Recovery Intelligence) decides the recovery action for delinquent accounts.

Send an account's context with get_recovery_strategy. ARI finds the live strategy that owns the account
and holds a random share out as a control group. For the rest, consent, opt-outs and contact caps first
decide which of the business-approved treatments the customer may receive; Thompson sampling, with a
customer-fit adjustment, then chooses among those. Payment plans, deferrals and hardship offers wait for a
person to approve them, and the contact rules are checked again when they do. Sends are simulated: no
channel gateway is connected. The answer says what to do, why, and what happens next.

Two request shapes are accepted. `account` is the original flat payload (contract v0), unchanged.
`context` is RecoveryContext v1: request_id, as_of_timestamp, party, account, delinquency, arrangement,
per-channel contact context, restrictions and freshness timestamps; under v1, missing or stale consent,
contact history or restrictions block the affected treatments (fail closed). Every answer lists any fields
ARI ignored and any values it had to assume.

Report every payment outcome with report_payment_outcome. Treated outcomes teach the model; control
outcomes measure how much the strategy actually adds. Use preview_recovery_strategy to ask without
recording anything."""

server = FastMCP(name="ari-recovery-agent", instructions=INSTRUCTIONS, stateless_http=True, json_response=True,
                 log_level="WARNING")
server.streamable_http_app()  # creates the session manager the gateway below hands requests to

# What the console shows about each tool.
TOOLS: list[dict] = []


def _tool(name: str, title: str, *, read_only: bool = False, idempotent: bool = True):
    def register(fn):
        TOOLS.append({"name": name, "title": title, "read_only": read_only,
                      "description": (fn.__doc__ or "").strip().split("\n\n")[0].replace("\n", " ")})
        return server.tool(name=name, title=title, annotations=ToolAnnotations(
            title=title, readOnlyHint=read_only, destructiveHint=False, idempotentHint=idempotent,
            openWorldHint=False))(fn)
    return register


async def _call(tool: str, work, summarize, action: str = "READ") -> Any:
    """Run a call off the event loop, one writer at a time, and audit it."""
    def run():
        db = SessionLocal()
        try:
            with ENGINE_LOCK:
                try:
                    result = work(db)
                except (nova.NovaError, ValueError) as e:
                    db.rollback()
                    audit(db, nova.ACTOR, action, "mcp", tool, f"{tool} refused: {e}")
                    db.commit()
                    raise
                audit(db, nova.ACTOR, action, "mcp", tool, summarize(result))
                db.commit()
                return result
        finally:
            db.close()
    return await anyio.to_thread.run_sync(run)


def _decided(r: dict) -> str:
    who = r.get("customer", {}).get("account_id", "?")
    if not r.get("strategy"):
        return f"{who}: {r['action'].replace('_', ' ')}"
    t = r.get("treatment") or {}
    arm = t.get("code") or ("control" if r.get("group") == "Control" else "no treatment")
    return (f"{who}: {r['strategy']['strategy_id']} {arm} "
            f"- {r['action'].replace('_', ' ')}" + (" (existing)" if r.get("existing") else ""))


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------
ACCOUNT_HELP = "Contract v0: the flat account payload. Send this or `context`, not both."
CONTEXT_HELP = ("RecoveryContext v1 (contract_version 'v1'). Send this or `account`, not both. Missing or stale "
                "guardrail data fails closed.")


def _one(account, context):
    if (account is None) == (context is None):
        raise ValueError("Send exactly one of `account` (contract v0) or `context` (RecoveryContext v1).")
    return account if account is not None else context

@_tool("get_recovery_strategy", "Get the recovery action for an account", idempotent=True)
async def get_recovery_strategy(
        account: Annotated[NovaAccount | None, Field(description=ACCOUNT_HELP)] = None,
        context: Annotated[RecoveryContextV1 | None, Field(description=CONTEXT_HELP)] = None,
) -> dict[str, Any]:
    """Decide what to do about one delinquent account, record the decision and act on it.

    ARI routes the account to the live strategy whose audience includes it and splits a random control
    share off. For treated accounts, consent, opt-outs and the 7-in-7 contact cap first remove the
    treatments the customer may not receive; Thompson sampling (with a customer-fit adjustment) then
    chooses among the rest, and the contact is scheduled. Sends are simulated: no channel gateway is
    connected. Payment plans, deferrals and hardship offers wait for a person to approve them first.
    Calling again for the same account_id returns the existing decision rather than contacting the
    customer twice, and so does repeating a request_id. A hard stop (vulnerability, a restriction) cancels
    an offer still waiting for review. Every rule is evaluated for every candidate treatment and kept.

    The answer's action is one of: contact, contact_failed, awaiting_approval, contact_blocked (no
    allowed treatment, or held at send time), control_bau (keep on business as usual), rejected,
    cancelled, no_action, refer_to_specialist, restricted (a restriction on file), blocked_stale_data
    (v1: guardrail data missing or out of date). It also carries the strategy, treatment, message, reasons,
    the alternatives with their selection probabilities, the treatments the contact rules blocked, any
    assumed data, and the next step.
    """
    req = _one(account, context)
    return await _call("get_recovery_strategy", lambda db: nova.recovery_strategy(db, req), _decided, "CREATE")


@_tool("preview_recovery_strategy", "Preview the recovery action (records nothing)", read_only=True)
async def preview_recovery_strategy(
        account: Annotated[NovaAccount | None, Field(description=ACCOUNT_HELP)] = None,
        context: Annotated[RecoveryContextV1 | None, Field(description=CONTEXT_HELP)] = None,
) -> dict[str, Any]:
    """What ARI would do for this account, without recording, contacting or reserving anything.

    Same routing, eligibility and Thompson sampling as get_recovery_strategy, so it is the right call for
    "what if" questions. The action is would_contact, would_need_approval, would_be_blocked, control_bau,
    no_action or refer_to_specialist. The account stays free for a real request afterwards.
    """
    req = _one(account, context)
    return await _call("preview_recovery_strategy", lambda db: nova.recovery_strategy(db, req, record=False),
                       lambda r: f"Preview {_decided(r)}")


@_tool("get_recovery_strategies", "Get recovery actions for a batch of accounts", idempotent=True)
async def get_recovery_strategies(
        accounts: Annotated[list[NovaAccount] | None, Field(
            description=f"Contract v0 accounts. Up to {MAX_BATCH} items in all, e.g. one page of the daily "
                        f"delinquent population (C9).")] = None,
        contexts: Annotated[list[RecoveryContextV1] | None, Field(
            description="RecoveryContext v1 items. May be sent alongside `accounts`.")] = None,
) -> dict[str, Any]:
    """Decide and record the recovery action for each account in a batch - a cohort handoff.

    Each account is handled exactly as get_recovery_strategy would handle it. An account that cannot be
    decided gets an error entry; the rest of the batch still goes through.
    """
    items = list(accounts or []) + list(contexts or [])
    if not items:
        raise ValueError("Send `accounts` (contract v0) and/or `contexts` (RecoveryContext v1).")
    if len(items) > MAX_BATCH:
        raise ValueError(f"Send at most {MAX_BATCH} accounts per call ({len(items)} sent).")

    def work(db: Session) -> dict:
        results = []
        for a in items:
            try:
                results.append(nova.recovery_strategy(db, a))
            except nova.NovaError as e:
                db.rollback()
                ref = a.account_id if isinstance(a, NovaAccount) else a.account.account_id
                results.append({"account_id": ref, "action": "error", "error": str(e)})
        counts = Counter(r["action"] for r in results)
        return {"accounts": len(results), "by_action": dict(counts), "results": results}

    return await _call("get_recovery_strategies", work,
                       lambda r: f"Batch of {r['accounts']}: " + ", ".join(
                           f"{n} {k.replace('_', ' ')}" for k, n in r["by_action"].items()), "CREATE")


@_tool("report_payment_outcome", "Report the payment outcome for a decision", idempotent=True)
async def report_payment_outcome(
        paid: Annotated[bool, Field(description="Did the customer pay within the strategy's evaluation window?")],
        decision_id: Annotated[str | None, Field(description="The decision_id ARI returned. Preferred.")] = None,
        account_id: Annotated[str | None, Field(description="Or the Nova account: its latest decision is used.")] = None,
        amount: Annotated[float | None, Field(ge=0, description="Amount paid. Defaults to the amount_past_due "
                                                               "sent with the account.")] = None,
        payment_date: Annotated[date | None, Field(description="Date paid, YYYY-MM-DD. Decides whether it fell "
                                                              "inside the evaluation window.")] = None,
        payment_status: Annotated[Literal["Posted", "Reversed"], Field(
            description="Reversed counts as not paid.")] = "Posted",
) -> dict[str, Any]:
    """Tell ARI how a decision turned out. This is how the model learns.

    A treated outcome updates the belief in that treatment for the strategy - the answer shows the belief
    before and after. A control outcome is kept as the comparison that measures uplift. Reporting again
    for the same decision corrects the earlier report (a reversal, for example).
    """
    rep = nova.PaymentReport(decision_id=decision_id, account_id=account_id, paid=paid, amount=amount,
                             payment_date=payment_date, payment_status=payment_status)
    return await _call("report_payment_outcome", lambda db: nova.report_outcome(db, rep),
                       lambda r: f"{r['decision_id']}: {'paid' if r['paid'] else 'not paid'}"
                                 + (", learned" if r["learned"] else "") + (" (correction)" if r["corrected"] else ""),
                       "UPDATE")


@_tool("get_decision", "Look up a decision", read_only=True)
async def get_decision(
        decision_id: Annotated[str | None, Field(description="A decision_id ARI returned.")] = None,
        account_id: Annotated[str | None, Field(description="Or a Nova account id: its latest decision.")] = None,
) -> dict[str, Any]:
    """Read a decision back: its current status (was the offer approved? was the contact sent?), the
    reasons, and the outcome if one was reported."""
    return await _call("get_decision", lambda db: nova.get_decision(db, decision_id, account_id),
                       lambda r: f"Read {r['decision_id']} ({r['action'].replace('_', ' ')})")


@_tool("list_live_strategies", "List the live recovery strategies", read_only=True)
async def list_live_strategies() -> dict[str, Any]:
    """The strategies currently running: who each one targets, which treatments it may use, its results
    against its own control group, and the treatment currently most likely to be best."""
    return await _call("list_live_strategies", lambda db: {"strategies": nova.strategies(db)},
                       lambda r: f"Listed {len(r['strategies'])} live strategies")


@_tool("list_treatments", "List the approved treatments", read_only=True)
async def list_treatments() -> dict[str, Any]:
    """The business-approved treatment playbook ARI chooses from: offer, channel, cost, who is eligible,
    and whether a person must approve each offer."""
    return await _call("list_treatments", lambda db: {"treatments": nova.treatments(db)},
                       lambda r: f"Listed {len(r['treatments'])} treatments")


# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------
def _new_token() -> str:
    return "ari_" + secrets.token_urlsafe(24)


def access_token(db: Session) -> tuple[str, str]:
    """(token, where it comes from). Created on first use."""
    env = os.getenv("ARI_MCP_TOKEN", "").strip()
    if env:
        return env, "environment"
    row = db.get(PlatformConfig, TOKEN_KEY)
    if row is None:
        row = PlatformConfig(key=TOKEN_KEY, value=_new_token(), label="MCP access token", group="Integrations",
                             kind="secret", help="Bearer token for the MCP endpoint.", updated_by="system",
                             updated_at=now())
        db.add(row)
        db.commit()
    return row.value, "generated"


def rotate_token(db: Session, actor: str) -> str:
    if os.getenv("ARI_MCP_TOKEN", "").strip():
        raise ValueError("This token is set by ARI_MCP_TOKEN in the server environment; change it there.")
    access_token(db)
    row = db.get(PlatformConfig, TOKEN_KEY)
    row.value, row.updated_by, row.updated_at = _new_token(), actor, now()
    audit(db, actor, "UPDATE", "integration", "mcp", "Rotated the MCP access token: the old one stops working now")
    db.commit()
    return row.value


def _expected_token() -> str:
    db = SessionLocal()
    try:
        return access_token(db)[0]
    finally:
        db.close()


def _bearer(scope) -> str | None:
    for key, value in scope.get("headers", []):
        if key == b"authorization":
            text = value.decode("latin-1").strip()
            if text[:7].lower() == "bearer ":
                return text[7:].strip()
    return None


class McpGateway:
    """The /mcp endpoint: check the bearer token, then hand over to the MCP transport."""

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http":
            supplied = _bearer(scope)
            expected = await anyio.to_thread.run_sync(_expected_token)
            if not supplied or not hmac.compare_digest(supplied.encode(), expected.encode()):
                await JSONResponse(
                    {"jsonrpc": "2.0", "id": None, "error": {
                        "code": -32001, "message": "Unauthorized. Send 'Authorization: Bearer <token>'; an ARI "
                                                   "admin finds the token under API & Integrations."}},
                    status_code=401, headers={"WWW-Authenticate": 'Bearer realm="ari-mcp"'})(scope, receive, send)
                return
        await server.session_manager.handle_request(scope, receive, send)


gateway = McpGateway()


def status(db: Session) -> dict:
    """What the console shows about the MCP endpoint."""
    token, source = access_token(db)
    day = (datetime.now(UTC) - timedelta(days=1)).isoformat(timespec="seconds")
    calls = db.query(AuditEvent).filter(AuditEvent.entity == "mcp")
    recent = calls.order_by(AuditEvent.at.desc(), AuditEvent.audit_id.desc()).limit(15).all()
    mcp_decisions = db.query(Decision).filter(Decision.origin == "mcp")
    return {
        "path": ENDPOINT_PATH,
        "transport": "Streamable HTTP · stateless · JSON responses",
        "protocol_versions": SUPPORTED_PROTOCOL_VERSIONS,
        "auth": "Bearer token",
        "token_source": source,
        # Enough to tell tokens apart, never enough to matter - even for a short token set by hand.
        "token_hint": f"{token[:4]}…{token[-4:]}" if len(token) >= 20 else "•" * 8,
        "tools": TOOLS,
        "stats": {
            "calls_24h": calls.filter(AuditEvent.at >= day).count(),
            "calls_total": calls.count(),
            "last_call_at": recent[0].at if recent else None,
            "accounts": db.query(ExternalCustomer).filter(ExternalCustomer.source == nova.SOURCE).count(),
            "decisions": mcp_decisions.count(),
            "awaiting_approval": mcp_decisions.filter(Decision.review_status == "pending").count(),
            "outcomes_reported": (db.query(Outcome).join(Decision, Decision.decision_id == Outcome.decision_id)
                                  .filter(Decision.origin == "mcp").count()),
        },
        "recent": [{"at": a.at, "tool": a.entity_id, "action": a.action, "summary": a.summary} for a in recent],
    }
