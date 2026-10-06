"""Decisions and their audit, human review, overrides, messages and the activity feed."""
from __future__ import annotations

import json
from datetime import datetime


from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import String, cast, func
from sqlalchemy.orm import Session


from ... import models
from ...core.database import get_db
from ...scoring import eligibility, fit_reasons, nudge_explanation
from .. import engine
from ..engine import as_of_decision, jl
from ..models import (
    Campaign, ComplianceViolation, Decision, EligibilityEval, EngagementEvent, FeatureSnapshot, Nudge, Outcome,
    User,
)
from ..platform import audit, cfg, now
from ..rbac import require
from .common import _treatments, _user_names

router = APIRouter()


def _decision_row(d: Decision, o: Outcome | None, names: dict, camps: dict, t: dict, cust: dict) -> dict:
    return {"decision_id": d.decision_id, "campaign_id": d.campaign_id, "strategy": camps.get(d.campaign_id),
            "customer_id": d.customer_id, "customer": cust.get(d.customer_id), "wave": d.wave,
            "group": d.group, "treatment_code": d.treatment_code,
            "treatment": t[d.treatment_code].name if d.treatment_code in t else None,
            "selection_probability": d.selection_probability, "review_policy": d.review_policy,
            "review_status": d.review_status, "overridden": d.overridden, "decided_at": d.decided_at,
            "origin": d.origin,
            "latency_ms": d.latency_ms,
            "outcome": None if o is None else ("Paid" if o.paid else "Not paid"),
            "amount": o.amount if o else None}


@router.get("/decisions")
def decisions(campaign: str = "", group: str = "", review: str = "", q: str = "", page: int = 1,
              page_size: int = 30, user: User = Depends(require("view_ai_decisions")),
              db: Session = Depends(get_db)):
    query = db.query(Decision, Outcome).outerjoin(Outcome, Outcome.decision_id == Decision.decision_id)
    if campaign:
        query = query.filter(Decision.campaign_id == campaign)
    if group:
        query = query.filter(Decision.group == group)
    if review:
        query = query.filter(Decision.review_status == review)
    if q:
        query = query.filter(Decision.decision_id.like(f"%{q}%") |
                             cast(Decision.customer_id, String).like(f"%{q}%"))
    total = query.count()
    rows = query.order_by(Decision.decided_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    names, t = _user_names(db), _treatments(db)
    camps = {c.campaign_id: c.name for c in db.query(Campaign)}
    cust = {c.customer_id: c.name for c in db.query(models.Customer).filter(
        models.Customer.customer_id.in_([d.customer_id for d, _ in rows]))}
    return {"total": total, "page": page, "page_size": page_size,
            "rows": [_decision_row(d, o, names, camps, t, cust) for d, o in rows]}


@router.get("/decisions/{did}")
def decision_audit(did: str, user: User = Depends(require("view_ai_decisions")), db: Session = Depends(get_db)):
    d = db.get(Decision, did)
    if not d:
        raise HTTPException(404, "Decision not found.")
    c = db.get(models.Customer, d.customer_id)
    camp = db.get(Campaign, d.campaign_id)
    o = db.query(Outcome).filter(Outcome.decision_id == did).first()
    # Everything about the customer comes from the decision's frozen context,
    # never from today's customer record, which later requests may have changed.
    fs = db.query(FeatureSnapshot).filter(FeatureSnapshot.decision_id == did).first()
    snap = json.loads(fs.features) if fs else json.loads(d.snapshot)
    evals = (db.query(EligibilityEval).filter(EligibilityEval.decision_id == did)
             .order_by(EligibilityEval.eval_id).all())
    ranking = jl(d.ranking)
    t = _treatments(db)
    nudges = db.query(Nudge).filter(Nudge.decision_id == did).order_by(Nudge.scheduled_at).all()
    expl = nudge_explanation(as_of_decision(snap))
    first = nudges[0] if nudges else None
    first_stages = jl(first.pipeline) if first else []
    guard = next((s for s in first_stages if s["stage"] == "Compliance check"), None)
    eligible = jl(d.eligible_arms)
    from_agent = d.origin == "mcp"
    trace = [
        {"step": "Client risk context", "agent": "Nova, via MCP" if from_agent else "Upstream (client model)",
         "ok": True,
         "detail": f"{snap.get('client_risk_band')} risk · score {snap.get('client_risk_score')} · "
                   f"{snap.get('days_past_due')} DPD. "
                   + (f"Sent by Nova for account {snap.get('account_id')}; ARI asked for the decision in real time."
                      if from_agent else "Supplied by the bank, not computed by ARI.")},
        {"step": "Intervention fit", "agent": "Nudge & self-cure scoring", "ok": True,
         "detail": f"Nudge propensity {snap.get('nudge_score')} · self-cure {snap.get('self_cure_score')} "
                   f"→ {snap.get('segment')}"},
    ]
    blocked = jl(d.blocked_arms)
    if evals:
        arms = list(dict.fromkeys(e.arm_id for e in evals))
        allowed = [a for a in arms if all(e.result == "PASS" for e in evals if e.arm_id == a)]
        trace.append({"step": "Guardrails & eligibility", "agent": "Rules, every one for every treatment",
                      "ok": bool(allowed),
                      "detail": f"{len(evals)} rule results over {len(arms)} treatments. Allowed: "
                                + (", ".join(t[a].name if a in t else a for a in allowed) or "none")
                                + "".join(f". Not allowed: {b.get('name', b['code'])} ("
                                          + "; ".join(r["reason"] for r in b.get("reasons", [b])) + ")"
                                          for b in blocked)})
    else:  # decided before per-rule results were kept
        trace.append({"step": "Eligibility", "agent": "Business rules", "ok": bool(eligible),
                      "detail": f"{len(eligible)} of {len(jl(camp.treatment_codes))} strategy treatments eligible: "
                                + ", ".join(t[x].name for x in eligible if x in t)
                                + ". Per-rule results were not recorded for this decision."})
    trace.append({"step": "Control split", "agent": "Randomiser", "ok": d.group != "Excluded",
                  "detail": ("Assigned to the randomised control group (business as usual)." if d.group == "Control"
                             else "Not randomised: no treatment was allowed, so the account was excluded before "
                                  "the control split." if d.group == "Excluded"
                             else f"Treatment group (control share {camp.control_pct:.0%}).")})
    if d.group == "Treatment":
        trace.append({"step": "Treatment selection", "agent": "Thompson sampling with customer fit",
                      "ok": bool(d.treatment_code) or d.overridden, "detail": d.explanation})
        trace.append({"step": "Review policy", "agent": "Governance",
                      "ok": d.review_status not in ("rejected", "cancelled"),
                      "detail": ("Communication treatment - executes automatically."
                                 if d.review_policy == "auto" else
                                 f"Forbearance treatment - human review: {d.review_status}"
                                 + (f" by {_user_names(db).get(d.reviewed_by, d.reviewed_by)}"
                                    if d.reviewed_by else "")
                                 + (f". {d.exclusion_reason}" if d.review_status == "cancelled" else ""))})
        if guard:
            trace.append({"step": "Compliance guard", "agent": "Contact policy", "ok": guard["ok"],
                          "detail": guard["detail"]})
        if first:
            trace.append({"step": "Execution", "agent": "Channel delivery (not connected)",
                          "ok": first.status not in ("Failed", "Held"),
                          "detail": f"{first.nudge_id} via {first.channel}: {first.status}"
                                    + (f" ({first.failure_reason})" if first.failure_reason else "")})
    trace.append({"step": "Outcome", "agent": "Learning loop", "ok": True,
                  "detail": (("Awaiting Nova's payment report." if from_agent else "Awaiting the evaluation window.")
                             if o is None else
                             (f"Paid ${o.amount:,.2f} after {o.days_to_pay} days." if o.paid else
                              f"No payment in {o.window_days} days.")
                             + ("" if o is None else
                                (" Learned from (reward {:.0f}).".format(o.reward) if o.learned else
                                 (" Comparison only - control outcomes are not learned from."
                                  if d.group == "Control" else " Not learned from - treatment not delivered."))))})
    return {
        "decision": _decision_row(d, o, _user_names(db), {camp.campaign_id: camp.name}, t,
                                  {c.customer_id: c.name}),
        "explanation": d.explanation, "exclusion_reason": d.exclusion_reason,
        "blocked_arms": blocked,
        "evaluations": [{"arm_id": e.arm_id, "arm": t[e.arm_id].name if e.arm_id in t else e.arm_id,
                         "arm_version": e.arm_version, "stage": e.stage, "rule_id": e.rule_id,
                         "rule_version": e.rule_version, "result": e.result, "reason_code": e.reason_code,
                         "reason": e.reason, "input_refs": jl(e.input_refs, {}), "evaluated_at": e.evaluated_at}
                        for e in evals],
        "context": None if fs is None else {
            "feature_snapshot_id": fs.snapshot_id, "contract_version": fs.contract_version,
            "request_id": fs.request_id, "as_of": fs.as_of_ts, "received_at": fs.received_at,
            "feature_set_version": fs.feature_set_version, "assumed": jl(fs.assumed),
            "ignored_fields": jl(fs.ignored_fields), "aliases_used": jl(fs.aliases_used),
            "lineage_only": jl(fs.lineage_only), "source_lineage": jl(fs.source_lineage, {}),
            "staleness": jl(fs.staleness, {}), "raw_payload": jl(fs.raw_payload, {})},
        "override_reason": d.override_reason, "original_treatment": d.original_treatment,
        "snapshot": snap, "ranking": ranking, "trace": trace,
        "factors": expl["contributions"], "self_cure": expl["self_cure_score"],
        "nudges": [{"nudge_id": n.nudge_id, "channel": n.channel, "status": n.status,
                    "scheduled_at": n.scheduled_at, "touch": n.touch_number, "escalation": n.is_escalation}
                   for n in nudges],
        "metadata": {"decision_id": d.decision_id, "timestamp": d.decided_at, "origin": d.origin,
                     "model": cfg(db, "model_version"), "strategy": d.campaign_id,
                     "strategy_version": camp.version, "segment": snap.get("segment"),
                     "risk_band": snap.get("client_risk_band"), "latency_ms": d.latency_ms,
                     "selection_probability": d.selection_probability},
    }


class ReviewDecisionIn(BaseModel):
    approve: bool
    note: str = ""


@router.post("/decisions/{did}/review")
def review_decision(did: str, body: ReviewDecisionIn, user: User = Depends(require("override_decisions")),
                    db: Session = Depends(get_db)):
    d = db.get(Decision, did)
    if not d or d.review_status != "pending":
        raise HTTPException(409, "This decision is not waiting for review.")
    if not body.approve and not body.note.strip():
        raise HTTPException(400, "Give a reason for rejecting the offer.")
    with engine.ENGINE_LOCK:
        out = engine.approve_and_execute(db, d, user.user_id, body.approve)
    if out.get("cancelled"):
        summary = f"Cancelled {did} ({d.treatment_code}) at approval: {out['cancelled']}"
    elif body.approve:
        summary = f"Approved {did} ({d.treatment_code})" + (
            f" - held at send time: {out['note']}" if out.get("status") == "Held" else "")
    else:
        summary = f"Rejected {did} ({d.treatment_code})"
    audit(db, user.user_id, "APPROVE" if body.approve else "UPDATE", "decision", did,
          summary + (f": {body.note}" if body.note else ""))
    db.commit()
    return out


class OverrideIn(BaseModel):
    treatment_code: str | None
    reason: str = Field(min_length=5)


@router.post("/decisions/{did}/override")
def override_decision(did: str, body: OverrideIn, user: User = Depends(require("override_decisions")),
                      db: Session = Depends(get_db)):
    d = db.get(Decision, did)
    if not d or d.group != "Treatment":
        raise HTTPException(409, "Only a treated decision can be overridden.")
    fs = db.query(FeatureSnapshot).filter(FeatureSnapshot.decision_id == did).first()
    c = as_of_decision(json.loads(fs.features) if fs else json.loads(d.snapshot))
    if body.treatment_code and not eligibility(body.treatment_code, c)[0]:
        raise HTTPException(400, f"{body.treatment_code} is not eligible for this customer: "
                                 f"{eligibility(body.treatment_code, c)[1]}.")
    d.original_treatment = d.original_treatment or d.treatment_code
    d.treatment_code = body.treatment_code
    d.overridden = True
    d.override_reason = body.reason
    # A human choice is not evidence about the bandit's choice: stop learning from it.
    o = db.query(Outcome).filter(Outcome.decision_id == did).first()
    if o:
        o.learned = False
    audit(db, user.user_id, "UPDATE", "decision", did,
          f"Overrode {did}: {d.original_treatment} -> {body.treatment_code or 'no treatment'}",
          {"reason": body.reason})
    db.commit()
    return {"ok": True}


@router.get("/nudges")
def nudges(status: str = "", campaign: str = "", page: int = 1, page_size: int = 30,
           user: User = Depends(require("view_ai_decisions")), db: Session = Depends(get_db)):
    q = db.query(Nudge).filter(Nudge.scheduled_at <= now())
    if status:
        q = q.filter(Nudge.status == status)
    if campaign:
        q = q.filter(Nudge.campaign_id == campaign)
    total = q.count()
    rows = q.order_by(Nudge.scheduled_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    cust = {c.customer_id: c.name for c in db.query(models.Customer).filter(
        models.Customer.customer_id.in_([n.customer_id for n in rows]))}
    counts = dict(db.query(Nudge.status, func.count()).filter(Nudge.scheduled_at <= now())
                  .group_by(Nudge.status).all())
    return {"total": total, "counts": counts, "rows": [
        {"nudge_id": n.nudge_id, "decision_id": n.decision_id, "campaign_id": n.campaign_id,
         "customer_id": n.customer_id, "customer": cust.get(n.customer_id), "channel": n.channel,
         "treatment_code": n.treatment_code, "status": n.status, "touch": n.touch_number,
         "escalation": n.is_escalation, "manual": n.manual, "scheduled_at": n.scheduled_at,
         "sent_at": n.sent_at} for n in rows]}


@router.get("/nudges/{nid}")
def nudge_detail(nid: str, user: User = Depends(require("view_ai_decisions")), db: Session = Depends(get_db)):
    n = db.get(Nudge, nid)
    if not n:
        raise HTTPException(404, "Nudge not found.")
    c = db.get(models.Customer, n.customer_id)
    d = db.get(Decision, n.decision_id)
    events = db.query(EngagementEvent).filter(EngagementEvent.nudge_id == nid).order_by(EngagementEvent.at).all()
    ranking = jl(d.ranking) if d else []
    chosen = next((r for r in ranking if r["code"] == n.treatment_code), None)
    sent = datetime.fromisoformat(n.sent_at) if n.sent_at else None
    first_click = next((e for e in events if e.event == "Clicked"), None)
    violations = db.query(ComplianceViolation).filter(ComplianceViolation.nudge_id == nid).all()
    return {
        "nudge": {"nudge_id": n.nudge_id, "decision_id": n.decision_id, "campaign_id": n.campaign_id,
                  "customer_id": n.customer_id, "customer": c.name, "channel": n.channel,
                  "treatment_code": n.treatment_code, "status": n.status, "touch": n.touch_number,
                  "escalation": n.is_escalation, "manual": n.manual, "scheduled_at": n.scheduled_at,
                  "sent_at": n.sent_at, "failure_reason": n.failure_reason, "content": n.content},
        "pipeline": jl(n.pipeline),
        "reasoning": {
            "summary": (d.explanation if d and n.touch_number == 1 and not n.manual else
                        ("Manual message sent by a strategist." if n.manual else
                         ("Escalation step from the strategy's escalation rule." if n.is_escalation
                          else f"Follow-up touch {n.touch_number} on the strategy's cadence."))),
            "fit_reasons": chosen["fit_reasons"] if chosen else fit_reasons(n.treatment_code, c),
            "ranking": ranking,
        },
        "engagement": {
            "events": [{"event": e.event, "at": e.at} for e in events],
            "opened": any(e.event == "Opened" for e in events),
            "clicked": first_click is not None,
            "form_completed": any(e.event == "FormCompleted" for e in events),
            "time_to_click_min": round((datetime.fromisoformat(first_click.at) - sent).total_seconds() / 60)
            if first_click and sent else None},
        "violations": [{"violation_id": v.violation_id, "rule": v.rule, "severity": v.severity,
                        "status": v.status} for v in violations],
    }


@router.get("/activity")
def activity(limit: int = 60, user: User = Depends(require("view_ai_decisions")), db: Session = Depends(get_db)):
    t = _treatments(db)
    cust = {c.customer_id: c.name for c in db.query(models.Customer)}
    items = []
    for d in db.query(Decision).filter(Decision.decided_at <= now()).order_by(Decision.decided_at.desc()).limit(limit):
        items.append({"at": d.decided_at, "kind": "decision", "id": d.decision_id, "campaign_id": d.campaign_id,
                      "title": (f"{cust.get(d.customer_id)} held out as control" if d.group == "Control" else
                                f"{t[d.treatment_code].name} chosen for {cust.get(d.customer_id)}"
                                if d.treatment_code in t else f"No treatment allowed for {cust.get(d.customer_id)}")
                               + (" · asked by Nova" if d.origin == "mcp" else ""),
                      "detail": d.explanation[:140], "status": d.review_status if d.review_policy != "auto" else d.group})
    for n in db.query(Nudge).filter(Nudge.sent_at.isnot(None), Nudge.sent_at <= now()).order_by(Nudge.sent_at.desc()).limit(limit):
        items.append({"at": n.sent_at, "kind": "nudge", "id": n.nudge_id, "campaign_id": n.campaign_id,
                      "title": f"{n.channel} to {cust.get(n.customer_id)}", "detail": n.content[:140],
                      "status": n.status})
    for o in db.query(Outcome).filter(Outcome.paid.is_(True), Outcome.observed_at <= now()).order_by(Outcome.observed_at.desc()).limit(limit // 2):
        items.append({"at": o.observed_at, "kind": "payment", "id": o.decision_id, "campaign_id": o.campaign_id,
                      "title": f"${o.amount:,.2f} received from {cust.get(o.customer_id)}",
                      "detail": f"{o.days_to_pay} days after the decision", "status": "Paid"})
    items.sort(key=lambda i: i["at"], reverse=True)
    return {"items": items[:limit]}
