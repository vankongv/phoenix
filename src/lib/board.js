import { COLUMNS } from './constants.js';
import { escHtml, timeAgo, detectPriority, priorityIcon } from './formatters.js';
import { assignColumn } from './column-mapper.js';
import { runStore, refine, cancelRun, pushRun } from './implementer.js';
import { getLaneAction, getCodeEditor } from './agents.js';
import { AGENT_BASE_URL as AGENT_BASE } from './config.js';
import { createIssue } from './github-api.js';

// ── Board toast ────────────────────────────────────────────────────────────────
function _showToast(msg) {
  let el = document.getElementById('board-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'board-toast';
    el.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;' +
      'background:#1a1b2e;color:#fff;font-size:13px;font-weight:600;padding:10px 20px;' +
      'border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,0.25);pointer-events:none;' +
      'display:flex;align-items:center;gap:8px;transition:opacity 0.3s';
    document.body.appendChild(el);
  }
  el.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px;color:#f9c74f">info</span>${escHtml(msg)}`;
  el.style.opacity = '1';
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 3000);
}

// ── Card lane persistence ─────────────────────────────────────
const CARD_LANES_KEY = 'pnx_card_lanes';

function _getCardLanes() {
  try {
    return JSON.parse(localStorage.getItem(CARD_LANES_KEY) || '{}');
  } catch {
    return {};
  }
}

function _saveCardLane(repo, issueNumber, columnId) {
  const all = _getCardLanes();
  if (!all[repo]) all[repo] = {};
  all[repo][String(issueNumber)] = columnId;
  try {
    localStorage.setItem(CARD_LANES_KEY, JSON.stringify(all));
  } catch {}
}

export function clearCardLanes() {
  localStorage.removeItem(CARD_LANES_KEY);
}

let _state = null;

export function initBoard(state) {
  _state = state;
}

export function buildColumns() {
  _state.columns = {};
  COLUMNS.forEach((c) => {
    _state.columns[c.id] = { ...c, issues: [] };
  });

  // Build default column map, then apply any persisted overrides
  const issueColMap = new Map();
  _state.allIssues.forEach((i) => issueColMap.set(i.number, assignColumn(i)));

  const repoLanes = _getCardLanes()[_state.repoFullName] || {};
  Object.entries(repoLanes).forEach(([num, col]) => {
    const n = parseInt(num, 10);
    if (issueColMap.has(n) && _state.columns[col]) issueColMap.set(n, col);
  });

  _state.allIssues.forEach((i) => _state.columns[issueColMap.get(i.number)].issues.push(i));
}

export function renderBoard(getFilters) {
  const board = document.getElementById('board');
  board.innerHTML = '';

  COLUMNS.forEach((colDef) => {
    const filtered = applyFilters(_state.columns[colDef.id].issues, getFilters());
    const colEl = document.createElement('div');
    colEl.className = 'flex flex-col min-w-[260px] max-w-[280px] flex-shrink-0';
    colEl.dataset.col = colDef.id;

    colEl.innerHTML = `
      <div class="flex items-center justify-between px-1 mb-3">
        <div class="flex items-center gap-1.5">
          <span class="material-symbols-outlined" style="font-size:14px;color:${colDef.color}">${colDef.icon}</span>
          <span class="text-[10px] font-bold uppercase tracking-widest" style="color:${colDef.color}">${colDef.label}</span>
        </div>
        <span class="text-[10px] font-bold px-1.5 py-0.5 rounded" style="background:#edeef0;color:#434654">${filtered.length}</span>
      </div>
      <div class="col-cards col-drop flex flex-col gap-2 rounded-lg p-1.5" data-col="${colDef.id}" style="background:#f3f4f6;min-height:60px"></div>
    `;

    const cardsEl = colEl.querySelector('.col-cards');
    filtered.forEach((issue) => cardsEl.appendChild(buildCard(issue, colDef.id)));

    cardsEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      cardsEl.classList.add('drag-over');
    });
    cardsEl.addEventListener('dragleave', () => cardsEl.classList.remove('drag-over'));
    cardsEl.addEventListener('drop', (e) => {
      e.preventDefault();
      cardsEl.classList.remove('drag-over');
      if (_state.dragNum && _state.dragFrom !== colDef.id) {
        // Find the dragged issue across all columns
        const draggedIssue = Object.values(_state.columns)
          .flatMap((c) => c.issues)
          .find((i) => i.number === _state.dragNum);
        if (draggedIssue?._local && colDef.id !== 'triage') {
          _showToast('Push this issue to GitHub before moving it past Triage.');
          return;
        }
        moveCard(_state.dragNum, _state.dragFrom, colDef.id, getFilters);
      }
    });

    board.appendChild(colEl);
  });
}

function buildCard(issue, colId) {
  const card = document.createElement('div');
  card.className = 'card rounded-lg p-3 transition-colors select-none';
  card.style.background = '#ffffff';
  card.draggable = true;
  card.dataset.issue = issue.number;

  const labels = (issue.labels || []).slice(0, 3);
  const assignee = (issue.assignees || [])[0];
  const pi = priorityIcon(detectPriority(issue));
  const run = runStore.get(issue.number);
  const dupList = colId === 'triage' ? (_state.duplicates?.get(issue.number) ?? []) : [];
  const topDup = dupList[0];

  const showEditorBtn = colId === 'todo' || colId === 'in_progress';

  card.innerHTML = `
    ${issue._local ? `
    <div class="flex items-center gap-1 mb-1.5">
      <span class="material-symbols-outlined" style="font-size:11px;color:#b45309">cloud_off</span>
      <span class="text-[10px] font-semibold" style="color:#b45309">Board only — not on GitHub</span>
    </div>` : ''}
    <div class="flex items-start justify-between gap-2 mb-2">
      <div class="flex-1 min-w-0">
        <span class="font-mono text-[10px] text-secondary uppercase tracking-wider">${issue._local ? 'draft' : `#${issue.number}`}</span>
        <h3 class="text-xs font-semibold text-on-surface leading-snug line-clamp-2 mt-0.5">${escHtml(issue.title)}</h3>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        ${
          showEditorBtn
            ? `<button data-open-editor-card
          class="flex items-center justify-center w-6 h-6 rounded-md transition-colors"
          style="background:#e8ecf5;color:#434654"
          onclick="event.stopPropagation()" title="Open in editor">
          <span data-editor-icon class="material-symbols-outlined" style="font-size:14px">code</span>
        </button>`
            : ''
        }
        <span class="material-symbols-outlined ${pi.color}" style="font-size:15px;font-variation-settings:'FILL' 1">${pi.icon}</span>
      </div>
    </div>
    ${
      labels.length
        ? `
    <div class="flex flex-wrap gap-1 mb-2">
      ${labels
        .map((l) => {
          const c = '#' + (l.color || '737685');
          return `<span class="label-pill" style="color:${c};background:${c}18">${escHtml(l.name)}</span>`;
        })
        .join('')}
    </div>`
        : ''
    }
    <div class="flex items-center justify-between mt-1">
      <div class="flex items-center gap-2">
        ${issue.comments ? `<span class="flex items-center gap-0.5 text-[10px] text-on-surface-variant/60"><span class="material-symbols-outlined" style="font-size:11px">chat_bubble</span>${issue.comments}</span>` : ''}
        ${assignee ? `<img src="${escHtml(assignee.avatar_url)}" class="w-4 h-4 rounded-full" title="${escHtml(assignee.login)}"/>` : ''}
      </div>
      <span class="text-[10px] text-on-surface-variant/50">${timeAgo(issue.created_at)}</span>
    </div>
    ${topDup ? _renderDupBadge(topDup, dupList.length) : ''}
    ${_renderRunBar(run, colId, issue)}
  `;

  card.addEventListener('mouseenter', () => {
    card.style.background = '#f3f4f6';
  });
  card.addEventListener('mouseleave', () => {
    card.style.background = '#ffffff';
  });
  card.addEventListener('click', () => _state.onOpenDrawer(issue));
  card.addEventListener('dragstart', () => {
    _state.dragNum = issue.number;
    _state.dragFrom = colId;
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    _state.dragNum = null;
    _state.dragFrom = null;
  });

  // Push local issue to GitHub
  const pushToGitHubBtn = card.querySelector('[data-push-to-github]');
  if (pushToGitHubBtn) {
    pushToGitHubBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!_state.repoFullName) return;
      pushToGitHubBtn.disabled = true;
      pushToGitHubBtn.textContent = 'Pushing…';
      try {
        const created = await createIssue(_state.repoFullName, { title: issue.title, body: issue.body });
        window.dispatchEvent(new CustomEvent('pnx:promote-local-issue', {
          detail: { localId: issue._localId, localNum: issue.number, githubIssue: created },
        }));
      } catch (err) {
        _showToast(`Failed to push: ${err.userMessage || err.message}`);
        pushToGitHubBtn.disabled = false;
        pushToGitHubBtn.textContent = 'Push to GitHub';
      }
    });
  }

  // Action button (implement or refine)
  const actionBtn = card.querySelector('[data-action]');
  if (actionBtn) {
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (actionBtn.dataset.action === 'refine') refine(issue);
      else _state.onImplement(issue);
    });
  }

  // Logs → link
  const logsBtn = card.querySelector('[data-open-logs]');
  if (logsBtn) {
    logsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _state.onOpenDrawer(issue, 'logs');
    });
  }

  // Stop button
  const stopBtn = card.querySelector('[data-stop-run]');
  if (stopBtn) {
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelRun(issue.number);
    });
  }

  // Push & PR button
  const pushBtn = card.querySelector('[data-push-run]');
  if (pushBtn) {
    pushBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      pushBtn.disabled = true;
      pushBtn.textContent = 'Pushing…';
      await pushRun(issue.number);
    });
  }

  // Open in editor button (run bar — existing worktree path)
  const editorBtn = card.querySelector('[data-open-editor]');
  if (editorBtn) {
    editorBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const editor = getCodeEditor();
      await fetch(`${AGENT_BASE}/open-editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: editorBtn.dataset.openEditor, cmd: editor.cmd }),
      });
    });
  }

  // Open in editor button (card header — create worktree on demand)
  const cardEditorBtn = card.querySelector('[data-open-editor-card]');
  if (cardEditorBtn) {
    const iconEl = cardEditorBtn.querySelector('[data-editor-icon]');
    cardEditorBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const run = runStore.get(issue.number);
      const editor = getCodeEditor();

      // Show spinner
      cardEditorBtn.style.pointerEvents = 'none';
      cardEditorBtn.style.background = '#dae2ff';
      cardEditorBtn.style.color = '#003d9b';
      iconEl.textContent = 'autorenew';
      iconEl.classList.add('animate-spin');

      const reset = () => {
        cardEditorBtn.style.pointerEvents = '';
        cardEditorBtn.style.background = '#e8ecf5';
        cardEditorBtn.style.color = '#434654';
        iconEl.textContent = 'code';
        iconEl.classList.remove('animate-spin');
      };

      try {
        if (run?.worktreePath) {
          await fetch(`${AGENT_BASE}/open-editor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: run.worktreePath, cmd: editor.cmd }),
          });
        } else {
          await fetch(`${AGENT_BASE}/worktree`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              issue_number: issue.number,
              repo_full_name: _state.repoFullName,
              editor_cmd: editor.cmd,
            }),
          });
        }
      } finally {
        reset();
      }
    });
  }

  return card;
}

function _renderDupBadge(topDup, total) {
  const pct = Math.round(topDup.similarity * 100);
  const extra = total > 1 ? ` +${total - 1}` : '';
  return `
    <div class="flex items-center gap-1.5 mt-2 px-2 py-1 rounded" style="background:#fef3c7">
      <span class="material-symbols-outlined shrink-0" style="font-size:12px;color:#b45309">warning</span>
      <span class="text-[10px] font-semibold" style="color:#92400e">Possible duplicate</span>
      <span class="text-[10px] font-bold px-1 rounded" style="background:#fde68a;color:#78350f">${pct}%</span>
      <span class="text-[10px] ml-auto font-mono" style="color:#b45309">#${topDup.number}${extra}</span>
    </div>`;
}

function _renderRunBar(run, colId, issue) {
  // Local (board-only) issues: show "Push to GitHub" regardless of column
  if (issue?._local) {
    const sep = 'border-top:1px solid rgba(195,198,214,0.3)';
    return `
      <div class="mt-2 pt-2" style="${sep}">
        <button data-push-to-github
          class="flex items-center justify-center gap-1.5 w-full text-xs font-semibold py-1.5 rounded-lg transition-all active:scale-95"
          style="background:#fef3c7;color:#b45309;border:1px solid #fcd34d">
          <span class="material-symbols-outlined" style="font-size:14px">cloud_upload</span>
          Push to GitHub
        </button>
      </div>`;
  }

  const action = getLaneAction(colId);
  if (!action) return ''; // in_review, done — no button

  const sep = 'border-top:1px solid rgba(195,198,214,0.3)';

  // ── Idle ─────────────────────────────────────────────────
  if (!run || run.status === 'idle') {
    return `
      <div class="mt-2 pt-2" style="${sep}">
        <button data-action="${action.type}"
          class="flex items-center justify-center gap-1.5 w-full text-xs font-semibold text-on-primary py-1.5 rounded-lg transition-all active:scale-95"
          style="background:${action.gradient}">
          <span class="material-symbols-outlined" style="font-size:14px">${action.icon}</span>
          ${action.label}
        </button>
      </div>`;
  }

  // ── Needs Review (HITL) ───────────────────────────────────
  if (run.status === 'needs_review') {
    return `
      <div class="mt-2 pt-2" style="${sep}">
        <div class="flex items-center gap-1.5 rounded-lg px-2 py-1.5" style="background:#f5f3ff">
          <span class="material-symbols-outlined shrink-0" style="font-size:13px;color:#7c3aed">upload</span>
          <span class="text-[10px] font-semibold" style="color:#6d28d9">Ready to push</span>
          <button data-push-run class="ml-auto flex items-center gap-0.5 text-[10px] font-semibold shrink-0 px-2 py-0.5 rounded-lg"
            style="background:#7c3aed;color:#fff" onclick="event.stopPropagation()">
            <span class="material-symbols-outlined" style="font-size:11px">upload</span>Push & PR
          </button>
        </div>
      </div>`;
  }

  // ── Running ───────────────────────────────────────────────
  if (run.status === 'running') {
    return `
      <div class="mt-2 pt-2" style="${sep}">
        <div class="flex items-center gap-1.5 rounded-lg px-2 py-1.5" style="background:#eff6ff">
          <span class="material-symbols-outlined animate-spin shrink-0" style="font-size:13px;color:#003d9b">autorenew</span>
          <span class="text-[10px] font-semibold shrink-0" style="color:#003d9b">${run.actionType === 'refine' ? 'Improving' : 'Running'}</span>
          <span class="text-[10px] text-on-surface-variant/70 truncate flex-1">${escHtml(run.step)}</span>
          ${
            run.worktreePath
              ? `<button data-open-editor="${escHtml(run.worktreePath)}"
            class="flex items-center gap-0.5 text-[10px] font-semibold shrink-0 px-1.5 py-0.5 rounded"
            style="color:#003d9b;border:1px solid #bfdbfe" onclick="event.stopPropagation()" title="Open worktree in editor">
            <span class="material-symbols-outlined" style="font-size:12px">code</span>Open
          </button>`
              : ''
          }
          <button data-open-logs class="text-[10px] font-semibold shrink-0 hover:underline"
            style="color:#003d9b" onclick="event.stopPropagation()">Logs →</button>
          <button data-stop-run class="flex items-center shrink-0 ml-1"
            style="color:#ba1a1a" onclick="event.stopPropagation()" title="Stop">
            <span class="material-symbols-outlined" style="font-size:15px">stop_circle</span>
          </button>
        </div>
      </div>`;
  }

  // ── Done (refine only) → show the implement button as if idle ─
  if (run.status === 'done' && run.actionType === 'refine') {
    return `
      <div class="mt-2 pt-2" style="${sep}">
        <button data-action="${action.type}"
          class="flex items-center justify-center gap-1.5 w-full text-xs font-semibold text-on-primary py-1.5 rounded-lg transition-all active:scale-95"
          style="background:${action.gradient}">
          <span class="material-symbols-outlined" style="font-size:14px">${action.icon}</span>
          ${action.label}
        </button>
      </div>`;
  }

  // ── Done (implement) ──────────────────────────────────────────
  if (run.status === 'done') {
    return `
      <div class="mt-2 pt-2" style="${sep}">
        <div class="flex items-center gap-1.5 rounded-lg px-2 py-1.5 mb-1.5" style="background:#f0fdf4">
          <span class="material-symbols-outlined shrink-0" style="font-size:13px;color:#1a7a4a;font-variation-settings:'FILL' 1">check_circle</span>
          <span class="text-[10px] font-semibold" style="color:#1a7a4a">${run.prUrl ? 'PR opened' : 'Done'}</span>
          ${
            run.worktreePath
              ? `<button data-open-editor="${escHtml(run.worktreePath)}"
            class="flex items-center gap-0.5 text-[10px] font-semibold shrink-0 px-1.5 py-0.5 rounded"
            style="color:#1a7a4a;border:1px solid #bbf7d0" onclick="event.stopPropagation()" title="Open worktree in editor">
            <span class="material-symbols-outlined" style="font-size:12px">code</span>Open
          </button>`
              : ''
          }
          ${
            run.prUrl
              ? `<a href="${escHtml(run.prUrl)}" target="_blank" rel="noopener"
              class="ml-auto text-[10px] font-semibold hover:underline shrink-0"
              style="color:#1a7a4a" onclick="event.stopPropagation()">View PR →</a>`
              : ''
          }
        </div>
        <button data-action="${action.type}"
          class="flex items-center justify-center gap-1.5 w-full text-xs font-semibold text-on-primary py-1.5 rounded-lg transition-all active:scale-95"
          style="background:${action.gradient}">
          <span class="material-symbols-outlined" style="font-size:14px">${action.icon}</span>
          ${action.label}
        </button>
      </div>`;
  }

  // ── Failed ────────────────────────────────────────────────
  return `
    <div class="mt-2 pt-2" style="${sep}">
      <div class="flex items-center gap-1.5 rounded-lg px-2 py-1.5" style="background:#fef2f2">
        <span class="material-symbols-outlined shrink-0" style="font-size:13px;color:#ba1a1a">error_outline</span>
        <span class="text-[10px] truncate flex-1" style="color:#ba1a1a" title="${escHtml(run.step)}">${escHtml(run.step)}</span>
        <button data-action="${action.type}"
          class="text-[10px] font-semibold shrink-0 px-2 py-0.5 rounded transition-colors"
          style="color:#ba1a1a;border:1px solid #fca5a5"
          onclick="event.stopPropagation()">Retry</button>
      </div>
    </div>`;
}

function moveCard(num, from, to, getFilters) {
  const list = _state.columns[from].issues;
  const idx = list.findIndex((i) => i.number === num);
  if (idx === -1) return;
  _state.columns[to].issues.unshift(list.splice(idx, 1)[0]);
  renderBoard(getFilters);
  // Persist card lane override so position survives restart
  if (_state.repoFullName) _saveCardLane(_state.repoFullName, num, to);
  // Log movement to SQLite (fire-and-forget)
  if (_state.repoFullName) {
    fetch(`${AGENT_BASE}/movements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: _state.repoFullName,
        issue_number: num,
        from_column: from,
        to_column: to,
      }),
    }).catch(() => {});
  }
}

export function applyFilters(issues, { search, label, assignee }) {
  return issues.filter((i) => {
    if (search && !i.title.toLowerCase().includes(search) && !String(i.number).includes(search))
      return false;
    if (label && !(i.labels || []).some((l) => l.name === label)) return false;
    if (assignee && !(i.assignees || []).some((a) => a.login === assignee)) return false;
    return true;
  });
}
