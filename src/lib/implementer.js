import { AGENT_BASE_URL as AGENT_BASE } from './config.js';
import { calcRunCost } from './constants.js';
const LOG_STORE_KEY = 'pnx_agent_logs';
const RUN_STORE_KEY = 'pnx_run_store';
const DISMISSED_SUGGESTIONS_KEY = 'pnx_dismissed_suggestions';

/** @type {Map<number, {status:'pending'|'idle'|'running'|'cancelled'|'done'|'failed'|'needs_review', step:string, prUrl:string|null, model:string|null, cost:{inputTokens:number,outputTokens:number,estimatedUsd:number,model:string}|null}>} */
export const runStore = new Map();

/** @type {Map<number, Array<{type:string,message:string,ts:number,tool?:string,path?:string}>>} */
export const logStore = new Map();

/** @type {Map<number, {title:string, description:string, acceptance_criteria:string[]}>} */
export const suggestionStore = new Map();

/** @type {Set<number>} Issue numbers whose AI suggestion has been dismissed */
export const dismissedSuggestions = new Set();

const _listeners = new Set();

// ── Persistence helpers ───────────────────────────────────────

function _persistLogs() {
  try {
    const data = {};
    logStore.forEach((v, k) => {
      data[k] = v;
    });
    localStorage.setItem(LOG_STORE_KEY, JSON.stringify(data));
  } catch {}
}

function _persistRuns() {
  try {
    const data = {};
    runStore.forEach((v, k) => {
      data[k] = v;
    });
    localStorage.setItem(RUN_STORE_KEY, JSON.stringify(data));
  } catch {}
}

function _persistDismissed() {
  try {
    localStorage.setItem(DISMISSED_SUGGESTIONS_KEY, JSON.stringify([...dismissedSuggestions]));
  } catch {}
}

// Load persisted state on startup
(function _loadPersisted() {
  try {
    const rawLogs = localStorage.getItem(LOG_STORE_KEY);
    if (rawLogs) {
      const data = JSON.parse(rawLogs);
      Object.entries(data).forEach(([k, v]) => logStore.set(Number(k), v));
    }
  } catch {}
  try {
    const rawRuns = localStorage.getItem(RUN_STORE_KEY);
    if (rawRuns) {
      const data = JSON.parse(rawRuns);
      Object.entries(data).forEach(([k, v]) => {
        // pending or running at startup means the session was interrupted
        if (v.status === 'running' || v.status === 'pending') {
          v = { ...v, status: 'failed', step: 'Interrupted' };
        }
        runStore.set(Number(k), v);
      });
    }
  } catch {}
  try {
    const rawDismissed = localStorage.getItem(DISMISSED_SUGGESTIONS_KEY);
    if (rawDismissed) {
      JSON.parse(rawDismissed).forEach((n) => dismissedSuggestions.add(Number(n)));
    }
  } catch {}
})();

export function clearHistory() {
  logStore.clear();
  runStore.clear();
  localStorage.removeItem(LOG_STORE_KEY);
  localStorage.removeItem(RUN_STORE_KEY);
  for (const fn of _listeners) fn(null);
}

/**
 * Dismiss the AI suggestion for an issue. Removes it from suggestionStore
 * and persists the dismissed state so it does not reappear after a page reload.
 * @param {number} issueNumber
 */
export function dismissSuggestion(issueNumber) {
  dismissedSuggestions.add(issueNumber);
  suggestionStore.delete(issueNumber);
  _persistDismissed();
  for (const fn of _listeners) fn(issueNumber);
}

/** Active EventSource per issue number — used for cancellation */
const _eventSources = new Map();

/** Active PR-polling timers — poll /status until pr_url appears */
const _prPollers = new Map();

/**
 * Poll /runs/{runId}/status every 8 s until pr_url is set (background PR creation).
 * Stops after 40 attempts (~5 min) and logs an error if still nothing.
 */
function _pollForPr(n, runId, endpoint) {
  if (_prPollers.has(n)) return;
  let attempts = 0;
  const MAX = 40;

  function poll() {
    fetch(`${endpoint}/runs/${runId}/status`)
      .then((r) => r.json())
      .then((status) => {
        attempts++;
        if (status.pr_url) {
          _prPollers.delete(n);
          const cur = runStore.get(n);
          _set(n, { ...cur, status: 'done', step: 'PR opened', prUrl: status.pr_url });
          _log(n, { type: 'done', message: `PR opened → ${status.pr_url}` });
        } else if (attempts < MAX) {
          _prPollers.set(n, setTimeout(poll, 8_000));
        } else {
          _prPollers.delete(n);
          _log(n, { type: 'error', message: 'PR creation timed out — check GitHub manually' });
        }
      })
      .catch(() => {
        attempts++;
        if (attempts < MAX) _prPollers.set(n, setTimeout(poll, 8_000));
        else _prPollers.delete(n);
      });
  }

  // First check after 6 s — PR creation usually takes 2-4 s
  _prPollers.set(n, setTimeout(poll, 6_000));
}

export function onRunUpdate(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _set(n, state) {
  runStore.set(n, state);
  _persistRuns();
  for (const fn of _listeners) fn(n);
}

function _log(n, entry) {
  if (!logStore.has(n)) logStore.set(n, []);
  const arr = logStore.get(n);
  if (entry.type === 'thinking') {
    // Replace the last thinking entry in-place so heartbeats don't pile up
    const lastIdx = arr.findLastIndex((e) => e.type === 'thinking');
    if (lastIdx !== -1) {
      arr[lastIdx] = { ...entry, ts: Date.now() };
      _persistLogs();
      for (const fn of _listeners) fn(n);
      return;
    }
  }
  if (entry.type === 'reasoning') {
    // Accumulate streaming chunks into the last reasoning entry
    if (arr.length > 0 && arr[arr.length - 1].type === 'reasoning') {
      arr[arr.length - 1] = {
        ...arr[arr.length - 1],
        message: arr[arr.length - 1].message + (entry.message ?? ''),
      };
      _persistLogs();
      for (const fn of _listeners) fn(n);
      return;
    }
  }
  arr.push({ ...entry, ts: Date.now() });
  _persistLogs();
  for (const fn of _listeners) fn(n);
}

// ── Implement (write code + open PR) ─────────────────────────

/**
 * @param {object} issue  GitHub issue object
 * @param {string} repoFullName  "owner/repo"
 * @param {{ endpoint?: string, mcpServers?: object[], autonomy?: string,
 *           llmModel?: string, llmApiKey?: string, fallbackLlmModel?: string,
 *           systemPrompt?: string, purpose?: string, reasoningPattern?: string,
 *           guardrailsAlways?: string, guardrailsNever?: string, sampling?: string }} [agentConfig]
 */
export async function implement(issue, repoFullName, agentConfig = {}) {
  const n = issue.number;
  const endpoint = agentConfig.endpoint ?? AGENT_BASE;
  const _model = agentConfig.llmModel ?? null;
  const _existingLogs = logStore.get(n) ?? [];
  const _runIndex = _existingLogs.filter((e) => e.type === 'run_start').length + 1;
  logStore.set(n, [
    ..._existingLogs,
    { type: 'run_start', ts: Date.now(), actionType: 'implement', runIndex: _runIndex },
  ]);
  _set(n, {
    status: 'pending',
    step: 'Queuing…',
    prUrl: null,
    actionType: 'implement',
    worktreePath: null,
    model: _model,
    cost: null,
    _endpoint: endpoint,
  });

  // Log team + agent context so the user knows what's running
  if (agentConfig.teamName) {
    const modeLabel = agentConfig.teamMode ? ` · ${agentConfig.teamMode}` : '';
    _log(n, { type: 'info', message: `Team: ${agentConfig.teamName}${modeLabel}` });
  }
  if (agentConfig.agentName) {
    const modelLabel = agentConfig.agentModel ? ` (${agentConfig.agentModel})` : '';
    _log(n, { type: 'info', message: `Agent: ${agentConfig.agentName}${modelLabel}` });
  }

  _log(n, { type: 'progress', message: 'Starting agent…' });

  let streamUrl;
  try {
    const res = await fetch(`${endpoint}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        issue_number: n,
        repo_full_name: repoFullName,
        spec: _buildSpec(issue),
        base_branch: 'main',
        create_draft_pr: agentConfig.createDraftPr ?? true,
        mcp_servers: agentConfig.mcpServers ?? [],
        ...(agentConfig.llmModel ? { llm_model: agentConfig.llmModel } : {}),
        ...(agentConfig.llmApiKey ? { llm_api_key: agentConfig.llmApiKey } : {}),
        ...(agentConfig.llmBaseUrl ? { llm_base_url: agentConfig.llmBaseUrl } : {}),
        ...(agentConfig.fallbackLlmModel
          ? { fallback_llm_model: agentConfig.fallbackLlmModel }
          : {}),
        ...(agentConfig.systemPrompt ? { system_prompt: agentConfig.systemPrompt } : {}),
        ...(agentConfig.purpose ? { purpose: agentConfig.purpose } : {}),
        ...(agentConfig.reasoningPattern
          ? { reasoning_pattern: agentConfig.reasoningPattern }
          : {}),
        ...(agentConfig.guardrailsAlways
          ? { guardrails_always: agentConfig.guardrailsAlways }
          : {}),
        ...(agentConfig.guardrailsNever ? { guardrails_never: agentConfig.guardrailsNever } : {}),
        ...(agentConfig.sampling ? { sampling: agentConfig.sampling } : {}),
        ...(agentConfig.autonomy ? { autonomy: agentConfig.autonomy } : {}),
        ...(agentConfig.maxIterations ? { max_iterations: agentConfig.maxIterations } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Agent server ${res.status}`);
    ({ stream_url: streamUrl } = await res.json());
    const pendingRun = runStore.get(n);
    _set(n, { ...pendingRun, status: 'running', step: 'Agent queued — opening stream…' });
    _log(n, { type: 'progress', message: 'Agent queued — opening stream…' });
  } catch (err) {
    _set(n, { status: 'failed', step: err.message, prUrl: null });
    _log(n, { type: 'error', message: err.message });
    return;
  }

  function _openStream(url) {
    const es = new EventSource(url);
    _eventSources.set(n, es);
    let errorStreak = 0;

    es.onmessage = (e) => {
      errorStreak = 0; // reset on any successful message
      const event = JSON.parse(e.data);
      const cur = runStore.get(n) ?? { status: 'running', step: '', prUrl: null };

      switch (event.type) {
        case 'progress':
          if (event.data.step === 'thinking') {
            // Heartbeat — update step text but keep log entry in-place
            _set(n, { ...cur, step: event.data.message });
            _log(n, { type: 'thinking', message: event.data.message });
          } else {
            _set(n, {
              ...cur,
              step: event.data.message,
              worktreePath: event.data.worktree_path ?? cur.worktreePath ?? null,
            });
            _log(n, { type: 'progress', message: event.data.message });
          }
          break;
        case 'reasoning':
          _set(n, { ...cur, step: 'Thinking…' });
          _log(n, { type: 'reasoning', message: event.data.content ?? 'Thinking…' });
          break;
        case 'tool_call':
          _set(n, { ...cur, step: `${event.data.tool}: ${event.data.path ?? ''}`.trimEnd() });
          _log(n, {
            type: 'tool_call',
            message: event.data.tool,
            tool: event.data.tool,
            path: event.data.path ?? '',
          });
          break;
        case 'tool_result': {
          // Strip ANSI escape codes, then show first meaningful line + line count
          // eslint-disable-next-line no-control-regex
          const clean = (event.data.output ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim();
          const lines = clean.split('\n').filter((l) => l.trim());
          const firstLine = (lines[0] ?? '').slice(0, 140);
          const extra = lines.length > 1 ? `  (+${lines.length - 1} lines)` : '';
          if (firstLine) _log(n, { type: 'tool_result', message: firstLine + extra });
          break;
        }
        case 'needs_review':
          _set(n, {
            ...cur,
            status: 'needs_review',
            step: 'Ready to push',
            prUrl: null,
            runId: event.data.run_id,
            branch: event.data.branch,
            worktreePath: event.data.worktree_path ?? cur.worktreePath ?? null,
          });
          _log(n, {
            type: 'done',
            message: `Changes committed on ${event.data.branch} — ready to push`,
          });
          es.close();
          _eventSources.delete(n);
          break;
        case 'complete': {
          const usage = event.data.usage;
          const cost = usage
            ? {
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
                estimatedUsd: calcRunCost(usage.input_tokens ?? 0, usage.output_tokens ?? 0, cur.model ?? ''),
                model: cur.model ?? '',
              }
            : cur.cost ?? null;
          if (event.data.pr_pending) {
            // Branch pushed; PR is being created in background — poll status for pr_url
            _set(n, { ...cur, status: 'done', step: 'PR being created…', prUrl: null, cost });
            _log(n, {
              type: 'done',
              message: `Branch pushed (${event.data.branch}) — PR being created in background…`,
            });
            _pollForPr(n, _runId, endpoint);
          } else {
            _set(n, {
              ...cur,
              status: 'done',
              step: 'PR opened',
              prUrl: event.data.pr_url ?? null,
              cost,
            });
            _log(n, { type: 'done', message: `PR opened → ${event.data.pr_url ?? ''}` });
          }
          es.close();
          _eventSources.delete(n);
          break;
        }
        case 'error':
          _set(n, { status: 'failed', step: event.data.message, prUrl: null });
          _log(n, { type: 'error', message: event.data.message });
          es.close();
          _eventSources.delete(n);
          break;
        case 'close':
          if (cur?.status === 'running') {
            _set(n, { ...cur, status: 'failed', step: 'Agent stopped unexpectedly', prUrl: null });
            _log(n, { type: 'error', message: 'Agent run ended without completing' });
          }
          es.close();
          _eventSources.delete(n);
          break;
      }
    };

    es.onerror = () => {
      const cur = runStore.get(n);
      if (cur?.status !== 'running') return; // already terminal — do nothing
      errorStreak++;

      if (errorStreak <= 5) {
        // Transient drop (proxy timeout, blip) — browser will auto-reconnect.
        // Just update the step label so the user sees what's happening.
        _set(n, { ...cur, step: `Reconnecting… (attempt ${errorStreak})` });
        _log(n, { type: 'thinking', message: `SSE reconnecting… (attempt ${errorStreak})` });
        return; // do NOT close — let EventSource auto-retry
      }

      // 5 consecutive errors — check server status before giving up
      es.close();
      _eventSources.delete(n);
      fetch(`${endpoint}/runs/${_runId}/status`)
        .then((r) => r.json())
        .then((status) => {
          const latest = runStore.get(n);
          if (status.status === 'complete') {
            if (status.pr_url) {
              _set(n, { ...latest, status: 'done', step: 'PR opened', prUrl: status.pr_url });
              _log(n, { type: 'done', message: `PR opened → ${status.pr_url}` });
            } else {
              _set(n, { ...latest, status: 'done', step: 'PR being created…', prUrl: null });
              _log(n, { type: 'done', message: 'Branch pushed — PR being created in background…' });
              _pollForPr(n, _runId, endpoint);
            }
          } else if (status.status === 'running') {
            // Server says still running — reconnect once more with fresh EventSource
            _log(n, { type: 'thinking', message: 'Reconnecting after repeated drops…' });
            _openStream(url);
          } else {
            _set(n, { status: 'failed', step: status.error || 'Connection lost', prUrl: null });
            _log(n, { type: 'error', message: status.error || 'SSE connection lost' });
          }
        })
        .catch(() => {
          const latest = runStore.get(n);
          if (latest?.status === 'running') {
            _set(n, { status: 'failed', step: 'Connection lost', prUrl: null });
            _log(n, { type: 'error', message: 'SSE connection lost — server unreachable' });
          }
        });
    };
  }

  // Extract run_id from the stream URL for status checks
  const _runId = streamUrl.split('/').filter(Boolean).at(-2);
  _openStream(`${endpoint}${streamUrl}`);
}

// ── Refine (improve issue description) ───────────────────────

export async function refine(issue, agentConfig = {}) {
  const n = issue.number;
  const endpoint = agentConfig.endpoint ?? AGENT_BASE;
  const _existingRefLogs = logStore.get(n) ?? [];
  const _refRunIndex = _existingRefLogs.filter((e) => e.type === 'run_start').length + 1;
  logStore.set(n, [
    ..._existingRefLogs,
    { type: 'run_start', ts: Date.now(), actionType: 'refine', runIndex: _refRunIndex },
  ]);
  _set(n, {
    status: 'pending',
    step: 'Analyzing issue…',
    prUrl: null,
    actionType: 'refine',
    model: agentConfig.llmModel ?? null,
    cost: null,
    _endpoint: endpoint,
  });

  if (agentConfig.teamName) {
    const modeLabel = agentConfig.teamMode ? ` · ${agentConfig.teamMode}` : '';
    _log(n, { type: 'info', message: `Team: ${agentConfig.teamName}${modeLabel}` });
  }
  if (agentConfig.agentName) {
    const modelLabel = agentConfig.agentModel ? ` (${agentConfig.agentModel})` : '';
    _log(n, { type: 'info', message: `Agent: ${agentConfig.agentName}${modelLabel}` });
  }

  _log(n, { type: 'progress', message: 'Sending to IssueRefiner…' });

  let streamUrl;
  try {
    const res = await fetch(`${endpoint}/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: issue.title,
        body: issue.body ?? '',
        ...(agentConfig.llmModel ? { llm_model: agentConfig.llmModel } : {}),
        ...(agentConfig.llmApiKey ? { llm_api_key: agentConfig.llmApiKey } : {}),
        ...(agentConfig.llmBaseUrl ? { llm_base_url: agentConfig.llmBaseUrl } : {}),
        ...(agentConfig.systemPrompt ? { system_prompt: agentConfig.systemPrompt } : {}),
        ...(agentConfig.userPrompt ? { user_prompt: agentConfig.userPrompt } : {}),
        ...(agentConfig.sampling ? { sampling: agentConfig.sampling } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Agent server ${res.status}`);
    ({ stream_url: streamUrl } = await res.json());
    const pendingRefine = runStore.get(n);
    _set(n, { ...pendingRefine, status: 'running' });
    _log(n, { type: 'progress', message: 'Refiner started — streaming reasoning…' });
  } catch (err) {
    _set(n, { status: 'failed', step: err.message, prUrl: null });
    _log(n, { type: 'error', message: err.message });
    return;
  }

  const es = new EventSource(`${endpoint}${streamUrl}`);
  _eventSources.set(n, es);

  es.onmessage = (e) => {
    const event = JSON.parse(e.data);
    const cur = runStore.get(n) ?? { status: 'running', step: '', prUrl: null };

    switch (event.type) {
      case 'reasoning':
        _set(n, { ...cur, step: 'Thinking…' });
        _log(n, { type: 'reasoning', message: event.data.content ?? '' });
        break;
      case 'progress':
        _set(n, { ...cur, step: event.data.message });
        _log(n, { type: 'progress', message: event.data.message });
        break;
      case 'suggestion':
        suggestionStore.set(n, event.data);
        _log(n, { type: 'done', message: 'AI suggestion ready — see Details tab' });
        for (const fn of _listeners) fn(n);
        break;
      case 'complete': {
        const usage = event.data.usage;
        const cur2 = runStore.get(n);
        const cost2 = usage
          ? {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              estimatedUsd: calcRunCost(usage.input_tokens ?? 0, usage.output_tokens ?? 0, cur2?.model ?? ''),
              model: cur2?.model ?? '',
            }
          : cur2?.cost ?? null;
        _set(n, { ...cur2, status: 'done', step: 'Refinement complete', prUrl: null, cost: cost2 });
        es.close();
        _eventSources.delete(n);
        break;
      }
      case 'error':
        _set(n, { status: 'failed', step: event.data.message, prUrl: null });
        _log(n, { type: 'error', message: event.data.message });
        es.close();
        _eventSources.delete(n);
        break;
      case 'close':
        es.close();
        _eventSources.delete(n);
        break;
    }
  };

  es.onerror = () => {
    const cur = runStore.get(n);
    if (cur?.status === 'running') {
      _set(n, { status: 'failed', step: 'Connection lost', prUrl: null });
      _log(n, { type: 'error', message: 'SSE connection lost' });
    }
    es.close();
    _eventSources.delete(n);
  };
}

// ── Push committed branch + open PR ──────────────────────────

export async function pushRun(issueNumber) {
  const run = runStore.get(issueNumber);
  if (!run?.runId) return;
  const runId = run.runId;

  _set(issueNumber, { ...run, status: 'running', step: 'Pushing branch…' });
  _log(issueNumber, { type: 'progress', message: 'Pushing branch to GitHub…' });

  try {
    const res = await fetch(`${AGENT_BASE}/runs/${runId}/push`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail ?? `Server ${res.status}`);
    _set(issueNumber, {
      ...runStore.get(issueNumber),
      status: 'done',
      step: 'PR opened',
      prUrl: data.pr_url,
    });
    _log(issueNumber, { type: 'done', message: `PR opened → ${data.pr_url ?? ''}` });
  } catch (err) {
    _set(issueNumber, {
      ...runStore.get(issueNumber),
      status: 'needs_review',
      step: 'Push failed — retry?',
    });
    _log(issueNumber, { type: 'error', message: err.message });
  }
}

// ── Cancel a running run ──────────────────────────────────────

export function cancelRun(issueNumber) {
  const es = _eventSources.get(issueNumber);
  if (es) {
    es.close();
    _eventSources.delete(issueNumber);
  }
  const run = runStore.get(issueNumber);
  // Best-effort: tell the backend to stop the run (ignore failures)
  if (run?.runId) {
    fetch(`${run._endpoint ?? AGENT_BASE}/runs/${run.runId}/cancel`, { method: 'POST' }).catch(() => {});
  }
  _set(issueNumber, { ...(run ?? {}), status: 'cancelled', step: 'Cancelled by user', prUrl: run?.prUrl ?? null });
  _log(issueNumber, { type: 'error', message: 'Stopped by user' });
}

// ── Delegation log helper ─────────────────────────────────────

/**
 * Emits a `delegation` log entry visible in the Agent Logs tab.
 * Call this just before handing off from one team agent to the next.
 */
export function logDelegation(issueNumber, fromAgentName, toAgentName) {
  _log(issueNumber, {
    type: 'delegation',
    message: `${fromAgentName} → ${toAgentName}`,
    from: fromAgentName,
    to: toAgentName,
  });
}

// ── Helpers ───────────────────────────────────────────────────

function _buildSpec(issue) {
  const body = issue.body ?? '';
  return {
    intent: issue.title,
    acceptance_criteria: _extractCriteria(body),
    technical_notes: body.slice(0, 2000) || null,
    context_files: [],
  };
}

// ── MCP connectivity check ────────────────────────────────────

/**
 * Pings an MCP server URL to verify it is reachable.
 * Uses no-cors mode so cross-origin servers respond without CORS headers.
 * Resolves to {ok:true} if any network response arrives within 5 s,
 * or {ok:false, error:string} on timeout / network failure.
 */
export async function pingMcpServer(url) {
  try {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), 5000);
    await fetch(url, { signal: controller.signal, method: 'HEAD', mode: 'no-cors' });
    clearTimeout(timerId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timeout' : 'Unreachable' };
  }
}

function _extractCriteria(body) {
  const bullets = body
    .split('\n')
    .filter((l) => /^[-*]\s/.test(l))
    .slice(0, 10);
  if (bullets.length > 0) return bullets.map((l) => l.replace(/^[-*]\s+/, ''));
  const first = body.trim().slice(0, 200);
  return first ? [first] : ['See issue for details'];
}
