.PHONY: install install-frontend install-backend dev dev-frontend dev-backend \
        test lint lint-python lint-frontend format format-python format-frontend \
        typecheck build clean

# ── Install ───────────────────────────────────────────────────────────────────

install: install-frontend install-backend

install-frontend:
	npm install

install-backend:
	cd agent && python -m venv .venv && .venv/bin/pip install -e ".[dev]"

# ── Dev servers ───────────────────────────────────────────────────────────────
# Runs all three services (Astro, agent, semantic) in the foreground.
# Prefer ./start.sh for coloured output; this target exists for CI/scripting.

dev:
	./start.sh

dev-frontend:
	npm run dev

dev-backend:
	cd agent && .venv/bin/uvicorn app:app --host 0.0.0.0 --port 8001 --reload

dev-semantic:
	cd agent && .venv/bin/python semantic_server.py

# ── Tests ─────────────────────────────────────────────────────────────────────

test: test-backend

test-backend:
	cd agent && .venv/bin/pytest

test-frontend:
	npm run test

# ── Lint ──────────────────────────────────────────────────────────────────────

lint: lint-python lint-frontend

lint-python:
	cd agent && .venv/bin/ruff check .

lint-frontend:
	npm run lint

# ── Format ───────────────────────────────────────────────────────────────────

format: format-python format-frontend

format-python:
	cd agent && .venv/bin/ruff format .

format-frontend:
	npm run format

# ── Type checking ─────────────────────────────────────────────────────────────

typecheck:
	npm run typecheck

# ── Build ─────────────────────────────────────────────────────────────────────

build:
	npm run build

# ── Clean ─────────────────────────────────────────────────────────────────────

clean:
	rm -rf dist/ .astro/ agent/__pycache__ agent/.pytest_cache agent/.coverage
