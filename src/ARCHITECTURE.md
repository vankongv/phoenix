# Frontend Architecture

## The `lib/` vs `scripts/` split

Standard Astro projects co-locate client-side JS inside `.astro` components via `<script>` tags. Phoenix uses a different layout because the app is a **single-page, DOM-heavy dashboard** — closer to a vanilla SPA than a content site.

```
src/
├── lib/        ← pure logic, no DOM
└── scripts/    ← DOM wiring and module init
```

### `src/lib/` — pure modules

These files contain business logic only. They do **not** access `document`, `window`, or `localStorage` (with one intentional exception: `semantic.js` reads a localStorage override for power users pointing at a remote instance).

| File               | Responsibility                                                      |
| ------------------ | ------------------------------------------------------------------- |
| `config.js`        | Service base URLs — single source of truth, reads `import.meta.env` |
| `github-api.js`    | GitHub REST API calls, token management, retry logic                |
| `board.js`         | Column state, card scoring, drag-and-drop persistence               |
| `implementer.js`   | Agent run lifecycle — SSE streaming, run/log stores                 |
| `agents.js`        | Agent and team config — read/write to localStorage                  |
| `semantic.js`      | Embedding similarity API calls                                      |
| `column-mapper.js` | Maps GitHub label/milestone combos to board columns                 |
| `formatters.js`    | Pure string utilities: `escHtml`, `timeAgo`, `detectPriority`       |
| `constants.js`     | Shared enums and lookup tables                                      |

Because `lib/` modules are pure functions with no DOM side-effects, they are straightforward to unit test with pytest or a JS test runner.

### `src/scripts/` — DOM controllers

These files wire DOM events to `lib/` functions and manage imperative UI state. Each file corresponds roughly to one panel or feature area.

| File                   | Owns                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `main.js`              | App bootstrap — imports and inits every other script module   |
| `state.js`             | Singleton shared state object (current repo, issues, columns) |
| `board-loader.js`      | Repo input, filter controls, issue loading                    |
| `drawer.js`            | Issue detail drawer — editing, implement/refine triggers      |
| `agent-rail.js`        | Right-side run status rail                                    |
| `agents-panel.js`      | Agent configuration wizard                                    |
| `teams-panel.js`       | Team configuration                                            |
| `planning.js`          | Tiptap rich-text notes panel with AI chat                     |
| `run-history-panel.js` | Historical run log viewer                                     |
| `token-repo.js`        | GitHub token prompt and localStorage persistence              |

### Entry point

`src/pages/index.astro` contains a single `<script>` tag:

```js
import '../scripts/main.js';
```

Astro bundles the entire import graph from that entry. All tree-shaking and code splitting is handled by Vite — you don't need to manage script loading order manually.

### `state.js` — shared singleton

`state.js` exports a single mutable object that all script modules share. It holds:

- `repoFullName` — currently loaded repo
- `allIssues` — raw issue array from GitHub
- `columns` — bucketed issues per Kanban column
- `duplicates` — semantic similarity map for Triage badges
- Callback hooks (`onOpenDrawer`, `onImplement`) set by `main.js`

This is effectively a lightweight global store. If the app grows significantly, replacing it with a proper reactive store (e.g. nanostores) would be the natural next step.

### Service URLs

All backend URLs originate from `src/lib/config.js`:

```js
export const AGENT_BASE_URL = import.meta.env.PUBLIC_AGENT_URL ?? 'http://localhost:8001';
export const SEMANTIC_BASE_URL = import.meta.env.PUBLIC_SEMANTIC_URL ?? 'http://localhost:3001';
```

Set `PUBLIC_AGENT_URL` and `PUBLIC_SEMANTIC_URL` in the root `.env` file to point at non-local deployments. Never hardcode service URLs in component or script files.
