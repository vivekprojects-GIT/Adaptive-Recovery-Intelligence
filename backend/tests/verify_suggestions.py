"""Check suggested strategies end to end, through the real API, on a
throwaway database: what is suggested, the evidence behind it, and that
choosing a suggestion creates a draft that goes through approval.

    cd backend
    .venv/Scripts/python.exe tests/verify_suggestions.py      (Windows)
    .venv/bin/python tests/verify_suggestions.py              (macOS / Linux)

Exits non-zero if any check fails.
"""
from __future__ import annotations

import os
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TMP = tempfile.mkdtemp(prefix="ari-suggest-")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(TMP, 'suggest.db')}"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

MAYA, JAMES = {"X-User-Id": "u-maya"}, {"X-User-Id": "u-james"}
failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


with TestClient(app) as api:
    print("\n1. What ARI suggests")
    r = api.get("/console/strategies/suggestions", headers=MAYA)
    data = r.json()
    sg = data["suggestions"]
    check(r.status_code == 200 and 1 <= len(sg) <= 3, f"{len(sg)} suggestions of {data['considered']} ideas")
    check(all(s["why"] and s["caveats"] and s["treatments"] and s["confidence"] for s in sg),
          "each suggestion carries its reasons, caveats, treatments and an evidence level")
    check(all(t["evidence"]["n"] >= 0 and 0 < t["reach"] <= 1 for s in sg for t in s["treatments"]),
          "each treatment shows its sample size and how much of the audience it is open to")
    new = next((s for s in sg if s["kind"] == "new"), None)
    rev = next((s for s in sg if s["kind"] == "revision"), None)
    check(new is not None, f"an uncovered audience is suggested: {new and new['title']}")
    check(rev is not None, f"a live strategy that is falling short is suggested: {rev and rev['title']}")
    support = [s for s in data["suggestions"] if "Lost Cause" in (s.get("fields", {}).get("include_segments") or [])]
    check(all(any(t["name"] == "Hardship Review" for t in s["treatments"]) for s in support),
          "an audience with customers who need support always keeps the hardship route")
    check(any(l["segment"] == "Sure Thing" for l in data["left_out"]), "the fit groups left out are named, with why")
    r = api.get("/console/strategies/suggestions", headers={"X-User-Id": "u-james"})
    check(r.status_code == 403, "a role without Create Strategy cannot see suggestions (403)")

    print("\n2. Choosing a new-strategy suggestion")
    out = api.post(f"/console/strategies/suggestions/{new['key']}/draft", headers=MAYA).json()
    check(out.get("status") == "Draft" and out.get("source") == "suggested" and out.get("parent_id") is None,
          f"creates {out.get('campaign_id')} as a Draft, marked as suggested")
    check(out.get("treatment_codes") == [t["code"] for t in new["treatments"]],
          f"with the suggested treatments {out.get('treatment_codes')}")
    sub = api.post(f"/console/strategies/{out['campaign_id']}/submit", headers=MAYA)
    check(sub.status_code == 200 and sub.json()["status"] == "In review",
          "it passes the full validation and goes for approval like any strategy")
    own = api.post(f"/console/strategies/{out['campaign_id']}/approve", headers=MAYA, json={"note": ""})
    check(own.status_code in (403, 409), f"its author cannot approve it (maker-checker, {own.status_code})")

    print("\n3. Choosing a rework suggestion")
    out = api.post(f"/console/strategies/suggestions/{rev['key']}/draft", headers=MAYA).json()
    check(out.get("status") == "Draft" and out.get("parent_id") == rev["based_on"] and out.get("version", 0) >= 2,
          f"creates {out.get('campaign_id')} as v{out.get('version')} of {rev['based_on']}")
    live = api.get(f"/console/strategies/{rev['based_on']}", headers=MAYA).json()
    check(live["status"] == "Live", f"{rev['based_on']} keeps running until the new version is approved and launched")
    again = api.post(f"/console/strategies/suggestions/{rev['key']}/draft", headers=MAYA)
    check(again.status_code == 409 and out["campaign_id"] in again.json()["detail"],
          f"a second rework while that draft is open is refused (409): {again.json()['detail'][:70]}")
    stale = api.post("/console/strategies/suggestions/new-C9/draft", headers=MAYA)
    check(stale.status_code == 409, "a suggestion that no longer applies is refused (409)")
    audit = api.get("/console/admin/audit?q=suggestion", headers={"X-User-Id": "u-priya"})
    check(audit.status_code == 200 and "ARI suggestion" in audit.text, "each choice is in the audit log")

print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}. Database: {TMP}")
sys.exit(1 if failures else 0)
