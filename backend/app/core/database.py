"""SQLAlchemy engine and sessions. SQLite by default; any SQLAlchemy URL
(Postgres in a persistent deployment) through DATABASE_URL."""
from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings

DATABASE_URL = settings.database_url
IS_SQLITE = DATABASE_URL.startswith("sqlite")
# The SQLite file, for the System Health page; None for a server database.
DB_PATH = DATABASE_URL.removeprefix("sqlite:///") if IS_SQLITE else None

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if IS_SQLITE else {})
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
