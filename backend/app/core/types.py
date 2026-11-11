"""Column types for times and dates.

Postgres stores them as real TIMESTAMP WITH TIME ZONE and DATE columns, so
the database can sort, compare and index them as times. SQLite has no date
type, so there they are stored as canonical ISO 8601 text, which sorts in time
order. Either way the application reads and writes ISO strings
("2026-11-06T06:00:00+00:00", "2026-11-06"), so code and API answers are the
same on both databases.

Every value is checked on the way in: a string that is not an ISO time is
refused, a time without a zone is taken as UTC, and every time is stored in
UTC to the second.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import Date, DateTime, String
from sqlalchemy.types import TypeDecorator

UTC = timezone.utc


def _to_datetime(value: str | datetime) -> datetime:
    dt = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).strip())
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).replace(microsecond=0)


def _to_date(value: str | date) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value).strip()[:10])


class IsoTimestamp(TypeDecorator):
    """A point in time: TIMESTAMP WITH TIME ZONE on Postgres, ISO text on SQLite."""
    impl = String(32)
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "sqlite":
            return dialect.type_descriptor(String(32))
        return dialect.type_descriptor(DateTime(timezone=True))

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        dt = _to_datetime(value)
        return dt.isoformat(timespec="seconds") if dialect.name == "sqlite" else dt

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if isinstance(value, datetime):
            return _to_datetime(value).isoformat(timespec="seconds")
        return value


class IsoDate(TypeDecorator):
    """A calendar date: DATE on Postgres, ISO text (YYYY-MM-DD) on SQLite."""
    impl = String(10)
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "sqlite":
            return dialect.type_descriptor(String(10))
        return dialect.type_descriptor(Date())

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        d = _to_date(value)
        return d.isoformat() if dialect.name == "sqlite" else d

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return value.isoformat() if isinstance(value, date) else value
