import { escHtml } from '../lib/formatters.js';
import { runStore, logStore, clearHistory } from '../lib/implementer.js';

const $ = (id) => document.getElementById(id);

const panel = $('run-history-panel');

let _activeFilter = 'all';
let _searchQuery = '';
let _sortOrder = 'newest';
let _selectedIssue = null;

// ── Status config (mirrors agent-rail.js) ─────────────────────

const STATUS_CONFIG = {
  pending: {
    color: '#6b7280',
    bg: '#f9fafb',
    border: 'rgba(107,114,128,0.15)',
    dot: '#9ca3af',
    label: 'Pending',
  },
  running: {
    color: '#16a34a',
    bg: '#f0fdf4',
    border: 'rgba(22,163,74,0.15)',
    dot: '#16a34a',
    label: 'Running',
  },
  done: {
    color: '#1d4ed8',
    bg: '#eff6ff',
    border: 'rgba(29,78,216,0.15)',
    dot: '#1d4ed8',
    label: 'Done',
  },
  needs_review: {
    color: '#b45309',
    bg: '#fffbeb',
    border: 'rgba(180,83,9,0.15)',
    dot: '#d97706',
    label: 'Review',
  },
  failed: {
    color: '#ba1a1a',
    bg: '#fff8f7',
    border: 'rgba(186,26,26,0.15)',
    dot: '#ba1a1a',
    label: 'Failed',
  },
  cancelled: {
    color: '#737885',
    bg: '#f4f4f7',
    border: 'rgba(115,120,133,0.15)',
    dot: '#a0a3b0',
    label: 'Cancelled',
  },
  idle: {
    color: '#737885',
    bg: '#f9f9fb',
    border: 'rgba(195,198,214,0.25)',
    dot: '#c3c6d6',
    label: 'Idle',
  },
};

const STATUS_ICON = {
  pending: 'pending',
  running: 'radio_button_checked',
  done: 'check_circle',
  needs_review: 'rate_review',
  failed: 'cancel',
  cancelled: 'do_not_disturb_on',
};

// ── Cost / token formatting ───────────────────────────────────

function _fmtCost(usd) {
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  if (usd < 0.01)  return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function _fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

const LOG_ICON = {
  progress: { icon: 'arrow_forward', color: '#1d4ed8' },
  thinking: { icon: 'psychology', color: '#7c3aed' },
  reasoning: { icon: 'psychology', color: '#7c3aed' },
  tool_call: { icon: 'build', color: '#b45309' },
  done: { icon: 'check_circle', color: '#16a34a' },
  error: { icon: 'error', color: '#ba1a1a' },
  delegation: { icon: 'group', color: '#0891b2' },
};

function _cfg(status) {
  return STATUS_CONFIG[status] ?? STATUS_CONFIG.idle;
}

function _lastTs(issueNumber) {
  const logs = logStore.get(issueNumber) ?? [];
  return logs.at(-1)?.ts ?? 0;
}

// ── Sorting & filtering ───────────────────────────────────────

function _getSortedFiltered() {
  let entries = [...runStore.entries()];

  // Filter by status
  if (_activeFilter !== 'all') {
    entries = entries.filter(([, run]) => run.status === _activeFilter);
  }

  // Filter by search
  if (_searchQuery) {
    const q = _searchQuery.toLowerCase();
    entries = entries.filter(([num, run]) => {
      return String(num).includes(q) || (run.step ?? '').toLowerCase().includes(q);
    });
  }

  // Sort
  if (_sortOrder === 'newest') {
    entries.sort(([a], [b]) => _lastTs(b) - _lastTs(a) || b - a);
  } else if (_sortOrder === 'oldest') {
    entries.sort(([a], [b]) => _lastTs(a) - _lastTs(b) || a - b);
  } else if (_sortOrder === 'status') {
    const ORDER = ['running', 'needs_review', 'failed', 'done', 'idle'];
    entries.sort(([, a], [, b]) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  }

  return entries;
}

// ── Stats bar ─────────────────────────────────────────────────

function _renderStats() {
  const counts = { running: 0, done: 0, needs_review: 0, failed: 0 };
  for (const [, run] of runStore.entries()) {
    if (counts[run.status] !== undefined) counts[run.status]++;
  }

  const total = runStore.size;
  const sessionCost = [...runStore.values()].reduce((s, r) => s + (r.cost?.estimatedUsd ?? 0), 0);
  const items = [
    { label: 'Total', value: total, color: '#434654' },
    { label: 'Running', value: counts.running, color: '#16a34a' },
    { label: 'Done', value: counts.done, color: '#1d4ed8' },
    { label: 'Review', value: counts.needs_review, color: '#b45309' },
    { label: 'Failed', value: counts.failed, color: '#ba1a1a' },
    ...(sessionCost > 0 ? [{ label: 'Est. Cost', value: _fmtCost(sessionCost), color: '#7c3aed' }] : []),
  ];

  $('run-history-stats').innerHTML = items
    .map(
      (it) => `
    <div class="flex items-center gap-1.5">
      <span class="text-[18px] font-bold leading-none" style="color:${it.color}">${it.value}</span>
      <span class="text-[10px] font-semibold uppercase tracking-wide" style="color:#a0a3b0">${it.label}</span>
    </div>
  `
    )
    .join('<span style="color:rgba(195,198,214,0.5);font-size:12px">·</span>');
}

// ── Run list ──────────────────────────────────────────────────

function _renderRunCard(issueNumber, run) {
  const cfg = _cfg(run.status);
  const icon = STATUS_ICON[run.status] ?? 'circle';
  const actionLabel = run.actionType
    ? run.actionType.charAt(0).toUpperCase() + run.actionType.slice(1)
    : 'Run';
  const logs = logStore.get(issueNumber) ?? [];
  const lastTs = logs.at(-1)?.ts;
  const timeStr = lastTs
    ? new Date(lastTs).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  const isSelected = _selectedIssue === issueNumber;

  return `
    <div class="run-history-card rounded-xl overflow-hidden cursor-pointer transition-all"
         data-issue="${issueNumber}"
         style="background:${cfg.bg};border:1.5px solid ${isSelected ? cfg.color : cfg.border}">
      <div class="flex items-start gap-3 px-4 py-3.5">
        <span class="material-symbols-outlined mt-0.5 flex-shrink-0" style="font-size:16px;color:${cfg.color}">${icon}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <p class="text-[13px] font-bold text-on-surface">Issue #${issueNumber}</p>
            <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
              style="background:${cfg.color}22;color:${cfg.color}">${escHtml(cfg.label)}</span>
            <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
              style="background:rgba(195,198,214,0.25);color:#737885">${escHtml(actionLabel)}</span>
            ${timeStr ? `<span class="text-[10px] ml-auto" style="color:#a0a3b0">${timeStr}</span>` : ''}
          </div>
          <p class="text-[11px] mt-1 text-on-surface-variant/70 line-clamp-2">${escHtml(run.step || '')}</p>
          <div class="flex items-center gap-3 mt-2 flex-wrap">
            <span class="text-[10px]" style="color:#a0a3b0">${logs.length} log${logs.length !== 1 ? 's' : ''}</span>
            ${run.cost?.estimatedUsd ? `<span class="text-[10px] font-mono font-semibold" style="color:#7c3aed">~${_fmtCost(run.cost.estimatedUsd)} · ${_fmtTokens(run.cost.inputTokens + run.cost.outputTokens)} tok</span>` : ''}
            ${
              run.prUrl
                ? `
              <a href="${escHtml(run.prUrl)}" target="_blank" rel="noopener"
                 class="inline-flex items-center gap-1 text-[10px] font-semibold hover:underline" style="color:#1d4ed8">
                <span class="material-symbols-outlined" style="font-size:11px">open_in_new</span>
                View PR
              </a>`
                : ''
            }
          </div>
        </div>
        <span class="material-symbols-outlined flex-shrink-0 mt-0.5" style="font-size:14px;color:#c3c6d6">
          chevron_right
        </span>
      </div>
    </div>`;
}

function _renderList() {
  const $list = $('run-history-list');
  const entries = _getSortedFiltered();

  if (runStore.size === 0) {
    $list.innerHTML = `
      <div class="flex flex-col items-center justify-center py-20 gap-3 text-center">
        <div class="w-12 h-12 rounded-xl flex items-center justify-center" style="background:#edeef0">
          <span class="material-symbols-outlined" style="font-size:24px;color:#a0a3b0">history</span>
        </div>
        <p class="text-[13px] font-semibold" style="color:#434654">No runs yet</p>
        <p class="text-[11px]" style="color:#a0a3b0">Agent runs will appear here once started.</p>
      </div>`;
    return;
  }

  if (entries.length === 0) {
    $list.innerHTML = `
      <div class="flex flex-col items-center justify-center py-16 gap-2 text-center">
        <span class="material-symbols-outlined" style="font-size:28px;color:#c3c6d6">search_off</span>
        <p class="text-[12px] font-medium" style="color:#a0a3b0">No runs match your filters.</p>
      </div>`;
    return;
  }

  $list.innerHTML = entries.map(([n, run]) => _renderRunCard(n, run)).join('');
}

// ── Detail pane ───────────────────────────────────────────────

function _renderDetail(issueNumber) {
  const run = runStore.get(issueNumber);
  const logs = logStore.get(issueNumber) ?? [];
  if (!run) return;

  const cfg = _cfg(run.status);
  const actionLabel = run.actionType
    ? run.actionType.charAt(0).toUpperCase() + run.actionType.slice(1)
    : 'Run';

  $('run-history-detail-meta').innerHTML = `
    <div class="flex items-center gap-2 flex-wrap">
      <p class="text-[14px] font-bold" style="color:#191c1e">Issue #${issueNumber}</p>
      <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
        style="background:${cfg.color}22;color:${cfg.color}">${escHtml(cfg.label)}</span>
      <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
        style="background:rgba(195,198,214,0.25);color:#737885">${escHtml(actionLabel)}</span>
    </div>
    ${run.step ? `<p class="text-[11px] mt-1.5" style="color:#6b6f80">${escHtml(run.step)}</p>` : ''}
    ${
      run.cost?.estimatedUsd
        ? `<div class="flex items-center gap-2 mt-2 px-2 py-1.5 rounded-lg" style="background:#f5f3ff;border:1px solid rgba(124,58,237,0.15)">
            <span class="material-symbols-outlined" style="font-size:13px;color:#7c3aed">toll</span>
            <span class="text-[11px] font-mono font-semibold" style="color:#7c3aed">~${_fmtCost(run.cost.estimatedUsd)}</span>
            <span class="text-[10px]" style="color:#a0a3b0">${_fmtTokens(run.cost.inputTokens)} in · ${_fmtTokens(run.cost.outputTokens)} out</span>
            ${run.cost.model ? `<span class="text-[9px] ml-auto" style="color:#c4b5fd">${escHtml(run.cost.model)}</span>` : ''}
           </div>`
        : ''
    }
    ${
      run.prUrl
        ? `
      <a href="${escHtml(run.prUrl)}" target="_blank" rel="noopener"
         class="inline-flex items-center gap-1 mt-2 text-[11px] font-semibold hover:underline" style="color:#1d4ed8">
        <span class="material-symbols-outlined" style="font-size:12px">open_in_new</span>
        View PR
      </a>`
        : ''
    }
  `;

  $('run-history-detail-logs').innerHTML =
    logs.length === 0
      ? '<p class="text-[11px] text-center py-4" style="color:#a0a3b0">No log entries</p>'
      : logs
          .map((entry) => {
            const lcfg = LOG_ICON[entry.type] ?? { icon: 'info', color: '#737885' };
            const time = entry.ts
              ? new Date(entry.ts).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })
              : '';
            return `
          <div class="flex gap-2 py-1">
            <span class="material-symbols-outlined shrink-0 mt-0.5" style="font-size:12px;color:${lcfg.color}">${lcfg.icon}</span>
            <div class="min-w-0 flex-1">
              <p class="text-[11px] leading-relaxed break-words" style="color:#434654">${escHtml(entry.message ?? '')}</p>
              ${time ? `<p class="text-[10px] mt-0.5" style="color:#c3c6d6">${time}</p>` : ''}
            </div>
          </div>`;
          })
          .join('');

  $('run-history-detail').classList.remove('hidden');
  $('run-history-detail').style.display = 'flex';
}

function _closeDetail() {
  _selectedIssue = null;
  $('run-history-detail').classList.add('hidden');
  $('run-history-detail').style.display = '';
  _renderList();
}

// ── Full render ───────────────────────────────────────────────

function renderRunHistoryPanel() {
  _renderStats();
  _renderList();
  if (_selectedIssue !== null) _renderDetail(_selectedIssue);
}

// ── Open / close ──────────────────────────────────────────────

function openRunHistoryPanel() {
  _selectedIssue = null;
  $('run-history-detail').classList.add('hidden');
  $('run-history-detail').style.display = '';
  panel.classList.remove('hidden');
  panel.style.display = 'flex';
  renderRunHistoryPanel();
}

function closeRunHistoryPanel() {
  panel.classList.add('hidden');
  panel.style.display = '';
}

// ── Init ──────────────────────────────────────────────────────

export function initRunHistoryPanel() {
  $('run-history-panel-close').addEventListener('click', closeRunHistoryPanel);

  $('run-history-clear-all').addEventListener('click', () => {
    clearHistory();
    _selectedIssue = null;
    $('run-history-detail').classList.add('hidden');
    $('run-history-detail').style.display = '';
    renderRunHistoryPanel();
  });

  $('run-history-detail-close').addEventListener('click', _closeDetail);

  $('run-history-search').addEventListener('input', (e) => {
    _searchQuery = e.target.value.trim();
    _renderList();
  });

  $('run-history-sort').addEventListener('change', (e) => {
    _sortOrder = e.target.value;
    _renderList();
  });

  // Status filter buttons
  document.querySelectorAll('.run-history-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.run-history-filter').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      _activeFilter = btn.dataset.filter;
      _renderList();
    });
  });

  // Run card click → show detail
  $('run-history-list').addEventListener('click', (e) => {
    const card = e.target.closest('.run-history-card');
    if (!card) return;
    const num = Number(card.dataset.issue);
    _selectedIssue = num;
    _renderList();
    _renderDetail(num);
  });

  // "View all" button in agent rail
  document.addEventListener('open-run-history-panel', openRunHistoryPanel);
}

export { renderRunHistoryPanel, openRunHistoryPanel };
