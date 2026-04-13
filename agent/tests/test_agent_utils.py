"""Tests for ImplementerAgent utility methods (no I/O, no LLM)."""

import os
import pytest

os.environ.setdefault("GITHUB_TOKEN", "test-token")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

from models import IssueSpec, RunRequest
from agent import ImplementerAgent


def _make_agent(intent="Add a feature", criteria=None, context_files=None):
    spec = IssueSpec(
        intent=intent,
        acceptance_criteria=criteria or ["Feature works"],
        context_files=context_files or [],
    )
    req = RunRequest(
        issue_number=1,
        repo_full_name="owner/repo",
        spec=spec,
    )
    return ImplementerAgent(run_id="test-run-id", request=req)


def test_extract_keywords_basic():
    agent = _make_agent(intent="Add dark mode toggle to settings page")
    kws = agent._extract_keywords()
    assert "dark" in kws
    assert "mode" in kws
    assert "settings" in kws
    # Stop words should be filtered
    assert "add" not in kws
    assert "the" not in kws


def test_extract_keywords_includes_context_file_parts():
    agent = _make_agent(context_files=["src/components/Header.astro"])
    kws = agent._extract_keywords()
    assert "components" in kws or "header" in kws


def test_score_file_keyword_match():
    agent = _make_agent(intent="Fix the authentication middleware bug")
    kws = agent._extract_keywords()
    score_match = agent._score_file("src/middleware/auth.py", kws)
    score_no_match = agent._score_file("src/styles/global.css", kws)
    assert score_match > score_no_match


def test_score_file_source_preferred_over_config():
    agent = _make_agent()
    kws = set()
    score_ts = agent._score_file("src/index.ts", kws)
    score_yaml = agent._score_file("config/settings.yaml", kws)
    # .ts gets +4, .yaml gets +2
    assert score_ts > score_yaml


def test_score_file_shallow_preferred():
    agent = _make_agent()
    kws = set()
    score_shallow = agent._score_file("index.py", kws)
    score_deep = agent._score_file("a/b/c/d/index.py", kws)
    assert score_shallow > score_deep
