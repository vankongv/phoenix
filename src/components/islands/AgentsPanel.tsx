/**
 * AgentsPanel — Preact island
 *
 * Replaces agents-panel.js + AgentsPanel.astro shell.
 * 5-step wizard for creating/editing AI agents, with a live agent grid.
 */
import { useState } from 'preact/hooks';
import {
  agentsSignal,
  agentsPanelOpenSignal,
  saveAgent,
  removeAgent,
  runsSignal,
} from '../../lib/signals.js';
import { PROVIDERS, SAMPLING_PROFILES, PROVIDER_ENDPOINTS } from '../../lib/constants.js';
import { AGENT_BASE_URL } from '../../lib/config.js';
import { getGlobalAiKey } from '../../lib/agents.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface McpServer { id: string; name: string; url: string; transport: string; token: string }

interface AgentForm {
  id: string; name: string; description: string; purpose: string;
  systemPrompt: string; reasoningPattern: string;
  guardrailsAlways: string; guardrailsNever: string;
  provider: string; model: string;
  fallbackProvider: string; fallbackModel: string;
  sampling: string; apiKey: string; llmBaseUrl: string; endpoint: string;
  lanes: string[]; autonomy: string; mcpServers: McpServer[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const EMPTY_FORM: AgentForm = {
  id: '', name: '', description: '', purpose: '',
  systemPrompt: '', reasoningPattern: '',
  guardrailsAlways: '', guardrailsNever: '',
  provider: 'claude', model: (PROVIDERS as any).claude.models[0],
  fallbackProvider: 'openai', fallbackModel: (PROVIDERS as any).openai.models[0],
  sampling: 'balanced', apiKey: '', llmBaseUrl: (PROVIDER_ENDPOINTS as any).claude,
  endpoint: AGENT_BASE_URL, lanes: [], autonomy: 'assist', mcpServers: [],
};

const TEMPLATES = [
  { icon: 'code', color: '#003d9b', label: 'Code Reviewer', sub: 'Optimization & debugging',
    name: 'CodeReviewerAgent',
    desc: 'Reviews PRs against acceptance criteria. Does NOT write code or approve merges.',
    purpose: 'Ensure code quality gates are met before merge.',
    prompt: '[Identity]\nYou are a senior code reviewer...\n\n[Reasoning Loop]\nFollow: Analyze → Validate → Report\n\n[Guardrails]\nAlways: Cite specific line numbers\nNever: Approve a PR with failing tests' },
  { icon: 'bar_chart', color: '#7c3aed', label: 'Data Analyst', sub: 'Statistical insights',
    name: 'DataAnalystAgent',
    desc: 'Analyzes issue data and generates insight reports. Does NOT modify code or close issues.',
    purpose: 'Surface patterns and priorities from incoming issues.',
    prompt: '[Identity]\nYou are a data analyst...\n\n[Reasoning Loop]\nFollow: Gather → Synthesize → Output\n\n[Guardrails]\nAlways: Include confidence scores\nNever: Modify issue state directly' },
  { icon: 'security', color: '#b45309', label: 'Security Auditor', sub: 'Vuln detection',
    name: 'SecurityAuditorAgent',
    desc: 'Audits code and dependencies for security vulnerabilities. Does NOT auto-patch.',
    purpose: 'Identify and report security risks before they reach production.',
    prompt: '[Identity]\nYou are a security auditor...\n\n[Reasoning Loop]\nFollow: Observe → Assess → Report\n\n[Guardrails]\nAlways: Include CVE references\nNever: Apply patches autonomously' },
  { icon: 'add_circle', color: '#737885', label: 'Custom', sub: 'Build from scratch',
    name: '', desc: '', purpose: '', prompt: '' },
];

const LANES = [
  { value: 'triage',      label: 'Triage' },
  { value: 'todo',        label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'in_review',   label: 'In Review' },
];

// ── Main component ────────────────────────────────────────────────────────────

export default function AgentsPanel() {
  const [showForm, setShowForm]       = useState(false);
  const [form, setForm]               = useState<AgentForm>(EMPTY_FORM);
  const [step, setStep]               = useState(1);
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [mcpDraft, setMcpDraft]       = useState({ name: '', url: '', transport: 'sse', token: '' });

  // Signal subscriptions
  const isOpen  = agentsPanelOpenSignal.value;
  const agents  = agentsSignal.value as any[];
  const runs    = runsSignal.value as Map<number, any>;

  if (!isOpen) return null;

  // ── Form helpers ─────────────────────────────────────────────────────────────
  function patchForm(patch: Partial<AgentForm>) { setForm(f => ({ ...f, ...patch })); }

  function openForm(agent?: any) {
    if (agent) {
      setForm({
        id: agent.id ?? '', name: agent.name ?? '', description: agent.description ?? '',
        purpose: agent.purpose ?? '', systemPrompt: agent.systemPrompt ?? '',
        reasoningPattern: agent.reasoningPattern ?? '',
        guardrailsAlways: agent.guardrailsAlways ?? '', guardrailsNever: agent.guardrailsNever ?? '',
        provider: agent.provider ?? 'claude', model: agent.model ?? '',
        fallbackProvider: agent.fallbackProvider ?? 'openai', fallbackModel: agent.fallbackModel ?? '',
        sampling: agent.sampling ?? 'balanced', apiKey: agent.apiKey ?? '',
        llmBaseUrl: agent.llmBaseUrl ?? (PROVIDER_ENDPOINTS as any)[agent.provider ?? 'claude'] ?? '',
        endpoint: agent.endpoint ?? AGENT_BASE_URL, lanes: agent.lanes ?? [], autonomy: agent.autonomy ?? 'assist',
        mcpServers: agent.mcpServers ? agent.mcpServers.map((m: any) => ({ ...m })) : [],
      });
    } else {
      setForm({ ...EMPTY_FORM, id: '' });
    }
    setStep(1);
    setMcpFormOpen(false);
    setShowForm(true);
  }

  function handleSave() {
    if (!form.name.trim()) { setStep(1); alert('Agent name is required'); return; }
    saveAgent({
      id: form.id || `agent_${Date.now()}`,
      name: form.name, description: form.description, purpose: form.purpose,
      systemPrompt: form.systemPrompt, reasoningPattern: form.reasoningPattern,
      guardrailsAlways: form.guardrailsAlways, guardrailsNever: form.guardrailsNever,
      provider: form.provider, model: form.model,
      fallbackProvider: form.fallbackProvider, fallbackModel: form.fallbackModel,
      sampling: form.sampling, apiKey: form.apiKey,
      llmBaseUrl: form.llmBaseUrl || undefined, endpoint: form.endpoint,
      lanes: form.lanes,
      actionType: form.lanes.includes('triage') ? 'refine' : 'implement',
      autonomy: form.autonomy, mcpServers: [...form.mcpServers],
    });
    setShowForm(false);
  }

  function toggleLane(lane: string) {
    patchForm({
      lanes: form.lanes.includes(lane)
        ? form.lanes.filter(l => l !== lane)
        : [...form.lanes, lane],
    });
  }

  function addMcp() {
    if (!mcpDraft.name || !mcpDraft.url) return;
    patchForm({ mcpServers: [...form.mcpServers, { id: `mcp_${Date.now()}`, ...mcpDraft }] });
    setMcpDraft({ name: '', url: '', transport: 'sse', token: '' });
    setMcpFormOpen(false);
  }

  function removeMcp(id: string) {
    patchForm({ mcpServers: form.mcpServers.filter(m => m.id !== id) });
  }

  // ── Provider model sync ────────────────────────────────────────────────────
  function setProvider(p: string) {
    const models = (PROVIDERS as any)[p]?.models ?? [];
    patchForm({ provider: p, model: models[0] ?? '', llmBaseUrl: (PROVIDER_ENDPOINTS as any)[p] ?? '' });
  }
  function setFallbackProvider(p: string) {
    const models = (PROVIDERS as any)[p]?.models ?? [];
    patchForm({ fallbackProvider: p, fallbackModel: models[0] ?? '' });
  }

  const pct = Math.round((step / 5) * 100);
  const activeRuns = [...runs.values()].filter(r => r.status === 'running').length;
  const doneRuns   = [...runs.values()].filter(r => r.status === 'done').length;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div class="fixed inset-0 z-50 hidden-override flex flex-col bg-surface overflow-hidden"
         style="display:flex">

      {/* ── Top bar ── */}
      <header class="flex items-center justify-between px-6 flex-shrink-0"
              style="background:#fff;border-bottom:1px solid rgba(195,198,214,0.2);height:52px">
        <div class="flex items-center gap-3">
          <button onClick={() => { agentsPanelOpenSignal.value = false; }}
                  class="flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                  style="color:#6b7280">
            <span class="material-symbols-outlined" style="font-size:15px">arrow_back</span>
            Board
          </button>
          <span class="select-none text-[11px]" style="color:rgba(195,198,214,0.7)">|</span>
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style="background:#003d9b">
              <span class="material-symbols-outlined" style="font-size:14px;color:#fff">hub</span>
            </div>
            <h1 class="text-[13px] font-bold" style="color:#191c1e">Agents</h1>
          </div>
        </div>
        <button onClick={() => openForm()}
                class="flex items-center gap-1.5 text-[12px] font-semibold px-4 py-1.5 rounded-full active:scale-95 transition-all duration-150"
                style="background:#003d9b;color:#fff">
          <span class="material-symbols-outlined" style="font-size:14px">add</span>
          New Agent
        </button>
      </header>

      {/* ── Body ── */}
      <div class="flex flex-1 overflow-hidden">

        {/* Left sidebar */}
        <aside class="w-48 bg-surface-container-lowest flex-shrink-0 flex flex-col pt-5 pb-6 px-3 gap-0.5"
               style="border-right:1px solid rgba(195,198,214,0.18)">
          <p class="text-[9px] font-black uppercase tracking-[0.12em] px-3 pb-2.5" style="color:#a0a3b0">Configuration</p>
          <button class="panel-nav active flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-semibold w-full text-left transition-all"
                  style="background:#eef2ff;color:#003d9b">
            <span class="material-symbols-outlined" style="font-size:16px">smart_toy</span>
            Agents
            <span class="ml-auto text-[10px] font-black px-1.5 py-0.5 rounded-full"
                  style="background:#e8ecf5;color:#6b7280">{agents.length}</span>
          </button>
          <div class="flex-1" />
          <p class="text-[10px] px-3 leading-relaxed" style="color:rgba(115,118,133,0.45)">Saves automatically.</p>
        </aside>

        {/* Main content */}
        <main class="flex-1 overflow-y-auto px-8 py-7"
              style="background:#f4f5f8;scrollbar-width:thin;scrollbar-color:#c3c6d6 transparent">
          <div class="max-w-5xl space-y-8">

            {/* Section header */}
            <div class="flex items-center justify-between mb-5">
              <div>
                <h2 class="text-lg font-bold tracking-tight" style="color:#191c1e">Agents</h2>
                <p class="text-[12px] mt-0.5 max-w-md leading-relaxed" style="color:#6b6f80">
                  Configure AI agents and assign them to board lanes.
                </p>
              </div>
            </div>

            {/* Cost & health banner */}
            {agents.length > 0 && (
              <div class="mb-4 px-4 py-2.5 rounded-lg flex items-center gap-4 text-xs"
                   style="background:#f3f4f6;border:1px solid rgba(195,198,214,0.3)">
                <span class="flex items-center gap-1.5 font-semibold"
                      style={`color:${activeRuns > 0 ? '#16a34a' : '#737885'}`}>
                  <span class="inline-block w-2 h-2 rounded-full"
                        style={`background:${activeRuns > 0 ? '#16a34a' : '#c3c6d6'}`} />
                  {activeRuns} active
                </span>
                <span style="color:#9ca3af">·</span>
                <span class="font-medium" style="color:#374151">{doneRuns} completed this session</span>
                <span style="color:#9ca3af">·</span>
                <span style="color:#6b7280">{agents.length} agent{agents.length !== 1 ? 's' : ''} configured</span>
              </div>
            )}

            {/* Wizard form */}
            {showForm && (
              <div class="mb-6">
                <div class="flex gap-5">

                  {/* ── Wizard card ── */}
                  <div class="flex-1 min-w-0 bg-surface-container-lowest rounded-xl border shadow-sm"
                       style="border-color:rgba(195,198,214,0.15)">

                    {/* Breadcrumb */}
                    <BreadcrumbBar step={step} />

                    {/* Wizard body */}
                    <div class="flex min-h-0">
                      <SubNav step={step} form={form} mcpCount={form.mcpServers.length} />

                      <div class="flex-1 p-5 space-y-5">
                        {step === 1 && <Step1 form={form} patchForm={patchForm} onTemplate={tpl => {
                          patchForm({ name: tpl.name, description: tpl.desc, purpose: tpl.purpose, systemPrompt: tpl.prompt });
                        }} />}
                        {step === 2 && <Step2 form={form} patchForm={patchForm}
                          mcpFormOpen={mcpFormOpen} setMcpFormOpen={setMcpFormOpen}
                          mcpDraft={mcpDraft} setMcpDraft={setMcpDraft}
                          onAddMcp={addMcp} onRemoveMcp={removeMcp} />}
                        {step === 3 && <Step3 form={form} patchForm={patchForm}
                          setProvider={setProvider} setFallbackProvider={setFallbackProvider} />}
                        {step === 4 && <Step4 form={form} patchForm={patchForm} onToggleLane={toggleLane} />}
                        {step === 5 && <Step5 form={form} />}
                      </div>
                    </div>

                    {/* Progress strip */}
                    <div class="px-5 py-2.5" style="border-top:1px solid rgba(195,198,214,0.15)">
                      <div class="flex items-center justify-between mb-1.5">
                        <span class="text-[9px] font-bold uppercase tracking-widest" style="color:#003d9b">
                          {pct}% COMPLETED
                        </span>
                        <span class="text-[9px] text-on-surface-variant/50">Step {step} of 5</span>
                      </div>
                      <div class="h-1.5 rounded-full w-full" style="background:#e1e2e4">
                        <div class="h-full rounded-full transition-all duration-300"
                             style={`width:${pct}%;background:linear-gradient(90deg,#003d9b,#0052cc)`} />
                      </div>
                    </div>

                    {/* Wizard nav */}
                    <div class="flex items-center justify-between px-2 py-3"
                         style="background:rgba(244,245,248,0.12);backdrop-filter:blur(6px);border-top:1px solid rgba(195,198,214,0.2)">
                      <button onClick={() => step > 1 && setStep(s => s - 1)}
                              class="flex items-center gap-1.5 text-xs font-semibold text-on-surface-variant px-5 py-2.5 rounded-full hover:bg-surface-container transition-colors"
                              style={`border:1px solid rgba(195,198,214,0.4);visibility:${step === 1 ? 'hidden' : 'visible'}`}>
                        <span class="material-symbols-outlined" style="font-size:14px">arrow_back</span>
                        Previous
                      </button>
                      <div class="flex items-center gap-3">
                        <button onClick={() => setShowForm(false)}
                                class="text-xs font-medium hover:text-on-surface-variant transition-colors px-2"
                                style="color:rgba(115,120,133,0.5)">
                          Cancel
                        </button>
                        <button
                          onClick={() => step < 5 ? setStep(s => s + 1) : handleSave()}
                          class="flex items-center gap-1.5 text-xs font-semibold px-6 py-2.5 rounded-full transition-all active:scale-95"
                          style="background:linear-gradient(135deg,#003d9b,#0052cc);color:#fff"
                        >
                          {step === 5 ? (form.id ? 'Save Agent' : 'Create Agent') : 'Next'}
                          <span class="material-symbols-outlined" style="font-size:14px">arrow_forward</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* ── Preview sidebar ── */}
                  <div class="w-64 flex-shrink-0 flex flex-col gap-3 self-start">
                    <div class="bg-surface-container-lowest rounded-xl border shadow-sm"
                         style="border-color:rgba(195,198,214,0.15)">
                      <div class="flex items-center justify-between px-4 py-3"
                           style="border-bottom:1px solid rgba(195,198,214,0.15)">
                        <p class="text-xs font-bold text-on-surface">Agent Preview</p>
                        <span class="text-[9px] font-bold px-1.5 py-0.5 rounded"
                              style="background:#dae2ff;color:#003d9b">Draft</span>
                      </div>
                      <div class="p-4 space-y-3">
                        <div class="flex items-center gap-3">
                          <div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                               style="background:#dae2ff">
                            <span class="material-symbols-outlined" style="font-size:16px;color:#003d9b">smart_toy</span>
                          </div>
                          <div class="min-w-0">
                            <p class="text-xs font-bold text-on-surface truncate">{form.name || 'New Agent'}</p>
                            <p class="text-[9px] text-on-surface-variant/60 mt-0.5">AI Agent · Draft</p>
                          </div>
                        </div>
                        {form.description && (
                          <p class="text-[10px] text-on-surface-variant leading-relaxed italic">
                            "{form.description}"
                          </p>
                        )}
                      </div>
                    </div>

                    {step === 2 && (
                      <div class="bg-surface-container-lowest rounded-xl border shadow-sm"
                           style="border-color:rgba(195,198,214,0.15)">
                        <div class="px-4 py-3" style="border-bottom:1px solid rgba(195,198,214,0.15)">
                          <p class="text-[10px] font-bold uppercase tracking-widest text-outline">Prompt Structure</p>
                        </div>
                        <div class="p-3 space-y-1.5">
                          {[
                            { label: 'Identity',       color: '#003d9b', bg: '#dae2ff', sub: 'Persona + Why it exists' },
                            { label: 'Reasoning Loop', color: '#7c3aed', bg: '#f3e8ff', sub: form.reasoningPattern || 'Patterns, not scripts' },
                            { label: 'Guardrails',     color: '#b45309', bg: '#fff3cd', sub: 'Hard Never / Always rules' },
                          ].map(s => (
                            <div key={s.label} class="rounded px-2.5 py-2" style={`background:${s.bg}`}>
                              <p class="text-[9px] font-bold uppercase tracking-widest mb-0.5"
                                 style={`color:${s.color}`}>{s.label}</p>
                              <p class="text-[10px] text-on-surface-variant/70">{s.sub}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Agent grid */}
            {!showForm && (
              <div class="grid grid-cols-3 gap-4">
                {/* CTA card */}
                <button
                  onClick={() => openForm()}
                  class="flex flex-col items-center justify-center gap-3 cursor-pointer transition-all"
                  style="background:#fafbff;border:2px dashed #c7d2fe;border-radius:16px;min-height:248px;padding:20px"
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor='#003d9b'; (e.currentTarget as HTMLElement).style.background='#eff6ff'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor='#c7d2fe'; (e.currentTarget as HTMLElement).style.background='#fafbff'; }}
                >
                  <div style="width:56px;height:56px;border-radius:50%;background:#003d9b;display:flex;align-items:center;justify-content:center">
                    <span class="material-symbols-outlined" style="font-size:28px;color:#fff">add</span>
                  </div>
                  <p style="font-size:13px;font-weight:700;color:#111827;margin:0">New Agent</p>
                  <p style="font-size:11px;color:#9ca3af;margin:2px 0 0;text-align:center">Set up a new AI agent.</p>
                </button>

                {/* Agent cards */}
                {agents.map(agent => {
                  const provColor = ({ claude:'#FF6B2B', copilot:'#24292E', openai:'#10A37F' } as any)[agent.provider] ?? '#003d9b';
                  const provBg    = ({ claude:'#FFF0EA', copilot:'#F0F2F4', openai:'#E6F9F4' } as any)[agent.provider] ?? '#dae2ff';
                  const abbrev    = agent.name.replace(/Agent$/i,'').slice(0,2).toUpperCase();
                  const model     = agent.model?.split('-').slice(0,2).join('-') || '—';
                  const mcpCount  = agent.mcpServers?.length ?? 0;

                  return (
                    <div key={agent.id}
                         class="flex flex-col overflow-hidden transition-all"
                         style="background:#fff;border:1px solid #e8eaed;border-radius:16px;box-shadow:0 1px 4px rgba(0,0,0,0.05),0 2px 12px rgba(0,0,0,0.03);min-height:248px"
                         onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow='0 8px 32px rgba(0,0,0,0.11)'; (e.currentTarget as HTMLElement).style.transform='translateY(-3px)'; }}
                         onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow='0 1px 4px rgba(0,0,0,0.05),0 2px 12px rgba(0,0,0,0.03)'; (e.currentTarget as HTMLElement).style.transform=''; }}>
                      {/* Card header */}
                      <div style="padding:16px 16px 0;display:flex;align-items:center;gap:10px">
                        <div style={`width:36px;height:36px;border-radius:8px;background:${provBg};color:${provColor};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;flex-shrink:0`}>
                          {abbrev}
                        </div>
                        <p style="font-size:13px;font-weight:700;color:#111827;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0">
                          {agent.name}
                        </p>
                        <span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;padding:3px 8px;border-radius:999px;background:#dcfce7;color:#15803d;flex-shrink:0">
                          <span style="width:5px;height:5px;border-radius:50%;background:#15803d;display:inline-block" />
                          Active
                        </span>
                      </div>

                      <p style="font-size:12px;color:#6b7280;line-height:1.6;margin:10px 16px 0;flex:1">
                        {agent.description || 'No description provided.'}
                      </p>

                      <div style="padding:10px 16px 0">
                        <p style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#9ca3af;margin:0 0 6px">LLM</p>
                        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                          <span style={`font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;background:${provBg};color:${provColor}`}>{model}</span>
                          <span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;background:#f3f4f6;color:#6b7280">{agent.autonomy}</span>
                          {mcpCount > 0 && (
                            <span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;background:#f5f3ff;color:#7c3aed">⚡ {mcpCount} MCP</span>
                          )}
                        </div>
                      </div>

                      <div style="padding:12px 16px;margin-top:12px;border-top:1px solid #f3f4f6;display:flex;align-items:center;gap:8px">
                        <button onClick={() => openForm(agent)}
                                style="flex:1;font-size:12px;font-weight:600;padding:7px 0;border-radius:8px;border:none;cursor:pointer;background:#003d9b;color:#fff">
                          Edit
                        </button>
                        <button onClick={() => removeAgent(agent.id)}
                                style="font-size:12px;font-weight:600;padding:7px 14px;border-radius:8px;border:1px solid #e5e7eb;cursor:pointer;background:#fff;color:#6b7280">
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BreadcrumbBar({ step }: { step: number }) {
  const phase = step <= 1 ? 1 : step <= 2 ? 2 : step <= 3 ? 3 : 4;
  const phases = [
    { num: 1, title: 'Agent Configuration' },
    { num: 2, title: 'Prompt & Knowledge' },
    { num: 3, title: 'Model Settings' },
    { num: 4, title: 'Automation Rules' },
  ];
  return (
    <div class="flex items-center px-6 py-4"
         style="border-bottom:1px solid rgba(195,198,214,0.18);background:#fcfcfd">
      {phases.map((p, i) => {
        const state = p.num < phase ? 'complete' : p.num === phase ? 'current' : 'upcoming';
        return (
          <>
            <div key={p.num} class="flex items-center flex-shrink-0">
              <div style={`width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.25s;
                ${state === 'complete' ? 'background:#003d9b;border:2px solid #003d9b' :
                  state === 'current'  ? 'background:#003d9b;border:2px solid #003d9b;box-shadow:0 0 0 5px rgba(0,61,155,0.1)' :
                                         'background:#fff;border:2px solid #e5e7eb'}`}>
                {state === 'complete'
                  ? <span class="material-symbols-outlined" style="font-size:18px;color:#fff;line-height:1">check</span>
                  : <span style={`font-size:11px;font-weight:800;line-height:1;${state === 'current' ? 'color:#fff' : 'color:#9ca3af'}`}>{p.num}</span>
                }
              </div>
              <div class="ml-2.5">
                <p style={`font-size:11px;font-weight:${state === 'current' ? '800' : '700'};white-space:nowrap;color:${state === 'complete' ? '#003d9b' : state === 'current' ? '#111827' : '#9ca3af'}`}>
                  {p.title}
                </p>
                <p style={`font-size:8px;font-weight:700;letter-spacing:0.08em;margin-top:3px;color:${state === 'complete' ? '#93c5fd' : state === 'current' ? '#003d9b' : '#d1d5db'}`}>
                  {state === 'complete' ? 'COMPLETE' : state === 'current' ? 'CURRENT' : 'UPCOMING'}
                </p>
              </div>
            </div>
            {i < phases.length - 1 && (
              <div style={`height:2px;background:${state === 'complete' ? '#003d9b' : '#e5e7eb'};flex:1;margin:0 10px;transition:background 0.25s`} />
            )}
          </>
        );
      })}
    </div>
  );
}

function SubNav({ step, form, mcpCount }: { step: number; form: AgentForm; mcpCount: number }) {
  const PHASE_ITEMS: Record<number, { label: string; hasData: () => boolean }[]> = {
    1: [
      { label: 'Agent Profile',       hasData: () => !!form.name.trim() },
      { label: 'Routing Description', hasData: () => !!form.description.trim() },
    ],
    2: [
      { label: 'Reasoning Pattern',   hasData: () => !!form.reasoningPattern },
      { label: 'System Prompt',       hasData: () => !!form.systemPrompt.trim() },
      { label: 'Connection',          hasData: () => !!form.endpoint.trim() },
      { label: 'MCP Tools',           hasData: () => mcpCount > 0 },
    ],
    3: [
      { label: 'Primary Provider',    hasData: () => !!form.provider },
      { label: 'Fallback',            hasData: () => !!form.fallbackProvider },
      { label: 'Sampling',            hasData: () => !!form.sampling },
    ],
    4: [
      { label: 'Assigned Lanes',      hasData: () => form.lanes.length > 0 },
      { label: 'Autonomy Level',      hasData: () => !!form.autonomy },
      { label: 'Guardrails',          hasData: () => !!(form.guardrailsAlways || form.guardrailsNever) },
      { label: 'Review',              hasData: () => false },
    ],
  };
  const phase = step <= 1 ? 1 : step <= 2 ? 2 : step <= 3 ? 3 : 4;
  const items = PHASE_ITEMS[phase] ?? [];
  const offsets: Record<number,number> = { 1:0, 2:2, 3:6, 4:9 };
  const offset = offsets[phase] ?? 0;

  return (
    <nav class="w-44 flex-shrink-0 py-4 px-3 space-y-0.5"
         style="border-right:1px solid rgba(195,198,214,0.15);background:#f9fafb;overflow-y:auto">
      {items.map((item, i) => {
        const done = item.hasData();
        const num  = String(offset + i + 1).padStart(2, '0');
        return (
          <div key={item.label}
               class={`flex items-center gap-2 text-[11px] py-1.5 px-2.5 rounded-lg transition-all ${i === 0 ? 'font-bold' : 'font-medium'}`}
               style={`${i === 0 ? 'color:#111827;background:#eef2ff' : 'color:#9ca3af'}`}>
            {done
              ? <span class="material-symbols-outlined flex-shrink-0"
                      style="font-size:20px;color:#16a34a;font-variation-settings:'FILL' 1,'wght' 400,'GRAD' 0,'opsz' 20">check_circle</span>
              : <span style={`width:20px;height:20px;border-radius:50%;background:#f0f0f2;color:#9ca3af;font-size:9px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;${i === 0 ? 'background:#003d9b;color:#fff' : ''}`}>{num}</span>
            }
            <span class="flex-1">{item.label}</span>
          </div>
        );
      })}
    </nav>
  );
}

function FieldLabel({ children }: { children: any }) {
  return <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#6b7280;margin-bottom:6px">{children}</label>;
}

function FieldInput({ value, onInput, placeholder, type = 'text', mono = false, ...rest }: any) {
  return (
    <input type={type} value={value} onInput={onInput} placeholder={placeholder}
           style={`width:100%;font-size:13px;padding:9px 0;border-radius:0;background:transparent;outline:none;border:none;border-bottom:1.5px solid rgba(195,198,214,0.5);transition:border-color 0.15s;color:#111827;${mono ? 'font-family:monospace' : ''}`}
           {...rest} />
  );
}

function Step1({ form, patchForm, onTemplate }: { form: AgentForm; patchForm: any; onTemplate: any }) {
  return (
    <div class="space-y-4">
      <div>
        <h3 class="text-sm font-bold text-on-surface">Agent Identity</h3>
        <p class="text-[11px] text-on-surface-variant mt-0.5 leading-relaxed">
          Select a template or define from scratch. The <strong>Storefront Description</strong> is what the orchestrator reads.
        </p>
      </div>

      <div class="grid grid-cols-4 gap-2">
        {TEMPLATES.map(tpl => (
          <button key={tpl.label} onClick={() => onTemplate(tpl)}
                  style={`display:flex;flex-direction:column;align-items:flex-start;padding:14px 12px;border-radius:10px;border:2px solid rgba(195,198,214,0.3);background:${form.name === tpl.name && tpl.name ? '#dae2ff' : '#f9f9fb'};transition:all 0.15s;cursor:pointer`}
                  onMouseEnter={e => { if (form.name !== tpl.name) { (e.currentTarget as HTMLElement).style.borderColor='#003d9b'; (e.currentTarget as HTMLElement).style.background='#eef2ff'; }}}
                  onMouseLeave={e => { if (form.name !== tpl.name) { (e.currentTarget as HTMLElement).style.borderColor='rgba(195,198,214,0.3)'; (e.currentTarget as HTMLElement).style.background='#f9f9fb'; }}}>
            <span class="material-symbols-outlined" style={`font-size:22px;color:${tpl.color}`}>{tpl.icon}</span>
            <span style="font-size:10px;font-weight:600;margin-top:4px;color:#111827">{tpl.label}</span>
            <span style="font-size:9px;color:#6b7280;margin-top:2px">{tpl.sub}</span>
          </button>
        ))}
      </div>

      <div>
        <FieldLabel>Name</FieldLabel>
        <FieldInput value={form.name} onInput={(e: any) => patchForm({ name: e.target.value })} placeholder="e.g. CodeReviewerAgent" />
      </div>
      <div>
        <FieldLabel>Storefront Description <span style="color:#b0b3c0;font-weight:normal;text-transform:none;letter-spacing:normal;margin-left:4px">— for orchestrators & routers</span></FieldLabel>
        <FieldInput value={form.description} onInput={(e: any) => patchForm({ description: e.target.value })} placeholder="What it does AND what it doesn't do" />
      </div>
      <div>
        <FieldLabel>Purpose / Why</FieldLabel>
        <FieldInput value={form.purpose} onInput={(e: any) => patchForm({ purpose: e.target.value })} placeholder="e.g. Ensure code quality gates are met before merge" />
      </div>
    </div>
  );
}

function Step2({ form, patchForm, mcpFormOpen, setMcpFormOpen, mcpDraft, setMcpDraft, onAddMcp, onRemoveMcp }: any) {
  const PATTERNS = [
    { value: 'analyze-validate-report', label: 'Analyze → Validate → Report' },
    { value: 'observe-plan-act',        label: 'Observe → Plan → Act' },
    { value: 'gather-synthesize-output',label: 'Gather → Synthesize → Output' },
    { value: 'custom',                  label: 'Custom' },
  ];
  const TRANSPORTS = ['sse', 'stdio', 'http'];
  return (
    <div class="space-y-4">
      <div>
        <h3 class="text-sm font-bold text-on-surface">Prompt & Knowledge</h3>
        <p class="text-[11px] text-on-surface-variant mt-0.5">Define the system prompt, reasoning pattern, connection endpoint, and MCP tool integrations.</p>
      </div>

      <div class="rounded-lg px-3.5 py-3 flex gap-3" style="background:#eef2ff;border:1px solid rgba(0,61,155,0.12)">
        <span class="material-symbols-outlined flex-shrink-0 mt-0.5" style="font-size:15px;color:#003d9b">layers</span>
        <p class="text-[10px] text-on-surface-variant leading-relaxed">
          <strong class="text-on-surface">Sandwich structure:</strong> Use <strong>[Identity]</strong> for persona · <strong>[Reasoning Loop]</strong> for patterns · <strong>[Guardrails]</strong> for hard Never/Always rules.
        </p>
      </div>

      <div>
        <FieldLabel>Reasoning Pattern</FieldLabel>
        <div class="flex flex-wrap gap-2">
          {PATTERNS.map(p => (
            <button key={p.value} onClick={() => patchForm({ reasoningPattern: p.value })}
                    style={`font-size:11px;font-weight:600;padding:5px 12px;border-radius:999px;border:1.5px solid transparent;transition:all 0.15s;white-space:nowrap;cursor:pointer;${form.reasoningPattern === p.value ? 'background:#dae2ff;border-color:#003d9b;color:#003d9b' : 'background:#edeef0;color:#434654'}`}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div class="flex items-center justify-between mb-1.5">
          <FieldLabel>System Prompt</FieldLabel>
          <span style="font-size:10px;color:#b0b3c0">{form.systemPrompt.length} chars</span>
        </div>
        <textarea rows={11} value={form.systemPrompt}
                  onInput={(e: any) => patchForm({ systemPrompt: e.target.value })}
                  placeholder={'[Identity]\nYou are a...\n\n[Reasoning Loop]\nFollow: Analyze → Validate → Report\n\n[Guardrails]\nAlways: ...\nNever: ...'}
                  style="width:100%;font-size:11px;padding:9px 13px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;outline:none;font-family:monospace;resize:none;line-height:1.6;color:#111827" />
      </div>

      {/* Connection */}
      <div class="p-3 rounded-lg space-y-3" style="background:#f3f4f6">
        <p class="text-[10px] font-bold uppercase tracking-widest text-outline">Connection</p>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Endpoint URL</FieldLabel>
            <FieldInput value={form.endpoint} onInput={(e: any) => patchForm({ endpoint: e.target.value })} mono />
          </div>
          <div>
            <FieldLabel>API Key</FieldLabel>
            <FieldInput type="password" value={form.apiKey} onInput={(e: any) => patchForm({ apiKey: e.target.value })} placeholder={getGlobalAiKey() ? 'Using global key (Settings → AI)' : 'Add a key in Settings → AI'} mono />
          </div>
        </div>
      </div>

      {/* MCP Tools */}
      <div class="rounded-lg border space-y-3" style="border-color:rgba(124,58,237,0.2);background:#faf5ff">
        <div class="flex items-center justify-between px-3.5 pt-3">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined" style="font-size:14px;color:#7c3aed">electrical_services</span>
            <p class="text-[10px] font-bold uppercase tracking-widest" style="color:#7c3aed">MCP Tools</p>
          </div>
          <button onClick={() => setMcpFormOpen(true)}
                  class="text-[10px] font-semibold flex items-center gap-1 px-2 py-1 rounded-full"
                  style="color:#7c3aed;background:rgba(124,58,237,0.08)">
            <span class="material-symbols-outlined" style="font-size:12px">add</span>
            Add Server
          </button>
        </div>

        <div class="px-3.5 space-y-1.5 pb-1">
          {form.mcpServers.length === 0
            ? <p class="text-[10px] text-on-surface-variant/40">No MCP servers added.</p>
            : form.mcpServers.map((mcp: McpServer) => (
              <div key={mcp.id} class="flex items-center justify-between gap-2 px-3 py-2 rounded-lg"
                   style="background:#f3e8ff;border:1px solid rgba(124,58,237,0.2)">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="material-symbols-outlined flex-shrink-0" style="font-size:13px;color:#7c3aed">electrical_services</span>
                  <div class="min-w-0">
                    <p class="text-[10px] font-bold truncate" style="color:#4c1d95">{mcp.name}</p>
                    <p class="text-[9px] font-mono truncate" style="color:#7c3aed">{mcp.url}</p>
                  </div>
                  <span class="text-[8px] font-bold px-1.5 py-0.5 rounded flex-shrink-0"
                        style="background:rgba(124,58,237,0.12);color:#7c3aed">{mcp.transport.toUpperCase()}</span>
                </div>
                <button onClick={() => onRemoveMcp(mcp.id)}
                        class="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center hover:bg-red-100">
                  <span class="material-symbols-outlined" style="font-size:12px;color:#ba1a1a">close</span>
                </button>
              </div>
            ))
          }
        </div>

        {mcpFormOpen && (
          <div class="px-3.5 pb-3.5 space-y-2.5" style="border-top:1px solid rgba(124,58,237,0.15)">
            <p class="text-[10px] font-bold uppercase tracking-widest pt-3" style="color:#7c3aed">New MCP Server</p>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <FieldLabel>Server Name</FieldLabel>
                <FieldInput value={mcpDraft.name} onInput={(e: any) => setMcpDraft((d: any) => ({ ...d, name: e.target.value }))} placeholder="e.g. GitHub MCP" />
              </div>
              <div>
                <FieldLabel>URL / Endpoint</FieldLabel>
                <FieldInput value={mcpDraft.url} onInput={(e: any) => setMcpDraft((d: any) => ({ ...d, url: e.target.value }))} placeholder="http://localhost:3001/sse" mono />
              </div>
            </div>
            <div>
              <FieldLabel>Transport</FieldLabel>
              <div class="flex gap-1.5">
                {TRANSPORTS.map(t => (
                  <button key={t} onClick={() => setMcpDraft((d: any) => ({ ...d, transport: t }))}
                          style={`flex:1;font-size:10px;font-weight:700;padding:6px 0;border-radius:6px;border:1px solid;transition:all 0.12s;cursor:pointer;${mcpDraft.transport === t ? 'border-color:rgba(124,58,237,0.4);background:#f3e8ff;color:#7c3aed' : 'border-color:rgba(199,196,216,0.5);background:#fff;color:#505f76'}`}>
                    {t.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div class="flex gap-2 pt-1">
              <button onClick={onAddMcp}
                      style="flex:1;font-size:10px;font-weight:700;padding:8px 0;border-radius:999px;background:#7c3aed;color:#fff;border:none;cursor:pointer">
                Add Server
              </button>
              <button onClick={() => setMcpFormOpen(false)}
                      style="padding:8px 12px;font-size:10px;font-weight:600;border-radius:8px;background:#f3f4f6;color:#737885;border:none;cursor:pointer">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Step3({ form, patchForm, setProvider, setFallbackProvider }: any) {
  const PROVIDER_LIST = [
    { key: 'openai',  label: 'OpenAI' },
    { key: 'claude',  label: 'Anthropic' },
    { key: 'copilot', label: 'GitHub' },
  ];
  const SAMPLING_LIST = [
    { key: 'deterministic', label: 'Deterministic', icon: 'target' },
    { key: 'balanced',      label: 'Balanced',       icon: 'balance' },
    { key: 'creative',      label: 'Creative',       icon: 'palette' },
  ];

  return (
    <div class="space-y-4">
      <div>
        <h3 class="text-sm font-bold text-on-surface">Model Settings</h3>
        <p class="text-[11px] text-on-surface-variant mt-0.5">Choose a primary LLM provider, model, fallback, and sampling profile.</p>
      </div>

      <div>
        <FieldLabel>Provider</FieldLabel>
        <div class="flex gap-2">
          {PROVIDER_LIST.map(p => (
            <button key={p.key} onClick={() => setProvider(p.key)}
                    style={`display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:6px 14px;border-radius:999px;border:1.5px solid;transition:all 0.15s;cursor:pointer;${form.provider === p.key ? 'background:#dae2ff;border-color:#003d9b;color:#003d9b' : 'border-color:rgba(195,198,214,0.5);background:#fff;color:#434654'}`}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>Model</FieldLabel>
          <select value={form.model} onChange={(e: any) => patchForm({ model: e.target.value })}
                  style="width:100%;font-size:13px;padding:9px 13px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;outline:none;color:#111827">
            {((PROVIDERS as any)[form.provider]?.models ?? []).map((m: string) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div>
          <FieldLabel>LLM Base URL</FieldLabel>
          <FieldInput value={form.llmBaseUrl} onInput={(e: any) => patchForm({ llmBaseUrl: e.target.value })} mono />
        </div>
      </div>

      <div class="p-3 rounded-lg space-y-3" style="background:#f3f4f6">
        <p class="text-[10px] font-bold uppercase tracking-widest text-outline">
          Fallback <span style="font-weight:normal;text-transform:none;letter-spacing:normal;color:rgba(115,120,133,0.5)">— if primary fails</span>
        </p>
        <div class="flex gap-2">
          {PROVIDER_LIST.map(p => (
            <button key={p.key} onClick={() => setFallbackProvider(p.key)}
                    style={`display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:6px 14px;border-radius:999px;border:1.5px solid;transition:all 0.15s;cursor:pointer;${form.fallbackProvider === p.key ? 'background:#dae2ff;border-color:#003d9b;color:#003d9b' : 'border-color:rgba(195,198,214,0.5);background:#fff;color:#434654'}`}>
              {p.label}
            </button>
          ))}
        </div>
        <div>
          <FieldLabel>Fallback Model</FieldLabel>
          <select value={form.fallbackModel} onChange={(e: any) => patchForm({ fallbackModel: e.target.value })}
                  style="width:100%;font-size:13px;padding:9px 13px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;outline:none;color:#111827">
            {((PROVIDERS as any)[form.fallbackProvider]?.models ?? []).map((m: string) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <FieldLabel>Sampling Profile</FieldLabel>
        <div class="flex gap-2">
          {SAMPLING_LIST.map(s => (
            <button key={s.key} onClick={() => patchForm({ sampling: s.key })}
                    class="flex-1 text-xs font-semibold py-2 rounded flex items-center justify-center gap-1.5 transition-colors"
                    style={`cursor:pointer;border:none;${form.sampling === s.key ? 'background:#003d9b;color:#fff' : 'background:#edeef0;color:#434654'}`}>
              <span class="material-symbols-outlined" style="font-size:15px">{s.icon}</span>
              {s.label}
            </button>
          ))}
        </div>
        <p class="text-[10px] text-on-surface-variant/40 mt-1.5">
          Temperature — Deterministic: 0.0 · Balanced: 0.5 · Creative: 0.9
        </p>
      </div>
    </div>
  );
}

function Step4({ form, patchForm, onToggleLane }: any) {
  const AUTONOMY = [
    { key: 'watch',      label: 'Watch',      icon: 'visibility' },
    { key: 'assist',     label: 'Assist',     icon: 'handshake' },
    { key: 'autonomous', label: 'Autonomous', icon: 'bolt' },
  ];
  return (
    <div class="space-y-4">
      <div>
        <h3 class="text-sm font-bold text-on-surface">Automation Rules</h3>
        <p class="text-[11px] text-on-surface-variant mt-0.5">Assign board lanes, set autonomy level, and define hard guardrail constraints.</p>
      </div>

      <div>
        <FieldLabel>Assigned Lanes</FieldLabel>
        <div class="flex flex-wrap gap-2">
          {LANES.map(l => (
            <label key={l.value}
                   class="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded cursor-pointer select-none transition-all"
                   style={form.lanes.includes(l.value) ? 'background:#dae2ff;color:#003d9b' : 'background:#e8eaed;color:#434654'}>
              <input type="checkbox" checked={form.lanes.includes(l.value)}
                     onChange={() => onToggleLane(l.value)}
                     class="w-3.5 h-3.5" />
              {l.label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <FieldLabel>Autonomy Level</FieldLabel>
        <div class="flex rounded overflow-hidden" style="border:1px solid rgba(195,198,214,0.4)">
          {AUTONOMY.map(a => (
            <button key={a.key} onClick={() => patchForm({ autonomy: a.key })}
                    class="flex-1 text-xs font-semibold py-2 flex items-center justify-center gap-1.5 transition-colors"
                    style={`cursor:pointer;border:none;${form.autonomy === a.key ? 'background:#003d9b;color:#fff' : 'background:#fff;color:#434654'}`}>
              <span class="material-symbols-outlined" style="font-size:15px">{a.icon}</span>
              {a.label}
            </button>
          ))}
        </div>
        <p class="text-[10px] text-on-surface-variant/40 mt-1.5">Watch: observe · Assist: suggest + wait for approval · Autonomous: act independently</p>
      </div>

      <div class="pt-1" style="border-top:1px solid rgba(195,198,214,0.2)">
        <div class="flex items-center gap-2 mb-3">
          <span class="material-symbols-outlined" style="font-size:14px;color:#003d9b">shield</span>
          <p class="text-xs font-bold text-on-surface">Hard Guardrails</p>
          <span class="text-[10px] text-on-surface-variant/50">— tight constraints, zero flexibility</span>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel style="color:#16a34a">Always</FieldLabel>
            <textarea rows={4} value={form.guardrailsAlways}
                      onInput={(e: any) => patchForm({ guardrailsAlways: e.target.value })}
                      placeholder={"Always: cite line numbers\nAlways: output valid JSON\nAlways: include confidence score"}
                      style="width:100%;font-size:11px;padding:9px 13px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;outline:none;font-family:monospace;resize:none;line-height:1.6;color:#111827" />
          </div>
          <div>
            <FieldLabel style="color:#ba1a1a">Never</FieldLabel>
            <textarea rows={4} value={form.guardrailsNever}
                      onInput={(e: any) => patchForm({ guardrailsNever: e.target.value })}
                      placeholder={"Never: approve failing tests\nNever: modify production data\nNever: skip security checks"}
                      style="width:100%;font-size:11px;padding:9px 13px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;outline:none;font-family:monospace;resize:none;line-height:1.6;color:#111827" />
          </div>
        </div>
        <p class="text-[10px] text-on-surface-variant/40 mt-1.5">These rules are appended to the system prompt automatically. Keep them short and absolute.</p>
      </div>
    </div>
  );
}

function Step5({ form }: { form: AgentForm }) {
  const rows: [string, string][] = [
    ['Name',      form.name || '—'],
    ['Storefront',form.description || '—'],
    ['Purpose',   form.purpose || '—'],
    ['Pattern',   form.reasoningPattern || 'none'],
    ['Prompt',    form.systemPrompt ? `${form.systemPrompt.length} chars` : '(empty)'],
    ['Provider',  form.provider],
    ['Model',     form.model || '—'],
    ['Fallback',  `${form.fallbackProvider} / ${form.fallbackModel || '—'}`],
    ['Sampling',  (SAMPLING_PROFILES as any)[form.sampling]?.label ?? form.sampling],
    ['Endpoint',  form.endpoint || '—'],
    ['Lanes',     form.lanes.join(', ') || 'none'],
    ['Autonomy',  form.autonomy],
    ['Always',    form.guardrailsAlways || '(none)'],
    ['Never',     form.guardrailsNever || '(none)'],
  ];
  return (
    <div class="space-y-3">
      <div>
        <h3 class="text-sm font-bold text-on-surface">Review & Save</h3>
        <p class="text-[11px] text-on-surface-variant mt-0.5">Check your configuration before creating the agent.</p>
      </div>
      <div class="space-y-2 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} class="flex gap-3 py-1.5" style="border-bottom:1px solid rgba(195,198,214,0.15)">
            <span class="w-24 flex-shrink-0 font-semibold text-on-surface-variant/70 text-[10px] uppercase tracking-wide">{k}</span>
            <span class="text-on-surface text-[11px] whitespace-pre-wrap break-all">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
