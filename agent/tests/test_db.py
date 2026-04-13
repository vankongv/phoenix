"""Tests for the SQLite persistence layer."""

import json
import pytest
import aiosqlite
from pathlib import Path
from unittest.mock import patch

import db


@pytest.fixture
def tmp_db(tmp_path, monkeypatch):
    """Redirect DB_PATH to a temp file for each test."""
    test_db = tmp_path / "test.db"
    monkeypatch.setattr(db, "DB_PATH", test_db)
    return test_db


async def test_init_db_creates_tables(tmp_db):
    await db.init_db()
    async with aiosqlite.connect(tmp_db) as conn:
        async with conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ) as cur:
            tables = {row[0] for row in await cur.fetchall()}
    assert {"repos", "issue_movements", "run_logs"} <= tables


async def test_upsert_repo_insert(tmp_db):
    await db.init_db()
    await db.upsert_repo("owner/repo")
    repos = await db.list_repos()
    assert len(repos) == 1
    assert repos[0]["full_name"] == "owner/repo"
    assert repos[0]["access_count"] == 1


async def test_upsert_repo_increments_count(tmp_db):
    await db.init_db()
    await db.upsert_repo("owner/repo")
    await db.upsert_repo("owner/repo")
    repos = await db.list_repos()
    assert repos[0]["access_count"] == 2


async def test_delete_repo(tmp_db):
    await db.init_db()
    await db.upsert_repo("owner/repo")
    await db.delete_repo("owner/repo")
    assert await db.list_repos() == []


async def test_log_and_list_movements(tmp_db):
    await db.init_db()
    await db.log_movement("owner/repo", 42, "triage", "todo")
    movements = await db.list_movements("owner/repo")
    assert len(movements) == 1
    assert movements[0]["issue_number"] == 42
    assert movements[0]["from_column"] == "triage"
    assert movements[0]["to_column"] == "todo"


async def test_append_and_get_run_logs(tmp_db):
    await db.init_db()
    await db.append_run_log("run-123", "owner/repo", 7, "start", {"key": "value"})
    logs = await db.get_run_logs("run-123")
    assert len(logs) == 1
    assert logs[0]["event_type"] == "start"
    assert logs[0]["data"] == {"key": "value"}


async def test_get_run_logs_handles_corrupt_json(tmp_db):
    """Corrupt JSON in the data column should not raise — returns raw string."""
    await db.init_db()
    async with aiosqlite.connect(tmp_db) as conn:
        await conn.execute(
            "INSERT INTO run_logs (run_id, repo, issue_number, event_type, data, logged_at) "
            "VALUES (?, ?, ?, ?, ?, datetime('now'))",
            ("run-bad", "owner/repo", 1, "start", "not-json"),
        )
        await conn.commit()
    logs = await db.get_run_logs("run-bad")
    assert logs[0]["data"] == "not-json"


async def test_list_repos_order(tmp_db):
    """Most recently accessed repo should appear first."""
    await db.init_db()
    await db.upsert_repo("owner/old")
    await db.upsert_repo("owner/new")
    repos = await db.list_repos()
    assert repos[0]["full_name"] == "owner/new"
