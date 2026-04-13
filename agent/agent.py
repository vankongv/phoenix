import asyncio
import json
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator, Optional

from github import Github
import db as _db
from openhands.sdk import LLM, Agent, Conversation, Tool
from openhands.sdk.event import (
    ACPToolCallEvent,
    AgentErrorEvent,
    MessageEvent,
    ObservationEvent,
)
try:
    from openhands.sdk.event.conversation_error import ConversationErrorEvent as _ConversationErrorEvent
except ImportError:
    try:
        from openhands.sdk.event import ConversationErrorEvent as _ConversationErrorEvent
    except ImportError:
        _ConversationErrorEvent = None
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.terminal import TerminalTool

from config import ANTHROPIC_API_KEY, BASE_REPOS_DIR, GITHUB_TOKEN, LLM_MODEL, _repo_locks

_SAMPLING_TEMP: dict[str, float] = {
    "deterministic": 0.0,
    "balanced":      0.5,
    "creative":      1.0,
}

# Per-issue lock: serialises the branch rename in _commit_local so concurrent
# runs for the same issue number don't race on the target branch name.
_commit_locks: dict[str, asyncio.Lock] = {}
from models import RunEvent, RunRequest
from registry import AgentResult, _runs


class ImplementerAgent:
    def __init__(self, run_id: str, request: RunRequest) -> None:
        self.run_id = run_id
        self.request = request
        self.work_dir: Optional[Path] = None       # the worktree path
        self._base_dir: Optional[Path] = None      # the shared base clone
        self._worktree_branch: Optional[str] = None  # branch name inside base repo
        self._queue: asyncio.Queue[RunEvent] = asyncio.Queue()
        self._gh = Github(GITHUB_TOKEN)
        self._repo = None   # resolved lazily in run()
        self._issue = None  # resolved lazily in run()
        self._conversation: Optional[Conversation] = None
        self._file_tree: str = ""
        self._file_snippets: str = ""
        self._tool_calls: int = 0

    # ── OpenWolf-style file intelligence ─────────────────────────────────────

    def _extract_keywords(self) -> set[str]:
        """Tokenise the issue spec into searchable path keywords."""
        spec = self.request.spec
        text = f"{spec.intent} {' '.join(spec.acceptance_criteria)} {spec.technical_notes or ''}"
        # Include path stems and directory names from context_files hints
        for cf in spec.context_files:
            text += " " + " ".join(Path(cf).parts)
        words = re.findall(r'[a-zA-Z][a-zA-Z0-9_-]{2,}', text)
        _STOP = {
            'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will',
            'should', 'when', 'then', 'add', 'new', 'can', 'use', 'make', 'get',
            'set', 'all', 'not', 'but', 'are', 'was', 'been', 'has', 'had', 'its',
            'also', 'into', 'each', 'would', 'could', 'which', 'there', 'their',
            'what', 'where', 'more', 'other', 'than', 'just', 'now', 'any', 'per',
            'feat', 'fix', 'bug', 'implement', 'create', 'update', 'change', 'edit',
            'show', 'display', 'currently', 'issue', 'need', 'want', 'like', 'work',
        }
        return {w.lower() for w in words if w.lower() not in _STOP and len(w) >= 3}

    def _score_file(self, rel: str, keywords: set[str]) -> int:
        """Score a file path for relevance to the issue. Higher = load first."""
        rel_lower = rel.lower()
        score = 0
        for kw in keywords:
            if kw in rel_lower:
                score += 8
        ext = Path(rel).suffix.lower()
        if ext in {'.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.php'}:
            score += 4
        elif ext in {'.css', '.scss', '.html', '.astro', '.vue', '.svelte', '.mdx'}:
            score += 3
        elif ext in {'.json', '.yaml', '.yml', '.toml', '.env', '.sh'}:
            score += 2
        # Prefer shallower paths (more likely to be config / entry points)
        depth = rel.count('/')
        score += max(0, 3 - depth)
        return score

    # ── Event emission ────────────────────────────────────────────────────────

    async def emit(self, type_: str, data: dict) -> None:
        await self._queue.put(RunEvent(
            type=type_,
            timestamp=datetime.now(timezone.utc).isoformat(),
            data=data,
        ))
        # Persist to SQLite (fire-and-forget; never block the SSE stream)
        try:
            asyncio.create_task(_db.append_run_log(
                self.run_id,
                self.request.repo_full_name,
                self.request.issue_number,
                type_,
                data,
            ))
        except RuntimeError:
            # Event loop may be closing during shutdown — safe to ignore
            pass

    async def events(self) -> AsyncIterator[RunEvent]:
        """Yield events; send a keepalive ping when idle for 15 s."""
        while True:
            try:
                event = await asyncio.wait_for(self._queue.get(), timeout=15.0)
                yield event
                if event.type in ("complete", "error", "close"):
                    break
            except asyncio.TimeoutError:
                yield RunEvent(
                    type="ping",
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    data={},
                )

    # ── Main pipeline ─────────────────────────────────────────────────────────

    async def run(self) -> AgentResult:
        try:
            # Resolve GitHub objects lazily so the /runs route never throws
            self._repo  = self._gh.get_repo(self.request.repo_full_name)
            self._issue = self._repo.get_issue(self.request.issue_number)
            await self.emit("start", {
                "issue_number": self.request.issue_number,
                "repo": self.request.repo_full_name,
                "title": self._issue.title,
            })
            await self._setup_worktree()
            result = await self._run_agent()
            if not result.success:
                await self.emit("error", {"message": result.error or "Agent run failed"})
                asyncio.create_task(self._cleanup_worktree())
                return result
            await self._commit_local(result)
            if self.request.autonomy == "autonomous":
                # Push the branch (fast: local → remote, no API wait).
                await self._push_branch(result)
                # PR creation is slow (GitHub API). Fire it in the background so
                # the SSE stream closes immediately — the frontend polls for pr_url.
                asyncio.create_task(self._create_pr_background(result))
                await self.emit("complete", {
                    "branch": result.branch_name,
                    "pr_pending": True,
                })
            else:
                # assist / semi-autonomous: hand off to the user for review before pushing.
                await self.emit("needs_review", {
                    "branch": result.branch_name,
                    "worktree_path": str(self.work_dir),
                    "files": result.files_changed,
                    "summary": result.summary,
                    "run_id": self.run_id,
                })
            return result
        except Exception as exc:
            await self.emit("error", {"message": str(exc)})
            # Clean up the worktree on any failure path so stale branches and
            # worktree directories don't accumulate across retries.
            asyncio.create_task(self._cleanup_worktree())
            return AgentResult(success=False, error=str(exc))
        finally:
            await self.emit("close", {})

    # ── Worktree setup ────────────────────────────────────────────────────────

    async def _setup_worktree(self) -> None:
        """Ensure a base clone exists for this repo, then add a git worktree.

        First call per repo: full shallow clone (~seconds, not minutes).
        Subsequent calls: git fetch --depth 1 + git worktree add (<1 s for
        large repos because the object DB is already on disk).
        """
        repo_key = self.request.repo_full_name.replace("/", "-")
        base_dir = BASE_REPOS_DIR / repo_key
        clone_url = self._repo.clone_url.replace(
            "https://", f"https://x-access-token:{GITHUB_TOKEN}@"
        )

        if repo_key not in _repo_locks:
            _repo_locks[repo_key] = asyncio.Lock()
        lock = _repo_locks[repo_key]

        async with lock:
            if not base_dir.exists():
                await self.emit("progress", {
                    "step": "clone",
                    "message": "First run — cloning base repository…",
                })
                BASE_REPOS_DIR.mkdir(parents=True, exist_ok=True)
                proc = await asyncio.create_subprocess_exec(
                    "git", "clone", "--depth", "1", "-b", self.request.base_branch,
                    clone_url, str(base_dir),
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )
                _, stderr = await proc.communicate()
                if proc.returncode != 0:
                    raise RuntimeError(f"git clone failed: {stderr.decode().strip()}")
            else:
                await self.emit("progress", {
                    "step": "fetch",
                    "message": "Fetching latest changes…",
                })
                # Refresh the PAT in the remote URL (token may have rotated).
                proc = await asyncio.create_subprocess_exec(
                    "git", "remote", "set-url", "origin", clone_url,
                    cwd=base_dir,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )
                await proc.communicate()

                proc = await asyncio.create_subprocess_exec(
                    "git", "fetch", "--depth", "1", "origin", self.request.base_branch,
                    cwd=base_dir,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )
                _, stderr = await proc.communicate()
                if proc.returncode != 0:
                    raise RuntimeError(f"git fetch failed: {stderr.decode().strip()}")

                proc = await asyncio.create_subprocess_exec(
                    "git", "reset", "--hard", f"origin/{self.request.base_branch}",
                    cwd=base_dir,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )
                await proc.communicate()

            # Create an isolated worktree on a new branch.
            # The worktree directory must not exist yet — git creates it.
            worktree_branch = f"pnx/{self.run_id[:8]}"
            worktree_path = Path(tempfile.gettempdir()) / f"pnx-{self.run_id[:8]}"
            proc = await asyncio.create_subprocess_exec(
                "git", "worktree", "add", "-b", worktree_branch,
                str(worktree_path), f"origin/{self.request.base_branch}",
                cwd=base_dir,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError(f"git worktree add failed: {stderr.decode().strip()}")

        self.work_dir = worktree_path
        self._base_dir = base_dir
        self._worktree_branch = worktree_branch

        # Pre-build a file tree so the agent can skip manual exploration.
        try:
            proc = await asyncio.create_subprocess_exec(
                "find", ".", "-type", "f",
                "-not", "-path", "./.git/*",
                "-not", "-path", "./node_modules/*",
                "-not", "-path", "./__pycache__/*",
                "-not", "-path", "./.venv/*",
                cwd=str(worktree_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await proc.communicate()
            lines = stdout.decode().splitlines()
            # Cap at 200 lines to keep the prompt from ballooning
            self._file_tree = "\n".join(sorted(lines)[:200])

            # Pre-read small source files ranked by relevance to the issue
            # (OpenWolf approach: score by keyword match + file type + depth).
            # Only read text files under 8 KB; skip binaries, lockfiles, build artefacts.
            _SKIP_EXTS = {'.lock', '.sum', '.mod', '.min.js', '.min.css', '.map',
                          '.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2',
                          '.ttf', '.eot', '.gif', '.webp', '.pdf', '.zip', '.tar'}
            _SKIP_DIRS = {'node_modules', '.git', '__pycache__', '.venv', 'dist',
                          'build', '.next', '.astro', 'coverage'}
            _MAX_FILE_BYTES = 8_000
            _MAX_TOTAL_BYTES = 60_000

            keywords = self._extract_keywords()
            context_set = set(self.request.spec.context_files)

            # Score every candidate file
            candidates: list[tuple[int, int, str, Path]] = []
            for rel in lines:
                rel = rel.lstrip('./')
                if not rel:
                    continue
                parts_list = rel.split('/')
                if any(p in _SKIP_DIRS for p in parts_list):
                    continue
                ext = Path(rel).suffix.lower()
                if ext in _SKIP_EXTS:
                    continue
                full = worktree_path / rel
                try:
                    size = full.stat().st_size
                    if size > _MAX_FILE_BYTES or size == 0:
                        continue
                    score = self._score_file(rel, keywords)
                    # Context files explicitly named in the spec get top priority
                    if any(rel == cf or rel.endswith(cf) for cf in context_set):
                        score += 50
                    candidates.append((score, size, rel, full))
                except OSError:
                    continue

            # Highest relevance first; tie-break on size (smaller = cheaper)
            candidates.sort(key=lambda x: (-x[0], x[1]))

            snippets: list[str] = []
            total = 0
            for score, size, rel, full in candidates:
                try:
                    text = full.read_text(encoding='utf-8', errors='ignore')
                    snippet = f"### {rel}\n```\n{text.rstrip()}\n```"
                    total += len(snippet)
                    if total > _MAX_TOTAL_BYTES:
                        break
                    snippets.append(snippet)
                except OSError:
                    continue

            self._file_snippets = "\n\n".join(snippets) if snippets else ""
        except Exception:
            # File tree extraction is best-effort — failures must not crash the run
            self._file_tree = ""
            self._file_snippets = ""

        await self.emit("progress", {
            "step": "worktree_ready",
            "message": f"Workspace ready ({worktree_path.name})",
            "worktree_path": str(worktree_path),
        })

    async def _cleanup_worktree(self) -> None:
        if self.work_dir is None:
            return
        if self._base_dir and self._base_dir.exists():
            proc = await asyncio.create_subprocess_exec(
                "git", "worktree", "remove", "--force", str(self.work_dir),
                cwd=self._base_dir,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.communicate()
            if self._worktree_branch:
                proc = await asyncio.create_subprocess_exec(
                    "git", "branch", "-D", self._worktree_branch,
                    cwd=self._base_dir,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )
                await proc.communicate()
        elif self.work_dir.exists():
            # Fallback if the base clone was deleted under us.
            await asyncio.to_thread(shutil.rmtree, self.work_dir, ignore_errors=True)

    # ── OpenHands ─────────────────────────────────────────────────────────────

    async def _run_agent(self) -> AgentResult:
        mcp_count = len(self.request.mcp_servers)
        mcp_note = f" with {mcp_count} MCP server(s)" if mcp_count else ""
        await self.emit("progress", {"step": "agent_start", "message": f"Starting OpenHands agent{mcp_note}…"})

        loop = asyncio.get_running_loop()

        # Callback fires on the executor thread — schedule emission on the event loop
        def _on_event(event) -> None:
            asyncio.run_coroutine_threadsafe(self._relay(event), loop)

        model       = self.request.llm_model   or LLM_MODEL
        # Pass None instead of "" so litellm falls back to env vars when no key supplied
        api_key     = self.request.llm_api_key or ANTHROPIC_API_KEY or None
        base_url    = self.request.llm_base_url or None
        temperature = _SAMPLING_TEMP.get(self.request.sampling or "", None)
        llm = LLM(
            model=model,
            api_key=api_key,
            # Disable extended thinking: with stream=False (the SDK default) the API
            # must generate ALL thinking tokens before sending any response, which
            # easily exceeds the 5-min timeout and causes silent 33-minute retry loops.
            extended_thinking_budget=0,
            reasoning_effort=None,
            enable_encrypted_reasoning=False,
            **({"base_url":    base_url}    if base_url    is not None else {}),
            **({"temperature": temperature} if temperature is not None else {}),
        )
        agent = Agent(
            llm=llm,
            tools=[Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)],
        )
        max_iterations = self.request.max_iterations or 50
        self._conversation = Conversation(
            agent=agent,
            workspace=str(self.work_dir),
            callbacks=[_on_event],
            visualizer=None,  # no rich console output in server context
            max_iteration_per_run=max_iterations,
        )

        prompt = self._build_prompt()

        def _run_sync() -> None:
            # send_message triggers tool initialisation (PTY start, ~1 s sleep).
            # Running it in the executor keeps the asyncio event loop free so SSE
            # events keep flowing while the agent boots up.
            self._conversation.send_message(prompt)
            self._conversation.run()

        # Emit a heartbeat every 5 s so the frontend sees progress during long LLM calls
        async def _heartbeat(executor_future: "asyncio.Future") -> None:
            step = 0
            dots = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
            while not executor_future.done():
                await asyncio.sleep(5)
                if executor_future.done():
                    break
                step += 1
                spinner = dots[step % len(dots)]
                elapsed = step * 5
                tool_label = f" · {self._tool_calls} tool calls" if self._tool_calls > 0 else ""
                await self.emit("progress", {
                    "step": "thinking",
                    "message": f"{spinner} Agent thinking… ({elapsed}s{tool_label})",
                })

        try:
            # Both send_message + run are synchronous — execute together in thread pool
            future = loop.run_in_executor(None, _run_sync)
            heartbeat_task = asyncio.create_task(_heartbeat(future))
            try:
                await future
            finally:
                heartbeat_task.cancel()
        except Exception as exc:
            return AgentResult(success=False, error=str(exc))

        return self._parse_conversation()

    async def _relay(self, event) -> None:
        """Forward SDK events to our SSE queue."""
        if isinstance(event, MessageEvent) and getattr(event, "source", None) == "agent":
            # Prefer extended-thinking reasoning content; fall back to plain text
            reasoning = getattr(event, "reasoning_content", None) or ""
            if not reasoning:
                try:
                    reasoning = " ".join(
                        c.text for c in event.llm_message.content
                        if hasattr(c, "text") and c.text
                    )
                except (AttributeError, TypeError):
                    reasoning = ""
            if reasoning:
                await self.emit("reasoning", {"content": str(reasoning)[:2000]})
        elif isinstance(event, ACPToolCallEvent):
            # tool_kind holds the slug ("terminal", "file_editor"); title is human-readable
            self._tool_calls += 1
            tool = event.tool_kind or event.title or "unknown"
            path = ""
            raw = event.raw_input
            if isinstance(raw, dict):
                path = raw.get("path", raw.get("command", ""))
            elif isinstance(raw, str):
                path = raw[:100]
            await self.emit("tool_call", {"tool": tool, "path": str(path)[:100]})
        elif isinstance(event, ObservationEvent):
            tool_name = getattr(event, "tool_name", None) or ""
            # observation.text joins all TextContent items — clean plain text, no repr
            try:
                output = event.observation.text
            except AttributeError:
                output = ""
            await self.emit("tool_result", {
                "tool": str(tool_name),
                "output": output[:600],
            })
        elif isinstance(event, AgentErrorEvent):
            await self.emit("error", {"message": str(event.error)})
        elif _ConversationErrorEvent and isinstance(event, _ConversationErrorEvent):
            code = getattr(event, "code", "")
            detail = getattr(event, "detail", None) or getattr(event, "message", None) or str(event)
            msg = f"{code}: {detail}" if code else str(detail)
            await self.emit("error", {"message": str(msg)})

    def _build_prompt(self) -> str:
        req  = self.request
        spec = req.spec
        criteria = "\n".join(f"- {c}" for c in spec.acceptance_criteria)
        tech = f"\nTechnical notes: {spec.technical_notes}" if spec.technical_notes else ""
        ctx  = f"\nKey files to read first: {', '.join(spec.context_files)}" if spec.context_files else ""
        slug = re.sub(r"[^a-z0-9]+", "-", spec.intent.lower())[:40].strip("-")

        parts: list[str] = []

        # Agent identity block (from agent config)
        if req.system_prompt or req.purpose or req.reasoning_pattern:
            parts.append("── AGENT CONFIGURATION ──")
            if req.purpose:
                parts.append(f"Role: {req.purpose}")
            if req.reasoning_pattern:
                parts.append(f"Reasoning pattern: {req.reasoning_pattern}")
            if req.system_prompt:
                parts.append(req.system_prompt.strip())
            parts.append("")

        # Guardrails — base rules always apply; merge with caller-provided values
        parts.append("── GUARDRAILS ──")
        always = "Read a file before editing it (unless already in pre-loaded snippets)."
        if req.guardrails_always:
            always = f"{always} {req.guardrails_always.strip()}"
        never = "Modify files outside the working directory. Skip the VERIFY step."
        if req.guardrails_never:
            never = f"{never} {req.guardrails_never.strip()}"
        parts.append(f"ALWAYS: {always}")
        parts.append(f"NEVER:  {never}")
        parts.append("")

        # Task
        tree_section = (
            f"\nREPOSITORY FILE TREE (pre-fetched — use this to navigate, skip manual exploration):\n"
            f"```\n{self._file_tree}\n```\n"
            if self._file_tree else ""
        )
        snippets_section = (
            f"\nPRE-LOADED FILE CONTENTS (small files already read — do NOT cat these again):\n\n"
            f"{self._file_snippets}\n"
            if self._file_snippets else ""
        )

        parts.append(
            f"Implement the following feature. Be thorough and precise.\n\n"
            f"INTENT: {spec.intent}\n\n"
            f"ACCEPTANCE CRITERIA:\n{criteria}{tech}{ctx}{tree_section}{snippets_section}\n\n"
            f"REASONING PROTOCOL — complete each step before moving to the next:\n\n"
            f"STEP 1 · OBSERVE\n"
            f"Using the file tree and pre-loaded snippets, list every file relevant to the\n"
            f"acceptance criteria. Do not read or edit anything yet.\n\n"
            f"STEP 2 · ANALYZE\n"
            f"For each identified file, note the pattern or interface your implementation\n"
            f"must follow (naming conventions, export style, existing abstractions).\n\n"
            f"STEP 3 · PLAN\n"
            f"Write a concrete implementation plan: which files change, what each change\n"
            f"does, and which acceptance criterion each change satisfies. This must appear\n"
            f"in your output before any edit.\n\n"
            f"STEP 4 · IMPLEMENT\n"
            f"Execute the plan. Read any file not already pre-loaded before editing it.\n"
            f"Write clean, idiomatic code that matches the existing style.\n\n"
            f"STEP 5 · VERIFY\n"
            f"Re-read each modified file. Check it against each acceptance criterion.\n"
            f"Fix any gap, then output exactly one JSON block:\n\n"
            f"```json\n"
            f"{{\n"
            f'  "branch_name": "implementer/issue-{req.issue_number}-{slug}",\n'
            f'  "files_changed": ["path/to/file"],\n'
            f'  "summary": "One sentence: what was implemented and why"\n'
            f"}}\n"
            f"```\n\n"
            f"Working directory: {self.work_dir}"
        )

        return "\n".join(parts)

    def _parse_conversation(self) -> AgentResult:
        """Extract branch/files/summary from the agent's final message."""
        last_text = ""
        try:
            if self._conversation:
                # SDK v1.x: events are on conversation.state.events (EventLog)
                events = list(self._conversation.state.events)
                for event in reversed(events):
                    if (isinstance(event, MessageEvent)
                            and getattr(event, "source", "") == "agent"):
                        try:
                            text = " ".join(
                                c.text for c in event.llm_message.content
                                if hasattr(c, "text") and c.text
                            )
                            if len(text) > 10:
                                last_text = text
                                break
                        except (AttributeError, TypeError):
                            pass
        except AttributeError:
            pass

        m = re.search(r"```json\s*(\{[\s\S]*?\})\s*```", last_text)
        raw = m.group(1) if m else None
        if raw is None:
            m = re.search(r"\{[\s\S]*?\}", last_text)
            raw = m.group(0) if m else None

        if raw:
            try:
                data = json.loads(raw)
                return AgentResult(
                    success=True,
                    branch_name=data.get("branch_name", f"implementer/issue-{self.request.issue_number}"),
                    files_changed=data.get("files_changed", []),
                    summary=data.get("summary", ""),
                )
            except json.JSONDecodeError:
                pass

        return AgentResult(
            success=True,
            branch_name=f"implementer/issue-{self.request.issue_number}",
            files_changed=[],
            summary=last_text[:500],
        )

    # ── Git helpers ───────────────────────────────────────────────────────────

    async def _git(self, *args: str, cwd: Optional[Path] = None) -> tuple[int, str]:
        """Run git, return (returncode, stderr)."""
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            cwd=cwd or self.work_dir,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        return proc.returncode, stderr.decode().strip()

    async def _git_out(self, *args: str, cwd: Optional[Path] = None) -> tuple[int, str]:
        """Run git, return (returncode, stdout)."""
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            cwd=cwd or self.work_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await proc.communicate()
        return proc.returncode, stdout.decode().strip()

    async def _commit_local(self, result: AgentResult) -> None:
        """Rename branch if needed, stage, and commit any remaining changes."""
        await self.emit("progress", {"step": "commit", "message": "Committing changes…"})

        rc, current_branch = await self._git_out("branch", "--show-current")
        if rc != 0 or not current_branch:
            current_branch = self._worktree_branch

        if current_branch == self._worktree_branch and result.branch_name != self._worktree_branch:
            # Serialise the rename per issue so concurrent retries don't race on
            # the same target branch name.
            issue_key = f"{self.request.repo_full_name}:{self.request.issue_number}"
            if issue_key not in _commit_locks:
                _commit_locks[issue_key] = asyncio.Lock()
            async with _commit_locks[issue_key]:
                # Prune stale worktree references first so orphaned branches (from
                # crashed previous runs) can be deleted — git refuses to delete a
                # branch that is "checked out" in a worktree that no longer exists.
                await self._git("worktree", "prune", cwd=self._base_dir)
                # If result.branch_name is still live in another worktree (directory
                # on disk, so prune left it), force-remove that worktree before
                # deleting the branch.  Scan the list rather than parsing error-
                # message text, which differs across git versions.
                rc_wl, wt_out = await self._git_out(
                    "worktree", "list", "--porcelain", cwd=self._base_dir
                )
                if rc_wl == 0:
                    wt_path: Optional[str] = None
                    for line in wt_out.splitlines():
                        if line.startswith("worktree "):
                            wt_path = line[len("worktree "):].strip()
                        elif line.startswith("branch ") and result.branch_name in line:
                            if wt_path and wt_path != str(self._base_dir):
                                await self._git(
                                    "worktree", "remove", "--force", wt_path, cwd=self._base_dir
                                )
                            wt_path = None
                # Delete the stale target branch (ignore failure when absent).
                await self._git("branch", "-D", result.branch_name, cwd=self._base_dir)
                target = result.branch_name
                code, err = await self._git("branch", "-m", self._worktree_branch, target)
                if code != 0:
                    if "already exists" in err:
                        # Cleanup wasn't enough — fall back to a suffixed name.
                        counter = 2
                        while counter <= 99:
                            candidate = f"{result.branch_name}-{counter}"
                            code, err = await self._git("branch", "-m", self._worktree_branch, candidate)
                            if code == 0:
                                target = candidate
                                break
                            counter += 1
                        else:
                            raise RuntimeError(f"git branch -m: {err}")
                    else:
                        raise RuntimeError(f"git branch -m: {err}")
                current_branch = target

        self._worktree_branch = current_branch
        result.branch_name = current_branch

        await self._git("add", "-A")
        # rc=1 means nothing to commit — agent may have committed already, that's fine
        await self._git("commit", "-m",
            f"feat: implement #{self.request.issue_number}\n\n{result.summary}")

    async def _push_branch(self, result: AgentResult) -> None:
        """Push branch to remote origin (fast — no GitHub API)."""
        await self.emit("progress", {"step": "push", "message": "Pushing branch…"})
        code, err = await self._git("push", "-u", "origin", result.branch_name)
        if code != 0:
            raise RuntimeError(f"git push: {err}")

    def _pr_body(self, result: AgentResult) -> tuple[str, str]:
        """Return (title, body) for the GitHub PR."""
        files_list = "\n".join(f"- `{f}`" for f in result.files_changed) or "_No tracked files_"
        title = f"feat: implement #{self.request.issue_number}: {self._issue.title}"
        body = (
            f"Fixes #{self.request.issue_number}\n\n"
            f"## Summary\n{result.summary}\n\n"
            f"## Files changed\n{files_list}\n\n"
            f"---\n_Implemented by Phoenix_"
        )
        return title, body

    async def _create_pr_background(self, result: AgentResult) -> None:
        """Create PR after SSE stream closes. Updates result.pr_url in place.
        The status endpoint returns result.pr_url, so the frontend poll will
        pick it up as soon as this task completes."""
        try:
            title, body = self._pr_body(result)
            pr = await asyncio.to_thread(
                self._repo.create_pull,
                title=title,
                body=body,
                head=result.branch_name,
                base=self.request.base_branch,
                draft=self.request.create_draft_pr,
            )
            result.pr_url = pr.html_url
            # Persist to DB so logs show pr_ready even after server restart
            await _db.append_run_log(
                self.run_id, self.request.repo_full_name,
                self.request.issue_number, "pr_ready", {"pr_url": pr.html_url},
            )
        except Exception as exc:
            await _db.append_run_log(
                self.run_id, self.request.repo_full_name,
                self.request.issue_number, "error",
                {"message": f"PR creation failed: {exc}"},
            )
        finally:
            await self._cleanup_worktree()

    async def _do_push_and_pr(self, result: AgentResult) -> str:
        """Push + open PR synchronously. Used by the /push endpoint (semi-autonomous)."""
        await self._push_branch(result)
        await self.emit("progress", {"step": "pr", "message": "Opening pull request…"})
        title, body = self._pr_body(result)
        try:
            pr = await asyncio.to_thread(
                self._repo.create_pull,
                title=title,
                body=body,
                head=result.branch_name,
                base=self.request.base_branch,
                draft=self.request.create_draft_pr,
            )
        finally:
            await self._cleanup_worktree()
        return pr.html_url

    async def push_and_pr(self) -> str:
        """Push the committed branch and open a PR. Called by the /push endpoint."""
        result = _runs[self.run_id].result
        if not result:
            raise RuntimeError("No result available to push")
        pr_url = await self._do_push_and_pr(result)
        result.pr_url = pr_url
        return pr_url
