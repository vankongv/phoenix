/**
 * Shared reactive state bridge.
 *
 * Wraps runStore / logStore / agents as @preact/signals so every
 * Preact island subscribes to the same source of truth and re-renders
 * automatically when data changes.
 *
 * Vanilla JS (main.js, board-loader.js, …) can also read/write these
 * signals directly — signals are framework-agnostic.
 */
import { signal } from '@preact/signals';
import { runStore, logStore, onRunUpdate, clearHistory as _clearHistory } from './implementer.js';
import {
  getAgents as _getAgents,
  saveAgent as _saveAgent,
  removeAgent as _removeAgent,
} from './agents.js';

// ── UI visibility signals ────────────────────────────────────────────────────
// Toggled by vanilla JS (main.js) and read by each island.

export const railOpenSignal = signal(false);
export const runHistoryOpenSignal = signal(false);
export const agentsPanelOpenSignal = signal(false);
export const teamsPanelOpenSignal = signal(false);
export const planningPanelOpenSignal = signal(false);

// Drawer: carries the selected issue + active tab so the island re-renders on
// every open/close/tab-switch without any extra prop drilling.
export const drawerSignal = signal({ issue: null, tab: 'details' });

export function openDrawer(issue, tab = 'details') {
  drawerSignal.value = { issue, tab };
}
export function closeDrawer() {
  drawerSignal.value = { issue: null, tab: 'details' };
}
export function setDrawerTab(tab) {
  // peek() reads without subscribing — we only want to update, not trigger extra renders here
  drawerSignal.value = { ...drawerSignal.peek(), tab };
}

// ── Data signals ─────────────────────────────────────────────────────────────
// Seeded from localStorage-restored Maps (implementer.js IIFE runs first).

export const runsSignal = signal(new Map(runStore));
export const logsSignal = signal(new Map(logStore));
export const agentsSignal = signal(_getAgents());

// Bridge: every time implementer fires a run update, push new Map copies so
// all subscribed islands re-render.
onRunUpdate(() => {
  runsSignal.value = new Map(runStore);
  logsSignal.value = new Map(logStore);
});

// ── Agent helpers ─────────────────────────────────────────────────────────────
// Wrap the localStorage CRUD so islands never call localStorage directly.

export function refreshAgents() {
  agentsSignal.value = _getAgents();
}
export function saveAgent(a) {
  _saveAgent(a);
  refreshAgents();
}
export function removeAgent(id) {
  _removeAgent(id);
  refreshAgents();
}

// ── History ───────────────────────────────────────────────────────────────────
// clearHistory() already triggers onRunUpdate → signals update automatically.

export function clearHistory() {
  _clearHistory();
}
