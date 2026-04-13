import { initBoard, renderBoard } from '../lib/board.js';
import { onRunUpdate } from '../lib/implementer.js';
import { AGENT_BASE_URL, SEMANTIC_BASE_URL } from '../lib/config.js';
import { state } from './state.js';
import { initBoardLoader, showState, loadIssues, getFilters } from './board-loader.js';
import { initTokenRepo } from './token-repo.js';
import { triggerImplement } from './run-dispatcher.js';
import {
  railOpenSignal,
  agentsPanelOpenSignal,
  teamsPanelOpenSignal,
  planningPanelOpenSignal,
  openDrawer,
} from '../lib/signals.js';

const $ = (id) => document.getElementById(id);

// ── State callbacks (set before initBoard) ────────────────────
// openDrawer() writes drawerSignal — the IssueDrawer island reads it.
state.onOpenDrawer = openDrawer;
state.onImplement = (issue) => triggerImplement(issue);

initBoard(state);

// ── Module init ───────────────────────────────────────────────
initBoardLoader();
initTokenRepo();

// ── Run updates → board only (islands auto-update via signals) ─
onRunUpdate(() => {
  if (state.allIssues.length > 0) renderBoard(getFilters);
});

// ── Signal-based panel toggles (Preact islands) ───────────────
$('agent-rail-btn')?.addEventListener('click', () => {
  railOpenSignal.value = !railOpenSignal.value;
});
$('agents-btn')?.addEventListener('click', () => {
  agentsPanelOpenSignal.value = !agentsPanelOpenSignal.value;
});
$('teams-btn')?.addEventListener('click', () => {
  teamsPanelOpenSignal.value = !teamsPanelOpenSignal.value;
});
$('planning-btn')?.addEventListener('click', () => {
  planningPanelOpenSignal.value = !planningPanelOpenSignal.value;
});

// ── Service health checks ─────────────────────────────────────

async function checkServices() {
  const setHealth = (dotId, labelId, ok, label) => {
    const dot = $(dotId),
      lbl = $(labelId);
    if (!dot || !lbl) return;
    dot.style.background = ok ? '#16a34a' : '#ba1a1a';
    lbl.style.color = ok ? '#16a34a' : '#ba1a1a';
    lbl.textContent = label;
  };

  try {
    const r = await fetch(`${AGENT_BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const ok = r.ok;
    setHealth('health-agent-dot', 'health-agent-label', ok, ok ? 'online' : 'error');
  } catch {
    setHealth('health-agent-dot', 'health-agent-label', false, 'offline');
  }

  try {
    await fetch(`${SEMANTIC_BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    setHealth('health-semantic-dot', 'health-semantic-label', true, 'online');
  } catch {
    setHealth('health-semantic-dot', 'health-semantic-label', false, 'offline');
  }
}

checkServices();
setInterval(checkServices, 30_000);

// ── Init ─────────────────────────────────────────────────────
showState('empty');
const lastRepo = localStorage.getItem('last_repo');
if (lastRepo) {
  $('repo-input').value = lastRepo;
  loadIssues(lastRepo);
}
