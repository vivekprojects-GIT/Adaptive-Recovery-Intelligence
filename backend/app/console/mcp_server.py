"""CARE as an MCP server: how an agent - Nova's, or any other - asks for a
recovery decision and reports what happened.

Transport: Streamable HTTP, stateless, plain JSON responses. Every call stands
alone, so any MCP client (the Python SDK, Claude, an enterprise agent
platform) can call it without session affinity. Served at /mcp, and at
/api/mcp behind the production entrypoint.

Auth: a bearer token. ARI_MCP_TOKEN in the environment wins; otherwise CARE
generates one on first use and keeps it in platform config, where an admin
reveals or rotates it under API & Integrations. DNS-rebinding protection is
left off: it exists for unauthenticated local servers, and a page in someone's
browser cannot present the token.

Every call is written to the audit log as the Nova agent.

No `from __future__ import annotations` here: FastMCP inspects the tool
signatures at registration and needs real types, not strings.
"""
import hmac
import secrets
from ..core import telemetry as otel
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

from ..core.config import settings
from ..core.database import SessionLocal
from .. import models
from ..core import pii
from . import callbacks, graph, nlq, nova
from .contract import NovaAccount, RecoveryContextV1
from .engine import ENGINE_LOCK, arrears
from .models import AuditEvent, Decision, ExternalCustomer, Outcome, PlatformConfig
from .platform import audit, now

UTC = timezone.utc
TOKEN_KEY = "_mcp_token"
ENDPOINT_PATH = "/mcp"
MAX_BATCH = 100

INSTRUCTIONS = """CARE (Collection and Recovery Agent) decides the recovery action for delinquent accounts.

Send an account's context with get_recovery_strategy. CARE finds the live strategy that owns the account
and holds a random share out as a control group. For the rest, consent, opt-outs and contact caps first
decide which of the business-approved treatments the customer may receive; Thompson sampling, with a
customer-fit adjustment, then chooses among those. Payment plans, deferrals and hardship offers wait for a
person to approve them, and the contact rules are checked again when they do. No channel gateway is
connected yet, so contacts are recorded but not delivered. The answer says what to do, why, and what happens next.

Two request shapes are accepted. `account` is the original flat payload (contract v0), unchanged.
`context` is RecoveryContext v1: request_id, as_of_timestamp, party, account, delinquency, arrangement,
per-channel contact context, restrictions and freshness timestamps; under v1, missing or stale consent,
contact history or restrictions block the affected treatments (fail closed). Every answer lists any fields
CARE ignored and any values it had to assume.

Report every payment outcome with report_payment_outcome. Treated outcomes teach the model; control
outcomes measure how much the strategy actually adds. Use preview_recovery_strategy to ask without
recording anything.

To ask about the data, all read-only: ask_portfolio answers a plain-English question about the accounts
and shows the SQL it ran. The recovery knowledge graph links customers, products, segments, strategies,
treatments, decisions, outcomes and agencies: start with get_taxonomy for its classes and relationships,
find things with search_graph, open one with get_node, follow links with traverse_graph, count with
count_by, and explain a link with how_connected. Accounts appear by account number and token, never by name."""

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
            with ENGINE_LOCK, otel.tracer.start_as_current_span(f"mcp.tool {tool}") as span:
                span.set_attribute("mcp.tool", tool)
                span.set_attribute("ari.caller", nova.ACTOR)
                try:
                    result = work(db)
                except (nova.NovaError, ValueError) as e:
                    db.rollback()
                    span.add_event("mcp.refused", {"ari.reason": str(e)[:200]})
                    otel.log.warning("MCP %s refused: %s", tool, e)
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

    CARE routes the account to the live strategy whose audience includes it and splits a random control
    share off. For treated accounts, consent, opt-outs and the 7-in-7 contact cap first remove the
    treatments the customer may not receive; Thompson sampling (with a customer-fit adjustment) then
    chooses among the rest, and the contact is scheduled. No channel gateway is connected yet, so the
    contact is recorded but not delivered. Payment plans, deferrals and hardship offers wait for a person to approve them first.
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
    """What CARE would do for this account, without recording, contacting or reserving anything.

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
        decision_id: Annotated[str | None, Field(description="The decision_id CARE returned. Preferred.")] = None,
        account_id: Annotated[str | None, Field(description="Or the Nova account: its latest decision is used.")] = None,
        amount: Annotated[float | None, Field(ge=0, description="Amount paid. Defaults to the amount_past_due "
                                                               "sent with the account.")] = None,
        payment_date: Annotated[date | None, Field(description="Date paid, YYYY-MM-DD. Decides whether it fell "
                                                              "inside the evaluation window.")] = None,
        payment_status: Annotated[Literal["Posted", "Reversed"], Field(
            description="Reversed counts as not paid.")] = "Posted",
        payment_id: Annotated[str | None, Field(
            max_length=64, description="Nova's id for this payment. Partial payments each send their own id and "
                                       "are added up; the same id sent again counts once; Reversed with an id "
                                       "removes that payment. Without an id, a report replaces the last one.")] = None,
        cure_flag: Annotated[bool | None, Field(
            description="Nova's own view: is the account cured (arrears paid in full)? CARE records it next to its "
                        "own calculation and says when they disagree.")] = None,
) -> dict[str, Any]:
    """Tell CARE how a decision turned out. This is how the model learns.

    A treated outcome updates the belief in that treatment for the strategy - the answer shows the belief
    before and after. A control outcome is kept as the comparison that measures uplift. Send each payment
    with its payment_id: the outcome is the total of the posted payments inside the evaluation window.
    """
    rep = nova.PaymentReport(decision_id=decision_id, account_id=account_id, paid=paid, amount=amount,
                             payment_date=payment_date, payment_status=payment_status, payment_id=payment_id,
                             cure_flag=cure_flag)
    return await _call("report_payment_outcome", lambda db: nova.report_outcome(db, rep),
                       lambda r: f"{r['decision_id']}: {'paid' if r['paid'] else 'not paid'}"
                                 + (", learned" if r["learned"] else "") + (" (correction)" if r["corrected"] else ""),
                       "UPDATE")


@_tool("get_decision", "Look up a decision", read_only=True)
async def get_decision(
        decision_id: Annotated[str | None, Field(description="A decision_id CARE returned.")] = None,
        account_id: Annotated[str | None, Field(description="Or a Nova account id: its latest decision.")] = None,
) -> dict[str, Any]:
    """Read a decision back: its current status (was the offer approved? was the contact sent?), the
    reasons, and the outcome if one was reported."""
    return await _call("get_decision", lambda db: nova.get_decision(db, decision_id, account_id),
                       lambda r: f"Read {r['decision_id']} ({r['action'].replace('_', ' ')})")


@_tool("get_decision_updates", "Read decisions a person changed", read_only=True)
async def get_decision_updates(
        after: Annotated[int, Field(ge=0, description="The next_cursor from the previous call; 0 the first time.")] = 0,
        limit: Annotated[int, Field(ge=1, le=500, description="Most events to return.")] = 100,
) -> dict[str, Any]:
    """Decisions a person approved, rejected, cancelled at approval or overrode, oldest first, after a
    cursor. Each event carries the decision as get_decision would return it, so Nova knows whether to
    carry out or stop the treatment. The same events are pushed to Nova's callback URL when one is set."""
    return await _call("get_decision_updates", lambda db: callbacks.updates(db, after, limit),
                       lambda r: f"Read {len(r['events'])} decision updates after {after}")


@_tool("list_live_strategies", "List the live recovery strategies", read_only=True)
async def list_live_strategies() -> dict[str, Any]:
    """The strategies currently running: who each one targets, which treatments it may use, its results
    against its own control group, and the treatment currently most likely to be best."""
    return await _call("list_live_strategies", lambda db: {"strategies": nova.strategies(db)},
                       lambda r: f"Listed {len(r['strategies'])} live strategies")


@_tool("list_treatments", "List the approved treatments", read_only=True)
async def list_treatments() -> dict[str, Any]:
    """The business-approved treatment playbook CARE chooses from: offer, channel, cost, who is eligible,
    and whether a person must approve each offer."""
    return await _call("list_treatments", lambda db: {"treatments": nova.treatments(db)},
                       lambda r: f"Listed {len(r['treatments'])} treatments")


# ---------------------------------------------------------------------------
# Questions about the data: the portfolio in plain English, and the recovery
# knowledge graph (taxonomy + typed relationships, console/graph.py). All
# read-only. Accounts appear by account number and token, never by name.
# ---------------------------------------------------------------------------
def _graph(fn):
    """A graph read, with an unknown node reported like any other refusal."""
    def work(db: Session):
        try:
            return fn(db)
        except LookupError as e:
            raise ValueError(str(e.args[0] if e.args else e)) from None
    return work


def _money(v: float) -> str:
    return f"${v:,.0f}"


# What CARE's fit groups and routes mean, in the words an agent can pass on.
FIT_MEANS = {"Persuadable": "CARE expects it to pay if contacted",
             "Sure Thing": "CARE expects it to pay without help",
             "Lost Cause": "CARE expects it to need support, such as a hardship review, to pay",
             "Sleeping Dog": "CARE expects contact to do more harm than good"}
ROUTE_MEANS = {"strategy": "so it is in a live strategy, where Thompson sampling picks its treatment",
               "bau": "so it stays on the bank's business-as-usual process",
               "hardship": "so it has been sent to the hardship team",
               "suppress": "so it is not being contacted"}


def _explain_account(c) -> str:
    ref = c.account_number or f"Account {c.customer_id}"
    due = arrears(c)
    text = (f"{ref} is a {c.product} account {c.days_past_due} days past due, owing {_money(c.balance)}, "
            f"of which {_money(due)} is past due. The bank rates it {c.client_risk_band.lower()} risk.")
    fit = FIT_MEANS.get(c.segment)
    if fit:
        text += f" {fit}" + (f", {ROUTE_MEANS[c.route]}." if c.route in ROUTE_MEANS else ".")
    return text


def _ask(db: Session, question: str, limit: int) -> dict:
    r = nlq.read(question)
    if not r["conditions"]:
        raise ValueError("No conditions found in that question. Ask about card business, days past due, balance, "
                         "arrears, credit limit, risk band, fit group, route, hardship, app use, texts, missed "
                         "payments, tenure, utilisation or on-time payments - for example: consumer card accounts "
                         "over 60 days past due with a balance above $5,000 who use the app. For strategies, "
                         "treatments, decisions or outcomes, use the graph tools: get_taxonomy, count_by "
                         "(e.g. Decision by CHOSE) and traverse_graph.")
    rows = nlq.apply(db.query(models.Customer), r["conditions"]).all()
    balance = round(sum(c.balance for c in rows), 2)
    owed = round(sum(arrears(c) for c in rows), 2)
    by_group = Counter(nlq.COHORT_NAMES.get(c.cohort_id, c.cohort_id) for c in rows)
    by_product = Counter(c.product for c in rows)
    cap = max(1, min(limit, 50))
    top = sorted(rows, key=lambda c: -c.balance)[:cap]
    answer = (f"{len(rows):,} accounts match ({'; '.join(r['labels'])}). Together they owe {_money(balance)}, "
              f"of which {_money(owed)} is past due." if rows else
              f"No accounts match ({'; '.join(r['labels'])}).")
    if rows:
        answer += " By days late: " + ", ".join(f"{k} {n:,}" for k, n in by_group.most_common()) + "."
    if r["not_understood"]:
        answer += f" Not understood, so not applied: \"{r['not_understood']}\"."
    n_cond = len(r["conditions"])
    how = (f"The question was read into {n_cond} condition{'s' if n_cond != 1 else ''} on known account fields "
           f"(see understood), run as the SQL shown, and totalled over the {len(rows):,} matching accounts. "
           f"largest_balances lists the {len(top)} biggest balances among them, each with a plain explanation. "
           f"Accounts are identified by account number and token; names are never returned.")
    return {
        "question": question,
        "answer": answer,
        "how_it_was_answered": how,
        "understood": r["labels"],
        "conditions": r["conditions"],
        "not_understood": r["not_understood"],
        "sql": r["sql"].replace("account_number, name, ", "account_number, "),   # agents never get names
        "accounts": len(rows),
        "total_balance": balance,
        "total_past_due": owed,
        "by_days_late": dict(by_group.most_common()),
        "by_card_business": dict(by_product.most_common()),
        "largest_balances": [
            {"account": c.account_number or f"account {c.customer_id}", "node_id": f"customer:{c.customer_id}",
             "token": pii.token(c.customer_id, "customer"), "card_business": c.product,
             "days_past_due": c.days_past_due, "balance": round(c.balance, 2), "past_due": arrears(c),
             "risk_band": c.client_risk_band, "fit_group": nlq.GROUPS.get(c.segment, c.segment),
             "route": nlq.ROUTES.get(c.route, c.route), "explanation": _explain_account(c)}
            for c in top],
    }


@_tool("ask_portfolio", "Ask a question about the accounts in plain English", read_only=True)
async def ask_portfolio(
        question: Annotated[str, Field(min_length=3, max_length=300, description=(
            "A question about the delinquent accounts, e.g. 'retail card accounts over 60 days past due with a "
            "balance above $2,000' or 'high risk customers who use the app'."))],
        limit: Annotated[int, Field(ge=1, le=50, description="How many of the largest balances to list.")] = 10,
) -> dict[str, Any]:
    """Answer a plain-English question about the accounts: how many match, what they owe, and which they are.

    The question is read into conditions on known account fields only, and the answer shows exactly what was
    understood, what was not, and the SQL it amounts to - a question can never become arbitrary SQL. Accounts
    are listed by account number and token, never by name.
    """
    return await _call("ask_portfolio", lambda db: _ask(db, question, limit),
                       lambda r: f"Asked: {question[:100]} - {r['accounts']} accounts")


@_tool("get_taxonomy", "Show the recovery taxonomy and relationship types", read_only=True)
async def get_taxonomy() -> dict[str, Any]:
    """The class tree the recovery knowledge graph is organised by (e.g. Retail Card < Card < Product, Split
    Payment Plan < Arrangement < Treatment), with node counts, and every relationship type with what it means.

    Start here: class names and relationship names from this answer are what the other graph tools take.
    """
    return await _call("get_taxonomy", _graph(graph.taxonomy),
                       lambda r: f"Read the taxonomy: {r['nodes']} nodes, {r['edges']} edges")


@_tool("search_graph", "Find things in the recovery knowledge graph", read_only=True)
async def search_graph(
        text: Annotated[str, Field(max_length=100, description="Words in the label or id, e.g. 'payment plan', "
                                                               "'STR-021', 'CC10'. Empty lists the class.")] = "",
        node_class: Annotated[str | None, Field(description="Limit to a class and its subclasses, e.g. 'Treatment', "
                                                            "'Strategy', 'Customer', 'Agency'.")] = None,
        limit: Annotated[int, Field(ge=1, le=50)] = 20,
) -> dict[str, Any]:
    """Find nodes - customers, strategies, treatments, decisions, agencies, segments - by text and class.

    Each match has an id (e.g. strategy:STR-021, treatment:S3) to pass to get_node, traverse_graph or
    how_connected.
    """
    return await _call("search_graph", _graph(lambda db: graph.search(db, text, node_class, limit)),
                       lambda r: f"Searched the graph for '{text[:60]}': {r['returned']} matches")


@_tool("get_node", "Show one node and everything it is linked to", read_only=True)
async def get_node(
        node_id: Annotated[str, Field(description="A node id from search_graph, e.g. 'strategy:STR-021'.")],
        limit: Annotated[int, Field(ge=1, le=50, description="Most linked nodes listed per relationship.")] = 25,
) -> dict[str, Any]:
    """One node: its properties, where it sits in the taxonomy, and its relationships in both directions."""
    return await _call("get_node", _graph(lambda db: graph.node(db, node_id, limit)),
                       lambda r: f"Read node {node_id}")


@_tool("traverse_graph", "Follow relationships through the knowledge graph", read_only=True)
async def traverse_graph(
        start: Annotated[str, Field(description="The node to start from, e.g. 'treatment:S3'.")],
        path: Annotated[list[str], Field(min_length=1, max_length=6, description=(
            "Relationship names to follow in order. Prefix ~ to walk one backwards: from treatment:S3, "
            "['~CHOSE', 'RESULTED_IN'] gives the outcomes of decisions that chose it."))],
        where: Annotated[dict[str, Any] | None, Field(description=(
            "Filter the end nodes by property or class, e.g. {'paid': true} or {'class': 'Arrangement'}."))] = None,
        limit: Annotated[int, Field(ge=1, le=50)] = 50,
) -> dict[str, Any]:
    """Walk the graph hop by hop from a start node and return the nodes reached, with the total count."""
    return await _call("traverse_graph", _graph(lambda db: graph.traverse(db, start, path, where, limit)),
                       lambda r: f"Traversed {start} via {' > '.join(path)}: {r['total']} nodes")


@_tool("count_by", "Count things in the graph, grouped", read_only=True)
async def count_by(
        node_class: Annotated[str, Field(description="What to count, e.g. 'Decision', 'Customer', 'Outcome'.")],
        group_by: Annotated[str, Field(description=(
            "A relationship (e.g. 'CHOSE' groups decisions by treatment, 'HOLDS' customers by card business), "
            "'class', or a property name (e.g. 'group', 'paid')."))],
        where: Annotated[dict[str, Any] | None, Field(description="Filter first, e.g. {'group': 'Treatment'}.")] = None,
        measure: Annotated[str | None, Field(description="A numeric property to sum and average per group, "
                                                         "e.g. 'balance' or 'amount'.")] = None,
) -> dict[str, Any]:
    """Count the nodes of a class, grouped by a relationship or a property, optionally summing a measure."""
    return await _call("count_by", _graph(lambda db: graph.aggregate(db, node_class, group_by, where, measure)),
                       lambda r: f"Counted {node_class} by {group_by}: {r['total']} nodes")


@_tool("how_connected", "Explain how two things are connected", read_only=True)
async def how_connected(
        a: Annotated[str, Field(description="A node id, e.g. 'agency:AGY-01'.")],
        b: Annotated[str, Field(description="Another node id, e.g. 'product:retail-card'.")],
        max_hops: Annotated[int, Field(ge=1, le=6)] = 5,
) -> dict[str, Any]:
    """The shortest chain of relationships between two nodes, hop by hop."""
    return await _call("how_connected", _graph(lambda db: graph.shortest_path(db, a, b, max_hops)),
                       lambda r: f"Connected {a} and {b}: {len(r['steps'])} hops" if r["connected"]
                       else f"{a} and {b} are not connected")


# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------
def _new_token() -> str:
    return "ari_" + secrets.token_urlsafe(24)


def access_token(db: Session) -> tuple[str, str]:
    """(token, where it comes from). Created on first use."""
    env = settings.mcp_token
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
    if settings.mcp_token:
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
                        "code": -32001, "message": "Unauthorized. Send 'Authorization: Bearer <token>'; an CARE "
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
