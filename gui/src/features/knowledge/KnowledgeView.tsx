import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';

import { ChatMarkdown } from '../../components/ChatMarkdown.js';
import { Input } from '../../components/ui/input.js';
import { cn } from '../../lib/utils.js';
import { entryKey } from './knowledgeIndex.js';
import { matchesKnowledge, parseKnowledge, readableTitle, type KnowledgeKind } from './knowledgeEntries.js';

const KIND_LABEL: Record<KnowledgeKind, string> = { decision: 'Decision', gotcha: 'Gotcha', assumption: 'Assumption', question: 'Question', note: 'Note' };
const KIND_TONE: Record<KnowledgeKind, string> = { decision: 'ai', gotcha: 'needs', assumption: 'idle', question: 'reopened', note: 'idle' };
type Filter = 'all' | 'decision' | 'gotcha';

/**
 * What the assistants learned in this workspace, as entries: decisions with their reasons, and the gotchas that cost
 * time. Newest first, searchable, and filtered by kind. A file that does not use the entry format is shown as written.
 */
export function KnowledgeView({ markdown, focus }: {
  markdown: string;
  /**
   * An entry to come to (its `entryKey`; none stays at the top), asked for again by a larger `request`. Coming to it clears the
   * search and the filter, scrolls it into view and marks it for a moment. A new text of the file asks for nothing: what the
   * reader scrolled to, searched for and chose stays.
   */
  focus?: { entry?: string | null; request: number };
}) {
  const knowledge = useMemo(() => parseKnowledge(markdown), [markdown]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [wanted, setWanted] = useState<string | null>(null);
  const [marked, setMarked] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const handled = useRef<number | null>(null);
  const request = focus?.request ?? null;
  const focusEntry = focus?.entry ?? null;
  useEffect(() => {
    if (request === null || handled.current === request) return;
    handled.current = request;
    setQuery('');
    setFilter('all');
    setWanted(focusEntry);
  }, [request, focusEntry]);
  // The entry is drawn once the search and filter are clear: it is found then, and left alone afterwards
  useLayoutEffect(() => {
    if (!wanted) return;
    const row = Array.from(list.current?.querySelectorAll<HTMLElement>('[data-knowledge-entry]') ?? []).find((item) => item.dataset.knowledgeEntry === wanted);
    if (!row) { if (knowledge.entries.length) setWanted(null); return; }
    const scroller = row.closest<HTMLElement>('[data-knowledge-scroll]');
    if (scroller) scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
    else row.scrollIntoView({ block: 'start' });
    setMarked(wanted);
    setWanted(null);
  }, [wanted, query, filter, knowledge.entries]);
  useEffect(() => {
    if (!marked) return undefined;
    const timer = setTimeout(() => setMarked(null), 2400);
    return () => clearTimeout(timer);
  }, [marked]);
  if (!knowledge.entries.length) return <ChatMarkdown content={markdown} />;

  const counts = { decision: knowledge.entries.filter((entry) => entry.kind === 'decision').length, gotcha: knowledge.entries.filter((entry) => entry.kind === 'gotcha').length };
  const shown = knowledge.entries.filter((entry) => (filter === 'all' || entry.kind === filter) && matchesKnowledge(entry, query));
  const needle = query.trim().toLowerCase();
  const sections = filter === 'all' ? knowledge.sections.filter((part) => !needle || `${part.title}\n${part.text}`.toLowerCase().includes(needle)) : [];
  return (
    <div className="space-y-3">
      {knowledge.goal && (
        <section aria-label="Feature goal" className="rounded-lg border border-border bg-muted/40 px-3.5 py-2.5">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Feature goal</h3>
          <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90" title={knowledge.goal}>{knowledge.goal}</p>
        </section>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search the knowledge" placeholder="Search the knowledge…" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-8"
            onKeyDown={(event) => {
              // Escape clears the search first; with nothing to clear it is the reader's
              if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); }
            }} />
        </div>
        <div role="group" aria-label="Show" className="inline-flex rounded-md border border-border p-0.5">
          {([['all', `All ${knowledge.entries.length}`], ['decision', `Decisions ${counts.decision}`], ['gotcha', `Gotchas ${counts.gotcha}`]] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}
              className={cn('h-7 rounded px-2.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring', filter === value ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 && sections.length === 0 ? <p role="status" className="py-4 text-sm text-muted-foreground">Nothing matches.</p> : shown.length > 0 && (
        <ol ref={list} aria-label="Knowledge entries" className="space-y-2">
          {shown.map((entry) => (
            <li key={entry.id} data-knowledge-entry={entryKey(entry)}>
              <article data-marked={marked === entryKey(entry) ? 'true' : undefined} className={cn('rounded-lg border bg-card px-3.5 py-3 transition-colors', marked === entryKey(entry) ? 'border-ring ring-2 ring-ring/50' : 'border-border')}>
                <div className="flex items-center gap-2">
                  <span className="state-chip" data-tone={KIND_TONE[entry.kind]}>{KIND_LABEL[entry.kind]}</span>
                  {entry.date && <time dateTime={entry.date} className="text-[11px] text-muted-foreground">{entry.date}</time>}
                </div>
                <h3 className="mt-1.5 text-sm font-semibold text-foreground">{readableTitle(entry.title)}</h3>
                {entry.text && <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{entry.text}</p>}
                {(entry.scope || entry.evidence) && (
                  <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    {entry.scope && <span className="min-w-0 break-all">Applies to <code className="font-mono">{entry.scope}</code></span>}
                    {entry.evidence && <span>{entry.evidence}</span>}
                  </p>
                )}
              </article>
            </li>
          ))}
        </ol>
      )}
      {sections.map((part) => (
        <section key={part.title} aria-label={part.title} className="border-t border-border pt-3">
          <h3 className="mb-1 text-sm font-semibold text-foreground">{part.title}</h3>
          <ChatMarkdown content={part.text} />
        </section>
      ))}
    </div>
  );
}
