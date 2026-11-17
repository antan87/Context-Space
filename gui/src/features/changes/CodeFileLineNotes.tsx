import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { apiFetch } from '../../lib/api/client.js';
import { ChatMarkdown } from '../../components/ChatMarkdown.js';
import { useClockTick } from '../../lib/useClockTick.js';
import { agoText } from '../plan/whatsNew.js';
import { placeLineNote, type LineNote, type LineRange } from '../board/lineNotes.js';
import { monacoSelectionLines } from './codeLineNotes.js';

const button = 'min-h-6 min-w-6 rounded border border-border bg-background px-2 text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring';
const ownsKey = () => document.querySelector('[role="dialog"], [data-slot="menu-popup"], .find-widget.visible, .monaco-menu-container, .suggest-widget.visible, .parameter-hints-widget.visible');
export interface CodeFileLineNotesProps {
  editor: monaco.editor.IStandaloneCodeEditor; workspace: string; path: string; repo?: string;
  content: string; active: boolean; openNoteId?: string; request?: number;
  onJumpNote?: (note: LineNote | undefined) => void;
  onAskInCLI?: (path: string, range: LineRange) => void | Promise<unknown>;
}

/** Notes decorate the existing editor/model. Polls never create, replace, or select a Monaco model. */
export function CodeFileLineNotes({ editor, workspace, path, repo, content, active, openNoteId, request, onAskInCLI, onJumpNote }: CodeFileLineNotesProps) {
  const [selection, setSelection] = useState<LineRange | null>(null);
  const [openId, setOpenId] = useState<string | null>(openNoteId ?? null);
  const [listOpen, setListOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const markerList = useRef<HTMLButtonElement>(null);
  const client = useQueryClient();
  const now = useClockTick();
  const query = useQuery({
    queryKey: ['line-notes', workspace],
    queryFn: ({ signal }) => apiFetch<{ notes: LineNote[] }>(`/api/workspace/${encodeURIComponent(workspace)}/line-notes`, { signal }),
    enabled: active, refetchInterval: active ? 5000 : false, retry: false,
  });
  const notes = (query.data?.notes ?? []).filter(n => !n.doneAt && n.path === path && (n.repo ?? '') === (repo ?? ''));
  const placed = notes.map(note => ({ note, ...placeLineNote(note, content) }));
  const opened = placed.find(n => n.note.id === openId);
  const jumpNote = placed.find(n => n.note.id === openNoteId)?.note;
  useEffect(() => { onJumpNote?.(jumpNote); }, [onJumpNote, jumpNote]);
  const live = useRef({ selection, opened, listOpen, placed, onAskInCLI });
  useLayoutEffect(() => { live.current = { selection, opened, listOpen, placed, onAskInCLI }; });
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const focusNote = useRef(openNoteId !== undefined);
  useEffect(() => {
    setOpenId(openNoteId ?? null); setSelection(null); setListOpen(false); setError(null);
    focusNote.current = openNoteId !== undefined;
  }, [openNoteId, request, path, repo]);
  useEffect(() => {
    if (!opened || !focusNote.current || !active) return;
    editor.revealLineInCenter(opened.line);
    panel.current?.focus({ preventScroll: true }); focusNote.current = false;
  });
  useEffect(() => {
    const collection = editor.createDecorationsCollection(); decorations.current = collection;
    return () => { collection.clear(); if (decorations.current === collection) decorations.current = null; };
  }, [editor]);
  useEffect(() => {
    const groups = new Map<number, typeof placed>();
    for (const note of placed) groups.set(note.line, [...(groups.get(note.line) ?? []), note]);
    const glyphs: monaco.editor.IModelDeltaDecoration[] = [...groups].map(([line, group]) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: { glyphMarginClassName: `pa1-note-glyph pa1-note-${group[0].note.tag} pa1-note-count-${group.length}`, glyphMarginHoverMessage: { value: `${group.length > 1 ? `${group.length} notes. ` : ''}Note from ${group[0].note.harness} on lines ${line}-${group[0].endLine}. Open with Notes in the file header.` } },
    }));
    if (opened) glyphs.push({ range: new monaco.Range(opened.line, 1, opened.endLine, 1), options: { isWholeLine: true, className: 'pa1-note-lines' } });
    decorations.current?.set(glyphs);
  });
  useEffect(() => {
    if (!active) return;
    const chosen = editor.onDidChangeCursorSelection(event => setSelection(monacoSelectionLines(event.selection)));
    const clicked = editor.onMouseDown(event => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !event.target.position) return;
      const note = live.current.placed.find(n => n.line === event.target.position!.lineNumber);
      if (note) { setOpenId(note.note.id); setListOpen(false); setError(null); focusNote.current = true; }
    });
    const key = (event: KeyboardEvent) => {
      const held = document.activeElement;
      const window = editor.getDomNode()?.closest('[data-code-window]');
      const field = held instanceof HTMLElement && !held.closest('.monaco-editor') && (held.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(held.tagName));
      if (event.defaultPrevented || ownsKey() || field || !(held && (window ? window.contains(held) : editor.getDomNode()?.contains(held) || root.current?.contains(held)))) return;
      if (event.key === 'Escape') {
        if (live.current.selection) { setSelection(null); }
        else if (live.current.opened) { setOpenId(null); markerList.current?.focus(); }
        else if (live.current.listOpen) { setListOpen(false); markerList.current?.focus(); }
        else return;
        event.preventDefault(); event.stopImmediatePropagation();
      } else if (event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault(); setListOpen(true); markerList.current?.focus();
      } else if (event.altKey && event.key === 'Enter' && live.current.selection && live.current.onAskInCLI) {
        event.preventDefault();
        void live.current.onAskInCLI(repo ? `${repo}/${path}` : path, live.current.selection); setSelection(null);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => { chosen.dispose(); clicked.dispose(); window.removeEventListener('keydown', key, true); };
  }, [active, editor, path, repo]);
  const open = (id: string) => { setOpenId(id); setListOpen(false); setError(null); focusNote.current = true; };
  const counts = new Map<number, number>();
  for (const note of placed) counts.set(note.line, (counts.get(note.line) ?? 0) + 1);
  const countRules = [...new Set(counts.values())].filter(count => count > 1).map(count => `.pa1-note-count-${count}::after { content: '${count}'; }`).join('\n');
  return <div ref={root} data-code-line-tools="" className="contents">
    <style>{countRules}</style>
    <div role="toolbar" aria-label="File questions and notes" className="order-first flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-2 py-1 text-xs">
      {selection && onAskInCLI && <button type="button" className={button} title="Ask about selected source lines (Alt+Enter)" onClick={() => { void onAskInCLI(repo ? `${repo}/${path}` : path, selection); setSelection(null); }}>Ask about {selection.line === selection.endLine ? `line ${selection.line}` : `lines ${selection.line}-${selection.endLine}`}</button>}
      <button ref={markerList} type="button" className={button} title="Notes for this file (Alt+N)" aria-expanded={listOpen} onClick={() => setListOpen(v => !v)}>Notes ({notes.length})</button>
      {query.isError && <span role="status">Notes could not be read.</span>}
    </div>
    {listOpen && <ul aria-label="File notes" className="order-first max-h-40 shrink-0 overflow-auto border-b border-border bg-card p-2 text-xs">
      {placed.map(n => <li key={n.note.id}><button type="button" className={`${button} my-0.5 text-left`} onClick={() => open(n.note.id)}>Note from {n.note.harness} on lines {n.line}-{n.endLine}</button></li>)}
      {!notes.length && <li>No open notes for this file.</li>}
    </ul>}
    {opened && <section ref={panel} tabIndex={-1} aria-label={`Note from ${opened.note.harness}`} data-code-line-note={opened.note.id} className="max-h-[45%] shrink-0 overflow-auto border-t border-border bg-card p-3 text-xs text-foreground outline-none">
      <p className="mb-2 text-xs text-muted-foreground">{opened.note.harness} · {agoText(opened.note.createdAt, new Date(now))} · lines {opened.line}-{opened.endLine}{opened.status === 'moved' ? ' · moved' : ''}</p>
      <ChatMarkdown content={opened.note.text} compact />
      {opened.status === 'changed' && <div className="mt-2 text-muted-foreground"><p>These lines changed since</p><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">{opened.note.anchor || '(No saved text)'}{opened.note.anchorCut ? '\n… (saved text cut)' : ''}</pre></div>}
      {error && <p role="alert">{error}</p>}
      <div className="mt-2 flex gap-2"><button type="button" className={button} disabled={busy} onClick={async () => {
        setBusy(true); setError(null);
        try {
          await apiFetch(`/api/workspace/${encodeURIComponent(workspace)}/line-notes/${encodeURIComponent(opened.note.id)}/done`, { method: 'POST' });
          client.setQueryData<{ notes: LineNote[] }>(['line-notes', workspace], old => old ? { notes: old.notes.filter(n => n.id !== opened.note.id) } : old);
          setOpenId(null); markerList.current?.focus(); void client.invalidateQueries({ queryKey: ['line-notes', workspace] });
        } catch (e) { setError(e instanceof Error ? e.message : 'Could not save Done.'); }
        finally { setBusy(false); }
      }}>{busy ? 'Saving…' : 'Done'}</button><button type="button" className={button} onClick={() => { setOpenId(null); markerList.current?.focus(); }}>Close</button></div>
    </section>}
  </div>;
}
