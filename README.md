# Phoenix v5

An AI-powered GitHub Kanban board that lets you ship issues directly from your board. Assign any issue to an AI agent and it will implement the feature, commit the changes, and open a draft PR — all without leaving the board.

## What it does

- **GitHub Kanban** — pulls your repo's issues into a Triage → Todo → In Progress → Review → Done board, with manual drag-and-drop lane overrides persisted locally
- **ImplementerAgent** — one click sends an issue to OpenHands + Claude; the agent writes the code, commits, and opens a PR
- **IssueRefiner** — rewrites vague issue descriptions into structured specs with acceptance criteria before implementation
- **Semantic deduplication** — flags similar/duplicate issues using embedding similarity
- **Run history** — full SSE event log per agent run, persisted to local SQLite

## Architecture

```
v5/
├── src/                  # Astro frontend (static, no SSR)
│   ├── components/       # Astro component templates
│   ├── lib/              # Pure logic: GitHub API, board state, formatters
│   ├── scripts/          # DOM wiring and event handlers
│   └── styles/           # Global CSS
├── agent/                # Python backend (FastAPI)
│   ├── app.py            # FastAPI app + middleware
│   ├── agent.py          # ImplementerAgent — git worktree + OpenHands runner
│   ├── semantic_server.py# Embedding similarity service (port 3001)
│   ├── routes/           # API route handlers
│   ├── db.py             # SQLite persistence (aiosqlite)
│   └── config.py         # Environment variable configuration
└── start.sh              # Dev launcher (starts both servers + Astro)
```

See [src/ARCHITECTURE.md](src/ARCHITECTURE.md) for a deeper explanation of the frontend's `lib/` vs `scripts/` pattern.

## Prerequisites

- Python 3.12+
- Node.js 18+
- A GitHub Personal Access Token (classic, `repo` scope)
- An Anthropic API key (or any LiteLLM-compatible key)

## Quick start

```bash
# 1. Clone
git clone https://github.com/your-org/phoenix.git
cd phoenix/v5

# 2. Configure the agent
cp agent/.env.example agent/.env
# Edit agent/.env — set GITHUB_TOKEN and ANTHROPIC_API_KEY

# 3. Install dependencies
cd agent && python -m venv .venv && source .venv/bin/activate
pip install -e .
cd ..
npm install

# 4. Run
./start.sh
```

The board will open at `http://localhost:4321`. The agent API runs on port `8001` and the semantic service on port `3001`.

## Configuration

All agent configuration lives in `agent/.env`. Copy `agent/.env.example` and fill in:

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_TOKEN` | Yes | — | GitHub PAT with `repo` scope |
| `ANTHROPIC_API_KEY` | Yes* | — | Anthropic API key (*or set per-agent in the UI) |
| `LLM_MODEL` | No | `anthropic/claude-sonnet-4-6` | LiteLLM model string |
| `CORS_ORIGINS` | No | `*` in dev | Comma-separated allowed origins |
| `PNX_REPOS_DIR` | No | `~/.pnx/repos` | Directory for base git clones |

### Frontend service URLs

The frontend defaults to `http://localhost:8001` (agent) and `http://localhost:3001` (semantic). Override at build time via Astro env vars:

```bash
# .env in v5/ root
PUBLIC_AGENT_URL=https://agent.example.com
PUBLIC_SEMANTIC_URL=https://semantic.example.com
```

## Development

```bash
# Start everything (recommended)
./start.sh

# Or start services individually:
cd agent && uvicorn app:app --port 8001 --reload
cd agent && python semantic_server.py
cd v5    && npm run dev
```

Logs are written to `.logs/` (gitignored).

## Running tests

```bash
cd agent
pip install -e ".[dev]"
pytest
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability disclosure policy.

## License

[GNU AGPL-3.0](LICENSE)
