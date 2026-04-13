"""
Phoenix v5 — centralised configuration

All settings are read from environment variables (and optionally a .env file
in the agent/ directory). Missing required variables raise a clear error at
startup rather than failing silently later.
"""

import asyncio
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class _Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",  # silently ignore unknown env vars
    )

    github_token: str = Field("", description="GitHub PAT with repo scope (optional — can be set in the UI Settings → GitHub)")
    anthropic_api_key: str = Field("", description="Anthropic API key (optional if set per-agent in the UI)")
    llm_model: str = Field(
        "anthropic/claude-sonnet-4-6",
        description="Default LiteLLM model string",
    )
    cors_origins: str = Field(
        "",
        description="Comma-separated allowed CORS origins. Empty = all localhost ports in dev.",
    )
    pnx_repos_dir: Path = Field(
        default_factory=lambda: Path.home() / ".pnx" / "repos",
        description="Directory where base git clones are stored",
    )


# Validate and load at import time — bad config fails loudly at startup.
_settings = _Settings()

# Re-export as module-level names so existing imports don't change.
GITHUB_TOKEN: str = _settings.github_token
ANTHROPIC_API_KEY: str = _settings.anthropic_api_key
LLM_MODEL: str = _settings.llm_model
CORS_ORIGINS: str = _settings.cors_origins
BASE_REPOS_DIR: Path = _settings.pnx_repos_dir

# Per-repo lock: serialises fetch + worktree-add so concurrent runs for the
# same repo don't race on the shared base clone.
_repo_locks: dict[str, asyncio.Lock] = {}
