"""
Phoenix v5 — Semantic duplicate-detection service
Runs on port 3001 (configurable via PORT env var).

Endpoints:
  GET /health
  GET /issues/similar?repo=owner/repo&number=42

Algorithm:
  TF-IDF cosine similarity over issue titles + bodies.
  Uses only stdlib (no scikit-learn) — results are cached per repo
  for 5 minutes so repeated Triage loads don't hammer the GitHub API.

Run:
  uvicorn semantic_server:app --port 3001
  # or via entry point:
  phoenix-semantic
"""

import math
import os
import re
import time
from collections import defaultdict
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from github import Github

# ── Config ────────────────────────────────────────────────────────────────────

GITHUB_TOKEN: str = os.environ["GITHUB_TOKEN"]
SIMILARITY_THRESHOLD: float = float(os.getenv("SIMILARITY_THRESHOLD", "0.15"))
CACHE_TTL: int = int(os.getenv("CACHE_TTL_SECONDS", "300"))  # 5 minutes
MAX_ISSUES: int = int(os.getenv("MAX_ISSUES", "500"))
CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "")

_gh = Github(GITHUB_TOKEN)

# ── In-memory cache ───────────────────────────────────────────────────────────

_cache: dict[str, tuple[float, list[dict]]] = {}   # repo → (timestamp, issues)


def _get_issues(repo_name: str) -> list[dict]:
    """Fetch open issues for a repo, with TTL cache."""
    now = time.monotonic()
    if repo_name in _cache:
        ts, issues = _cache[repo_name]
        if now - ts < CACHE_TTL:
            return issues

    repo = _gh.get_repo(repo_name)
    raw = repo.get_issues(state="open")
    issues = []
    for i, issue in enumerate(raw):
        if i >= MAX_ISSUES:
            break
        if issue.pull_request:        # skip PRs
            continue
        issues.append({
            "number": issue.number,
            "title": issue.title or "",
            "body": (issue.body or "")[:2000],
        })

    _cache[repo_name] = (now, issues)
    return issues


# ── TF-IDF helpers ────────────────────────────────────────────────────────────

def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def _tf(tokens: list[str]) -> dict[str, float]:
    counts: dict[str, int] = defaultdict(int)
    for t in tokens:
        counts[t] += 1
    total = len(tokens) or 1
    return {t: c / total for t, c in counts.items()}


def _build_tfidf(docs: list[list[str]]) -> list[dict[str, float]]:
    """Return TF-IDF vectors for each document."""
    n = len(docs)
    df: dict[str, int] = defaultdict(int)
    tfs = [_tf(d) for d in docs]
    for tf in tfs:
        for term in tf:
            df[term] += 1

    idf = {term: math.log((n + 1) / (cnt + 1)) + 1.0 for term, cnt in df.items()}

    vectors = []
    for tf in tfs:
        vec = {term: tf_val * idf.get(term, 1.0) for term, tf_val in tf.items()}
        vectors.append(vec)
    return vectors


def _cosine(a: dict[str, float], b: dict[str, float]) -> float:
    dot = sum(a.get(t, 0.0) * v for t, v in b.items())
    mag_a = math.sqrt(sum(v * v for v in a.values())) or 1e-9
    mag_b = math.sqrt(sum(v * v for v in b.values())) or 1e-9
    return dot / (mag_a * mag_b)


def _find_similar(
    issues: list[dict],
    target_number: int,
    threshold: float,
) -> list[dict]:
    docs = [_tokenize(f"{i['title']} {i['body']}") for i in issues]
    vectors = _build_tfidf(docs)

    target_idx = next((i for i, iss in enumerate(issues) if iss["number"] == target_number), None)
    if target_idx is None:
        return []

    target_vec = vectors[target_idx]
    results = []
    for i, (issue, vec) in enumerate(zip(issues, vectors)):
        if i == target_idx:
            continue
        sim = _cosine(target_vec, vec)
        if sim >= threshold:
            results.append({
                "issueId": str(issue["number"]),
                "number": issue["number"],
                "title": issue["title"],
                "similarity": round(sim, 4),
            })

    results.sort(key=lambda x: x["similarity"], reverse=True)
    return results[:10]


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Phoenix Semantic Service", version="5.0.0")

_allow_origins = (
    [o.strip() for o in CORS_ORIGINS.split(",") if o.strip()]
    if CORS_ORIGINS
    else []
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins if _allow_origins else ["*"],
    allow_origin_regex=None if _allow_origins else r"http://localhost:\d+",
    allow_methods=["GET"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "version": "5.0.0", "cached_repos": len(_cache)}


@app.get("/issues/similar")
async def similar_issues(
    repo: str = Query(..., description="owner/repo"),
    number: int = Query(..., description="Issue number"),
    threshold: Optional[float] = Query(None, description="Override similarity threshold"),
) -> dict:
    if not repo or "/" not in repo:
        raise HTTPException(status_code=400, detail="repo must be 'owner/repo'")

    try:
        issues = _get_issues(repo)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"GitHub error: {exc}") from exc

    if not any(i["number"] == number for i in issues):
        raise HTTPException(status_code=404, detail=f"Issue #{number} not found in {repo}")

    t = threshold if threshold is not None else SIMILARITY_THRESHOLD
    similar = _find_similar(issues, number, t)
    return {"similar": similar}


# ── CLI entry point ───────────────────────────────────────────────────────────

def serve_semantic() -> None:
    """Entry point for `phoenix-semantic` / `uvx phoenix-agent` semantic mode."""
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(
        prog="phoenix-semantic",
        description="Phoenix v5 semantic duplicate-detection service",
    )
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "3001")))
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    uvicorn.run(app, host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    serve_semantic()
