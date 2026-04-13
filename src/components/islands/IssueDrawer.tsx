import { useState, useRef, useEffect } from 'preact/hooks';
import { drawerSignal, closeDrawer, setDrawerTab, runsSignal, logsSignal, suggestionsSignal, dismissSuggestion } from '../../lib/signals.js';
import { triggerImplement, triggerAddressPRComments, cancelRun, pushRun } from '../../scripts/run-dispatcher.js';
import { updateIssue, fetchIssueComments, createIssueComment, fetchOrgMembers, fetchRepoLabels, createRepoLabel, fetchPRReviewThreads } from '../../lib/github-api.js';
import { getAgents, getTeams, getCodeEditor, getIssueTeam, setIssueTeam } from '../../lib/agents.js';
import { AGENT_BASE_URL } from '../../lib/config.js';
import { state } from '../../scripts/state.js';
import { renderBoard } from '../../lib/board.js';
import { getFilters } from '../../scripts/board-loader.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Issue {
  number: number;
  title: string;
  body?: string;
  html_url: string;
  state: string;
  labels?: Array<{ name: string; color: string }>;
  assignees?: Array<{ login: string; avatar_url: string }>;
  milestone?: { title: string } | null;
  comments: number;
  created_at: string;
  updated_at: string;
}

interface Run {
  status: string;
  step?: string;
  prUrl?: string | null;
  worktreePath?: string | null;
  actionType?: string;
}

interface PRReviewComment {
  body: string;
  path: string | null;
  author: { login: string } | null;
}

interface PRReviewThread {
  isResolved: boolean;
  comments: PRReviewComment[];
}

interface LogEntry {
  type: string;
  message?: string;
  ts?: number;
  tool?: string;
  path?: string;
  from?: string;
  to?: string;
  actionType?: string;
  runIndex?: number;
}

interface RunGroup {
  runIndex: number;
  actionType: string;
  startTs: number;
  logs: LogEntry[];
}

function groupLogsByRun(logs: LogEntry[]): RunGroup[] {
  const groups: RunGroup[] = [];
  let current: RunGroup | null = null;
  for (const entry of logs) {
    if (entry.type === 'run_start') {
      if (current) groups.push(current);
      current = {
        runIndex: entry.runIndex ?? groups.length + 1,
        actionType: entry.actionType ?? 'implement',
        startTs: entry.ts ?? Date.now(),
        logs: [],
      };
    } else if (current) {
      current.logs.push(entry);
    } else {
      // Legacy logs stored before run grouping was added — treat as run 1
      current = { runIndex: 1, actionType: 'implement', startTs: entry.ts ?? 0, logs: [entry] };
    }
  }
  if (current) groups.push(current);
  return groups;
}

function getRunGroupStatus(group: RunGroup, isActive: boolean, activeStatus?: string): string {
  if (isActive && activeStatus) return activeStatus;
  const last = group.logs[group.logs.length - 1];
  if (!last) return 'cancelled';
  if (last.type === 'done') return 'done';
  if (last.type === 'error') return 'failed';
  return 'cancelled';
}

type Tab = 'details' | 'ai' | 'logs';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPullRequest(issue: Issue): boolean {
  return issue.html_url?.includes('/pull/') ?? false;
}

function fmtDate(d: Date) {
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function cleanLogMessage(raw: string): string {
  if (!raw.includes('TextContent(')) return raw;
  const m = raw.match(/\btext=['"](.+)/s);
  if (!m) return raw;
  return m[1]
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    // eslint-disable-next-line no-control-regex
    .replace(/(?:\\x1b|\x1b)\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/['"\])\s]+$/, '')
    .trim();
}

function formatReasoningMessage(msg: string) {
  const jsonMatch = msg.match(/^```json\s*([\s\S]*?)```\s*$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      return (
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:10px;font-family:monospace">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    } catch {
      /* fall through */
    }
  }
  return <>{msg}</>;
}

function getIssueColId(issue: Issue): string | null {
  for (const [colId, col] of Object.entries(state.columns as Record<string, { issues?: Issue[] }>)) {
    if (col.issues?.some((i) => i.number === issue.number)) return colId;
  }
  return null;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function LabelPill({ label }: { label: { name: string; color: string } }) {
  const c = '#' + (label.color || '737685');
  return (
    <span
      class="label-pill"
      style={`color:${c};background:${c}18;border:1px solid ${c}30`}
    >
      {label.name}
    </span>
  );
}

function FieldRow({ label, children, last }: { label: string; children: any; last?: boolean }) {
  return (
    <div
      class="flex items-center px-3 py-2.5"
      style={last ? undefined : 'border-bottom:1px solid #e1e2e4'}
    >
      <span class="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/60">
        {label}
      </span>
      {children}
    </div>
  );
}

function AIStatusRow({ run, issueNumber }: { run: Run | undefined; issueNumber: number }) {
  if (!run || run.status === 'idle') return null;

  const icons: Record<string, string> = {
    running: 'autorenew',
    done: 'check_circle',
    failed: 'error_outline',
    needs_review: 'upload',
  };
  const colors: Record<string, string> = {
    running: '#003d9b',
    done: '#1a7a4a',
    failed: '#ba1a1a',
    needs_review: '#7c3aed',
  };
  const icon = icons[run.status] ?? 'autorenew';
  const color = colors[run.status] ?? '#003d9b';
  const spin = run.status === 'running';

  async function handleOpenEditor(path: string) {
    const editor = getCodeEditor();
    await fetch(`${AGENT_BASE_URL}/open-editor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, cmd: editor.cmd }),
    });
  }

  async function handlePush(issueNumber: number) {
    await pushRun(issueNumber);
  }

  return (
    <div class="flex items-center gap-2 rounded-lg px-3 py-2" style="background:#ffffff">
      <span
        class={`material-symbols-outlined${spin ? ' animate-spin' : ''}`}
        style={`font-size:14px;color:${color}`}
      >
        {icon}
      </span>
      <span class="text-[11px] text-on-surface flex-1 truncate">{run.step}</span>
      {run.worktreePath && (
        <button
          onClick={() => handleOpenEditor(run.worktreePath!)}
          class="flex items-center gap-0.5 text-[10px] font-semibold px-2 py-0.5 rounded"
          style={`color:${color};border:1px solid ${color}40`}
          title="Open worktree in editor"
        >
          <span class="material-symbols-outlined" style="font-size:12px">code</span>Open
        </button>
      )}
      {run.status === 'needs_review' && (
        <button
          onClick={() => handlePush(issueNumber)}
          class="flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1 rounded-lg transition-all active:scale-95"
          style="background:#7c3aed;color:#fff"
        >
          <span class="material-symbols-outlined" style="font-size:12px">upload</span>Push & PR
        </button>
      )}
      {run.prUrl && (
        <a
          href={run.prUrl}
          target="_blank"
          class="text-[10px] font-bold text-primary underline"
          onClick={(e) => e.stopPropagation()}
        >
          View PR
        </a>
      )}
    </div>
  );
}

// ── Comments Section ──────────────────────────────────────────────────────────

interface GHComment {
  id: number;
  user: { login: string; avatar_url: string };
  body: string;
  created_at: string;
}

function CommentsSection({ issue }: { issue: Issue }) {
  const [comments, setComments] = useState<GHComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const repo = (state.issueSourceRepo || state.repoFullName) as string | null;

  useEffect(() => {
    if (!repo) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    fetchIssueComments(repo, issue.number)
      .then((data: GHComment[]) => setComments(data))
      .catch((e: Error) => setError(e.message ?? 'Failed to load comments'))
      .finally(() => setLoading(false));
  }, [repo, issue.number]);

  async function handleSubmit() {
    if (!body.trim() || !repo) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created: GHComment = await createIssueComment(repo, issue.number, body.trim());
      setComments((prev) => [...prev, created]);
      issue.comments = (issue.comments ?? 0) + 1;
      setBody('');
    } catch (e: any) {
      setSubmitError(e.message ?? 'Failed to post comment');
    } finally {
      setSubmitting(false);
    }
  }

  if (!repo) return null;

  return (
    <div class="space-y-3">
      {/* Header */}
      <div class="flex items-center gap-2">
        <p class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60">
          Comments
        </p>
        {!loading && comments.length > 0 && (
          <span
            class="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
            style="background:#e8ecf5;color:#003d9b"
          >
            {comments.length}
          </span>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div class="flex items-center gap-2 py-2 text-[11px] text-on-surface-variant/50">
          <span class="material-symbols-outlined animate-spin" style="font-size:14px;color:#737685">autorenew</span>
          Loading…
        </div>
      )}

      {/* Error */}
      {error && (
        <div class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[11px]" style="background:#fff0f0;color:#ba1a1a;border:1px solid #fca5a5">
          <span class="material-symbols-outlined shrink-0" style="font-size:13px">error_outline</span>
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && comments.length === 0 && (
        <div class="flex flex-col items-center py-5 gap-1.5">
          <span class="material-symbols-outlined" style="font-size:28px;color:#c3c6d6">chat_bubble_outline</span>
          <p class="text-[11px] italic" style="color:#c3c6d6">No comments yet</p>
        </div>
      )}

      {/* Comment list */}
      {!loading && !error && comments.length > 0 && (
        <div class="flex flex-col gap-2">
          {comments.map((c) => (
            <div
              key={c.id}
              class="rounded-xl"
              style="border:1px solid #e7e8ea;background:#f8f9fb"
            >
              {/* Comment header */}
              <div
                class="flex items-center gap-2 px-3 py-2"
                style="border-bottom:1px solid #e7e8ea;background:#f4f5fb;border-radius:11px 11px 0 0"
              >
                <img src={c.user.avatar_url} alt={c.user.login} class="w-5 h-5 rounded-full shrink-0" />
                <span class="text-[11px] font-semibold text-on-surface flex-1 truncate">{c.user.login}</span>
                <span class="text-[10px] shrink-0" style="color:#737685">{fmtDate(new Date(c.created_at))}</span>
              </div>
              {/* Comment body */}
              <p class="text-[11px] text-on-surface leading-relaxed whitespace-pre-wrap px-3 py-2.5">{c.body}</p>
            </div>
          ))}
        </div>
      )}

      {/* Compose box */}
      <div class="rounded-xl overflow-hidden" style="border:1px solid #e1e2e4">
        <textarea
          class="w-full text-xs text-on-surface leading-relaxed px-3 pt-3 pb-2 resize-none outline-none block"
          style="min-height:76px;background:#ffffff"
          placeholder="Leave a comment…"
          value={body}
          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); handleSubmit(); }
          }}
        />
        <div
          class="flex items-center justify-between px-3 py-2 gap-2"
          style="background:#f4f5fb;border-top:1px solid #e1e2e4"
        >
          {submitError ? (
            <span class="text-[10px] flex items-center gap-1" style="color:#ba1a1a">
              <span class="material-symbols-outlined" style="font-size:11px">error_outline</span>
              {submitError}
            </span>
          ) : (
            <span class="text-[10px]" style="color:#c3c6d6">Ctrl+Enter to post</span>
          )}
          <button
            disabled={submitting || !body.trim()}
            onClick={handleSubmit}
            class="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-all active:scale-95 shrink-0"
            style={`${submitting || !body.trim() ? 'background:#e8ecf5;color:#737685' : 'background:linear-gradient(135deg,#003d9b,#0052cc);color:#fff'}`}
          >
            {submitting ? (
              <>
                <span class="material-symbols-outlined animate-spin" style="font-size:12px">autorenew</span>
                Posting…
              </>
            ) : (
              <>
                <span class="material-symbols-outlined" style="font-size:12px">send</span>
                Comment
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Assignee Editor ───────────────────────────────────────────────────────────

type Assignee = { login: string; avatar_url: string };
type Label = { name: string; color: string };

function AssigneeEditor({
  issue,
  assignees,
  onUpdate,
}: {
  issue: Issue;
  assignees: Assignee[];
  onUpdate: (next: Assignee[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [collabs, setCollabs] = useState<Assignee[]>([]);
  const [loadingCollabs, setLoadingCollabs] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const isLocal = !!(issue as any)._local;
  const repo = (state.issueSourceRepo || state.repoFullName) as string | null;

  useEffect(() => {
    if (!open || collabs.length > 0 || !repo) return;
    setLoadingCollabs(true);
    const org = repo.split("/")[0];
    fetchOrgMembers(org, repo)
      .then((data: Assignee[]) => setCollabs(data))
      .catch(() => {})
      .finally(() => setLoadingCollabs(false));
  }, [open, repo]);

  // Auto-focus search when dropdown opens
  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  async function toggle(collab: Assignee) {
    if (!repo || saving || isLocal) return;
    setSaving(true);
    const isAssigned = assignees.some((a) => a.login === collab.login);
    const nextLogins = isAssigned
      ? assignees.filter((a) => a.login !== collab.login).map((a) => a.login)
      : [...assignees.map((a) => a.login), collab.login];
    try {
      const updated = await updateIssue(repo, issue.number, { assignees: nextLogins });
      issue.assignees = updated.assignees ?? [];
      onUpdate(updated.assignees ?? []);
    } catch {}
    setSaving(false);
  }

  const filtered = query.trim()
    ? collabs.filter((c) => c.login.toLowerCase().includes(query.toLowerCase()))
    : collabs;

  return (
    <div class="relative flex-1 min-w-0" ref={ref}>
      <button
        onClick={() => !isLocal && repo && setOpen(!open)}
        class="flex items-center gap-1.5 flex-wrap w-full text-left group/btn"
        disabled={isLocal || !repo}
      >
        {assignees.length > 0 ? (
          <div class="flex flex-wrap items-center gap-1.5">
            {assignees.map((a) => (
              <div key={a.login} class="flex items-center gap-1">
                <img src={a.avatar_url} class="w-4 h-4 rounded-full shrink-0" />
                <span class="text-on-surface text-xs">{a.login}</span>
              </div>
            ))}
            {!isLocal && repo && (
              <span
                class="material-symbols-outlined opacity-0 group-hover/btn:opacity-50 transition-opacity"
                style="font-size:13px;color:#737685"
              >
                edit
              </span>
            )}
          </div>
        ) : (
          <span class="flex items-center gap-1">
            <span class="text-on-surface-variant/40 italic">Unassigned</span>
            {!isLocal && repo && (
              <span
                class="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
                style="background:#e8ecf5;color:#003d9b"
              >
                <span class="material-symbols-outlined" style="font-size:11px">add</span>
                Add
              </span>
            )}
          </span>
        )}
      </button>

      {open && (
        <div
          class="absolute left-0 z-50 bg-white rounded-xl shadow-xl min-w-56"
          style="top:calc(100% + 6px);border:1px solid #e1e2e4;width:220px"
        >
          {/* Search input */}
          <div class="px-2 pt-2 pb-1.5" style="border-bottom:1px solid #e1e2e4">
            <div
              class="flex items-center gap-1.5 px-2 py-1.5 rounded-lg"
              style="background:#f4f5fb;border:1px solid #e1e2e4"
            >
              <span class="material-symbols-outlined shrink-0" style="font-size:13px;color:#737685">search</span>
              <input
                ref={searchRef}
                type="text"
                class="flex-1 text-[11px] text-on-surface bg-transparent outline-none min-w-0"
                placeholder="Search org members…"
                value={query}
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
              />
              {query && (
                <button onClick={() => setQuery('')} class="shrink-0">
                  <span class="material-symbols-outlined" style="font-size:12px;color:#737685">close</span>
                </button>
              )}
            </div>
          </div>

          {/* Results */}
          <div class="py-1 max-h-52 overflow-y-auto" style="scrollbar-width:thin;scrollbar-color:#c3c6d6 transparent">
            {loadingCollabs ? (
              <div class="flex items-center gap-1.5 px-3 py-2.5 text-[11px] text-on-surface-variant/60">
                <span class="material-symbols-outlined animate-spin" style="font-size:12px">autorenew</span>
                Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div class="px-3 py-2.5 text-[11px] text-on-surface-variant/40 italic">
                {query ? `No match for "${query}"` : 'No collaborators found'}
              </div>
            ) : (
              filtered.map((c) => {
                const checked = assignees.some((a) => a.login === c.login);
                return (
                  <button
                    key={c.login}
                    disabled={saving}
                    onClick={() => toggle(c)}
                    class="w-full flex items-center gap-2 px-3 py-2 transition-colors text-left"
                    style={checked ? 'background:#f0f4ff' : undefined}
                    onMouseEnter={(e) => { if (!checked) (e.currentTarget as HTMLElement).style.background = '#f4f5fb'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = checked ? '#f0f4ff' : ''; }}
                  >
                    <img src={c.avatar_url} class="w-6 h-6 rounded-full shrink-0" />
                    <span class="text-[11px] text-on-surface flex-1 truncate">{c.login}</span>
                    {checked && (
                      <span class="material-symbols-outlined shrink-0" style="font-size:14px;color:#003d9b">check</span>
                    )}
                    {saving && checked && (
                      <span class="material-symbols-outlined animate-spin shrink-0" style="font-size:11px;color:#737685">autorenew</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Labels Editor ─────────────────────────────────────────────────────────────

const LABEL_COLORS = [
  'ef4444','f97316','eab308','22c55e','06b6d4','3b82f6','8b5cf6','ec4899',
  'dc2626','d97706','65a30d','059669','0891b2','4f46e5','7c3aed','db2777',
  '737685','374151',
];

function LabelsEditor({
  issue,
  labels,
  onUpdate,
}: {
  issue: Issue;
  labels: Label[];
  onUpdate: (next: Label[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [repoLabels, setRepoLabels] = useState<Label[]>([]);
  const [loadingLabels, setLoadingLabels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newColor, setNewColor] = useState(LABEL_COLORS[5]);
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const isLocal = !!(issue as any)._local;
  const repo = (state.issueSourceRepo || state.repoFullName) as string | null;

  useEffect(() => {
    if (!open || repoLabels.length > 0 || !repo) return;
    setLoadingLabels(true);
    fetchRepoLabels(repo)
      .then((data: Label[]) => setRepoLabels(data))
      .catch(() => {})
      .finally(() => setLoadingLabels(false));
  }, [open, repo]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCreating(false);
      setCreateError(null);
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  async function toggle(label: Label) {
    if (!repo || saving || isLocal) return;
    setSaving(true);
    const isActive = labels.some((l) => l.name === label.name);
    const nextNames = isActive
      ? labels.filter((l) => l.name !== label.name).map((l) => l.name)
      : [...labels.map((l) => l.name), label.name];
    try {
      const updated = await updateIssue(repo, issue.number, { labels: nextNames });
      issue.labels = updated.labels ?? [];
      onUpdate(updated.labels ?? []);
    } catch {}
    setSaving(false);
  }

  async function handleCreate() {
    const name = query.trim();
    if (!name || !repo) return;
    setCreatingLabel(true);
    setCreateError(null);
    try {
      const created: Label = await createRepoLabel(repo, { name, color: newColor });
      setRepoLabels((prev) => [...prev, created]);
      // immediately assign it
      const nextNames = [...labels.map((l) => l.name), created.name];
      const updated = await updateIssue(repo, issue.number, { labels: nextNames });
      issue.labels = updated.labels ?? [];
      onUpdate(updated.labels ?? []);
      setQuery('');
      setCreating(false);
    } catch (e: any) {
      setCreateError(e.userMessage ?? e.message ?? 'Failed to create label');
    } finally {
      setCreatingLabel(false);
    }
  }

  const filtered = query.trim()
    ? repoLabels.filter((l) => l.name.toLowerCase().includes(query.toLowerCase()))
    : repoLabels;

  const exactMatch = repoLabels.some((l) => l.name.toLowerCase() === query.trim().toLowerCase());
  const showCreate = query.trim() && !exactMatch;

  return (
    <div class="relative flex-1 min-w-0" ref={ref}>
      <button
        onClick={() => !isLocal && repo && setOpen(!open)}
        class="flex items-center gap-1 flex-wrap w-full text-left group/btn"
        disabled={isLocal || !repo}
      >
        {labels.length > 0 ? (
          <div class="flex flex-wrap items-center gap-1">
            {labels.map((l) => {
              const c = '#' + (l.color || '737685');
              return (
                <span
                  key={l.name}
                  class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium"
                  style={`color:${c};background:${c}18`}
                >
                  {l.name}
                </span>
              );
            })}
            {!isLocal && repo && (
              <span
                class="material-symbols-outlined opacity-0 group-hover/btn:opacity-50 transition-opacity"
                style="font-size:13px;color:#737685"
              >
                edit
              </span>
            )}
          </div>
        ) : (
          <span class="text-on-surface-variant/50 italic flex items-center gap-1">
            None
            {!isLocal && repo && (
              <span class="material-symbols-outlined" style="font-size:13px;color:#737685">add</span>
            )}
          </span>
        )}
      </button>

      {open && (
        <div
          class="absolute left-0 z-50 bg-white rounded-xl shadow-xl min-w-56"
          style="top:calc(100% + 6px);border:1px solid #e1e2e4;width:232px"
        >
          {/* Search */}
          <div class="px-2 pt-2 pb-1.5" style="border-bottom:1px solid #e1e2e4">
            <div
              class="flex items-center gap-1.5 px-2 py-1.5 rounded-lg"
              style="background:#f4f5fb;border:1px solid #e1e2e4"
            >
              <span class="material-symbols-outlined shrink-0" style="font-size:13px;color:#737685">label</span>
              <input
                ref={searchRef}
                type="text"
                class="flex-1 text-[11px] text-on-surface bg-transparent outline-none min-w-0"
                placeholder="Search or create labels…"
                value={query}
                onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setCreating(false); setCreateError(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setOpen(false);
                  if (e.key === 'Enter' && showCreate) handleCreate();
                }}
              />
              {query && (
                <button onClick={() => { setQuery(''); setCreating(false); }} class="shrink-0">
                  <span class="material-symbols-outlined" style="font-size:12px;color:#737685">close</span>
                </button>
              )}
            </div>
          </div>

          {/* Label list */}
          <div class="py-1 max-h-48 overflow-y-auto" style="scrollbar-width:thin;scrollbar-color:#c3c6d6 transparent">
            {loadingLabels ? (
              <div class="flex items-center gap-1.5 px-3 py-2.5 text-[11px] text-on-surface-variant/60">
                <span class="material-symbols-outlined animate-spin" style="font-size:12px">autorenew</span>
                Loading…
              </div>
            ) : filtered.length === 0 && !showCreate ? (
              <div class="px-3 py-2.5 text-[11px] text-on-surface-variant/40 italic">No labels found</div>
            ) : (
              filtered.map((l) => {
                const checked = labels.some((lbl) => lbl.name === l.name);
                const c = '#' + (l.color || '737685');
                return (
                  <button
                    key={l.name}
                    disabled={saving}
                    onClick={() => toggle(l)}
                    class="w-full flex items-center gap-2 px-3 py-2 transition-colors text-left"
                    style={checked ? 'background:#f0f4ff' : undefined}
                    onMouseEnter={(e) => { if (!checked) (e.currentTarget as HTMLElement).style.background = '#f4f5fb'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = checked ? '#f0f4ff' : ''; }}
                  >
                    <span class="w-3 h-3 rounded-full shrink-0" style={`background:${c}`} />
                    <span class="text-[11px] text-on-surface flex-1 truncate">{l.name}</span>
                    {checked && (
                      <span class="material-symbols-outlined shrink-0" style="font-size:14px;color:#003d9b">check</span>
                    )}
                    {saving && checked && (
                      <span class="material-symbols-outlined animate-spin shrink-0" style="font-size:11px;color:#737685">autorenew</span>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Create label */}
          {showCreate && (
            <div style="border-top:1px solid #e1e2e4">
              {!creating ? (
                <button
                  onClick={() => setCreating(true)}
                  class="w-full flex items-center gap-2 px-3 py-2.5 transition-colors text-left hover:bg-[#f4f5fb]"
                >
                  <span class="material-symbols-outlined shrink-0" style="font-size:14px;color:#003d9b">add_circle</span>
                  <span class="text-[11px] text-on-surface">
                    Create label <strong>"{query.trim()}"</strong>
                  </span>
                </button>
              ) : (
                <div class="px-3 py-2.5 space-y-2.5">
                  <p class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60">
                    Pick a colour
                  </p>
                  <div class="flex flex-wrap gap-1.5">
                    {LABEL_COLORS.map((hex) => (
                      <button
                        key={hex}
                        onClick={() => setNewColor(hex)}
                        class="w-5 h-5 rounded-full transition-transform active:scale-90"
                        style={`background:#${hex};outline:${newColor === hex ? `2px solid #${hex}` : 'none'};outline-offset:2px`}
                        title={`#${hex}`}
                      />
                    ))}
                  </div>
                  {createError && (
                    <p class="text-[10px]" style="color:#ba1a1a">{createError}</p>
                  )}
                  <div class="flex items-center gap-2">
                    {/* Preview */}
                    <span
                      class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium flex-1 truncate"
                      style={`color:#${newColor};background:#${newColor}22`}
                    >
                      {query.trim()}
                    </span>
                    <button
                      disabled={creatingLabel}
                      onClick={handleCreate}
                      class="flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1.5 rounded-lg transition-all active:scale-95 shrink-0"
                      style={`${creatingLabel ? 'background:#e8ecf5;color:#737685' : 'background:linear-gradient(135deg,#003d9b,#0052cc);color:#fff'}`}
                    >
                      {creatingLabel ? (
                        <span class="material-symbols-outlined animate-spin" style="font-size:11px">autorenew</span>
                      ) : (
                        <span class="material-symbols-outlined" style="font-size:11px">add</span>
                      )}
                      {creatingLabel ? 'Creating…' : 'Create'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Details Tab ───────────────────────────────────────────────────────────────

function DetailsTab({ issue }: { issue: Issue }) {
  const isLocal = !!(issue as any)._local;
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleVal, setTitleVal] = useState(issue.title);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descVal, setDescVal] = useState(issue.body ?? '');
  const [applyStatus, setApplyStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const [applyLoading, setApplyLoading] = useState(false);
  const [copyLabel, setCopyLabel] = useState<'Copy Markdown' | 'Copied!'>('Copy Markdown');
  const [openEditorLoading, setOpenEditorLoading] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [localAssignees, setLocalAssignees] = useState<Assignee[]>(issue.assignees ?? []);
  const [localLabels, setLocalLabels] = useState<Label[]>(issue.labels ?? []);

  const labels = localLabels;
  const assignees = localAssignees;
  const dupList = state.duplicates.get(issue.number) ?? [];
  const teams = getTeams();
  const assignedTeamId = state.repoFullName ? getIssueTeam(state.repoFullName, issue.number) : null;
  const suggestion = (suggestionsSignal.value as Map<number, any>).get(issue.number);

  const stateColor =
    issue.state === 'open'
      ? { bg: '#dbeafe', fg: '#1d4ed8' }
      : { bg: '#d1fae5', fg: '#065f46' };
  const stateIcon = issue.state === 'open' ? 'radio_button_unchecked' : 'check_circle';
  const createdDate = new Date(issue.created_at);
  const updatedDate = new Date(issue.updated_at);

  function commitTitle(val: string) {
    const next = val.trim() || issue.title;
    issue.title = next;
    setTitleVal(next);
    setEditingTitle(false);
  }

  function commitDesc(val: string) {
    issue.body = val;
    setDescVal(val);
    setEditingDesc(false);
  }

  async function handleApply() {
    const applyRepo = (state.issueSourceRepo || state.repoFullName) as string | null;
    if (!suggestion || !applyRepo) return;
    setApplyLoading(true);
    setApplyStatus(null);
    const newBody = [
      suggestion.description,
      '',
      ...(suggestion.acceptance_criteria?.length
        ? ['### Acceptance Criteria', ...suggestion.acceptance_criteria.map((c: string) => `- [ ] ${c}`)]
        : []),
    ].join('\n');
    try {
      await updateIssue(applyRepo, issue.number, {
        title: suggestion.title,
        body: newBody,
        assignees: undefined,
        labels: undefined,
      });
      issue.title = suggestion.title;
      issue.body = newBody;
      renderBoard(getFilters);
      dismissSuggestion(issue.number);
    } catch (err: any) {
      setApplyStatus({ msg: err.userMessage || err.message, ok: false });
    } finally {
      setApplyLoading(false);
    }
  }

  async function handleCopyMarkdown() {
    if (!suggestion) return;
    const md = [
      `## ${suggestion.title}`,
      '',
      suggestion.description,
      '',
      '### Acceptance Criteria',
      ...(suggestion.acceptance_criteria ?? []).map((c: string) => `- [ ] ${c}`),
    ].join('\n');
    await navigator.clipboard.writeText(md);
    setCopyLabel('Copied!');
    setTimeout(() => setCopyLabel('Copy Markdown'), 1500);
  }

  async function handleOpenEditor() {
    const editor = getCodeEditor();
    const runs = runsSignal.value as Map<number, Run>;
    const run = runs.get(issue.number);
    setOpenEditorLoading(true);
    try {
      if (run?.worktreePath) {
        await fetch(`${AGENT_BASE_URL}/open-editor`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: run.worktreePath, cmd: editor.cmd }),
        });
      } else {
        await fetch(`${AGENT_BASE_URL}/worktree`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issue_number: issue.number,
            repo_full_name: state.repoFullName,
            editor_cmd: editor.cmd,
          }),
        });
      }
    } finally {
      setOpenEditorLoading(false);
    }
  }

  return (
    <div class="space-y-4">
      {/* Local issue — push to GitHub banner */}
      {isLocal && (
        <div class="rounded-xl p-4 space-y-3" style="background:#fef3c7;border:1px solid #fcd34d">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined" style="font-size:16px;color:#b45309">cloud_off</span>
            <p class="text-xs font-bold" style="color:#92400e">Board only — not on GitHub</p>
          </div>
          <p class="text-[11px] leading-relaxed" style="color:#92400e">
            This issue lives locally on your board. Push it to GitHub to enable AI features, tracking, and collaboration.
          </p>
          <button
            disabled={pushLoading}
            onClick={async () => {
              if (!state.repoFullName) return;
              setPushLoading(true);
              try {
                const { createIssue: ci } = await import('../../lib/github-api.js');
                const created = await ci(state.repoFullName, { title: issue.title, body: issue.body ?? '', labels: undefined });
                window.dispatchEvent(new CustomEvent('pnx:promote-local-issue', {
                  detail: { localId: (issue as any)._localId, localNum: issue.number, githubIssue: created },
                }));
              } catch (err: any) {
                alert(err.userMessage || err.message);
              } finally {
                setPushLoading(false);
              }
            }}
            class="flex items-center justify-center gap-1.5 w-full text-xs font-semibold py-2 rounded-lg transition-all active:scale-95"
            style="background:#d97706;color:#fff;opacity:var(--op,1)"
          >
            <span class="material-symbols-outlined" style="font-size:14px">cloud_upload</span>
            {pushLoading ? 'Pushing…' : 'Push to GitHub'}
          </button>
        </div>
      )}

      {/* Title */}
      <div
        class="group relative cursor-text rounded-lg px-2 py-1.5 -mx-2 transition-colors hover:bg-[#edeef0]"
        onClick={() => !editingTitle && setEditingTitle(true)}
      >
        <p class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/50 mb-1">
          #{issue.number}
        </p>
        {editingTitle ? (
          <input
            class="w-full font-semibold text-[15px] text-on-surface leading-snug bg-white rounded px-1 py-0.5 outline-none ring-2"
            style="ring-color:#003d9b;border:none"
            value={titleVal}
            autoFocus
            onInput={(e) => setTitleVal((e.target as HTMLInputElement).value)}
            onBlur={(e) => commitTitle((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitTitle((e.target as HTMLInputElement).value);
              }
              if (e.key === 'Escape') {
                setTitleVal(issue.title);
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <h2 class="font-semibold text-[15px] text-on-surface leading-snug pr-6">{titleVal}</h2>
        )}
        {!editingTitle && (
          <span
            class="material-symbols-outlined absolute top-2 right-2 opacity-0 group-hover:opacity-60 transition-opacity text-on-surface-variant"
            style="font-size:14px"
          >
            edit
          </span>
        )}
      </div>

      {/* Label pills */}
      {labels.length > 0 && (
        <div class="flex flex-wrap gap-1 px-0.5">
          {labels.map((l) => (
            <LabelPill key={l.name} label={l} />
          ))}
        </div>
      )}

      {/* Field list */}
      <div class="rounded-xl text-xs" style="border:1px solid #e1e2e4">
        <FieldRow label="Status">
          <span
            class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold"
            style={`background:${stateColor.bg};color:${stateColor.fg}`}
          >
            <span class="material-symbols-outlined" style="font-size:11px">{stateIcon}</span>
            {issue.state.charAt(0).toUpperCase() + issue.state.slice(1)}
          </span>
        </FieldRow>

        <FieldRow label="Assignee">
          <AssigneeEditor
            issue={issue}
            assignees={localAssignees}
            onUpdate={setLocalAssignees}
          />
        </FieldRow>

        <FieldRow label="Team">
          <select
            class="text-xs text-on-surface bg-transparent outline-none cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-surface-container"
            value={assignedTeamId ?? ''}
            onChange={(e) => {
              const val = (e.target as HTMLSelectElement).value || null;
              if (state.repoFullName) setIssueTeam(state.repoFullName, issue.number, val);
            }}
          >
            <option value="">— None —</option>
            {teams.map((t: any) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </FieldRow>

        <FieldRow label="Labels">
          <LabelsEditor
            issue={issue}
            labels={localLabels}
            onUpdate={setLocalLabels}
          />
        </FieldRow>

        <FieldRow label="Milestone">
          {issue.milestone ? (
            <span class="inline-flex items-center gap-1 text-on-surface">
              <span class="material-symbols-outlined" style="font-size:12px;color:#003d9b">flag</span>
              {issue.milestone.title}
            </span>
          ) : (
            <span class="text-on-surface-variant/50 italic">None</span>
          )}
        </FieldRow>

        <FieldRow label="Created">
          <span class="text-on-surface" title={createdDate.toISOString()}>
            {fmtDate(createdDate)}
          </span>
        </FieldRow>

        <FieldRow label="Updated" last>
          <span class="text-on-surface" title={updatedDate.toISOString()}>
            {fmtDate(updatedDate)}
          </span>
        </FieldRow>
      </div>

      {/* Description */}
      <div>
        <p class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60 mb-1.5">
          Description
        </p>
        <div
          class="group relative rounded-xl cursor-text transition-colors"
          style="border:1px solid #e1e2e4;min-height:72px"
          onClick={() => !editingDesc && setEditingDesc(true)}
        >
          {editingDesc ? (
            <>
              <textarea
                class="w-full text-xs text-on-surface leading-relaxed p-3 resize-none outline-none rounded-xl"
                style="min-height:140px;background:#f8f9ff;border:none;box-shadow:inset 0 0 0 2px #003d9b"
                placeholder="Add a description…"
                autoFocus
                onInput={(e) => setDescVal((e.target as HTMLTextAreaElement).value)}
                onBlur={(e) => commitDesc((e.target as HTMLTextAreaElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.ctrlKey) {
                    e.preventDefault();
                    commitDesc((e.target as HTMLTextAreaElement).value);
                  }
                  if (e.key === 'Escape') {
                    setDescVal(issue.body ?? '');
                    setEditingDesc(false);
                  }
                }}
              >
                {descVal}
              </textarea>
              <p class="text-[10px] text-on-surface-variant/50 px-3 pb-2">
                Ctrl+Enter to save · Esc to cancel
              </p>
            </>
          ) : (
            <>
              <div
                class="text-xs text-on-surface-variant leading-relaxed p-3 whitespace-pre-wrap max-h-56 overflow-y-auto"
                style="scrollbar-width:thin;scrollbar-color:#c3c6d6 transparent"
              >
                {descVal ? (
                  descVal.slice(0, 2000) + (descVal.length > 2000 ? '\n\n…' : '')
                ) : (
                  <span class="italic text-on-surface-variant/40">Click to add a description…</span>
                )}
              </div>
              <span
                class="material-symbols-outlined absolute top-2 right-2 opacity-0 group-hover:opacity-50 transition-opacity text-on-surface-variant"
                style="font-size:13px"
              >
                edit
              </span>
            </>
          )}
        </div>
      </div>

      {/* Comments */}
      {!(issue as any)._local && <CommentsSection issue={issue} />}

      {/* Duplicates */}
      {dupList.length > 0 && (
        <div>
          <div class="flex items-center gap-1.5 mb-2">
            <span class="material-symbols-outlined" style="font-size:14px;color:#b45309">warning</span>
            <p class="text-[10px] font-bold uppercase tracking-widest" style="color:#b45309">
              Possible Duplicates ({dupList.length})
            </p>
          </div>
          <div class="flex flex-col gap-1.5">
            {dupList.map((d: any) => {
              const pct = Math.round(d.similarity * 100);
              const barColor = pct >= 90 ? '#dc2626' : '#d97706';
              return (
                <div
                  key={d.number}
                  class="rounded-lg p-2.5"
                  style="background:#fef3c7;border:1px solid #fde68a"
                >
                  <div class="flex items-center justify-between mb-1.5">
                    <span class="font-mono text-[10px] font-bold" style="color:#92400e">
                      #{d.number}
                    </span>
                    <span
                      class="text-[10px] font-bold px-1.5 py-0.5 rounded"
                      style="background:#fde68a;color:#78350f"
                    >
                      {pct}% match
                    </span>
                  </div>
                  <p class="text-[11px] text-on-surface line-clamp-1 mb-1.5">{d.title}</p>
                  <div class="rounded-full h-1 w-full" style="background:#fde68a">
                    <div
                      class="rounded-full h-1"
                      style={`width:${pct}%;background:${barColor}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* AI Suggestion card */}
      {suggestion && (
        <div class="rounded-xl p-4 space-y-2" style="background:#fef3c7;border-left:3px solid #d97706">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined" style="font-size:16px;color:#b45309">auto_awesome</span>
            <p class="text-[10px] font-bold uppercase tracking-widest" style="color:#b45309">
              AI Suggestion
            </p>
            <button
              onClick={() => dismissSuggestion(issue.number)}
              class="ml-auto flex items-center justify-center rounded-full hover:bg-amber-200 transition-colors"
              style="color:#b45309;padding:2px"
              title="Dismiss suggestion"
              aria-label="Dismiss AI suggestion"
            >
              <span class="material-symbols-outlined" style="font-size:14px">close</span>
            </button>
          </div>
          <p class="text-xs font-semibold text-on-surface">{suggestion.title}</p>
          <p class="text-[11px] text-on-surface-variant leading-relaxed">{suggestion.description}</p>
          {suggestion.acceptance_criteria?.length > 0 && (
            <ul class="text-[11px] space-y-0.5 text-on-surface-variant">
              {suggestion.acceptance_criteria.map((c: string, i: number) => (
                <li key={i} class="flex items-start gap-1">
                  <span style="color:#b45309">✓</span> {c}
                </li>
              ))}
            </ul>
          )}
          <div class="flex items-center gap-2 pt-1">
            <button
              disabled={applyLoading}
              onClick={handleApply}
              class="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-md transition-colors active:scale-95"
              style={`background:${applyLoading ? '#9ca3af' : '#d97706'};color:#fff`}
            >
              <span class="material-symbols-outlined" style="font-size:11px">cloud_upload</span>
              {applyLoading ? 'Applying…' : applyStatus?.ok ? 'Applied' : 'Apply to GitHub'}
            </button>
            <button
              onClick={handleCopyMarkdown}
              class="text-[10px] font-semibold text-primary hover:underline flex items-center gap-1"
            >
              <span class="material-symbols-outlined" style="font-size:11px">content_copy</span>
              {copyLabel}
            </button>
          </div>
          {applyStatus && (
            <p class="text-[10px]" style={`color:${applyStatus.ok ? '#16a34a' : '#ba1a1a'}`}>
              {applyStatus.msg}
            </p>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div class="flex gap-2">
        <button
          disabled={openEditorLoading}
          onClick={handleOpenEditor}
          class="flex items-center justify-center gap-1.5 flex-1 text-xs font-semibold py-2.5 rounded-lg transition-all active:scale-95"
          style="background:#e8ecf5;color:#434654;border:1px solid rgba(195,198,214,0.5)"
        >
          <span class="material-symbols-outlined" style="font-size:14px">
            {openEditorLoading ? 'autorenew' : 'code'}
          </span>
          {openEditorLoading ? 'Opening…' : 'Open in Editor'}
        </button>
        {!isLocal && (
          <a
            href={issue.html_url}
            target="_blank"
            class="flex items-center justify-center gap-1.5 flex-1 text-on-primary text-xs font-semibold py-2.5 rounded-lg transition-all active:scale-95"
            style="background:linear-gradient(135deg,#003d9b,#0052cc)"
          >
            <span class="material-symbols-outlined" style="font-size:14px">open_in_new</span>
            View on GitHub
          </a>
        )}
      </div>
    </div>
  );
}

// ── AI Tab ────────────────────────────────────────────────────────────────────

function AITab({ issue }: { issue: Issue }) {
  const runs = runsSignal.value as Map<number, Run>;
  const run = runs.get(issue.number);
  const status = run?.status ?? 'idle';

  const issueColId = getIssueColId(issue);
  const isTriageCol = issueColId === 'triage';

  const assignedTeamId = state.repoFullName ? getIssueTeam(state.repoFullName, issue.number) : null;
  const teams = getTeams();
  const assignedTeam = assignedTeamId ? teams.find((t: any) => t.id === assignedTeamId) : null;
  const implementAgents = getAgents().filter((a: any) => a.actionType === 'implement');

  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    implementAgents[0]?.id ?? ''
  );

  const [refinePrompt, setRefinePrompt] = useState('');
  const [pushLoading, setPushLoading] = useState(false);

  // PR review threads — loaded when the drawer opens for a pull request
  const [reviewThreads, setReviewThreads] = useState<PRReviewThread[] | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [addressingPR, setAddressingPR] = useState(false);

  const repo = (state.issueSourceRepo || state.repoFullName) as string | null;
  const isPR = isPullRequest(issue);

  useEffect(() => {
    if (!isPR || !repo || (issue as any)._local) return;
    setThreadsLoading(true);
    fetchPRReviewThreads(repo, issue.number)
      .then((threads: PRReviewThread[]) => setReviewThreads(threads))
      .finally(() => setThreadsLoading(false));
  }, [isPR, repo, issue.number]);

  const unresolvedThreads = (reviewThreads ?? []).filter((t) => !t.isResolved);

  async function handlePush() {
    setPushLoading(true);
    await pushRun(issue.number);
    setPushLoading(false);
  }

  function handleAddressPRComments() {
    if (!reviewThreads) return;
    setAddressingPR(true);
    triggerAddressPRComments(issue, reviewThreads);
    setDrawerTab('logs');
    setAddressingPR(false);
  }

  const isIdleOrFailed = status === 'idle' || status === 'failed';

  if ((issue as any)._local) {
    return (
      <div class="rounded-xl p-5 space-y-3 text-center" style="background:#fef3c7;border:1px solid #fcd34d;margin-top:8px">
        <span class="material-symbols-outlined" style="font-size:32px;color:#b45309;display:block">cloud_off</span>
        <p class="text-sm font-bold" style="color:#92400e">Push to GitHub first</p>
        <p class="text-[12px] leading-relaxed" style="color:#92400e">
          AI features (Improve Issue, Implement with AI) are only available for issues on GitHub.
          Go to the <strong>Details</strong> tab to push this issue.
        </p>
      </div>
    );
  }

  return (
    <div class="space-y-4">
      {/* Issue title */}
      <div>
        <p class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60 mb-1">
          Issue
        </p>
        <p class="text-sm font-semibold text-on-surface leading-snug">{issue.title}</p>
      </div>

      {/* Address PR Comments — visible only when this item is a PR with unresolved review threads */}
      {isPR && (threadsLoading || unresolvedThreads.length > 0) && (
        <div class="rounded-xl p-4 space-y-3" style="background:#edeef0">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined" style="font-size:16px;color:#0e7490">rate_review</span>
            <p class="text-xs font-bold text-on-surface">Address PR Comments</p>
            {!threadsLoading && unresolvedThreads.length > 0 && (
              <span
                class="ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                style="background:#cffafe;color:#0e7490"
              >
                {unresolvedThreads.length} unresolved
              </span>
            )}
          </div>
          {threadsLoading ? (
            <div class="flex items-center gap-1.5 text-[11px] text-on-surface-variant/60">
              <span class="material-symbols-outlined animate-spin" style="font-size:13px">autorenew</span>
              Loading review comments…
            </div>
          ) : (
            <>
              <p class="text-[11px] text-on-surface-variant leading-relaxed">
                The agent will read the unresolved reviewer comments and push fixes to the branch.
              </p>
              <div class="flex flex-col gap-1.5 max-h-36 overflow-y-auto" style="scrollbar-width:thin;scrollbar-color:#c3c6d6 transparent">
                {unresolvedThreads.map((thread, i) => {
                  const c = thread.comments[0];
                  if (!c) return null;
                  return (
                    <div
                      key={i}
                      class="rounded-lg px-2.5 py-2 text-[11px]"
                      style="background:#ffffff;border:1px solid #e1e2e4"
                    >
                      {c.path && (
                        <p class="font-mono text-[10px] text-primary mb-0.5 truncate">{c.path}</p>
                      )}
                      <p class="text-on-surface-variant line-clamp-2 leading-snug">{c.body}</p>
                    </div>
                  );
                })}
              </div>
              <button
                disabled={addressingPR || status === 'running'}
                onClick={handleAddressPRComments}
                class="flex items-center justify-center gap-1.5 w-full text-on-primary text-xs font-semibold py-2 rounded-lg transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                style="background:linear-gradient(135deg,#0e7490,#0891b2)"
              >
                <span class="material-symbols-outlined" style="font-size:14px">
                  {addressingPR ? 'autorenew' : 'rate_review'}
                </span>
                {addressingPR ? 'Starting…' : 'Address PR Comments'}
              </button>
            </>
          )}
        </div>
      )}

      {/* Improve Issue — triage column only */}
      {isTriageCol && (
        <div class="rounded-xl p-4 space-y-3" style="background:#edeef0">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined" style="font-size:16px;color:#6d28d9">edit_note</span>
            <p class="text-xs font-bold text-on-surface">Improve Issue</p>
          </div>
          <p class="text-[11px] text-on-surface-variant leading-relaxed">
            The agent will rewrite the issue title and description to be clearer, more actionable, and
            better scoped.
          </p>
          <textarea
            value={refinePrompt}
            onInput={(e) => setRefinePrompt((e.target as HTMLTextAreaElement).value)}
            placeholder="Provide additional context or instructions for the AI (optional)…"
            rows={3}
            class="w-full text-[11px] text-on-surface bg-white rounded-lg px-3 py-2 resize-none outline-none leading-relaxed"
            style="border:1px solid #c3c6d6"
          />
          <button
            onClick={() => {
              // triggerRefine from run-dispatcher
              import('../../scripts/run-dispatcher.js').then(({ triggerRefine }) => {
                triggerRefine(issue, refinePrompt.trim());
                setDrawerTab('logs');
              });
            }}
            class="flex items-center justify-center gap-1.5 w-full text-on-primary text-xs font-semibold py-2 rounded-lg transition-all active:scale-95"
            style="background:linear-gradient(135deg,#6d28d9,#7c3aed)"
          >
            <span class="material-symbols-outlined" style="font-size:14px">edit_note</span>
            Improve Issue
          </button>
        </div>
      )}

      {/* Implement with AI */}
      <div class="rounded-xl p-4 space-y-3" style="background:#edeef0">
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined" style="font-size:16px;color:#003d9b">auto_fix_high</span>
          <p class="text-xs font-bold text-on-surface">Implement with AI</p>
        </div>
        <p class="text-[11px] text-on-surface-variant leading-relaxed">
          The agent will read the issue, write code, run tests, and open a draft PR — all automatically.
        </p>

        {assignedTeam ? (
          <div
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold"
            style="background:#dae2ff;color:#003d9b"
          >
            <span class="material-symbols-outlined" style="font-size:13px">group</span>
            {(assignedTeam as any).name}
            <span class="ml-auto font-normal opacity-70">{(assignedTeam as any).mode}</span>
          </div>
        ) : implementAgents.length > 1 && isIdleOrFailed ? (
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/60 shrink-0">
              Agent
            </span>
            <select
              class="flex-1 text-xs text-on-surface bg-white rounded-lg px-2 py-1.5 outline-none cursor-pointer"
              style="border:1px solid #c3c6d6"
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId((e.target as HTMLSelectElement).value)}
            >
              {implementAgents.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <AIStatusRow run={run} issueNumber={issue.number} />

        {status === 'running' && (
          <button
            onClick={() => cancelRun(issue.number)}
            class="flex items-center justify-center gap-1.5 w-full text-xs font-semibold py-2 rounded-lg transition-all active:scale-95"
            style="background:#fce4e4;color:#ba1a1a;border:1px solid #f5c2c2"
          >
            <span class="material-symbols-outlined" style="font-size:14px">stop_circle</span>
            Stop
          </button>
        )}

        {status === 'needs_review' && (
          <button
            disabled={pushLoading}
            onClick={handlePush}
            class="flex items-center justify-center gap-1.5 w-full text-xs font-semibold py-2 rounded-lg transition-all active:scale-95"
            style="background:#7c3aed;color:#fff"
          >
            <span class="material-symbols-outlined" style="font-size:14px">upload</span>
            {pushLoading ? 'Pushing…' : 'Push & Open PR'}
          </button>
        )}

        {isIdleOrFailed && (
          <button
            onClick={() => {
              triggerImplement(issue, selectedAgentId || null);
              setDrawerTab('logs');
            }}
            class="flex items-center justify-center gap-1.5 w-full text-on-primary text-xs font-semibold py-2 rounded-lg transition-all active:scale-95"
            style="background:linear-gradient(135deg,#003d9b,#0052cc)"
          >
            <span class="material-symbols-outlined" style="font-size:14px">play_arrow</span>
            {status === 'failed' ? 'Retry' : 'Start Implementation'}
          </button>
        )}
      </div>

      {/* Semantic Search */}
      <div class="rounded-xl p-4 space-y-2" style="background:#edeef0">
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined" style="font-size:16px;color:#003d9b">hub</span>
          <p class="text-xs font-bold text-on-surface">Semantic Search</p>
        </div>
        <p class="text-[11px] text-on-surface-variant leading-relaxed">
          Hybrid search (Voyage AI + keyword) is active. Possible duplicates are auto-detected at ≥85%
          similarity and shown on Triage cards.
        </p>
        {(state.duplicates.get(issue.number) ?? []).length > 0 ? (
          <div class="flex items-center gap-1.5 text-[11px] font-semibold" style="color:#b45309">
            <span class="material-symbols-outlined" style="font-size:13px">warning</span>
            {state.duplicates.get(issue.number).length} possible duplicate(s) detected
          </div>
        ) : (
          <div class="flex items-center gap-1.5 text-[11px]" style="color:#1a7a4a">
            <span class="material-symbols-outlined" style="font-size:13px">check_circle</span>
            No duplicates found above 85% threshold
          </div>
        )}
      </div>
    </div>
  );
}

// ── Logs Tab ──────────────────────────────────────────────────────────────────

const LOG_ICONS: Record<string, { icon: string; color: string }> = {
  info: { icon: 'info', color: '#003d9b' },
  progress: { icon: 'arrow_right', color: '#434654' },
  thinking: { icon: 'autorenew', color: '#434654' },
  reasoning: { icon: 'psychology', color: '#7b2600' },
  tool_call: { icon: 'terminal', color: '#003d9b' },
  tool_result: { icon: 'subdirectory_arrow_right', color: '#4b5563' },
  done: { icon: 'check_circle', color: '#1a7a4a' },
  error: { icon: 'error_outline', color: '#ba1a1a' },
  delegation: { icon: 'swap_horiz', color: '#7c3aed' },
};

function LogEntry({ entry, idx }: { entry: LogEntry; idx: number }) {
  const meta = LOG_ICONS[entry.type] ?? LOG_ICONS.progress;
  const ts = entry.ts
    ? new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';

  if (entry.type === 'delegation') {
    return (
      <div
        key={idx}
        class="flex items-center gap-2 px-3 py-2"
        style="background:#1a1030;border-top:1px solid #2d1f52;border-bottom:1px solid #2d1f52"
      >
        <span class="shrink-0 text-[9px]" style="color:#737685">{ts}</span>
        <span class="material-symbols-outlined shrink-0" style="font-size:13px;color:#7c3aed">swap_horiz</span>
        <span class="text-[10px] font-semibold" style="color:#c4b5fd">Handoff</span>
        <span class="text-[10px]" style="color:#a78bfa">{entry.from ?? ''}</span>
        <span class="material-symbols-outlined" style="font-size:11px;color:#6d28d9">arrow_forward</span>
        <span class="text-[10px] font-semibold" style="color:#a78bfa">{entry.to ?? ''}</span>
      </div>
    );
  }

  const isReasoning = entry.type === 'reasoning';
  const isResult = entry.type === 'tool_result';
  const isThinking = entry.type === 'thinking';
  const rawMsg = entry.message ?? '';
  const cleanMsg = cleanLogMessage(rawMsg);
  const displayMsg = isResult
    ? (() => {
        const lines = cleanMsg.split('\n').filter((l) => l.trim());
        if (!lines.length) return null;
        return lines[0].slice(0, 120) + (lines.length > 1 ? `  (+${lines.length - 1} lines)` : '');
      })()
    : cleanMsg;

  if (isResult && !displayMsg) return null;

  const textColor = isReasoning
    ? '#ffb59b'
    : entry.type === 'done'
    ? '#6ee7a0'
    : entry.type === 'error'
    ? '#fca5a5'
    : entry.type === 'tool_call'
    ? '#93c5fd'
    : entry.type === 'info'
    ? '#93c5fd'
    : isResult
    ? '#6b7280'
    : '#d1d5db';

  return (
    <div
      key={idx}
      class={`flex gap-2 py-1 ${isResult ? 'pl-8 pr-3' : 'px-3 py-1.5'} ${isReasoning ? 'border-l-2' : ''}`}
      style={isReasoning ? 'border-color:#7b2600;background:#1e1208' : isResult ? 'opacity:0.75' : undefined}
    >
      <span class="shrink-0 text-[9px] pt-0.5" style="color:#737685">{isResult ? '' : ts}</span>
      <span
        class={`material-symbols-outlined shrink-0${isThinking ? ' animate-spin' : ''}`}
        style={`font-size:${isResult ? '10' : '12'}px;color:${meta.color};margin-top:1px`}
      >
        {meta.icon}
      </span>
      <span
        class={`flex-1 leading-relaxed ${isReasoning ? '' : 'break-all'} text-[10px]`}
        style={`color:${textColor}`}
      >
        {entry.type === 'tool_call' ? (
          <>
            <span style="color:#93c5fd">{entry.tool ?? ''}</span>
            {entry.path && <span style="color:#737685">{'  ' + entry.path}</span>}
          </>
        ) : isReasoning ? (
          formatReasoningMessage(entry.message ?? '')
        ) : (
          displayMsg ?? ''
        )}
      </span>
    </div>
  );
}

function RunStatusBadge({ status, isActive, onCancel, onPush, pushLoading }: {
  status: string;
  isActive: boolean;
  onCancel?: () => void;
  onPush?: () => void;
  pushLoading?: boolean;
}) {
  if (status === 'running') return (
    <div class="flex items-center gap-2">
      <div class="flex items-center gap-1 text-[10px] font-semibold" style="color:#003d9b">
        <span class="material-symbols-outlined animate-spin" style="font-size:11px">autorenew</span>
        Running
      </div>
      {isActive && onCancel && (
        <button
          onClick={onCancel}
          class="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-lg transition-all active:scale-95"
          style="background:#fce4e4;color:#ba1a1a;border:1px solid #f5c2c2"
        >
          <span class="material-symbols-outlined" style="font-size:11px">stop_circle</span>
          Stop
        </button>
      )}
    </div>
  );
  if (status === 'done') return (
    <div class="flex items-center gap-1 text-[10px] font-semibold" style="color:#1a7a4a">
      <span class="material-symbols-outlined" style="font-size:11px">check_circle</span>
      Done
    </div>
  );
  if (status === 'failed') return (
    <div class="flex items-center gap-1 text-[10px] font-semibold" style="color:#ba1a1a">
      <span class="material-symbols-outlined" style="font-size:11px">error</span>
      Failed
    </div>
  );
  if (status === 'needs_review') return (
    <div class="flex items-center gap-2">
      <div class="flex items-center gap-1 text-[10px] font-semibold" style="color:#7c3aed">
        <span class="material-symbols-outlined" style="font-size:11px">upload</span>
        Ready to push
      </div>
      {isActive && onPush && (
        <button
          disabled={pushLoading}
          onClick={onPush}
          class="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-lg transition-all active:scale-95"
          style="background:#7c3aed;color:#fff"
        >
          <span class="material-symbols-outlined" style="font-size:11px">upload</span>
          {pushLoading ? 'Pushing…' : 'Push & Open PR'}
        </button>
      )}
    </div>
  );
  if (status === 'cancelled') return (
    <div class="flex items-center gap-1 text-[10px] font-semibold" style="color:#737685">
      <span class="material-symbols-outlined" style="font-size:11px">cancel</span>
      Cancelled
    </div>
  );
  return null;
}

function LogsTab({ issue }: { issue: Issue }) {
  const runs = runsSignal.value as Map<number, Run>;
  const logsMap = logsSignal.value as Map<number, LogEntry[]>;
  const run = runs.get(issue.number);
  const logs = logsMap.get(issue.number) ?? [];
  const hasSuggestion = (suggestionsSignal.value as Map<number, any>).has(issue.number);

  const groups = groupLogsByRun(logs);
  const latestRunIndex = groups.length > 0 ? groups[groups.length - 1].runIndex : -1;

  // Collapsed set — all runs except the latest start collapsed
  const [collapsedRuns, setCollapsedRuns] = useState<Set<number>>(() => {
    const init = new Set<number>();
    const g = groupLogsByRun(logsMap.get(issue.number) ?? []);
    for (let i = 0; i < g.length - 1; i++) init.add(g[i].runIndex);
    return init;
  });

  // When a new run starts, collapse the previous latest and expand the new one
  const prevLatestRef = useRef(latestRunIndex);
  useEffect(() => {
    if (latestRunIndex !== prevLatestRef.current && prevLatestRef.current !== -1) {
      setCollapsedRuns((prev) => {
        const next = new Set(prev);
        next.add(prevLatestRef.current);
        next.delete(latestRunIndex);
        return next;
      });
    }
    prevLatestRef.current = latestRunIndex;
  }, [latestRunIndex]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const [pushLoading, setPushLoading] = useState(false);

  // Auto-scroll when the latest run gets new log entries and is expanded
  useEffect(() => {
    if (bodyRef.current && !collapsedRuns.has(latestRunIndex)) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs.length]);

  async function handlePush() {
    setPushLoading(true);
    await pushRun(issue.number);
    setPushLoading(false);
  }

  function toggleRun(runIndex: number) {
    setCollapsedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(runIndex)) next.delete(runIndex);
      else next.add(runIndex);
      return next;
    });
  }

  return (
    <div class="space-y-4" ref={bodyRef}>
      {/* Header */}
      <p class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60">
        Agent Logs
      </p>

      {/* Empty state */}
      {groups.length === 0 ? (
        <div class="flex flex-col items-center gap-3 py-10 text-center">
          <span class="material-symbols-outlined" style="font-size:36px;color:#c3c6d6">terminal</span>
          <p class="text-xs text-on-surface-variant/60">No agent run started yet.</p>
          <button
            onClick={() => triggerImplement(issue, null)}
            class="flex items-center gap-1.5 text-xs font-semibold text-on-primary px-4 py-2 rounded-lg transition-all active:scale-95"
            style="background:linear-gradient(135deg,#003d9b,#0052cc)"
          >
            <span class="material-symbols-outlined" style="font-size:14px">play_arrow</span>
            Start Implementation
          </button>
        </div>
      ) : (
        <div class="flex flex-col gap-2">
          {groups.map((group) => {
            const isActive = group.runIndex === latestRunIndex;
            const status = getRunGroupStatus(group, isActive, run?.status);
            const isCollapsed = collapsedRuns.has(group.runIndex);
            const startTime = new Date(group.startTs).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            });
            const startDate = new Date(group.startTs).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            });
            const actionLabel = group.actionType === 'refine' ? 'Refine' : 'Implement';

            return (
              <div key={group.runIndex} class="rounded-xl overflow-hidden" style="border:1px solid #2a2d30">
                {/* Run header — click to expand/collapse */}
                <button
                  onClick={() => toggleRun(group.runIndex)}
                  class="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                  style="background:#1e2124"
                >
                  <span
                    class="material-symbols-outlined shrink-0 transition-transform"
                    style={`font-size:14px;color:#737685;transform:rotate(${isCollapsed ? '-90deg' : '0deg'})`}
                  >
                    expand_more
                  </span>
                  <span class="text-[10px] font-semibold" style="color:#d1d5db">
                    Run #{group.runIndex}
                  </span>
                  <span
                    class="text-[9px] px-1.5 py-0.5 rounded-md font-medium"
                    style="background:#2a2d30;color:#9ca3af"
                  >
                    {actionLabel}
                  </span>
                  <span class="text-[9px]" style="color:#4b5563">
                    {startDate} {startTime}
                  </span>
                  <span class="text-[9px]" style="color:#374151">
                    · {group.logs.length} entries
                  </span>
                  <div class="ml-auto">
                    <RunStatusBadge
                      status={status}
                      isActive={isActive}
                      onCancel={() => cancelRun(issue.number)}
                      onPush={handlePush}
                      pushLoading={pushLoading}
                    />
                  </div>
                </button>

                {/* Log entries */}
                {!isCollapsed && (
                  <div class="flex flex-col gap-0.5 font-mono text-[11px]" style="background:#191c1e">
                    {group.logs.map((entry, idx) => (
                      <LogEntry key={idx} entry={entry} idx={idx} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* View AI Suggestion shortcut */}
      {hasSuggestion && (
        <button
          onClick={() => setDrawerTab('details')}
          class="w-full flex items-center justify-center gap-1.5 text-xs font-semibold py-2 rounded-lg transition-all active:scale-95"
          style="background:#dae2ff;color:#003d9b"
        >
          <span class="material-symbols-outlined" style="font-size:14px">auto_fix_high</span>
          View AI Suggestion in Details
        </button>
      )}
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function IssueDrawer() {
  const { issue, tab } = drawerSignal.value as { issue: Issue | null; tab: Tab };
  const logsMap = logsSignal.value as Map<number, LogEntry[]>;

  if (!issue) return null;

  const logCount = logsMap.get(issue.number)?.length ?? 0;

  const tabActiveStyle = 'border-bottom:2px solid #003d9b;color:#003d9b;font-weight:700';

  const drawerBodyRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on log tab
  useEffect(() => {
    if (tab === 'logs' && drawerBodyRef.current) {
      drawerBodyRef.current.scrollTop = drawerBodyRef.current.scrollHeight;
    }
  }, [tab, logCount]);

  return (
    <>
      {/* Backdrop */}
      <div
        class="fixed inset-0 z-40"
        onClick={closeDrawer}
      />

      {/* Drawer panel */}
      <div
        class="fixed right-0 z-50 flex flex-col bg-surface-container-lowest"
        style="top:48px;bottom:0;width:400px;border-left:1px solid rgba(195,198,214,0.25);box-shadow:-8px 0 24px rgba(0,0,0,0.08)"
      >
        {/* Header */}
        <div
          class="flex items-center h-13 px-4 shrink-0 gap-2"
          style="border-bottom:1px solid rgba(195,198,214,0.25)"
        >
          {/* Issue number badge — local issues show a "Board only" pill */}
          {(issue as any)._local ? (
            <span
              class="text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 flex items-center gap-1"
              style="background:#fef3c7;color:#b45309"
            >
              <span class="material-symbols-outlined" style="font-size:11px">cloud_off</span>
              Board only
            </span>
          ) : (
            <span
              class="text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0"
              style="background:#e8ecf5;color:#003d9b"
            >
              #{issue.number}
            </span>
          )}

          {/* GitHub link — hide for local issues */}
          {!(issue as any)._local && (
            <a
              href={issue.html_url}
              target="_blank"
              class="text-on-surface-variant hover:text-on-surface transition-colors shrink-0"
              title="Open on GitHub"
            >
              <span class="material-symbols-outlined" style="font-size:15px">open_in_new</span>
            </a>
          )}

          {/* Tabs */}
          <div class="flex items-center flex-1 ml-1 gap-0">
            {(['details', 'ai', 'logs'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setDrawerTab(t)}
                class="relative px-3 py-1 text-[11px] transition-colors text-on-surface-variant hover:text-on-surface"
                style={tab === t ? tabActiveStyle : undefined}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
                {t === 'logs' && logCount > 0 && tab !== 'logs' && (
                  <span
                    class="ml-1 text-[9px] font-bold px-1 py-0.5 rounded-full"
                    style="background:#003d9b;color:#fff"
                  >
                    {logCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Close */}
          <button
            onClick={closeDrawer}
            class="text-on-surface-variant hover:text-on-surface transition-colors p-1 rounded shrink-0"
          >
            <span class="material-symbols-outlined" style="font-size:16px">close</span>
          </button>
        </div>

        {/* Body */}
        <div
          id="drawer-body"
          ref={drawerBodyRef}
          class="flex-1 overflow-y-auto px-5 py-5"
          style="scrollbar-width:thin;scrollbar-color:#c3c6d6 transparent"
        >
          {tab === 'details' && <DetailsTab issue={issue} />}
          {tab === 'ai' && <AITab issue={issue} />}
          {tab === 'logs' && <LogsTab issue={issue} />}
        </div>
      </div>
    </>
  );
}
