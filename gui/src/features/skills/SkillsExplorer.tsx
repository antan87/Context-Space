import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Search, X } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import {
  useQuarantineHarnessSkill,
  useQuarantinedHarnessSkills,
  useRevealSkillFolder,
  useRestoreHarnessSkill,
  type QuarantineEntryItem,
} from '../../lib/api/queries.js';
import type { SkillItem } from '../../types.js';

type Selection = { kind: 'skill'; key: string } | { kind: 'quarantine'; key: string } | null;

interface SkillsExplorerProps {
  skills: SkillItem[];
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  onEdit: (skill: SkillItem) => void;
  onDelete: (skill: SkillItem) => void;
  /** Opens the "move to a category" dialog for one of the catalog's own skills. */
  onMove: (skill: SkillItem, event: React.MouseEvent) => void;
}

const LIST_MIN_WIDTH = 240;
const LIST_MAX_WIDTH = 640;
const LIST_DEFAULT_WIDTH = 320;
const LIST_WIDTH_KEY = 'skills-explorer-list-width';

function clampWidth(width: number): number {
  return Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, Math.round(width)));
}

/** The width is a per-browser preference, so a storage failure just means the default is used. */
function readStoredWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(LIST_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : LIST_DEFAULT_WIDTH;
  } catch {
    return LIST_DEFAULT_WIDTH;
  }
}

function writeStoredWidth(width: number): void {
  try {
    window.localStorage.setItem(LIST_WIDTH_KEY, String(width));
  } catch {
    // Storage is unavailable (private window or blocked site data); the width still applies for this visit.
  }
}

/** Keys identify one row: the same skill id can exist in two tools, so an id alone is not enough. */
const skillKey = (skill: SkillItem) => `${skill.source?.harness ?? 'catalog'}:${skill.id}`;

/**
 * Global skills page: a list grouped by where each skill comes from (your catalog, each tool, and
 * quarantine), with a detail pane. Your catalog skills are edited and deleted; a tool's skills are
 * read-only here and can only be moved to quarantine and back.
 */
export function SkillsExplorer({ skills, showToast, onEdit, onDelete, onMove }: SkillsExplorerProps) {
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<Selection>(null);
  const [listWidth, setListWidth] = useState(() => readStoredWidth());
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const quarantine = useQuarantinedHarnessSkills();
  const quarantineSkill = useQuarantineHarnessSkill();
  const restoreSkill = useRestoreHarnessSkill();
  const revealSkill = useRevealSkillFolder();
  const entries = quarantine.data?.entries ?? [];

  const matches = (text: string) => !query.trim() || text.toLowerCase().includes(query.trim().toLowerCase());
  const visible = (skill: SkillItem) =>
    matches(`${skill.id} ${skill.title ?? ''} ${skill.description} ${skill.tags?.join(' ') ?? ''} ${skill.source?.label ?? ''}`);

  const catalog = skills.filter((s) => !s.source && visible(s));
  const toolGroups = new Map<string, { label: string; root: string; skills: SkillItem[] }>();
  for (const skill of skills) {
    if (!skill.source || !visible(skill)) continue;
    const group = toolGroups.get(skill.source.harness) ?? { label: skill.source.label, root: skill.source.root, skills: [] };
    group.skills.push(skill);
    toolGroups.set(skill.source.harness, group);
  }
  const tools = [...toolGroups.values()];

  const shownEntries = entries.filter((entry) => matches(`${entry.id} ${entry.label}`));
  const selectedSkill = selection?.kind === 'skill' ? skills.find((s) => skillKey(s) === selection.key) : undefined;
  const selectedEntry = selection?.kind === 'quarantine' ? entries.find((e) => `${e.id}:${e.quarantinedAt}` === selection.key) : undefined;

  const runQuarantine = async (skill: SkillItem) => {
    try {
      await quarantineSkill.mutateAsync(skill.id);
      setSelection(null);
      showToast?.(`Moved "${skill.id}" to quarantine. Restore it from the list any time.`, 'info');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : 'Could not move the skill', 'error');
    }
  };

  const runReveal = async (skill: SkillItem) => {
    try {
      await revealSkill.mutateAsync(skill);
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : 'Could not open the folder', 'error');
    }
  };

  const runRestore = async (entry: QuarantineEntryItem) => {
    try {
      await restoreSkill.mutateAsync(entry.id);
      setSelection(null);
      showToast?.(`Restored "${entry.id}".`, 'success');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : 'Could not restore the skill', 'error');
    }
  };

  const total = skills.length;
  const shown = catalog.length + tools.reduce((sum, tool) => sum + tool.skills.length, 0) + shownEntries.length;

  return (
    <div className="flex flex-1 min-h-0 border-t border-border/60">
      {/* List */}
      <aside aria-label="Skill list" style={{ width: listWidth }} className="shrink-0 flex flex-col min-h-0">
        <div className="p-3 border-b border-border/60">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none z-10" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills"
              aria-label="Search skills"
              className="pl-9 pr-8 h-9 text-xs"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Showing <strong className="text-foreground">{shown}</strong> of <strong className="text-foreground">{total}</strong> skills
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-4">
          <Section title="Your catalog" count={catalog.length}>
            {catalog.map((skill) => (
              <Row
                key={skillKey(skill)}
                title={skill.title || skill.id}
                subtitle={skill.id}
                active={selection?.kind === 'skill' && selection.key === skillKey(skill)}
                onClick={() => setSelection({ kind: 'skill', key: skillKey(skill) })}
              />
            ))}
          </Section>

          {tools.map((tool) => (
            <Section key={tool.label} title={tool.label} count={tool.skills.length}>
              {tool.skills.map((skill) => (
                <Row
                  key={skillKey(skill)}
                  title={skill.id}
                  subtitle={skill.description}
                  active={selection?.kind === 'skill' && selection.key === skillKey(skill)}
                  onClick={() => setSelection({ kind: 'skill', key: skillKey(skill) })}
                />
              ))}
            </Section>
          ))}

          {entries.length > 0 && (
            <Section title="Quarantine" count={shownEntries.length}>
              {shownEntries.map((entry) => (
                <Row
                  key={`${entry.id}:${entry.quarantinedAt}`}
                  title={entry.id}
                  subtitle={`From ${entry.label}`}
                  active={selection?.kind === 'quarantine' && selection.key === `${entry.id}:${entry.quarantinedAt}`}
                  onClick={() => setSelection({ kind: 'quarantine', key: `${entry.id}:${entry.quarantinedAt}` })}
                  tone="warning"
                />
              ))}
            </Section>
          )}

          {catalog.length === 0 && tools.length === 0 && shownEntries.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">No skills match “{query}”.</p>
          )}
        </div>
      </aside>

      {/* Drag handle: drag left or right to show full skill names. Keyboard: arrow keys. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize skill list"
        aria-valuemin={LIST_MIN_WIDTH}
        aria-valuemax={LIST_MAX_WIDTH}
        aria-valuenow={listWidth}
        tabIndex={0}
        onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
          dragStart.current = { x: event.clientX, width: listWidth };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
          if (!dragStart.current) return;
          setListWidth(clampWidth(dragStart.current.width + event.clientX - dragStart.current.x));
        }}
        onPointerUp={() => {
          if (dragStart.current) writeStoredWidth(listWidth);
          dragStart.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const next = clampWidth(listWidth + (event.key === 'ArrowRight' ? 16 : -16));
          setListWidth(next);
          writeStoredWidth(next);
        }}
        className="w-1.5 shrink-0 cursor-col-resize border-r border-border/60 hover:bg-primary/30 focus:outline-none focus-visible:bg-primary/40"
      />

      {/* Detail */}
      <section aria-label="Skill details" className="flex-1 min-w-0 overflow-y-auto p-6">
        {selectedSkill && (
          <SkillDetail
            skill={selectedSkill}
            onEdit={() => onEdit(selectedSkill)}
            onDelete={() => onDelete(selectedSkill)}
            onQuarantine={() => runQuarantine(selectedSkill)}
            busy={quarantineSkill.isPending}
            onOpenFolder={() => runReveal(selectedSkill)}
            openingFolder={revealSkill.isPending}
            onMove={(event) => onMove(selectedSkill, event)}
          />
        )}
        {selectedEntry && (
          <div className="max-w-2xl space-y-4">
            <h2 className="text-lg font-semibold">{selectedEntry.id}</h2>
            <p className="text-sm text-muted-foreground">
              Moved out of {selectedEntry.label}. {selectedEntry.label} no longer loads it. Restoring puts it back in its folder.
            </p>
            <dl className="text-xs grid grid-cols-[7rem_1fr] gap-y-2">
              <dt className="text-muted-foreground">Was at</dt>
              <dd className="font-mono break-all">{selectedEntry.originalPath}</dd>
              <dt className="text-muted-foreground">Moved</dt>
              <dd>{new Date(selectedEntry.quarantinedAt).toLocaleString()}</dd>
            </dl>
            <Button onClick={() => runRestore(selectedEntry)} disabled={restoreSkill.isPending}>
              Restore
            </Button>
          </div>
        )}
        {!selectedSkill && !selectedEntry && (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            Select a skill to see its details.
          </div>
        )}
      </section>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div>
      <div className="px-2 pb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>{title}</span>
        <span className="font-mono">{count}</span>
      </div>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function Row({
  title,
  subtitle,
  active,
  onClick,
  tone,
}: {
  title: string;
  subtitle?: string;
  active: boolean;
  onClick: () => void;
  tone?: 'warning';
}) {
  return (
    <li>
      <button
        onClick={onClick}
        aria-current={active ? 'true' : undefined}
        className={`w-full text-left rounded-md px-2 py-1.5 transition-colors ${
          active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'
        } ${tone === 'warning' ? 'border-l-2 border-amber-500' : ''}`}
      >
        <div className="text-sm font-medium truncate">{title}</div>
        {subtitle && <div className="text-[11px] text-muted-foreground truncate">{subtitle}</div>}
      </button>
    </li>
  );
}

function SkillDetail({
  skill,
  onEdit,
  onDelete,
  onQuarantine,
  busy,
  onOpenFolder,
  openingFolder,
  onMove,
}: {
  skill: SkillItem;
  onEdit: () => void;
  onDelete: () => void;
  onQuarantine: () => void;
  busy: boolean;
  onOpenFolder: () => void;
  openingFolder: boolean;
  onMove: (event: React.MouseEvent) => void;
}) {
  const fromTool = Boolean(skill.source);
  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{skill.title || skill.id}</h2>
          <p className="font-mono text-xs text-muted-foreground">{skill.id}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" onClick={onOpenFolder} disabled={openingFolder}>
            Open folder
          </Button>
          {fromTool ? (
            <Button variant="outline" onClick={onQuarantine} disabled={busy}>
              Move to quarantine
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={onMove} title="Move to another category" aria-label="Move to another category">
                Move to category
              </Button>
              <Button variant="outline" onClick={onEdit} title="Edit skill" aria-label="Edit skill">Edit</Button>
              <Button variant="outline" onClick={onDelete} title="Delete skill" aria-label="Delete skill">Delete</Button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge variant="outline" className="text-[10px]">{fromTool ? `Read-only · ${skill.source!.label}` : 'Your catalog · editable'}</Badge>
        {skill.category && <Badge variant="secondary" className="text-[10px]">{skill.category}</Badge>}
        {skill.tags?.map((tag) => (
          <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>
        ))}
      </div>

      {skill.description && <p className="text-sm">{skill.description}</p>}

      <dl className="text-xs grid grid-cols-[7rem_1fr] gap-y-2">
        {fromTool && (
          <>
            <dt className="text-muted-foreground">Folder</dt>
            <dd className="font-mono break-all">{skill.source!.root}/{skill.id}</dd>
          </>
        )}
        {skill.sourcePath && !fromTool && (
          <>
            <dt className="text-muted-foreground">Folder</dt>
            <dd className="font-mono break-all">{skill.sourcePath}</dd>
          </>
        )}
        {skill.references && skill.references.length > 0 && (
          <>
            <dt className="text-muted-foreground">References</dt>
            <dd>{skill.references.map((r) => r.name).join(', ')}</dd>
          </>
        )}
      </dl>

      {(skill.rawFile ?? skill.content) && <SkillFile skill={skill} />}
    </div>
  );
}

/** The SKILL.md file: rendered as Markdown by default, or the exact text. */
function SkillFile({ skill }: { skill: SkillItem }) {
  const [view, setView] = useState<'preview' | 'raw'>('preview');
  const raw = skill.rawFile ?? skill.content;
  const tabClass = (active: boolean) =>
    `px-2.5 py-1 text-xs rounded-md transition-colors ${active ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">SKILL.md</div>
        <div role="tablist" aria-label="SKILL.md view" className="flex gap-1">
          <button role="tab" aria-selected={view === 'preview'} className={tabClass(view === 'preview')} onClick={() => setView('preview')}>
            Preview
          </button>
          <button role="tab" aria-selected={view === 'raw'} className={tabClass(view === 'raw')} onClick={() => setView('raw')}>
            Raw
          </button>
        </div>
      </div>
      {view === 'raw' ? (
        <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap break-words">
          {raw}
        </pre>
      ) : (
        <div className="max-h-[60vh] overflow-auto rounded-md border border-border p-4 text-sm leading-relaxed space-y-3 break-words">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: (props) => <h1 className="text-xl font-semibold mt-2" {...props} />,
              h2: (props) => <h2 className="text-lg font-semibold mt-4" {...props} />,
              h3: (props) => <h3 className="text-base font-semibold mt-3" {...props} />,
              p: (props) => <p {...props} />,
              ul: (props) => <ul className="list-disc pl-5 space-y-1" {...props} />,
              ol: (props) => <ol className="list-decimal pl-5 space-y-1" {...props} />,
              a: (props) => <a className="underline text-primary" target="_blank" rel="noreferrer" {...props} />,
              code: ({ className, ...props }) => (
                <code className={`rounded bg-muted px-1 py-0.5 font-mono text-xs ${className ?? ''}`} {...props} />
              ),
              pre: (props) => <pre className="rounded-md bg-muted/50 p-3 overflow-x-auto text-xs font-mono" {...props} />,
              blockquote: (props) => <blockquote className="border-l-2 border-border pl-3 text-muted-foreground" {...props} />,
            }}
          >
            {skill.content || raw}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
