"""Check the database schema on a throwaway database: honest table names,
declared and enforced foreign keys, real time types, and the upgrade of an
older database that has none of them.

    cd backend
    .venv/Scripts/python.exe tests/verify_schema.py      (Windows)
    .venv/bin/python tests/verify_schema.py              (macOS / Linux)

Exits non-zero if any check fails.
"""
from __future__ import annotations

import os
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TMP = tempfile.mkdtemp(prefix="ari-schema-")
os.environ["DATABASE_URL"] = os.environ.get("ARI_TEST_DATABASE_URL") or f"sqlite:///{os.path.join(TMP, 'schema.db')}"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import inspect, text  # noqa: E402
from sqlalchemy.exc import IntegrityError, StatementError  # noqa: E402

from app import main, models  # noqa: E402
from app.console.models import Campaign, Decision  # noqa: E402
from app.core.database import IS_SQLITE, Base, SessionLocal, engine  # noqa: E402
from app.core.migrate import upgrade  # noqa: E402
from app.core.types import IsoDate, IsoTimestamp  # noqa: E402

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


main.startup()

print("\n1. Table names say what they hold")
names = set(inspect(engine).get_table_names())
check({"treatments", "strategies"} <= names and "campaigns" not in names,
      "the playbook is in `treatments`, strategies are in `strategies`, no `campaigns`")
check(models.Strategy.__tablename__ == "treatments" and Campaign.__tablename__ == "strategies",
      "the models map to the new names")

print("\n2. Every link is a declared foreign key")
fks = {(t.name, fk.parent.name, fk.column.table.name) for t in Base.metadata.tables.values() for fk in t.foreign_keys}
for want in (("decisions", "customer_id", "customers"), ("decisions", "campaign_id", "strategies"),
             ("decisions", "treatment_code", "treatments"), ("nudges", "customer_id", "customers"),
             ("outcomes", "decision_id", "decisions"), ("customers", "cohort_id", "cohorts"),
             ("contact_records", "nudge_id", "nudges"), ("kg_edges", "src", "kg_nodes"),
             ("placements", "customer_id", "customers"), ("treatment_meta", "code", "treatments")):
    check(want in fks, f"{want[0]}.{want[1]} references {want[2]}")
check(len(fks) >= 37, f"{len(fks)} foreign keys declared in all")

print("\n3. The database enforces them")
db = SessionLocal()
camp = db.query(Campaign).first()
db.add(Decision(decision_id="D-NOPE", campaign_id=camp.campaign_id, customer_id=99_999_999, wave=0, group="Control",
                decided_at="2026-11-06T06:00:00+00:00"))
try:
    db.commit()
    check(False, "a decision about a customer that does not exist is refused")
except IntegrityError:
    db.rollback()
    check(True, "a decision about a customer that does not exist is refused")
if IS_SQLITE:
    check(db.execute(text("PRAGMA foreign_key_check")).fetchall() == [], "the seeded data has no broken references")

print("\n4. Times are real times")
cols = {c.name: c.type for c in Decision.__table__.columns}
check(isinstance(cols["decided_at"], IsoTimestamp), "decisions.decided_at is a timestamp")
from app.console.models import PaymentRecord, RecoveryAccount  # noqa: E402
check(isinstance(PaymentRecord.__table__.c.payment_date.type, IsoDate)
      and isinstance(RecoveryAccount.__table__.c.charge_off_date.type, IsoDate), "payment and charge-off dates are dates")
d = db.query(Decision).order_by(Decision.decided_at).first()
check(d.decided_at.endswith("+00:00") and "T" in d.decided_at, f"times read back as ISO strings in UTC ({d.decided_at})")
db.add(Decision(decision_id="D-BADTIME", campaign_id=camp.campaign_id, customer_id=d.customer_id, wave=0,
                group="Control", decided_at="yesterday"))
try:
    db.commit()
    check(False, "a time that is not ISO 8601 is refused")
except StatementError:
    db.rollback()
    check(True, "a time that is not ISO 8601 is refused")
later = db.query(Decision).filter(Decision.decided_at >= "2026-01-01T00:00:00-05:00").count()
check(later == db.query(Decision).count(), "times compare as times, whatever zone the comparison is written in")
db.close()

print("\n5. An older database is upgraded without losing a row")
if not IS_SQLITE:
    print("  SKIP  the in-place rebuild is for SQLite; a server database is created fresh")
else:
    db = SessionLocal()
    counts = {t: db.execute(text(f'SELECT COUNT(*) FROM "{t}"')).scalar() for t in ("treatments", "strategies", "decisions")}
    db.close()
    raw = engine.raw_connection()
    cur = raw.cursor()
    cur.execute("PRAGMA foreign_keys = OFF")
    cur.execute("PRAGMA legacy_alter_table = ON")
    for stmt in ('ALTER TABLE strategies RENAME TO campaigns', 'ALTER TABLE treatments RENAME TO strategies',
                 'CREATE TABLE _plain AS SELECT * FROM decisions', 'DROP TABLE decisions',
                 'ALTER TABLE _plain RENAME TO decisions'):
        cur.execute(stmt)
    raw.commit()
    cur.execute("PRAGMA foreign_keys = ON")
    raw.close()
    old = set(inspect(engine).get_table_names())
    check("campaigns" in old and "treatments" not in old, "built an old-style database: `campaigns`, no `treatments`")
    steps = upgrade(engine, Base.metadata)
    check(any("campaigns -> strategies" in s for s in steps) and any("strategies -> treatments" in s for s in steps),
          "the upgrade renames both tables")
    check(any("rebuilt decisions" in s for s in steps), "the upgrade rebuilds decisions with its foreign keys")
    db = SessionLocal()
    after = {t: db.execute(text(f'SELECT COUNT(*) FROM "{t}"')).scalar() for t in ("treatments", "strategies", "decisions")}
    have = {(r[3], r[2]) for r in db.execute(text("PRAGMA foreign_key_list(decisions)"))}
    db.close()
    check(after == counts, f"every row kept: {after}")
    check(("customer_id", "customers") in have and ("campaign_id", "strategies") in have,
          "the rebuilt decisions table has its foreign keys")
    check(upgrade(engine, Base.metadata) == [], "running the upgrade again changes nothing")

print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}. Database: {TMP}")
sys.exit(1 if failures else 0)
