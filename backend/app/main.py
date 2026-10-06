"""The ARI API: the console API under /console, the MCP endpoint agents call
at /mcp, and a health check. The production entrypoint (server.py) mounts
this app at /api and serves the built web app beside it."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.routing import Route

from . import models
from .console import models as console_models
from .console.mcp_server import ENDPOINT_PATH as MCP_PATH, gateway as mcp_gateway, server as mcp_server
from .console.platform import metrics_middleware
from .console.routes import router as console_router
from .console.seed import seed_console
from .core.config import settings
from .core.database import Base, SessionLocal, engine
from .seed import seed

# Imported for their side effect: registering the tables with Base.metadata.
_TABLE_MODULES = (models, console_models)


def startup() -> None:
    """Create the schema, load the base data on an empty database, then bring
    the console data and reference settings up to date."""
    Base.metadata.create_all(engine)
    db = SessionLocal()
    try:
        empty = db.query(models.Customer).count() == 0 or db.query(models.Strategy).count() == 0
    except Exception:
        empty = True
    finally:
        db.close()
    if empty:
        seed(reset=True)
    db = SessionLocal()
    try:
        seed_console(db)
    finally:
        db.close()


@asynccontextmanager
async def lifespan(_app):
    """Seed, then keep the MCP transport's task group running for the app's
    life. server.py runs this same lifespan, because a mounted app's own
    lifespan never runs."""
    startup()
    async with mcp_server.session_manager.run():
        yield


app = FastAPI(title="ARI API", version="4.2.0", lifespan=lifespan)
if settings.cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                       allow_methods=["*"], allow_headers=["*"])
app.middleware("http")(metrics_middleware)
app.include_router(console_router)
# MCP: agents such as Nova's ask for recovery decisions here (console/mcp_server.py).
app.router.routes.append(Route(MCP_PATH, endpoint=mcp_gateway))


@app.get("/health")
def health():
    return {"status": "ok"}
