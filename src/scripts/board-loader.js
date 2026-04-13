import { fetchAllIssues, createIssue } from '../lib/github-api.js';
import { buildColumns, renderBoard } from '../lib/board.js';
import { loadTriageDuplicates } from '../lib/semantic.js';
import { AGENT_BASE_URL } from '../lib/config.js';
import { state } from './state.js';
import { getLocalIssues, promoteLocalIssue } from '../lib/local-issues.js';

const $ = (id) => document.getElementById(id);

const repoSwitcherSelect = $('repo-switcher-select');
const repoSwitcherSep = $('repo-switcher-sep');
const statsBar = $('stats-bar');
const emptyState = $('empty-state');
const loadingState = $('loading-state');
const errorState = $('error-state');
const boardWrap = $('board-wrap');

// ── UI state ─────────────────────────────────────────────────
export function showState(s) {
  [emptyState, loadingState, errorState, boardWrap].forEach((el) => el.classList.add('hidden'));
  [emptyState, loadingState, errorState].forEach((el) => el.classList.remove('flex'));
  statsBar.classList.add('hidden');
  statsBar.classList.remove('flex');

  if (s === 'empty') {
    emptyState.classList.remove('hidden');
    emptyState.classList.add('flex');
  }
  if (s === 'loading') {
    loadingState.classList.remove('hidden');
    loadingState.classList.add('flex');
  }
  if (s === 'error') {
    errorState.classList.remove('hidden');
    errorState.classList.add('flex');
  }
  if (s === 'board') boardWrap.classList.remove('hidden');
}

// ── Filters ──────────────────────────────────────────────────
export function getFilters() {
  return {
    search: ($('filter-search').value || '').toLowerCase(),
    label: $('filter-label').value,
    assignee: $('filter-assignee').value,
  };
}

export function populateFilters() {
  const labels = new Set(),
    assignees = new Set();
  state.allIssues.forEach((i) => {
    (i.labels || []).forEach((l) => labels.add(l.name));
    (i.assignees || []).forEach((a) => assignees.add(a.login));
  });

  const ls = $('filter-label');
  ls.innerHTML = '<option value="">All labels</option>';
  [...labels].sort().forEach((l) => {
    const o = document.createElement('option');
    o.value = l;
    o.textContent = l;
    ls.appendChild(o);
  });

  const as = $('filter-assignee');
  as.innerHTML = '<option value="">All assignees</option>';
  [...assignees].sort().forEach((a) => {
    const o = document.createElement('option');
    o.value = a;
    o.textContent = a;
    as.appendChild(o);
  });
}

// ── Load issues ──────────────────────────────────────────────
export async function loadIssues(repoArg) {
  const repo = repoArg || $('repo-input').value.trim();
  if (!repo || !repo.includes('/')) {
    alert('Enter a valid owner/repo');
    return;
  }

  showState('loading');
  $('loading-text').textContent = `Fetching issues for ${repo}…`;
  state.repoFullName = repo; // Set early so other async code knows a repo is loading

  try {
    state.allIssues = [...getLocalIssues(repo), ...await fetchAllIssues(repo)];
    state.duplicates = new Map();
    buildColumns();
    populateFilters();
    renderBoard(getFilters);
    showState('board');
    $('board-repo').textContent = repo;
    $('stat-open').textContent = `${state.allIssues.length} open issues`;
    statsBar.classList.remove('hidden');
    statsBar.classList.add('flex');
    localStorage.setItem('last_repo', repo);
    // Persist repo to SQLite (fire-and-forget)
    fetch(`${AGENT_BASE_URL}/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: repo }),
    }).catch(() => {});
    $('new-issue-btn').classList.remove('hidden');
    $('new-issue-btn').classList.add('flex');

    // Sync header switcher
    repoSwitcherSelect.classList.remove('hidden');
    repoSwitcherSep.classList.remove('hidden');
    if (!Array.from(repoSwitcherSelect.options).some((o) => o.value === repo)) {
      const opt = document.createElement('option');
      opt.value = repo;
      opt.textContent = repo;
      repoSwitcherSelect.prepend(opt);
    }
    repoSwitcherSelect.value = repo;

    // Highlight selected in sidebar list
    $('repo-list')
      .querySelectorAll('.repo-list-item')
      .forEach((b) => b.classList.toggle('bg-primary/10', b.dataset.repo === repo));

    // Show selected chip in sidebar
    const repoSelectedName = $('repo-selected-name');
    const repoSelectedWrap = $('repo-selected-wrap');
    const repoListWrap = $('repo-list-wrap');
    if (repoSelectedName) repoSelectedName.textContent = repo.replace('oolio-group/', '');
    if (repoSelectedWrap) repoSelectedWrap.classList.remove('hidden');
    if (repoListWrap) repoListWrap.classList.add('hidden');

    // Load semantic duplicates for Triage column in the background
    const triageIssues = state.columns['triage']?.issues ?? [];
    if (triageIssues.length) {
      loadTriageDuplicates(triageIssues, repo).then((dupeMap) => {
        if (dupeMap.size > 0) {
          state.duplicates = dupeMap;
          renderBoard(getFilters);
        }
      });
    }
  } catch (err) {
    showState('error');
    $('error-text').textContent = err.message || 'Failed to fetch issues';
    $('error-detail').textContent =
      err.userMessage ||
      (err.status === 401
        ? 'Invalid or missing token — click Token to add one.'
        : err.status === 404
          ? 'Repo not found or not accessible.'
          : 'Check the repo name and token, then try again.');
  }
}

// ── Restore repo history from SQLite ─────────────────────────
async function restoreRepoHistory() {
  try {
    const res = await fetch(`${AGENT_BASE_URL}/repos?limit=50`);
    if (!res.ok) return;
    const repos = await res.json();
    if (!repos.length) return;

    // Populate the header switcher with persisted repos
    repos.forEach(({ full_name }) => {
      if (!Array.from(repoSwitcherSelect.options).some((o) => o.value === full_name)) {
        const opt = document.createElement('option');
        opt.value = full_name;
        opt.textContent = full_name;
        repoSwitcherSelect.appendChild(opt);
      }
    });
    repoSwitcherSelect.classList.remove('hidden');
    repoSwitcherSep.classList.remove('hidden');

    // Auto-load the most-recently accessed repo (first in list)
    const last = localStorage.getItem('last_repo') || repos[0]?.full_name;
    if (last) {
      $('repo-input').value = last;
      loadIssues(last);
    }
  } catch {
    // Agent server not running — silently degrade
  }
}

// ── Event listeners ──────────────────────────────────────────
export function initBoardLoader() {
  $('load-btn').addEventListener('click', () => loadIssues());
  $('repo-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadIssues();
  });
  $('demo-btn').addEventListener('click', () => {
    $('repo-input').value = 'vercel/next.js';
    loadIssues();
  });

  repoSwitcherSelect.addEventListener('change', () => {
    loadIssues(repoSwitcherSelect.value);
  });

  ['filter-search', 'filter-label', 'filter-assignee'].forEach((id) =>
    $(id).addEventListener('input', () => renderBoard(getFilters))
  );

  // ── New Issue modal ───────────────────────────────────────────
  function openNewIssueModal() {
    $('new-issue-title').value = '';
    $('new-issue-body').value = '';
    $('new-issue-labels').value = '';
    $('new-issue-error').classList.add('hidden');
    $('new-issue-modal').classList.remove('hidden');
    $('new-issue-title').focus();
  }

  function closeNewIssueModal() {
    $('new-issue-modal').classList.add('hidden');
  }

  $('new-issue-btn').addEventListener('click', openNewIssueModal);
  $('new-issue-modal-close').addEventListener('click', closeNewIssueModal);
  $('new-issue-cancel').addEventListener('click', closeNewIssueModal);
  $('new-issue-modal').addEventListener('click', (e) => {
    if (e.target === $('new-issue-modal')) closeNewIssueModal();
  });

  $('new-issue-submit').addEventListener('click', async () => {
    const title = $('new-issue-title').value.trim();
    const body = $('new-issue-body').value.trim();
    const labels = $('new-issue-labels')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!title) {
      $('new-issue-error').textContent = 'Title is required.';
      $('new-issue-error').classList.remove('hidden');
      return;
    }

    const btn = $('new-issue-submit');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    $('new-issue-error').classList.add('hidden');

    try {
      const created = await createIssue(state.repoFullName, {
        title,
        body,
        labels: labels.length ? labels : undefined,
      });
      state.allIssues.unshift(created);
      buildColumns();
      populateFilters();
      renderBoard(getFilters);
      closeNewIssueModal();
    } catch (err) {
      $('new-issue-error').textContent =
        err.userMessage || err.message || 'Failed to create issue.';
      $('new-issue-error').classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.innerHTML =
        '<span class="material-symbols-outlined" style="font-size:14px">add_circle</span> Create Issue';
    }
  });

  // ── Local issue events (from Planning panel) ─────────────────
  window.addEventListener('pnx:add-local-issue', (e) => {
    if (!state.repoFullName) return;
    state.allIssues.unshift(e.detail);
    buildColumns();
    renderBoard(getFilters);
  });

  window.addEventListener('pnx:promote-local-issue', (e) => {
    if (!state.repoFullName) return;
    const { localId, localNum, githubIssue } = e.detail;
    promoteLocalIssue(state.repoFullName, localId);
    const idx = state.allIssues.findIndex((i) => i.number === localNum);
    if (idx !== -1) state.allIssues.splice(idx, 1, githubIssue);
    else state.allIssues.unshift(githubIssue);
    buildColumns();
    renderBoard(getFilters);
  });

  // Restore repo history from SQLite on startup
  restoreRepoHistory();
}
