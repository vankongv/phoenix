import { escHtml } from '../lib/formatters.js';
import { getAgents } from '../lib/agents.js';
import { getTeams, saveTeam, removeTeam } from '../lib/agents.js';

const $ = (id) => document.getElementById(id);

const teamsPanel = $('teams-panel');

// ── Activity feed ─────────────────────────────────────────────
const _teamActivity = [];
function _addTeamActivity(msg) {
  const now = new Date();
  const time = now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  _teamActivity.unshift({ time, msg });
  if (_teamActivity.length > 20) _teamActivity.pop();
  _renderTeamActivity();
}

function _renderTeamActivity() {
  const feed = $('team-activity-feed');
  if (!feed) return;
  if (_teamActivity.length === 0) {
    feed.innerHTML = `
      <div class="flex flex-col items-center gap-2 mt-8 text-center">
        <i data-lucide="clock" class="lc" style="width:20px;height:20px;color:rgba(195,198,214,0.6)"></i>
        <p class="text-xs text-on-surface-variant/40 leading-snug">Activity will appear<br>here as you work.</p>
      </div>`;
    if (window.lucide) lucide.createIcons();
    return;
  }
  feed.innerHTML = _teamActivity
    .map(
      (e) => `
    <div class="flex gap-2.5 py-1.5" style="border-bottom:1px solid rgba(195,198,214,0.12)">
      <div class="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style="background:rgba(0,61,155,0.35)"></div>
      <div>
        <p class="text-[10px] font-semibold" style="color:#737885">Today ${e.time}</p>
        <p class="text-xs text-on-surface leading-snug mt-0.5">${escHtml(e.msg)}</p>
      </div>
    </div>
  `
    )
    .join('');
}

// ── Test Panel ────────────────────────────────────────────────
let _testingTeam = null;

function openTestPanel(team) {
  _testingTeam = team;
  $('test-panel-team-name').textContent = `— ${team.name}`;
  $('test-input').value = '';
  $('test-output').innerHTML = '';
  $('test-output').classList.add('hidden');
  const panel = $('team-test-panel');
  panel.classList.remove('hidden');
  panel.classList.add('flex');
  if (window.lucide) lucide.createIcons();
}

// ── Workflow canvas state ─────────────────────────────────────
let WF_editingTeam = null;
let WF_agentOrder = [];
let WF_mcpList = [];
let WF_zoom = 1;
let WF_panX = 0;
let WF_panY = 0;
let WF_nodePositions = {};
let WF_selectedNode = null;
let _nodeDragging = false;
let _nodeDragId = null;
let _nodeDragStart = null;
let _nodeDragMoved = false;
let _canvasPanning = false;
let _canvasPanStart = null;
let WF_selectedTransport = 'sse';

const WF2_CARD_W = 220;
const WF2_CARD_H = 58;
const WF2_GAP_X = 300;
const WF2_GAP_Y = 110;

function openWorkflowCanvas(team) {
  WF_editingTeam = team ? { ...team } : null;
  WF_agentOrder = team?.agents ? [...team.agents] : [];
  WF_mcpList = team?.mcpServers ? team.mcpServers.map((m) => ({ ...m })) : [];
  WF_zoom = 1;
  WF_panX = 0;
  WF_panY = 0;
  WF_nodePositions = team?.nodePositions ? { ...team.nodePositions } : {};
  WF_selectedNode = null;

  $('wf-team-name').value = team?.name ?? '';
  const defaultMode = team?.mode ?? 'sequential';
  const defaultStage = team?.status ?? 'draft';
  document
    .querySelectorAll('.wf-mode-pill')
    .forEach((b) => b.classList.toggle('active', b.dataset.wfmode === defaultMode));
  document
    .querySelectorAll('.wf-stage-pill')
    .forEach((b) => b.classList.toggle('active', b.dataset.wfstage === defaultStage));

  const ct = $('wf-canvas-transform');
  if (ct) ct.style.transform = 'translate(0px,0px) scale(1)';
  $('wf-zoom-label').textContent = '100%';

  const detail = $('wf-node-detail');
  detail.classList.add('hidden');
  detail.classList.remove('flex');

  _wfRender();
  $('wf-overlay').classList.remove('hidden');
  _setupCanvasEvents();
  if (window.lucide) lucide.createIcons();
}

function _wfClose() {
  $('wf-overlay').classList.add('hidden');
  const detail = $('wf-node-detail');
  detail.classList.add('hidden');
  detail.classList.remove('flex');
  WF_editingTeam = null;
  WF_agentOrder = [];
  WF_mcpList = [];
  WF_zoom = 1;
  WF_selectedNode = null;
}

// ── Zoom helpers ──────────────────────────────────────────────
function _wfApplyZoom(z) {
  WF_zoom = Math.min(3, Math.max(0.2, z));
  const t = $('wf-canvas-transform');
  if (t) t.style.transform = `translate(${WF_panX}px,${WF_panY}px) scale(${WF_zoom})`;
  $('wf-zoom-label').textContent = `${Math.round(WF_zoom * 100)}%`;
}

// ── Canvas pan + wheel zoom ───────────────────────────────────
function _setupCanvasEvents() {
  const root = $('wf-canvas-root');
  if (!root || root._wf2Init) return;
  root._wf2Init = true;

  root.addEventListener('mousedown', (e) => {
    if (
      e.target.closest('.wf2-node') ||
      e.target.closest('.wf2-del') ||
      e.target.closest('.wf2-handle')
    )
      return;
    _canvasPanning = true;
    _canvasPanStart = { mx: e.clientX, my: e.clientY, px: WF_panX, py: WF_panY };
    root.classList.add('panning');
    e.preventDefault();
  });

  root.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const delta = e.deltaY > 0 ? -0.12 : 0.12;
      const newZoom = Math.min(3, Math.max(0.2, WF_zoom + delta));
      const ratio = newZoom / WF_zoom;
      WF_panX = mx - (mx - WF_panX) * ratio;
      WF_panY = my - (my - WF_panY) * ratio;
      WF_zoom = newZoom;
      const t = $('wf-canvas-transform');
      if (t) t.style.transform = `translate(${WF_panX}px,${WF_panY}px) scale(${WF_zoom})`;
      $('wf-zoom-label').textContent = `${Math.round(WF_zoom * 100)}%`;
    },
    { passive: false }
  );
}

window.addEventListener('mousemove', (e) => {
  if (_canvasPanning && _canvasPanStart) {
    WF_panX = _canvasPanStart.px + (e.clientX - _canvasPanStart.mx);
    WF_panY = _canvasPanStart.py + (e.clientY - _canvasPanStart.my);
    const t = $('wf-canvas-transform');
    if (t) t.style.transform = `translate(${WF_panX}px,${WF_panY}px) scale(${WF_zoom})`;
  }
  if (_nodeDragging && _nodeDragId && _nodeDragStart) {
    _nodeDragMoved = true;
    const dx = (e.clientX - _nodeDragStart.mx) / WF_zoom;
    const dy = (e.clientY - _nodeDragStart.my) / WF_zoom;
    WF_nodePositions[_nodeDragId] = {
      x: _nodeDragStart.nx + dx,
      y: _nodeDragStart.ny + dy,
    };
    const el = $('wf-nodes-layer')?.querySelector(`[data-node-id="${_nodeDragId}"]`);
    if (el) {
      el.style.left = WF_nodePositions[_nodeDragId].x + 'px';
      el.style.top = WF_nodePositions[_nodeDragId].y + 'px';
    }
    _wfDrawEdges();
  }
});

window.addEventListener('mouseup', () => {
  if (_canvasPanning) {
    _canvasPanning = false;
    _canvasPanStart = null;
    $('wf-canvas-root')?.classList.remove('panning');
  }
  if (_nodeDragging) {
    _nodeDragging = false;
    const el = _nodeDragId
      ? $('wf-nodes-layer')?.querySelector(`[data-node-id="${_nodeDragId}"]`)
      : null;
    if (el) {
      el.classList.remove('wf2-dragging');
      el.style.zIndex = '';
    }
    _nodeDragId = null;
    _nodeDragStart = null;
    document.body.style.userSelect = '';
    setTimeout(() => {
      _nodeDragMoved = false;
    }, 0);
  }
});

// ── Render helpers ────────────────────────────────────────────
function _wfRender() {
  _wfRenderPalette();
  _wfRenderMcpPalette();
  _wfRenderFlow();
  if (window.lucide) lucide.createIcons();
}

function _wfRenderPalette() {
  const palette = $('wf-palette');
  const agents = getAgents();
  const inFlow = new Set(WF_agentOrder);
  palette.innerHTML = '';

  if (agents.length === 0) {
    palette.innerHTML = `
      <div class="flex flex-col items-center gap-2.5 px-2 py-4 text-center">
        <div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:#dae2ff">
          <i data-lucide="bot" class="lc" style="width:18px;height:18px;color:#003d9b"></i>
        </div>
        <p class="text-xs font-semibold text-on-surface">No agents yet</p>
        <p class="text-[10px] text-on-surface-variant/50 leading-snug">Create agents in the Agents panel first.</p>
      </div>`;
    return;
  }

  agents.forEach((agent) => {
    const isIn = inFlow.has(agent.id);
    const pColor =
      { claude: '#FF6B2B', copilot: '#24292E', openai: '#10A37F' }[agent.provider] ?? '#003d9b';
    const el = document.createElement('div');
    el.className = 'wf-palette-item' + (isIn ? ' in-flow' : '');
    el.innerHTML = `
      <div class="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold flex-shrink-0"
           style="background:${pColor}22;color:${pColor}">${escHtml(agent.name.slice(0, 2).toUpperCase())}</div>
      <div class="min-w-0 flex-1">
        <p class="wf-palette-name text-xs font-bold text-on-surface truncate">${escHtml(agent.name)}</p>
        <p class="text-[10px] text-on-surface-variant/50 truncate">${escHtml(agent.description || agent.provider)}</p>
      </div>
      <i data-lucide="${isIn ? 'check-circle' : 'plus-circle'}" class="lc flex-shrink-0"
         style="width:14px;height:14px;color:${isIn ? '#16a34a' : 'rgba(0,61,155,0.6)'}"></i>
    `;
    el.addEventListener('click', () => {
      if (isIn) {
        const idx = WF_agentOrder.indexOf(agent.id);
        if (idx > -1) WF_agentOrder.splice(idx, 1);
      } else {
        WF_agentOrder.push(agent.id);
      }
      _wfRender();
    });
    palette.appendChild(el);
  });

  const searchEl = $('wf-palette-search');
  if (searchEl) {
    searchEl.value = '';
    searchEl.oninput = () => {
      const q = searchEl.value.toLowerCase();
      palette.querySelectorAll('.wf-palette-item').forEach((el) => {
        const name = el.querySelector('.wf-palette-name')?.textContent.toLowerCase() ?? '';
        el.style.display = name.includes(q) ? '' : 'none';
      });
    };
  }
}

function _wfRenderMcpPalette() {
  const palette = $('wf-mcp-palette');
  const mcpCount = $('wf-mcp-count');
  const inFlow = new Set(WF_agentOrder);
  palette.innerHTML = '';
  if (mcpCount) mcpCount.textContent = WF_mcpList.length;

  if (WF_mcpList.length === 0) {
    palette.innerHTML =
      '<p class="text-[10px] text-on-surface-variant/40 px-2">No MCP servers. Click Add.</p>';
    return;
  }

  WF_mcpList.forEach((mcp) => {
    const isIn = inFlow.has(mcp.id);
    const el = document.createElement('div');
    el.className = 'wf-mcp-palette-item' + (isIn ? ' in-flow' : '');
    el.innerHTML = `
      <i data-lucide="plug" class="lc flex-shrink-0" style="width:12px;height:12px;color:#7c3aed"></i>
      <div class="min-w-0 flex-1">
        <p class="text-xs font-bold text-on-surface truncate">${escHtml(mcp.name)}</p>
        <p class="text-[10px] text-on-surface-variant/50 truncate">${escHtml(mcp.transport)} · ${escHtml(mcp.url)}</p>
      </div>
      <i data-lucide="${isIn ? 'check-circle' : 'plus-circle'}" class="lc flex-shrink-0"
         style="width:13px;height:13px;color:${isIn ? '#16a34a' : 'rgba(124,58,237,0.6)'}"></i>
    `;
    el.addEventListener('click', () => {
      if (isIn) {
        const idx = WF_agentOrder.indexOf(mcp.id);
        if (idx > -1) WF_agentOrder.splice(idx, 1);
      } else {
        WF_agentOrder.push(mcp.id);
      }
      _wfRender();
    });
    palette.appendChild(el);
  });
}

function _wfRenderFlow() {
  const agents = getAgents();
  const empty = $('wf-empty');
  const layer = $('wf-nodes-layer');
  const fab = $('wf-add-node-fab');
  const counter = $('wf-agent-count');
  if (!layer) return;

  counter.textContent = WF_agentOrder.length;

  if (WF_agentOrder.length === 0) {
    empty?.classList.remove('hidden');
    fab?.classList.add('hidden');
    layer.innerHTML = '';
    const svg = $('wf-edges-svg');
    if (svg) svg.innerHTML = '';
    return;
  }
  empty?.classList.add('hidden');
  fab?.classList.remove('hidden');

  const resolved = WF_agentOrder.map((id, rawIdx) => {
    const agent = agents.find((a) => a.id === id);
    const mcp = WF_mcpList.find((m) => m.id === id);
    return { id, agent, mcp, isMcp: !!mcp, rawIdx };
  }).filter((n) => n.agent || n.mcp);

  _wfAutoLayout(resolved);
  layer.innerHTML = '';
  resolved.forEach((n) => _wfRenderNode(n, layer));
  _wfDrawEdges(resolved);
  if (window.lucide) lucide.createIcons();
}

function _wfAutoLayout(resolved) {
  const mode = document.querySelector('.wf-mode-pill.active')?.dataset.wfmode ?? 'sequential';
  const needsLayout = resolved.some((n) => !WF_nodePositions[n.id]);
  if (!needsLayout) return;

  if (mode === 'parallel') {
    const totalH = (resolved.length - 1) * WF2_GAP_Y;
    const startY = Math.max(60, 200 - totalH / 2);
    resolved.forEach((n, i) => {
      if (!WF_nodePositions[n.id]) WF_nodePositions[n.id] = { x: 200, y: startY + i * WF2_GAP_Y };
    });
  } else {
    const cols = 4;
    resolved.forEach((n, i) => {
      if (!WF_nodePositions[n.id]) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        WF_nodePositions[n.id] = {
          x: 60 + col * WF2_GAP_X,
          y: 80 + row * (WF2_CARD_H + 120),
        };
      }
    });
  }
}

function _wfRenderNode(n, layer) {
  const { id, agent, mcp, isMcp, rawIdx } = n;
  const pos = WF_nodePositions[id] ?? { x: 80, y: 80 };

  const provColor = { claude: '#E8510A', copilot: '#24292E', openai: '#10A37F' };
  const provIcon = { claude: 'bot', copilot: 'code-2', openai: 'sparkles' };
  const fbColors = ['#003d9b', '#7c3aed', '#16a34a', '#b45309', '#be185d'];
  const laneLabel = {
    triage: 'Triage',
    todo: 'To Do',
    in_progress: 'In Progress',
    in_review: 'Review',
  };

  const label = isMcp ? mcp.name : agent.name;
  const subtitle = isMcp ? mcp.transport : agent.model || agent.provider || '';
  const desc = isMcp ? mcp.url : agent.description || '';
  const color = isMcp
    ? '#7c3aed'
    : (provColor[agent?.provider] ?? fbColors[rawIdx % fbColors.length]);
  const iconName = isMcp ? 'plug' : (provIcon[agent?.provider] ?? 'bot');
  const lanes = !isMcp && agent?.lanes?.length ? agent.lanes : [];

  const el = document.createElement('div');
  el.className = 'wf2-node';
  el.style.left = pos.x + 'px';
  el.style.top = pos.y + 'px';
  el.dataset.nodeId = id;

  const hasFooter = !!(desc || lanes.length);
  el.innerHTML = `
    <div class="wf2-card">
      <div class="wf2-handle wf2-handle-left"></div>
      <div class="wf2-icon-box" style="background:${color}">
        <i data-lucide="${iconName}" class="lc" style="width:18px;height:18px;color:#fff"></i>
      </div>
      <div class="wf2-card-text">
        <p class="wf2-title">${escHtml(label)}</p>
        <p class="wf2-subtitle">${escHtml(subtitle)}</p>
      </div>
      <div class="wf2-handle wf2-handle-right"></div>
      <button class="wf2-del" title="Remove">
        <i data-lucide="x" class="lc" style="width:10px;height:10px"></i>
      </button>
    </div>
    ${
      hasFooter
        ? `<div class="wf2-footer">
      ${desc ? `<p class="wf2-desc">${escHtml(desc.slice(0, 90))}${desc.length > 90 ? '…' : ''}</p>` : ''}
      ${
        lanes.length
          ? `<div class="wf2-tags">${lanes
              .slice(0, 3)
              .map((l) => `<span class="wf2-tag">${escHtml(laneLabel[l] ?? l)}</span>`)
              .join('')}</div>`
          : ''
      }
    </div>`
        : ''
    }
  `;

  const card = el.querySelector('.wf2-card');
  card.addEventListener('mousedown', (e) => {
    if (e.target.closest('.wf2-del') || e.target.closest('.wf2-handle')) return;
    e.stopPropagation();
    e.preventDefault();
    _nodeDragging = true;
    _nodeDragMoved = false;
    _nodeDragId = id;
    const p = WF_nodePositions[id];
    _nodeDragStart = { mx: e.clientX, my: e.clientY, nx: p.x, ny: p.y };
    el.classList.add('wf2-dragging');
    el.style.zIndex = '10';
    document.body.style.userSelect = 'none';
  });

  el.addEventListener('click', (e) => {
    if (e.target.closest('.wf2-del') || e.target.closest('.wf2-handle')) return;
    if (_nodeDragMoved) return;
    document.querySelectorAll('.wf2-node').forEach((nd) => nd.classList.remove('wf2-selected'));
    el.classList.add('wf2-selected');
    _wfShowNodeDetail(isMcp ? { type: 'mcp', data: mcp } : { type: 'agent', data: agent });
  });

  el.querySelector('.wf2-del').addEventListener('click', (e) => {
    e.stopPropagation();
    WF_agentOrder.splice(WF_agentOrder.indexOf(id), 1);
    delete WF_nodePositions[id];
    _wfRenderFlow();
    if (window.lucide) lucide.createIcons();
  });

  layer.appendChild(el);
}

function _wfDrawEdges(resolved) {
  const svg = $('wf-edges-svg');
  if (!svg) return;
  svg.innerHTML = '';

  if (!resolved) {
    const agents = getAgents();
    resolved = WF_agentOrder.map((id, rawIdx) => {
      const agent = agents.find((a) => a.id === id);
      const mcp = WF_mcpList.find((m) => m.id === id);
      return { id, agent, mcp, isMcp: !!mcp, rawIdx };
    }).filter((n) => n.agent || n.mcp);
  }
  if (resolved.length < 2) return;

  const mode = document.querySelector('.wf-mode-pill.active')?.dataset.wfmode ?? 'sequential';
  const edgeColor =
    { sequential: '#003d9b', parallel: '#7c3aed', consensus: '#16a34a' }[mode] ?? '#003d9b';
  const dash = mode === 'consensus' ? '4,4' : '7,4';

  for (let i = 0; i < resolved.length - 1; i++) {
    const fPos = WF_nodePositions[resolved[i].id];
    const tPos = WF_nodePositions[resolved[i + 1].id];
    if (!fPos || !tPos) continue;

    const x1 = fPos.x + WF2_CARD_W;
    const y1 = fPos.y + WF2_CARD_H / 2;
    const x2 = tPos.x;
    const y2 = tPos.y + WF2_CARD_H / 2;
    const tension = Math.min(Math.abs(x2 - x1) * 0.5, 160);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute(
      'd',
      `M ${x1},${y1} C ${x1 + tension},${y1} ${x2 - tension},${y2} ${x2},${y2}`
    );
    path.setAttribute('stroke', edgeColor);
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-dasharray', dash);
    path.setAttribute('fill', 'none');
    path.setAttribute('opacity', '0.55');
    svg.appendChild(path);

    const angle = Math.atan2(y2 - y2, tension);
    const as = 7;
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    arrow.setAttribute(
      'points',
      [
        `${x2},${y2}`,
        `${x2 - as * Math.cos(angle - 0.42)},${y2 - as * Math.sin(angle - 0.42)}`,
        `${x2 - as * Math.cos(angle + 0.42)},${y2 - as * Math.sin(angle + 0.42)}`,
      ].join(' ')
    );
    arrow.setAttribute('fill', edgeColor);
    arrow.setAttribute('opacity', '0.55');
    svg.appendChild(arrow);
  }
}

function _wfShowNodeDetail(item) {
  WF_selectedNode = item;
  const detail = $('wf-node-detail');
  const nameEl = $('wf-detail-name');
  const iconEl = $('wf-detail-icon');
  const badge = $('wf-detail-type-badge');
  const body = $('wf-detail-body');

  const labelStyle =
    'class="text-[10px] font-bold uppercase tracking-wide text-on-surface-variant/50 mb-1"';
  const valStyle = 'class="text-xs font-semibold text-on-surface"';

  if (item.type === 'mcp') {
    const mcp = item.data;
    nameEl.textContent = mcp.name;
    iconEl.textContent = 'MC';
    iconEl.style.background = '#f3e8ff';
    iconEl.style.color = '#7c3aed';
    badge.textContent = 'MCP SERVER';
    badge.style.background = '#f3e8ff';
    badge.style.color = '#7c3aed';
    body.innerHTML = `
      <div><p ${labelStyle}>Transport</p><p ${valStyle}>${escHtml(mcp.transport)}</p></div>
      <div><p ${labelStyle}>URL</p><p class="text-xs font-mono text-on-surface break-all">${escHtml(mcp.url)}</p></div>
      <div><p ${labelStyle}>Token</p><p class="text-xs font-mono text-on-surface">${mcp.token ? '●●●●●●●●' : '(none)'}</p></div>
      <div class="pt-3" style="border-top:1px solid rgba(195,198,214,0.2)">
        <button class="wf-detail-remove text-xs font-semibold flex items-center gap-1.5 transition-colors"
                style="color:#ba1a1a">
          <i data-lucide="trash-2" class="lc" style="width:13px;height:13px"></i> Remove from flow
        </button>
      </div>
    `;
  } else {
    const a = item.data;
    nameEl.textContent = a.name;
    iconEl.textContent = a.name.slice(0, 2).toUpperCase();
    iconEl.style.background = '#dae2ff';
    iconEl.style.color = '#003d9b';
    badge.textContent = 'AGENT';
    badge.style.background = '#dae2ff';
    badge.style.color = '#003d9b';
    body.innerHTML = `
      <div><p ${labelStyle}>Provider</p><p ${valStyle}>${escHtml(a.provider ?? '—')}</p></div>
      <div><p ${labelStyle}>Model</p><p ${valStyle}>${escHtml(a.model ?? '—')}</p></div>
      <div><p ${labelStyle}>Autonomy</p><p ${valStyle}>${escHtml(a.autonomy ?? 'assist')}</p></div>
      <div><p ${labelStyle}>Sampling</p><p ${valStyle}>${escHtml(a.sampling ?? 'balanced')}</p></div>
      ${a.description ? `<div><p ${labelStyle}>Description</p><p class="text-xs text-on-surface leading-relaxed">${escHtml(a.description)}</p></div>` : ''}
      ${a.systemPrompt ? `<div><p ${labelStyle}>System Prompt</p><p class="text-xs text-on-surface-variant/70 leading-relaxed">${escHtml(a.systemPrompt.slice(0, 140))}${a.systemPrompt.length > 140 ? '…' : ''}</p></div>` : ''}
      <div class="pt-3" style="border-top:1px solid rgba(195,198,214,0.2)">
        <button class="wf-detail-remove text-xs font-semibold flex items-center gap-1.5 transition-colors"
                style="color:#ba1a1a">
          <i data-lucide="trash-2" class="lc" style="width:13px;height:13px"></i> Remove from flow
        </button>
      </div>
    `;
  }

  detail.classList.remove('hidden');
  detail.classList.add('flex');

  const removeBtn = body.querySelector('.wf-detail-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      const id = WF_selectedNode?.data?.id;
      const idx = id ? WF_agentOrder.indexOf(id) : -1;
      if (idx > -1) {
        WF_agentOrder.splice(idx, 1);
        detail.classList.add('hidden');
        detail.classList.remove('flex');
        WF_selectedNode = null;
        document
          .querySelectorAll('.wf-node')
          .forEach((n) => n.classList.remove('wf-node-selected'));
        _wfRender();
      }
    });
  }
  if (window.lucide) lucide.createIcons();
}

// ── Teams canvas ──────────────────────────────────────────────
export function renderTeamsCanvas() {
  const teams = getTeams();
  const agents = getAgents();
  const cols = { draft: [], production: [] };
  teams.forEach((t) => {
    const stage = t.status === 'production' ? 'production' : 'draft';
    cols[stage].push(t);
  });

  const modeLabels = { sequential: 'Sequential', parallel: 'Parallel', consensus: 'Consensus' };
  const modeIcons = { sequential: 'arrow-right', parallel: 'git-branch', consensus: 'merge' };
  const modeColors = {
    sequential: { bg: '#dae2ff', text: '#003d9b' },
    parallel: { bg: '#f3e8ff', text: '#7c3aed' },
    consensus: { bg: '#dcfce7', text: '#16a34a' },
  };

  Object.entries(cols).forEach(([stage, stageTeams]) => {
    const col = $(`col-${stage}`);
    const cnt = $(`col-count-${stage}`);
    if (!col) return;
    cnt.textContent = stageTeams.length;
    if (stageTeams.length === 0) {
      const emptyIcon = stage === 'draft' ? 'file-plus-2' : 'zap';
      const emptyTitle = stage === 'draft' ? 'No draft teams' : 'No production teams';
      const emptyDesc =
        stage === 'draft'
          ? 'Click "New Team" to build your first workflow.'
          : 'Deploy a Draft team to see it here.';
      col.innerHTML = `
        <div class="flex flex-col items-center gap-3 mt-12 px-4 text-center">
          <div class="w-12 h-12 rounded-2xl flex items-center justify-center bg-surface-container">
            <i data-lucide="${emptyIcon}" class="lc" style="width:22px;height:22px;color:#737885"></i>
          </div>
          <p class="text-xs font-semibold text-on-surface-variant">${emptyTitle}</p>
          <p class="text-[10px] text-on-surface-variant/50 leading-snug max-w-[160px]">${emptyDesc}</p>
          ${
            stage === 'draft'
              ? `<button onclick="document.getElementById('add-team-btn').click()"
            class="text-xs font-semibold text-primary hover:underline mt-1">+ New Team</button>`
              : ''
          }
        </div>`;
      return;
    }
    col.innerHTML = '';

    stageTeams.forEach((team) => {
      const teamAgents = (team.agents || [])
        .map((id) => agents.find((a) => a.id === id))
        .filter(Boolean);
      const mcpCount = (team.mcpServers || []).length;
      const mc = modeColors[team.mode] ?? modeColors.sequential;
      const modeIcon = modeIcons[team.mode] ?? 'arrow-right';
      const edges = team.edges ?? [];
      const subtitle = `${teamAgents.length} agent${teamAgents.length !== 1 ? 's' : ''}${mcpCount ? ` · ${mcpCount} MCP` : ''} · ${modeLabels[team.mode] ?? 'Sequential'}`;

      const card = document.createElement('div');
      card.className = 'tp-team-card';
      card.style.borderLeft = `3px solid ${mc.text}`;
      card.innerHTML = `
        <div class="px-4 pt-3.5 pb-3.5">
          <div class="flex items-start justify-between gap-2 mb-1">
            <div class="flex-1 min-w-0">
              <p class="text-sm font-bold text-on-surface leading-tight truncate">${escHtml(team.name)}</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5 leading-snug">${escHtml(subtitle)}</p>
            </div>
            <div class="flex items-center gap-1.5 flex-shrink-0">
              <span class="tp-mode-badge" style="background:${mc.bg};color:${mc.text}">
                <i data-lucide="${modeIcon}" class="lc" style="width:10px;height:10px"></i>
                ${modeLabels[team.mode] ?? 'Sequential'}
              </span>
              <button class="tp-card-delete w-6 h-6 flex items-center justify-center rounded-md
                             text-on-surface-variant/30 hover:text-error hover:bg-error/8 transition-colors">
                <i data-lucide="trash-2" class="lc" style="width:12px;height:12px"></i>
              </button>
            </div>
          </div>

          <div class="py-2.5 mb-2" style="border-top:1px solid rgba(195,198,214,0.15);border-bottom:1px solid rgba(195,198,214,0.15)">
            ${_buildFlowDiagram(teamAgents, edges, team.mode)}
          </div>

          <div class="grid grid-cols-3 text-center mb-3 rounded-lg overflow-hidden"
               style="border:1px solid rgba(195,198,214,0.2)">
            <div class="py-2" style="border-right:1px solid rgba(195,198,214,0.2)">
              <p class="text-xs font-bold text-on-surface">${teamAgents.length}</p>
              <p class="text-[10px] text-on-surface-variant/60">Agents</p>
            </div>
            <div class="py-2" style="border-right:1px solid rgba(195,198,214,0.2)">
              <p class="text-xs font-bold text-on-surface">${mcpCount}</p>
              <p class="text-[10px] text-on-surface-variant/60">MCPs</p>
            </div>
            <div class="py-2">
              <p class="text-xs font-bold text-on-surface">$${(teamAgents.length * 1.2).toFixed(2)}</p>
              <p class="text-[10px] text-on-surface-variant/60">/ hour</p>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button class="tp-card-edit flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold
                           bg-primary text-on-primary py-2 rounded-lg hover:opacity-90 active:scale-95 transition-all">
              <i data-lucide="workflow" class="lc" style="width:13px;height:13px"></i> Edit Flow
            </button>
            <button class="tp-card-test flex items-center gap-1.5 text-xs font-semibold
                           px-3 py-2 rounded-lg transition-colors hover:opacity-90"
                    style="background:#f3e8ff;color:#7c3aed">
              <i data-lucide="flask-conical" class="lc" style="width:13px;height:13px"></i> Test
            </button>
            ${
              stage === 'draft'
                ? `<button class="tp-card-promote text-xs font-semibold px-3 py-2 rounded-lg active:scale-95 transition-all"
                   style="background:linear-gradient(135deg,#003d9b,#0052cc);color:#fff">Deploy</button>`
                : `<button class="tp-card-deploy text-xs font-semibold px-3 py-2 rounded-lg flex items-center gap-1.5"
                   style="background:linear-gradient(135deg,#16a34a,#15803d);color:#fff">
                   <i data-lucide="zap" class="lc" style="width:13px;height:13px"></i> Running</button>`
            }
          </div>
        </div>
      `;
      card.querySelector('.tp-card-edit').addEventListener('click', () => openWorkflowCanvas(team));
      card.querySelector('.tp-card-test').addEventListener('click', () => openTestPanel(team));
      card.querySelector('.tp-card-delete').addEventListener('click', () => {
        removeTeam(team.id);
        renderTeamsCanvas();
        _addTeamActivity(`"${team.name}" was deleted.`);
        if (window.lucide) lucide.createIcons();
      });
      const pb = card.querySelector('.tp-card-promote');
      if (pb)
        pb.addEventListener('click', () => {
          team.status = 'production';
          saveTeam(team);
          renderTeamsCanvas();
          _addTeamActivity(`"${team.name}" deployed to production.`);
          if (window.lucide) lucide.createIcons();
        });
      const db = card.querySelector('.tp-card-deploy');
      if (db)
        db.addEventListener('click', () =>
          _addTeamActivity(`"${team.name}" already live in production.`)
        );
      col.appendChild(card);
    });
  });
  _renderTeamActivity();
  if (window.lucide) lucide.createIcons();
}

function _buildFlowDiagram(agents, edges, mode) {
  if (agents.length === 0)
    return '<p class="text-[10px] text-on-surface-variant/40 py-1">No agents — click Edit Flow</p>';
  const colors = ['#003d9b', '#7c3aed', '#16a34a', '#b45309', '#be185d'];
  const bgs = ['#dae2ff', '#f3e8ff', '#dcfce7', '#fff3cd', '#fce7f3'];

  const inDeg = {};
  agents.forEach((a) => {
    inDeg[a.id] = 0;
  });
  (edges ?? []).forEach((e) => {
    if (inDeg[e.to] !== undefined) inDeg[e.to]++;
  });

  const sorted = [...agents].sort((a, b) => (inDeg[a.id] ?? 0) - (inDeg[b.id] ?? 0));

  const connSvg =
    {
      sequential: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="1" y1="7" x2="10" y2="7" stroke="rgba(0,61,155,0.4)" stroke-width="1.5"/><polygon points="8,4 13,7 8,10" fill="rgba(0,61,155,0.4)"/></svg>`,
      parallel: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="1" y1="4" x2="13" y2="4" stroke="rgba(124,58,237,0.5)" stroke-width="1.5"/><line x1="1" y1="10" x2="13" y2="10" stroke="rgba(124,58,237,0.5)" stroke-width="1.5"/></svg>`,
      consensus: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="rgba(22,163,74,0.5)" stroke-width="1.5" fill="none"/><text x="7" y="10.5" text-anchor="middle" font-size="7" fill="rgba(22,163,74,0.7)" font-weight="700">✓</text></svg>`,
    }[mode] ??
    `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="1" y1="7" x2="10" y2="7" stroke="rgba(0,61,155,0.4)" stroke-width="1.5"/><polygon points="8,4 13,7 8,10" fill="rgba(0,61,155,0.4)"/></svg>`;

  return `<div class="flex items-center gap-1 flex-wrap">
    ${sorted
      .slice(0, 4)
      .map((a, i) => {
        const c = colors[i % colors.length];
        const bg = bgs[i % bgs.length];
        const shortName = a.name.length > 7 ? a.name.slice(0, 6) + '…' : a.name;
        return `${i > 0 ? `<span class="flex-shrink-0 opacity-70">${connSvg}</span>` : ''}
      <div class="flex flex-col items-center gap-0.5">
        <div class="w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold flex-shrink-0"
             style="background:${bg};color:${c}">${escHtml(a.name.slice(0, 2).toUpperCase())}</div>
        <p class="text-[10px] text-on-surface-variant/60 w-8 truncate text-center leading-tight">${escHtml(shortName)}</p>
      </div>`;
      })
      .join('')}
    ${agents.length > 4 ? `<span class="text-xs text-on-surface-variant/50 font-semibold self-center ml-1">+${agents.length - 4}</span>` : ''}
  </div>`;
}

// ── Init ─────────────────────────────────────────────────────
export function initTeamsPanel() {
  $('teams-btn').addEventListener('click', () => {
    teamsPanel.classList.remove('hidden');
    teamsPanel.classList.add('flex');
    renderTeamsCanvas();
    if (window.lucide) lucide.createIcons();
  });
  $('teams-panel-close').addEventListener('click', () => {
    teamsPanel.classList.add('hidden');
    teamsPanel.classList.remove('flex');
  });
  $('add-team-btn').addEventListener('click', () => openWorkflowCanvas(null));

  // Test panel
  $('test-panel-close').addEventListener('click', () => {
    $('team-test-panel').classList.add('hidden');
    $('team-test-panel').classList.remove('flex');
    _testingTeam = null;
  });
  $('test-run-btn').addEventListener('click', () => {
    const input = $('test-input').value.trim();
    if (!input) {
      $('test-input').focus();
      return;
    }

    const out = $('test-output');
    out.classList.remove('hidden');

    const agents = _testingTeam
      ? (_testingTeam.agents || [])
          .map((id) => getAgents().find((a) => a.id === id))
          .filter(Boolean)
      : [];
    const steps = [
      {
        label: '🔍 Parsing input',
        detail: `"${input.slice(0, 60)}${input.length > 60 ? '…' : ''}"`,
        ms: 120,
      },
      ...agents.map((a, i) => ({
        label: `🤖 ${a.name}`,
        detail: `Processing with ${a.model || a.provider} · ${a.autonomy ?? 'assist'} mode`,
        ms: 400 + i * 200,
      })),
      { label: '✅ Result ready', detail: 'All agents completed. Output synthesised.', ms: 200 },
    ];

    out.innerHTML = '';
    let delay = 0;
    steps.forEach((step) => {
      delay += step.ms;
      setTimeout(() => {
        const div = document.createElement('div');
        div.className = 'test-step';
        div.style.cssText =
          'opacity:0;transform:translateY(4px);transition:opacity 0.2s,transform 0.2s';
        div.innerHTML = `
          <div class="flex items-start gap-2.5">
            <div class="w-0.5 self-stretch rounded-full flex-shrink-0" style="background:#7c3aed;min-height:28px"></div>
            <div>
              <p class="text-xs font-semibold text-on-surface">${step.label}</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5 leading-snug">${escHtml(step.detail)}</p>
            </div>
          </div>
        `;
        out.appendChild(div);
        requestAnimationFrame(() => {
          div.style.opacity = '1';
          div.style.transform = 'none';
        });
      }, delay);
    });
  });

  // Zoom controls
  $('wf-zoom-in').addEventListener('click', () => _wfApplyZoom(WF_zoom + 0.15));
  $('wf-zoom-out').addEventListener('click', () => _wfApplyZoom(WF_zoom - 0.15));
  $('wf-zoom-reset').addEventListener('click', () => {
    WF_panX = 0;
    WF_panY = 0;
    _wfApplyZoom(1);
  });

  // MCP modal
  $('wf-add-mcp-btn').addEventListener('click', () => {
    $('mcp-form-name').value = '';
    $('mcp-form-url').value = '';
    $('mcp-form-token').value = '';
    WF_selectedTransport = 'sse';
    document
      .querySelectorAll('.mcp-transport-btn')
      .forEach((b) => b.classList.toggle('active', b.dataset.transport === 'sse'));
    $('wf-mcp-modal').classList.remove('hidden');
  });
  $('wf-mcp-modal-close').addEventListener('click', () =>
    $('wf-mcp-modal').classList.add('hidden')
  );
  document.querySelectorAll('.mcp-transport-btn').forEach((b) =>
    b.addEventListener('click', () => {
      WF_selectedTransport = b.dataset.transport;
      document.querySelectorAll('.mcp-transport-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    })
  );
  $('wf-mcp-modal-save').addEventListener('click', () => {
    const name = $('mcp-form-name').value.trim();
    const url = $('mcp-form-url').value.trim();
    if (!name || !url) return;
    WF_mcpList.push({
      id: `mcp_${Date.now()}`,
      name,
      url,
      transport: WF_selectedTransport,
      token: $('mcp-form-token').value.trim(),
    });
    $('wf-mcp-modal').classList.add('hidden');
    _wfRenderMcpPalette();
    if (window.lucide) lucide.createIcons();
  });

  // Node detail panel
  $('wf-detail-close').addEventListener('click', () => {
    const detail = $('wf-node-detail');
    detail.classList.add('hidden');
    detail.classList.remove('flex');
    WF_selectedNode = null;
    document.querySelectorAll('.wf-node').forEach((n) => n.classList.remove('wf-node-selected'));
  });

  $('wf-back').addEventListener('click', _wfClose);

  document.querySelectorAll('.wf-mode-pill').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.wf-mode-pill').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      if (WF_agentOrder.length > 0) {
        _wfRenderFlow();
        if (window.lucide) lucide.createIcons();
      }
    })
  );
  document.querySelectorAll('.wf-stage-pill').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.wf-stage-pill').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    })
  );

  $('wf-save').addEventListener('click', () => {
    const name = $('wf-team-name').value.trim();
    if (!name) {
      $('wf-team-name').focus();
      return;
    }
    const mode = document.querySelector('.wf-mode-pill.active')?.dataset.wfmode ?? 'sequential';
    const status = document.querySelector('.wf-stage-pill.active')?.dataset.wfstage ?? 'draft';
    const agentIds = WF_agentOrder.filter((id) => getAgents().some((a) => a.id === id));
    const edges = agentIds.slice(0, -1).map((id, i) => ({ from: id, to: agentIds[i + 1] }));
    saveTeam({
      id: WF_editingTeam?.id || `team_${Date.now()}`,
      name,
      mode,
      status,
      agents: [...WF_agentOrder],
      mcpServers: [...WF_mcpList],
      edges,
      nodePositions: { ...WF_nodePositions },
    });
    _wfClose();
    renderTeamsCanvas();
    _addTeamActivity(`"${name}" flow saved.`);
    if (window.lucide) lucide.createIcons();
  });

  // FAB focuses palette search
  $('wf-add-node-fab')?.addEventListener('click', () => {
    const s = $('wf-palette-search');
    if (s) {
      s.focus();
      s.select();
    }
  });
}
