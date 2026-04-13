from typing import Optional

import db as _db
from fastapi import APIRouter, Query
from models import MovementBody

router = APIRouter()


@router.post("/movements", status_code=204)
async def record_movement(body: MovementBody) -> None:
    await _db.log_movement(body.repo, body.issue_number, body.from_column, body.to_column)


@router.get("/movements")
async def get_movements(
    repo: Optional[str] = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[dict]:
    return await _db.list_movements(repo, limit)
