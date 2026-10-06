"""Production entrypoint: the API under /api and the built React app at /.

One process, one URL - on Render's free tier that means a single cold start
and no cross-origin configuration.
"""
import os

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .core.config import settings
from .main import app as api, lifespan

STATIC_DIR = settings.static_dir


class SPAStaticFiles(StaticFiles):
    """Serve index.html for unknown paths so client-side routes survive a refresh."""

    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404:
                return FileResponse(os.path.join(self.directory, "index.html"))
            raise


# Mounted sub-apps do not run their own lifespan, so seeding and the MCP
# transport start from here. The MCP endpoint is then /api/mcp.
app = FastAPI(title="Adaptive Recovery Intelligence", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


app.mount("/api", api)

if os.path.isdir(STATIC_DIR):
    app.mount("/", SPAStaticFiles(directory=STATIC_DIR, html=True), name="spa")
