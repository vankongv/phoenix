/**
 * TeamsPanel — Preact island
 *
 * Replaces teams-panel.js (1004 lines of vanilla JS).
 * Fullscreen overlay for managing teams (groups of agents with a workflow canvas).
 */
import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { teamsPanelOpenSignal, agentsSignal } from '../../lib/signals.js';
import { getTeams, saveTeam, removeTeam } from '../../lib/agents.js';

// ── Interfaces ────────────────────────────────────────────────────────────────

interface Team {
  id: string;
  name: string;
  mode: 'sequential' | 'parallel' | 'consensus';
  status: 'draft' | 'production';
  agents: string[];
  mcpServers?: MCP[];
  edges?: Array<{ from: string; to: string }>;
  nodePositions?: Record<string, { x: number; y: number }>;
}

interface Agent {
  id: string;
  name: string;
  description?: string;
  provider?: string;
  model?: string;
  actionType?: string;
  lanes?: string[];
  autonomy?: string;
  sampling?: string;
  systemPrompt?: string;
}

interface MCP {
  id: string;
  name: string;
  url: string;
  transport: string;
  token?: string;
}

interface ActivityEntry {
  time: string;
  msg: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MODE_COLORS: Record<string, { bg: string; text: string }> = {
  sequential: { bg: '#dae2ff', text: '#003d9b' },
  parallel: { bg: '#f3e8ff', text: '#7c3aed' },
  consensus: { bg: '#dcfce7', text: '#16a34a' },
};

const PROVIDER_COLORS: Record<string, string> = {
  claude: '#d97706',
  openai: '#059669',
  gemini: '#2563eb',
  mistral: '#7c3aed',
  default: '#6b7280',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(d = new Date()): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

function getProviderColor(provider?: string): string {
  return PROVIDER_COLORS[provider?.toLowerCase() ?? ''] ?? PROVIDER_COLORS.default;
}

// ── Mini flow diagram ─────────────────────────────────────────────────────────

function MiniFlow({ team, agents }: { team: Team; agents: Agent[] }) {
  const teamAgents = team.agents
    .map((id) => agents.find((a) => a.id === id))
    .filter(Boolean) as Agent[];

  const visible = teamAgents.slice(0, 4);
  const extra = teamAgents.length - 4;

  const mode = team.mode;

  function ConnectorIcon() {
    if (mode === 'sequential') {
      return (
        <svg width="20" height="16" viewBox="0 0 20 16" fill="none" style="flex-shrink:0">
          <path d="M2 8h12M10 4l6 4-6 4" stroke="#003d9b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      );
    }
    if (mode === 'parallel') {
      return (
        <svg width="20" height="16" viewBox="0 0 20 16" fill="none" style="flex-shrink:0">
          <line x1="6" y1="4" x2="6" y2="12" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" />
          <line x1="14" y1="4" x2="14" y2="12" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" />
        </svg>
      );
    }
    // consensus
    return (
      <svg width="20" height="16" viewBox="0 0 20 16" fill="none" style="flex-shrink:0">
        <circle cx="10" cy="8" r="5" stroke="#16a34a" stroke-width="1.5" />
        <path d="M7 8l2 2 4-4" stroke="#16a34a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    );
  }

  return (
    <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:6px 0">
      {visible.map((agent, idx) => (
        <>
          <div
            key={agent.id}
            title={agent.name}
            style={`
              width:28px;height:28px;border-radius:50%;
              background:${getProviderColor(agent.provider)};
              color:white;font-size:10px;font-weight:600;
              display:flex;align-items:center;justify-content:center;
              flex-shrink:0;
            `}
          >
            {initials(agent.name)}
          </div>
          {idx < visible.length - 1 && <ConnectorIcon key={`conn-${idx}`} />}
        </>
      ))}
      {extra > 0 && (
        <span style="font-size:11px;color:#6b7280;font-weight:500">+{extra}</span>
      )}
    </div>
  );
}

// ── Team Card ─────────────────────────────────────────────────────────────────

function TeamCard({
  team,
  agents,
  onEdit,
  onTest,
  onDelete,
  onDeploy,
}: {
  team: Team;
  agents: Agent[];
  onEdit: (t: Team) => void;
  onTest: (t: Team) => void;
  onDelete: (id: string) => void;
  onDeploy: (t: Team) => void;
}) {
  const modeColor = MODE_COLORS[team.mode] ?? MODE_COLORS.sequential;
  const agentCount = team.agents.length;
  const mcpCount = team.mcpServers?.length ?? 0;
  const estCost = (agentCount * 1.2).toFixed(2);
  const teamAgents = team.agents
    .map((id) => agents.find((a) => a.id === id))
    .filter(Boolean) as Agent[];

  return (
    <div
      style={`
        border-radius:12px;background:white;
        border-left:3px solid ${modeColor.text};
        box-shadow:0 1px 4px rgba(0,0,0,0.08);
        padding:14px 16px;
        display:flex;flex-direction:column;gap:10px;
      `}
    >
      {/* Card header */}
      <div style="display:flex;align-items:flex-start;justify-content:space-between">
        <div>
          <div style="font-weight:600;font-size:14px;color:#111827">{team.name}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:2px">
            {agentCount} agents · {mcpCount} MCP ·{' '}
            <span
              style={`
                background:${modeColor.bg};color:${modeColor.text};
                padding:1px 6px;border-radius:9999px;font-size:10px;font-weight:500;
              `}
            >
              {team.mode}
            </span>
          </div>
        </div>
        <button
          onClick={() => onDelete(team.id)}
          title="Delete team"
          style="background:none;border:none;cursor:pointer;color:#9ca3af;padding:2px;border-radius:4px;display:flex;align-items:center"
        >
          <span class="material-symbols-outlined" style="font-size:16px">delete</span>
        </button>
      </div>

      {/* Mini flow */}
      <MiniFlow team={team} agents={agents} />

      {/* Stats grid */}
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
        {[
          { label: 'Agents', value: String(agentCount) },
          { label: 'MCPs', value: String(mcpCount) },
          { label: 'Est. cost', value: `$${estCost}/hr` },
        ].map(({ label, value }) => (
          <div
            key={label}
            style="background:#f9fafb;border-radius:8px;padding:6px 8px;text-align:center"
          >
            <div style="font-size:13px;font-weight:600;color:#111827">{value}</div>
            <div style="font-size:10px;color:#9ca3af">{label}</div>
          </div>
        ))}
      </div>

      {/* Action buttons */}
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button
          onClick={() => onEdit(team)}
          style="flex:1;background:#f3f4f6;border:none;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:500;cursor:pointer;color:#374151;display:flex;align-items:center;justify-content:center;gap:4px"
        >
          <span class="material-symbols-outlined" style="font-size:14px">account_tree</span>
          Edit Flow
        </button>
        <button
          onClick={() => onTest(team)}
          style="flex:1;background:#f3f4f6;border:none;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:500;cursor:pointer;color:#374151;display:flex;align-items:center;justify-content:center;gap:4px"
        >
          <span class="material-symbols-outlined" style="font-size:14px">play_arrow</span>
          Test
        </button>
        {team.status === 'draft' ? (
          <button
            onClick={() => onDeploy(team)}
            style="flex:1;background:#003d9b;border:none;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:500;cursor:pointer;color:white;display:flex;align-items:center;justify-content:center;gap:4px"
          >
            <span class="material-symbols-outlined" style="font-size:14px">rocket_launch</span>
            Deploy
          </button>
        ) : (
          <div
            style="flex:1;background:#dcfce7;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:500;color:#16a34a;display:flex;align-items:center;justify-content:center;gap:4px"
          >
            <span class="material-symbols-outlined" style="font-size:14px">check_circle</span>
            Running
          </div>
        )}
      </div>
    </div>
  );
}

// ── Activity Feed ─────────────────────────────────────────────────────────────

function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  return (
    <div style="width:220px;flex-shrink:0;display:flex;flex-direction:column;border-left:1px solid #f3f4f6">
      <div style="padding:16px 16px 10px;font-weight:600;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6">
        Activity
      </div>
      <div style="flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px">
        {entries.length === 0 ? (
          <div style="color:#9ca3af;font-size:12px;text-align:center;margin-top:20px">No activity yet</div>
        ) : (
          entries.map((e, i) => (
            <div key={i} style="display:flex;flex-direction:column;gap:1px">
              <span style="font-size:10px;color:#9ca3af">{e.time}</span>
              <span style="font-size:12px;color:#374151">{e.msg}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Test Panel ────────────────────────────────────────────────────────────────

function TestPanel({ team, onClose }: { team: Team; onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);

  function runTest() {
    if (!prompt.trim() || running) return;
    setRunning(true);
    setSteps(['Parsing prompt…']);

    const agentNames = team.agents;

    let delay = 800;
    agentNames.forEach((agId, idx) => {
      setTimeout(() => {
        setSteps((prev) => [...prev, `Agent ${agId}: processing…`]);
      }, delay);
      delay += 900;
    });

    setTimeout(() => {
      setSteps((prev) => [...prev, 'Result ready ✓']);
      setRunning(false);
    }, delay + 600);
  }

  return (
    <div
      style="
        position:fixed;right:0;top:0;bottom:0;width:360px;
        background:white;border-left:1px solid #e5e7eb;
        display:flex;flex-direction:column;z-index:60;
        box-shadow:-4px 0 20px rgba(0,0,0,0.08);
      "
    >
      {/* Header */}
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #f3f4f6">
        <div>
          <div style="font-weight:600;font-size:14px;color:#111827">Test: {team.name}</div>
          <div style="font-size:11px;color:#6b7280">Simulate workflow execution</div>
        </div>
        <button
          onClick={onClose}
          style="background:none;border:none;cursor:pointer;color:#9ca3af;display:flex;align-items:center;padding:4px;border-radius:6px"
        >
          <span class="material-symbols-outlined" style="font-size:20px">close</span>
        </button>
      </div>

      {/* Body */}
      <div style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px">
        <textarea
          value={prompt}
          onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
          placeholder="Enter a test prompt…"
          rows={4}
          style="width:100%;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;font-size:13px;resize:vertical;outline:none;font-family:inherit;box-sizing:border-box"
        />
        <button
          onClick={runTest}
          disabled={running || !prompt.trim()}
          style={`
            background:${running ? '#9ca3af' : '#003d9b'};
            color:white;border:none;border-radius:8px;
            padding:10px 16px;font-size:13px;font-weight:500;
            cursor:${running ? 'not-allowed' : 'pointer'};
            display:flex;align-items:center;justify-content:center;gap:6px;
          `}
        >
          <span class="material-symbols-outlined" style="font-size:16px">{running ? 'hourglass_empty' : 'play_arrow'}</span>
          {running ? 'Running…' : 'Run Test'}
        </button>

        {steps.length > 0 && (
          <div style="display:flex;flex-direction:column;gap:6px">
            {steps.map((s, i) => (
              <div
                key={i}
                style={`
                  display:flex;align-items:center;gap:8px;
                  padding:8px 12px;border-radius:8px;
                  background:${i === steps.length - 1 && s.includes('✓') ? '#dcfce7' : '#f9fafb'};
                  font-size:12px;color:#374151;
                `}
              >
                <span
                  class="material-symbols-outlined"
                  style={`font-size:14px;color:${i === steps.length - 1 && s.includes('✓') ? '#16a34a' : '#9ca3af'}`}
                >
                  {s.includes('✓') ? 'check_circle' : 'radio_button_unchecked'}
                </span>
                {s}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Workflow Canvas ───────────────────────────────────────────────────────────

function WorkflowCanvas({
  team,
  agents,
  onClose,
  onSaved,
}: {
  team: Team | null;
  agents: Agent[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const isNew = !team;

  const [wfTeam] = useState<Team | null>(team);
  const [agentOrder, setAgentOrder] = useState<string[]>(team?.agents ?? []);
  const [mcpList, setMcpList] = useState<MCP[]>(team?.mcpServers ?? []);
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>(
    team?.nodePositions ?? {}
  );
  const [selectedNode, setSelectedNode] = useState<{ type: 'agent' | 'mcp'; data: any } | null>(null);
  const [wfMode, setWfMode] = useState<'sequential' | 'parallel' | 'consensus'>(
    team?.mode ?? 'sequential'
  );
  const [wfStage, setWfStage] = useState<'draft' | 'production'>(team?.status ?? 'draft');
  const [wfName, setWfName] = useState(team?.name ?? '');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [mcpDraft, setMcpDraft] = useState({ name: '', url: '', transport: 'sse', token: '' });
  const [agentSearch, setAgentSearch] = useState('');
  const [nameError, setNameError] = useState('');

  const canvasRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<string, HTMLDivElement>>({});

  const dragRef = useRef({
    dragging: false,
    id: '',
    startMx: 0,
    startMy: 0,
    startNx: 0,
    startNy: 0,
    moved: false,
  });
  const panRef = useRef({ panning: false, startMx: 0, startMy: 0, startPx: 0, startPy: 0 });

  // Auto-layout on first open
  useEffect(() => {
    const allIds = [...agentOrder, ...mcpList.map((m) => m.id)];
    const newPos: Record<string, { x: number; y: number }> = { ...nodePositions };
    let changed = false;

    allIds.forEach((id, idx) => {
      if (!newPos[id]) {
        changed = true;
        if (wfMode === 'parallel') {
          newPos[id] = { x: 80, y: 60 + idx * 90 };
        } else {
          const col = idx % 4;
          const row = Math.floor(idx / 4);
          newPos[id] = { x: 80 + col * 260, y: 80 + row * 120 };
        }
      }
    });

    if (changed) setNodePositions(newPos);
  }, []); // run once on mount

  // Drag handlers
  function onNodeMouseDown(e: MouseEvent, id: string) {
    e.stopPropagation();
    const pos = nodePositions[id] ?? { x: 0, y: 0 };
    dragRef.current = {
      dragging: true,
      id,
      startMx: e.clientX,
      startMy: e.clientY,
      startNx: pos.x,
      startNy: pos.y,
      moved: false,
    };

    function onMouseMove(ev: MouseEvent) {
      const d = dragRef.current;
      if (!d.dragging) return;
      const dx = (ev.clientX - d.startMx) / zoom;
      const dy = (ev.clientY - d.startMy) / zoom;
      const nx = d.startNx + dx;
      const ny = d.startNy + dy;
      d.moved = true;

      // Direct DOM update for perf
      const el = nodeRefs.current[d.id];
      if (el) {
        el.style.left = `${nx}px`;
        el.style.top = `${ny}px`;
      }
    }

    function onMouseUp(ev: MouseEvent) {
      const d = dragRef.current;
      if (d.dragging && d.moved) {
        const dx = (ev.clientX - d.startMx) / zoom;
        const dy = (ev.clientY - d.startMy) / zoom;
        setNodePositions((prev) => ({
          ...prev,
          [d.id]: { x: d.startNx + dx, y: d.startNy + dy },
        }));
      }
      dragRef.current.dragging = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  // Pan handlers
  function onCanvasMouseDown(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('[data-node]')) return;
    panRef.current = { panning: true, startMx: e.clientX, startMy: e.clientY, startPx: pan.x, startPy: pan.y };

    function onMouseMove(ev: MouseEvent) {
      if (!panRef.current.panning) return;
      const dx = ev.clientX - panRef.current.startMx;
      const dy = ev.clientY - panRef.current.startMy;
      const nx = panRef.current.startPx + dx;
      const ny = panRef.current.startPy + dy;

      if (transformRef.current) {
        transformRef.current.style.transform = `translate(${nx}px, ${ny}px) scale(${zoom})`;
      }
    }

    function onMouseUp(ev: MouseEvent) {
      if (panRef.current.panning) {
        const dx = ev.clientX - panRef.current.startMx;
        const dy = ev.clientY - panRef.current.startMy;
        setPan({ x: panRef.current.startPx + dx, y: panRef.current.startPy + dy });
      }
      panRef.current.panning = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom((z) => Math.min(3, Math.max(0.2, z * factor)));
  }

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom]);

  function toggleAgent(agentId: string) {
    setAgentOrder((prev) => {
      if (prev.includes(agentId)) return prev.filter((id) => id !== agentId);
      // Add with auto-position
      const idx = prev.length;
      setNodePositions((pos) => {
        if (pos[agentId]) return pos;
        const col = idx % 4;
        const row = Math.floor(idx / 4);
        return { ...pos, [agentId]: { x: 80 + col * 260, y: 80 + row * 120 } };
      });
      return [...prev, agentId];
    });
  }

  function removeNodeFromCanvas(id: string, type: 'agent' | 'mcp') {
    if (type === 'agent') {
      setAgentOrder((prev) => prev.filter((x) => x !== id));
    } else {
      setMcpList((prev) => prev.filter((m) => m.id !== id));
    }
    setNodePositions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (selectedNode?.data?.id === id) setSelectedNode(null);
  }

  function addMcp() {
    if (!mcpDraft.name || !mcpDraft.url) return;
    const mcp: MCP = { ...mcpDraft, id: crypto.randomUUID() };
    setMcpList((prev) => {
      const idx = prev.length + agentOrder.length;
      setNodePositions((pos) => ({
        ...pos,
        [mcp.id]: { x: 80 + (idx % 4) * 260, y: 80 + Math.floor(idx / 4) * 120 },
      }));
      return [...prev, mcp];
    });
    setMcpDraft({ name: '', url: '', transport: 'sse', token: '' });
    setMcpModalOpen(false);
  }

  function handleSave() {
    if (!wfName.trim()) {
      setNameError('Team name is required');
      return;
    }
    setNameError('');

    const saved: Team = {
      id: wfTeam?.id ?? crypto.randomUUID(),
      name: wfName.trim(),
      mode: wfMode,
      status: wfStage,
      agents: agentOrder,
      mcpServers: mcpList,
      nodePositions,
    };
    saveTeam(saved);
    onSaved(`Team "${saved.name}" saved`);
    onClose();
  }

  // SVG edges
  const NODE_W = 220;
  const NODE_H = 58;
  const allIds = [...agentOrder, ...mcpList.map((m) => m.id)];

  // Canvas transform
  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  const filteredAgents = agents.filter(
    (a) =>
      !agentSearch ||
      a.name.toLowerCase().includes(agentSearch.toLowerCase()) ||
      (a.description ?? '').toLowerCase().includes(agentSearch.toLowerCase())
  );

  const modeColor = MODE_COLORS[wfMode] ?? MODE_COLORS.sequential;

  return (
    <div
      style="
        position:absolute;inset:0;background:white;z-index:10;
        display:flex;flex-direction:column;
      "
    >
      {/* Canvas Header */}
      <div style="display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid #e5e7eb;background:white;z-index:2;flex-shrink:0">
        <button
          onClick={onClose}
          style="background:#f3f4f6;border:none;border-radius:8px;padding:6px 10px;cursor:pointer;display:flex;align-items:center;gap:4px;font-size:13px;color:#374151;font-weight:500"
        >
          <span class="material-symbols-outlined" style="font-size:16px">arrow_back</span>
          Back
        </button>

        <input
          value={wfName}
          onInput={(e) => setWfName((e.target as HTMLInputElement).value)}
          placeholder="Team name…"
          style={`
            flex:1;max-width:280px;border:${nameError ? '1px solid #ef4444' : '1px solid #e5e7eb'};
            border-radius:8px;padding:7px 12px;font-size:14px;font-weight:500;
            outline:none;color:#111827;
          `}
        />
        {nameError && <span style="font-size:11px;color:#ef4444">{nameError}</span>}

        {/* Mode pills */}
        <div style="display:flex;gap:4px;margin-left:auto">
          {(['sequential', 'parallel', 'consensus'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setWfMode(m)}
              style={`
                border:none;border-radius:9999px;padding:5px 12px;font-size:12px;font-weight:500;cursor:pointer;
                background:${wfMode === m ? MODE_COLORS[m].bg : '#f3f4f6'};
                color:${wfMode === m ? MODE_COLORS[m].text : '#6b7280'};
                transition:all 0.15s;
              `}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* Stage */}
        <select
          value={wfStage}
          onChange={(e) => setWfStage((e.target as HTMLSelectElement).value as any)}
          style="border:1px solid #e5e7eb;border-radius:8px;padding:6px 10px;font-size:13px;color:#374151;outline:none;cursor:pointer"
        >
          <option value="draft">Draft</option>
          <option value="production">Production</option>
        </select>

        {/* Zoom controls */}
        <div style="display:flex;gap:2px;align-items:center;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
          <button
            onClick={() => setZoom((z) => Math.max(0.2, z - 0.1))}
            style="background:none;border:none;padding:5px 8px;cursor:pointer;color:#6b7280;font-size:14px"
          >
            <span class="material-symbols-outlined" style="font-size:16px">remove</span>
          </button>
          <span style="font-size:11px;color:#6b7280;padding:0 4px;min-width:36px;text-align:center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.min(3, z + 0.1))}
            style="background:none;border:none;padding:5px 8px;cursor:pointer;color:#6b7280;font-size:14px"
          >
            <span class="material-symbols-outlined" style="font-size:16px">add</span>
          </button>
          <button
            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
            style="background:none;border:none;padding:5px 8px;cursor:pointer;color:#6b7280;font-size:14px"
          >
            <span class="material-symbols-outlined" style="font-size:16px">center_focus_strong</span>
          </button>
        </div>

        <button
          onClick={handleSave}
          style="background:#003d9b;color:white;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px"
        >
          <span class="material-symbols-outlined" style="font-size:16px">save</span>
          Save Team
        </button>
      </div>

      {/* Canvas body */}
      <div style="flex:1;display:flex;overflow:hidden">

        {/* Left sidebar: agent palette */}
        <div style="width:256px;flex-shrink:0;border-right:1px solid #f3f4f6;display:flex;flex-direction:column;background:#fafafa">
          <div style="padding:12px 14px;border-bottom:1px solid #f3f4f6">
            <div style="font-weight:600;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Agents</div>
            <input
              value={agentSearch}
              onInput={(e) => setAgentSearch((e.target as HTMLInputElement).value)}
              placeholder="Search agents…"
              style="width:100%;border:1px solid #e5e7eb;border-radius:8px;padding:6px 10px;font-size:12px;outline:none;box-sizing:border-box;background:white"
            />
          </div>
          <div style="flex:1;overflow-y:auto;padding:8px">
            {filteredAgents.map((agent) => {
              const inFlow = agentOrder.includes(agent.id);
              const providerColor = getProviderColor(agent.provider);
              return (
                <div
                  key={agent.id}
                  onClick={() => toggleAgent(agent.id)}
                  style={`
                    display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;
                    cursor:pointer;margin-bottom:4px;
                    background:${inFlow ? '#eff6ff' : 'white'};
                    border:1px solid ${inFlow ? '#bfdbfe' : '#f3f4f6'};
                    transition:all 0.15s;
                  `}
                >
                  <div
                    style={`
                      width:28px;height:28px;border-radius:8px;
                      background:${providerColor};color:white;
                      font-size:10px;font-weight:600;flex-shrink:0;
                      display:flex;align-items:center;justify-content:center;
                    `}
                  >
                    {initials(agent.name)}
                  </div>
                  <div style="flex:1;min-width:0">
                    <div style="font-size:12px;font-weight:500;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                      {agent.name}
                    </div>
                    <div style="font-size:10px;color:#9ca3af">{agent.provider ?? 'custom'}</div>
                  </div>
                  {inFlow && (
                    <span class="material-symbols-outlined" style="font-size:14px;color:#2563eb;flex-shrink:0">
                      check_circle
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* MCP servers section */}
          <div style="border-top:1px solid #f3f4f6;padding:10px 14px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <div style="font-weight:600;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">MCP Servers</div>
              <button
                onClick={() => setMcpModalOpen(true)}
                style="background:none;border:none;cursor:pointer;color:#2563eb;display:flex;align-items:center;padding:2px"
              >
                <span class="material-symbols-outlined" style="font-size:16px">add_circle</span>
              </button>
            </div>
            {mcpList.length === 0 ? (
              <div style="font-size:11px;color:#9ca3af">No MCP servers added</div>
            ) : (
              mcpList.map((mcp) => (
                <div key={mcp.id} style="font-size:12px;color:#374151;padding:4px 0;display:flex;align-items:center;gap:6px">
                  <span class="material-symbols-outlined" style="font-size:13px;color:#7c3aed">hub</span>
                  {mcp.name}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Center: canvas */}
        <div
          ref={canvasRef}
          onMouseDown={onCanvasMouseDown}
          style="flex:1;position:relative;overflow:hidden;background:#f8f9fc;cursor:grab;background-image:radial-gradient(circle,#d1d5db 1px,transparent 1px);background-size:24px 24px"
        >
          <div
            ref={transformRef}
            id="wf-canvas-transform"
            style={`position:absolute;top:0;left:0;transform:${transform};transform-origin:0 0;width:2000px;height:2000px`}
          >
            {/* SVG edges */}
            <svg
              style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none"
              overflow="visible"
            >
              {agentOrder.map((id, idx) => {
                if (idx === 0) return null;
                const prevId = agentOrder[idx - 1];
                const from = nodePositions[prevId];
                const to = nodePositions[id];
                if (!from || !to) return null;

                const x1 = from.x + NODE_W;
                const y1 = from.y + NODE_H / 2;
                const x2 = to.x;
                const y2 = to.y + NODE_H / 2;
                const mx = (x1 + x2) / 2;

                const color = wfMode === 'parallel' ? '#7c3aed' : '#003d9b';

                return (
                  <path
                    key={`${prevId}-${id}`}
                    d={`M ${x1},${y1} C ${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                    fill="none"
                    stroke={color}
                    stroke-width="1.5"
                    stroke-dasharray={wfMode === 'parallel' ? '5,3' : undefined}
                    opacity="0.6"
                  />
                );
              })}
              {/* MCP edges: connect to last agent */}
              {mcpList.map((mcp) => {
                const lastAgentId = agentOrder[agentOrder.length - 1];
                if (!lastAgentId) return null;
                const from = nodePositions[lastAgentId];
                const to = nodePositions[mcp.id];
                if (!from || !to) return null;

                const x1 = from.x + NODE_W;
                const y1 = from.y + NODE_H / 2;
                const x2 = to.x;
                const y2 = to.y + NODE_H / 2;
                const mx = (x1 + x2) / 2;

                return (
                  <path
                    key={`mcp-${mcp.id}`}
                    d={`M ${x1},${y1} C ${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                    fill="none"
                    stroke="#7c3aed"
                    stroke-width="1.5"
                    stroke-dasharray="4,3"
                    opacity="0.5"
                  />
                );
              })}
            </svg>

            {/* Agent nodes */}
            {agentOrder.map((id) => {
              const agent = agents.find((a) => a.id === id);
              if (!agent) return null;
              const pos = nodePositions[id] ?? { x: 80, y: 80 };
              const providerColor = getProviderColor(agent.provider);
              const isSelected = selectedNode?.data?.id === id;

              return (
                <div
                  key={id}
                  data-node="true"
                  ref={(el) => { if (el) nodeRefs.current[id] = el as HTMLDivElement; }}
                  onMouseDown={(e) => onNodeMouseDown(e as MouseEvent, id)}
                  onClick={() => setSelectedNode({ type: 'agent', data: agent })}
                  style={`
                    position:absolute;
                    left:${pos.x}px;top:${pos.y}px;
                    width:${NODE_W}px;
                    background:white;
                    border:1.5px solid ${isSelected ? '#003d9b' : '#e5e7eb'};
                    border-radius:10px;
                    padding:10px 12px;
                    cursor:move;
                    user-select:none;
                    box-shadow:${isSelected ? '0 0 0 3px rgba(0,61,155,0.12)' : '0 1px 4px rgba(0,0,0,0.08)'};
                    display:flex;align-items:center;gap:8px;
                  `}
                >
                  <div
                    style={`
                      width:32px;height:32px;border-radius:8px;flex-shrink:0;
                      background:${providerColor};color:white;
                      font-size:11px;font-weight:600;
                      display:flex;align-items:center;justify-content:center;
                    `}
                  >
                    {initials(agent.name)}
                  </div>
                  <div style="flex:1;min-width:0">
                    <div style="font-size:12px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                      {agent.name}
                    </div>
                    <div style="font-size:10px;color:#9ca3af">{agent.provider ?? 'custom'} · {agent.model ?? ''}</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeNodeFromCanvas(id, 'agent'); }}
                    style="background:none;border:none;cursor:pointer;color:#9ca3af;padding:2px;border-radius:4px;flex-shrink:0"
                  >
                    <span class="material-symbols-outlined" style="font-size:14px">close</span>
                  </button>
                </div>
              );
            })}

            {/* MCP nodes */}
            {mcpList.map((mcp) => {
              const pos = nodePositions[mcp.id] ?? { x: 80, y: 80 };
              const isSelected = selectedNode?.data?.id === mcp.id;

              return (
                <div
                  key={mcp.id}
                  data-node="true"
                  ref={(el) => { if (el) nodeRefs.current[mcp.id] = el as HTMLDivElement; }}
                  onMouseDown={(e) => onNodeMouseDown(e as MouseEvent, mcp.id)}
                  onClick={() => setSelectedNode({ type: 'mcp', data: mcp })}
                  style={`
                    position:absolute;
                    left:${pos.x}px;top:${pos.y}px;
                    width:${NODE_W}px;
                    background:white;
                    border:1.5px solid ${isSelected ? '#7c3aed' : '#e5e7eb'};
                    border-radius:10px;
                    padding:10px 12px;
                    cursor:move;
                    user-select:none;
                    box-shadow:${isSelected ? '0 0 0 3px rgba(124,58,237,0.12)' : '0 1px 4px rgba(0,0,0,0.08)'};
                    display:flex;align-items:center;gap:8px;
                  `}
                >
                  <div
                    style="width:32px;height:32px;border-radius:8px;flex-shrink:0;background:#f3e8ff;color:#7c3aed;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;"
                  >
                    <span class="material-symbols-outlined" style="font-size:16px">hub</span>
                  </div>
                  <div style="flex:1;min-width:0">
                    <div style="font-size:12px;font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                      {mcp.name}
                    </div>
                    <div style="font-size:10px;color:#9ca3af">{mcp.transport} · MCP</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeNodeFromCanvas(mcp.id, 'mcp'); }}
                    style="background:none;border:none;cursor:pointer;color:#9ca3af;padding:2px;border-radius:4px;flex-shrink:0"
                  >
                    <span class="material-symbols-outlined" style="font-size:14px">close</span>
                  </button>
                </div>
              );
            })}

            {/* Empty canvas hint */}
            {agentOrder.length === 0 && mcpList.length === 0 && (
              <div
                style="
                  position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);
                  text-align:center;color:#9ca3af;pointer-events:none;
                "
              >
                <span class="material-symbols-outlined" style="font-size:48px;display:block;margin-bottom:8px;opacity:0.4">
                  account_tree
                </span>
                <div style="font-size:14px;font-weight:500">Add agents from the left panel</div>
                <div style="font-size:12px;margin-top:4px">Click an agent to toggle it in/out of the flow</div>
              </div>
            )}
          </div>
        </div>

        {/* Right sidebar: node details */}
        <div style="width:220px;flex-shrink:0;border-left:1px solid #f3f4f6;background:#fafafa;display:flex;flex-direction:column">
          {selectedNode ? (
            <>
              <div style="padding:14px 16px;border-bottom:1px solid #f3f4f6">
                <div style="font-weight:600;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">
                  {selectedNode.type === 'agent' ? 'Agent' : 'MCP Server'}
                </div>
              </div>
              <div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px;overflow-y:auto">
                {selectedNode.type === 'agent' ? (
                  <>
                    <DetailRow label="Name" value={selectedNode.data.name} />
                    <DetailRow label="Provider" value={selectedNode.data.provider ?? '—'} />
                    <DetailRow label="Model" value={selectedNode.data.model ?? '—'} />
                    <DetailRow label="Autonomy" value={selectedNode.data.autonomy ?? '—'} />
                    <DetailRow label="Sampling" value={selectedNode.data.sampling ?? '—'} />
                    {selectedNode.data.description && (
                      <div>
                        <div style="font-size:10px;color:#9ca3af;margin-bottom:2px">Description</div>
                        <div style="font-size:11px;color:#374151">{selectedNode.data.description}</div>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <DetailRow label="Name" value={selectedNode.data.name} />
                    <DetailRow label="URL" value={selectedNode.data.url} />
                    <DetailRow label="Transport" value={selectedNode.data.transport} />
                  </>
                )}
              </div>
            </>
          ) : (
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;text-align:center;color:#9ca3af">
              <span class="material-symbols-outlined" style="font-size:32px;opacity:0.4;margin-bottom:8px">info</span>
              <div style="font-size:12px">Click a node to see details</div>
            </div>
          )}
        </div>
      </div>

      {/* MCP modal */}
      {mcpModalOpen && (
        <div
          style="position:absolute;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:20"
          onClick={(e) => { if (e.target === e.currentTarget) setMcpModalOpen(false); }}
        >
          <div style="background:white;border-radius:16px;padding:24px;width:400px;max-width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.15)">
            <div style="font-weight:700;font-size:16px;color:#111827;margin-bottom:16px">Add MCP Server</div>
            <div style="display:flex;flex-direction:column;gap:12px">
              <FormField
                label="Name"
                value={mcpDraft.name}
                onChange={(v) => setMcpDraft((d) => ({ ...d, name: v }))}
                placeholder="My MCP Server"
              />
              <FormField
                label="URL"
                value={mcpDraft.url}
                onChange={(v) => setMcpDraft((d) => ({ ...d, url: v }))}
                placeholder="https://mcp.example.com/sse"
              />
              <div>
                <label style="font-size:12px;font-weight:500;color:#374151;display:block;margin-bottom:4px">Transport</label>
                <select
                  value={mcpDraft.transport}
                  onChange={(e) => setMcpDraft((d) => ({ ...d, transport: (e.target as HTMLSelectElement).value }))}
                  style="width:100%;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:13px;outline:none"
                >
                  <option value="sse">SSE</option>
                  <option value="stdio">stdio</option>
                  <option value="http">HTTP</option>
                </select>
              </div>
              <FormField
                label="Token (optional)"
                value={mcpDraft.token}
                onChange={(v) => setMcpDraft((d) => ({ ...d, token: v }))}
                placeholder="Bearer token…"
              />
            </div>
            <div style="display:flex;gap:8px;margin-top:20px">
              <button
                onClick={() => setMcpModalOpen(false)}
                style="flex:1;background:#f3f4f6;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:500;cursor:pointer;color:#374151"
              >
                Cancel
              </button>
              <button
                onClick={addMcp}
                style="flex:1;background:#003d9b;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:500;cursor:pointer;color:white"
              >
                Add Server
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style="font-size:10px;color:#9ca3af;margin-bottom:1px">{label}</div>
      <div style="font-size:12px;color:#111827;font-weight:500;word-break:break-all">{value}</div>
    </div>
  );
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label style="font-size:12px;font-weight:500;color:#374151;display:block;margin-bottom:4px">{label}</label>
      <input
        value={value}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        placeholder={placeholder}
        style="width:100%;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;box-sizing:border-box"
      />
    </div>
  );
}

// ── Teams List View ───────────────────────────────────────────────────────────

function TeamsListView({
  teams,
  agents,
  activity,
  testTeam,
  onEditTeam,
  onTestTeam,
  onDeleteTeam,
  onDeployTeam,
  onNewTeam,
  onClose,
  onCloseTest,
}: {
  teams: Team[];
  agents: Agent[];
  activity: ActivityEntry[];
  testTeam: Team | null;
  onEditTeam: (t: Team) => void;
  onTestTeam: (t: Team) => void;
  onDeleteTeam: (id: string) => void;
  onDeployTeam: (t: Team) => void;
  onNewTeam: () => void;
  onClose: () => void;
  onCloseTest: () => void;
}) {
  const drafts = teams.filter((t) => t.status === 'draft');
  const production = teams.filter((t) => t.status === 'production');

  return (
    <div style="display:flex;flex-direction:column;height:100%">
      {/* Header */}
      <header class="flex items-center justify-between px-6 shrink-0"
              style="background:#fff;border-bottom:1px solid rgba(195,198,214,0.2);height:52px">
        <div class="flex items-center gap-3">
          <button onClick={onClose}
                  class="flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                  style="background:none;border:none;cursor:pointer;color:#6b7280">
            <span class="material-symbols-outlined" style="font-size:15px">arrow_back</span>
            Board
          </button>
          <span class="select-none text-[11px]" style="color:rgba(195,198,214,0.7)">|</span>
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-lg flex items-center justify-center shrink-0" style="background:#003d9b">
              <span class="material-symbols-outlined" style="font-size:14px;color:#fff">groups</span>
            </div>
            <h1 class="text-[13px] font-bold" style="color:#191c1e">Teams</h1>
          </div>
        </div>
        <button
          onClick={onNewTeam}
          class="flex items-center gap-1.5 text-[12px] font-semibold px-4 py-1.5 rounded-full active:scale-95 transition-all duration-150"
          style="background:#003d9b;color:#fff;border:none;cursor:pointer"
        >
          <span class="material-symbols-outlined" style="font-size:14px">add</span>
          New Team
        </button>
      </header>

      {/* Body */}
      <div style="flex:1;overflow:hidden;display:flex">
        {/* Two columns */}
        <div style="flex:1;overflow-y:auto;padding:20px 24px;display:grid;grid-template-columns:1fr 1fr;gap:20px;align-content:start">

          {/* Draft column */}
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <span style="font-weight:600;font-size:14px;color:#374151">Draft</span>
              <span style="background:#f3f4f6;color:#6b7280;font-size:11px;font-weight:600;padding:2px 8px;border-radius:9999px">
                {drafts.length}
              </span>
            </div>
            <div style="display:flex;flex-direction:column;gap:12px">
              {drafts.length === 0 ? (
                <div style="text-align:center;padding:32px 16px;color:#9ca3af;border:2px dashed #e5e7eb;border-radius:12px">
                  <span class="material-symbols-outlined" style="font-size:28px;display:block;margin-bottom:6px;opacity:0.5">
                    draft
                  </span>
                  <div style="font-size:12px">No draft teams</div>
                </div>
              ) : (
                drafts.map((team) => (
                  <TeamCard
                    key={team.id}
                    team={team}
                    agents={agents}
                    onEdit={onEditTeam}
                    onTest={onTestTeam}
                    onDelete={onDeleteTeam}
                    onDeploy={onDeployTeam}
                  />
                ))
              )}
            </div>
          </div>

          {/* Production column */}
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <span style="font-weight:600;font-size:14px;color:#374151">Production</span>
              <span style="background:#dcfce7;color:#16a34a;font-size:11px;font-weight:600;padding:2px 8px;border-radius:9999px">
                {production.length}
              </span>
            </div>
            <div style="display:flex;flex-direction:column;gap:12px">
              {production.length === 0 ? (
                <div style="text-align:center;padding:32px 16px;color:#9ca3af;border:2px dashed #e5e7eb;border-radius:12px">
                  <span class="material-symbols-outlined" style="font-size:28px;display:block;margin-bottom:6px;opacity:0.5">
                    rocket_launch
                  </span>
                  <div style="font-size:12px">No production teams</div>
                </div>
              ) : (
                production.map((team) => (
                  <TeamCard
                    key={team.id}
                    team={team}
                    agents={agents}
                    onEdit={onEditTeam}
                    onTest={onTestTeam}
                    onDelete={onDeleteTeam}
                    onDeploy={onDeployTeam}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {/* Activity feed */}
        <ActivityFeed entries={activity} />
      </div>

      {/* Test panel (slides in from right, within the overlay) */}
      {testTeam && <TestPanel team={testTeam} onClose={onCloseTest} />}
    </div>
  );
}

// ── Main Export ───────────────────────────────────────────────────────────────

export default function TeamsPanel() {
  const isOpen = teamsPanelOpenSignal.value;
  if (!isOpen) return null;

  const agents: Agent[] = agentsSignal.value as Agent[];

  const [teams, setTeams] = useState<Team[]>(getTeams);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [editingTeam, setEditingTeam] = useState<Team | null | 'new'>('none' as any);
  const [showCanvas, setShowCanvas] = useState(false);
  const [canvasTeam, setCanvasTeam] = useState<Team | null>(null);
  const [testTeam, setTestTeam] = useState<Team | null>(null);

  function addActivity(msg: string) {
    setActivity((prev) => [{ time: formatTime(), msg }, ...prev].slice(0, 20));
  }

  function handleEditTeam(team: Team) {
    setCanvasTeam(team);
    setShowCanvas(true);
  }

  function handleNewTeam() {
    setCanvasTeam(null);
    setShowCanvas(true);
  }

  function handleCloseCanvas() {
    setShowCanvas(false);
    setCanvasTeam(null);
  }

  function handleSaved(msg: string) {
    setTeams(getTeams());
    addActivity(msg);
  }

  function handleDeleteTeam(id: string) {
    removeTeam(id);
    setTeams(getTeams());
    addActivity('Team removed');
  }

  function handleDeployTeam(team: Team) {
    const updated: Team = { ...team, status: 'production' };
    saveTeam(updated);
    setTeams(getTeams());
    addActivity(`Team "${team.name}" deployed to production`);
  }

  function handleTestTeam(team: Team) {
    setTestTeam(team);
  }

  function handleCloseTest() {
    setTestTeam(null);
  }

  return (
    <div
      style="
        position:fixed;inset:0;z-index:50;
        background:rgba(0,0,0,0.5);
        display:flex;align-items:stretch;
      "
      onClick={(e) => {
        if (e.target === e.currentTarget) teamsPanelOpenSignal.value = false;
      }}
    >
      <div
        style="
          position:fixed;inset:0;
          background:#f8f9fc;
          display:flex;flex-direction:column;
          overflow:hidden;
        "
        onClick={(e) => e.stopPropagation()}
      >
        {showCanvas ? (
          <WorkflowCanvas
            team={canvasTeam}
            agents={agents}
            onClose={handleCloseCanvas}
            onSaved={handleSaved}
          />
        ) : (
          <TeamsListView
            teams={teams}
            agents={agents}
            activity={activity}
            testTeam={testTeam}
            onEditTeam={handleEditTeam}
            onTestTeam={handleTestTeam}
            onDeleteTeam={handleDeleteTeam}
            onDeployTeam={handleDeployTeam}
            onNewTeam={handleNewTeam}
            onClose={() => { teamsPanelOpenSignal.value = false; }}
            onCloseTest={handleCloseTest}
          />
        )}
      </div>
    </div>
  );
}
