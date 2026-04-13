/**
 * AgentRail — Preact island
 *
 * Replaces agent-rail.js + AgentRail.astro shell.
 * Subscribes to runsSignal / logsSignal / agentsSignal from signals.js
 * so it re-renders automatically on any agent run update.
 */
import { useState } from 'preact/hooks';
import {
  runsSignal,
  logsSignal,
  agentsSignal,
  railOpenSignal,
  runHistoryOpenSignal,
  clearHistory,
} from '../../lib/signals.js';

// ── Config ────────────────────────────────────────────────────────────────────

const STATUS_CFG: Record<string, { color: string; bg: string; border: string; label: string }> = {
  running: { color: '#16a34a', bg: '#f0fdf4', border: 'rgba(22,163,74,0.15)', label: 'Running' },
  done: { color: '#1d4ed8', bg: '#eff6ff', border: 'rgba(29,78,216,0.15)', label: 'Done' },
  needs_review: { color: '#b45309', bg: '#fffbeb', border: 'rgba(180,83,9,0.15)', label: 'Review' },
  failed: { color: '#ba1a1a', bg: '#fff8f7', border: 'rgba(186,26,26,0.15)', label: 'Failed' },
  idle: { color: '#737885', bg: '#f9f9fb', border: 'rgba(195,198,214,0.25)', label: 'Idle' },
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

const STATUS_ICON: Record<string, string> = {
  running: 'radio_button_checked',
  done: 'check_circle',
  failed: 'cancel',
  needs_review: 'rate_review',
};

function scfg(status: string) {
  return STATUS_CFG[status] ?? STATUS_CFG.idle;
}

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

interface Agent {
  name: string;
  description?: string;
  lanes?: string[];
  actionType?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AgentRail() {
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set());

  // Reading .value in render body auto-subscribes this component to each signal.
  const isOpen = railOpenSignal.value;
  const runs = runsSignal.value as Map<number, Run>;
  const logs = logsSignal.value as Map<number, LogEntry[]>;
  const agents = agentsSignal.value as Agent[];

  if (!isOpen) return null;

  const runningTypes = new Set(
    [...runs.values()].filter((r) => r.status === 'running').map((r) => r.actionType)
  );
  const active = agents.filter((a) => runningTypes.has(a.actionType));
  const idle = agents.filter((a) => !runningTypes.has(a.actionType));

  const sortedRuns = [...runs.entries()].sort(([aN], [bN]) => {
    const aTs = (logs.get(aN) ?? []).at(-1)?.ts ?? 0;
    const bTs = (logs.get(bN) ?? []).at(-1)?.ts ?? 0;
    return bTs - aTs || bN - aN;
  });

  function toggleExpand(n: number) {
    const next = new Set(expandedRuns);
    next.has(n) ? next.delete(n) : next.add(n);
    setExpandedRuns(next);
  }

  return (
    <div
      class="fixed right-0 z-40 flex flex-col bg-surface-container-lowest"
      style="top:48px;bottom:0;width:288px;border-left:1px solid rgba(195,198,214,0.25);box-shadow:-4px 0 16px rgba(0,0,0,0.06)"
    >
      {/* ── Header ── */}
      <div
        class="flex items-center justify-between px-4 h-11 flex-shrink-0"
        style="border-bottom:1px solid rgba(195,198,214,0.2)"
      >
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined" style="font-size:15px;color:#003d9b">
            hub
          </span>
          <p class="text-sm font-bold text-on-surface">Agent Rail</p>
        </div>
        <button
          onClick={() => {
            railOpenSignal.value = false;
          }}
          class="text-on-surface-variant hover:text-on-surface transition-colors p-1 rounded"
        >
          <span class="material-symbols-outlined" style="font-size:16px">
            close
          </span>
        </button>
      </div>

      {/* ── Scrollable content ── */}
      <div
        class="flex-1 overflow-y-auto px-3 py-4"
        style="scrollbar-width:thin;scrollbar-color:#c3c6d6 transparent"
      >
        <p class="text-[10px] font-bold uppercase tracking-widest text-outline mb-3 px-1">Agents</p>

        {/* Active */}
        <p class="text-[9px] font-bold uppercase tracking-widest mb-2 px-1" style="color:#16a34a">
          Active
        </p>
        <div class="space-y-2 mb-5">
          {active.length === 0 ? (
            <p class="text-[10px] text-on-surface-variant/50 px-1 pb-1">No active agents</p>
          ) : (
            active.map((a) => (
              <div
                key={a.name}
                class="flex items-center gap-2.5 px-3 py-2.5 rounded-lg"
                style="background:#f0fdf4;border:1px solid rgba(22,163,74,0.15)"
              >
                <div
                  class="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                  style="background:#dcfce7"
                >
                  <span class="material-symbols-outlined" style="font-size:13px;color:#16a34a">
                    smart_toy
                  </span>
                </div>
                <div class="min-w-0">
                  <p class="text-[11px] font-bold text-on-surface truncate">{a.name}</p>
                  <p class="text-[9px] text-on-surface-variant/60 truncate">
                    {a.description || a.lanes?.join(', ') || ''}
                  </p>
                </div>
                <span
                  class="shrink-0 w-1.5 h-1.5 rounded-full ml-auto"
                  style="background:#16a34a"
                />
              </div>
            ))
          )}
        </div>

        {/* Idle */}
        <p class="text-[9px] font-bold uppercase tracking-widest mb-2 px-1" style="color:#737885">
          Idle
        </p>
        <div class="space-y-1.5 mb-5">
          {idle.length === 0 ? (
            <p class="text-[10px] text-on-surface-variant/50 px-1 pb-1">No idle agents</p>
          ) : (
            idle.map((a) => (
              <div
                key={a.name}
                class="flex items-center gap-2.5 px-3 py-2 rounded-lg"
                style="background:#f9f9fb;border:1px solid rgba(195,198,214,0.25)"
              >
                <div
                  class="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                  style="background:#e1e2e4"
                >
                  <span class="material-symbols-outlined" style="font-size:12px;color:#737885">
                    smart_toy
                  </span>
                </div>
                <p class="text-[11px] font-semibold text-on-surface-variant truncate">{a.name}</p>
                <span
                  class="shrink-0 w-1.5 h-1.5 rounded-full ml-auto"
                  style="background:#c3c6d6"
                />
              </div>
            ))
          )}
        </div>

        {/* Paused */}
        <p class="text-[9px] font-bold uppercase tracking-widest mb-2 px-1" style="color:#b45309">
          Paused
        </p>
        <div class="space-y-1.5 mb-6">
          <p class="text-[10px] text-on-surface-variant/50 px-1 pb-1">No paused agents</p>
        </div>

        {/* Run history */}
        <div class="flex items-center justify-between mb-2 px-1">
          <p class="text-[10px] font-bold uppercase tracking-widest text-outline">Run History</p>
          <div class="flex items-center gap-2.5">
            <button
              onClick={() => {
                runHistoryOpenSignal.value = true;
              }}
              class="text-[9px] font-semibold transition-colors"
              style="color:#003d9b"
            >
              View all
            </button>
            <button
              onClick={clearHistory}
              class="text-[9px] font-semibold text-on-surface-variant/50 hover:text-error transition-colors"
            >
              Clear
            </button>
          </div>
        </div>

        <div class="space-y-1.5">
          {sortedRuns.length === 0 ? (
            <p class="text-[10px] text-on-surface-variant/50 px-1 pb-1">No runs yet</p>
          ) : (
            sortedRuns.map(([n, run]) => {
              const c = scfg(run.status);
              const runLogs = logs.get(n) ?? [];
              const isExp = expandedRuns.has(n);
              const actionLabel = run.actionType
                ? run.actionType.charAt(0).toUpperCase() + run.actionType.slice(1)
                : 'Run';
              const statusIcon = STATUS_ICON[run.status] ?? 'circle';

              return (
                <div
                  key={n}
                  class="rounded-lg overflow-hidden"
                  style={`background:${c.bg};border:1px solid ${c.border}`}
                >
                  {/* Row */}
                  <button
                    class="w-full flex items-center gap-2 px-2.5 py-2 text-left"
                    onClick={() => toggleExpand(n)}
                  >
                    <span
                      class="material-symbols-outlined shrink-0"
                      style={`font-size:12px;color:${c.color}`}
                    >
                      {statusIcon}
                    </span>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-1.5">
                        <p class="text-[11px] font-bold text-on-surface">Issue #{n}</p>
                        <span
                          class="text-[8px] font-semibold px-1 py-px rounded"
                          style={`background:${c.color}22;color:${c.color}`}
                        >
                          {c.label}
                        </span>
                        <span class="text-[8px] text-on-surface-variant/50">{actionLabel}</span>
                      </div>
                      <p class="text-[9px] text-on-surface-variant/60 truncate mt-0.5">
                        {run.step ?? ''}
                      </p>
                    </div>
                    <span
                      class="material-symbols-outlined shrink-0"
                      style="font-size:12px;color:#737885"
                    >
                      {isExp ? 'expand_less' : 'expand_more'}
                    </span>
                  </button>

                  {/* PR link */}
                  {run.prUrl && (
                    <div class="px-2.5 pb-2">
                      <a
                        href={run.prUrl}
                        target="_blank"
                        rel="noopener"
                        class="inline-flex items-center gap-1 text-[9px] font-semibold hover:underline"
                        style="color:#1d4ed8"
                      >
                        <span class="material-symbols-outlined" style="font-size:10px">
                          open_in_new
                        </span>
                        View PR
                      </a>
                    </div>
                  )}

                  {/* Expanded logs */}
                  {isExp && (
                    <div
                      class="mx-2 mb-2 rounded-md overflow-hidden"
                      style="background:#f4f4f7;border:1px solid rgba(195,198,214,0.3)"
                    >
                      <div
                        class="px-2 py-1.5 max-h-48 overflow-y-auto"
                        style="scrollbar-width:thin;scrollbar-color:#c3c6d6 transparent"
                      >
                        {runLogs.length === 0 ? (
                          <p class="text-[9px] text-on-surface-variant/40 py-1">No log entries</p>
                        ) : (
                          runLogs.map((entry, i) => {
                            const li = LOG_ICON[entry.type] ?? { icon: 'info', color: '#737885' };
                            const time = entry.ts
                              ? new Date(entry.ts).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                })
                              : '';
                            const msg = (entry.message ?? '').slice(0, 300);
                            return (
                              <div key={i} class="flex gap-1.5 py-0.5">
                                <span
                                  class="material-symbols-outlined shrink-0 mt-0.5"
                                  style={`font-size:10px;color:${li.color}`}
                                >
                                  {li.icon}
                                </span>
                                <div class="min-w-0 flex-1">
                                  <p
                                    class="text-[9px] leading-relaxed break-words"
                                    style="color:#444"
                                  >
                                    {msg}
                                  </p>
                                  {time && (
                                    <p class="text-[8px] mt-0.5" style="color:#aaa">
                                      {time}
                                    </p>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── Footer ── */}
      <div class="px-3 py-3 flex-shrink-0" style="border-top:1px solid rgba(195,198,214,0.2)">
        <button
          class="w-full text-xs font-semibold py-2.5 rounded-lg flex items-center justify-center gap-2 transition-opacity hover:opacity-80"
          style="background:#ffdad6;color:#ba1a1a"
        >
          <span class="material-symbols-outlined" style="font-size:14px">
            stop_circle
          </span>
          Stop all agents
        </button>
      </div>
    </div>
  );
}
