import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChatMarkdown, type MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { SourceLinesContext } from '../../components/sourceLinesContext.js';
import { useClockTick } from '../../lib/useClockTick.js';
import { agoText } from '../plan/whatsNew.js';
import { readerOwnsKey, readerCopyText, renderedFragmentText } from './readerInteractions.js';
import { isCodeWindowOpen } from '../workspace-shell/codeWindowOpen.js';
import { placeLineNote, selectionLines, type LineNote, type LineRange } from './lineNotes.js';

export interface ReaderLineTools {
  notes: LineNote[]; openNoteId?: string; request: number; active: boolean;
  readOnly: boolean; onDone: (id: string) => Promise<unknown>; onAsk?: (range: LineRange) => void;
}
const blocked = () => isCodeWindowOpen() || Boolean(document.querySelector('[role="dialog"], [data-slot="menu-popup"]'));
const focusMarker = (body: HTMLElement | null, id: string) => body?.querySelector<HTMLButtonElement>(`[data-note-ids~="${CSS.escape(id)}"]`)?.focus();
const control = 'min-h-6 min-w-6 rounded border border-border bg-background px-1 text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring';

/** All state is local to the opened file, never reset by a poll's data identity. */
export function ReaderLines({ content, markdown, tools, links }: { content: string; markdown: boolean; tools: ReaderLineTools; links?: MarkdownDocumentLinks }) {
  const { active, onAsk, openNoteId, request } = tools;
  const body = useRef<HTMLDivElement>(null);
  const askButton = useRef<HTMLButtonElement>(null);
  const [ask, setAsk] = useState<(LineRange & { top: number }) | null>(null);
  const [openId, setOpenId] = useState<string | null>(openNoteId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useClockTick();
  const placed = tools.notes.map(note => ({ note, ...placeLineNote(note, content) }));
  const opened = placed.find(n => n.note.id === openId);
  const openRef = useRef(opened);
  const askRef = useRef(ask);
  useLayoutEffect(() => { openRef.current = opened; askRef.current = ask; }, [opened, ask]);
  const pendingFocus = useRef(openNoteId);
  useEffect(() => {
    setOpenId(openNoteId ?? null);
    pendingFocus.current = openNoteId;
    setAsk(null);
  }, [openNoteId, request]);
  useEffect(() => {
    if (!pendingFocus.current || !body.current) return;
    const note = body.current.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(pendingFocus.current)}"]`);
    if (!note) return;
    note.scrollIntoView({ block: 'center' }); note.focus({ preventScroll: true }); pendingFocus.current = undefined;
  });
  useEffect(() => {
    if (!active) return;
    const update = () => {
      const el = body.current;
      const selection = window.getSelection();
      const range = el && selectionLines(el, selection);
      if (!range || !onAsk || blocked()) { setAsk(null); return; }
      const rect = selection!.getRangeAt(0).getBoundingClientRect();
      setAsk({ ...range, top: Math.max(0, rect.top - el!.getBoundingClientRect().top) });
    };
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || blocked() || !readerOwnsKey(body.current?.closest<HTMLElement>('[data-board-reader]') ?? body.current, e.target, document.activeElement, document.body)) return;
      if (e.key === 'Escape') {
        if (askRef.current) { e.preventDefault(); e.stopImmediatePropagation(); setAsk(null); }
        else if (openRef.current) { e.preventDefault(); e.stopImmediatePropagation(); setOpenId(null); focusMarker(body.current, openRef.current.note.id); }
      } else if (askRef.current && e.altKey && e.key === 'Enter') {
        e.preventDefault(); onAsk?.(askRef.current); setAsk(null);
      }
    };
    document.addEventListener('selectionchange', update);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('selectionchange', update); window.removeEventListener('keydown', key, true); };
  }, [active, onAsk]);
  const adorn = (range: LineRange, children: ReactNode, single = false, owned = range) => {
    const matching = placed.filter(n => n.line >= owned.line && n.line <= owned.endLine);
    const selected = opened && opened.line <= range.endLine && opened.endLine >= range.line;
    const Block = single ? 'span' : 'div';
    return <Block data-source-line={range.line} data-source-end={range.endLine} data-source-single={single ? '' : undefined}
      className={`source-block relative min-w-0 ${selected ? 'bg-primary/10 ring-1 ring-primary/30' : ''}`}>
      {children}
      {matching.length > 0 && <div data-line-note-ui="" className="line-note-adornment absolute z-10 -left-9 top-0 select-none">
        <button type="button" data-note-marker={range.line} data-note-ids={matching.map(n => n.note.id).join(' ')} style={{ maxWidth: 32, padding: 0 }} className={`${control} ${matching[0].note.tag === 'risk' ? 'text-amber-600 dark:text-amber-400' : matching[0].note.tag === 'todo' ? 'text-emerald-600 dark:text-emerald-400' : 'text-primary'}`}
          aria-label={`Note from ${matching[0].note.harness} on lines ${matching[0].line}-${matching[0].endLine}`}
          onClick={() => { setOpenId(matching[0].note.id); setError(null); }}>✎{matching.length > 1 ? matching.length : ''}</button>
      </div>}
      {matching.some(n => n.note.id === openId) && <div data-line-note-ui="" className="line-note-adornment not-prose my-2 whitespace-normal rounded-md border border-border bg-background p-3 text-xs font-sans text-foreground">
        {matching.map(({ note, status, line, endLine }) => <section key={note.id} data-note-id={note.id} tabIndex={-1} aria-label={`Note from ${note.harness}`} className="mb-2 last:mb-0">
          <p className="mb-2 text-xs text-muted-foreground">{note.harness} · {agoText(note.createdAt, new Date(now))} · lines {line}-{endLine}{status === 'moved' ? ' · moved' : ''}</p>
          <SourceLinesContext value={null}><ChatMarkdown content={note.text} compact /></SourceLinesContext>
          {status === 'changed' && <div className="mt-2 text-muted-foreground"><p>These lines changed since</p><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">{note.anchor || '(No saved text)'}{note.anchorCut ? '\n… (saved text cut)' : ''}</pre></div>}
          <div className="mt-2 flex gap-2"><button type="button" className={control} disabled={tools.readOnly || busy} onClick={async () => {
            setBusy(true); setError(null);
            try { await tools.onDone(note.id); if (openId === note.id) setOpenId(null); }
            catch (e) { setError(e instanceof Error ? e.message : 'Could not save Done.'); }
            finally { setBusy(false); }
          }}>{busy ? 'Saving…' : 'Done'}</button><button type="button" className={control} onClick={() => { setOpenId(null); focusMarker(body.current, matching[0].note.id); }}>Close</button></div>
        </section>)}
        {error && <p role="alert">{error}</p>}
      </div>}
    </Block>;
  };
  const sourceRows = () => <pre className="whitespace-pre-wrap break-words font-mono text-xs sm:text-sm rounded-lg border border-border bg-muted/20 p-4 overflow-visible">{content.replace(/\r\n/g, '\n').split('\n').map((line, i, lines) => <span key={i}>{adorn({ line: i + 1, endLine: i + 1 }, <><span>{line}</span>{i < lines.length - 1 ? '\n' : ''}</>, true)}</span>)}</pre>;
  const renderSource = (blocks: LineRange[], children: ReactNode) => {
    if (!blocks.length) return <div className="not-prose">{sourceRows()}</div>;
    // Partition source lines once: gaps go backward, and leading gaps go to the first block.
    const ownership = new Map(blocks.map((block, i) => [block.line, {
      line: i === 0 ? 1 : block.line,
      endLine: (blocks[i + 1]?.line ?? Infinity) - 1,
    }]));
    return <SourceLinesContext value={(range, children) => adorn(range, children, false, ownership.get(range.line))}>{children}</SourceLinesContext>;
  };
  return <div ref={body} data-reader-lines="" data-slash-owner="" className="reader-lines isolate relative min-w-0 pl-10 text-sm" onCopy={event => {
    if (!body.current) return;
    const text = readerCopyText(body.current, window.getSelection(), markdown, fragment => {
      const html = document.createElement('div'); html.append(fragment.cloneNode(true));
      event.clipboardData.setData('text/html', html.innerHTML);
      return renderedFragmentText(fragment, body.current?.querySelector<HTMLElement>('.prose'));
    });
    if (text === null) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  }}>
    {markdown && content.trim() ? <ChatMarkdown content={content} links={links} renderSource={renderSource} /> : sourceRows()}
    {ask && onAsk && <button ref={askButton} type="button" className={`${control} absolute left-0 z-20 h-6 w-9 px-0 shadow-sm`} style={{ top: ask.top }} title="Ask about selected source lines (Alt+Enter)"
      onMouseDown={e => e.preventDefault()} onClick={() => { onAsk?.(ask); setAsk(null); }}>Ask</button>}
  </div>;
}
