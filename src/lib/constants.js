export const COLUMNS = [
  { id: 'triage', label: 'Triage', icon: 'inbox', color: '#737685' },
  { id: 'todo', label: 'To Do', icon: 'list_alt', color: '#4c5e83' },
  { id: 'in_progress', label: 'In Progress', icon: 'pending', color: '#003d9b' },
  { id: 'in_review', label: 'In Review', icon: 'rate_review', color: '#7b2600' },
  { id: 'done', label: 'Done', icon: 'check_circle', color: '#1a7a4a' },
];

export const LABEL_MAP = [
  { keywords: ['in progress', 'wip', 'doing', 'in-progress'], col: 'in_progress' },
  { keywords: ['in review', 'review', 'pr open', 'in-review'], col: 'in_review' },
  { keywords: ['todo', 'to do', 'to-do', 'ready', 'backlog'], col: 'todo' },
  { keywords: ['done', 'completed', 'released', 'closed', 'merged'], col: 'done' },
];

// Canonical GitHub label (name + color) written back when a card is moved.
// `triage` has no status label — any existing status labels are stripped.
export const COLUMN_STATUS_LABELS = {
  triage:      null,
  todo:        { name: 'to do',       color: '4c5e83' },
  in_progress: { name: 'in progress', color: '003d9b' },
  in_review:   { name: 'in review',   color: '7b2600' },
  done:        { name: 'done',        color: '1a7a4a' },
};

export const PROVIDERS = {
  claude: {
    name: 'Claude (Anthropic)',
    emoji: '🟠',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
  copilot: { name: 'GitHub Copilot', emoji: '⬛', models: ['gpt-4o', 'gpt-4o-mini', 'o3'] },
  openai: { name: 'OpenAI', emoji: '🟢', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'] },
};

export const PROVIDER_ENDPOINTS = {
  claude: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  copilot: 'https://api.githubcopilot.com',
};

export const SAMPLING_PROFILES = {
  deterministic: { label: 'Deterministic', desc: 'Code & extraction', temp: 0.0 },
  balanced: { label: 'Balanced', desc: 'General reasoning', temp: 0.5 },
  creative: { label: 'Creative', desc: 'Brainstorm & refine', temp: 0.9 },
};

export const CODE_EDITORS = [
  { id: 'vscode', name: 'VS Code', cmd: 'code', icon: 'editor_choice' },
  { id: 'vscode-insiders', name: 'VS Code Insiders', cmd: 'code-insiders', icon: 'editor_choice' },
  { id: 'cursor', name: 'Cursor', cmd: 'cursor', icon: 'arrow_outward' },
  { id: 'windsurf', name: 'Windsurf', cmd: 'windsurf', icon: 'wind_power' },
  { id: 'zed', name: 'Zed', cmd: 'zed', icon: 'bolt' },
];

// ── Token pricing (USD per 1 million tokens, input / output) ──
export const MODEL_COSTS = {
  'claude-opus-4-6':   { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':  { input: 0.80,  output: 4.00  },
  'gpt-4o':            { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':       { input: 0.15,  output: 0.60  },
  'o3-mini':           { input: 1.10,  output: 4.40  },
  'o3':                { input: 10.00, output: 40.00 },
};

/** Returns estimated USD cost for a run given token counts and model id. */
export function calcRunCost(inputTokens, outputTokens, model) {
  const p = MODEL_COSTS[model];
  if (!p || (!inputTokens && !outputTokens)) return 0;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export const DEFAULT_AGENT_MAX_ITERATIONS = 50;

export const LANE_ACTIONS = {
  triage: {
    label: 'Improve Issue',
    icon: 'edit_note',
    type: 'refine',
    gradient: 'linear-gradient(135deg,#6d28d9,#7c3aed)',
  },
  todo: {
    label: 'Implement with AI',
    icon: 'auto_fix_high',
    type: 'implement',
    gradient: 'linear-gradient(135deg,#003d9b,#0052cc)',
  },
  in_progress: {
    label: 'Continue',
    icon: 'play_arrow',
    type: 'implement',
    gradient: 'linear-gradient(135deg,#003d9b,#0052cc)',
  },
  in_review: null,
  done: null,
};
