/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Base URL for the agent API. Defaults to http://localhost:8001 */
  readonly PUBLIC_AGENT_URL: string;
  /** Base URL for the semantic similarity service. Defaults to http://localhost:3001 */
  readonly PUBLIC_SEMANTIC_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
