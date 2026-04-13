/**
 * Lightweight pub/sub event bus.
 *
 * Decouples event producers (health checks, run updates, etc.) from consumers
 * (favicon, notifications, sounds, etc.) so new features can subscribe without
 * touching core modules.
 *
 * Usage:
 *   import { bus } from './event-bus.js';
 *   bus.on('service:health', (data) => { ... });
 *   bus.emit('service:health', { agent: true, semantic: false });
 */

/** @type {Map<string, Set<Function>>} */
const _subs = new Map();

export const bus = {
  /**
   * Subscribe to an event. Returns an unsubscribe function.
   * @param {string} event
   * @param {Function} fn
   * @returns {() => void}
   */
  on(event, fn) {
    if (!_subs.has(event)) _subs.set(event, new Set());
    _subs.get(event).add(fn);
    return () => _subs.get(event)?.delete(fn);
  },

  /**
   * Emit an event with data to all subscribers.
   * @param {string} event
   * @param {*} data
   */
  emit(event, data) {
    const fns = _subs.get(event);
    if (fns) for (const fn of fns) fn(data);
  },
};
