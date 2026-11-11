"""Bring an existing database up to the current schema before startup.

Runs on every start, and does nothing once a database is current.

  1. Table names. The treatment playbook used to live in `strategies` and the
     strategies in `campaigns`; they are now `treatments` and `strategies`.
  2. Foreign keys (SQLite only). SQLite cannot add a constraint to an existing
     table, so a table whose declared foreign keys are missing is rebuilt:
     renamed aside, created again from the models, its rows copied across,
     and the old copy dropped. No row is lost, and the rebuilt tables are
     checked with PRAGMA foreign_key_check before the change is kept.

A Postgres database gets the renames here; it is otherwise created fresh by
create_all, with every constraint, or migrated by the deployment.
"""
from __future__ import annotations

import logging

from sqlalchemy import Engine, MetaData, inspect, text
from sqlalchemy.schema import CreateIndex, CreateTable

log = logging.getLogger("care.migrate")

# (old name, new name, a column only the old table has), applied in this order.
RENAMES = [("strategies", "treatments", "cost_per_contact"),
           ("campaigns", "strategies", "treatment_codes")]


def _rename(engine: Engine) -> list[str]:
    done = []
    with engine.begin() as conn:
        for old, new, marker in RENAMES:
            insp = inspect(conn)
            names = set(insp.get_table_names())
            if old in names and new not in names and marker in {c["name"] for c in insp.get_columns(old)}:
                conn.execute(text(f'ALTER TABLE "{old}" RENAME TO "{new}"'))
                done.append(f"{old} -> {new}")
    return done


def _declared(table) -> set[tuple[str, str, str]]:
    return {(fk.parent.name, fk.column.table.name, fk.column.name) for fk in table.foreign_keys}


def _rebuild_sqlite(engine: Engine, metadata: MetaData) -> list[str]:
    raw = engine.raw_connection()
    try:
        cur = raw.cursor()
        tables = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        stale = []
        for t in metadata.sorted_tables:
            if t.name not in tables:
                continue
            have = {(r[3], r[2], r[4]) for r in cur.execute(f'PRAGMA foreign_key_list("{t.name}")')}
            (ddl,) = cur.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (t.name,)).fetchone()
            deferred = ddl.upper().count("DEFERRABLE INITIALLY DEFERRED") >= len(t.foreign_key_constraints)
            if not _declared(t) <= have or not deferred:
                stale.append(t)
        if not stale:
            return []
        # Constraints off and references left alone while tables are swapped.
        cur.execute("PRAGMA foreign_keys = OFF")
        cur.execute("PRAGMA legacy_alter_table = ON")
        cur.execute("BEGIN")
        try:
            for t in stale:
                old = f"_old_{t.name}"
                cur.execute(f'ALTER TABLE "{t.name}" RENAME TO "{old}"')
                for (ix,) in cur.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? "
                                         "AND sql IS NOT NULL", (old,)).fetchall():
                    cur.execute(f'DROP INDEX "{ix}"')
            for t in stale:   # parents first, so each create sees its references
                cur.execute(str(CreateTable(t).compile(dialect=engine.dialect)))
                for ix in t.indexes:
                    cur.execute(str(CreateIndex(ix).compile(dialect=engine.dialect)))
            for t in stale:
                old = f"_old_{t.name}"
                have = {r[1] for r in cur.execute(f'PRAGMA table_info("{old}")')}
                keep = ", ".join(f'"{c.name}"' for c in t.columns if c.name in have)
                cur.execute(f'INSERT INTO "{t.name}" ({keep}) SELECT {keep} FROM "{old}"')
                cur.execute(f'DROP TABLE "{old}"')
            broken = cur.execute("PRAGMA foreign_key_check").fetchall()
            if broken:
                raise RuntimeError(f"{len(broken)} rows point at rows that do not exist, e.g. {broken[:3]}")
            cur.execute("COMMIT")
        except Exception:
            cur.execute("ROLLBACK")
            raise
        finally:
            cur.execute("PRAGMA legacy_alter_table = OFF")
            cur.execute("PRAGMA foreign_keys = ON")
        return [f"rebuilt {t.name} with its foreign keys" for t in stale]
    finally:
        raw.close()


def upgrade(engine: Engine, metadata: MetaData) -> list[str]:
    """Rename and rebuild what an older database needs. Returns what was done."""
    done = _rename(engine)
    if engine.dialect.name == "sqlite":
        done += _rebuild_sqlite(engine, metadata)
    for step in done:
        log.warning("Schema upgrade: %s", step)
    return done
