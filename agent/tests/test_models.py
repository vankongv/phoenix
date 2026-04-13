"""Tests for Pydantic request/response models."""

import pytest
from pydantic import ValidationError

from models import IssueSpec, RunRequest, MovementBody, RepoBody


def test_issue_spec_minimal():
    spec = IssueSpec(intent="Add dark mode", acceptance_criteria=["Toggle exists"])
    assert spec.technical_notes is None
    assert spec.context_files == []


def test_run_request_defaults():
    req = RunRequest(
        issue_number=1,
        repo_full_name="owner/repo",
        spec=IssueSpec(intent="Fix bug", acceptance_criteria=["Bug is gone"]),
    )
    assert req.base_branch == "main"
    assert req.create_draft_pr is True
    assert req.mcp_servers == []
    assert req.autonomy is None


def test_run_request_requires_issue_number():
    with pytest.raises(ValidationError):
        RunRequest(
            repo_full_name="owner/repo",
            spec=IssueSpec(intent="Fix", acceptance_criteria=[]),
        )


def test_movement_body():
    body = MovementBody(
        repo="owner/repo", issue_number=5,
        from_column="todo", to_column="in_progress"
    )
    assert body.issue_number == 5


def test_repo_body():
    body = RepoBody(full_name="owner/repo")
    assert body.full_name == "owner/repo"
