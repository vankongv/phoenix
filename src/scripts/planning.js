/**
 * Planning panel — NotebookLM-style notes with Tiptap rich text editor + AI chat.
 * Notes are persisted in localStorage under 'pnx_planning_notes'.
 * Content is stored as HTML (from Tiptap).
 */

import { Editor, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Highlight from '@tiptap/extension-highlight';
import Typography from '@tiptap/extension-typography';
import mermaid from 'mermaid';

import { createIssue } from '../lib/github-api.js';
import { getAgents, getGlobalAiKey } from '../lib/agents.js';
import { AGENT_BASE_URL } from '../lib/config.js';
import { state } from './state.js';
const STORAGE_KEY = 'pnx_planning_notes';

/** Pick an API key: per-agent override first, then global Settings → AI key. */
function _getApiKey() {
  const agents = getAgents();
  const perAgent = agents.find((a) => a.provider === 'claude' && a.apiKey)?.apiKey;
  return perAgent || getGlobalAiKey();
}

// ── Mermaid init ──────────────────────────────────────────────────────────────

mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  fontFamily: 'Inter, sans-serif',
  flowchart: { curve: 'basis', useMaxWidth: true },
  securityLevel: 'loose',
});

let _mermaidCounter = 0;

const DIAGRAM_TEMPLATES = {
  flowchart: `flowchart LR
    Start([Start]) --> Process[Do something]
    Process --> Decision{Condition?}
    Decision -- Yes --> Result([Done])
    Decision -- No  --> Process`,

  sequence: `sequenceDiagram
    actor User
    User->>Server: Request
    Server->>DB: Query
    DB-->>Server: Data
    Server-->>User: Response`,

  er: `erDiagram
    USER {
        int id PK
        string name
        string email
    }
    ORDER {
        int id PK
        int userId FK
        float total
    }
    USER ||--o{ ORDER : places`,

  mindmap: `mindmap
  root((Project))
    Goals
      Feature A
      Feature B
    Risks
      Technical
      Timeline
    Team
      Frontend
      Backend`,

  gantt: `gantt
    title Project Timeline
    dateFormat YYYY-MM-DD
    section Phase 1
    Research       :a1, 2025-01-01, 7d
    Design         :a2, after a1, 5d
    section Phase 2
    Development    :a3, after a2, 14d
    Testing        :a4, after a3, 7d`,
};

// ── Tiptap MermaidBlock Node ──────────────────────────────────────────────────
// atom=true: Tiptap treats it as a single opaque unit — its DOM is
// fully owned by the node view and never touched by ProseMirror's reconciler.

const MermaidBlock = Node.create({
  name: 'mermaidBlock',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      source: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-source') ?? '',
        renderHTML: (attrs) => ({ 'data-source': attrs.source }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-mermaid-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-mermaid-block': '' }, HTMLAttributes)];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      // Build DOM
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

      // Render helper
      const render = async (source) => {
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
        } catch (e) {
          svgWrap.innerHTML = `<p style="color:#ba1a1a;font-size:11px;padding:12px">${_esc(e.message)}</p>`;
        }
      };

      render(node.attrs.source);

      copyBtn.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        await navigator.clipboard.writeText(node.attrs.source).catch(() => {});
        copyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:13px;vertical-align:middle">check</span>`;
        setTimeout(() => {
          copyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:13px;vertical-align:middle">content_copy</span>`;
        }, 1500);
      });

      editBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        _openDiagramModal(node.attrs.source, (newSource) => {
          if (typeof getPos !== 'function') return;
          editor
            .chain()
            .focus()
            .command(({ tr }) => {
              tr.setNodeMarkup(getPos(), undefined, { source: newSource });
              return true;
            })
            .run();
        });
      });

      delBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (typeof getPos !== 'function') return;
        const pos = getPos();
        editor
          .chain()
          .focus()
          .command(({ tr, state: s }) => {
            const node2 = s.doc.nodeAt(pos);
            if (node2) tr.delete(pos, pos + node2.nodeSize);
            return true;
          })
          .run();
      });

      return {
        dom,
        update(updatedNode) {
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

// ── State ─────────────────────────────────────────────────────────────────────

let _notes = [];
let _activeId = null;
const _selectedIds = new Set();
let _chatCtx = 'all';
let _saveTimer = null;
let _searchQuery = '';
let _streaming = false;

/** Issues generated by AI, pending user review. */
let _generatedIssues = [];

/** Notes used as source for the current issue-generation session. */
let _issueSourceNotes = [];

/** @type {Editor|null} */
let _editor = null;

// ── Persistence ───────────────────────────────────────────────────────────────

function _loadNotes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _notes = raw ? JSON.parse(raw) : [];
  } catch {
    _notes = [];
  }
}

function _saveNotes() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(_notes));
}

function _uuid() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ── Note CRUD ─────────────────────────────────────────────────────────────────

function _createNote() {
  const now = new Date().toISOString();
  const note = { id: _uuid(), title: '', content: '', createdAt: now, updatedAt: now };
  _notes.unshift(note);
  _saveNotes();
  return note;
}

function _deleteNote(id) {
  _notes = _notes.filter((n) => n.id !== id);
  _selectedIds.delete(id);
  _saveNotes();
}

function _updateNote(id, patch) {
  const n = _notes.find((n) => n.id === id);
  if (!n) return;
  Object.assign(n, patch, { updatedAt: new Date().toISOString() });
  _saveNotes();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip HTML tags for plain-text word count / AI context */
function _stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || '';
}

function _wordCount(htmlOrText) {
  return _stripHtml(htmlOrText).trim().split(/\s+/).filter(Boolean).length;
}

// ── Note list rendering ───────────────────────────────────────────────────────

function _renderNoteList() {
  const list = document.getElementById('planning-note-list');
  if (!list) return;

  const q = _searchQuery.toLowerCase();
  const visible = q
    ? _notes.filter(
        (n) => n.title.toLowerCase().includes(q) || _stripHtml(n.content).toLowerCase().includes(q)
      )
    : _notes;

  if (visible.length === 0) {
    list.innerHTML = `<p class="text-[11px] text-center py-6" style="color:#a0a3b0">
      ${q ? 'No notes match your search.' : 'No notes yet.'}
    </p>`;
    return;
  }

  list.innerHTML = visible
    .map((n) => {
      const isActive = n.id === _activeId;
      const isSelected = _selectedIds.has(n.id);
      const preview =
        _stripHtml(n.content).replace(/\s+/g, ' ').trim().slice(0, 80) || 'Empty note';
      const title = n.title || 'Untitled note';
      const wc = _wordCount(n.content);
      return `
    <div class="planning-note-card${isActive ? ' active' : ''}" data-note-id="${n.id}">
      <div class="flex items-start justify-between gap-2 mb-1.5">
        <span class="note-card-title">${_esc(title)}</span>
        <input type="checkbox" class="note-select-cb w-3.5 h-3.5 flex-shrink-0 mt-0.5 cursor-pointer"
          style="accent-color:#003d9b"
          data-note-id="${n.id}" ${isSelected ? 'checked' : ''}
          onclick="event.stopPropagation()"/>
      </div>
      <div class="note-card-preview">${_esc(preview)}</div>
      <div class="flex items-center gap-2 mt-2">
        <span class="note-card-date">${_relativeTime(n.updatedAt)}</span>
        ${wc > 0 ? `<span class="note-card-words">${wc}w</span>` : ''}
      </div>
    </div>`;
    })
    .join('');

  list.querySelectorAll('.planning-note-card').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.noteId) _openNote(el.dataset.noteId);
    });
  });

  list.querySelectorAll('.note-select-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.noteId;
      if (cb.checked) _selectedIds.add(id);
      else _selectedIds.delete(id);
      _updateSelectionUI();
    });
  });
}

function _updateSelectionUI() {
  const count = _selectedIds.size;
  const total = _notes.length;
  const selCount = document.getElementById('planning-selected-count');
  if (selCount) selCount.textContent = count > 0 ? `${count} selected` : '';
  const allCb = document.getElementById('planning-select-all');
  if (allCb) {
    allCb.checked = count === total && total > 0;
    allCb.indeterminate = count > 0 && count < total;
  }
  const ctxCount = document.getElementById('planning-ctx-selected-count');
  if (ctxCount) ctxCount.textContent = count;
  const genBtn = document.getElementById('planning-generate-issues-btn');
  if (genBtn) {
    const label = count > 0 ? `Issues (${count})` : 'Issues';
    genBtn.querySelector('.gen-btn-label').textContent = label;
  }
}

// ── Editor show/hide ──────────────────────────────────────────────────────────

function _openNote(id) {
  _activeId = id;
  const note = _notes.find((n) => n.id === id);
  if (!note) return;
  _renderNoteList();
  _showEditor(note);
}

function _showEditor(note) {
  const empty = document.getElementById('planning-editor-empty');
  const editor = document.getElementById('planning-editor');
  if (!empty || !editor) return;
  empty.classList.add('hidden');
  editor.classList.remove('hidden');
  editor.classList.add('flex');

  const titleEl = document.getElementById('planning-note-title');
  if (titleEl) titleEl.value = note.title;

  // Load content into Tiptap without triggering the onUpdate save
  if (_editor) {
    _editor.off('update', _onEditorUpdate);
    _editor.commands.setContent(note.content || '', false);
    _editor.on('update', _onEditorUpdate);
  }

  _refreshMeta(note);
  _syncToolbarState();
}

function _hideEditor() {
  const empty = document.getElementById('planning-editor-empty');
  const editor = document.getElementById('planning-editor');
  if (empty) empty.classList.remove('hidden');
  if (editor) {
    editor.classList.add('hidden');
    editor.classList.remove('flex');
  }
}

function _refreshMeta(note) {
  const metaEl = document.getElementById('planning-note-meta');
  const wordEl = document.getElementById('planning-note-wordcount');
  if (metaEl)
    metaEl.textContent = `Created ${_relativeTime(note.createdAt)} · edited ${_relativeTime(note.updatedAt)}`;
  if (wordEl) wordEl.textContent = `${_wordCount(note.content)} words`;
}

// ── Auto-save ─────────────────────────────────────────────────────────────────

function _scheduleSave() {
  clearTimeout(_saveTimer);
  const status = document.getElementById('planning-save-status');
  if (status) status.textContent = 'Saving…';
  _saveTimer = setTimeout(_doSave, 700);
}

function _doSave() {
  if (!_activeId) return;
  const title = document.getElementById('planning-note-title')?.value ?? '';
  const content = _editor ? _editor.getHTML() : '';
  _updateNote(_activeId, { title, content });

  const wordEl = document.getElementById('planning-note-wordcount');
  if (wordEl) wordEl.textContent = `${_wordCount(content)} words`;

  const status = document.getElementById('planning-save-status');
  if (status) {
    status.textContent = 'Saved';
    setTimeout(() => {
      status.textContent = '';
    }, 1800);
  }

  _renderNoteList();
}

// ── Tiptap editor update handler ──────────────────────────────────────────────

function _onEditorUpdate() {
  _scheduleSave();
  _syncToolbarState();
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function _syncToolbarState() {
  if (!_editor) return;
  const cmds = [
    'bold',
    'italic',
    'underline',
    'strike',
    'highlight',
    'code',
    'bulletList',
    'orderedList',
    'taskList',
    'blockquote',
    'codeBlock',
  ];
  cmds.forEach((cmd) => {
    const btn = document.querySelector(`[data-cmd="${cmd}"]`);
    if (btn) btn.classList.toggle('active', _editor.isActive(cmd));
  });

  // Heading select
  const sel = document.getElementById('planning-tb-heading');
  if (sel) {
    if (_editor.isActive('heading', { level: 1 })) sel.value = '1';
    else if (_editor.isActive('heading', { level: 2 })) sel.value = '2';
    else if (_editor.isActive('heading', { level: 3 })) sel.value = '3';
    else sel.value = '0';
  }
}

function _bindToolbar() {
  // Toolbar buttons
  document.querySelectorAll('.tb-btn[data-cmd]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus in editor
      if (!_editor) return;
      const cmd = btn.dataset.cmd;
      switch (cmd) {
        case 'bold':
          _editor.chain().focus().toggleBold().run();
          break;
        case 'italic':
          _editor.chain().focus().toggleItalic().run();
          break;
        case 'underline':
          _editor.chain().focus().toggleUnderline().run();
          break;
        case 'strike':
          _editor.chain().focus().toggleStrike().run();
          break;
        case 'highlight':
          _editor.chain().focus().toggleHighlight().run();
          break;
        case 'code':
          _editor.chain().focus().toggleCode().run();
          break;
        case 'bulletList':
          _editor.chain().focus().toggleBulletList().run();
          break;
        case 'orderedList':
          _editor.chain().focus().toggleOrderedList().run();
          break;
        case 'taskList':
          _editor.chain().focus().toggleTaskList().run();
          break;
        case 'blockquote':
          _editor.chain().focus().toggleBlockquote().run();
          break;
        case 'codeBlock':
          _editor.chain().focus().toggleCodeBlock().run();
          break;
        case 'horizontalRule':
          _editor.chain().focus().setHorizontalRule().run();
          break;
        case 'undo':
          _editor.chain().focus().undo().run();
          break;
        case 'redo':
          _editor.chain().focus().redo().run();
          break;
      }
      _syncToolbarState();
    });
  });

  // Heading dropdown
  document.getElementById('planning-tb-heading')?.addEventListener('change', (e) => {
    if (!_editor) return;
    const level = parseInt(e.target.value, 10);
    if (level === 0) _editor.chain().focus().setParagraph().run();
    else _editor.chain().focus().toggleHeading({ level }).run();
    _syncToolbarState();
  });
}

// ── AI Chat ───────────────────────────────────────────────────────────────────

function _getContextNotes() {
  if (_chatCtx === 'all') return [..._notes];
  if (_chatCtx === 'current') return _notes.filter((n) => n.id === _activeId);
  if (_chatCtx === 'selected') return _notes.filter((n) => _selectedIds.has(n.id));
  return [..._notes];
}

function _appendUserBubble(text) {
  const msgs = document.getElementById('planning-chat-messages');
  if (!msgs) return;
  document.getElementById('planning-chat-welcome')?.remove();
  const div = document.createElement('div');
  div.className = 'chat-user-bubble';
  div.innerHTML = `<div class="bubble">${_esc(text)}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function _appendThinking() {
  const msgs = document.getElementById('planning-chat-messages');
  if (!msgs) return;
  const div = document.createElement('div');
  div.id = 'planning-thinking';
  div.className = 'chat-ai-bubble';
  div.innerHTML = `
    <div class="avatar">
      <span class="material-symbols-outlined" style="font-size:12px;color:#fff">auto_awesome</span>
    </div>
    <div class="chat-thinking">
      <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span>Thinking…</span>
    </div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function _appendAiBubble() {
  const msgs = document.getElementById('planning-chat-messages');
  if (!msgs) return null;
  document.getElementById('planning-thinking')?.remove();
  const div = document.createElement('div');
  div.className = 'chat-ai-bubble';
  div.innerHTML = `
    <div class="avatar">
      <span class="material-symbols-outlined" style="font-size:12px;color:#fff">auto_awesome</span>
    </div>
    <div class="bubble" id="planning-streaming-bubble"></div>`;
  msgs.appendChild(div);
  return document.getElementById('planning-streaming-bubble');
}

/** Convert AI-generated markdown to Tiptap-compatible HTML for note storage. */
function _markdownToNoteHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let listTag = '';

  const inlineFormat = (raw) =>
    raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const closeList = () => {
    if (listTag) { out.push(`</${listTag}>`); listTag = ''; }
  };

  for (const line of lines) {
    const f = inlineFormat(line);
    if (/^### /.test(line)) { closeList(); out.push(`<h3>${inlineFormat(line.slice(4))}</h3>`); }
    else if (/^## /.test(line)) { closeList(); out.push(`<h2>${inlineFormat(line.slice(3))}</h2>`); }
    else if (/^# /.test(line)) { closeList(); out.push(`<h1>${inlineFormat(line.slice(2))}</h1>`); }
    else if (/^[-*] /.test(line)) {
      if (listTag !== 'ul') { closeList(); out.push('<ul>'); listTag = 'ul'; }
      out.push(`<li><p>${inlineFormat(line.slice(2))}</p></li>`);
    } else if (/^\d+\. /.test(line)) {
      if (listTag !== 'ol') { closeList(); out.push('<ol>'); listTag = 'ol'; }
      out.push(`<li><p>${inlineFormat(line.replace(/^\d+\. /, ''))}</p></li>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${f}</p>`);
    }
  }
  closeList();
  return out.join('') || '<p></p>';
}

function _renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/((<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(.+)$/, '<p>$1</p>');
}

async function _sendQuestion(question) {
  if (_streaming || !question.trim()) return;

  const contextNotes = _getContextNotes();
  if (contextNotes.length === 0) {
    _appendUserBubble(question);
    const bubble = _appendAiBubble();
    if (bubble)
      bubble.innerHTML =
        '<p style="color:#ba1a1a">No notes in context. Select some or switch to "All notes".</p>';
    return;
  }

  _streaming = true;
  const sendBtn = document.getElementById('planning-chat-send');
  if (sendBtn) sendBtn.style.opacity = '0.5';

  _appendUserBubble(question);
  _appendThinking();

  let bubble = null;
  let fullText = '';

  try {
    const res = await fetch(`${AGENT_BASE_URL}/notes/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        notes: contextNotes.map((n) => ({
          id: n.id,
          title: n.title || 'Untitled',
          content: _stripHtml(n.content),
        })),
        llm_api_key: _getApiKey() || undefined,
      }),
    });

    if (!res.ok) throw new Error(`Agent server error: ${res.status}`);

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
            if (!bubble) bubble = _appendAiBubble();
            fullText += event.data.content;
            if (bubble) bubble.innerHTML = _renderMarkdown(fullText);
            const msgs = document.getElementById('planning-chat-messages');
            if (msgs) msgs.scrollTop = msgs.scrollHeight;
          } else if (event.type === 'update_note') {
            const { note_id, content } = event.data;
            const html = _markdownToNoteHtml(content);
            _updateNote(note_id, { content: html });
            if (_activeId === note_id && _editor) {
              _editor.off('update', _onEditorUpdate);
              _editor.commands.setContent(html, false);
              _editor.on('update', _onEditorUpdate);
              const n = _notes.find((n) => n.id === note_id);
              if (n) _refreshMeta(n);
            }
            _renderNoteList();
            const updatedNote = _notes.find((n) => n.id === note_id);
            const title = updatedNote?.title || 'Untitled';
            if (!bubble) bubble = _appendAiBubble();
            if (bubble)
              bubble.innerHTML +=
                `<div style="margin-top:8px;padding:6px 10px;background:#e8f5e9;border-radius:6px;font-size:12px;color:#2e7d32">✓ Updated note: <strong>${_esc(title)}</strong></div>`;
          } else if (event.type === 'error') {
            if (!bubble) bubble = _appendAiBubble();
            if (bubble)
              bubble.innerHTML = `<p style="color:#ba1a1a">Error: ${_esc(event.data.message)}</p>`;
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    document.getElementById('planning-thinking')?.remove();
    if (!bubble) bubble = _appendAiBubble();
    if (bubble)
      bubble.innerHTML = `<p style="color:#ba1a1a">Could not reach agent server. Is it running on port 8001?</p>`;
  } finally {
    _streaming = false;
    if (sendBtn) sendBtn.style.opacity = '1';
  }
}

// ── Diagram editor modal ──────────────────────────────────────────────────────

let _diagramInsertCallback = null; // called with final source when user saves
let _diagramPreviewTimer = null;

function _openDiagramModal(initialSource, onInsert) {
  const modal = document.getElementById('planning-diagram-modal');
  const srcEl = document.getElementById('planning-diagram-source');
  const errEl = document.getElementById('planning-diagram-error');
  const prevEl = document.getElementById('planning-diagram-preview');
  const insertBtn = document.getElementById('planning-diagram-insert');
  if (!modal || !srcEl) return;

  _diagramInsertCallback = onInsert ?? null;

  // Toggle label based on new vs edit mode
  const isEdit = !!onInsert;
  if (insertBtn) {
    insertBtn.innerHTML = isEdit
      ? `<span class="material-symbols-outlined" style="font-size:15px">check_circle</span> Update diagram`
      : `<span class="material-symbols-outlined" style="font-size:15px">add_circle</span> Insert into note`;
  }

  // Reset template button states
  document.querySelectorAll('.diagram-tpl-btn').forEach((b) => b.classList.remove('active'));

  // Guard against undefined/null/literal "undefined" source
  const safeSource =
    initialSource && initialSource !== 'undefined' ? initialSource : DIAGRAM_TEMPLATES.flowchart;

  srcEl.value = safeSource;
  if (errEl) errEl.textContent = '';
  if (prevEl) prevEl.innerHTML = '<p class="text-[12px]" style="color:#c3c6d6">Rendering…</p>';

  modal.classList.remove('hidden');
  modal.classList.add('flex');

  _debouncedDiagramPreview();
  setTimeout(() => srcEl.focus(), 50);
}

function _closeDiagramModal() {
  const modal = document.getElementById('planning-diagram-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  _diagramInsertCallback = null;
}

function _debouncedDiagramPreview() {
  clearTimeout(_diagramPreviewTimer);
  _diagramPreviewTimer = setTimeout(_renderDiagramPreview, 400);
}

async function _renderDiagramPreview() {
  const raw = document.getElementById('planning-diagram-source')?.value ?? '';
  const source = raw.trim();
  const prevEl = document.getElementById('planning-diagram-preview');
  const errEl = document.getElementById('planning-diagram-error');
  if (!source || source === 'undefined' || !prevEl) return;

  const id = `mermaid-preview-${++_mermaidCounter}`;
  try {
    const { svg } = await mermaid.render(id, source);
    prevEl.innerHTML = `<div style="max-width:100%">${svg}</div>`;
    if (errEl) errEl.textContent = '';
  } catch (err) {
    if (errEl) errEl.textContent = `Syntax error: ${err.message?.split('\n')[0]}`;
    prevEl.innerHTML =
      '<p class="text-[12px]" style="color:#c3c6d6;padding:16px">Fix the syntax error to see a preview</p>';
  }
}

function _insertDiagramIntoNote() {
  const source = document.getElementById('planning-diagram-source')?.value?.trim();
  if (!source) return;

  if (_diagramInsertCallback) {
    // Editing existing block via Node View callback
    _diagramInsertCallback(source);
  } else if (_editor) {
    // Insert as a proper mermaidBlock node — no DOM hacks needed
    _editor.chain().focus().insertContent({ type: 'mermaidBlock', attrs: { source } }).run();
  }

  _closeDiagramModal();
}

function _bindDiagramModal() {
  document
    .getElementById('planning-diagram-modal-close')
    ?.addEventListener('click', _closeDiagramModal);
  document.getElementById('planning-diagram-cancel')?.addEventListener('click', _closeDiagramModal);
  document.getElementById('planning-diagram-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) _closeDiagramModal();
  });
  document
    .getElementById('planning-diagram-insert')
    ?.addEventListener('click', _insertDiagramIntoNote);
  document
    .getElementById('planning-diagram-source')
    ?.addEventListener('input', _debouncedDiagramPreview);

  // AI prompt bar
  const aiInput = document.getElementById('planning-diagram-ai-input');
  const aiBtn = document.getElementById('planning-diagram-ai-btn');

  async function _handleDiagramAI() {
    const instruction = aiInput?.value?.trim();
    const source = document.getElementById('planning-diagram-source')?.value?.trim();
    if (!instruction || !source) return;

    if (aiBtn) {
      aiBtn.disabled = true;
      aiBtn.innerHTML = `<span class="material-symbols-outlined animate-spin" style="font-size:13px">autorenew</span> Thinking…`;
    }

    try {
      const res = await fetch(`${AGENT_BASE_URL}/diagram/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, instruction, llm_api_key: _getApiKey() || undefined }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const srcEl = document.getElementById('planning-diagram-source');
      if (srcEl) srcEl.value = data.source;
      if (aiInput) aiInput.value = '';
      _debouncedDiagramPreview();

      // In edit mode, also live-update the node in the note immediately
      if (_diagramInsertCallback) {
        _diagramInsertCallback(data.source);
        // Keep modal open so user can keep refining
      }
    } catch (err) {
      const errEl = document.getElementById('planning-diagram-error');
      if (errEl) {
        errEl.textContent = err.message?.slice(0, 80) ?? 'AI error';
        setTimeout(() => {
          errEl.textContent = '';
        }, 4000);
      }
    } finally {
      if (aiBtn) {
        aiBtn.disabled = false;
        aiBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:13px">send</span> Generate`;
      }
    }
  }

  aiBtn?.addEventListener('click', _handleDiagramAI);
  aiInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      _handleDiagramAI();
    }
  });

  document.querySelectorAll('.diagram-tpl-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tpl = DIAGRAM_TEMPLATES[btn.dataset.tpl];
      if (!tpl) return;
      const srcEl = document.getElementById('planning-diagram-source');
      if (srcEl) srcEl.value = tpl;
      document.querySelectorAll('.diagram-tpl-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      _debouncedDiagramPreview();
    });
  });

  // Toolbar button in editor
  document.getElementById('planning-insert-diagram-btn')?.addEventListener('click', () => {
    _openDiagramModal(DIAGRAM_TEMPLATES.flowchart, null);
  });
}

// ── Generate GitHub Issues from selected notes ────────────────────────────────

function _getRepoOptions() {
  const activeRepo = state.issueSourceRepo || state.repoFullName;
  const repos = state.repos?.length
    ? state.repos.map((r) => r.full_name)
    : activeRepo
      ? [activeRepo]
      : [];
  return repos.length
    ? repos
        .map(
          (r) => `<option value="${r}"${r === activeRepo ? ' selected' : ''}>${r}</option>`
        )
        .join('')
    : `<option value="">No repositories — load one from the board first</option>`;
}

/** Stream a prompt+notes through the agent and return the full text response. */
async function _streamAgentText(prompt, notes) {
  const res = await fetch(`${AGENT_BASE_URL}/notes/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: prompt,
      notes: notes.map((n) => ({
        id: n.id,
        title: n.title || 'Untitled',
        content: _stripHtml(n.content),
      })),
      llm_api_key: _getApiKey() || undefined,
    }),
  });

  if (!res.ok) throw new Error(`Agent server error: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let fullText = '';

  function processLine(line) {
    if (!line.startsWith('data: ')) return;
    try {
      const event = JSON.parse(line.slice(6));
      if (event.type === 'token') fullText += event.data.content;
    } catch {
      /* skip malformed SSE chunk */
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buf) buf.split('\n').forEach(processLine);
      break;
    }
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    lines.forEach(processLine);
  }

  return fullText;
}

/** Extract the first JSON object from a string, handling markdown code fences. */
function _extractJson(text) {
  // strip ```json … ``` or ``` … ``` wrappers
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const match = candidate.match(/\{[\s\S]*\}/);
  if (!match) return null;
  return JSON.parse(match[0]);
}

/** Phase 1 — ask the AI to surface assumptions/edge cases before generating issues. */
async function _generateIssues() {
  const notes =
    _selectedIds.size > 0
      ? _notes.filter((n) => _selectedIds.has(n.id))
      : _activeId
        ? _notes.filter((n) => n.id === _activeId)
        : [];

  if (notes.length === 0) return;

  _issueSourceNotes = notes;
  _openIssuesModal('loading', `Analysing ${notes.length} note${notes.length !== 1 ? 's' : ''}…`);

  const prompt = `You are about to help create GitHub issues from planning notes. Before generating issues, identify 3–5 key assumptions or edge cases that need clarification to produce accurate, well-scoped issues.

Return ONLY a JSON object in this exact format (no other text):
{"questions":["Question 1?","Question 2?","Question 3?"]}

Focus on: scope boundaries, technical approach decisions, priority/urgency, missing acceptance criteria, dependencies, or anything ambiguous in the notes.`;

  try {
    const text = await _streamAgentText(prompt, notes);
    const parsed = _extractJson(text);
    if (!parsed) throw new Error('Could not parse questions from response.');
    const { questions } = parsed;
    if (!Array.isArray(questions) || questions.length === 0)
      throw new Error('No questions returned.');
    _openIssuesModal('questions', questions);
  } catch (err) {
    _openIssuesModal('error', err.message || 'Failed to analyse notes.');
  }
}

/** Phase 2 — generate issues using notes + user's answers to the clarifying questions. */
async function _generateIssuesWithAnswers(qas) {
  _openIssuesModal('loading', 'Generating issues…');

  const qaBlock = qas.map(({ q, a }) => `Q: ${q}\nA: ${a || '(no answer provided)'}`).join('\n\n');

  const prompt = `Based on the planning notes and the clarifications below, generate a list of GitHub issues. Each issue must be a concrete, actionable work item that accounts for the answers given.

Clarifications:
${qaBlock}

Return ONLY a JSON object in this exact format (no other text):
{"issues":[{"title":"...","body":"Markdown description...","subtasks":["subtask 1","subtask 2"]}]}

Generate 2–6 issues.`;

  try {
    const text = await _streamAgentText(prompt, _issueSourceNotes);
    const parsed = _extractJson(text);
    if (!parsed)
      throw new Error('No JSON in response — try again or add more detail to your notes.');
    const issues = (parsed.issues || []).map((iss, i) => ({
      id: `gen-${Date.now()}-${i}`,
      title: iss.title || '',
      body: iss.body || '',
      subtasks: Array.isArray(iss.subtasks) ? iss.subtasks : [],
      selected: true,
    }));
    _generatedIssues = issues;
    _openIssuesModal('review', issues);
  } catch (err) {
    _openIssuesModal('error', err.message || 'Failed to generate issues.');
  }
}

/**
 * Update the modal content.
 * state: 'loading' | 'questions' | 'review' | 'error'
 * payload:
 *   loading  → string label
 *   questions → string[] of questions
 *   review   → issue[]
 *   error    → string error message
 */
function _openIssuesModal(state, payload) {
  const modal = document.getElementById('planning-issues-modal');
  if (!modal) return;

  const repoSelect = document.getElementById('planning-issues-repo');
  if (repoSelect) repoSelect.innerHTML = _getRepoOptions();

  const body = document.getElementById('planning-issues-body');
  const footer = document.getElementById('planning-issues-footer');

  if (state === 'loading') {
    if (body)
      body.innerHTML = `
      <div class="flex flex-col items-center justify-center py-12 gap-3">
        <span class="material-symbols-outlined animate-spin" style="font-size:28px;color:#003d9b">autorenew</span>
        <p class="text-[13px] font-medium" style="color:#6b7280">${_esc(payload || 'Working…')}</p>
      </div>`;
    if (footer) footer.innerHTML = '';
  } else if (state === 'questions') {
    const questions = payload; // string[]
    if (body)
      body.innerHTML = `
      <p class="text-[12px] leading-relaxed mb-4" style="color:#6b7280">
        Before creating issues, please clarify a few assumptions from your notes:
      </p>
      <div class="space-y-4">
        ${questions
          .map(
            (q, i) => `
          <div>
            <label class="block text-[12px] font-semibold mb-1.5" style="color:#191c1e">${_esc(q)}</label>
            <textarea class="issue-qa-answer w-full text-[12.5px] px-3 py-2 rounded-xl resize-none focus:outline-none"
              data-qi="${i}" rows="2"
              placeholder="Your answer…"
              style="background:#f4f5f8;border:1.5px solid rgba(195,198,214,0.4);color:#191c1e;font-family:Inter,sans-serif;scrollbar-width:thin"></textarea>
          </div>`
          )
          .join('')}
      </div>`;
    if (footer) {
      footer.innerHTML = `
        <button id="planning-issues-cancel-btn" class="text-[13px] font-semibold px-4 py-2 rounded-xl transition-all" style="color:#6b7280;background:#f3f4f6">Cancel</button>
        <button id="planning-issues-proceed-btn" class="flex items-center gap-1.5 text-[13px] font-semibold px-4 py-2 rounded-xl transition-all active:scale-95" style="background:linear-gradient(135deg,#003d9b,#0052cc);color:#fff">
          <span class="material-symbols-outlined" style="font-size:15px">auto_awesome</span>
          Generate issues
        </button>`;
      document
        .getElementById('planning-issues-cancel-btn')
        ?.addEventListener('click', _closeIssuesModal);
      document.getElementById('planning-issues-proceed-btn')?.addEventListener('click', () => {
        const answers = [...document.querySelectorAll('.issue-qa-answer')].map((el, i) => ({
          q: questions[i],
          a: el.value.trim(),
        }));
        _generateIssuesWithAnswers(answers);
      });
    }
  } else if (state === 'review') {
    _renderIssuesList(payload);
    _updateIssuesFooter();
  } else if (state === 'error') {
    if (body)
      body.innerHTML = `
      <div class="rounded-xl px-4 py-3 text-[12.5px]" style="background:#fef2f2;color:#ba1a1a;border:1px solid #fca5a5">
        ${_esc(payload || 'Something went wrong.')}
      </div>`;
    if (footer) {
      footer.innerHTML = `<button id="planning-issues-close-btn" class="text-[13px] font-semibold px-4 py-2 rounded-xl" style="color:#6b7280;background:#f3f4f6">Close</button>`;
      document
        .getElementById('planning-issues-close-btn')
        ?.addEventListener('click', _closeIssuesModal);
    }
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function _renderIssuesList(issues) {
  const body = document.getElementById('planning-issues-body');
  if (!body) return;

  if (issues.length === 0) {
    body.innerHTML = `<p class="text-[12.5px] py-4 text-center" style="color:#a0a3b0">No issues generated. Try with more detailed notes.</p>`;
    return;
  }

  body.innerHTML = issues
    .map(
      (iss, idx) => `
    <div class="issue-gen-card" data-idx="${idx}" style="border:1.5px solid rgba(195,198,214,0.3);border-radius:12px;padding:14px 16px;background:#fafbff">
      <div class="flex items-start gap-3">
        <input type="checkbox" class="issue-gen-cb mt-0.5 w-3.5 h-3.5 shrink-0 accent-[#003d9b]"
          data-idx="${idx}" ${iss.selected ? 'checked' : ''}/>
        <div class="flex-1 min-w-0">
          <input type="text" class="issue-gen-title w-full text-[13px] font-semibold bg-transparent focus:outline-none rounded px-1"
            style="color:#191c1e;border-bottom:1px solid transparent" data-idx="${idx}" value="${_esc(iss.title)}" placeholder="Issue title"/>
          ${iss.body ? `<p class="text-[11.5px] mt-1.5 leading-relaxed" style="color:#6b7280">${_esc(iss.body.slice(0, 140))}${iss.body.length > 140 ? '…' : ''}</p>` : ''}
          ${
            iss.subtasks.length > 0
              ? `
            <ul class="mt-2 space-y-0.5">
              ${iss.subtasks
                .map(
                  (s) => `<li class="flex items-center gap-1.5 text-[11px]" style="color:#6b7280">
                <span class="material-symbols-outlined" style="font-size:11px;color:#a0a3b0">check_box_outline_blank</span>${_esc(s)}
              </li>`
                )
                .join('')}
            </ul>`
              : ''
          }
        </div>
      </div>
    </div>`
    )
    .join('');

  body.querySelectorAll('.issue-gen-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      const idx = parseInt(cb.dataset.idx, 10);
      _generatedIssues[idx].selected = cb.checked;
      _updateIssuesFooter();
    });
  });

  body.querySelectorAll('.issue-gen-title').forEach((input) => {
    input.addEventListener('input', () => {
      const idx = parseInt(input.dataset.idx, 10);
      _generatedIssues[idx].title = input.value;
      _updateIssuesFooter();
    });
  });
}

function _updateIssuesFooter() {
  const footer = document.getElementById('planning-issues-footer');
  if (!footer) return;
  const count = _generatedIssues.filter((i) => i.selected && i.title.trim()).length;
  const disabled = count === 0 ? ' opacity-50 pointer-events-none' : '';
  footer.innerHTML = `
    <button id="planning-issues-cancel-btn" class="text-[13px] font-semibold px-4 py-2 rounded-xl transition-all" style="color:#6b7280;background:#f3f4f6">Cancel</button>
    <button id="planning-issues-create-btn" class="flex items-center gap-1.5 text-[13px] font-semibold px-4 py-2 rounded-xl transition-all active:scale-95${disabled}" style="background:linear-gradient(135deg,#003d9b,#0052cc);color:#fff">
      <span class="material-symbols-outlined" style="font-size:15px">add_circle</span>
      Create ${count} issue${count !== 1 ? 's' : ''}
    </button>`;
  document
    .getElementById('planning-issues-cancel-btn')
    ?.addEventListener('click', _closeIssuesModal);
  document
    .getElementById('planning-issues-create-btn')
    ?.addEventListener('click', _createIssuesFromModal);
}

function _closeIssuesModal() {
  const modal = document.getElementById('planning-issues-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

async function _createIssuesFromModal() {
  const repo = document.getElementById('planning-issues-repo')?.value?.trim();
  if (!repo) return;

  const toCreate = _generatedIssues.filter((i) => i.selected && i.title.trim());
  if (toCreate.length === 0) return;

  const createBtn = document.getElementById('planning-issues-create-btn');
  if (createBtn) {
    createBtn.disabled = true;
    createBtn.innerHTML = `<span class="material-symbols-outlined animate-spin" style="font-size:15px">autorenew</span> Creating…`;
  }

  const created = [];
  const failed = [];

  for (const iss of toCreate) {
    try {
      const bodyText =
        iss.subtasks.length > 0
          ? `${iss.body}\n\n**Sub-tasks:**\n${iss.subtasks.map((s) => `- [ ] ${s}`).join('\n')}`
          : iss.body;
      const result = await createIssue(repo, { title: iss.title.trim(), body: bodyText });
      created.push({ title: iss.title, number: result.number, url: result.html_url });
    } catch (err) {
      failed.push({ title: iss.title, error: err.userMessage || err.message });
    }
  }

  const body = document.getElementById('planning-issues-body');
  if (body) {
    const successHtml =
      created.length > 0
        ? `
      <div class="rounded-xl px-4 py-3 text-[12.5px]" style="background:#f0fdf4;color:#15803d;border:1px solid #86efac">
        <div class="flex items-center gap-2 font-semibold mb-2">
          <span class="material-symbols-outlined" style="font-size:16px">check_circle</span>
          ${created.length} issue${created.length !== 1 ? 's' : ''} created in <strong>${_esc(repo)}</strong>
        </div>
        <ul class="space-y-1">
          ${created.map((i) => `<li><a href="${i.url}" target="_blank" rel="noopener" style="color:#003d9b;text-decoration:underline">#${i.number} ${_esc(i.title)}</a></li>`).join('')}
        </ul>
      </div>`
        : '';
    const failHtml =
      failed.length > 0
        ? `
      <div class="rounded-xl px-4 py-3 text-[12.5px] mt-3" style="background:#fef2f2;color:#ba1a1a;border:1px solid #fca5a5">
        Failed to create: ${_esc(failed.map((i) => i.title).join(', '))}
      </div>`
        : '';
    body.innerHTML = successHtml + failHtml;
  }

  const footer = document.getElementById('planning-issues-footer');
  if (footer) {
    footer.innerHTML = `<button id="planning-issues-done-btn" class="text-[13px] font-semibold px-4 py-2 rounded-xl" style="background:linear-gradient(135deg,#003d9b,#0052cc);color:#fff">Done</button>`;
    document
      .getElementById('planning-issues-done-btn')
      ?.addEventListener('click', _closeIssuesModal);
  }
}

// ── URL Import ────────────────────────────────────────────────────────────────

function _openUrlModal() {
  const modal = document.getElementById('planning-url-modal');
  const input = document.getElementById('planning-url-input');
  const errEl = document.getElementById('planning-url-error');
  if (!modal) return;
  if (input) input.value = '';
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
  _resetUrlImportBtn();
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  setTimeout(() => input?.focus(), 50);
}

function _closeUrlModal() {
  const modal = document.getElementById('planning-url-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

function _resetUrlImportBtn() {
  const btn = document.getElementById('planning-url-import');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:15px">auto_awesome</span> Import &amp; Summarise`;
  }
}

async function _importUrl() {
  const input = document.getElementById('planning-url-input');
  const errEl = document.getElementById('planning-url-error');
  const btn = document.getElementById('planning-url-import');
  const url = input?.value.trim();

  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    if (errEl) {
      errEl.textContent = 'Please enter a valid URL starting with http:// or https://';
      errEl.classList.remove('hidden');
    }
    return;
  }
  if (errEl) errEl.classList.add('hidden');

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined animate-spin" style="font-size:15px">autorenew</span> Fetching…`;
  }

  try {
    const res = await fetch(`${AGENT_BASE_URL}/notes/fetch-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, llm_api_key: _getApiKey() || undefined }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Convert markdown summary to HTML paragraphs and insert into note
    const html = _mdToHtml(data.summary);
    const heading = `<h2>📄 ${_esc(data.title)}</h2>`;
    if (_editor) {
      _editor
        .chain()
        .focus()
        .insertContent(heading + html)
        .run();
      _scheduleSave();
    }
    _closeUrlModal();
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || 'Could not fetch URL.';
      errEl.classList.remove('hidden');
    }
    _resetUrlImportBtn();
  }
}

/** Simple markdown → HTML for headings, bullets, bold, code, blockquotes. */
function _mdToHtml(md) {
  return md
    .split('\n')
    .map((line) => {
      if (/^### (.+)/.test(line)) return `<h3>${line.replace(/^### /, '')}</h3>`;
      if (/^## (.+)/.test(line)) return `<h2>${line.replace(/^## /, '')}</h2>`;
      if (/^# (.+)/.test(line)) return `<h1>${line.replace(/^# /, '')}</h1>`;
      if (/^> (.+)/.test(line)) return `<blockquote><p>${line.replace(/^> /, '')}</p></blockquote>`;
      if (/^[-*] (.+)/.test(line)) return `<li>${line.replace(/^[-*] /, '')}</li>`;
      if (line.trim() === '') return '';
      return `<p>${line}</p>`;
    })
    .map((l) => {
      // inline: **bold**, `code`
      return l
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    })
    .join('\n');
}

// ── Skills management ─────────────────────────────────────────────────────────

const SKILLS_KEY = 'pnx_skills';

const _DEFAULT_SKILLS = {
  url_import: true,
  diagram_gen: true,
  issue_gen: true,
  ai_chat: true,
};

function _loadSkills() {
  try {
    const raw = localStorage.getItem(SKILLS_KEY);
    return raw ? { ..._DEFAULT_SKILLS, ...JSON.parse(raw) } : { ..._DEFAULT_SKILLS };
  } catch {
    return { ..._DEFAULT_SKILLS };
  }
}

function _saveSkills(skills) {
  localStorage.setItem(SKILLS_KEY, JSON.stringify(skills));
}

/** Show/hide UI elements based on which skills are enabled. */
function _applySkillVisibility(skills) {
  const importBtn = document.getElementById('planning-import-url-btn');
  const diagramBtn = document.getElementById('planning-insert-diagram-btn');
  const issueBtn = document.getElementById('planning-generate-issues-btn');

  if (importBtn) importBtn.style.display = skills.url_import ? '' : 'none';
  if (diagramBtn) diagramBtn.style.display = skills.diagram_gen ? '' : 'none';
  if (issueBtn) issueBtn.style.display = skills.issue_gen ? '' : 'none';
}

function _openSkillsPanel() {
  const panel = document.getElementById('planning-skills-panel');
  if (!panel) return;

  // Sync checkbox states from storage
  const skills = _loadSkills();
  document.querySelectorAll('.skill-cb').forEach((cb) => {
    const key = cb.dataset.skill;
    if (key && key in skills) cb.checked = skills[key];
  });

  panel.classList.remove('hidden');
  panel.style.display = 'flex';
}

function _closeSkillsPanel() {
  const panel = document.getElementById('planning-skills-panel');
  if (panel) {
    panel.classList.add('hidden');
    panel.style.display = 'none';
  }
}

function _bindSkillsPanel() {
  document.getElementById('planning-skills-btn')?.addEventListener('click', _openSkillsPanel);
  document.getElementById('planning-skills-close')?.addEventListener('click', _closeSkillsPanel);

  document.querySelectorAll('.skill-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      const skills = _loadSkills();
      skills[cb.dataset.skill] = cb.checked;
      _saveSkills(skills);
      _applySkillVisibility(skills);
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initPlanning() {
  _loadNotes();

  const panel = document.getElementById('planning-panel');
  if (!panel) return;

  // ── Init Tiptap editor ──
  const mountEl = document.getElementById('planning-note-content');
  if (mountEl) {
    _editor = new Editor({
      element: mountEl,
      extensions: [
        StarterKit,
        Underline,
        TaskList,
        TaskItem.configure({ nested: true }),
        Highlight,
        Typography,
        MermaidBlock,
        Placeholder.configure({
          placeholder: 'Start writing your note… Use the toolbar above or type / for commands.',
        }),
      ],
      content: '',
      onUpdate: _onEditorUpdate,
      onSelectionUpdate: _syncToolbarState,
    });
  }

  _bindToolbar();
  _bindDiagramModal();
  _bindSkillsPanel();

  // Apply skill visibility from stored settings
  _applySkillVisibility(_loadSkills());

  // ── URL import modal ──
  document.getElementById('planning-import-url-btn')?.addEventListener('click', _openUrlModal);
  document.getElementById('planning-url-modal-close')?.addEventListener('click', _closeUrlModal);
  document.getElementById('planning-url-cancel')?.addEventListener('click', _closeUrlModal);
  document.getElementById('planning-url-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) _closeUrlModal();
  });
  document.getElementById('planning-url-import')?.addEventListener('click', _importUrl);
  document.getElementById('planning-url-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      _importUrl();
    }
  });

  // ── Open/close panel ──
  document.getElementById('planning-panel-close')?.addEventListener('click', () => {
    panel.classList.add('hidden');
    panel.classList.remove('flex');
  });

  document.addEventListener('open-planning-panel', () => {
    _loadNotes();
    _renderNoteList();
    _updateSelectionUI();
    if (_notes.length > 0 && !_activeId) _openNote(_notes[0].id);
    else if (_activeId) {
      const n = _notes.find((n) => n.id === _activeId);
      if (n) _showEditor(n);
      else _hideEditor();
    } else {
      _hideEditor();
    }
    panel.classList.remove('hidden');
    panel.classList.add('flex');
  });

  // ── New note ──
  function _handleNewNote() {
    const note = _createNote();
    _renderNoteList();
    _updateSelectionUI();
    _openNote(note.id);
    setTimeout(() => document.getElementById('planning-note-title')?.focus(), 50);
  }

  document.getElementById('planning-new-note-btn')?.addEventListener('click', _handleNewNote);
  document.getElementById('planning-editor-new-btn')?.addEventListener('click', _handleNewNote);

  // ── Delete note ──
  document.getElementById('planning-delete-note-btn')?.addEventListener('click', () => {
    if (!_activeId) return;
    if (!confirm('Delete this note? This cannot be undone.')) return;
    _deleteNote(_activeId);
    _activeId = null;
    _renderNoteList();
    _updateSelectionUI();
    if (_notes.length > 0) _openNote(_notes[0].id);
    else _hideEditor();
  });

  // ── Title auto-save ──
  document.getElementById('planning-note-title')?.addEventListener('input', _scheduleSave);

  // ── Search ──
  document.getElementById('planning-note-search')?.addEventListener('input', (e) => {
    _searchQuery = e.target.value;
    _renderNoteList();
  });

  // ── Select all ──
  document.getElementById('planning-select-all')?.addEventListener('change', (e) => {
    if (e.target.checked) _notes.forEach((n) => _selectedIds.add(n.id));
    else _selectedIds.clear();
    _renderNoteList();
    _updateSelectionUI();
  });

  // ── Context buttons ──
  document.querySelectorAll('.planning-ctx-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      _chatCtx = btn.dataset.ctx;
      document.querySelectorAll('.planning-ctx-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ── Clear chat ──
  document.getElementById('planning-clear-chat-btn')?.addEventListener('click', () => {
    const msgs = document.getElementById('planning-chat-messages');
    if (!msgs) return;
    msgs.innerHTML = `
      <div id="planning-chat-welcome" class="text-center py-6">
        <div class="w-10 h-10 rounded-xl flex items-center justify-center mx-auto mb-3"
          style="background:linear-gradient(135deg,#dae2ff,#c8d4f8)">
          <span class="material-symbols-outlined" style="font-size:20px;color:#003d9b">auto_awesome</span>
        </div>
        <p class="text-[13px] font-semibold mb-1" style="color:#191c1e">Chat with your notes</p>
        <p class="text-[11px] leading-relaxed" style="color:#6b6f80">
          Ask questions, brainstorm ideas, or get summaries of your planning notes.
        </p>
        <div class="mt-4 space-y-2">
          <button class="planning-suggestion-chip">Summarise these notes</button>
          <button class="planning-suggestion-chip">What are the key action items?</button>
          <button class="planning-suggestion-chip">Find gaps or missing details</button>
        </div>
      </div>`;
    _bindSuggestionChips();
  });

  // ── Chat send ──
  const chatInput = document.getElementById('planning-chat-input');
  const sendBtn = document.getElementById('planning-chat-send');

  function _handleSend() {
    const q = chatInput?.value.trim();
    if (!q) return;
    if (chatInput) chatInput.value = '';
    _autoResizeTextarea(chatInput);
    _sendQuestion(q);
  }

  sendBtn?.addEventListener('click', _handleSend);
  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      _handleSend();
    }
  });
  chatInput?.addEventListener('input', () => _autoResizeTextarea(chatInput));

  _bindSuggestionChips();

  // ── Generate GitHub issues ──
  document
    .getElementById('planning-generate-issues-btn')
    ?.addEventListener('click', _generateIssues);
  document
    .getElementById('planning-issues-modal-close')
    ?.addEventListener('click', _closeIssuesModal);
  document.getElementById('planning-issues-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) _closeIssuesModal();
  });
}

function _bindSuggestionChips() {
  document.querySelectorAll('.planning-suggestion-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('planning-chat-welcome')?.remove();
      _sendQuestion(chip.textContent.trim());
    });
  });
}

function _autoResizeTextarea(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
