/**
 * RunHistoryPanel — Preact island
 *
 * Replaces run-history-panel.js + RunHistoryPanel.astro shell.
 * Full-screen overlay with filterable run list + detail pane.
 */
import { useState } from 'preact/hooks';
import { runsSignal, logsSignal, runHistoryOpenSignal, clearHistory } from '../../lib/signals.js';

// ── Config ────────────────────────────────────────────────────────────────────

const STATUS_CFG: Record<string, { color: string; bg: string; border: string; label: string }> = {
  running: { color: '#16a34a', bg: '#f0fdf4', border: 'rgba(22,163,74,0.15)', label: 'Running' },
  done: { color: '#1d4ed8', bg: '#eff6ff', border: 'rgba(29,78,216,0.15)', label: 'Done' },
  needs_review: { color: '#b45309', bg: '#fffbeb', border: 'rgba(180,83,9,0.15)', label: 'Review' },
  failed: { color: '#ba1a1a', bg: '#fff8f7', border: 'rgba(186,26,26,0.15)', label: 'Failed' },
  idle: { color: '#737885', bg: '#f9f9fb', border: 'rgba(195,198,214,0.25)', label: 'Idle' },
};

const STATUS_ICON: Record<string, string> = {
  running: 'radio_button_checked',
  done: 'check_circle',
  needs_review: 'rate_review',
  failed: 'cancel',
};

const LOG_ICON: Record<string, { icon: string; color: string }> = {
  progress: { icon: 'arrow_forward', color: '#1d4ed8' },
  thinking: { icon: 'psychology', color: '#7c3aed' },
  reasoning: { icon: 'psychology', color: '#7c3aed' },
  tool_call: { icon: 'build', color: '#b45309' },
  done: { icon: 'check_circle', color: '#16a34a' },
  error: { icon: 'error', color: '#ba1a1a' },
  delegation: { icon: 'group', color: '#0891b2' },
};

const STATUS_ORDER = ['running', 'needs_review', 'failed', 'done', 'idle'];

type SortOrder = 'newest' | 'oldest' | 'status';
type Filter = 'all' | 'running' | 'done' | 'needs_review' | 'failed';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Run {
  status: string;
  step?: string;
  prUrl?: string | null;
  actionType?: string;
}

interface LogEntry {
  type: string;
  message?: string;
  ts?: number;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FilterBtn({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: Filter;
  active: boolean;
  onClick: (v: Filter) => void;
}) {
  return (
    <button
      onClick={() => onClick(value)}
      style={
        active
          ? 'font-size:11px;font-weight:600;padding:4px 10px;border-radius:7px;color:#003d9b;background:rgba(0,61,155,0.1);border:1.5px solid rgba(0,61,155,0.2);cursor:pointer;transition:all 0.12s'
          : 'font-size:11px;font-weight:600;padding:4px 10px;border-radius:7px;color:#737685;background:#f3f4f6;border:1.5px solid transparent;cursor:pointer;transition:all 0.12s'
      }
    >
      {label}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RunHistoryPanel() {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);

  // Signal subscriptions — auto re-render on change
  const isOpen = runHistoryOpenSignal.value;
  const runs = runsSignal.value as Map<number, Run>;
  const logs = logsSignal.value as Map<number, LogEntry[]>;

  if (!isOpen) return null;

  // ── Stats ──────────────────────────────────────────────────────────────────
  const counts = { running: 0, done: 0, needs_review: 0, failed: 0 };
  for (const [, r] of runs) {
    if (r.status in counts) counts[r.status as keyof typeof counts]++;
  }

  // ── Sorted + filtered entries ──────────────────────────────────────────────
  function lastTs(n: number) {
    return (logs.get(n) ?? []).at(-1)?.ts ?? 0;
  }

  let entries = [...runs.entries()];
  if (filter !== 'all') entries = entries.filter(([, r]) => r.status === filter);
  if (search) {
    const q = search.toLowerCase();
    entries = entries.filter(
      ([n, r]) => String(n).includes(q) || (r.step ?? '').toLowerCase().includes(q)
    );
  }
  if (sortOrder === 'newest') entries.sort(([a], [b]) => lastTs(b) - lastTs(a) || b - a);
  if (sortOrder === 'oldest') entries.sort(([a], [b]) => lastTs(a) - lastTs(b) || a - b);
  if (sortOrder === 'status')
    entries.sort(([, a], [, b]) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

  function close() {
    runHistoryOpenSignal.value = false;
    setSelectedIssue(null);
  }

  function handleClear() {
    clearHistory();
    setSelectedIssue(null);
  }

  // ── Selected run detail ────────────────────────────────────────────────────
  const detailRun = selectedIssue !== null ? runs.get(selectedIssue) : null;
  const detailLogs = selectedIssue !== null ? (logs.get(selectedIssue) ?? []) : [];

  return (
    <div class="fixed inset-0 z-50 flex flex-col bg-surface overflow-hidden">
      {/* ── Top bar ── */}
      <header
        class="flex items-center justify-between px-6 flex-shrink-0"
        style="background:#fff;border-bottom:1px solid rgba(195,198,214,0.2);height:52px"
      >
        <div class="flex items-center gap-3">
          <button
            onClick={close}
            class="flex items-center gap-1.5 text-[13px] font-medium transition-colors"
            style="color:#6b7280"
          >
            <span class="material-symbols-outlined" style="font-size:15px">
              arrow_back
            </span>
            Board
          </button>
          <span class="select-none text-[11px]" style="color:rgba(195,198,214,0.7)">
            |
          </span>
          <div class="flex items-center gap-2">
            <div
              class="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
              style="background:#003d9b"
            >
              <span class="material-symbols-outlined" style="font-size:14px;color:#fff">
                history
              </span>
            </div>
            <h1 class="text-[13px] font-bold" style="color:#191c1e">
              Run History
            </h1>
          </div>
        </div>

        <div class="flex items-center gap-3">
          {/* Stats */}
          <div class="flex items-center gap-3">
            {[
              { label: 'Total', value: runs.size, color: '#434654' },
              { label: 'Running', value: counts.running, color: '#16a34a' },
              { label: 'Done', value: counts.done, color: '#1d4ed8' },
              { label: 'Review', value: counts.needs_review, color: '#b45309' },
              { label: 'Failed', value: counts.failed, color: '#ba1a1a' },
            ].map((it, i, arr) => (
              <>
                <div key={it.label} class="flex items-center gap-1.5">
                  <span class="text-[18px] font-bold leading-none" style={`color:${it.color}`}>
                    {it.value}
                  </span>
                  <span
                    class="text-[10px] font-semibold uppercase tracking-wide"
                    style="color:#a0a3b0"
                  >
                    {it.label}
                  </span>
                </div>
                {i < arr.length - 1 && (
                  <span style="color:rgba(195,198,214,0.5);font-size:12px">·</span>
                )}
              </>
            ))}
          </div>

          <button
            onClick={handleClear}
            class="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-all"
            style="color:#ba1a1a;background:rgba(186,26,26,0.07)"
          >
            <span class="material-symbols-outlined" style="font-size:13px">
              delete_sweep
            </span>
            Clear all
          </button>
        </div>
      </header>

      {/* ── Toolbar: search + filters + sort ── */}
      <div
        class="flex items-center gap-3 px-6 py-3 flex-shrink-0"
        style="background:#fafafa;border-bottom:1px solid rgba(195,198,214,0.15)"
      >
        <div class="relative flex-1 max-w-xs">
          <span
            class="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style="font-size:14px;color:#a0a3b0"
          >
            search
          </span>
          <input
            type="text"
            placeholder="Search by issue # or step…"
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value.trim())}
            class="w-full text-[12px] pl-8 pr-3 py-1.5 rounded-lg focus:outline-none"
            style="background:#fff;border:1.5px solid rgba(195,198,214,0.4);color:#191c1e"
          />
        </div>

        <div class="flex items-center gap-1.5">
          {(['all', 'running', 'done', 'needs_review', 'failed'] as Filter[]).map((f) => (
            <FilterBtn
              key={f}
              label={f === 'needs_review' ? 'Review' : f.charAt(0).toUpperCase() + f.slice(1)}
              value={f}
              active={filter === f}
              onClick={setFilter}
            />
          ))}
        </div>

        <select
          value={sortOrder}
          onChange={(e) => setSortOrder((e.target as HTMLSelectElement).value as SortOrder)}
          class="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg focus:outline-none cursor-pointer ml-auto"
          style="background:#fff;border:1.5px solid rgba(195,198,214,0.4);color:#434654"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="status">By status</option>
        </select>
      </div>

      {/* ── Body ── */}
      <div class="flex flex-1 overflow-hidden">
        {/* Run list */}
        <div
          class="flex-1 overflow-y-auto px-6 py-5"
          style="scrollbar-width:thin;scrollbar-color:#c3c6d6 transparent"
        >
          <div class="space-y-3 max-w-3xl mx-auto">
            {runs.size === 0 ? (
              <div class="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <div
                  class="w-12 h-12 rounded-xl flex items-center justify-center"
                  style="background:#edeef0"
                >
                  <span class="material-symbols-outlined" style="font-size:24px;color:#a0a3b0">
                    history
                  </span>
                </div>
                <p class="text-[13px] font-semibold" style="color:#434654">
                  No runs yet
                </p>
                <p class="text-[11px]" style="color:#a0a3b0">
                  Agent runs will appear here once started.
                </p>
              </div>
            ) : entries.length === 0 ? (
              <div class="flex flex-col items-center justify-center py-16 gap-2 text-center">
                <span class="material-symbols-outlined" style="font-size:28px;color:#c3c6d6">
                  search_off
                </span>
                <p class="text-[12px] font-medium" style="color:#a0a3b0">
                  No runs match your filters.
                </p>
              </div>
            ) : (
              entries.map(([n, run]) => {
                const c = STATUS_CFG[run.status] ?? STATUS_CFG.idle;
                const icon = STATUS_ICON[run.status] ?? 'circle';
                const actionLabel = run.actionType
                  ? run.actionType.charAt(0).toUpperCase() + run.actionType.slice(1)
                  : 'Run';
                const runLogs = logs.get(n) ?? [];
                const lastLog = runLogs.at(-1);
                const timeStr = lastLog?.ts
                  ? new Date(lastLog.ts).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : '';
                const isSelected = selectedIssue === n;

                return (
                  <div
                    key={n}
                    class="rounded-xl overflow-hidden cursor-pointer transition-all"
                    style={`background:${c.bg};border:1.5px solid ${isSelected ? c.color : c.border}`}
                    onClick={() => setSelectedIssue(n)}
                  >
                    <div class="flex items-start gap-3 px-4 py-3.5">
                      <span
                        class="material-symbols-outlined mt-0.5 flex-shrink-0"
                        style={`font-size:16px;color:${c.color}`}
                      >
                        {icon}
                      </span>
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2 flex-wrap">
                          <p class="text-[13px] font-bold text-on-surface">Issue #{n}</p>
                          <span
                            class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                            style={`background:${c.color}22;color:${c.color}`}
                          >
                            {c.label}
                          </span>
                          <span
                            class="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                            style="background:rgba(195,198,214,0.25);color:#737885"
                          >
                            {actionLabel}
                          </span>
                          {timeStr && (
                            <span class="text-[10px] ml-auto" style="color:#a0a3b0">
                              {timeStr}
                            </span>
                          )}
                        </div>
                        <p class="text-[11px] mt-1 text-on-surface-variant/70 line-clamp-2">
                          {run.step ?? ''}
                        </p>
                        <div class="flex items-center gap-3 mt-2">
                          <span class="text-[10px]" style="color:#a0a3b0">
                            {runLogs.length} log{runLogs.length !== 1 ? 's' : ''}
                          </span>
                          {run.prUrl && (
                            <a
                              href={run.prUrl}
                              target="_blank"
                              rel="noopener"
                              class="inline-flex items-center gap-1 text-[10px] font-semibold hover:underline"
                              style="color:#1d4ed8"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span class="material-symbols-outlined" style="font-size:11px">
                                open_in_new
                              </span>
                              View PR
                            </a>
                          )}
                        </div>
                      </div>
                      <span
                        class="material-symbols-outlined flex-shrink-0 mt-0.5"
                        style="font-size:14px;color:#c3c6d6"
                      >
                        chevron_right
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── Detail pane ── */}
        {selectedIssue !== null && detailRun && (
          <aside
            class="flex flex-col flex-shrink-0 overflow-hidden"
            style="width:360px;border-left:1px solid rgba(195,198,214,0.2);background:#f8f9fb"
          >
            {/* Detail header */}
            <div
              class="flex items-center justify-between px-4 py-3 flex-shrink-0"
              style="border-bottom:1px solid rgba(195,198,214,0.15);background:#fff"
            >
              <p class="text-[12px] font-bold" style="color:#191c1e">
                Run Logs
              </p>
              <button onClick={() => setSelectedIssue(null)} style="color:#a0a3b0">
                <span class="material-symbols-outlined" style="font-size:16px">
                  close
                </span>
              </button>
            </div>

            {/* Detail meta */}
            {(() => {
              const c = STATUS_CFG[detailRun.status] ?? STATUS_CFG.idle;
              const actionLabel = detailRun.actionType
                ? detailRun.actionType.charAt(0).toUpperCase() + detailRun.actionType.slice(1)
                : 'Run';
              return (
                <div
                  class="px-4 py-3 flex-shrink-0"
                  style="border-bottom:1px solid rgba(195,198,214,0.1);background:#fff"
                >
                  <div class="flex items-center gap-2 flex-wrap">
                    <p class="text-[14px] font-bold" style="color:#191c1e">
                      Issue #{selectedIssue}
                    </p>
                    <span
                      class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                      style={`background:${c.color}22;color:${c.color}`}
                    >
                      {c.label}
                    </span>
                    <span
                      class="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                      style="background:rgba(195,198,214,0.25);color:#737885"
                    >
                      {actionLabel}
                    </span>
                  </div>
                  {detailRun.step && (
                    <p class="text-[11px] mt-1.5" style="color:#6b6f80">
                      {detailRun.step}
                    </p>
                  )}
                  {detailRun.prUrl && (
                    <a
                      href={detailRun.prUrl}
                      target="_blank"
                      rel="noopener"
                      class="inline-flex items-center gap-1 mt-2 text-[11px] font-semibold hover:underline"
                      style="color:#1d4ed8"
                    >
                      <span class="material-symbols-outlined" style="font-size:12px">
                        open_in_new
                      </span>
                      View PR
                    </a>
                  )}
                </div>
              );
            })()}

            {/* Log entries */}
            <div
              class="flex-1 overflow-y-auto px-4 py-3 space-y-1"
              style="scrollbar-width:thin;scrollbar-color:#c3c6d6 transparent"
            >
              {detailLogs.length === 0 ? (
                <p class="text-[11px] text-center py-4" style="color:#a0a3b0">
                  No log entries
                </p>
              ) : (
                detailLogs.map((entry, i) => {
                  const li = LOG_ICON[entry.type] ?? { icon: 'info', color: '#737885' };
                  const time = entry.ts
                    ? new Date(entry.ts).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })
                    : '';
                  return (
                    <div key={i} class="flex gap-2 py-1">
                      <span
                        class="material-symbols-outlined shrink-0 mt-0.5"
                        style={`font-size:12px;color:${li.color}`}
                      >
                        {li.icon}
                      </span>
                      <div class="min-w-0 flex-1">
                        <p class="text-[11px] leading-relaxed break-words" style="color:#434654">
                          {entry.message ?? ''}
                        </p>
                        {time && (
                          <p class="text-[10px] mt-0.5" style="color:#c3c6d6">
                            {time}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
