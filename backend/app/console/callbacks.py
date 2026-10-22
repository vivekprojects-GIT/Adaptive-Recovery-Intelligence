"""Telling Nova when a person changes one of its decisions.

A decision Nova asked for can wait for a reviewer (payment plans, deferrals,
hardship offers, balances over the review threshold). When the reviewer
approves, rejects or overrides it, or it is cancelled at approval, Nova needs
to know so the treatment can be carried out or stopped. Two ways, both always
on:

  Push   each event is POSTed to the callback URL set in Platform Config
         (nova_callback_url), signed with HMAC-SHA256 over the raw body in
         X-ARI-Signature. Failed deliveries are retried on the next event,
         up to MAX_ATTEMPTS, or from API & Integrations.
  Pull   the MCP tool get_decision_updates returns the events after a
         cursor (event_id), for a caller with no URL to receive on.

Events are kept in an outbox (decision_events), written in the same
transaction as the change they describe, so none is lost if delivery fails.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from ..core.config import settings
from ..core.database import SessionLocal
from .models import Decision, DecisionEvent, PlatformConfig
from .platform import audit, cfg, now

UTC = timezone.utc
SECRET_KEY = "_callback_secret"
MAX_ATTEMPTS = 5
TIMEOUT_S = 5.0
EVENTS = ("decision.approved", "decision.rejected", "decision.cancelled", "decision.overridden")
_lock = threading.Lock()


def _new_secret() -> str:
    return "whsec_" + secrets.token_urlsafe(24)


def secret(db: Session) -> tuple[str, str]:
    """(signing secret, where it comes from). Created on first use."""
    if settings.callback_secret:
        return settings.callback_secret, "environment (ARI_CALLBACK_SECRET)"
    row = db.get(PlatformConfig, SECRET_KEY)
    if row is None:
        row = PlatformConfig(key=SECRET_KEY, value=_new_secret(), label="Callback signing secret",
                             group="Integrations", kind="secret", help="Signs callbacks to Nova.",
                             updated_by="system", updated_at=now())
        db.add(row)
        db.commit()
    return row.value, "platform configuration"


def rotate_secret(db: Session, actor: str) -> str:
    if settings.callback_secret:
        raise ValueError("The secret is set by ARI_CALLBACK_SECRET in the server environment; change it there.")
    secret(db)
    row = db.get(PlatformConfig, SECRET_KEY)
    row.value, row.updated_by, row.updated_at = _new_secret(), actor, now()
    audit(db, actor, "UPDATE", "integration", "callbacks", "Rotated the callback signing secret")
    db.commit()
    return row.value


def sign(key: str, body: bytes) -> str:
    return "sha256=" + hmac.new(key.encode(), body, hashlib.sha256).hexdigest()


def record(db: Session, dec: Decision, event: str, actor: str, note: str = "") -> DecisionEvent | None:
    """Queue an event for a decision Nova asked for. Console decisions are not Nova's: nothing is queued."""
    if dec.origin != "mcp":
        return None
    assert event in EVENTS, event
    from . import nova   # nova imports this module's neighbours; import late
    try:
        current = nova.get_decision(db, dec.decision_id)
    except nova.NovaError:
        current = {"decision_id": dec.decision_id}
    account = (current.get("customer") or {}).get("account_id") or current.get("account_id")
    ev = DecisionEvent(decision_id=dec.decision_id, account_ref=account, event=event,
                       actor=actor, created_at=now(), status="pending", attempts=0)
    db.add(ev)
    db.flush()
    ev.payload = json.dumps({"event_id": ev.event_id, "event": event, "occurred_at": ev.created_at,
                             "decision_id": dec.decision_id, "account_id": ev.account_ref,
                             "request_id": dec.request_id, "review_status": dec.review_status,
                             "by": actor, "note": note.strip() or None, "decision": current},
                            default=str, separators=(",", ":"))
    return ev


def _deliver_one(client: httpx.Client, url: str, key: str, ev: DecisionEvent) -> None:
    body = ev.payload.encode()
    ev.attempts += 1
    ev.last_attempt_at = now()
    try:
        r = client.post(url, content=body, headers={
            "Content-Type": "application/json", "X-ARI-Event": ev.event, "X-ARI-Event-Id": str(ev.event_id),
            "X-ARI-Signature": sign(key, body), "User-Agent": "ARI-callbacks/1"})
        if 200 <= r.status_code < 300:
            ev.status, ev.delivered_at, ev.last_error = "delivered", now(), None
        else:
            ev.status, ev.last_error = "failed", f"HTTP {r.status_code}: {r.text[:200]}"
    except httpx.HTTPError as e:
        ev.status, ev.last_error = "failed", f"{type(e).__name__}: {e}"[:300]


def deliver_pending(db: Session) -> dict:
    """Send every event not yet delivered (pending, or failed with attempts left)."""
    url = (cfg(db, "nova_callback_url") or "").strip()
    rows = (db.query(DecisionEvent).filter(DecisionEvent.status.in_(["pending", "failed", "not_configured"]),
                                           DecisionEvent.attempts < MAX_ATTEMPTS)
            .order_by(DecisionEvent.event_id).all())
    if not url:
        for ev in rows:
            ev.status = "not_configured"
        db.commit()
        return {"sent": 0, "delivered": 0, "failed": 0, "waiting": len(rows), "configured": False}
    key, _ = secret(db)
    with httpx.Client(timeout=TIMEOUT_S) as client:
        for ev in rows:
            _deliver_one(client, url, key, ev)
    db.commit()
    return {"sent": len(rows), "delivered": sum(e.status == "delivered" for e in rows),
            "failed": sum(e.status == "failed" for e in rows), "waiting": 0, "configured": True}


def dispatch() -> None:
    """Deliver in the background, so a reviewer never waits on Nova's endpoint."""
    def run() -> None:
        with _lock:
            db = SessionLocal()
            try:
                deliver_pending(db)
            finally:
                db.close()
    threading.Thread(target=run, name="ari-callbacks", daemon=True).start()


def updates(db: Session, after: int = 0, limit: int = 100) -> dict:
    """Events after a cursor, oldest first: the pull side of the same outbox."""
    rows = (db.query(DecisionEvent).filter(DecisionEvent.event_id > after).order_by(DecisionEvent.event_id)
            .limit(max(1, min(limit, 500))).all())
    return {"events": [json.loads(e.payload) for e in rows],
            "next_cursor": rows[-1].event_id if rows else after, "more": len(rows) == max(1, min(limit, 500))}


def status(db: Session) -> dict:
    rows = db.query(DecisionEvent).order_by(DecisionEvent.event_id.desc()).all()
    counts: dict[str, int] = {}
    for e in rows:
        counts[e.status] = counts.get(e.status, 0) + 1
    _, source = secret(db)
    return {"url": (cfg(db, "nova_callback_url") or "").strip() or None, "secret_source": source,
            "events": len(rows), "by_status": counts, "max_attempts": MAX_ATTEMPTS,
            "recent": [{"event_id": e.event_id, "event": e.event, "decision_id": e.decision_id,
                        "account_id": e.account_ref, "status": e.status, "attempts": e.attempts,
                        "created_at": e.created_at, "delivered_at": e.delivered_at, "last_error": e.last_error}
                       for e in rows[:20]],
            "checked_at": datetime.now(UTC).isoformat(timespec="seconds")}
