import shutil
import tempfile
import traceback
from pathlib import Path

import db as _db
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import CORS_ORIGINS
from routes import movements, notes, refine, repos, runs, worktree

app = FastAPI(title="Phoenix ImplementerAgent", version="5.0.0")


@app.on_event("startup")
async def _on_startup() -> None:
    """Initialise SQLite DB and clean up stale worktrees from previous crashes."""
    await _db.init_db()
    tmp = Path(tempfile.gettempdir())
    for d in tmp.glob("pnx-*"):
        if d.is_dir():
            try:
                shutil.rmtree(d, ignore_errors=True)
            except Exception:
                pass


_allow_origins = (
    [o.strip() for o in CORS_ORIGINS.split(",") if o.strip()]
    if CORS_ORIGINS
    else []
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins if _allow_origins else ["*"],
    allow_origin_regex=None if _allow_origins else r"http://localhost:\d+",
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
async def health() -> dict:
    from registry import _runs
    return {"ok": True, "version": "5.0.0", "active_runs": len(_runs)}


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
    """Return JSON errors with CORS headers so the browser sees the message."""
    origin = request.headers.get("origin", "*")
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc)},
        headers={"Access-Control-Allow-Origin": origin},
    )


app.include_router(runs.router)
app.include_router(refine.router)
app.include_router(worktree.router)
app.include_router(repos.router)
app.include_router(movements.router)
app.include_router(notes.router)
