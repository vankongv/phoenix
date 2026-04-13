"""
Phoenix v5 — SQLite persistence layer

Tables:
  repos            — repo selection history (full_name, last_accessed, access_count)
  issue_movements  — log of Kanban column moves
  run_logs         — persisted SSE events from agent runs

DB lives at  ~/.pnx/pnx.db  (same directory as the base-clone cache).
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import aiosqlite

DB_PATH = Path.home() / ".pnx" / "pnx.db"

_DDL = """
CREATE TABLE IF NOT EXISTS repos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name    TEXT UNIQUE NOT NULL,
    last_accessed TEXT NOT NULL,
    access_count INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS issue_movements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    repo         TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    from_column  TEXT NOT NULL,
    to_column    TEXT NOT NULL,
    moved_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movements_repo ON issue_movements(repo);

CREATE TABLE IF NOT EXISTS run_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id       TEXT NOT NULL,
    repo         TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    event_type   TEXT NOT NULL,
    data         TEXT NOT NULL,
    logged_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id);
"""


async def init_db() -> None:
    """Create DB file and tables if they don't exist yet."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(_DDL)
        await db.commit()


# ── Repos ──────────────────────────────────────────────────────────────────────

async def upsert_repo(full_name: str) -> None:
    """Insert or update a repo, bumping access_count and refreshing last_accessed."""
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO repos (full_name, last_accessed, access_count)
            VALUES (?, ?, 1)
            ON CONFLICT(full_name) DO UPDATE SET
                last_accessed = excluded.last_accessed,
                access_count  = access_count + 1
            """,
            (full_name, now),
        )
        await db.commit()


async def list_repos(limit: int = 50) -> list[dict]:
    """Return repos ordered by most recently accessed."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT full_name, last_accessed, access_count FROM repos "
            "ORDER BY last_accessed DESC LIMIT ?",
            (limit,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def delete_repo(full_name: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM repos WHERE full_name = ?", (full_name,))
        await db.commit()


# ── Issue movements ────────────────────────────────────────────────────────────

async def log_movement(
    repo: str, issue_number: int, from_column: str, to_column: str
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO issue_movements (repo, issue_number, from_column, to_column, moved_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (repo, issue_number, from_column, to_column, now),
        )
        await db.commit()


async def list_movements(
    repo: Optional[str] = None, limit: int = 200
) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if repo:
            async with db.execute(
                "SELECT * FROM issue_movements WHERE repo = ? "
                "ORDER BY moved_at DESC LIMIT ?",
                (repo, limit),
            ) as cur:
                return [dict(r) for r in await cur.fetchall()]
        async with db.execute(
            "SELECT * FROM issue_movements ORDER BY moved_at DESC LIMIT ?",
            (limit,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── Run logs ───────────────────────────────────────────────────────────────────

async def append_run_log(
    run_id: str,
    repo: str,
    issue_number: int,
    event_type: str,
    data: dict,
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO run_logs (run_id, repo, issue_number, event_type, data, logged_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (run_id, repo, issue_number, event_type, json.dumps(data), now),
        )
        await db.commit()


async def get_run_logs(run_id: str) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM run_logs WHERE run_id = ? ORDER BY id ASC",
            (run_id,),
        ) as cur:
            rows = await cur.fetchall()
    result = []
    for r in rows:
        d = dict(r)
        try:
            d["data"] = json.loads(d["data"])
        except (json.JSONDecodeError, TypeError):
            pass
        result.append(d)
    return result
