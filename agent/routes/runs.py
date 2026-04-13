import asyncio
import uuid
from typing import AsyncIterator

import db as _db
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from agent import ImplementerAgent
from models import RunEvent, RunRequest
from registry import RunState, _runs

router = APIRouter()


def _on_task_done(run_id: str, task: asyncio.Task) -> None:
    state = _runs.get(run_id)
    if state and not task.cancelled() and task.exception() is None:
        state.result = task.result()


@router.post("/runs", status_code=202)
async def create_run(request: RunRequest) -> dict:
    run_id = str(uuid.uuid4())
    agent = ImplementerAgent(run_id, request)
    task = asyncio.create_task(agent.run(), name=f"run-{run_id[:8]}")
    _runs[run_id] = RunState(run_id=run_id, agent=agent, task=task)
    task.add_done_callback(lambda t: _on_task_done(run_id, t))
    return {"run_id": run_id, "stream_url": f"/runs/{run_id}/stream"}


@router.get("/runs/{run_id}/stream")
async def stream_run(run_id: str) -> StreamingResponse:
    state = _runs.get(run_id)
    if not state:
        raise HTTPException(status_code=404, detail="Run not found")

    async def generate() -> AsyncIterator[str]:
        async for event in state.agent.events():
            yield f"data: {event.model_dump_json()}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/runs/{run_id}/status")
async def run_status(run_id: str) -> dict:
    state = _runs.get(run_id)
    if not state:
        raise HTTPException(status_code=404, detail="Run not found")
    if not state.task.done():
        return {"status": "running"}
    result = state.result
    if result is None or not result.success:
        return {"status": "failed", "error": result.error if result else "unknown"}
    return {
        "status": "complete",
        "pr_url": result.pr_url,
        "branch": result.branch_name,
        "files": result.files_changed,
    }


@router.post("/runs/{run_id}/push")
async def push_run(run_id: str) -> dict:
    """Push the committed branch and open a draft PR."""
    state = _runs.get(run_id)
    if not state:
        raise HTTPException(status_code=404, detail="Run not found")
    try:
        pr_url = await state.agent.push_and_pr()
        return {"ok": True, "pr_url": pr_url}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/runs/{run_id}")
async def cancel_run(run_id: str) -> dict:
    state = _runs.pop(run_id, None)
    if not state:
        raise HTTPException(status_code=404, detail="Run not found")
    state.task.cancel()
    return {"ok": True}


@router.get("/runs/{run_id}/logs")
async def get_run_logs(run_id: str) -> list[dict]:
    return await _db.get_run_logs(run_id)
