import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from agent import ImplementerAgent


@dataclass
class AgentResult:
    success: bool
    branch_name: Optional[str] = None
    pr_url: Optional[str] = None
    files_changed: list[str] = field(default_factory=list)
    summary: str = ""
    error: Optional[str] = None


@dataclass
class RunState:
    run_id: str
    agent: "ImplementerAgent"
    task: asyncio.Task
    result: Optional[AgentResult] = None


_runs: dict[str, RunState] = {}
