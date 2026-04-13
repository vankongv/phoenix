"""
Phoenix v5 — Notes AI chat endpoint.
Streams Claude responses about user's planning notes.
"""

import asyncio
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import AsyncIterator

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from config import ANTHROPIC_API_KEY
from models import RunEvent

router = APIRouter()


class NoteItem(BaseModel):
    id: str
    title: str
    content: str


class NotesAskRequest(BaseModel):
    question: str
    notes: list[NoteItem]
    llm_model: str | None = None
    llm_api_key: str | None = None


_NOTES_SYSTEM = (
    "You are a knowledgeable assistant helping the user think through their planning notes. "
    "The user will provide one or more notes and ask questions about them. "
    "Answer thoughtfully and concisely. Use markdown for structure when helpful. "
    "Reference specific notes by title when relevant.\n\n"
    "You also have access to an update_note tool. Use it when the user explicitly asks you to "
    "modify, add to, rewrite, or update one of their notes. "
    "When updating a note, write the complete updated content — not just the changes. "
    "Use plain text with markdown formatting (# headers, **bold**, - lists, etc.)."
)

_UPDATE_NOTE_TOOL = {
    "name": "update_note",
    "description": (
        "Update the content of one of the user's planning notes. "
        "Use this when the user asks you to modify, add to, rewrite, or update a note. "
        "Write the full updated content of the note, not just the changed parts."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "note_id": {
                "type": "string",
                "description": "The ID of the note to update (from the provided notes list)",
            },
            "new_content": {
                "type": "string",
                "description": "The complete new content for the note in plain text with markdown formatting",
            },
        },
        "required": ["note_id", "new_content"],
    },
}


async def _stream_notes_ask(req: NotesAskRequest, queue: asyncio.Queue) -> None:
    async def emit(type_: str, data: dict) -> None:
        await queue.put(RunEvent(
            type=type_,
            timestamp=datetime.now(timezone.utc).isoformat(),
            data=data,
        ))

    try:
        import anthropic as _anthropic

        api_key = req.llm_api_key or ANTHROPIC_API_KEY
        if not api_key:
            await emit("error", {"message": "No API key configured. Add your Anthropic API key in the Agents settings panel."})
            return
        model = req.llm_model or "claude-sonnet-4-6"
        client = _anthropic.AsyncAnthropic(api_key=api_key)

        # Build context from notes — include the note ID so Claude can reference it in update_note calls
        notes_context = "\n\n".join(
            f"--- Note ID: {n.id} | Title: {n.title} ---\n{n.content}" for n in req.notes
        ) or "(no notes provided)"

        user_message = (
            f"Here are my planning notes:\n\n{notes_context}\n\n"
            f"My question/request: {req.question}"
        )

        async with client.messages.stream(
            model=model,
            max_tokens=2048,
            system=_NOTES_SYSTEM,
            tools=[_UPDATE_NOTE_TOOL],
            messages=[{"role": "user", "content": user_message}],
            temperature=0.5,
        ) as stream:
            async for text in stream.text_stream:
                await emit("token", {"content": text})

            # After text streaming, check if Claude called update_note
            final = await stream.get_final_message()
            for block in final.content:
                if block.type == "tool_use" and block.name == "update_note":
                    await emit("update_note", {
                        "note_id": block.input.get("note_id", ""),
                        "content": block.input.get("new_content", ""),
                    })

        await emit("complete", {})

    except Exception as exc:
        await emit("error", {"message": str(exc)})
    finally:
        await emit("close", {})


class _TextExtractor(HTMLParser):
    """Strip HTML tags and collect visible text, skipping script/style/nav."""

    _SKIP_TAGS = {"script", "style", "nav", "footer", "header", "aside", "noscript"}

    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []
        self._depth = 0  # skip depth counter

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag.lower() in self._SKIP_TAGS:
            self._depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in self._SKIP_TAGS and self._depth > 0:
            self._depth -= 1

    def handle_data(self, data: str) -> None:
        if self._depth == 0:
            text = data.strip()
            if text:
                self._parts.append(text)

    def get_text(self) -> str:
        return "\n".join(self._parts)


class FetchUrlRequest(BaseModel):
    url: str
    llm_api_key: str | None = None
    llm_model: str | None = None


_FETCH_SYSTEM = (
    "You are a concise research assistant. "
    "Given raw webpage content, produce a well-structured markdown summary. "
    "Include: key points, main ideas, and any actionable insights. "
    "Use ## headers, bullet points, and **bold** for key terms. "
    "Keep the summary under 500 words. "
    "At the very end, add a line: > Source: <url>"
)


@router.post("/notes/fetch-url")
async def notes_fetch_url(req: FetchUrlRequest) -> JSONResponse:
    """Fetch a URL, extract visible text, summarize with Claude, return markdown."""
    try:
        request = urllib.request.Request(
            req.url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; Phoenix/5.0; +https://github.com/phoenix)"},
        )
        with urllib.request.urlopen(request, timeout=15) as resp:
            charset = "utf-8"
            ct = resp.headers.get_content_charset()
            if ct:
                charset = ct
            raw_html = resp.read().decode(charset, errors="replace")
    except urllib.error.URLError as exc:
        return JSONResponse({"error": f"Could not fetch URL: {exc.reason}"}, status_code=400)
    except Exception as exc:
        return JSONResponse({"error": f"Fetch error: {exc}"}, status_code=400)

    # Extract <title>
    title_match = re.search(r"<title[^>]*>([^<]{1,200})</title>", raw_html, re.IGNORECASE)
    page_title = title_match.group(1).strip() if title_match else req.url

    # Extract text
    extractor = _TextExtractor()
    try:
        extractor.feed(raw_html)
    except Exception:
        pass
    page_text = extractor.get_text()[:10_000]  # cap to ~10k chars

    try:
        import anthropic as _anthropic

        api_key = req.llm_api_key or ANTHROPIC_API_KEY
        if not api_key:
            return JSONResponse(
                {"error": "No API key configured. Add your Anthropic API key in the Agents settings panel."},
                status_code=400,
            )
        model = req.llm_model or "claude-sonnet-4-6"
        client = _anthropic.AsyncAnthropic(api_key=api_key)

        message = await client.messages.create(
            model=model,
            max_tokens=1024,
            system=_FETCH_SYSTEM,
            messages=[{
                "role": "user",
                "content": (
                    f"URL: {req.url}\n"
                    f"Page title: {page_title}\n\n"
                    f"Page content:\n{page_text}\n\n"
                    "Summarise this page."
                ),
            }],
            temperature=0.3,
        )
        summary_md = message.content[0].text.strip()
        return JSONResponse({"title": page_title, "summary": summary_md, "url": req.url})

    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


class DiagramEditRequest(BaseModel):
    source: str
    instruction: str
    llm_api_key: str | None = None
    llm_model: str | None = None


_DIAGRAM_SYSTEM = (
    "You are an expert at Mermaid diagram syntax. "
    "The user will give you an existing Mermaid diagram source and an instruction to modify it. "
    "Return ONLY the updated Mermaid source — no explanation, no markdown fences, no extra text. "
    "Keep the diagram type and existing structure unless the instruction explicitly changes it. "
    "Ensure the output is valid Mermaid syntax."
)


@router.post("/diagram/edit")
async def diagram_edit(req: DiagramEditRequest) -> JSONResponse:
    try:
        import anthropic as _anthropic
        api_key = req.llm_api_key or ANTHROPIC_API_KEY
        if not api_key:
            return JSONResponse(
                {"error": "No API key configured. Add your Anthropic API key in the Agents settings panel."},
                status_code=400,
            )
        model   = req.llm_model or "claude-sonnet-4-6"
        client  = _anthropic.AsyncAnthropic(api_key=api_key)

        user_msg = (
            f"Current Mermaid diagram:\n```\n{req.source}\n```\n\n"
            f"Instruction: {req.instruction}"
        )

        message = await client.messages.create(
            model=model,
            max_tokens=2048,
            system=_DIAGRAM_SYSTEM,
            messages=[{"role": "user", "content": user_msg}],
            temperature=0.2,
        )

        raw = message.content[0].text.strip()
        # Strip markdown fences if model adds them despite instructions
        raw = re.sub(r"^```(?:mermaid)?\s*\n?", "", raw)
        raw = re.sub(r"\n?```\s*$", "", raw)

        return JSONResponse({"source": raw.strip()})

    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


@router.post("/notes/ask")
async def notes_ask(req: NotesAskRequest) -> StreamingResponse:
    queue: asyncio.Queue = asyncio.Queue()
    asyncio.create_task(_stream_notes_ask(req, queue))

    async def generate() -> AsyncIterator[str]:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=60.0)
                yield f"data: {event.model_dump_json()}\n\n"
                if event.type in ("complete", "error", "close"):
                    break
            except asyncio.TimeoutError:
                yield f"data: {RunEvent(type='ping', timestamp=datetime.now(timezone.utc).isoformat(), data={}).model_dump_json()}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
