import { escHtml } from '../lib/formatters.js';
import { getAgents } from '../lib/agents.js';
import { runStore, logStore, clearHistory } from '../lib/implementer.js';

const $ = (id) => document.getElementById(id);

const agentRail = $('agent-rail');

// Track which history items have their logs expanded
const _expandedRuns = new Set();

// ── Status config ─────────────────────────────────────────────

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

function _statusCfg(status) {
  return STATUS_CONFIG[status] ?? STATUS_CONFIG.idle;
}

// ── Log rendering ─────────────────────────────────────────────

const LOG_ICON = {
  progress: { icon: 'arrow_forward', color: '#1d4ed8' },
  thinking: { icon: 'psychology', color: '#7c3aed' },
  reasoning: { icon: 'psychology', color: '#7c3aed' },
  tool_call: { icon: 'build', color: '#b45309' },
  done: { icon: 'check_circle', color: '#16a34a' },
  error: { icon: 'error', color: '#ba1a1a' },
  delegation: { icon: 'group', color: '#0891b2' },
};

function _renderLogEntry(entry) {
  const cfg = LOG_ICON[entry.type] ?? { icon: 'info', color: '#737885' };
  const time = entry.ts
    ? new Date(entry.ts).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '';
  const msg = (entry.message ?? '').slice(0, 300);
  return `
    <div class="flex gap-1.5 py-0.5">
      <span class="material-symbols-outlined shrink-0 mt-0.5" style="font-size:10px;color:${cfg.color}">${cfg.icon}</span>
      <div class="min-w-0 flex-1">
        <p class="text-[9px] leading-relaxed break-words" style="color:#444">${escHtml(msg)}</p>
        ${time ? `<p class="text-[8px] mt-0.5" style="color:#aaa">${time}</p>` : ''}
      </div>
    </div>`;
}

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

// ── History rendering ─────────────────────────────────────────

function _renderHistoryItem(issueNumber, run) {
  const cfg = _statusCfg(run.status);
  const logs = logStore.get(issueNumber) ?? [];
  const isExpanded = _expandedRuns.has(issueNumber);
  const actionLabel = run.actionType
    ? run.actionType.charAt(0).toUpperCase() + run.actionType.slice(1)
    : 'Run';

  const logsHtml = isExpanded
    ? `
    <div class="mt-2 rounded-md overflow-hidden" style="background:#f4f4f7;border:1px solid rgba(195,198,214,0.3)">
      <div class="px-2 py-1.5 max-h-48 overflow-y-auto" style="scrollbar-width:thin;scrollbar-color:#c3c6d6 transparent">
        ${
          logs.length === 0
            ? '<p class="text-[9px] text-on-surface-variant/40 py-1">No log entries</p>'
            : logs.map(_renderLogEntry).join('')
        }
      </div>
    </div>`
    : '';

  return `
    <div class="rounded-lg overflow-hidden" style="background:${cfg.bg};border:1px solid ${cfg.border}">
      <button class="rail-history-toggle w-full flex items-center gap-2 px-2.5 py-2 text-left"
              data-issue="${issueNumber}">
        <span class="material-symbols-outlined shrink-0" style="font-size:12px;color:${cfg.color}">
          ${run.status === 'running' ? 'radio_button_checked' : run.status === 'done' ? 'check_circle' : run.status === 'failed' ? 'cancel' : run.status === 'needs_review' ? 'rate_review' : 'circle'}
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <p class="text-[11px] font-bold text-on-surface">Issue #${issueNumber}</p>
            <span class="text-[8px] font-semibold px-1 py-px rounded" style="background:${cfg.color}22;color:${cfg.color}">${escHtml(cfg.label)}</span>
            <span class="text-[8px] text-on-surface-variant/50">${escHtml(actionLabel)}</span>
          </div>
          <p class="text-[9px] text-on-surface-variant/60 truncate mt-0.5">${escHtml(run.step || '')}</p>
          ${run.cost?.estimatedUsd ? `<p class="text-[8px] mt-0.5 font-mono" style="color:#7c3aed">~${_fmtCost(run.cost.estimatedUsd)} · ${_fmtTokens(run.cost.inputTokens + run.cost.outputTokens)} tok</p>` : ''}
        </div>
        <span class="material-symbols-outlined shrink-0" style="font-size:12px;color:#737885">
          ${isExpanded ? 'expand_less' : 'expand_more'}
        </span>
      </button>
      ${
        run.prUrl
          ? `
        <div class="px-2.5 pb-2">
          <a href="${escHtml(run.prUrl)}" target="_blank" rel="noopener"
             class="inline-flex items-center gap-1 text-[9px] font-semibold hover:underline" style="color:#1d4ed8">
            <span class="material-symbols-outlined" style="font-size:10px">open_in_new</span>
            View PR
          </a>
        </div>`
          : ''
      }
      ${logsHtml}
    </div>`;
}

// ── Main render ───────────────────────────────────────────────

export function renderAgentRail() {
  const agents = getAgents();
  const runningTypes = new Set(
    [...runStore.values()].filter((r) => r.status === 'running').map((r) => r.actionType)
  );
  const active = agents.filter((a) => runningTypes.has(a.actionType));
  const idle = agents.filter((a) => !runningTypes.has(a.actionType));

  const $active = $('rail-active-list');
  const $idle = $('rail-idle-list');
  const $paused = $('rail-paused-list');
  const $history = $('rail-history-list');

  if (active.length === 0) {
    $active.innerHTML =
      '<p class="text-[10px] text-on-surface-variant/50 px-1 pb-1">No active agents</p>';
  } else {
    $active.innerHTML = active
      .map(
        (a) => `
      <div class="flex items-center gap-2.5 px-3 py-2.5 rounded-lg" style="background:#f0fdf4;border:1px solid rgba(22,163,74,0.15)">
        <div class="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style="background:#dcfce7">
          <span class="material-symbols-outlined" style="font-size:13px;color:#16a34a">smart_toy</span>
        </div>
        <div class="min-w-0">
          <p class="text-[11px] font-bold text-on-surface truncate">${escHtml(a.name)}</p>
          <p class="text-[9px] text-on-surface-variant/60 truncate">${escHtml(a.description || a.lanes?.join(', ') || '')}</p>
        </div>
        <span class="shrink-0 w-1.5 h-1.5 rounded-full ml-auto" style="background:#16a34a"></span>
      </div>
    `
      )
      .join('');
  }

  if (idle.length === 0) {
    $idle.innerHTML =
      '<p class="text-[10px] text-on-surface-variant/50 px-1 pb-1">No idle agents</p>';
  } else {
    $idle.innerHTML = idle
      .map(
        (a) => `
      <div class="flex items-center gap-2.5 px-3 py-2 rounded-lg" style="background:#f9f9fb;border:1px solid rgba(195,198,214,0.25)">
        <div class="w-6 h-6 rounded-full flex items-center justify-center shrink-0" style="background:#e1e2e4">
          <span class="material-symbols-outlined" style="font-size:12px;color:#737885">smart_toy</span>
        </div>
        <p class="text-[11px] font-semibold text-on-surface-variant truncate">${escHtml(a.name)}</p>
        <span class="shrink-0 w-1.5 h-1.5 rounded-full ml-auto" style="background:#c3c6d6"></span>
      </div>
    `
      )
      .join('');
  }

  $paused.innerHTML =
    '<p class="text-[10px] text-on-surface-variant/50 px-1 pb-1">No paused agents</p>';

  // Run history — sorted by most recent log timestamp, falling back to issue number
  const runs = [...runStore.entries()];
  if (runs.length === 0) {
    $history.innerHTML =
      '<p class="text-[10px] text-on-surface-variant/50 px-1 pb-1">No runs yet</p>';
  } else {
    const sorted = runs.sort(([aNum], [bNum]) => {
      const aLogs = logStore.get(aNum) ?? [];
      const bLogs = logStore.get(bNum) ?? [];
      const aTs = aLogs.at(-1)?.ts ?? 0;
      const bTs = bLogs.at(-1)?.ts ?? 0;
      return bTs - aTs || bNum - aNum;
    });
    $history.innerHTML = sorted.map(([n, run]) => _renderHistoryItem(n, run)).join('');
  }
}

// ── Init ──────────────────────────────────────────────────────

export function initAgentRail() {
  $('agent-rail-btn').addEventListener('click', () => {
    const isHidden = agentRail.classList.contains('hidden');
    if (isHidden) {
      agentRail.classList.remove('hidden');
      renderAgentRail();
      $('agent-rail-btn').classList.add('active');
    } else {
      agentRail.classList.add('hidden');
      $('agent-rail-btn').classList.remove('active');
    }
  });

  $('agent-rail-close').addEventListener('click', () => {
    agentRail.classList.add('hidden');
    $('agent-rail-btn').classList.remove('active');
  });

  $('rail-stop-all').addEventListener('click', () => {
    agentRail.classList.add('hidden');
    $('agent-rail-btn').classList.remove('active');
  });

  $('rail-clear-history').addEventListener('click', () => {
    clearHistory();
    renderAgentRail();
  });

  $('rail-view-all-history').addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('open-run-history-panel'));
  });

  // Toggle log expansion for history items (event delegation)
  $('rail-history-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.rail-history-toggle');
    if (!btn) return;
    const issueNumber = Number(btn.dataset.issue);
    if (_expandedRuns.has(issueNumber)) {
      _expandedRuns.delete(issueNumber);
    } else {
      _expandedRuns.add(issueNumber);
    }
    renderAgentRail();
  });
}
