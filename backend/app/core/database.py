"""SQLAlchemy engine and sessions. SQLite by default; Postgres (or any
SQLAlchemy database) through DATABASE_URL."""
from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings


def normalise(url: str) -> str:
    """Render and most hosts give postgres:// or postgresql:// URLs; SQLAlchemy
    needs the driver named, and this app uses psycopg 3."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


DATABASE_URL = normalise(settings.database_url)
IS_SQLITE = DATABASE_URL.startswith("sqlite")
# The SQLite file, for the System Health page; None for a server database.
DB_PATH = DATABASE_URL.removeprefix("sqlite:///") if IS_SQLITE else None

if IS_SQLITE:
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    # pool_pre_ping: a hosted database drops idle connections, so check one
    # before use instead of failing the request that gets it.
    engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=5, max_overflow=5)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency: one session per request, always closed."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
