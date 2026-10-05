"""End-to-end check of the treatment playbook, the strategy lifecycle and
Thompson sampling, through the real API, on a throwaway database.

    cd backend
    .venv/Scripts/python.exe tests/verify_thompson.py      (Windows)
    .venv/bin/python tests/verify_thompson.py              (macOS / Linux)

Needs httpx for FastAPI's TestClient (pip install httpx). Exits non-zero if
any check fails.

What "Thompson sampling works" means here, concretely:
  A. A new treatment with no history, which is truly the best arm, is
     explored and then kept: it ends with most of the allocation and a high
     posterior probability of being best.
  B. A new treatment with no history, which is truly weak, is explored early
     (a flat prior is optimistic) and then dropped as outcomes come in.
"""
from __future__ import annotations

import os
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # rule text uses ≥ and ≤; Windows consoles default to cp1252

TMP = tempfile.mkdtemp(prefix="ari-verify-")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(TMP, 'verify.db')}"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from app.console.models import Decision  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402

MAYA, JAMES, PRIYA = ({"X-User-Id": u} for u in ("u-maya", "u-james", "u-priya"))
failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


def ok(r, what: str):
    if r.status_code >= 400:
        raise SystemExit(f"{what}: HTTP {r.status_code} {r.text}")
    return r.json()


def launch(api, body: dict) -> str:
    cid = ok(api.post("/console/strategies", headers=MAYA, json=body), "create strategy")["campaign_id"]
    ok(api.post(f"/console/strategies/{cid}/submit", headers=MAYA), "submit")
    ok(api.post(f"/console/strategies/{cid}/approve", headers=JAMES, json={"note": ""}), "approve")
    ok(api.post(f"/console/strategies/{cid}/launch", headers=MAYA), "launch")
    return cid


def run_waves(api, cid: str, n: int) -> list[dict]:
    done, handoffs = 0, 0
    while done < n:
        out = ok(api.post(f"/console/strategies/{cid}/waves?count={min(10, n - done)}", headers=MAYA), "waves")
        handoffs += len(out["handoffs"])
        done += out["waves_run"]
        if out["waves_run"] == 0:
            raise SystemExit(f"{cid}: no wave ran - {out['message']}")
    print(f"  ran {done} waves on {cid}, {handoffs} automatic handoffs")
    return ok(api.get(f"/console/strategies/{cid}", headers=MAYA), "detail")["learning"]["waves"]


def show(traj: list[dict], codes: list[str]) -> None:
    print("  wave   " + "".join(f"{c:>14}" for c in codes) + "      P(best) at end of wave")
    for w in traj:
        share = "".join(f"{w['allocation'][c]:>13.0%} " for c in codes) if w["treated"] else \
            "".join(f"{'-':>13} " for _ in codes)
        best = "  ".join(f"{c} {w['posterior'][c]['p_best']:.2f}" for c in codes)
        print(f"  {w['label']:<7}{share}     {best}")


def share(traj: list[dict], code: str, waves: slice) -> float:
    rows = [w for w in traj[1:]][waves]
    treated = sum(w["treated"] for w in rows)
    return sum(w["counts"][code] for w in rows) / treated if treated else 0.0


with TestClient(app) as api:
    print("\n1. Treatment playbook")
    s7 = ok(api.post("/console/treatments", headers=MAYA, json={
        "name": "In-app instalment plan", "kind": "Arrangement", "channel": "App push",
        "offer": "Spread the arrears over 4 months in the app, no fee.", "timing": "Day 2", "cost": 0.5,
        "human_review": False, "rules": {}}), "create S7")
    check(s7["code"] == "S7" and s7["historical_n"] == 0 and s7["status"] == "Active",
          "new treatment takes the next code (S7), starts with no history and active")
    s8 = ok(api.post("/console/treatments", headers=MAYA, json={
        "name": "Courtesy call", "kind": "Outreach", "channel": "Outbound call",
        "offer": "A named agent calls to agree a payment date.", "timing": "Day 4", "cost": 3.5,
        "rules": {"max_dpd": 70}}), "create S8")
    check("70 days past due" in s8["eligibility_rule"], f"rules become readable text: '{s8['eligibility_rule']}'")
    r = api.post("/console/treatments", headers=MAYA, json={**s8, "kind": "Bogus"})
    check(r.status_code == 400, "an unknown kind is refused (400)")
    r = api.post("/console/treatments", headers={"X-User-Id": "u-james"}, json={**s8, "name": "Leader try"})
    check(r.status_code == 403, "a role without 'Manage Treatment Playbook' is refused (403)")
    prev = ok(api.post("/console/treatments/preview", headers=MAYA, json={"rules": {"requires_app_user": True}}),
              "preview")
    check(0 < prev["eligible"] < prev["customers"],
          f"rule preview: app users only reaches {prev['eligible']} of {prev['customers']} customers")
    tmp = ok(api.post("/console/treatments", headers=MAYA, json={
        "name": "Throwaway letter", "kind": "Reminder", "channel": "Letter", "offer": "A reminder letter.",
        "cost": 0.6, "rules": {"max_missed_payments": 0}}), "create S9")
    check(tmp["rules"].get("max_missed_payments") == 0, "a zero-valued rule (no missed payments) is kept")
    edited = ok(api.put(f"/console/treatments/{tmp['code']}", headers=MAYA, json={
        **{k: tmp[k] for k in ("name", "kind", "channel", "offer", "timing", "human_review")},
        "cost": tmp["cost"], "rules": {"max_missed_payments": 1}}), "edit S9")
    check(edited["version"] == 2 and edited["material_change"], "changing a rule is material: version 1 -> 2")
    retired = ok(api.post(f"/console/treatments/{tmp['code']}/retire", headers=MAYA), "retire")
    check(retired["status"] == "Retired", "retire sets status Retired")
    back = ok(api.post(f"/console/treatments/{tmp['code']}/activate", headers=MAYA), "activate")
    check(back["status"] == "Active", "reactivate sets status Active")
    r = api.delete(f"/console/treatments/{tmp['code']}", headers=MAYA)
    check(r.status_code == 200, "an unused treatment can be deleted")
    codes = [t["code"] for t in ok(api.get("/console/treatments", headers=MAYA), "list")]
    check(tmp["code"] not in codes, "deleted treatment is gone from the playbook")
    r = api.delete("/console/treatments/S1", headers=MAYA)
    check(r.status_code == 409, "a treatment used by strategies cannot be deleted (409) - retire instead")

    base = {"description": "Automated check", "target_cohorts": ["C2", "C3"], "include_segments": ["Persuadable"],
            "wave_size": 40, "control_pct": 0.2, "cadence_days": 3, "max_touches": 2, "tone": "Supportive",
            "send_window_start": 9, "send_window_end": 19, "evaluation_days": 7, "recovery_target": 0.4}

    print("\n2A. Thompson sampling finds a better new treatment (S7, no history) against S1 and S2")
    a = launch(api, {**base, "name": "TS check A", "treatment_codes": ["S1", "S2", "S7"]})
    traj = run_waves(api, a, 12)
    show(traj, ["S1", "S2", "S7"])
    final = traj[-1]["posterior"]
    check(final["S7"]["p_best"] > 0.9, f"S7 ends as the best arm with P(best) = {final['S7']['p_best']:.2f}")
    check(share(traj, "S7", slice(-4, None)) > 0.6,
          f"S7 gets {share(traj, 'S7', slice(-4, None)):.0%} of treated customers in the last 4 waves")

    print("\n2B. Thompson sampling drops a weak new treatment (S8, no history) against S1 and S3")
    b = launch(api, {**base, "name": "TS check B", "treatment_codes": ["S1", "S3", "S8"]})
    r = api.put(f"/console/strategies/{b}", headers=MAYA, json={**base, "name": "TS check B", "treatment_codes": ["S1"]})
    check(r.status_code == 409, "a live strategy is never edited in place, even before its first wave (409)")
    traj = run_waves(api, b, 12)
    show(traj, ["S1", "S3", "S8"])
    early, late = share(traj, "S8", slice(0, 2)), share(traj, "S8", slice(-4, None))
    check(early > 0.2, f"S8 is explored early: {early:.0%} of the first 2 waves")
    check(late < early / 2, f"S8 is dropped as evidence arrives: {late:.0%} of the last 4 waves")
    check(traj[-1]["posterior"]["S3"]["p_best"] > 0.85,
          f"S3 ends as the best arm with P(best) = {traj[-1]['posterior']['S3']['p_best']:.2f}")

    print("\n3. Editing a live strategy creates a new version")
    r = api.put(f"/console/strategies/{a}", headers=MAYA, json={**base, "name": "Edited in place", "treatment_codes": ["S1"]})
    check(r.status_code == 409, "a live strategy with history is not edited in place (409)")
    rev = ok(api.post(f"/console/strategies/{a}/revise", headers=MAYA), "revise")
    check(rev["parent_id"] == a and rev["version"] == 2 and rev["status"] == "Draft",
          f"Edit opens {rev['campaign_id']} as v2 draft of {a}")
    again = ok(api.post(f"/console/strategies/{a}/revise", headers=MAYA), "revise again")
    check(again["campaign_id"] == rev["campaign_id"], "a second Edit reuses the open v2 draft")
    detail = ok(api.get(f"/console/strategies/{a}", headers=MAYA), "detail")
    check(detail["open_revision"] == rev["campaign_id"], "the live version points at its open revision")
    ok(api.put(f"/console/strategies/{rev['campaign_id']}", headers=MAYA,
               json={**base, "name": "TS check A", "treatment_codes": ["S1", "S7"], "wave_size": 30}), "edit v2")
    ok(api.post(f"/console/strategies/{rev['campaign_id']}/submit", headers=MAYA), "submit v2")
    ok(api.post(f"/console/strategies/{rev['campaign_id']}/approve", headers=JAMES, json={"note": ""}), "approve")
    ok(api.post(f"/console/strategies/{rev['campaign_id']}/launch", headers=MAYA), "launch v2")
    old = ok(api.get(f"/console/strategies/{a}", headers=MAYA), "old")
    check(old["status"] == "Archived", f"launching v2 archives v1 ({a} is {old['status']})")
    ok(api.post(f"/console/strategies/{rev['campaign_id']}/waves", headers=MAYA), "wave v2")
    db = SessionLocal()
    v1 = {x for (x,) in db.query(Decision.customer_id).filter(Decision.campaign_id == a)}
    v2 = {x for (x,) in db.query(Decision.customer_id).filter(Decision.campaign_id == rev["campaign_id"])}
    db.close()
    check(bool(v2) and not (v1 & v2), f"v2 decided {len(v2)} new customers and none of v1's {len(v1)}")

    print("\n4. Delete")
    d = ok(api.post("/console/strategies", headers=MAYA, json={**base, "name": "Delete me",
                                                                 "treatment_codes": ["S1"]}), "draft")
    check(api.delete(f"/console/strategies/{d['campaign_id']}", headers=MAYA).status_code == 200,
          "a draft can be deleted")
    check(api.get(f"/console/strategies/{d['campaign_id']}", headers=MAYA).status_code == 404, "and it is gone")
    d = ok(api.post("/console/strategies", headers=MAYA, json={**base, "name": "Delete me too",
                                                                 "treatment_codes": ["S1"]}), "draft")
    ok(api.post(f"/console/strategies/{d['campaign_id']}/submit", headers=MAYA), "submit")
    check(api.delete(f"/console/strategies/{d['campaign_id']}", headers=MAYA).status_code == 200,
          "a strategy in review that never ran can be deleted")
    check(api.delete("/console/strategies/STR-021", headers=MAYA).status_code == 409, "a live strategy cannot")
    check(api.delete("/console/strategies/STR-022", headers=MAYA).status_code == 409,
          "a paused strategy with history cannot (archive it instead)")

    print("\n5. A wave that finds nobody is not counted")
    ok(api.put("/console/admin/config", headers=PRIYA, json={"values": {"auto_handoff": "false"}}), "config")
    for _ in range(30):
        before = ok(api.get("/console/strategies/STR-009", headers=MAYA), "detail")["waves_run"]
        out = ok(api.post("/console/strategies/STR-009/waves?count=10", headers=MAYA), "waves")
        if out["waves_run"] == 0:
            after = ok(api.get("/console/strategies/STR-009", headers=MAYA), "detail")["waves_run"]
            check(after == before and bool(out["message"]),
                  f"empty wave: counter stays at {after}, message shown")
            break
    else:
        check(False, "STR-009's pool never ran out")
    out = ok(api.post("/console/handoffs", headers=MAYA), "handoff")
    check(out["total"] > 0, f"manual handoff adds {out['total']} accounts")
    out = ok(api.post("/console/strategies/STR-009/waves", headers=MAYA), "wave after handoff")
    check(out["decided"] > 0, f"after the handoff the next wave decides {out['decided']} customers")

print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}. Database: {TMP}")
sys.exit(1 if failures else 0)
