import asyncio
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from config import ANTHROPIC_API_KEY
from models import RefineRequest, RunEvent

router = APIRouter()

_refine_queues: dict[str, asyncio.Queue] = {}


async def _emit_refine(queue: asyncio.Queue, type_: str, data: dict) -> None:
    await queue.put(RunEvent(
        type=type_,
        timestamp=datetime.now(timezone.utc).isoformat(),
        data=data,
    ))


_REFINE_SAMPLING_TEMP: dict[str, float] = {
    "deterministic": 0.0,
    "balanced":      0.5,
    "creative":      1.0,
}

_REFINE_SYSTEM_BASE = (
    "You are a Senior Product Manager. Refine the GitHub issue into a clear, "
    "structured specification. Call the submit_spec tool exactly once with: "
    "title (str), description (str, 2-4 sentences), acceptance_criteria (list of "
    "binary pass/fail strings). Also set overall_completeness 0.0–1.0: "
    "1.0 = all details stated explicitly, 0.5 = inferred from context, "
    "0.1 = largely guessed with no basis in the issue."
)

_SUBMIT_SPEC_TOOL = {
    "name": "submit_spec",
    "description": "Submit the refined issue spec. Call this exactly once.",
    "input_schema": {
        "type": "object",
        "properties": {
            "title":                {"type": "string"},
            "description":          {"type": "string"},
            "acceptance_criteria":  {"type": "array", "items": {"type": "string"}},
            "overall_completeness": {"type": "number", "minimum": 0, "maximum": 1},
        },
        "required": ["title", "description", "acceptance_criteria"],
    },
}


async def _run_refine(run_id: str, req: RefineRequest, queue: asyncio.Queue) -> None:
    try:
        import anthropic as _anthropic  # lazy import — only needed for refine

        api_key  = req.llm_api_key or ANTHROPIC_API_KEY
        if not api_key:
            await queue.put({"type": "error", "message": "No API key configured. Add one in Settings → AI."})
            return
        model    = req.llm_model or "claude-opus-4-6"
        base_url = req.llm_base_url or None
        client   = _anthropic.AsyncAnthropic(
            api_key=api_key,
            **({"base_url": base_url} if base_url else {}),
        )

        # Prepend custom system prompt if provided, then base instructions
        system = _REFINE_SYSTEM_BASE
        if req.system_prompt:
            system = f"{req.system_prompt.strip()}\n\n{system}"

        user = f"Issue title: {req.title}\n\nIssue body:\n{req.body or '(no body provided)'}"

        extra: dict = {}
        if req.sampling and req.sampling in _REFINE_SAMPLING_TEMP:
            extra["temperature"] = _REFINE_SAMPLING_TEMP[req.sampling]

        response = await client.messages.create(
            model=model,
            max_tokens=1024,
            system=system,
            messages=[{"role": "user", "content": user}],
            tools=[_SUBMIT_SPEC_TOOL],
            tool_choice={"type": "tool", "name": "submit_spec"},
            **extra,
        )
        tool_block = next(b for b in response.content if b.type == "tool_use")
        suggestion = tool_block.input  # schema-validated dict — no regex needed

        await _emit_refine(queue, "reasoning", {
            "content": f"Spec refined ({response.usage.input_tokens} in / {response.usage.output_tokens} out tokens)",
        })
        await _emit_refine(queue, "suggestion", suggestion)
        await _emit_refine(queue, "complete", {})

    except Exception as exc:
        await _emit_refine(queue, "error", {"message": str(exc)})
    finally:
        await _emit_refine(queue, "close", {})


@router.post("/refine", status_code=202)
async def refine_issue(request: RefineRequest) -> dict:
    import uuid
    run_id = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue()
    _refine_queues[run_id] = queue
    asyncio.create_task(_run_refine(run_id, request, queue))
    return {"run_id": run_id, "stream_url": f"/refine/{run_id}/stream"}


@router.get("/refine/{run_id}/stream")
async def stream_refine(run_id: str) -> StreamingResponse:
    queue = _refine_queues.get(run_id)
    if not queue:
        raise HTTPException(status_code=404, detail="Refine run not found")

    async def generate() -> AsyncIterator[str]:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=30.0)
                yield f"data: {event.model_dump_json()}\n\n"
                if event.type in ("complete", "error", "close"):
                    _refine_queues.pop(run_id, None)
                    break
            except asyncio.TimeoutError:
                yield f"data: {RunEvent(type='ping', timestamp=datetime.now(timezone.utc).isoformat(), data={}).model_dump_json()}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
