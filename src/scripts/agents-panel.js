import { escHtml } from '../lib/formatters.js';
import { getAgents, saveAgent, removeAgent } from '../lib/agents.js';
import { runStore, pingMcpServer } from '../lib/implementer.js';
import { PROVIDERS, SAMPLING_PROFILES, PROVIDER_ENDPOINTS } from '../lib/constants.js';
import { AGENT_BASE_URL } from '../lib/config.js';
import { renderBoard } from '../lib/board.js';
import { state } from './state.js';
import { getFilters } from './board-loader.js';

const $ = (id) => document.getElementById(id);

const agentsPanel = $('agents-panel');

let wizardStep = 1;
let agentMcpList = []; // [{id, name, url, transport, token}]

// ── Panel open/close ─────────────────────────────────────────
function closeAgentsPanel() {
  agentsPanel.classList.add('hidden');
  agentsPanel.classList.remove('flex');
}

export function renderAgentsPanel() {
  const agents = getAgents();
  const list = $('agents-list');
  list.className = 'grid grid-cols-3 gap-4';
  list.innerHTML = '';
  $('agent-form-wrap').classList.add('hidden');

  $('agents-count').textContent = agents.length;

  const banner = $('cost-health-banner');
  if (agents.length > 0) {
    const activeRuns = [...runStore.values()].filter((r) => r.status === 'running').length;
    const doneRuns = [...runStore.values()].filter((r) => r.status === 'done').length;
    const sessionCost = [...runStore.values()].reduce((s, r) => s + (r.cost?.estimatedUsd ?? 0), 0);
    const costFrag = sessionCost > 0
      ? `<span class="text-on-surface-variant">·</span>
         <span class="font-mono font-semibold" style="color:#7c3aed">~${_fmtCost(sessionCost)} est.</span>`
      : '';
    banner.classList.remove('hidden');
    banner.innerHTML = `
      <span class="flex items-center gap-1.5 font-semibold" style="color:${activeRuns > 0 ? '#16a34a' : '#737885'}">
        <span class="inline-block w-2 h-2 rounded-full" style="background:${activeRuns > 0 ? '#16a34a' : '#c3c6d6'}"></span>
        ${activeRuns} active
      </span>
      <span class="text-on-surface-variant">·</span>
      <span class="text-on-surface font-medium">${doneRuns} completed this session</span>
      <span class="text-on-surface-variant">·</span>
      <span class="text-on-surface-variant">${agents.length} agent${agents.length !== 1 ? 's' : ''} configured</span>
      ${costFrag}
    `;
  } else {
    banner.classList.add('hidden');
  }

  // "Create New Agent" CTA card
  const ctaCard = document.createElement('div');
  ctaCard.className = 'agent-grid-card-cta';
  ctaCard.style.cssText =
    'background:#fafbff;border:2px dashed #c7d2fe;border-radius:16px;min-height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;cursor:pointer;transition:all 0.2s ease;';
  ctaCard.addEventListener('mouseenter', () => {
    ctaCard.style.borderColor = '#003d9b';
    ctaCard.style.background = '#eff6ff';
    ctaCard.style.transform = 'translateY(-2px)';
  });
  ctaCard.addEventListener('mouseleave', () => {
    ctaCard.style.borderColor = '#c7d2fe';
    ctaCard.style.background = '#fafbff';
    ctaCard.style.transform = '';
  });
  ctaCard.innerHTML = `
  <div style="width:56px;height:56px;border-radius:50%;background:#003d9b;display:flex;align-items:center;justify-content:center;margin-bottom:4px;">
    <span style="font-family:'Material Symbols Outlined';font-variation-settings:'FILL' 0,'wght' 300,'GRAD' 0,'opsz' 24;font-size:28px;color:#fff;line-height:1;">add</span>
  </div>
  <p style="font-size:13px;font-weight:700;color:#111827;margin:0;">New Agent</p>
  <p style="font-size:11px;color:#9ca3af;margin:2px 0 0;text-align:center;">Set up a new AI agent.</p>
`;
  ctaCard.addEventListener('click', () => openAgentForm(null));
  list.appendChild(ctaCard);

  agents.forEach((agent) => {
    const provColor =
      { claude: '#FF6B2B', copilot: '#24292E', openai: '#10A37F' }[agent.provider] ?? '#003d9b';
    const provBg =
      { claude: '#FFF0EA', copilot: '#F0F2F4', openai: '#E6F9F4' }[agent.provider] ?? '#dae2ff';
    const abbrev = agent.name
      .replace(/Agent$/i, '')
      .slice(0, 2)
      .toUpperCase();
    const autonomy = agent.autonomy ?? 'assist';
    const model = agent.model?.split('-').slice(0, 2).join('-') || '—';
    const mcpCount = agent.mcpServers?.length ?? 0;

    const card = document.createElement('div');
    card.className = 'agent-grid-card';
    card.style.cssText =
      'background:#ffffff;border:1px solid #e8eaed;border-radius:16px;box-shadow:0 1px 4px rgba(0,0,0,0.05),0 2px 12px rgba(0,0,0,0.03);display:flex;flex-direction:column;overflow:hidden;position:relative;transition:box-shadow 0.2s,transform 0.18s,border-color 0.2s;';
    card.addEventListener('mouseenter', () => {
      card.style.boxShadow = '0 8px 32px rgba(0,0,0,0.11),0 2px 8px rgba(0,0,0,0.06)';
      card.style.transform = 'translateY(-3px)';
      card.style.borderColor = '#d1d5db';
    });
    card.addEventListener('mouseleave', () => {
      card.style.boxShadow = '0 1px 4px rgba(0,0,0,0.05),0 2px 12px rgba(0,0,0,0.03)';
      card.style.transform = '';
      card.style.borderColor = '#e8eaed';
    });
    card.innerHTML = `
  <div style="padding:16px 16px 0;display:flex;align-items:center;gap:10px;">
    <div style="width:36px;height:36px;border-radius:8px;background:${provBg};color:${provColor};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;flex-shrink:0;letter-spacing:-0.5px;">${escHtml(abbrev)}</div>
    <p style="font-size:13px;font-weight:700;color:#111827;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0;">${escHtml(agent.name)}</p>
    <span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;padding:3px 8px;border-radius:999px;background:#dcfce7;color:#15803d;flex-shrink:0;">
      <span style="width:5px;height:5px;border-radius:50%;background:#15803d;display:inline-block;"></span>Active
    </span>
  </div>
  <p style="font-size:12px;color:#6b7280;line-height:1.6;margin:10px 16px 0;flex:1;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escHtml(agent.description || 'No description provided.')}</p>
  <div style="padding:10px 16px 0;">
    <p style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#9ca3af;margin:0 0 6px;">LLM</p>
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
      <span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;background:${provBg};color:${provColor};">${escHtml(model)}</span>
      <span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;background:#f3f4f6;color:#6b7280;">${escHtml(autonomy)}</span>
      ${mcpCount > 0 ? `<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;background:#f5f3ff;color:#7c3aed;">⚡ ${mcpCount} MCP</span>` : ''}
    </div>
  </div>
  <div style="padding:12px 16px;margin-top:12px;border-top:1px solid #f3f4f6;display:flex;align-items:center;gap:8px;">
    <button data-edit="${agent.id}" style="flex:1;font-size:12px;font-weight:600;padding:7px 0;border-radius:8px;border:none;cursor:pointer;background:#003d9b;color:#fff;">Edit</button>
    <button data-remove="${agent.id}" style="font-size:12px;font-weight:600;padding:7px 14px;border-radius:8px;border:1px solid #e5e7eb;cursor:pointer;background:#fff;color:#6b7280;">Delete</button>
  </div>
`;
    card.querySelector('[data-edit]').addEventListener('click', (e) => {
      e.stopPropagation();
      openAgentForm(agent);
    });
    card.querySelector('[data-remove]').addEventListener('click', (e) => {
      e.stopPropagation();
      removeAgent(agent.id);
      renderAgentsPanel();
      if (state.allIssues.length) renderBoard(getFilters);
    });
    list.appendChild(card);
  });
}

// ── Agent wizard ──────────────────────────────────────────────
function openAgentForm(agent) {
  $('agent-form-id').value = agent?.id ?? '';
  $('agent-form-name').value = agent?.name ?? '';
  $('agent-form-endpoint').value = agent?.endpoint ?? AGENT_BASE_URL;
  $('agent-form-desc').value = agent?.description ?? '';
  $('agent-form-apikey').value = agent?.apiKey ?? '';
  $('agent-form-purpose').value = agent?.purpose ?? '';
  $('agent-form-systemprompt').value = agent?.systemPrompt ?? '';
  $('agent-form-guardrail-always').value = agent?.guardrailsAlways ?? '';
  $('agent-form-guardrail-never').value = agent?.guardrailsNever ?? '';

  agentMcpList = agent?.mcpServers ? agent.mcpServers.map((m) => ({ ...m })) : [];
  _renderAgentMcpList();

  const prov = agent?.provider ?? 'claude';
  _setProviderPills('#agent-provider-pills', prov);
  _refreshModelDropdown('agent-form-model', prov, agent?.model);
  // Pre-fill API base URL: use saved value, or fall back to known provider default
  const llmBaseUrlInput = $('agent-form-llm-base-url');
  if (llmBaseUrlInput) {
    llmBaseUrlInput.value = agent?.llmBaseUrl ?? PROVIDER_ENDPOINTS[prov] ?? '';
  }

  const fbProv = agent?.fallbackProvider ?? 'openai';
  _setProviderPills('#agent-fallback-provider-pills', fbProv);
  _refreshFallbackModelDropdown(fbProv, agent?.fallbackModel);

  document
    .querySelectorAll('#agent-form-sampling .sampling-pill')
    .forEach((btn) =>
      btn.classList.toggle('active', btn.dataset.profile === (agent?.sampling ?? 'balanced'))
    );
  document
    .querySelectorAll('[data-autonomy]')
    .forEach((btn) =>
      btn.classList.toggle('active', btn.dataset.autonomy === (agent?.autonomy ?? 'assist'))
    );
  document.querySelectorAll('#agent-form-lanes input[type=checkbox]').forEach((cb) => {
    cb.checked = (agent?.lanes ?? []).includes(cb.value);
  });
  const rp = agent?.reasoningPattern ?? '';
  document
    .querySelectorAll('.reasoning-pattern-pill')
    .forEach((btn) => btn.classList.toggle('active', btn.dataset.pattern === rp));

  document.querySelectorAll('.agent-tpl-card').forEach((c) => c.classList.remove('active'));

  const banner = $('cost-health-banner');
  if (getAgents().length > 0) banner.classList.remove('hidden');
  else banner.classList.add('hidden');

  wizardStep = 1;
  renderWizardStep(wizardStep);
  $('agent-form-wrap').classList.remove('hidden');
  $('agents-list').classList.add('hidden');
}

function renderWizardStep(step) {
  document.querySelectorAll('.wizard-tab').forEach((t) => {
    t.classList.toggle('active', Number(t.dataset.step) === step);
  });
  document.querySelectorAll('.wizard-step').forEach((el) => {
    el.classList.toggle('hidden', el.id !== `wizard-step-${step}`);
  });
  const backBtn = $('wizard-back');
  backBtn.style.visibility = step === 1 ? 'hidden' : 'visible';
  const nextBtn = $('wizard-next');
  if (step === 5) {
    nextBtn.textContent = $('agent-form-id').value ? 'Save Agent' : 'Create Agent';
    _renderWizardReview();
  } else {
    nextBtn.textContent = 'Next';
  }
  const nameVal = $('agent-form-name').value;
  $('preview-agent-name').textContent = nameVal || 'New Agent';
  const descVal = $('agent-form-desc').value;
  if (descVal) $('preview-agent-desc').textContent = `"${descVal}"`;

  const promptPreview = $('preview-prompt-structure');
  if (step === 2) {
    promptPreview.classList.remove('hidden');
    const promptLen = $('agent-form-systemprompt').value.length;
    $('prompt-char-count').textContent = `${promptLen} chars`;
  } else {
    promptPreview.classList.add('hidden');
  }

  const stepToPhase = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 4 };
  const currentPhase = stepToPhase[step];
  document.querySelectorAll('.wizard-phase').forEach((phaseEl) => {
    const ph = Number(phaseEl.dataset.phase);
    if (ph < currentPhase) {
      phaseEl.dataset.state = 'complete';
      phaseEl.querySelector('.wizard-phase-status').textContent = 'COMPLETE';
    } else if (ph === currentPhase) {
      phaseEl.dataset.state = 'current';
      phaseEl.querySelector('.wizard-phase-status').textContent = 'CURRENT';
    } else {
      delete phaseEl.dataset.state;
      phaseEl.querySelector('.wizard-phase-status').textContent = 'UPCOMING';
    }
  });

  const pct = Math.round((step / 5) * 100);
  const progressBar = $('wizard-progress-bar');
  const progressPct = $('wizard-progress-pct');
  const progressLabel = $('wizard-progress-step-label');
  if (progressBar) progressBar.style.width = `${pct}%`;
  if (progressPct) progressPct.textContent = pct;
  if (progressLabel) progressLabel.textContent = `Step ${step} of 5`;

  const SUBNAV_ITEMS = {
    1: [
      { label: 'Agent Profile', hasData: () => !!$('agent-form-name').value.trim() },
      { label: 'Routing Description', hasData: () => !!$('agent-form-desc').value.trim() },
    ],
    2: [
      {
        label: 'Reasoning Pattern',
        hasData: () => !!document.querySelector('.reasoning-pattern-pill.active'),
      },
      { label: 'System Prompt', hasData: () => !!$('agent-form-systemprompt').value.trim() },
      { label: 'Connection', hasData: () => !!$('agent-form-endpoint').value.trim() },
      { label: 'MCP Tools', hasData: () => agentMcpList.length > 0 },
    ],
    3: [
      {
        label: 'Primary Provider',
        hasData: () => !!document.querySelector('#agent-provider-pills .provider-pill.active'),
      },
      {
        label: 'Fallback',
        hasData: () =>
          !!document.querySelector('#agent-fallback-provider-pills .provider-pill.active'),
      },
      {
        label: 'Sampling',
        hasData: () => !!document.querySelector('#agent-form-sampling .sampling-pill.active'),
      },
    ],
    4: [
      {
        label: 'Assigned Lanes',
        hasData: () => document.querySelectorAll('#agent-form-lanes input:checked').length > 0,
      },
      {
        label: 'Autonomy Level',
        hasData: () => !!document.querySelector('[data-autonomy].active'),
      },
      {
        label: 'Guardrails',
        hasData: () =>
          !!(
            $('agent-form-guardrail-always')?.value.trim() ||
            $('agent-form-guardrail-never')?.value.trim()
          ),
      },
      { label: 'Review', hasData: () => false },
    ],
  };
  const subnav = $('wizard-subnav');
  if (subnav) {
    const items = SUBNAV_ITEMS[currentPhase] ?? [];
    const phaseOffsets = { 1: 0, 2: 2, 3: 5, 4: 8 };
    const offset = phaseOffsets[currentPhase] ?? 0;
    subnav.innerHTML = items
      .map((item, i) => {
        const num = String(offset + i + 1).padStart(2, '0');
        const hasData = item.hasData();
        return `
        <div class="wizard-subnav-item${i === 0 ? ' active' : ''}${hasData ? ' has-data' : ''}">
          <span class="subnav-num">${hasData ? '' : num}</span>
          <span class="flex-1">${escHtml(item.label)}</span>
          <span class="material-symbols-outlined subnav-check">check_circle</span>
        </div>
      `;
      })
      .join('');
  }
}

function _renderWizardReview() {
  const provider =
    document.querySelector('#agent-provider-pills .provider-pill.active')?.dataset.provider ??
    'claude';
  const fbProvider =
    document.querySelector('#agent-fallback-provider-pills .provider-pill.active')?.dataset
      .fbProvider ?? 'openai';
  const sampling =
    document.querySelector('#agent-form-sampling .sampling-pill.active')?.dataset.profile ??
    'balanced';
  const autonomy = document.querySelector('[data-autonomy].active')?.dataset.autonomy ?? 'assist';
  const lanes = [
    ...document.querySelectorAll('#agent-form-lanes input[type=checkbox]:checked'),
  ].map((c) => c.value);
  const pattern = document.querySelector('.reasoning-pattern-pill.active')?.dataset.pattern ?? '';
  const promptLen = $('agent-form-systemprompt').value.length;
  const always = $('agent-form-guardrail-always').value.trim();
  const never = $('agent-form-guardrail-never').value.trim();

  const rows = [
    ['Name', $('agent-form-name').value || '—'],
    ['Storefront', $('agent-form-desc').value || '—'],
    ['Purpose', $('agent-form-purpose').value || '—'],
    ['Pattern', pattern || 'none'],
    ['Prompt', promptLen ? `${promptLen} chars` : '(empty)'],
    ['Provider', `${PROVIDERS[provider]?.emoji ?? ''} ${PROVIDERS[provider]?.name ?? provider}`],
    ['Model', $('agent-form-model').value || '—'],
    [
      'Fallback',
      `${PROVIDERS[fbProvider]?.emoji ?? ''} ${$('agent-form-fallback-model').value || '—'}`,
    ],
    ['Sampling', SAMPLING_PROFILES[sampling]?.label ?? sampling],
    ['Endpoint', $('agent-form-endpoint').value || '—'],
    ['Lanes', lanes.join(', ') || 'none'],
    ['Autonomy', autonomy],
    ['Always', always || '(none)'],
    ['Never', never || '(none)'],
  ];

  $('wizard-review-summary').innerHTML = rows
    .map(
      ([k, v]) => `
    <div class="flex gap-3 py-1.5" style="border-bottom:1px solid rgba(195,198,214,0.15)">
      <span class="w-24 flex-shrink-0 font-semibold text-on-surface-variant/70 text-[10px] uppercase tracking-wide">${k}</span>
      <span class="text-on-surface text-[11px] whitespace-pre-wrap break-all">${escHtml(String(v))}</span>
    </div>
  `
    )
    .join('');
}

function _setProviderPills(containerSelector, provider) {
  document.querySelectorAll(`${containerSelector} .provider-pill`).forEach((btn) => {
    const val = btn.dataset.provider ?? btn.dataset.fbProvider;
    btn.classList.toggle('active', val === provider);
  });
}

function _refreshModelDropdown(selectId, provider, current) {
  const sel = $(selectId);
  const models = PROVIDERS[provider]?.models ?? [];
  sel.innerHTML = models
    .map((m) => `<option value="${m}"${m === current ? ' selected' : ''}>${m}</option>`)
    .join('');
}

function _refreshFallbackModelDropdown(provider, current) {
  _refreshModelDropdown('agent-form-fallback-model', provider, current);
}

function _saveAgentFromWizard() {
  const name = $('agent-form-name').value.trim();
  if (!name) {
    wizardStep = 1;
    renderWizardStep(1);
    alert('Agent name is required');
    return;
  }

  const provider =
    document.querySelector('#agent-provider-pills .provider-pill.active')?.dataset.provider ??
    'claude';
  const fallbackProvider =
    document.querySelector('#agent-fallback-provider-pills .provider-pill.active')?.dataset
      .fbProvider ?? 'openai';
  const sampling =
    document.querySelector('#agent-form-sampling .sampling-pill.active')?.dataset.profile ??
    'balanced';
  const autonomy = document.querySelector('[data-autonomy].active')?.dataset.autonomy ?? 'assist';
  const lanes = [
    ...document.querySelectorAll('#agent-form-lanes input[type=checkbox]:checked'),
  ].map((c) => c.value);
  const reasoningPattern =
    document.querySelector('.reasoning-pattern-pill.active')?.dataset.pattern ?? '';

  saveAgent({
    id: $('agent-form-id').value || `agent_${Date.now()}`,
    name,
    description: $('agent-form-desc').value,
    purpose: $('agent-form-purpose').value,
    systemPrompt: $('agent-form-systemprompt').value,
    reasoningPattern,
    guardrailsAlways: $('agent-form-guardrail-always').value,
    guardrailsNever: $('agent-form-guardrail-never').value,
    provider,
    model: $('agent-form-model').value,
    fallbackProvider,
    fallbackModel: $('agent-form-fallback-model').value,
    sampling,
    apiKey: $('agent-form-apikey').value,
    llmBaseUrl: $('agent-form-llm-base-url')?.value.trim() || undefined,
    endpoint: $('agent-form-endpoint').value,
    lanes,
    actionType: lanes.includes('triage') ? 'refine' : 'implement',
    autonomy,
    mcpServers: [...agentMcpList],
  });

  $('agent-form-wrap').classList.add('hidden');
  renderAgentsPanel();
  if (state.allIssues.length) renderBoard(getFilters);
}

// ── Agent MCP helpers ─────────────────────────────────────────

function _fmtCost(usd) {
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  if (usd < 0.01)  return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

let _agentMcpTransport = 'sse';

function _renderAgentMcpList() {
  const container = $('agent-mcp-list');
  const empty = $('agent-mcp-empty');
  if (!container) return;
  container.querySelectorAll('.agent-mcp-chip').forEach((el) => el.remove());
  if (agentMcpList.length === 0) {
    if (empty) empty.classList.remove('hidden');
  } else {
    if (empty) empty.classList.add('hidden');
    agentMcpList.forEach((mcp) => {
      const chip = document.createElement('div');
      chip.className =
        'agent-mcp-chip flex items-center justify-between gap-2 px-3 py-2 rounded-lg';
      chip.style.cssText = 'background:#f3e8ff;border:1px solid rgba(124,58,237,0.2)';
      chip.innerHTML = `
        <div class="flex items-center gap-2 min-w-0">
          <span class="material-symbols-outlined flex-shrink-0" style="font-size:13px;color:#7c3aed">electrical_services</span>
          <div class="min-w-0">
            <p class="text-[10px] font-bold truncate" style="color:#4c1d95">${escHtml(mcp.name)}</p>
            <p class="text-[9px] font-mono truncate" style="color:#7c3aed">${escHtml(mcp.url)}</p>
          </div>
          <span class="text-[8px] font-bold px-1.5 py-0.5 rounded flex-shrink-0"
                style="background:rgba(124,58,237,0.12);color:#7c3aed">${escHtml(mcp.transport.toUpperCase())}</span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button data-mcp-test="${escHtml(mcp.id)}" title="Test connection"
            class="w-5 h-5 rounded flex items-center justify-center hover:bg-purple-100 transition-colors">
            <span class="material-symbols-outlined" style="font-size:12px;color:#7c3aed">wifi_tethering</span>
          </button>
          <button data-mcp-remove="${escHtml(mcp.id)}"
            class="w-5 h-5 rounded flex items-center justify-center hover:bg-red-100 transition-colors">
            <span class="material-symbols-outlined" style="font-size:12px;color:#ba1a1a">close</span>
          </button>
        </div>
      `;
      chip.querySelector('[data-mcp-test]').addEventListener('click', async () => {
        const icon = chip.querySelector('[data-mcp-test] .material-symbols-outlined');
        icon.textContent = 'sync';
        icon.style.color = '#9ca3af';
        const result = await pingMcpServer(mcp.url);
        if (result.ok) {
          icon.textContent = 'check_circle';
          icon.style.color = '#16a34a';
        } else {
          icon.textContent = 'error';
          icon.style.color = '#ba1a1a';
          chip.querySelector('[data-mcp-test]').title = result.error ?? 'Unreachable';
        }
      });
      chip.querySelector('[data-mcp-remove]').addEventListener('click', () => {
        agentMcpList = agentMcpList.filter((m) => m.id !== mcp.id);
        _renderAgentMcpList();
      });
      container.appendChild(chip);
    });
  }
}

// ── Init ─────────────────────────────────────────────────────
export function initAgentsPanel() {
  $('agents-btn').addEventListener('click', () => {
    agentsPanel.classList.remove('hidden');
    agentsPanel.classList.add('flex');
    renderAgentsPanel();
  });
  $('agents-panel-close').addEventListener('click', closeAgentsPanel);
  $('add-agent-btn').addEventListener('click', () => openAgentForm(null));

  // Provider pill clicks
  document.querySelectorAll('#agent-provider-pills .provider-pill').forEach((btn) =>
    btn.addEventListener('click', () => {
      const provider = btn.dataset.provider;
      _setProviderPills('#agent-provider-pills', provider);
      _refreshModelDropdown('agent-form-model', provider);
      // Pre-fill API base URL if it's empty or still a known provider default
      const llmBaseUrlInput = $('agent-form-llm-base-url');
      if (llmBaseUrlInput) {
        const knownUrls = new Set(Object.values(PROVIDER_ENDPOINTS));
        const current = llmBaseUrlInput.value.trim();
        if (!current || knownUrls.has(current)) {
          llmBaseUrlInput.value = PROVIDER_ENDPOINTS[provider] ?? '';
        }
      }
    })
  );
  document.querySelectorAll('#agent-fallback-provider-pills .provider-pill').forEach((btn) =>
    btn.addEventListener('click', () => {
      _setProviderPills('#agent-fallback-provider-pills', btn.dataset.fbProvider);
      _refreshFallbackModelDropdown(btn.dataset.fbProvider);
    })
  );

  // Template card clicks
  document.querySelectorAll('.agent-tpl-card').forEach((card) =>
    card.addEventListener('click', () => {
      document.querySelectorAll('.agent-tpl-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      const { name, desc, purpose, prompt } = card.dataset;
      if (name) $('agent-form-name').value = name;
      if (desc) $('agent-form-desc').value = desc;
      if (purpose) $('agent-form-purpose').value = purpose;
      if (prompt) {
        const decoded = prompt.replace(/\\n/g, '\n');
        $('agent-form-systemprompt').value = decoded;
        $('prompt-char-count').textContent = `${decoded.length} chars`;
      }
      $('preview-agent-name').textContent = name || 'New Agent';
      if (purpose) $('preview-agent-desc').textContent = `"${purpose}"`;
      else if (desc) $('preview-agent-desc').textContent = `"${desc}"`;
    })
  );

  // Reasoning pattern pill clicks
  document.querySelectorAll('.reasoning-pattern-pill').forEach((btn) =>
    btn.addEventListener('click', () => {
      document
        .querySelectorAll('.reasoning-pattern-pill')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const patternMap = {
        'analyze-validate-report': 'Analyze → Validate → Report',
        'observe-plan-act': 'Observe → Plan → Act',
        'gather-synthesize-output': 'Gather → Synthesize → Output',
      };
      const label = patternMap[btn.dataset.pattern];
      $('preview-pattern-label').textContent = label ?? 'Custom pattern';
    })
  );

  // Live char count on system prompt
  $('agent-form-systemprompt').addEventListener('input', () => {
    $('prompt-char-count').textContent = `${$('agent-form-systemprompt').value.length} chars`;
  });

  // Sampling pill clicks
  document.querySelectorAll('#agent-form-sampling .sampling-pill').forEach((btn) =>
    btn.addEventListener('click', () => {
      document
        .querySelectorAll('#agent-form-sampling .sampling-pill')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    })
  );

  // Autonomy clicks
  document.querySelectorAll('[data-autonomy]').forEach((btn) =>
    btn.addEventListener('click', () => {
      btn
        .closest('div')
        .querySelectorAll('[data-autonomy]')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    })
  );

  // Wizard next / back
  $('wizard-next').addEventListener('click', () => {
    if (wizardStep < 5) {
      wizardStep++;
      renderWizardStep(wizardStep);
    } else {
      _saveAgentFromWizard();
    }
  });
  $('wizard-back').addEventListener('click', () => {
    if (wizardStep > 1) {
      wizardStep--;
      renderWizardStep(wizardStep);
    }
  });
  $('agent-form-cancel').addEventListener('click', () => {
    $('agent-form-wrap').classList.add('hidden');
    $('agents-list').classList.remove('hidden');
  });

  // Agent MCP inline form
  $('agent-mcp-add-btn').addEventListener('click', () => {
    $('agent-mcp-form').classList.remove('hidden');
    $('agent-mcp-name').value = '';
    $('agent-mcp-url').value = '';
    $('agent-mcp-token').value = '';
    _agentMcpTransport = 'sse';
    document.querySelectorAll('.agent-mcp-transport').forEach((b) => {
      const active = b.dataset.transport === 'sse';
      b.style.background = active ? '#f3e8ff' : '#fff';
      b.style.color = active ? '#7c3aed' : '#737885';
      b.style.borderColor = active ? 'rgba(124,58,237,0.4)' : 'rgba(195,198,214,0.5)';
    });
  });
  $('agent-mcp-cancel-btn').addEventListener('click', () => {
    $('agent-mcp-form').classList.add('hidden');
  });
  document.querySelectorAll('.agent-mcp-transport').forEach((btn) =>
    btn.addEventListener('click', () => {
      _agentMcpTransport = btn.dataset.transport;
      document.querySelectorAll('.agent-mcp-transport').forEach((b) => {
        const active = b === btn;
        b.style.background = active ? '#f3e8ff' : '#fff';
        b.style.color = active ? '#7c3aed' : '#737885';
        b.style.borderColor = active ? 'rgba(124,58,237,0.4)' : 'rgba(195,198,214,0.5)';
      });
    })
  );
  $('agent-mcp-save-btn').addEventListener('click', () => {
    const name = $('agent-mcp-name').value.trim();
    const url = $('agent-mcp-url').value.trim();
    if (!name || !url) {
      if (!name) $('agent-mcp-name').focus();
      else $('agent-mcp-url').focus();
      return;
    }
    agentMcpList.push({
      id: `mcp_${Date.now()}`,
      name,
      url,
      transport: _agentMcpTransport,
      token: $('agent-mcp-token').value.trim(),
    });
    $('agent-mcp-form').classList.add('hidden');
    _renderAgentMcpList();
  });
}
