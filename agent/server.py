"""
Phoenix v5 — ImplementerAgent server
FastAPI + OpenHands SDK — uses git worktrees to give each agent an isolated
workspace from a shared base clone, pushes a branch, and opens a draft PR.
Progress is streamed via SSE.

Run:
    uvicorn app:app --host 0.0.0.0 --port 8001

The bind port defaults to 8001 and can be overridden via the AGENT_PORT
environment variable (must be an integer in the range 1–65535).
"""

import argparse
import os
import sys

from app import app  # noqa: F401  — re-exported for `uvicorn server:app`

_DEFAULT_PORT = 8001


def _resolve_port() -> int:
    """Return the port to bind to, reading AGENT_PORT from the environment.

    Exits with a descriptive error message if the value is non-numeric or
    outside the valid port range (1–65535).
    """
    raw = os.environ.get("AGENT_PORT")
    if raw is None:
        return _DEFAULT_PORT
    try:
        port = int(raw)
    except ValueError:
        sys.exit(
            f"[phoenix-agent] Invalid AGENT_PORT value {raw!r}: "
            "must be an integer in the range 1–65535."
        )
    if not (1 <= port <= 65535):
        sys.exit(
            f"[phoenix-agent] Invalid AGENT_PORT value {port}: "
            "must be an integer in the range 1–65535."
        )
    return port


def serve() -> None:
    """Entry point for `phoenix-agent` / `uvx phoenix-agent`."""
    import uvicorn

    default_port = _resolve_port()

    parser = argparse.ArgumentParser(
        prog="phoenix-agent",
        description="Phoenix v5 agent server (OpenHands + FastAPI)",
    )
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument(
        "--port",
        type=int,
        default=default_port,
        help=f"Bind port (default: {default_port}, overridable via AGENT_PORT env var)",
    )
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
