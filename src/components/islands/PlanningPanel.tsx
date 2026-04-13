/**
 * PlanningPanel — Preact island
 *
 * Replaces planning.js (1665 lines of vanilla JS).
 * Fullscreen overlay with:
 *   - Left sidebar: searchable note list
 *   - Center: TipTap rich-text editor
 *   - Right sidebar: AI chat panel
 */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { Editor, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Highlight from '@tiptap/extension-highlight';
import Typography from '@tiptap/extension-typography';
import mermaid from 'mermaid';
import { createIssue } from '../../lib/github-api.js';
import { addLocalIssue } from '../../lib/local-issues.js';
import { getAgents, getGlobalAiKey } from '../../lib/agents.js';
import { AGENT_BASE_URL } from '../../lib/config.js';
import { state } from '../../scripts/state.js';
import { planningPanelOpenSignal } from '../../lib/signals.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Decision {
  q: string;
  a: string;
}

interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  decisions?: Decision[];
}

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

interface GeneratedIssue {
  title: string;
  body: string;
  githubNumber?: number;   // set after pushed to GitHub
  localBoardId?: string;   // _localId of the local board issue once added to board
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DIAGRAM_TEMPLATES: Record<string, string> = {
  flowchart: `flowchart LR\n    Start([Start]) --> Process[Do something]\n    Process --> Decision{Condition?}\n    Decision -- Yes --> Result([Done])\n    Decision -- No  --> Process`,
  sequence: `sequenceDiagram\n    actor User\n    User->>Server: Request\n    Server->>DB: Query\n    DB-->>Server: Data\n    Server-->>User: Response`,
  er: `erDiagram\n    USER { int id PK\n        string name\n    }\n    ORDER { int id PK\n        int userId FK\n    }\n    USER ||--o{ ORDER : places`,
  mindmap: `mindmap\n  root((Project))\n    Goals\n      Feature A\n    Risks\n      Technical`,
  gantt: `gantt\n    title Project Timeline\n    dateFormat YYYY-MM-DD\n    section Phase 1\n    Research :a1, 2025-01-01, 7d`,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function stripHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent ?? '';
}

function wordCount(html: string): number {
  const text = stripHtml(html).trim();
  if (!text) return 0;
  return text.split(/\s+/).length;
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let _mermaidCounter = 0;

// ── MermaidBlock TipTap Extension ─────────────────────────────────────────────

function createMermaidExtension(
  openDiagramModalRef: { current: ((src: string, onSave: (src: string) => void) => void) | null }
) {
  return Node.create({
    name: 'mermaidBlock',
    group: 'block',
    atom: true,

    addAttributes() {
      return {
        source: {
          default: '',
          parseHTML: (el: Element) => el.getAttribute('data-source') ?? '',
          renderHTML: (attrs: Record<string, string>) => ({ 'data-source': attrs.source }),
        },
      };
    },

    parseHTML() {
      return [{ tag: 'div[data-mermaid-block]' }];
    },

    renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
      return ['div', mergeAttributes({ 'data-mermaid-block': '' }, HTMLAttributes)];
    },

    addNodeView() {
      return ({ node, editor, getPos }: { node: any; editor: Editor; getPos: (() => number) | boolean }) => {
        const dom = document.createElement('div');
        dom.className = 'mermaid-block';

        const toolbar = document.createElement('div');
        toolbar.className = 'mermaid-block-toolbar';
        toolbar.innerHTML = `
          <span class="material-symbols-outlined" style="font-size:14px;color:#a0a3b0">account_tree</span>
          <span style="flex:1">Flow Diagram</span>`;

        const editBtn = document.createElement('button');
        editBtn.className = 'mermaid-block-edit-btn';
        editBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:13px;vertical-align:middle">edit</span> Edit`;
        toolbar.appendChild(editBtn);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'mermaid-block-edit-btn';
        copyBtn.style.cssText = 'margin-left:4px';
        copyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:13px;vertical-align:middle">content_copy</span>`;
        copyBtn.title = 'Copy Mermaid source';
        toolbar.appendChild(copyBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'mermaid-block-edit-btn';
        delBtn.style.cssText = 'color:#ba1a1a;background:rgba(186,26,26,0.07);margin-left:4px';
        delBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:13px;vertical-align:middle">delete</span>`;
        delBtn.title = 'Remove diagram';
        toolbar.appendChild(delBtn);

        const svgWrap = document.createElement('div');
        svgWrap.className = 'mermaid-block-svg';

        dom.appendChild(toolbar);
        dom.appendChild(svgWrap);

        const render = async (source: string) => {
          const src = source && source !== 'undefined' ? source.trim() : '';
          if (!src) {
            svgWrap.innerHTML =
              '<p style="color:#a0a3b0;font-size:12px;padding:12px">Empty diagram — click Edit to add content.</p>';
            return;
          }
          try {
            const id = `mermaid-nv-${++_mermaidCounter}`;
            const { svg } = await mermaid.render(id, src);
            svgWrap.innerHTML = `<div style="max-width:100%">${svg}</div>`;
          } catch (e: any) {
            svgWrap.innerHTML = `<p style="color:#ba1a1a;font-size:11px;padding:12px">${esc(e.message)}</p>`;
          }
        };

        render(node.attrs.source);

        copyBtn.addEventListener('mousedown', async (e: MouseEvent) => {
          e.preventDefault();
          await navigator.clipboard.writeText(node.attrs.source).catch(() => {});
          copyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:13px;vertical-align:middle">check</span>`;
          setTimeout(() => {
            copyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:13px;vertical-align:middle">content_copy</span>`;
          }, 1500);
        });

        editBtn.addEventListener('mousedown', (e: MouseEvent) => {
          e.preventDefault();
          if (openDiagramModalRef.current) {
            openDiagramModalRef.current(node.attrs.source, (newSource: string) => {
              if (typeof getPos !== 'function') return;
              editor
                .chain()
                .focus()
                .command(({ tr }: { tr: any }) => {
                  tr.setNodeMarkup(getPos(), undefined, { source: newSource });
                  return true;
                })
                .run();
            });
          }
        });

        delBtn.addEventListener('mousedown', (e: MouseEvent) => {
          e.preventDefault();
          if (typeof getPos !== 'function') return;
          const pos = getPos();
          editor
            .chain()
            .focus()
            .command(({ tr, state: s }: { tr: any; state: any }) => {
              const node2 = s.doc.nodeAt(pos);
              if (node2) tr.delete(pos, pos + node2.nodeSize);
              return true;
            })
            .run();
        });

        return {
          dom,
          update(updatedNode: any) {
            if (updatedNode.type.name !== 'mermaidBlock') return false;
            if (updatedNode.attrs.source !== node.attrs.source) {
              render(updatedNode.attrs.source);
            }
            node = updatedNode;
            return true;
          },
        };
      };
    },
  });
}

// ── DiagramModal ──────────────────────────────────────────────────────────────

interface DiagramModalProps {
  open: boolean;
  source: string;
  onSourceChange: (src: string) => void;
  onSave: () => void;
  onCancel: () => void;
  selectedTemplate: string;
  onSelectTemplate: (t: string) => void;
}

function DiagramModal({
  open,
  source,
  onSourceChange,
  onSave,
  onCancel,
  selectedTemplate,
  onSelectTemplate,
}: DiagramModalProps) {
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !previewRef.current) return;
    const src = source.trim();
    if (!src) {
      if (previewRef.current) previewRef.current.innerHTML = '<p style="color:#a0a3b0;padding:16px">Nothing to preview.</p>';
      return;
    }
    let cancelled = false;
    requestAnimationFrame(async () => {
      if (cancelled || !previewRef.current) return;
      try {
        const id = `mermaid-preview-${++_mermaidCounter}`;
        const { svg } = await mermaid.render(id, src);
        if (!cancelled && previewRef.current) {
          previewRef.current.innerHTML = `<div style="max-width:100%">${svg}</div>`;
        }
      } catch (e: any) {
        if (!cancelled && previewRef.current) {
          previewRef.current.innerHTML = `<p style="color:#ba1a1a;font-size:12px;padding:16px">${esc(e.message)}</p>`;
        }
      }
    });
    return () => { cancelled = true; };
  }, [source, open]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          width: 880,
          maxWidth: '96vw',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.18)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 18px', borderBottom: '1px solid #eee' }}>
          <span class="material-symbols-outlined" style={{ fontSize: 18, color: '#5f6376' }}>account_tree</span>
          <span style={{ fontWeight: 600, fontSize: 15, flex: 1 }}>Edit Diagram</span>
          <button
            onClick={onCancel}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
          >
            <span class="material-symbols-outlined" style={{ fontSize: 20, color: '#888' }}>close</span>
          </button>
        </div>

        {/* Template picker */}
        <div style={{ display: 'flex', gap: 6, padding: '10px 18px', borderBottom: '1px solid #f0f0f0', flexWrap: 'wrap' }}>
          {Object.keys(DIAGRAM_TEMPLATES).map((t) => (
            <button
              key={t}
              onClick={() => {
                onSelectTemplate(t);
                onSourceChange(DIAGRAM_TEMPLATES[t]);
              }}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid',
                borderColor: selectedTemplate === t ? '#003d9b' : '#ddd',
                background: selectedTemplate === t ? '#003d9b' : '#fff',
                color: selectedTemplate === t ? '#fff' : '#333',
                fontSize: 12,
                cursor: 'pointer',
                fontWeight: selectedTemplate === t ? 600 : 400,
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Body: editor + preview */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
          {/* Source editor */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid #eee', padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Source
            </div>
            <textarea
              value={source}
              onInput={(e) => onSourceChange((e.target as HTMLTextAreaElement).value)}
              style={{
                flex: 1,
                fontFamily: 'monospace',
                fontSize: 13,
                padding: 10,
                border: '1px solid #ddd',
                borderRadius: 6,
                resize: 'none',
                outline: 'none',
                background: '#fafafa',
                minHeight: 260,
              }}
              spellcheck={false}
            />
          </div>

          {/* Live preview */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Preview
            </div>
            <div
              ref={previewRef}
              style={{
                flex: 1,
                border: '1px solid #eee',
                borderRadius: 6,
                overflow: 'auto',
                background: '#fafff9',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'center',
                padding: 8,
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', gap: 8, padding: '12px 18px', borderTop: '1px solid #eee', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '7px 18px',
              borderRadius: 7,
              border: '1px solid #ddd',
              background: '#fff',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            style={{
              padding: '7px 18px',
              borderRadius: 7,
              border: 'none',
              background: '#003d9b',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function PlanningPanel() {
  if (!planningPanelOpenSignal.value) return null;

  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [chatCtx, setChatCtx] = useState<'all' | 'selected' | 'active'>('all');
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [generatedIssues, setGeneratedIssues] = useState<GeneratedIssue[]>([]);
  const [viewFullIssue, setViewFullIssue] = useState<GeneratedIssue | null>(null);
  const [viewEditTitle, setViewEditTitle] = useState('');
  const [viewEditBody, setViewEditBody] = useState('');
  const [diagramModalOpen, setDiagramModalOpen] = useState(false);
  const [diagramModalSource, setDiagramModalSource] = useState('');
  const [diagramModalOnSave, setDiagramModalOnSave] = useState<((src: string) => void) | null>(null);
  const [selectedDiagramTemplate, setSelectedDiagramTemplate] = useState('flowchart');
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [insertDiagramSelectOpen, setInsertDiagramSelectOpen] = useState(false);

  // Decisions / ADR panel
  // decisionsNoteId === '__multi__' means the panel was opened for multiple selected notes
  const [decisionsNoteId, setDecisionsNoteId] = useState<string | null>(null);
  const [decisionsSourceNotes, setDecisionsSourceNotes] = useState<Note[]>([]);
  const [decisionsPhase, setDecisionsPhase] = useState<'loading' | 'questions' | 'error'>('loading');
  const [decisionsQuestions, setDecisionsQuestions] = useState<string[]>([]);
  const [decisionsAnswers, setDecisionsAnswers] = useState<string[]>([]);
  const [decisionsError, setDecisionsError] = useState('');

  const editorRef = useRef<Editor | null>(null);
  const editorDomRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openDiagramModalRef = useRef<((src: string, onSave: (src: string) => void) => void) | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<Note[]>([]);

  // Keep refs in sync
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  // Load notes on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem('pnx_planning_notes');
      const loaded: Note[] = raw ? JSON.parse(raw) : [];
      setNotes(loaded);
      if (loaded.length > 0) setActiveId(loaded[0].id);
    } catch {
      setNotes([]);
    }
  }, []);

  // Initialize TipTap once
  useEffect(() => {
    if (!editorDomRef.current) return;

    mermaid.initialize({
      startOnLoad: false,
      theme: 'neutral',
      fontFamily: 'Inter, sans-serif',
      flowchart: { curve: 'basis', useMaxWidth: true },
      securityLevel: 'loose',
    });

    const MermaidBlock = createMermaidExtension(openDiagramModalRef);

    const editor = new Editor({
      element: editorDomRef.current,
      extensions: [
        StarterKit,
        Underline,
        Placeholder.configure({ placeholder: 'Start writing…' }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Highlight.configure({ multicolor: true }),
        Typography,
        MermaidBlock,
      ],
      content: '',
      onUpdate: ({ editor: ed }) => {
        if (activeIdRef.current) {
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
          saveTimerRef.current = setTimeout(() => {
            setNotes((prev) => {
              const next = prev.map((n) =>
                n.id === activeIdRef.current
                  ? { ...n, content: ed.getHTML(), updatedAt: new Date().toISOString() }
                  : n
              );
              localStorage.setItem('pnx_planning_notes', JSON.stringify(next));
              return next;
            });
          }, 800);
        }
      },
    });
    editorRef.current = editor;

    // Set the modal opener ref
    openDiagramModalRef.current = (src, onSave) => {
      setDiagramModalSource(src || '');
      setDiagramModalOnSave(() => onSave);
      setDiagramModalOpen(true);
    };

    return () => {
      editor.destroy();
      editorRef.current = null;
    };
  }, []); // run once

  // Load note content when activeId changes
  useEffect(() => {
    if (!editorRef.current || !activeId) return;
    const note = notes.find((n) => n.id === activeId);
    if (note) editorRef.current.commands.setContent(note.content || '', false);
  }, [activeId]);

  // Scroll chat to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // ── Note CRUD ───────────────────────────────────────────────────────────────

  function createNote(): Note {
    const now = new Date().toISOString();
    const note: Note = { id: crypto.randomUUID(), title: '', content: '', createdAt: now, updatedAt: now };
    setNotes((prev) => {
      const next = [note, ...prev];
      localStorage.setItem('pnx_planning_notes', JSON.stringify(next));
      return next;
    });
    setActiveId(note.id);
    return note;
  }

  function deleteNote(id: string) {
    setNotes((prev) => {
      const next = prev.filter((n) => n.id !== id);
      localStorage.setItem('pnx_planning_notes', JSON.stringify(next));
      return next;
    });
    setSelectedIds((prev) => {
      const s = new Set(prev);
      s.delete(id);
      return s;
    });
    if (activeId === id) {
      setActiveId(notesRef.current.find((n) => n.id !== id)?.id ?? null);
    }
  }

  function deleteSelected() {
    setNotes((prev) => {
      const next = prev.filter((n) => !selectedIds.has(n.id));
      localStorage.setItem('pnx_planning_notes', JSON.stringify(next));
      return next;
    });
    if (activeId && selectedIds.has(activeId)) {
      setActiveId(notesRef.current.find((n) => !selectedIds.has(n.id))?.id ?? null);
    }
    setSelectedIds(new Set());
  }

  function updateNoteTitle(id: string, title: string) {
    setNotes((prev) => {
      const next = prev.map((n) =>
        n.id === id ? { ...n, title, updatedAt: new Date().toISOString() } : n
      );
      localStorage.setItem('pnx_planning_notes', JSON.stringify(next));
      return next;
    });
  }

  // ── Context builder ─────────────────────────────────────────────────────────

  function buildContextNotes(): Note[] {
    const current = notesRef.current;
    if (chatCtx === 'all') return current;
    if (chatCtx === 'selected') return current.filter((n) => selectedIds.has(n.id));
    if (chatCtx === 'active') {
      const note = current.find((n) => n.id === activeIdRef.current);
      return note ? [note] : [];
    }
    return [];
  }

  // ── Shared streaming helper (matches backend /notes/ask contract) ────────────

  async function streamAgentText(question: string, notes: Note[]): Promise<string> {
    const apiKey = getAgents().find((a: any) => a.apiKey)?.apiKey || getGlobalAiKey();
    const res = await fetch(`${AGENT_BASE_URL}/notes/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        notes: notes.map((n) => ({ id: n.id, title: n.title || 'Untitled', content: stripHtml(n.content) })),
        llm_api_key: apiKey || undefined,
      }),
    });
    if (!res.ok) throw new Error(`Agent server error: ${res.status}`);
    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'token') fullText += event.data?.content ?? '';
        } catch { /* skip malformed SSE chunk */ }
      }
    }
    return fullText;
  }

  // Same helper but also streams tokens into the chat panel (for sendChat)
  async function streamAgentTextToChat(question: string, notes: Note[]): Promise<void> {
    const apiKey = getAgents().find((a: any) => a.apiKey)?.apiKey || getGlobalAiKey();
    const res = await fetch(`${AGENT_BASE_URL}/notes/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        notes: notes.map((n) => ({ id: n.id, title: n.title || 'Untitled', content: stripHtml(n.content) })),
        llm_api_key: apiKey || undefined,
      }),
    });
    if (!res.ok) throw new Error(`Agent server error: ${res.status}`);
    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'token') {
            const chunk = event.data?.content ?? '';
            if (chunk) {
              setChatMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === 'assistant') {
                  next[next.length - 1] = { ...last, content: last.content + chunk };
                }
                return next;
              });
            }
          }
        } catch { /* skip */ }
      }
    }
  }

  // ── Chat ────────────────────────────────────────────────────────────────────

  async function sendChat() {
    const msg = chatInput.trim();
    if (!msg || streaming) return;
    setChatInput('');
    setChatMessages((prev) => [
      ...prev,
      { role: 'user', content: msg, ts: Date.now() },
      { role: 'assistant', content: '', ts: Date.now() },
    ]);
    setStreaming(true);

    try {
      await streamAgentTextToChat(msg, buildContextNotes());
    } catch (err: any) {
      setChatMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant') {
          next[next.length - 1] = { ...last, content: `Error: ${err.message}` };
        }
        return next;
      });
    } finally {
      setStreaming(false);
    }
  }

  async function generateIssues() {
    if (streaming) return;
    setStreaming(true);
    setGeneratedIssues([]);

    const prompt = `Based on the planning notes, generate a list of GitHub issues. Each issue must be a concrete, actionable work item.

Return ONLY a JSON object in this exact format (no other text, no markdown fences):
{"issues":[{"title":"...","body":"Markdown description..."}]}

Generate 2–6 issues.`;

    try {
      const text = await streamAgentText(prompt, buildContextNotes());
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      const candidate = fenced ? fenced[1] : text;
      const jsonMatch = candidate.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Could not parse issues from AI response.');
      const parsed = JSON.parse(jsonMatch[0]);
      const issues: GeneratedIssue[] = parsed.issues ?? [];
      setGeneratedIssues(issues);
      if (issues.length > 0) {
        const summary = issues.map((i) => `**${i.title}**`).join('\n');
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Generated ${issues.length} issue(s):\n${summary}`, ts: Date.now() },
        ]);
      }
    } catch (err: any) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error generating issues: ${err.message}`, ts: Date.now() },
      ]);
    } finally {
      setStreaming(false);
    }
  }

  async function pushIssueToGitHub(issue: GeneratedIssue, idx: number) {
    if (!state.repoFullName) {
      setChatMessages((prev) => [...prev, { role: 'assistant', content: 'Load a repository on the board first.', ts: Date.now() }]);
      return;
    }
    try {
      const created = await createIssue(state.repoFullName, { title: issue.title, body: issue.body, labels: undefined });
      setGeneratedIssues((prev) =>
        prev.map((gi, i) => i === idx ? { ...gi, githubNumber: created.number } : gi)
      );
      // If it was on the board as a local issue, promote it to the real GitHub issue
      if (issue.localBoardId) {
        window.dispatchEvent(new CustomEvent('pnx:promote-local-issue', {
          detail: {
            localId: issue.localBoardId,
            localNum: created.number - 1, // approximation; board-loader uses localId as authoritative
            githubIssue: created,
          },
        }));
      }
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Issue #${created.number} "${issue.title}" created on GitHub.`, ts: Date.now() },
      ]);
    } catch (err: any) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Failed to create issue: ${err.userMessage || err.message}`, ts: Date.now() },
      ]);
    }
  }

  function openViewModal(issue: GeneratedIssue) {
    setViewEditTitle(issue.title);
    setViewEditBody(issue.body);
    setViewFullIssue(issue);
  }

  function commitViewEdits() {
    if (!viewFullIssue) return;
    const idx = generatedIssues.indexOf(viewFullIssue);
    if (idx === -1) return;
    const updated: GeneratedIssue = { ...viewFullIssue, title: viewEditTitle, body: viewEditBody };
    setGeneratedIssues((prev) => prev.map((gi, i) => i === idx ? updated : gi));
    setViewFullIssue(updated);
  }

  function addIssueToBoard(issue: GeneratedIssue, idx: number) {
    if (!state.repoFullName) {
      setChatMessages((prev) => [...prev, { role: 'assistant', content: 'Load a repository on the board first.', ts: Date.now() }]);
      return;
    }
    if (issue.localBoardId) return; // already on board
    const local = addLocalIssue(state.repoFullName, { title: issue.title, body: issue.body });
    setGeneratedIssues((prev) =>
      prev.map((gi, i) => i === idx ? { ...gi, localBoardId: local._localId } : gi)
    );
    window.dispatchEvent(new CustomEvent('pnx:add-local-issue', { detail: local }));
  }

  // ── Diagram modal actions ───────────────────────────────────────────────────

  function handleDiagramSave() {
    if (diagramModalOnSave) {
      diagramModalOnSave(diagramModalSource);
    } else {
      // Insert new diagram
      editorRef.current
        ?.chain()
        .focus()
        .insertContent({ type: 'mermaidBlock', attrs: { source: diagramModalSource } })
        .run();
    }
    setDiagramModalOpen(false);
    setDiagramModalOnSave(null);
  }

  function handleInsertDiagram(template: string) {
    openDiagramModalRef.current?.(DIAGRAM_TEMPLATES[template] ?? DIAGRAM_TEMPLATES.flowchart, null as any);
    setInsertDiagramSelectOpen(false);
  }

  // ── Decisions / ADR ─────────────────────────────────────────────────────────

  async function _runDecisionsAnalysis(sourceNotes: Note[]) {
    setDecisionsPhase('loading');
    setDecisionsQuestions([]);
    setDecisionsAnswers([]);

    const question = `You are helping capture key decisions for planning notes. Identify 3–5 key assumptions or edge cases that need explicit decisions before these notes can be turned into actionable GitHub issues.

Return ONLY a JSON object (no other text, no markdown fences):
{"questions":["Question 1?","Question 2?","Question 3?"]}

Focus on: technical approach choices, scope boundaries, constraints, dependencies, risk factors.`;

    try {
      const fullText = await streamAgentText(question, sourceNotes);
      const fenced = fullText.match(/```(?:json)?\s*([\s\S]*?)```/);
      const candidate = fenced ? fenced[1] : fullText;
      const jsonMatch = candidate.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Could not parse questions from AI response.');
      const parsed = JSON.parse(jsonMatch[0]);
      const questions: string[] = parsed.questions ?? [];
      if (questions.length === 0) throw new Error('No questions returned.');
      setDecisionsQuestions(questions);
      setDecisionsAnswers(new Array(questions.length).fill(''));
      setDecisionsPhase('questions');
    } catch (err: any) {
      setDecisionsError(err.message || 'Failed to analyse notes.');
      setDecisionsPhase('error');
    }
  }

  async function analyzeForDecisions(noteId: string) {
    const note = notesRef.current.find((n) => n.id === noteId);
    if (!note) return;
    setDecisionsNoteId(noteId);
    setDecisionsSourceNotes([note]);
    // Show saved decisions immediately if present
    if (note.decisions && note.decisions.length > 0) {
      setDecisionsQuestions(note.decisions.map((d) => d.q));
      setDecisionsAnswers(note.decisions.map((d) => d.a));
      setDecisionsPhase('questions');
      return;
    }
    await _runDecisionsAnalysis([note]);
  }

  async function analyzeSelectedNotesForDecisions() {
    const selected = notesRef.current.filter((n) => selectedIds.has(n.id));
    if (selected.length < 2) return;
    setDecisionsNoteId('__multi__');
    setDecisionsSourceNotes(selected);
    await _runDecisionsAnalysis(selected);
  }

  function saveDecisions() {
    // Single-note mode only — persist Q&A to the note as ADR records
    if (!decisionsNoteId || decisionsNoteId === '__multi__') return;
    const decisions: Decision[] = decisionsQuestions.map((q, i) => ({ q, a: decisionsAnswers[i] ?? '' }));
    setNotes((prev) => {
      const next = prev.map((n) => n.id === decisionsNoteId ? { ...n, decisions } : n);
      localStorage.setItem('pnx_planning_notes', JSON.stringify(next));
      return next;
    });
  }

  async function createIssuesFromDecisions() {
    if (!decisionsNoteId || streaming) return;
    const isMulti = decisionsNoteId === '__multi__';

    const qaBlock = decisionsQuestions.length > 0
      ? decisionsQuestions.map((q, i) => `Q: ${q}\nA: ${decisionsAnswers[i] || '(not answered)'}`).join('\n\n')
      : '';

    const prompt = `Based on the planning notes and the decisions/clarifications below, generate GitHub issues. Each issue must be a concrete, actionable work item that accounts for the answers given.

Decisions:
${qaBlock}

Return ONLY a JSON object (no other text, no markdown fences):
{"issues":[{"title":"...","body":"Markdown description..."}]}

Generate 2–6 issues.`;

    setStreaming(true);
    setGeneratedIssues([]);
    try {
      // In multi-note mode: first create a new document capturing the decisions
      let docNote: Note | null = null;
      if (isMulti) {
        const sourceNames = decisionsSourceNotes.map((n) => n.title || 'Untitled').join(', ');
        const docContent = [
          `<h2>Assumptions &amp; Decisions</h2>`,
          `<p><em>Sources: ${esc(sourceNames)}</em></p>`,
          ...decisionsQuestions.map((q, i) =>
            `<h3>${esc(q)}</h3><p>${esc(decisionsAnswers[i] || '(not answered)')}</p>`
          ),
        ].join('\n');
        const now = new Date().toISOString();
        docNote = {
          id: crypto.randomUUID(),
          title: `Decisions — ${new Date().toLocaleDateString()}`,
          content: docContent,
          createdAt: now,
          updatedAt: now,
        };
        setNotes((prev) => {
          const next = [docNote!, ...prev];
          localStorage.setItem('pnx_planning_notes', JSON.stringify(next));
          return next;
        });
        setActiveId(docNote.id);
        // Update editor content
        setTimeout(() => {
          editorRef.current?.commands.setContent(docContent, false);
        }, 50);
      }

      const contextNotes = isMulti ? decisionsSourceNotes : [notesRef.current.find((n) => n.id === decisionsNoteId)!].filter(Boolean);
      const text = await streamAgentText(prompt, contextNotes);
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      const candidate = fenced ? fenced[1] : text;
      const jsonMatch = candidate.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Could not parse issues from AI response.');
      const parsed = JSON.parse(jsonMatch[0]);
      const issues: GeneratedIssue[] = parsed.issues ?? [];
      setGeneratedIssues(issues);
      if (issues.length > 0) {
        setChatMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `Generated ${issues.length} issue(s) from decisions:\n${issues.map((i) => `**${i.title}**`).join('\n')}`,
            ts: Date.now(),
          },
        ]);
      }
    } catch (err: any) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error generating issues: ${err.message}`, ts: Date.now() },
      ]);
    } finally {
      setStreaming(false);
    }
  }

  // ── Filtered note list ──────────────────────────────────────────────────────

  const filteredNotes = searchQuery.trim()
    ? notes.filter((n) => {
        const q = searchQuery.toLowerCase();
        return (
          n.title.toLowerCase().includes(q) ||
          stripHtml(n.content).toLowerCase().includes(q)
        );
      })
    : notes;

  // ── Toolbar command helpers ─────────────────────────────────────────────────

  function cmd(action: () => void) {
    return (e: MouseEvent) => {
      e.preventDefault();
      action();
    };
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        background: '#f7f8fa',
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {/* ── Top bar ── */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          flexShrink: 0,
          background: '#fff',
          borderBottom: '1px solid rgba(195,198,214,0.2)',
          height: 52,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => { planningPanelOpenSignal.value = false; }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 500,
              color: '#6b7280',
              padding: 0,
            }}
          >
            <span class="material-symbols-outlined" style={{ fontSize: 15 }}>arrow_back</span>
            Board
          </button>
          <span style={{ fontSize: 11, color: 'rgba(195,198,214,0.7)', userSelect: 'none' }}>|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 8,
                background: '#003d9b',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 14, color: '#fff' }}>edit_note</span>
            </div>
            <h1 style={{ fontSize: 13, fontWeight: 700, color: '#191c1e', margin: 0 }}>Planning</h1>
          </div>
          {state.repoFullName && (
            <>
              <span style={{ fontSize: 11, color: 'rgba(195,198,214,0.6)', userSelect: 'none' }}>|</span>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '3px 9px',
                  borderRadius: 999,
                  background: 'rgba(0,61,155,0.07)',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#003d9b',
                  maxWidth: 220,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                }}
                title={state.repoFullName}
              >
                <span class="material-symbols-outlined" style={{ fontSize: 13, flexShrink: 0 }}>commit</span>
                {state.repoFullName}
              </div>
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {selectedIds.size > 1 && (
            <button
              title={`Create GitHub issues from ${selectedIds.size} selected notes`}
              onClick={analyzeSelectedNotesForDecisions}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 12,
                fontWeight: 700,
                padding: '6px 14px',
                borderRadius: 999,
                border: '2px solid #003d9b',
                background: '#fff',
                color: '#003d9b',
                cursor: 'pointer',
              }}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 14 }}>add_task</span>
              Create Issue ({selectedIds.size})
            </button>
          )}
          <button
            title="New note"
            onClick={createNote}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              fontWeight: 600,
              padding: '6px 16px',
              borderRadius: 999,
              background: '#003d9b',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <span class="material-symbols-outlined" style={{ fontSize: 14 }}>add</span>
            New Note
          </button>
        </div>
      </header>

      {/* ── Body ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

      {/* ── Left Sidebar ────────────────────────────────────────────────────── */}
      <div
        style={{
          width: 240,
          flexShrink: 0,
          borderRight: '1px solid #e5e7eb',
          background: '#fff',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >

        {/* Search */}
        <div style={{ padding: '8px 10px', borderBottom: '1px solid #f0f0f0' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: '#f4f5f7',
              borderRadius: 7,
              padding: '5px 8px',
            }}
          >
            <span class="material-symbols-outlined" style={{ fontSize: 16, color: '#aaa' }}>search</span>
            <input
              type="text"
              placeholder="Search notes…"
              value={searchQuery}
              onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
              style={{
                border: 'none',
                background: 'transparent',
                outline: 'none',
                fontSize: 13,
                flex: 1,
                color: '#333',
              }}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#aaa', display: 'flex' }}
              >
                <span class="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
              </button>
            )}
          </div>
        </div>

        {/* Bulk actions */}
        {selectedIds.size > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 6,
              padding: '6px 10px',
              borderBottom: '1px solid #f0f0f0',
              background: '#fffbf0',
            }}
          >
            <span style={{ fontSize: 11, color: '#7a6000', flex: 1, alignSelf: 'center' }}>
              {selectedIds.size} selected
            </span>
            <button
              title="Send selected to AI chat"
              onClick={() => { setChatCtx('selected'); }}
              style={{
                fontSize: 11,
                padding: '3px 7px',
                borderRadius: 5,
                border: '1px solid #d4a800',
                background: '#fff8e0',
                cursor: 'pointer',
                color: '#7a6000',
              }}
            >
              Chat
            </button>
            <button
              title="Delete selected"
              onClick={deleteSelected}
              style={{
                fontSize: 11,
                padding: '3px 7px',
                borderRadius: 5,
                border: '1px solid #fcc',
                background: '#fff5f5',
                cursor: 'pointer',
                color: '#ba1a1a',
              }}
            >
              Delete
            </button>
          </div>
        )}

        {/* Note list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filteredNotes.length === 0 && (
            <div style={{ padding: '24px 14px', color: '#aaa', fontSize: 13, textAlign: 'center' }}>
              {searchQuery ? 'No matching notes' : 'No notes yet'}
            </div>
          )}
          {filteredNotes.map((note) => {
            const isActive = note.id === activeId;
            const isSelected = selectedIds.has(note.id);
            const preview = stripHtml(note.content).slice(0, 80);
            const wc = wordCount(note.content);
            return (
              <div
                key={note.id}
                onClick={() => setActiveId(note.id)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 6,
                  padding: '9px 10px',
                  borderBottom: '1px solid #f4f4f4',
                  cursor: 'pointer',
                  background: isActive ? '#eef2ff' : isSelected ? '#fffbef' : 'transparent',
                  borderLeft: isActive ? '3px solid #003d9b' : '3px solid transparent',
                  transition: 'background 0.1s',
                }}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation();
                    setSelectedIds((prev) => {
                      const s = new Set(prev);
                      if ((e.target as HTMLInputElement).checked) s.add(note.id);
                      else s.delete(note.id);
                      return s;
                    });
                  }}
                  style={{ marginTop: 2, flexShrink: 0 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      color: isActive ? '#003d9b' : '#1a1b2e',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {note.title || 'Untitled'}
                  </div>
                  {preview && (
                    <div
                      style={{
                        fontSize: 11,
                        color: '#888',
                        marginTop: 2,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {preview}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, marginTop: 3 }}>
                    <span style={{ fontSize: 10, color: '#bbb' }}>{relativeTime(note.updatedAt)}</span>
                    <span style={{ fontSize: 10, color: '#bbb' }}>{wc}w</span>
                  </div>
                </div>
                <button
                  title="Decisions & issues for this note"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (decisionsNoteId === note.id) {
                      setDecisionsNoteId(null);
                    } else {
                      analyzeForDecisions(note.id);
                    }
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 2,
                    color: decisionsNoteId === note.id ? '#003d9b' : '#ccc',
                    flexShrink: 0,
                    opacity: decisionsNoteId === note.id ? 1 : 0,
                    transition: 'opacity 0.1s',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; (e.currentTarget as HTMLElement).style.color = '#003d9b'; }}
                  onMouseLeave={(e) => {
                    if (decisionsNoteId !== note.id) {
                      (e.currentTarget as HTMLElement).style.opacity = '0';
                      (e.currentTarget as HTMLElement).style.color = '#ccc';
                    }
                  }}
                >
                  <span class="material-symbols-outlined" style={{ fontSize: 14 }}>psychology</span>
                </button>
                <button
                  title="Delete note"
                  onClick={(e) => { e.stopPropagation(); deleteNote(note.id); }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 2,
                    color: '#ccc',
                    flexShrink: 0,
                    opacity: 0,
                    transition: 'opacity 0.1s',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; (e.currentTarget as HTMLElement).style.color = '#ba1a1a'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0'; (e.currentTarget as HTMLElement).style.color = '#ccc'; }}
                >
                  <span class="material-symbols-outlined" style={{ fontSize: 14 }}>delete</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Center: Editor ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {/* Note title input */}
        {activeId && (
          <div style={{ padding: '10px 24px 0 24px', borderBottom: '1px solid #f0f0f0', background: '#fff', display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="text"
              placeholder="Note title…"
              value={notes.find((n) => n.id === activeId)?.title ?? ''}
              onInput={(e) => {
                if (activeId) updateNoteTitle(activeId, (e.target as HTMLInputElement).value);
              }}
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                fontSize: 20,
                fontWeight: 700,
                color: '#1a1b2e',
                background: 'transparent',
                padding: '6px 0',
              }}
            />
            {/* Create Issue — primary entry point */}
            <button
              title="Capture assumptions & edge cases, then create a GitHub issue"
              onClick={() => {
                if (decisionsNoteId === activeId) {
                  setDecisionsNoteId(null);
                } else {
                  analyzeForDecisions(activeId);
                }
              }}
              style={{
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 12,
                fontWeight: 700,
                padding: '6px 14px',
                borderRadius: 999,
                border: 'none',
                background: decisionsNoteId === activeId ? '#003d9b' : '#003d9b',
                color: '#fff',
                cursor: 'pointer',
                marginBottom: 6,
                boxShadow: decisionsNoteId === activeId ? 'none' : '0 1px 4px rgba(0,61,155,0.18)',
                opacity: decisionsNoteId === activeId ? 0.75 : 1,
              }}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 14 }}>add_task</span>
              Create Issue
            </button>
          </div>
        )}

        {/* Toolbar */}
        {toolbarVisible && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              padding: '5px 16px',
              borderBottom: '1px solid #eee',
              background: '#fff',
              flexWrap: 'wrap',
            }}
          >
            {/* Bold */}
            <button
              title="Bold (Ctrl+B)"
              onMouseDown={cmd(() => editorRef.current?.chain().focus().toggleBold().run())}
              style={toolbarBtnStyle(editorRef.current?.isActive('bold'))}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 16 }}>format_bold</span>
            </button>

            {/* Italic */}
            <button
              title="Italic (Ctrl+I)"
              onMouseDown={cmd(() => editorRef.current?.chain().focus().toggleItalic().run())}
              style={toolbarBtnStyle(editorRef.current?.isActive('italic'))}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 16 }}>format_italic</span>
            </button>

            {/* Underline */}
            <button
              title="Underline (Ctrl+U)"
              onMouseDown={cmd(() => editorRef.current?.chain().focus().toggleUnderline().run())}
              style={toolbarBtnStyle(editorRef.current?.isActive('underline'))}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 16 }}>format_underlined</span>
            </button>

            <div style={{ width: 1, height: 18, background: '#e5e7eb', margin: '0 4px' }} />

            {/* H1 */}
            <button
              title="Heading 1"
              onMouseDown={cmd(() => editorRef.current?.chain().focus().toggleHeading({ level: 1 }).run())}
              style={toolbarBtnStyle(editorRef.current?.isActive('heading', { level: 1 }))}
            >
              <span style={{ fontSize: 12, fontWeight: 700 }}>H1</span>
            </button>

            {/* H2 */}
            <button
              title="Heading 2"
              onMouseDown={cmd(() => editorRef.current?.chain().focus().toggleHeading({ level: 2 }).run())}
              style={toolbarBtnStyle(editorRef.current?.isActive('heading', { level: 2 }))}
            >
              <span style={{ fontSize: 12, fontWeight: 700 }}>H2</span>
            </button>

            {/* H3 */}
            <button
              title="Heading 3"
              onMouseDown={cmd(() => editorRef.current?.chain().focus().toggleHeading({ level: 3 }).run())}
              style={toolbarBtnStyle(editorRef.current?.isActive('heading', { level: 3 }))}
            >
              <span style={{ fontSize: 12, fontWeight: 700 }}>H3</span>
            </button>

            <div style={{ width: 1, height: 18, background: '#e5e7eb', margin: '0 4px' }} />

            {/* Bullet list */}
            <button
              title="Bullet list"
              onMouseDown={cmd(() => editorRef.current?.chain().focus().toggleBulletList().run())}
              style={toolbarBtnStyle(editorRef.current?.isActive('bulletList'))}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 16 }}>format_list_bulleted</span>
            </button>

            {/* Task list */}
            <button
              title="Task list"
              onMouseDown={cmd(() => editorRef.current?.chain().focus().toggleTaskList().run())}
              style={toolbarBtnStyle(editorRef.current?.isActive('taskList'))}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 16 }}>checklist</span>
            </button>

            {/* Ordered list */}
            <button
              title="Ordered list"
              onMouseDown={cmd(() => editorRef.current?.chain().focus().toggleOrderedList().run())}
              style={toolbarBtnStyle(editorRef.current?.isActive('orderedList'))}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 16 }}>format_list_numbered</span>
            </button>

            {/* Code block */}
            <button
              title="Code block"
              onMouseDown={cmd(() => editorRef.current?.chain().focus().toggleCodeBlock().run())}
              style={toolbarBtnStyle(editorRef.current?.isActive('codeBlock'))}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 16 }}>code</span>
            </button>

            {/* Blockquote */}
            <button
              title="Blockquote"
              onMouseDown={cmd(() => editorRef.current?.chain().focus().toggleBlockquote().run())}
              style={toolbarBtnStyle(editorRef.current?.isActive('blockquote'))}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 16 }}>format_quote</span>
            </button>

            <div style={{ width: 1, height: 18, background: '#e5e7eb', margin: '0 4px' }} />

            {/* Highlight */}
            <button
              title="Highlight"
              onMouseDown={cmd(() => editorRef.current?.chain().focus().toggleHighlight().run())}
              style={toolbarBtnStyle(editorRef.current?.isActive('highlight'))}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 16 }}>highlight</span>
            </button>

            <div style={{ width: 1, height: 18, background: '#e5e7eb', margin: '0 4px' }} />

            {/* Insert diagram */}
            <div style={{ position: 'relative' }}>
              <button
                title="Insert diagram"
                onMouseDown={(e) => { e.preventDefault(); setInsertDiagramSelectOpen((v) => !v); }}
                style={toolbarBtnStyle(false)}
              >
                <span class="material-symbols-outlined" style={{ fontSize: 16 }}>account_tree</span>
                <span style={{ fontSize: 11, marginLeft: 3 }}>Diagram</span>
              </button>
              {insertDiagramSelectOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    zIndex: 10,
                    background: '#fff',
                    border: '1px solid #ddd',
                    borderRadius: 7,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
                    minWidth: 140,
                    padding: 4,
                  }}
                >
                  {Object.keys(DIAGRAM_TEMPLATES).map((t) => (
                    <button
                      key={t}
                      onMouseDown={(e) => { e.preventDefault(); handleInsertDiagram(t); }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        background: 'none',
                        border: 'none',
                        padding: '6px 10px',
                        fontSize: 13,
                        cursor: 'pointer',
                        borderRadius: 5,
                        color: '#333',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#f0f3ff'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ flex: 1 }} />

            {/* Toggle toolbar */}
            <button
              title="Hide toolbar"
              onClick={() => setToolbarVisible(false)}
              style={toolbarBtnStyle(false)}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 14 }}>expand_less</span>
            </button>
          </div>
        )}

        {!toolbarVisible && (
          <div style={{ padding: '2px 16px', background: '#fff', borderBottom: '1px solid #eee' }}>
            <button
              title="Show toolbar"
              onClick={() => setToolbarVisible(true)}
              style={{ ...toolbarBtnStyle(false), fontSize: 11, color: '#888' }}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 13 }}>expand_more</span>
              Toolbar
            </button>
          </div>
        )}

        {/* Click outside diagram select */}
        {insertDiagramSelectOpen && (
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9 }}
            onClick={() => setInsertDiagramSelectOpen(false)}
          />
        )}

        {/* Editor area */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '24px 32px',
            background: '#fff',
          }}
        >
          {!activeId && (
            <div style={{ color: '#bbb', fontSize: 14, textAlign: 'center', marginTop: 48 }}>
              Select or create a note to start writing.
            </div>
          )}
          <div
            ref={editorDomRef}
            style={{
              minHeight: 320,
              outline: 'none',
              fontSize: 15,
              lineHeight: 1.7,
              color: '#1a1b2e',
              display: activeId ? 'block' : 'none',
            }}
          />
        </div>

        {/* Word count footer */}
        <div
          style={{
            padding: '5px 32px',
            borderTop: '1px solid #f0f0f0',
            background: '#fff',
            fontSize: 11,
            color: '#aaa',
            display: 'flex',
            gap: 12,
          }}
        >
          {activeId && (
            <>
              <span>{wordCount(notes.find((n) => n.id === activeId)?.content ?? '')} words</span>
              <span>Last saved {relativeTime(notes.find((n) => n.id === activeId)?.updatedAt ?? new Date().toISOString())}</span>
            </>
          )}
        </div>
      </div>

      {/* ── Decisions / ADR Panel ───────────────────────────────────────────── */}
      {decisionsNoteId && (
        <div
          style={{
            width: 320,
            flexShrink: 0,
            borderLeft: '1px solid #e5e7eb',
            background: '#f8f9fb',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '13px 12px 10px',
              borderBottom: '1px solid #f0f0f0',
              background: '#fff',
            }}
          >
            <span class="material-symbols-outlined" style={{ fontSize: 15, color: '#003d9b' }}>add_task</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#1a1b2e', lineHeight: 1.2 }}>Create Issue</div>
              <div style={{ fontSize: 10, color: '#888', lineHeight: 1.2 }}>
                {decisionsNoteId === '__multi__'
                  ? `${decisionsSourceNotes.length} notes`
                  : 'Assumptions & edge cases'}
              </div>
            </div>
            {decisionsPhase !== 'loading' && (
              <button
                title="Re-analyse"
                onClick={() => {
                  if (decisionsNoteId === '__multi__') {
                    _runDecisionsAnalysis(decisionsSourceNotes);
                  } else if (decisionsNoteId) {
                    setNotes((prev) => {
                      const next = prev.map((n) => n.id === decisionsNoteId ? { ...n, decisions: undefined } : n);
                      localStorage.setItem('pnx_planning_notes', JSON.stringify(next));
                      return next;
                    });
                    analyzeForDecisions(decisionsNoteId);
                  }
                }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 3, color: '#aaa' }}
              >
                <span class="material-symbols-outlined" style={{ fontSize: 15 }}>refresh</span>
              </button>
            )}
            <button
              title="Close"
              onClick={() => setDecisionsNoteId(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 3, color: '#aaa' }}
            >
              <span class="material-symbols-outlined" style={{ fontSize: 17 }}>close</span>
            </button>
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 8px' }}>
            {decisionsPhase === 'loading' && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 0', gap: 10 }}>
                <span class="material-symbols-outlined" style={{ fontSize: 28, color: '#003d9b', animation: 'spin 1s linear infinite' }}>autorenew</span>
                <p style={{ fontSize: 12, color: '#888', margin: 0 }}>Finding assumptions &amp; edge cases…</p>
              </div>
            )}

            {decisionsPhase === 'error' && (
              <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#ba1a1a' }}>
                {decisionsError}
              </div>
            )}

            {decisionsPhase === 'questions' && decisionsQuestions.map((q, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: '#1a1b2e', marginBottom: 5, lineHeight: 1.4 }}>{q}</label>
                <textarea
                  rows={2}
                  placeholder="Your decision…"
                  value={decisionsAnswers[i] ?? ''}
                  onInput={(e) => {
                    const val = (e.target as HTMLTextAreaElement).value;
                    setDecisionsAnswers((prev) => {
                      const next = [...prev];
                      next[i] = val;
                      return next;
                    });
                  }}
                  style={{
                    width: '100%',
                    fontSize: 12,
                    padding: '7px 10px',
                    borderRadius: 8,
                    border: '1.5px solid rgba(195,198,214,0.5)',
                    background: '#fff',
                    color: '#1a1b2e',
                    resize: 'none',
                    outline: 'none',
                    fontFamily: 'Inter, sans-serif',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            ))}

            {decisionsPhase === 'questions' && (
              <p style={{ fontSize: 10.5, color: '#b0b3c0', lineHeight: 1.5, marginTop: 4 }}>
                Answer the assumptions above, then click <strong>Create Issue</strong> to generate a structured GitHub issue.
              </p>
            )}
          </div>

          {/* Footer */}
          {decisionsPhase === 'questions' && (
            <div
              style={{
                padding: '10px 14px',
                borderTop: '1px solid #f0f0f0',
                background: '#fff',
                display: 'flex',
                gap: 8,
                justifyContent: 'flex-end',
              }}
            >
              {decisionsNoteId !== '__multi__' && (
                <button
                  onClick={saveDecisions}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '5px 10px',
                    borderRadius: 6,
                    border: '1px solid #d0d5e8',
                    background: '#fff',
                    color: '#5f6376',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <span class="material-symbols-outlined" style={{ fontSize: 12 }}>save</span>
                  Save ADR
                </button>
              )}
              <button
                onClick={createIssuesFromDecisions}
                disabled={streaming}
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '5px 12px',
                  borderRadius: 6,
                  border: 'none',
                  background: streaming ? '#aab5d0' : '#003d9b',
                  color: '#fff',
                  cursor: streaming ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  opacity: streaming ? 0.7 : 1,
                }}
              >
                <span class="material-symbols-outlined" style={{ fontSize: 12 }}>add_task</span>
                {streaming ? 'Generating…' : 'Create Issue'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Right Sidebar: AI Chat ──────────────────────────────────────────── */}
      <div
        style={{
          width: 320,
          flexShrink: 0,
          borderLeft: '1px solid #e5e7eb',
          background: '#fff',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Chat header */}
        <div style={{ padding: '13px 12px 10px', borderBottom: '1px solid #f0f0f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <span class="material-symbols-outlined" style={{ fontSize: 17, color: '#5f6376' }}>smart_toy</span>
            <span style={{ fontWeight: 700, fontSize: 14, flex: 1, color: '#1a1b2e' }}>AI Chat</span>
          </div>
          {/* Context selector */}
          <div style={{ display: 'flex', gap: 4 }}>
            {(['all', 'selected', 'active'] as const).map((ctx) => (
              <button
                key={ctx}
                onClick={() => setChatCtx(ctx)}
                style={{
                  flex: 1,
                  padding: '3px 0',
                  borderRadius: 5,
                  border: '1px solid',
                  borderColor: chatCtx === ctx ? '#003d9b' : '#e0e0e0',
                  background: chatCtx === ctx ? '#eef2ff' : '#fff',
                  color: chatCtx === ctx ? '#003d9b' : '#666',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontWeight: chatCtx === ctx ? 600 : 400,
                }}
              >
                {ctx === 'all' ? 'All Notes' : ctx === 'selected' ? 'Selected' : 'Active'}
              </button>
            ))}
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 0' }}>
          {chatMessages.length === 0 && (
            <div style={{ color: '#bbb', fontSize: 13, textAlign: 'center', marginTop: 32 }}>
              Ask anything about your notes…
            </div>
          )}
          {chatMessages.map((msg, i) => (
            <div
              key={i}
              style={{
                marginBottom: 10,
                display: 'flex',
                flexDirection: 'column',
                alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              <div
                style={{
                  maxWidth: '90%',
                  padding: '8px 11px',
                  borderRadius: msg.role === 'user' ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
                  background: msg.role === 'user' ? '#003d9b' : '#f4f5f7',
                  color: msg.role === 'user' ? '#fff' : '#1a1b2e',
                  fontSize: 13,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {msg.content || (streaming && i === chatMessages.length - 1 ? '…' : '')}
              </div>
            </div>
          ))}

          {/* Generated issues cards */}
          {generatedIssues.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {generatedIssues.map((issue, i) => (
                <div
                  key={i}
                  style={{
                    border: `1px solid ${issue.githubNumber ? '#bbf7d0' : '#e5e7eb'}`,
                    borderRadius: 8,
                    padding: '8px 10px',
                    marginBottom: 6,
                    background: issue.githubNumber ? '#f0fdf4' : '#fafbff',
                  }}
                >
                  {/* Status badges */}
                  <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                    {issue.githubNumber && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#d1fae5', color: '#065f46' }}>
                        #{issue.githubNumber} on GitHub
                      </span>
                    )}
                    {issue.localBoardId && !issue.githubNumber && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#fef3c7', color: '#b45309' }}>
                        On board (draft)
                      </span>
                    )}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 12, color: '#1a1b2e', marginBottom: 4 }}>
                    {issue.title}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: '#666',
                      marginBottom: 7,
                      whiteSpace: 'pre-wrap',
                      maxHeight: 48,
                      overflow: 'hidden',
                    }}
                  >
                    {issue.body}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <button
                      onClick={() => openViewModal(issue)}
                      style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid #d0d5e8', background: '#fff', color: '#5f6376', cursor: 'pointer', fontWeight: 600 }}
                    >
                      View
                    </button>
                    {!issue.localBoardId && !issue.githubNumber && (
                      <button
                        onClick={() => addIssueToBoard(issue, i)}
                        style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid #d97706', background: '#fffbeb', color: '#b45309', cursor: 'pointer', fontWeight: 600 }}
                      >
                        Add to Board
                      </button>
                    )}
                    {!issue.githubNumber && (
                      <button
                        onClick={() => pushIssueToGitHub(issue, i)}
                        style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid #003d9b', background: '#fff', color: '#003d9b', cursor: 'pointer', fontWeight: 600 }}
                      >
                        Create on GitHub
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Chat input */}
        <div style={{ padding: '8px 10px', borderTop: '1px solid #f0f0f0', display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea
            value={chatInput}
            onInput={(e) => setChatInput((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChat();
              }
            }}
            placeholder="Message…"
            rows={2}
            style={{
              flex: 1,
              border: '1px solid #e0e0e0',
              borderRadius: 8,
              padding: '7px 9px',
              fontSize: 13,
              resize: 'none',
              outline: 'none',
              fontFamily: 'inherit',
              lineHeight: 1.4,
            }}
          />
          <button
            onClick={sendChat}
            disabled={streaming || !chatInput.trim()}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: 'none',
              background: streaming || !chatInput.trim() ? '#e0e0e0' : '#003d9b',
              color: streaming || !chatInput.trim() ? '#aaa' : '#fff',
              cursor: streaming || !chatInput.trim() ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <span class="material-symbols-outlined" style={{ fontSize: 18 }}>send</span>
          </button>
        </div>
      </div>

      {/* ── Diagram Modal ───────────────────────────────────────────────────── */}
      <DiagramModal
        open={diagramModalOpen}
        source={diagramModalSource}
        onSourceChange={setDiagramModalSource}
        onSave={handleDiagramSave}
        onCancel={() => { setDiagramModalOpen(false); setDiagramModalOnSave(null); }}
        selectedTemplate={selectedDiagramTemplate}
        onSelectTemplate={setSelectedDiagramTemplate}
      />

      {/* ── View Full Issue Modal ────────────────────────────────────────────── */}
      {viewFullIssue && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget) setViewFullIssue(null); }}
        >
          <div style={{ background: '#fff', borderRadius: 12, width: 680, maxWidth: '96vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '14px 20px 10px', borderBottom: '1px solid #eee' }}>
              <div style={{ flex: 1 }}>
                {viewFullIssue.githubNumber && (
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#d1fae5', color: '#065f46', marginBottom: 6, display: 'inline-block' }}>
                    #{viewFullIssue.githubNumber} on GitHub
                  </span>
                )}
                <input
                  value={viewEditTitle}
                  onInput={(e) => setViewEditTitle((e.target as HTMLInputElement).value)}
                  onBlur={commitViewEdits}
                  placeholder="Issue title…"
                  style={{
                    width: '100%',
                    fontSize: 16,
                    fontWeight: 700,
                    color: '#1a1b2e',
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    padding: '4px 0',
                    borderBottom: '2px solid transparent',
                    transition: 'border-color 0.15s',
                    boxSizing: 'border-box',
                  }}
                  onFocus={(e) => { (e.target as HTMLInputElement).style.borderBottomColor = '#003d9b'; }}
                  onBlurCapture={(e) => { (e.target as HTMLInputElement).style.borderBottomColor = 'transparent'; }}
                />
              </div>
              <button onClick={() => { commitViewEdits(); setViewFullIssue(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#888', flexShrink: 0 }}>
                <span class="material-symbols-outlined" style={{ fontSize: 20 }}>close</span>
              </button>
            </div>
            {/* Editable body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0' }}>
              <textarea
                value={viewEditBody}
                onInput={(e) => setViewEditBody((e.target as HTMLTextAreaElement).value)}
                onBlur={commitViewEdits}
                placeholder="Describe the issue…"
                style={{
                  width: '100%',
                  height: '100%',
                  minHeight: 200,
                  padding: '20px',
                  fontSize: 14,
                  color: '#374151',
                  lineHeight: 1.7,
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  background: 'transparent',
                  fontFamily: 'Inter, sans-serif',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            {/* Footer */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '12px 20px', borderTop: '1px solid #eee' }}>
              {!viewFullIssue.localBoardId && !viewFullIssue.githubNumber && (
                <button
                  onClick={() => {
                    commitViewEdits();
                    const idx = generatedIssues.indexOf(viewFullIssue);
                    if (idx !== -1) addIssueToBoard({ ...viewFullIssue, title: viewEditTitle, body: viewEditBody }, idx);
                  }}
                  style={{ fontSize: 12, padding: '6px 14px', borderRadius: 7, border: '1px solid #d97706', background: '#fffbeb', color: '#b45309', cursor: 'pointer', fontWeight: 600 }}
                >
                  Add to Board
                </button>
              )}
              {!viewFullIssue.githubNumber && (
                <button
                  onClick={() => {
                    const latest = { ...viewFullIssue, title: viewEditTitle, body: viewEditBody };
                    const idx = generatedIssues.indexOf(viewFullIssue);
                    if (idx !== -1) pushIssueToGitHub(latest, idx);
                    setViewFullIssue(null);
                  }}
                  style={{ fontSize: 12, padding: '6px 14px', borderRadius: 7, border: 'none', background: '#003d9b', color: '#fff', cursor: 'pointer', fontWeight: 700 }}
                >
                  Create on GitHub
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      </div>{/* ── /Body ── */}
    </div>
  );
}

// ── Toolbar button style helper ───────────────────────────────────────────────

function toolbarBtnStyle(active: boolean | undefined): Record<string, string | number> {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '4px 6px',
    borderRadius: 5,
    border: 'none',
    background: active ? '#eef2ff' : 'transparent',
    color: active ? '#003d9b' : '#444',
    cursor: 'pointer',
    fontWeight: active ? 700 : 400,
    transition: 'background 0.1s',
  };
}
