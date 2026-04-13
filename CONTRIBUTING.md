# Contributing to Phoenix

Thank you for your interest in contributing. This guide covers everything you need to get started.

## Code of conduct

Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). In short: be respectful, constructive, and professional. Technical disagreement is fine; personal attacks are not.

## How to contribute

### Reporting bugs

Open an issue with:
- A clear title describing the problem
- Steps to reproduce
- What you expected vs what happened
- Your environment (OS, Python version, Node version, browser)

### Suggesting features

Open an issue tagged `enhancement`. Describe the problem you're solving and why you think it belongs in Phoenix rather than a plugin or fork. Check existing issues first to avoid duplicates.

### Submitting pull requests

1. **Fork** the repository and create your branch from `main`
2. **Read the architecture doc** at [src/ARCHITECTURE.md](src/ARCHITECTURE.md) before touching the frontend
3. **Write a test** if you're adding backend logic (see Testing below)
4. **Run the linters** before opening a PR
5. **Keep PRs focused** — one feature or fix per PR

## Development setup

```bash
git clone https://github.com/your-org/phoenix.git
cd phoenix/v5

# Backend
cd agent
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# Frontend
cd ..
npm install

# Start everything
./start.sh
```

Copy `agent/.env.example` to `agent/.env` and fill in your credentials.

## Project layout

```
v5/
├── src/
│   ├── components/   # Astro templates — markup only, no business logic
│   ├── lib/          # Pure JS modules — no DOM access, importable in tests
│   ├── scripts/      # DOM event handlers and module initialisation
│   └── styles/       # Global CSS (Tailwind)
└── agent/
    ├── routes/       # FastAPI route handlers — thin, delegate to agent.py / db.py
    ├── agent.py      # ImplementerAgent — git + OpenHands orchestration
    ├── db.py         # SQLite persistence layer
    └── semantic_server.py  # Embedding similarity service
```

## Coding conventions

### Python

- Type hints on all public functions
- No bare `except:` — always catch a specific exception type or at minimum `Exception`
- Parameterised SQL only — never string-format SQL queries
- `async`/`await` throughout — no blocking I/O on the event loop

### JavaScript

- ES modules (`import`/`export`) only
- `lib/` modules must not touch the DOM — keep them pure so they stay testable
- Service base URLs must come from `src/lib/config.js`, not hardcoded strings
- No `console.log` left in merged code (use the SSE event stream for debug output)

## Testing

```bash
cd agent
pytest                    # run all tests
pytest -x                 # stop on first failure
pytest tests/test_db.py   # single file
```

New backend logic should have a corresponding test in `agent/tests/`. Frontend `lib/` modules are pure functions — unit tests for those are welcome.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add semantic deduplication threshold config
fix: prevent worktree leak on agent timeout
docs: document lib/ vs scripts/ split
chore: bump openhands-ai to 0.39
```

## Questions

Open a discussion or ask in the issue thread for the feature you're working on.
