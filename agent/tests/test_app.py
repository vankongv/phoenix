"""Smoke tests for the FastAPI app — health endpoint and basic routing."""

import os
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

# Provide required env vars before importing the app
os.environ.setdefault("GITHUB_TOKEN", "test-token")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

import db
from app import app


@pytest.fixture(autouse=True)
def patch_db(tmp_path, monkeypatch):
    """Use a temp DB for every test so tests are fully isolated."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")


@pytest_asyncio.fixture
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac


async def test_health(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert "version" in data
    assert "active_runs" in data


async def test_repos_empty(client):
    resp = await client.get("/repos")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_repos_post_and_get(client):
    resp = await client.post("/repos", json={"full_name": "owner/repo"})
    assert resp.status_code == 200

    resp = await client.get("/repos")
    assert any(r["full_name"] == "owner/repo" for r in resp.json())


async def test_repos_delete(client):
    await client.post("/repos", json={"full_name": "owner/repo"})
    resp = await client.delete("/repos/owner/repo")
    assert resp.status_code == 200

    resp = await client.get("/repos")
    assert not any(r["full_name"] == "owner/repo" for r in resp.json())


async def test_movements_empty(client):
    resp = await client.get("/movements")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_movements_log(client):
    resp = await client.post("/movements", json={
        "repo": "owner/repo",
        "issue_number": 10,
        "from_column": "triage",
        "to_column": "todo",
    })
    assert resp.status_code == 200

    resp = await client.get("/movements?repo=owner/repo")
    data = resp.json()
    assert len(data) == 1
    assert data[0]["issue_number"] == 10
