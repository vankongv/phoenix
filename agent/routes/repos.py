import db as _db
from fastapi import APIRouter, Query
from models import RepoBody

router = APIRouter()


@router.get("/repos")
async def get_repos(limit: int = Query(default=50, ge=1, le=200)) -> list[dict]:
    return await _db.list_repos(limit)


@router.post("/repos", status_code=204)
async def save_repo(body: RepoBody) -> None:
    await _db.upsert_repo(body.full_name)


@router.delete("/repos/{full_name:path}", status_code=204)
async def remove_repo(full_name: str) -> None:
    await _db.delete_repo(full_name)
