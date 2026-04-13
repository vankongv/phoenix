/**
 * Service base URLs.
 *
 * Override at build time via Astro public env vars (set in .env at the repo root):
 *   PUBLIC_AGENT_URL=https://agent.example.com
 *   PUBLIC_SEMANTIC_URL=https://semantic.example.com
 *
 * Falls back to localhost for local development.
 */
export const AGENT_BASE_URL = import.meta.env.PUBLIC_AGENT_URL ?? 'http://localhost:8001';

export const SEMANTIC_BASE_URL = import.meta.env.PUBLIC_SEMANTIC_URL ?? 'http://localhost:3001';
