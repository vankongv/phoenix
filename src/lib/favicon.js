/**
 * Dynamic favicon & tab-title manager.
 *
 * Subscribes to the event bus and derives an overall system status from:
 *   - service health (agent server, semantic API)
 *   - agent run states (running, needs_review, failed, done)
 *
 * Status priority (highest wins):
 *   💀 critical  — both services down
 *   🚧 error     — a run failed or a service is down
 *   ❓ attention — a run needs review / approval
 *   ⚡ active    — a run is in progress
 *   🟢 healthy   — everything nominal
 *   💤 idle      — no repo loaded yet
 *
 * Favicon is an inline SVG data-URI (no external files needed).
 */
import { bus } from './event-bus.js';
import { runStore } from './implementer.js';

const BASE_TITLE = 'Phoenix';

// ── State ────────────────────────────────────────────────────────────
let _serviceHealth = { agent: null, semantic: null }; // null = unknown
let _linkEl = null;

// ── Status config ────────────────────────────────────────────────────
const STATUS = {
  critical:  { emoji: '💀', color: '#ba1a1a', label: 'critical' },
  error:     { emoji: '🚧', color: '#ba1a1a', label: 'error' },
  attention: { emoji: '❓', color: '#e8a317', label: 'attention' },
  active:    { emoji: '⚡', color: '#e8a317', label: 'active' },
  healthy:   { emoji: '🟢', color: '#16a34a', label: 'healthy' },
  idle:      { emoji: '💤', color: '#737885', label: 'idle' },
};

// ── SVG favicon builder ──────────────────────────────────────────────

function buildFaviconSvg(color) {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
      `<circle cx="16" cy="16" r="14" fill="${color}"/>` +
      `<text x="16" y="22" text-anchor="middle" font-size="18" font-weight="bold" fill="white" font-family="system-ui,sans-serif">P</text>` +
    `</svg>`
  )}`;
}

// ── Apply ────────────────────────────────────────────────────────────

function apply(status) {
  const cfg = STATUS[status];

  // Tab title
  document.title = `${cfg.emoji} ${BASE_TITLE}`;

  // Favicon
  if (!_linkEl) {
    _linkEl = document.querySelector('link[rel="icon"]');
    if (!_linkEl) {
      _linkEl = document.createElement('link');
      _linkEl.rel = 'icon';
      _linkEl.type = 'image/svg+xml';
      document.head.appendChild(_linkEl);
    }
  }
  _linkEl.href = buildFaviconSvg(cfg.color);
}

// ── Derive overall status ────────────────────────────────────────────

function deriveStatus() {
  const agentOk = _serviceHealth.agent;
  const semanticOk = _serviceHealth.semantic;

  // Both services down → critical
  if (agentOk === false && semanticOk === false) return 'critical';

  // Scan all active runs for the highest-priority state
  let hasRunning = false;
  let hasFailed = false;
  let hasNeedsReview = false;

  for (const [, run] of runStore) {
    if (run.status === 'running' || run.status === 'pending') hasRunning = true;
    if (run.status === 'failed') hasFailed = true;
    if (run.status === 'needs_review') hasNeedsReview = true;
  }

  // Any service down → error (even if runs are fine)
  if (agentOk === false || semanticOk === false) return 'error';

  // Run-level statuses
  if (hasFailed) return 'error';
  if (hasNeedsReview) return 'attention';
  if (hasRunning) return 'active';

  // Services healthy (or unknown on first load)
  if (agentOk === true) return 'healthy';

  return 'idle';
}

function refresh() {
  apply(deriveStatus());
}

// ── Event subscriptions ──────────────────────────────────────────────

export function initFavicon() {
  // Service health updates
  bus.on('service:health', (data) => {
    _serviceHealth = { ...data };
    refresh();
  });

  // Run status changes
  bus.on('run:update', () => {
    refresh();
  });

  // Initial state
  refresh();
}
