import { escHtml } from '../lib/formatters.js';
import { updateIssue } from '../lib/github-api.js';
import {
  onRunUpdate,
  runStore,
  logStore,
  implement,
  refine,
  cancelRun,
  pushRun,
  suggestionStore,
  logDelegation,
} from '../lib/implementer.js';
import { getAgents, getTeams, getCodeEditor, getIssueTeam, setIssueTeam, getGlobalAiKey } from '../lib/agents.js';
import { renderBoard } from '../lib/board.js';
import { AGENT_BASE_URL } from '../lib/config.js';
import { state } from './state.js';
import { getFilters } from './board-loader.js';

const $ = (id) => document.getElementById(id);

const drawer = $('drawer');
const drawerBack = $('drawer-backdrop');

let _drawerIssue = null;
let _drawerTab = 'details';

// ── Open / close ─────────────────────────────────────────────
export function openDrawer(issue, tab = 'details') {
  _drawerIssue = issue;
  _drawerTab = tab;
  $('drawer-number').textContent = `#${issue.number}`;
  $('drawer-gh-link').href = issue.html_url;
  _renderDrawerTabs();
  _renderDrawerBody();
  drawer.classList.remove('translate-x-full');
  drawerBack.classList.remove('hidden');
}

export function closeDrawer() {
  drawer.classList.add('translate-x-full');
  drawerBack.classList.add('hidden');
  _drawerIssue = null;
}

// Called from main.js onRunUpdate to refresh the drawer if it's open
export function refreshDrawerIfOpen(issueNumber) {
  if (_drawerIssue?.number === issueNumber) {
    _renderDrawerTabs();
    _renderDrawerBody();
    if (_drawerTab === 'logs') {
      const body = $('drawer-body');
      if (body) body.scrollTop = body.scrollHeight;
    }
  }
}

// ── Tabs ─────────────────────────────────────────────────────
function _renderDrawerTabs() {
  ['details', 'ai', 'logs'].forEach((t) => {
    const btn = $(`tab-${t}`);
    btn.classList.toggle('active-tab', t === _drawerTab);
  });

  const logs = _drawerIssue ? (logStore.get(_drawerIssue.number) ?? []) : [];
  const badge = $('tab-logs-badge');
  if (logs.length > 0 && _drawerTab !== 'logs') {
    badge.textContent = logs.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function _renderDrawerBody() {
  if (!_drawerIssue) return;
  if (_drawerTab === 'details') _renderDetails(_drawerIssue);
  else if (_drawerTab === 'ai') _renderAI(_drawerIssue);
  else _renderLogs(_drawerIssue);
}

// ── Details tab ──────────────────────────────────────────────
function _renderDetails(issue) {
  const labels = issue.labels || [];
  const assignees = issue.assignees || [];
  const dupList = state.duplicates.get(issue.number) ?? [];
  const teams = getTeams();
  const assignedTeamId = state.repoFullName ? getIssueTeam(state.repoFullName, issue.number) : null;

  const stateColor =
    issue.state === 'open' ? { bg: '#dbeafe', fg: '#1d4ed8' } : { bg: '#d1fae5', fg: '#065f46' };
  const stateIcon = issue.state === 'open' ? 'radio_button_unchecked' : 'check_circle';
  const createdDate = new Date(issue.created_at);
  const updatedDate = new Date(issue.updated_at);
  const fmtDate = (d) =>
    d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  $('drawer-body').innerHTML = `
    <!-- Title (editable) -->
    <div id="detail-title-wrap" class="group relative cursor-text rounded-lg px-2 py-1.5 -mx-2 transition-colors hover:bg-[#edeef0]">
      <p class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/50 mb-1">#${issue.number}</p>
      <h2 id="detail-title-display" class="font-semibold text-[15px] text-on-surface leading-snug pr-6">${escHtml(issue.title)}</h2>
      <span class="material-symbols-outlined absolute top-2 right-2 opacity-0 group-hover:opacity-60 transition-opacity text-on-surface-variant" style="font-size:14px">edit</span>
    </div>

    <!-- Labels -->
    ${
      labels.length
        ? `
    <div class="flex flex-wrap gap-1 px-0.5">
      ${labels
        .map((l) => {
          const c = '#' + (l.color || '737685');
          return `<span class="label-pill" style="color:${c};background:${c}18;border:1px solid ${c}30">${escHtml(l.name)}</span>`;
        })
        .join('')}
    </div>`
        : ''
    }

    <!-- Field list (Jira style) -->
    <div class="rounded-xl overflow-hidden text-xs" style="border:1px solid #e1e2e4">

      <!-- Status -->
      <div class="flex items-center px-3 py-2.5" style="border-bottom:1px solid #e1e2e4">
        <span class="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/60">Status</span>
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold"
          style="background:${stateColor.bg};color:${stateColor.fg}">
          <span class="material-symbols-outlined" style="font-size:11px">${stateIcon}</span>
          ${issue.state.charAt(0).toUpperCase() + issue.state.slice(1)}
        </span>
      </div>

      <!-- Assignees -->
      <div class="flex items-center px-3 py-2.5" style="border-bottom:1px solid #e1e2e4">
        <span class="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/60">Assignee</span>
        ${
          assignees.length
            ? `
        <div class="flex items-center gap-1.5 flex-wrap">
          ${assignees
            .map(
              (a) => `
            <div class="flex items-center gap-1.5">
              <img src="${escHtml(a.avatar_url)}" class="w-5 h-5 rounded-full" title="${escHtml(a.login)}"/>
              <span class="text-on-surface">${escHtml(a.login)}</span>
            </div>
          `
            )
            .join('')}
        </div>`
            : `<span class="text-on-surface-variant/50 italic">Unassigned</span>`
        }
      </div>

      <!-- Team assignment -->
      <div class="flex items-center px-3 py-2.5" style="border-bottom:1px solid #e1e2e4">
        <span class="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/60">Team</span>
        <select id="issue-team-select"
          class="text-xs text-on-surface bg-transparent outline-none cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-surface-container">
          <option value="">— None —</option>
          ${teams.map((t) => `<option value="${escHtml(t.id)}"${assignedTeamId === t.id ? ' selected' : ''}>${escHtml(t.name)}</option>`).join('')}
        </select>
      </div>

      <!-- Labels field row -->
      <div class="flex items-center px-3 py-2.5" style="border-bottom:1px solid #e1e2e4">
        <span class="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/60">Labels</span>
        ${
          labels.length
            ? `
        <div class="flex flex-wrap gap-1">
          ${labels
            .map((l) => {
              const c = '#' + (l.color || '737685');
              return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium" style="color:${c};background:${c}18">${escHtml(l.name)}</span>`;
            })
            .join('')}
        </div>`
            : `<span class="text-on-surface-variant/50 italic">None</span>`
        }
      </div>

      <!-- Milestone -->
      <div class="flex items-center px-3 py-2.5" style="border-bottom:1px solid #e1e2e4">
        <span class="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/60">Milestone</span>
        ${
          issue.milestone
            ? `<span class="inline-flex items-center gap-1 text-on-surface"><span class="material-symbols-outlined" style="font-size:12px;color:#003d9b">flag</span>${escHtml(issue.milestone.title)}</span>`
            : `<span class="text-on-surface-variant/50 italic">None</span>`
        }
      </div>

      <!-- Comments -->
      <div class="flex items-center px-3 py-2.5" style="border-bottom:1px solid #e1e2e4">
        <span class="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/60">Comments</span>
        <span class="inline-flex items-center gap-1 text-on-surface">
          <span class="material-symbols-outlined" style="font-size:12px;color:#737685">chat_bubble</span>
          ${issue.comments}
        </span>
      </div>

      <!-- Created -->
      <div class="flex items-center px-3 py-2.5" style="border-bottom:1px solid #e1e2e4">
        <span class="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/60">Created</span>
        <span class="text-on-surface" title="${createdDate.toISOString()}">${fmtDate(createdDate)}</span>
      </div>

      <!-- Updated -->
      <div class="flex items-center px-3 py-2.5">
        <span class="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/60">Updated</span>
        <span class="text-on-surface" title="${updatedDate.toISOString()}">${fmtDate(updatedDate)}</span>
      </div>

    </div>

    <!-- Description (editable) -->
    <div>
      <p class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60 mb-1.5">Description</p>
      <div id="detail-desc-wrap" class="group relative rounded-xl cursor-text transition-colors"
        style="border:1px solid #e1e2e4;min-height:72px">
        <div id="detail-desc-display" class="text-xs text-on-surface-variant leading-relaxed p-3 whitespace-pre-wrap max-h-56 overflow-y-auto"
          style="scrollbar-width:thin;scrollbar-color:#c3c6d6 transparent">
          ${
            issue.body
              ? escHtml((issue.body || '').slice(0, 2000)) +
                (issue.body.length > 2000 ? '\n\n…' : '')
              : `<span class="italic text-on-surface-variant/40">Click to add a description…</span>`
          }
        </div>
        <span class="material-symbols-outlined absolute top-2 right-2 opacity-0 group-hover:opacity-50 transition-opacity text-on-surface-variant" style="font-size:13px">edit</span>
      </div>
    </div>

    ${
      dupList.length
        ? `
    <div>
      <div class="flex items-center gap-1.5 mb-2">
        <span class="material-symbols-outlined" style="font-size:14px;color:#b45309">warning</span>
        <p class="text-[10px] font-bold uppercase tracking-widest" style="color:#b45309">Possible Duplicates (${dupList.length})</p>
      </div>
      <div class="flex flex-col gap-1.5">
        ${dupList
          .map((d) => {
            const pct = Math.round(d.similarity * 100);
            const barColor = pct >= 90 ? '#dc2626' : '#d97706';
            return `
          <div class="rounded-lg p-2.5" style="background:#fef3c7;border:1px solid #fde68a">
            <div class="flex items-center justify-between mb-1.5">
              <span class="font-mono text-[10px] font-bold" style="color:#92400e">#${d.number}</span>
              <span class="text-[10px] font-bold px-1.5 py-0.5 rounded" style="background:#fde68a;color:#78350f">${pct}% match</span>
            </div>
            <p class="text-[11px] text-on-surface line-clamp-1 mb-1.5">${escHtml(d.title)}</p>
            <div class="rounded-full h-1 w-full" style="background:#fde68a">
              <div class="rounded-full h-1" style="width:${pct}%;background:${barColor}"></div>
            </div>
          </div>`;
          })
          .join('')}
      </div>
    </div>`
        : ''
    }

    ${_renderSuggestionCard(issue.number)}

    <div class="flex gap-2">
      <button id="drawer-open-editor-btn"
        class="flex items-center justify-center gap-1.5 flex-1 text-xs font-semibold py-2.5 rounded-lg transition-all active:scale-95"
        style="background:#e8ecf5;color:#434654;border:1px solid rgba(195,198,214,0.5)">
        <span id="drawer-editor-icon" class="material-symbols-outlined" style="font-size:14px">code</span>
        <span id="drawer-editor-label">Open in Editor</span>
      </button>
      <a href="${escHtml(issue.html_url)}" target="_blank"
        class="flex items-center justify-center gap-1.5 flex-1 text-on-primary text-xs font-semibold py-2.5 rounded-lg transition-all active:scale-95"
        style="background:linear-gradient(135deg,#003d9b,#0052cc)">
        <span class="material-symbols-outlined" style="font-size:14px">open_in_new</span>
        View on GitHub
      </a>
    </div>
  `;

  const suggestion = suggestionStore.get(issue.number);

  // Wire copy-as-markdown button
  const copyBtn = $('drawer-body').querySelector('[data-copy-suggestion]');
  if (copyBtn && suggestion) {
    copyBtn.addEventListener('click', () => {
      const md = [
        `## ${suggestion.title}`,
        '',
        suggestion.description,
        '',
        '### Acceptance Criteria',
        ...(suggestion.acceptance_criteria ?? []).map((c) => `- [ ] ${c}`),
      ].join('\n');
      navigator.clipboard.writeText(md).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.innerHTML =
            '<span class="material-symbols-outlined" style="font-size:11px">content_copy</span>Copy Markdown';
        }, 1500);
      });
    });
  }

  // Wire apply-to-github button
  const applyBtn = $('drawer-body').querySelector('[data-apply-suggestion]');
  const applyStatus = $(`apply-suggestion-status-${issue.number}`);
  if (applyBtn && suggestion && state.repoFullName) {
    applyBtn.addEventListener('click', async () => {
      applyBtn.disabled = true;
      applyBtn.textContent = 'Applying…';
      const newBody = [
        suggestion.description,
        '',
        ...(suggestion.acceptance_criteria?.length
          ? ['### Acceptance Criteria', ...suggestion.acceptance_criteria.map((c) => `- [ ] ${c}`)]
          : []),
      ].join('\n');
      try {
        await updateIssue(state.repoFullName, issue.number, {
          title: suggestion.title,
          body: newBody,
        });
        issue.title = suggestion.title;
        issue.body = newBody;
        renderBoard(getFilters);
        applyBtn.innerHTML =
          '<span class="material-symbols-outlined" style="font-size:11px">check_circle</span>Applied';
        applyBtn.style.background = '#16a34a';
        if (applyStatus) {
          applyStatus.textContent = 'Issue updated on GitHub.';
          applyStatus.style.color = '#16a34a';
          applyStatus.classList.remove('hidden');
        }
      } catch (err) {
        applyBtn.disabled = false;
        applyBtn.innerHTML =
          '<span class="material-symbols-outlined" style="font-size:11px">cloud_upload</span>Apply to GitHub';
        if (applyStatus) {
          applyStatus.textContent = err.userMessage || err.message;
          applyStatus.style.color = '#ba1a1a';
          applyStatus.classList.remove('hidden');
        }
      }
    });
  }

  // Wire open-in-editor button
  const drawerEditorBtn = $('drawer-open-editor-btn');
  const drawerEditorIcon = $('drawer-editor-icon');
  const drawerEditorLabel = $('drawer-editor-label');
  if (drawerEditorBtn) {
    drawerEditorBtn.addEventListener('click', async () => {
      const editor = getCodeEditor();
      const run = runStore.get(issue.number);

      drawerEditorBtn.style.pointerEvents = 'none';
      drawerEditorIcon.textContent = 'autorenew';
      drawerEditorIcon.classList.add('animate-spin');
      drawerEditorLabel.textContent = 'Opening…';

      const reset = () => {
        drawerEditorBtn.style.pointerEvents = '';
        drawerEditorIcon.textContent = 'code';
        drawerEditorIcon.classList.remove('animate-spin');
        drawerEditorLabel.textContent = 'Open in Editor';
      };

      try {
        if (run?.worktreePath) {
          await fetch(`${AGENT_BASE_URL}/open-editor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: run.worktreePath, cmd: editor.cmd }),
          });
        } else {
          await fetch(`${AGENT_BASE_URL}/worktree`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              issue_number: issue.number,
              repo_full_name: state.repoFullName,
              editor_cmd: editor.cmd,
            }),
          });
        }
      } finally {
        reset();
      }
    });
  }

  // Wire team assignment select
  const teamSelect = $('issue-team-select');
  if (teamSelect && state.repoFullName) {
    teamSelect.addEventListener('change', () => {
      setIssueTeam(state.repoFullName, issue.number, teamSelect.value || null);
    });
  }

  _bindDetailsEdits(issue);
}

function _bindDetailsEdits(issue) {
  // ── Inline title edit ──────────────────────────────────────
  const titleWrap = $('detail-title-wrap');
  const titleDisplay = $('detail-title-display');

  titleWrap.addEventListener('click', () => {
    if (titleWrap.querySelector('#detail-title-input')) return;
    const input = document.createElement('input');
    input.id = 'detail-title-input';
    input.value = issue.title;
    input.className =
      'w-full font-semibold text-[15px] text-on-surface leading-snug bg-white rounded px-1 py-0.5 outline-none ring-2';
    input.style.cssText = 'ring-color:#003d9b;border:none';
    titleDisplay.replaceWith(input);
    titleWrap.style.background = '#ffffff';
    input.focus();
    input.select();

    const commit = () => {
      const val = input.value.trim() || issue.title;
      issue.title = val;
      const newH2 = document.createElement('h2');
      newH2.id = 'detail-title-display';
      newH2.className = 'font-semibold text-[15px] text-on-surface leading-snug pr-6';
      newH2.textContent = val;
      input.replaceWith(newH2);
      titleWrap.style.background = '';
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        input.value = issue.title;
        input.blur();
      }
    });
  });

  // ── Inline description edit ────────────────────────────────
  const descWrap = $('detail-desc-wrap');
  const descDisplay = $('detail-desc-display');

  descWrap.addEventListener('click', () => {
    if (descWrap.querySelector('#detail-desc-input')) return;
    const ta = document.createElement('textarea');
    ta.id = 'detail-desc-input';
    ta.value = issue.body || '';
    ta.placeholder = 'Add a description…';
    ta.className =
      'w-full text-xs text-on-surface leading-relaxed p-3 resize-none outline-none rounded-xl';
    ta.style.cssText =
      'min-height:140px;background:#f8f9ff;border:none;box-shadow:inset 0 0 0 2px #003d9b';
    descDisplay.replaceWith(ta);
    ta.focus();

    const hint = document.createElement('p');
    hint.className = 'text-[10px] text-on-surface-variant/50 px-3 pb-2';
    hint.textContent = 'Ctrl+Enter to save · Esc to cancel';
    descWrap.appendChild(hint);

    const commit = () => {
      issue.body = ta.value;
      const bodyText = ta.value;
      const newDiv = document.createElement('div');
      newDiv.id = 'detail-desc-display';
      newDiv.className =
        'text-xs text-on-surface-variant leading-relaxed p-3 whitespace-pre-wrap max-h-56 overflow-y-auto';
      newDiv.style.cssText = 'scrollbar-width:thin;scrollbar-color:#c3c6d6 transparent';
      newDiv.textContent = bodyText || '';
      if (!bodyText)
        newDiv.innerHTML =
          '<span class="italic text-on-surface-variant/40">Click to add a description…</span>';
      ta.replaceWith(newDiv);
      hint.remove();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        ta.blur();
      }
      if (e.key === 'Escape') {
        ta.value = issue.body || '';
        ta.blur();
      }
    });
    ta.addEventListener('blur', commit);
  });
}

// ── Agent config builder ──────────────────────────────────────
function _agentConfig(agent, team = null) {
  if (!agent) return {};
  // Map provider+model to the OpenHands-compatible model string.
  // Claude models pass through directly; OpenAI models need the openai/ prefix.
  const _prefixModel = (provider, model) => {
    if (!model) return undefined;
    return (provider === 'openai' || provider === 'copilot') && !model.startsWith('openai/')
      ? `openai/${model}`
      : model;
  };
  return {
    endpoint: agent.endpoint,
    mcpServers: agent.mcpServers ?? [],
    autonomy: agent.autonomy || undefined,
    llmModel: _prefixModel(agent.provider, agent.model),
    llmApiKey: agent.apiKey || getGlobalAiKey() || undefined,
    llmBaseUrl: agent.llmBaseUrl || undefined,
    fallbackLlmModel: _prefixModel(agent.fallbackProvider, agent.fallbackModel),
    systemPrompt: agent.systemPrompt || undefined,
    purpose: agent.purpose || undefined,
    reasoningPattern: agent.reasoningPattern || undefined,
    guardrailsAlways: agent.guardrailsAlways || undefined,
    guardrailsNever: agent.guardrailsNever || undefined,
    sampling: agent.sampling || undefined,
    // UI metadata for log display — not sent to backend
    agentName: agent.name || agent.id,
    agentModel: agent.model || agent.provider,
    agentActionType: agent.actionType || 'implement',
    teamName: team?.name || null,
    teamMode: team?.mode || null,
  };
}

// ── Implement dispatcher ─────────────────────────────────────
export async function triggerImplement(issue, overrideAgentId = null) {
  let issueColId = null;
  for (const [colId, col] of Object.entries(state.columns)) {
    if (col.issues?.some((i) => i.number === issue.number)) {
      issueColId = colId;
      break;
    }
  }

  const teams = getTeams();
  const agents = getAgents();

  // If an explicit agent was picked (no team), run it directly
  if (overrideAgentId) {
    const agent = agents.find((a) => a.id === overrideAgentId);
    if (agent) {
      implement(issue, state.repoFullName, _agentConfig(agent, null));
      return;
    }
  }

  // Check if this issue has an explicitly assigned team
  const assignedTeamId = state.repoFullName ? getIssueTeam(state.repoFullName, issue.number) : null;
  const assignedTeam = assignedTeamId ? teams.find((t) => t.id === assignedTeamId) : null;

  const prodTeam =
    assignedTeam ??
    teams.find(
      (t) =>
        t.status === 'production' &&
        (t.agents ?? []).some((id) =>
          agents.find((a) => a.id === id && (a.lanes ?? []).includes(issueColId))
        )
    );

  if (prodTeam && prodTeam.mode === 'sequential') {
    const teamAgents = (prodTeam.agents ?? [])
      .map((id) => agents.find((a) => a.id === id))
      .filter(Boolean);

    let currentIssue = issue;
    for (let i = 0; i < teamAgents.length; i++) {
      const agent = teamAgents[i];
      const nextAgent = teamAgents[i + 1];

      if (agent.actionType === 'refine') {
        refine(currentIssue, _agentConfig(agent, prodTeam));
        await new Promise((resolve) => {
          const unsub = onRunUpdate((n) => {
            if (n !== issue.number) return;
            const run = runStore.get(n);
            if (run?.status === 'done' || run?.status === 'failed') {
              unsub();
              resolve();
            }
          });
        });
        // Merge AI suggestion back into the issue for the next agent
        const suggestion = suggestionStore.get(issue.number);
        if (suggestion) {
          currentIssue = {
            ...currentIssue,
            title: suggestion.title || currentIssue.title,
            body: [
              suggestion.description || currentIssue.body,
              ...(suggestion.acceptance_criteria?.length
                ? [
                    '\n### Acceptance Criteria',
                    ...suggestion.acceptance_criteria.map((c) => `- [ ] ${c}`),
                  ]
                : []),
            ].join('\n'),
          };
        }
        if (nextAgent) logDelegation(issue.number, agent.name, nextAgent.name);
      } else {
        implement(currentIssue, state.repoFullName, _agentConfig(agent, prodTeam));
        return;
      }
    }
    return;
  }

  if (prodTeam && prodTeam.mode === 'parallel') {
    const teamAgents = (prodTeam.agents ?? [])
      .map((id) => agents.find((a) => a.id === id))
      .filter(Boolean);

    teamAgents.forEach((agent) => {
      if (agent.actionType === 'refine') {
        refine(issue, _agentConfig(agent, prodTeam));
      } else {
        implement(issue, state.repoFullName, _agentConfig(agent, prodTeam));
      }
    });
    return;
  }

  const agent =
    agents.find((a) => a.actionType === 'implement' && (a.lanes ?? []).includes(issueColId)) ??
    agents.find((a) => a.actionType === 'implement') ??
    agents.find((a) => a.id === 'implementer');

  implement(issue, state.repoFullName, _agentConfig(agent, null));
}

// ── AI Actions tab ───────────────────────────────────────────
function _renderAI(issue) {
  const run = runStore.get(issue.number);
  const status = run?.status ?? 'idle';

  let issueColId = null;
  for (const [colId, col] of Object.entries(state.columns)) {
    if (col.issues?.some((i) => i.number === issue.number)) {
      issueColId = colId;
      break;
    }
  }
  const isTriageCol = issueColId === 'triage';

  const assignedTeamId = state.repoFullName ? getIssueTeam(state.repoFullName, issue.number) : null;
  const assignedTeam = assignedTeamId ? getTeams().find((t) => t.id === assignedTeamId) : null;
  const implementAgents = getAgents().filter((a) => a.actionType === 'implement');

  $('drawer-body').innerHTML = `
    <div>
      <p class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60 mb-1">Issue</p>
      <p class="text-sm font-semibold text-on-surface leading-snug">${escHtml(issue.title)}</p>
    </div>

    ${
      isTriageCol
        ? `
    <!-- Improve Issue section (triage only) -->
    <div class="rounded-xl p-4 space-y-3" style="background:#edeef0">
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined" style="font-size:16px;color:#6d28d9">edit_note</span>
        <p class="text-xs font-bold text-on-surface">Improve Issue</p>
      </div>
      <p class="text-[11px] text-on-surface-variant leading-relaxed">
        The agent will rewrite the issue title and description to be clearer, more actionable, and better scoped.
      </p>
      ${
        status === 'idle' || status === 'failed'
          ? `
      <button id="drawer-refine-btn"
        class="flex items-center justify-center gap-1.5 w-full text-on-primary text-xs font-semibold py-2 rounded-lg transition-all active:scale-95"
        style="background:linear-gradient(135deg,#6d28d9,#7c3aed)">
        <span class="material-symbols-outlined" style="font-size:14px">edit_note</span>
        ${status === 'failed' ? 'Retry' : 'Improve Issue'}
      </button>`
          : ''
      }
    </div>`
        : ''
    }

    <!-- Implement section -->
    <div class="rounded-xl p-4 space-y-3" style="background:#edeef0">
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined" style="font-size:16px;color:#003d9b">auto_fix_high</span>
        <p class="text-xs font-bold text-on-surface">Implement with AI</p>
      </div>
      <p class="text-[11px] text-on-surface-variant leading-relaxed">
        The agent will read the issue, write code, run tests, and open a draft PR — all automatically.
      </p>

      ${
        assignedTeam
          ? `
      <!-- Team badge -->
      <div class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold" style="background:#dae2ff;color:#003d9b">
        <span class="material-symbols-outlined" style="font-size:13px">group</span>
        ${escHtml(assignedTeam.name)}
        <span class="ml-auto font-normal opacity-70">${escHtml(assignedTeam.mode)}</span>
      </div>`
          : implementAgents.length > 1 && (status === 'idle' || status === 'failed')
            ? `
      <!-- Agent picker (no team assigned) -->
      <div class="flex items-center gap-2">
        <span class="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/60 shrink-0">Agent</span>
        <select id="drawer-agent-select"
          class="flex-1 text-xs text-on-surface bg-white rounded-lg px-2 py-1.5 outline-none cursor-pointer"
          style="border:1px solid #c3c6d6">
          ${implementAgents.map((a) => `<option value="${escHtml(a.id)}">${escHtml(a.name)}</option>`).join('')}
        </select>
      </div>`
            : ''
      }

      ${_renderAIStatus(run)}
      ${
        status === 'running'
          ? `
      <button id="drawer-stop-btn"
        class="flex items-center justify-center gap-1.5 w-full text-xs font-semibold py-2 rounded-lg transition-all active:scale-95"
        style="background:#fce4e4;color:#ba1a1a;border:1px solid #f5c2c2">
        <span class="material-symbols-outlined" style="font-size:14px">stop_circle</span>
        Stop
      </button>`
          : ''
      }
      ${
        status === 'idle' || status === 'failed'
          ? `
      <button id="drawer-implement-btn"
        class="flex items-center justify-center gap-1.5 w-full text-on-primary text-xs font-semibold py-2 rounded-lg transition-all active:scale-95"
        style="background:linear-gradient(135deg,#003d9b,#0052cc)">
        <span class="material-symbols-outlined" style="font-size:14px">play_arrow</span>
        ${status === 'failed' ? 'Retry' : 'Start Implementation'}
      </button>`
          : ''
      }
    </div>

    <!-- Semantic search hint -->
    <div class="rounded-xl p-4 space-y-2" style="background:#edeef0">
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined" style="font-size:16px;color:#003d9b">hub</span>
        <p class="text-xs font-bold text-on-surface">Semantic Search</p>
      </div>
      <p class="text-[11px] text-on-surface-variant leading-relaxed">
        Hybrid search (Voyage AI + keyword) is active. Possible duplicates are auto-detected at ≥85% similarity and shown on Triage cards.
      </p>
      ${
        state.duplicates.get(issue.number)?.length
          ? `
      <div class="flex items-center gap-1.5 text-[11px] font-semibold" style="color:#b45309">
        <span class="material-symbols-outlined" style="font-size:13px">warning</span>
        ${state.duplicates.get(issue.number).length} possible duplicate(s) detected
      </div>`
          : `
      <div class="flex items-center gap-1.5 text-[11px]" style="color:#1a7a4a">
        <span class="material-symbols-outlined" style="font-size:13px">check_circle</span>
        No duplicates found above 85% threshold
      </div>`
      }
    </div>
  `;

  const stopBtn = $('drawer-stop-btn');
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      cancelRun(issue.number);
    });
  }

  const refineBtn = $('drawer-refine-btn');
  if (refineBtn) {
    refineBtn.addEventListener('click', () => {
      const refinerAgent = getAgents().find((a) => a.actionType === 'refine') ?? getAgents()[0];
      refine(issue, _agentConfig(refinerAgent));
      _drawerTab = 'logs';
      _renderDrawerTabs();
      _renderDrawerBody();
    });
  }

  const btn = $('drawer-implement-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      const agentSelect = $('drawer-agent-select');
      const overrideAgentId = agentSelect?.value || null;
      triggerImplement(issue, overrideAgentId);
      _drawerTab = 'logs';
      _renderDrawerTabs();
      _renderDrawerBody();
    });
  }

  const editorBtn = $('drawer-body').querySelector('[data-open-editor]');
  if (editorBtn) {
    editorBtn.addEventListener('click', async () => {
      const editor = getCodeEditor();
      await fetch(`${AGENT_BASE_URL}/open-editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: editorBtn.dataset.openEditor, cmd: editor.cmd }),
      });
    });
  }

  const pushBtn = $('ai-push-btn');
  if (pushBtn) {
    pushBtn.addEventListener('click', async () => {
      pushBtn.disabled = true;
      pushBtn.textContent = 'Pushing…';
      await pushRun(issue.number);
    });
  }
}

function _renderAIStatus(run) {
  if (!run || run.status === 'idle') return '';

  const icons = {
    running: 'autorenew',
    done: 'check_circle',
    failed: 'error_outline',
    needs_review: 'upload',
  };
  const colors = {
    running: '#003d9b',
    done: '#1a7a4a',
    failed: '#ba1a1a',
    needs_review: '#7c3aed',
  };
  const icon = icons[run.status] ?? 'autorenew';
  const color = colors[run.status] ?? '#003d9b';
  const spin = run.status === 'running' ? ' animate-spin' : '';

  return `
    <div class="flex items-center gap-2 rounded-lg px-3 py-2" style="background:#ffffff">
      <span class="material-symbols-outlined${spin}" style="font-size:14px;color:${color}">${icon}</span>
      <span class="text-[11px] text-on-surface flex-1 truncate">${escHtml(run.step)}</span>
      ${
        run.worktreePath
          ? `<button data-open-editor="${escHtml(run.worktreePath)}"
        class="flex items-center gap-0.5 text-[10px] font-semibold px-2 py-0.5 rounded"
        style="color:${color};border:1px solid ${color}40" title="Open worktree in editor">
        <span class="material-symbols-outlined" style="font-size:12px">code</span>Open
      </button>`
          : ''
      }
      ${
        run.status === 'needs_review'
          ? `<button id="ai-push-btn"
        class="flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1 rounded-lg transition-all active:scale-95"
        style="background:#7c3aed;color:#fff">
        <span class="material-symbols-outlined" style="font-size:12px">upload</span>Push & PR
      </button>`
          : ''
      }
      ${run.prUrl ? `<a href="${escHtml(run.prUrl)}" target="_blank" class="text-[10px] font-bold text-primary underline" onclick="event.stopPropagation()">View PR</a>` : ''}
    </div>`;
}

// ── Agent Logs tab ───────────────────────────────────────────
function _formatReasoningMessage(msg) {
  const jsonMatch = msg.match(/^```json\s*([\s\S]*?)```\s*$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      return `<pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:10px;font-family:monospace">${escHtml(JSON.stringify(parsed, null, 2))}</pre>`;
    } catch {
      /* incomplete or invalid JSON, fall through */
    }
  }
  return escHtml(msg);
}

function _renderLogs(issue) {
  const logs = logStore.get(issue.number) ?? [];
  const run = runStore.get(issue.number);

  const logIcons = {
    info: { icon: 'info', color: '#003d9b' },
    progress: { icon: 'arrow_right', color: '#434654' },
    thinking: { icon: 'autorenew', color: '#434654' },
    reasoning: { icon: 'psychology', color: '#7b2600' },
    tool_call: { icon: 'terminal', color: '#003d9b' },
    tool_result: { icon: 'subdirectory_arrow_right', color: '#4b5563' },
    done: { icon: 'check_circle', color: '#1a7a4a' },
    error: { icon: 'error_outline', color: '#ba1a1a' },
    delegation: { icon: 'swap_horiz', color: '#7c3aed' },
  };

  $('drawer-body').innerHTML = `
    <div class="flex items-center justify-between">
      <p class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60">Agent Logs</p>
      ${
        run?.status === 'running'
          ? `
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-1 text-[10px] font-semibold" style="color:#003d9b">
          <span class="material-symbols-outlined animate-spin" style="font-size:12px">autorenew</span>
          Running
        </div>
        <button id="logs-stop-btn"
          class="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-lg transition-all active:scale-95"
          style="background:#fce4e4;color:#ba1a1a;border:1px solid #f5c2c2">
          <span class="material-symbols-outlined" style="font-size:11px">stop_circle</span>
          Stop
        </button>
      </div>`
          : run?.status === 'done'
            ? `
      <div class="flex items-center gap-1 text-[10px] font-semibold" style="color:#1a7a4a">
        <span class="material-symbols-outlined" style="font-size:12px">check_circle</span>
        Done
      </div>`
            : run?.status === 'failed'
              ? `
      <div class="flex items-center gap-1 text-[10px] font-semibold" style="color:#ba1a1a">
        <span class="material-symbols-outlined" style="font-size:12px">error</span>
        Failed
      </div>`
              : run?.status === 'needs_review'
                ? `
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-1 text-[10px] font-semibold" style="color:#7c3aed">
          <span class="material-symbols-outlined" style="font-size:12px">upload</span>
          Ready to push
        </div>
        <button id="logs-push-btn"
          class="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-lg transition-all active:scale-95"
          style="background:#7c3aed;color:#fff">
          <span class="material-symbols-outlined" style="font-size:11px">upload</span>
          Push & Open PR
        </button>
      </div>`
                : ''
      }
    </div>

    ${
      logs.length === 0
        ? `
    <div class="flex flex-col items-center gap-3 py-10 text-center">
      <span class="material-symbols-outlined" style="font-size:36px;color:#c3c6d6">terminal</span>
      <p class="text-xs text-on-surface-variant/60">No agent run started yet.</p>
      <button id="logs-implement-btn"
        class="flex items-center gap-1.5 text-xs font-semibold text-on-primary px-4 py-2 rounded-lg transition-all active:scale-95"
        style="background:linear-gradient(135deg,#003d9b,#0052cc)">
        <span class="material-symbols-outlined" style="font-size:14px">play_arrow</span>
        Start Implementation
      </button>
    </div>`
        : `
    <div class="flex flex-col gap-0.5 font-mono text-[11px] rounded-xl overflow-hidden" style="background:#191c1e">
      ${logs
        .map((entry) => {
          const meta = logIcons[entry.type] ?? logIcons.progress;
          const ts = new Date(entry.ts).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });

          if (entry.type === 'delegation') {
            return `
          <div class="flex items-center gap-2 px-3 py-2" style="background:#1a1030;border-top:1px solid #2d1f52;border-bottom:1px solid #2d1f52">
            <span class="shrink-0 text-[9px]" style="color:#737685">${ts}</span>
            <span class="material-symbols-outlined shrink-0" style="font-size:13px;color:#7c3aed">swap_horiz</span>
            <span class="text-[10px] font-semibold" style="color:#c4b5fd">Handoff</span>
            <span class="text-[10px]" style="color:#a78bfa">${escHtml(entry.from ?? '')}</span>
            <span class="material-symbols-outlined" style="font-size:11px;color:#6d28d9">arrow_forward</span>
            <span class="text-[10px] font-semibold" style="color:#a78bfa">${escHtml(entry.to ?? '')}</span>
          </div>`;
          }

          const isReasoning = entry.type === 'reasoning';
          const isResult = entry.type === 'tool_result';

          // Extract clean text from garbled Python repr (stored logs from old backend)
          // Pattern: content=[TextContent(..., text='actual text here'...)]
          // The string may be truncated (no closing quote/bracket), so match greedily to end.
          const cleanMsg = (() => {
            const raw = entry.message ?? '';
            if (!raw.includes('TextContent(')) return raw;
            // Grab everything after text=' or text="
            const m = raw.match(/\btext=['"](.+)/s);
            if (!m) return raw;
            return (
              m[1]
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t')
                .replace(/\\'/g, "'")
                .replace(/\\"/g, '"')
                // strip ANSI: both literal \x1b and escaped \\x1b forms
                // eslint-disable-next-line no-control-regex
                .replace(/(?:\\x1b|\x1b)\[[0-9;?]*[a-zA-Z]/g, '')
                .replace(/['"\])\s]+$/, '') // trim trailing quote/bracket artifacts
                .trim()
            );
          })();

          // For tool_result: show first line + count, skip empty
          const displayMsg = isResult
            ? (() => {
                const lines = cleanMsg.split('\n').filter((l) => l.trim());
                if (!lines.length) return null;
                const first = lines[0].slice(0, 120);
                return first + (lines.length > 1 ? `  (+${lines.length - 1} lines)` : '');
              })()
            : cleanMsg;

          if (isResult && !displayMsg) return ''; // skip empty results

          const textColor = isReasoning
            ? '#ffb59b'
            : entry.type === 'done'
              ? '#6ee7a0'
              : entry.type === 'error'
                ? '#fca5a5'
                : entry.type === 'tool_call'
                  ? '#93c5fd'
                  : entry.type === 'info'
                    ? '#93c5fd'
                    : isResult
                      ? '#6b7280'
                      : '#d1d5db';
          return `
        <div class="flex gap-2 py-1 ${isResult ? 'pl-8 pr-3' : 'px-3 py-1.5'} ${isReasoning ? 'border-l-2' : ''}"
          style="${isReasoning ? 'border-color:#7b2600;background:#1e1208' : isResult ? 'opacity:0.75' : ''}">
          <span class="shrink-0 text-[9px] pt-0.5" style="color:#737685">${isResult ? '' : ts}</span>
          <span class="material-symbols-outlined shrink-0 ${entry.type === 'thinking' ? 'animate-spin' : ''}" style="font-size:${isResult ? '10' : '12'}px;color:${meta.color};margin-top:1px">${meta.icon}</span>
          <span class="flex-1 leading-relaxed ${isReasoning ? '' : 'break-all'} text-[10px]" style="color:${textColor}">
            ${
              entry.type === 'tool_call'
                ? `<span style="color:#93c5fd">${escHtml(entry.tool ?? '')}</span>${entry.path ? `  <span style="color:#737685">${escHtml(entry.path)}</span>` : ''}`
                : isReasoning
                  ? _formatReasoningMessage(entry.message)
                  : escHtml(displayMsg ?? '')
            }
          </span>
        </div>`;
        })
        .join('')}
    </div>`
    }

    ${
      suggestionStore.has(issue.number)
        ? `
    <button id="logs-goto-details-btn"
      class="w-full flex items-center justify-center gap-1.5 text-xs font-semibold py-2 rounded-lg transition-all active:scale-95"
      style="background:#dae2ff;color:#003d9b">
      <span class="material-symbols-outlined" style="font-size:14px">auto_fix_high</span>
      View AI Suggestion in Details
    </button>`
        : ''
    }
  `;

  const btn = $('logs-implement-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      triggerImplement(issue);
    });
  }

  const logsStopBtn = $('logs-stop-btn');
  if (logsStopBtn) {
    logsStopBtn.addEventListener('click', () => cancelRun(issue.number));
  }

  const logsPushBtn = $('logs-push-btn');
  if (logsPushBtn) {
    logsPushBtn.addEventListener('click', async () => {
      logsPushBtn.disabled = true;
      logsPushBtn.textContent = 'Pushing…';
      await pushRun(issue.number);
    });
  }

  const gotoBtn = $('logs-goto-details-btn');
  if (gotoBtn) {
    gotoBtn.addEventListener('click', () => {
      _drawerTab = 'details';
      _renderDrawerTabs();
      _renderDrawerBody();
    });
  }

  const body = $('drawer-body');
  body.scrollTop = body.scrollHeight;
}

// ── Suggestion card helper ────────────────────────────────────
function _renderSuggestionCard(issueNumber) {
  const suggestion = suggestionStore.get(issueNumber);
  if (!suggestion) return '';

  return `
    <div class="rounded-xl p-4 space-y-2" style="background:#fef3c7;border-left:3px solid #d97706">
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined" style="font-size:16px;color:#b45309">auto_awesome</span>
        <p class="text-[10px] font-bold uppercase tracking-widest" style="color:#b45309">AI Suggestion</p>
      </div>
      <p class="text-xs font-semibold text-on-surface">${escHtml(suggestion.title)}</p>
      <p class="text-[11px] text-on-surface-variant leading-relaxed">${escHtml(suggestion.description)}</p>
      ${
        suggestion.acceptance_criteria?.length
          ? `
      <ul class="text-[11px] space-y-0.5 text-on-surface-variant">
        ${suggestion.acceptance_criteria.map((c) => `<li class="flex items-start gap-1"><span style="color:#b45309">✓</span> ${escHtml(c)}</li>`).join('')}
      </ul>`
          : ''
      }
      <div class="flex items-center gap-2 pt-1">
        <button data-apply-suggestion
          class="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-md transition-colors active:scale-95"
          style="background:#d97706;color:#fff">
          <span class="material-symbols-outlined" style="font-size:11px">cloud_upload</span>Apply to GitHub
        </button>
        <button data-copy-suggestion
          class="text-[10px] font-semibold text-primary hover:underline flex items-center gap-1">
          <span class="material-symbols-outlined" style="font-size:11px">content_copy</span>Copy Markdown
        </button>
      </div>
      <p id="apply-suggestion-status-${issueNumber}" class="text-[10px] hidden"></p>
    </div>`;
}

// ── Init ─────────────────────────────────────────────────────
export function initDrawer() {
  $('drawer-close').addEventListener('click', closeDrawer);
  drawerBack.addEventListener('click', closeDrawer);

  ['details', 'ai', 'logs'].forEach((t) => {
    $(`tab-${t}`).addEventListener('click', () => {
      _drawerTab = t;
      _renderDrawerTabs();
      _renderDrawerBody();
    });
  });
}
