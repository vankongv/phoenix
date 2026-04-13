import { fetchUserRepos } from '../lib/github-api.js';
import { escHtml } from '../lib/formatters.js';
import { state } from './state.js';
import { loadIssues } from './board-loader.js';

const $ = (id) => document.getElementById(id);

const repoSwitcherSelect = $('repo-switcher-select');
const repoSwitcherSep = $('repo-switcher-sep');

// ── Repo panel state ─────────────────────────────────────────
function showRepoPanel(s) {
  ['repo-no-token', 'repo-loading', 'repo-list-wrap', 'repo-fetch-error'].forEach((id) =>
    $(id).classList.add('hidden')
  );
  if (s) $(s).classList.remove('hidden');
}

export async function loadUserRepos() {
  showRepoPanel('repo-loading');
  try {
    state.repos = await fetchUserRepos();
    renderRepoList(state.repos);
    // Only show the repo list if no repo is currently selected or loading
    if (!state.repoFullName) showRepoPanel('repo-list-wrap');
    populateRepoSwitcher(state.repos);
  } catch (err) {
    $('repo-fetch-error-text').textContent = err.userMessage || 'Could not load repos.';
    showRepoPanel('repo-fetch-error');
  }
}

function renderRepoList(repos) {
  const list = $('repo-list');
  list.innerHTML = '';
  repos.forEach((repo) => {
    const btn = document.createElement('button');
    btn.dataset.repo = repo.full_name;
    btn.className =
      'repo-list-item w-full text-left px-2 py-1.5 rounded-lg text-xs text-on-surface hover:bg-surface-container transition-colors flex items-center gap-1.5';
    btn.innerHTML = `
      <span class="material-symbols-outlined text-on-surface-variant/50 flex-shrink-0" style="font-size:13px">${repo.private ? 'lock' : 'public'}</span>
      <span class="truncate">${escHtml(repo.full_name)}</span>`;
    list.appendChild(btn);
  });
}

function populateRepoSwitcher(repos) {
  repoSwitcherSelect.innerHTML = '';
  repos.forEach((repo) => {
    const opt = document.createElement('option');
    opt.value = repo.full_name;
    opt.textContent = repo.full_name;
    repoSwitcherSelect.appendChild(opt);
  });
  // Restore active selection after repopulate
  if (state.repoFullName) repoSwitcherSelect.value = state.repoFullName;
}

function initRepoPanel() {
  const token = localStorage.getItem('gh_token');
  if (!token) {
    showRepoPanel('repo-no-token');
  } else {
    loadUserRepos();
  }
}

function showTokenStatus(msg, color) {
  const el = $('token-status');
  el.textContent = msg;
  el.style.color = color;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2000);
}

// ── Init ─────────────────────────────────────────────────────
export function initTokenRepo() {
  // Token modal
  $('token-btn').addEventListener('click', () => {
    $('token-input').value = localStorage.getItem('gh_token') || '';
    $('token-modal').classList.remove('hidden');
  });
  $('token-modal-close').addEventListener('click', () => $('token-modal').classList.add('hidden'));
  $('token-modal').addEventListener('click', (e) => {
    if (e.target === $('token-modal')) $('token-modal').classList.add('hidden');
  });
  $('token-save').addEventListener('click', () => {
    const val = $('token-input').value.trim();
    if (val) {
      localStorage.setItem('gh_token', val);
      loadUserRepos();
      showTokenStatus('Token saved ✓', '#1a7a4a');
      setTimeout(() => $('token-modal').classList.add('hidden'), 700);
    }
  });
  $('token-clear').addEventListener('click', () => {
    localStorage.removeItem('gh_token');
    $('token-input').value = '';
    showTokenStatus('Cleared', '#ba1a1a');
    showRepoPanel('repo-no-token');
    repoSwitcherSelect.classList.add('hidden');
    repoSwitcherSep.classList.add('hidden');
  });

  // Repo list click (event delegation)
  $('repo-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-repo]');
    if (!btn) return;
    const repo = btn.dataset.repo;
    $('repo-input').value = repo;
    loadIssues(repo);
    $('repo-list')
      .querySelectorAll('.repo-list-item')
      .forEach((b) => b.classList.toggle('bg-primary/10', b.dataset.repo === repo));
    // Show selected repo chip, hide the list
    $('repo-selected-name').textContent = repo.replace('oolio-group/', '');
    $('repo-selected-wrap').classList.remove('hidden');
    $('repo-list-wrap').classList.add('hidden');
    $('repo-search').value = '';
    $('repo-list')
      .querySelectorAll('.repo-list-item')
      .forEach((b) => b.classList.remove('hidden'));
  });

  // Change repo button — show list again
  $('repo-change-btn').addEventListener('click', () => {
    $('repo-selected-wrap').classList.add('hidden');
    $('repo-list-wrap').classList.remove('hidden');
    $('repo-search').focus();
  });

  // Repo search filter
  $('repo-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    $('repo-list')
      .querySelectorAll('.repo-list-item')
      .forEach((btn) => {
        btn.classList.toggle('hidden', !btn.dataset.repo.toLowerCase().includes(q));
      });
  });

  // Manual fallback toggle
  $('repo-manual-toggle').addEventListener('click', () => {
    $('repo-manual-wrap').classList.toggle('hidden');
  });

  // Retry button
  $('repo-retry-btn').addEventListener('click', loadUserRepos);

  // "Set Token" shortcut in sidebar
  $('repo-set-token-btn').addEventListener('click', () => {
    $('token-input').value = localStorage.getItem('gh_token') || '';
    $('token-modal').classList.remove('hidden');
  });

  initRepoPanel();
}
