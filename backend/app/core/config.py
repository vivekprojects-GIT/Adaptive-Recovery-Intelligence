"""Settings, read once from the environment. Nothing else reads os.environ."""
from __future__ import annotations

import os
from dataclasses import dataclass

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REPO_DIR = os.path.dirname(BACKEND_DIR)


def _list(value: str) -> list[str]:
    return [x.strip() for x in value.split(",") if x.strip()]


@dataclass(frozen=True)
class Settings:
    # SQLAlchemy URL. Defaults to a SQLite file next to the backend.
    database_url: str
    # Where the built React app lives, for the production entrypoint.
    static_dir: str
    # Origins allowed to call the API from a browser. Empty: same origin only
    # (the Vite dev server proxies /api, and production serves one URL).
    cors_origins: list[str]
    # Bearer token for the MCP endpoint. Empty: ARI generates one and keeps it
    # in platform configuration, where an admin can reveal or rotate it.
    mcp_token: str


def load() -> Settings:
    return Settings(
        database_url=os.getenv("DATABASE_URL", f"sqlite:///{os.path.join(BACKEND_DIR, 'recovery.db')}"),
        static_dir=os.getenv("STATIC_DIR", os.path.join(REPO_DIR, "frontend", "dist")),
        cors_origins=_list(os.getenv("ARI_CORS_ORIGINS", "")),
        mcp_token=os.getenv("ARI_MCP_TOKEN", "").strip(),
    )


settings = load()
