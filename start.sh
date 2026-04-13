#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$SCRIPT_DIR/agent"
ENV_FILE="$AGENT_DIR/.env"

# ── Colours ───────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

# ── Load .env (optional) ──────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# ── Check required commands ───────────────────────────────────
need() { command -v "$1" &>/dev/null || { echo -e "${RED}ERROR: '$1' not found. $2${RESET}"; exit 1; }; }
need node "Install Node.js from https://nodejs.org"
need npm  "Install Node.js from https://nodejs.org"

# Resolve uvicorn: prefer venv inside agent/, then uv run, then PATH
UVICORN=""
if [[ -x "$AGENT_DIR/.venv/bin/uvicorn" ]]; then
  UVICORN="$AGENT_DIR/.venv/bin/uvicorn"
elif [[ -x "$AGENT_DIR/venv/bin/uvicorn" ]]; then
  UVICORN="$AGENT_DIR/venv/bin/uvicorn"
elif command -v uvicorn &>/dev/null; then
  UVICORN="uvicorn"
elif command -v uv &>/dev/null; then
  # uv run installs deps on the fly from pyproject.toml
  UVICORN="uv run uvicorn"
else
  echo -e "${RED}ERROR: uvicorn not found.${RESET}"
  echo -e "  Install it with one of:"
  echo -e "    ${BOLD}cd agent && python3 -m venv .venv && .venv/bin/pip install -e .${RESET}"
  echo -e "    ${BOLD}pip install uvicorn${RESET}"
  echo -e "    ${BOLD}brew install uv && uv sync${RESET} (inside agent/)"
  exit 1
fi

# ── Trap: kill all background processes on exit ───────────────
PIDS=()
cleanup() {
  echo -e "\n${YELLOW}Shutting down…${RESET}"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo -e "${GREEN}All processes stopped.${RESET}"
}
trap cleanup INT TERM EXIT

# ── Free ports if already in use ─────────────────────────────
free_port() {
  local port="$1"
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo -e "  ${YELLOW}Port $port in use — killing stale process(es)…${RESET}"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 0.5
  fi
}
free_port 8001
free_port 3001
free_port 4321
free_port 4322
free_port 4323
free_port 4324

# ── Ensure esbuild binary is healthy (crashes on stale installs) ──
if ! "$SCRIPT_DIR/node_modules/.bin/esbuild" --version &>/dev/null; then
  echo -e "  ${YELLOW}esbuild binary broken — reinstalling node_modules…${RESET}"
  npm --prefix "$SCRIPT_DIR" install
fi

# ── Log files ─────────────────────────────────────────────────
LOG_DIR="$SCRIPT_DIR/.logs"
mkdir -p "$LOG_DIR"

# ── Start services ────────────────────────────────────────────
echo -e "${BOLD}${CYAN}Ponenix v5${RESET} — starting all services"
echo -e "  Using: ${YELLOW}$UVICORN${RESET}\n"

# 1. Agent server (port 8001)
echo -e "  ${GREEN}▶${RESET} Agent server      → http://localhost:8001"
(cd "$AGENT_DIR" && $UVICORN server:app --host 0.0.0.0 --port 8001) \
  >"$LOG_DIR/agent.log" 2>&1 &
PIDS+=($!)

# 2. Semantic service (port 3001)
echo -e "  ${GREEN}▶${RESET} Semantic service  → http://localhost:3001"
(cd "$AGENT_DIR" && $UVICORN semantic_server:app --host 0.0.0.0 --port 3001) \
  >"$LOG_DIR/semantic.log" 2>&1 &
PIDS+=($!)

# 3. Astro frontend (port 4321 by default)
echo -e "  ${GREEN}▶${RESET} Frontend (Astro)  → http://localhost:4321"
npm --prefix "$SCRIPT_DIR" run dev \
  >"$LOG_DIR/frontend.log" 2>&1 &
PIDS+=($!)

# ── Wait for backends to be ready ────────────────────────────
echo -e "\n  Waiting for services to come up…"
wait_for() {
  local url="$1" name="$2" i=0
  while ! curl -sf "$url" >/dev/null 2>&1; do
    sleep 0.5
    i=$(( i + 1 ))
    if (( i >= 30 )); then
      echo -e "  ${RED}✗ $name did not start (check .logs/${name,,}.log)${RESET}"
      return
    fi
  done
  echo -e "  ${GREEN}✓${RESET} $name ready"
}

wait_for "http://localhost:8001/health" "Agent server"
wait_for "http://localhost:3001/health" "Semantic service"

# Frontend is ready when Astro prints its URL — just give it a moment
sleep 2
echo -e "  ${GREEN}✓${RESET} Frontend ready\n"

echo -e "${BOLD}All services running.${RESET}"
echo -e "  Frontend  → ${CYAN}http://localhost:4321${RESET}"
echo -e "  Agent     → ${CYAN}http://localhost:8001${RESET}"
echo -e "  Semantic  → ${CYAN}http://localhost:3001${RESET}"
echo -e "  Logs      → ${CYAN}.logs/${RESET}"
echo -e "\n  Press ${BOLD}Ctrl+C${RESET} to stop all.\n"

# Keep alive — wait for any child to die unexpectedly
wait -n "${PIDS[@]}" 2>/dev/null || true
echo -e "\n${YELLOW}A service exited unexpectedly. Check .logs/ for details.${RESET}"
