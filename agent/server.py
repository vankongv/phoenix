"""
Phoenix v5 — ImplementerAgent server
FastAPI + OpenHands SDK — uses git worktrees to give each agent an isolated
workspace from a shared base clone, pushes a branch, and opens a draft PR.
Progress is streamed via SSE.

Run:
    uvicorn app:app --host 0.0.0.0 --port 8001
"""

import argparse

from app import app  # noqa: F401  — re-exported for `uvicorn server:app`


def serve() -> None:
    """Entry point for `phoenix-agent` / `uvx phoenix-agent`."""
    import uvicorn

    parser = argparse.ArgumentParser(
        prog="phoenix-agent",
        description="Phoenix v5 agent server (OpenHands + FastAPI)",
    )
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8001, help="Bind port (default: 8001)")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload (dev mode)")
    args = parser.parse_args()

    # Use the app object directly so the entry point works regardless of cwd.
    # reload=True requires a string import path — fall back to module string only then.
    if args.reload:
        uvicorn.run("app:app", host=args.host, port=args.port, reload=True)
    else:
        uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    serve()
