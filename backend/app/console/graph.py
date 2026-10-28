"""The recovery knowledge graph: CARE's structured data, organised by a taxonomy
and stored as a graph, so an agent can reach any of it through a small set of
read-only tools.

  Taxonomy   a class tree. Every node belongs to one class, and every class
             sits under a parent, e.g. Retail Card < Card < Product, or
             Split Payment Plan < Arrangement < Treatment.
  Nodes      one per thing: a customer, a strategy, a decision, an agency,
             and the reference values they share (a delinquency bucket, a
             risk band, a product).
  Edges      typed relationships: customer HOLDS product, decision CHOSE
             treatment, placement WITH_AGENCY agency.

The graph is rebuilt from the tables whenever they change, and persisted in
kg_nodes / kg_edges, so it is always the same data the console shows.
Customers appear by their customer ID and a token, never by name: the graph
is built for agents (see core/pii.py).
"""
from __future__ import annotations

import json
import threading
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models
from ..core import pii
from .engine import arrears
from .models import (
    Agency, Campaign, Decision, KgEdge, KgNode, Outcome, Placement, PlatformConfig, TreatmentMeta,
)

UTC = timezone.utc

# (class, parent, description). The order is the order the tree is shown in.
TAXONOMY: list[tuple[str, str | None, str]] = [
    ("Thing", None, "Everything in the recovery graph"),
    ("Party", "Thing", "A person or business the bank deals with"),
    ("Customer", "Party", "A delinquent account holder handed over for collections"),
    ("Agency", "Party", "An external collection agency on the bank's panel"),
    ("Product", "Thing", "What the customer owes on"),
    ("Card", "Product", "A card business"),
    ("Consumer Credit Card", "Card", "General-purpose consumer credit card"),
    ("Small Business Card", "Card", "Card issued to a small business"),
    ("Retail Card", "Card", "Store or private-label card for one retailer"),
    ("Co-Brand Card", "Card", "Card issued with a partner brand"),
    ("Segment", "Thing", "A way the book is divided"),
    ("Delinquency bucket", "Segment", "How far behind the account is, from the bank's collections system"),
    ("Risk band", "Segment", "The bank's own risk rating"),
    ("Fit group", "Segment", "CARE's Propensity Router: how the customer is likely to respond to contact"),
    ("Route", "Segment", "Where the Propensity Router sends the customer"),
    ("Treatment", "Thing", "One approved action from the Treatment Playbook"),
    ("Reminder", "Treatment", "A reminder that a payment is due"),
    ("Digital nudge", "Treatment", "An in-app or digital prompt to pay"),
    ("Arrangement", "Treatment", "A change to how the arrears are paid, such as instalments"),
    ("Deferral", "Treatment", "A change to when a payment is due"),
    ("Outreach", "Treatment", "A person contacts the customer"),
    ("Hardship", "Treatment", "Affordability review and reduced payments"),
    ("Channel", "Thing", "How a treatment reaches the customer"),
    ("Strategy", "Thing", "A plan that decides which customers get which treatments, against a control group"),
    ("Event", "Thing", "Something that happened to an account"),
    ("Decision", "Event", "CARE's choice for one customer in one strategy"),
    ("Outcome", "Event", "What the customer did within the evaluation window"),
    ("Placement", "Event", "An account sent to a collection agency"),
]
PARENT = {c: p for c, p, _ in TAXONOMY}
DESCRIPTION = {c: d for c, _, d in TAXONOMY}

# (relationship, from class, to class, meaning)
RELATIONSHIPS: list[tuple[str, str, str, str]] = [
    ("HOLDS", "Customer", "Product", "the product the customer owes on"),
    ("IN_BUCKET", "Customer", "Delinquency bucket", "how far behind the account is"),
    ("RATED", "Customer", "Risk band", "the bank's risk rating"),
    ("IN_FIT_GROUP", "Customer", "Fit group", "the Propensity Router's fit group"),
    ("ROUTED_TO", "Customer", "Route", "where the router sent the customer"),
    ("TARGETS", "Strategy", "Delinquency bucket", "buckets the strategy's audience is drawn from"),
    ("USES", "Strategy", "Treatment", "treatments the strategy may choose between"),
    ("ESCALATES_TO", "Strategy", "Treatment", "the treatment used when there is no payment"),
    ("SENT_BY", "Treatment", "Channel", "how the treatment reaches the customer"),
    ("ABOUT", "Decision", "Customer", "the customer decided"),
    ("MADE_IN", "Decision", "Strategy", "the strategy that made the decision"),
    ("CHOSE", "Decision", "Treatment", "the treatment chosen (none for control or excluded)"),
    ("RESULTED_IN", "Decision", "Outcome", "what happened within the evaluation window"),
    ("OF_CUSTOMER", "Placement", "Customer", "the account placed"),
    ("WITH_AGENCY", "Placement", "Agency", "the agency it was placed with"),
    ("CONTRACTED_FOR", "Agency", "Product", "products the agency may be placed"),
]

GROUP_LABEL = {"Persuadable": "Likely responsive", "Sure Thing": "Likely self-cure", "Lost Cause": "Needs support",
               "Sleeping Dog": "Do not contact"}
ROUTE_LABEL = {"strategy": "Accounts in a strategy", "bau": "Business as usual", "hardship": "Sent to the hardship team",
               "suppress": "Do not contact"}


def is_a(cls: str, ancestor: str) -> bool:
    while cls:
        if cls == ancestor:
            return True
        cls = PARENT.get(cls)
    return False


def descendants(cls: str) -> set[str]:
    return {c for c in PARENT if is_a(c, cls)}


def _slug(text: str) -> str:
    return "".join(ch if ch.isalnum() else "-" for ch in text.lower()).strip("-")


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
def _mark(db: Session, key: str) -> str | None:
    row = db.get(PlatformConfig, key)
    return row.value if row else None


def _set_mark(db: Session, key: str, value: str) -> None:
    row = db.get(PlatformConfig, key)
    if row:
        row.value = value
    else:
        db.add(PlatformConfig(key=key, value=value, label="internal", group="internal", kind="text"))


def _signature(db: Session) -> str:
    parts = [db.query(func.count(models.Customer.customer_id)).scalar(),
             db.query(func.count(Decision.decision_id)).scalar(), db.query(func.max(Decision.decided_at)).scalar(),
             db.query(func.count(Outcome.outcome_id)).scalar(), db.query(func.count(Campaign.campaign_id)).scalar(),
             db.query(func.max(Campaign.updated_at)).scalar(), db.query(func.count(Placement.placement_id)).scalar(),
             db.query(func.max(Placement.reviewed_at)).scalar(), db.query(func.count(models.Strategy.code)).scalar()]
    return "|".join(str(p) for p in parts)


def _extract(db: Session) -> tuple[list[dict], list[tuple[str, str, str]]]:
    nodes: dict[str, dict] = {}
    edges: list[tuple[str, str, str]] = []

    def node(nid: str, cls: str, label: str, **props: Any) -> str:
        nodes[nid] = {"id": nid, "cls": cls, "label": label, "props": props}
        return nid

    for cls, _, desc in TAXONOMY:   # products and treatment kinds are classes and nodes
        if is_a(cls, "Product") and cls not in ("Product", "Card"):
            node(f"product:{_slug(cls)}", cls, cls, description=desc)
    cohorts = db.query(models.Cohort).order_by(models.Cohort.sort_order).all()
    for co in cohorts:
        node(f"bucket:{co.cohort_id}", "Delinquency bucket", f"{co.dpd_bucket} ({co.name})", cohort_id=co.cohort_id,
             expected_payment=co.expected_payment, bank_risk_band=co.client_risk_band)
    for band in sorted({c.client_risk_band for c in cohorts} | {"Low", "Medium", "High", "Very high"}):
        node(f"risk:{_slug(band)}", "Risk band", band)
    for g, label in GROUP_LABEL.items():
        node(f"fit:{_slug(g)}", "Fit group", label, model_name=g)
    for r, label in ROUTE_LABEL.items():
        node(f"route:{r}", "Route", label, route=r)

    kinds = {t.code: t for t in db.query(TreatmentMeta)}
    for s in db.query(models.Strategy):
        meta = kinds.get(s.code)
        kind = meta.kind if meta and meta.kind in PARENT else "Treatment"
        n = s.hist_successes + s.hist_failures
        node(f"treatment:{s.code}", kind, s.name, code=s.code, offer=s.offer, cost_per_contact=s.cost_per_contact,
             eligibility=s.eligibility_rule, human_review=bool(meta and meta.human_review),
             status=meta.status if meta else "Active", track_record=round(s.hist_successes / n, 4) if n else None)
        ch = node(f"channel:{_slug(s.channel)}", "Channel", s.channel)
        edges.append((f"treatment:{s.code}", "SENT_BY", ch))

    for c in db.query(Campaign):
        node(f"strategy:{c.campaign_id}", "Strategy", c.name, strategy_id=c.campaign_id, status=c.status,
             version=c.version, target_payment_rate=c.recovery_target, control_share=c.control_pct,
             waves_run=c.waves_run, launched_at=c.launched_at)
        for co in json.loads(c.target_cohorts or "[]"):
            edges.append((f"strategy:{c.campaign_id}", "TARGETS", f"bucket:{co}"))
        for code in json.loads(c.treatment_codes or "[]"):
            edges.append((f"strategy:{c.campaign_id}", "USES", f"treatment:{code}"))
        if c.escalate_to:
            edges.append((f"strategy:{c.campaign_id}", "ESCALATES_TO", f"treatment:{c.escalate_to}"))

    for c in db.query(models.Customer):
        ref = c.account_number or f"account {c.customer_id}"
        product = c.product or "Consumer Credit Card"
        nid = node(f"customer:{c.customer_id}", "Customer", ref, customer_ref=ref,
                   token=pii.token(c.customer_id, "customer"), balance=round(c.balance, 2), arrears=arrears(c),
                   days_past_due=c.days_past_due, missed_payments_12m=c.missed_payments,
                   on_time_ratio=c.payment_history, tenure_years=c.tenure_years, hardship_flag=c.hardship_flag)
        edges += [(nid, "HOLDS", f"product:{_slug(product)}"), (nid, "IN_BUCKET", f"bucket:{c.cohort_id}"),
                  (nid, "RATED", f"risk:{_slug(c.client_risk_band)}"), (nid, "IN_FIT_GROUP", f"fit:{_slug(c.segment)}")]
        if c.route:
            edges.append((nid, "ROUTED_TO", f"route:{c.route}"))

    outcomes = {o.decision_id: o for o in db.query(Outcome)}
    now = datetime.now(UTC).isoformat(timespec="seconds")
    for d in db.query(Decision):
        nid = node(f"decision:{d.decision_id}", "Decision", d.decision_id, group=d.group, decided_at=d.decided_at,
                   review=d.review_status, validation=bool(d.validation), overridden=bool(d.overridden),
                   reason=(d.explanation or "")[:400])
        edges += [(nid, "ABOUT", f"customer:{d.customer_id}"), (nid, "MADE_IN", f"strategy:{d.campaign_id}")]
        if d.treatment_code:
            edges.append((nid, "CHOSE", f"treatment:{d.treatment_code}"))
        o = outcomes.get(d.decision_id)
        if o is not None and o.observed_at <= now:
            oid = node(f"outcome:{d.decision_id}", "Outcome", f"{'Paid' if o.paid else 'Not paid'} ({d.decision_id})",
                       paid=o.paid, amount=round(o.amount, 2), days_to_pay=o.days_to_pay, observed_at=o.observed_at)
            edges.append((nid, "RESULTED_IN", oid))

    for a in db.query(Agency):
        node(f"agency:{a.agency_id}", "Agency", a.name, agency_id=a.agency_id, fee_rate=a.fee_rate,
             min_days_past_due=a.min_dpd, capacity=a.capacity, status=a.status)
        for p in json.loads(a.products or "[]"):
            edges.append((f"agency:{a.agency_id}", "CONTRACTED_FOR", f"product:{_slug(p)}"))
    for p in db.query(Placement):
        nid = node(f"placement:{p.placement_id}", "Placement", p.placement_id, status=p.status, balance_placed=p.amount,
                   recovered=p.recovered, fee=p.fee, proposed_at=p.proposed_at, placed_at=p.placed_at)
        edges += [(nid, "OF_CUSTOMER", f"customer:{p.customer_id}"), (nid, "WITH_AGENCY", f"agency:{p.agency_id}")]

    edges = [e for e in edges if e[0] in nodes and e[2] in nodes]
    return list(nodes.values()), edges


class Graph:
    """The graph in memory, for traversal. Loaded from kg_nodes / kg_edges."""

    def __init__(self, nodes: list[dict], edges: list[tuple[str, str, str]], built_at: str, signature: str):
        self.nodes = {n["id"]: n for n in nodes}
        self.out: dict[str, list[tuple[str, str]]] = defaultdict(list)
        self.inn: dict[str, list[tuple[str, str]]] = defaultdict(list)
        for s, r, d in edges:
            self.out[s].append((r, d))
            self.inn[d].append((r, s))
        self.edges = edges
        self.built_at, self.signature = built_at, signature
        self.by_cls: dict[str, list[str]] = defaultdict(list)
        for n in nodes:
            self.by_cls[n["cls"]].append(n["id"])


_lock = threading.Lock()
_cache: Graph | None = None


def build(db: Session) -> Graph:
    """Rebuild the graph from the tables and store it."""
    global _cache
    sig = _signature(db)
    nodes, edges = _extract(db)
    db.query(KgEdge).delete()
    db.query(KgNode).delete()
    db.bulk_insert_mappings(KgNode, [{"node_id": n["id"], "cls": n["cls"], "label": n["label"],
                                      "props": json.dumps(n["props"], default=str)} for n in nodes])
    db.bulk_insert_mappings(KgEdge, [{"src": s, "rel": r, "dst": d} for s, r, d in edges])
    built = datetime.now(UTC).isoformat(timespec="seconds")
    _set_mark(db, "_graph_signature", sig)
    _set_mark(db, "_graph_built_at", built)
    db.commit()
    _cache = Graph(nodes, edges, built, sig)
    return _cache


def _load(db: Session, sig: str, built: str) -> Graph:
    nodes = [{"id": n.node_id, "cls": n.cls, "label": n.label, "props": json.loads(n.props or "{}")}
             for n in db.query(KgNode)]
    edges = [(e.src, e.rel, e.dst) for e in db.query(KgEdge)]
    return Graph(nodes, edges, built, sig)


def get(db: Session) -> Graph:
    """The current graph: rebuilt when the tables have changed since it was built."""
    global _cache
    with _lock:
        sig = _signature(db)
        if _cache is not None and _cache.signature == sig:
            return _cache
        if _mark(db, "_graph_signature") == sig and db.query(KgNode).count():
            _cache = _load(db, sig, _mark(db, "_graph_built_at") or "")
            return _cache
        return build(db)


# ---------------------------------------------------------------------------
# Read-only tools. The same functions serve the console, the MCP endpoint and
# the console's agent, so every caller sees the same answers.
# ---------------------------------------------------------------------------
MAX_ROWS = 50


def _brief(g: Graph, nid: str) -> dict:
    n = g.nodes[nid]
    return {"id": nid, "class": n["cls"], "label": n["label"]}


def taxonomy(db: Session) -> dict:
    """The class tree with node counts, and every relationship type."""
    g = get(db)
    counts = Counter(n["cls"] for n in g.nodes.values())
    rel_counts = Counter(r for _, r, _ in g.edges)

    def tree(cls: str) -> dict:
        kids = [c for c, p, _ in TAXONOMY if p == cls]
        total = sum(counts.get(c, 0) for c in descendants(cls))
        return {"class": cls, "description": DESCRIPTION[cls], "nodes": counts.get(cls, 0), "total": total,
                "children": [tree(k) for k in kids]}

    return {"taxonomy": tree("Thing"),
            "relationships": [{"name": r, "from": a, "to": b, "meaning": m, "edges": rel_counts.get(r, 0)}
                              for r, a, b, m in RELATIONSHIPS],
            "nodes": len(g.nodes), "edges": len(g.edges), "built_at": g.built_at}


def search(db: Session, text: str = "", cls: str | None = None, limit: int = 20) -> dict:
    """Nodes whose label or ID contains the text, optionally within a class (and its subclasses)."""
    g = get(db)
    t = text.strip().lower()
    allowed = descendants(cls) if cls else None
    if cls and cls not in PARENT:
        raise ValueError(f"Unknown class '{cls}'. Use one from the taxonomy.")
    hits = []
    for n in g.nodes.values():
        if allowed is not None and n["cls"] not in allowed:
            continue
        if t and t not in n["label"].lower() and t not in n["id"].lower():
            continue
        hits.append(n)
        if len(hits) >= max(1, min(limit, MAX_ROWS)):
            break
    return {"matches": [{**_brief(g, n["id"]), "props": n["props"]} for n in hits], "returned": len(hits)}


def node(db: Session, node_id: str, limit: int = 25) -> dict:
    """One node, its properties, its place in the taxonomy and its relationships, both ways."""
    g = get(db)
    n = g.nodes.get(node_id)
    if n is None:
        raise LookupError(f"No node '{node_id}'. Find one with graph_search.")
    path, c = [], n["cls"]
    while c:
        path.append(c)
        c = PARENT.get(c)
    out: dict[str, list] = defaultdict(list)
    for r, d in g.out.get(node_id, []):
        out[r].append(d)
    inn: dict[str, list] = defaultdict(list)
    for r, s in g.inn.get(node_id, []):
        inn[r].append(s)
    cap = max(1, min(limit, MAX_ROWS))
    return {"id": node_id, "class": n["cls"], "label": n["label"], "is_a": list(reversed(path)), "props": n["props"],
            "outgoing": [{"rel": r, "count": len(ids), "nodes": [_brief(g, i) for i in ids[:cap]]} for r, ids in out.items()],
            "incoming": [{"rel": r, "count": len(ids), "nodes": [_brief(g, i) for i in ids[:cap]]} for r, ids in inn.items()]}


def traverse(db: Session, start: str, path: list[str], where: dict | None = None, limit: int = 50) -> dict:
    """Follow relationships hop by hop from a start node. Each step is a
    relationship name; prefix it with ~ to walk it backwards (e.g. ~ABOUT goes
    from a customer to its decisions). `where` filters the end nodes on
    properties or class, e.g. {"paid": true} or {"class": "Arrangement"}."""
    g = get(db)
    if start not in g.nodes:
        raise LookupError(f"No node '{start}'.")
    names = {r for r, *_ in RELATIONSHIPS}
    frontier = {start}
    for step in path:
        back = step.startswith("~")
        rel = step.lstrip("~")
        if rel not in names:
            raise ValueError(f"Unknown relationship '{rel}'. Relationships: {', '.join(sorted(names))}.")
        nxt = set()
        for nid in frontier:
            for r, other in (g.inn if back else g.out).get(nid, []):
                if r == rel:
                    nxt.add(other)
        frontier = nxt
    found = [g.nodes[i] for i in sorted(frontier)]
    if where:
        found = [n for n in found if _matches(n, where)]
    cap = max(1, min(limit, MAX_ROWS))
    return {"start": _brief(g, start), "path": path, "total": len(found),
            "nodes": [{**_brief(g, n["id"]), "props": n["props"]} for n in found[:cap]], "returned": min(cap, len(found))}


def _matches(n: dict, where: dict) -> bool:
    for k, v in where.items():
        if k == "class":
            if not is_a(n["cls"], v):
                return False
        elif n["props"].get(k) != v:
            return False
    return True


def aggregate(db: Session, cls: str, group_by: str, where: dict | None = None, measure: str | None = None) -> dict:
    """Count the nodes of a class, grouped by a relationship (the node at the
    other end, e.g. HOLDS) or a property (e.g. group). With `measure`, also sum
    and average that numeric property per group."""
    g = get(db)
    if cls not in PARENT:
        raise ValueError(f"Unknown class '{cls}'.")
    members = [g.nodes[i] for c in descendants(cls) for i in g.by_cls.get(c, [])]
    if where:
        members = [n for n in members if _matches(n, where)]
    rels = {r for r, *_ in RELATIONSHIPS}
    groups: dict[str, list[dict]] = defaultdict(list)
    for n in members:
        if group_by in rels or group_by.lstrip("~") in rels:
            back = group_by.startswith("~")
            keys = [g.nodes[o]["label"] for r, o in (g.inn if back else g.out).get(n["id"], []) if r == group_by.lstrip("~")]
            for k in keys or ["(none)"]:
                groups[k].append(n)
        elif group_by == "class":
            groups[n["cls"]].append(n)
        else:
            groups[str(n["props"].get(group_by, "(none)"))].append(n)
    rows = []
    for k, ns in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        row: dict[str, Any] = {"group": k, "count": len(ns)}
        if measure:
            vals = [n["props"].get(measure) for n in ns if isinstance(n["props"].get(measure), (int, float))]
            row["sum"] = round(sum(vals), 2) if vals else None
            row["average"] = round(sum(vals) / len(vals), 4) if vals else None
        rows.append(row)
    return {"class": cls, "group_by": group_by, "total": len(members), "groups": rows[:MAX_ROWS]}


def shortest_path(db: Session, a: str, b: str, max_hops: int = 5) -> dict:
    """How two nodes are connected: the shortest chain of relationships between them."""
    g = get(db)
    for x in (a, b):
        if x not in g.nodes:
            raise LookupError(f"No node '{x}'.")
    prev: dict[str, tuple[str, str, bool] | None] = {a: None}
    q = deque([(a, 0)])
    while q:
        cur, hops = q.popleft()
        if cur == b or hops >= max_hops:
            if cur == b:
                break
            continue
        for back, adj in ((False, g.out), (True, g.inn)):
            for r, nxt in adj.get(cur, []):
                if nxt not in prev:
                    prev[nxt] = (cur, r, back)
                    q.append((nxt, hops + 1))
    if b not in prev:
        return {"connected": False, "steps": []}
    steps, cur = [], b
    while prev[cur] is not None:
        p, r, back = prev[cur]
        steps.append({"from": _brief(g, p), "rel": ("~" if back else "") + r, "to": _brief(g, cur)})
        cur = p
    return {"connected": True, "steps": list(reversed(steps))}
