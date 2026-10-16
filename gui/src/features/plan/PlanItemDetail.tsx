import { useState, type ReactNode } from 'react';
import { ArrowLeft, Check, CircleSlash, Clock, Copy, Pencil, Play, RotateCcw, ShieldCheck, Trash2, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { TONE_CLASS, forYou, itemLook, nameOf, shortCommits, stateLine, whenText, whoName } from './planView.js';
import type { PlanChangeInput, PlanEvidence, PlanItemView, PlanView } from './planTypes.js';

/** A change that needs a reason, with the question the reason answers. */
type ReasonAction = 'done' | 'answer' | 'block' | 'later' | 'drop' | 'reopen';
const ASK: Record<ReasonAction, { button: string; question: string }> = {
  done: { button: 'Done…', question: 'What came out of it?' },
  answer: { button: 'Answer…', question: 'The answer' },
  block: { button: 'Mark blocked…', question: 'What is it stuck on?' },
  later: { button: 'Do later…', question: 'When to look at it again?' },
  drop: { button: 'Drop…', question: 'Why is it not needed?' },
  reopen: { button: 'Reopen…', question: 'What is wrong?' },
};
const ICON: Record<ReasonAction, ReactNode> = {
  done: <Check />, answer: <Check />, block: <CircleSlash />, later: <Clock />, drop: <Trash2 />, reopen: <RotateCcw />,
};

function changeFor(action: ReasonAction, id: string, text: string): PlanChangeInput {
  switch (action) {
    case 'done': return { type: 'done', id, resolution: text };
    case 'answer': return { type: 'answer', id, answer: text };
    case 'block': return { type: 'block', id, reason: text };
    case 'later': return { type: 'later', id, revisitWhen: text };
    case 'drop': return { type: 'drop', id, reason: text };
    case 'reopen': return { type: 'reopen', id, reason: text };
  }
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-1.5">
    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
    {children}
  </section>;
}

const isOpen = (item: Pick<PlanItemView, 'status'>) => item.status === 'todo' || item.status === 'in_progress' || item.status === 'blocked';

function CheckPart({ item, evidence, words, running, readOnly, onRun }: {
  item: PlanItemView; evidence?: PlanEvidence; words: PlanView['words']; running: boolean; readOnly: boolean; onRun: () => void;
}) {
  const command = item.gate?.command || (item.gate?.required ? 'the workspace tests' : '');
  if (!command) return null;
  const when = evidence ? whenText(evidence.at) : '';
  const result = !evidence ? 'Not run yet.'
    : `Last run ${evidence.canProgress ? 'passed' : evidence.lastVerificationStatus === 'timeout' ? 'stopped: it took too long' : 'failed'}`
      + `${evidence.lastVerificationSha ? ` · commit ${evidence.lastVerificationSha.slice(0, 7)}` : ''}${when ? ` · ${when}` : ''}.`;
  return <Part title="Check before it counts as done">
    <p className="text-sm"><code className="rounded bg-muted px-1 text-xs">{command}</code></p>
    <p className={`text-sm ${evidence ? (evidence.canProgress ? TONE_CLASS.done : TONE_CLASS.reopened) : 'text-muted-foreground'}`}>{result}</p>
    <p className="text-xs text-muted-foreground">{forYou(words.rules[2]!)}</p>
    {!readOnly && item.status === 'in_progress' && <Button size="xs" variant="outline" disabled={running} onClick={onRun}>
      <ShieldCheck className={running ? 'animate-spin' : ''} />{running ? 'Running the check…' : 'Run check now'}
    </Button>}
  </Part>;
}

/** Edits the name, what it delivers, its check, where the work is, and what it waits for. */
function EditForm({ item, view, busy, onSave, onCancel }: {
  item: PlanItemView; view: PlanView; busy: boolean; onSave: (change: PlanChangeInput) => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [detail, setDetail] = useState(item.detail ?? '');
  const [check, setCheck] = useState(item.gate?.command ?? '');
  const [needsCheck, setNeedsCheck] = useState(Boolean(item.gate?.required));
  const [repo, setRepo] = useState(item.links?.repo ?? '');
  const [branch, setBranch] = useState(item.links?.branch ?? '');
  const [workItem, setWorkItem] = useState(item.links?.workItem ?? '');
  const before = item.waitsFor.map((wait) => wait.id);
  const [waits, setWaits] = useState<string[]>(before);
  const candidates = [...view.milestones, ...view.otherOpen, ...view.needsYou.filter((other) => !view.milestones.includes(other))]
    .filter((other, index, all) => other.id !== item.id && all.findIndex((candidate) => candidate.id === other.id) === index);
  const isMilestone = item.kind === 'milestone';
  const save = () => {
    const links = { ...(repo.trim() ? { repo: repo.trim() } : {}), ...(branch.trim() ? { branch: branch.trim() } : {}), ...(workItem.trim() ? { workItem: workItem.trim() } : {}) };
    onSave({
      type: 'edit', id: item.id,
      ...(title.trim() !== item.title ? { title: title.trim() } : {}),
      ...(detail.trim() !== (item.detail ?? '') ? { detail: detail.trim() || null } : {}),
      ...(isMilestone ? { gate: needsCheck || check.trim() ? { required: needsCheck || Boolean(check.trim()), ...(check.trim() ? { command: check.trim() } : {}) } : null } : {}),
      ...(isMilestone ? { links } : {}),
      after: waits.filter((id) => !before.includes(id)),
      notAfter: before.filter((id) => !waits.includes(id)),
    });
  };
  return <div className="space-y-3">
    <label className="block text-sm">Name<Input className="mt-1" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label className="block text-sm">{isMilestone ? 'What it must deliver' : 'More about it'}<Textarea className="mt-1" value={detail} onChange={(event) => setDetail(event.target.value)} /></label>
    {isMilestone && <>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={needsCheck} onChange={(event) => setNeedsCheck(event.target.checked)} />Its check must pass before it counts as done</label>
      <label className="block text-sm">Check command (empty: the workspace tests)<Input className="mt-1" value={check} placeholder="npm test" onChange={(event) => setCheck(event.target.value)} /></label>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="text-sm">Repository<Input className="mt-1" value={repo} onChange={(event) => setRepo(event.target.value)} /></label>
        <label className="text-sm">Branch<Input className="mt-1" value={branch} onChange={(event) => setBranch(event.target.value)} /></label>
        <label className="text-sm">Work item or PR<Input className="mt-1" value={workItem} onChange={(event) => setWorkItem(event.target.value)} /></label>
      </div>
    </>}
    {candidates.length > 0 && <fieldset className="space-y-1">
      <legend className="mb-1 text-sm">Waits for</legend>
      {candidates.map((other) => <label key={other.id} className="flex items-center gap-2 text-sm" title={other.label}>
        <input type="checkbox" checked={waits.includes(other.id)} onChange={(event) => setWaits(event.target.checked ? [...waits, other.id] : waits.filter((id) => id !== other.id))} />
        {other.title}
      </label>)}
    </fieldset>}
    <div className="flex gap-2">
      <Button size="sm" disabled={busy || !title.trim()} onClick={save}>Save</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
    </div>
  </div>;
}

/**
 * One item opened: its main action beside its name, then what it must deliver, what it waits for and holds
 * up, its check, where the work is, and its history. Beside the list when there is room, else in its place.
 */
export function PlanItemDetail({ item, view, readOnly, busy, checking, error, message, onClose, onOpen, onChange, onRunCheck }: {
  item: PlanItemView;
  view: PlanView;
  readOnly: boolean;
  busy: boolean;
  checking: boolean;
  error?: string;
  /** What the last change did, said once. */
  message?: string;
  onClose: () => void;
  /** Opens another item, such as one this item waits for. */
  onOpen: (id: string) => void;
  onChange: (change: PlanChangeInput) => Promise<boolean>;
  onRunCheck: () => void;
}) {
  const [asking, setAsking] = useState<ReasonAction | null>(null);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const { words } = view;
  const { icon: Icon, tone } = itemLook(item);
  const kind = words.kinds[item.kind].label;
  const milestones = view.milestones.filter((milestone) => milestone.status !== 'dropped');
  const position = item.kind === 'milestone' ? milestones.findIndex((milestone) => milestone.id === item.id) : -1;
  const everything = [...view.needsYou, ...view.milestones, ...view.otherOpen, ...view.closed];
  const byId = (id: string) => everything.find((candidate) => candidate.id === id);
  const byLabel = (label: string) => everything.find((candidate) => candidate.label === label);
  const unsettled = item.waitsFor.some((wait) => wait.status !== 'done' && wait.status !== 'dropped');
  const closesWithCheck = item.kind === 'milestone' && Boolean(item.gate?.required || item.gate?.command);
  const needsYou = Boolean(item.proposal) || (item.kind === 'question' && item.status === 'todo' && item.owner === 'user');
  const submit = async (change: PlanChangeInput) => {
    if (await onChange(change)) { setAsking(null); setReason(''); setEditing(false); }
  };

  // The one main action, labelled beside the name; the rest are icons with tooltips.
  const startable = item.status === 'todo' && item.kind !== 'question';
  const main: ReasonAction | 'start' | null = readOnly || editing ? null
    : startable ? 'start'
      : isOpen(item) ? (item.kind === 'question' ? 'answer' : item.kind !== 'milestone' || item.status === 'in_progress' ? 'done' : null)
        : 'reopen';
  const others: ReasonAction[] = readOnly || editing || !isOpen(item) ? []
    : [...(startable && item.kind !== 'milestone' ? ['done' as const] : []), ...(item.status !== 'blocked' ? ['block' as const] : []), 'later', 'drop'];

  return <section aria-label={`${kind} ${item.label}`} className="space-y-4 rounded-xl border border-border bg-card px-4 py-3 @min-[45rem]:sticky @min-[45rem]:top-2 @min-[45rem]:max-h-[calc(100vh-10rem)] @min-[45rem]:overflow-y-auto">
    <Button size="xs" variant="ghost" className="-ml-2 text-muted-foreground @min-[45rem]:hidden" onClick={onClose}><ArrowLeft />Back to the plan</Button>
    {/* Where it is and what can be done with it on one line, right above its name, which keeps the whole width. */}
    <header className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span>{position >= 0 ? `Milestone ${position + 1} of ${milestones.length}` : kind}</span>
        <span className={`inline-flex items-center gap-1 font-medium ${TONE_CLASS[tone]}`}><Icon aria-hidden="true" className="size-3.5" />{needsYou ? words.needsYou.label : words.statuses[item.status].label}</span>
      </p>
      <div className="flex shrink-0 items-center gap-0.5">
        {main === 'start' && <Button size="xs" disabled={busy || unsettled} title={unsettled ? 'It waits for items that are not done yet' : undefined} onClick={() => void submit({ type: 'start', id: item.id })}><Play />Start</Button>}
        {main && main !== 'start' && <Button size="xs" variant="outline" disabled={busy} onClick={() => setAsking(main)}>{ICON[main]}{ASK[main].button}</Button>}
        {others.map((action) => <IconButton key={action} label={ASK[action].button} icon={ICON[action]} disabled={busy} onClick={() => setAsking(action)} />)}
        {!readOnly && !editing && <IconButton label="Edit" icon={<Pencil />} disabled={busy} onClick={() => setEditing(true)} />}
        <IconButton label={copied ? `Copied ${item.id}` : `Copy the code ${item.id}, to name it to an AI`} icon={copied ? <Check /> : <Copy />}
          onClick={async () => { if (await safeCopyToClipboard(item.id)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }} />
        <IconButton label="Close" icon={<X />} className="hidden @min-[45rem]:inline-flex" onClick={onClose} />
      </div>
      </div>
      <h3 className="text-base font-semibold text-foreground">{item.title}</h3>
      <p className="text-sm text-muted-foreground">{stateLine(item, words)}</p>
    </header>

    {asking && <div className="space-y-2 rounded-lg border border-border p-3">
      <label className="block text-sm">{ASK[asking].question}<Textarea className="mt-1" autoFocus value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      {asking === 'done' && closesWithCheck && <p className="text-xs text-muted-foreground">Its check runs first; it is done only if the check passes.</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !reason.trim()} onClick={() => void submit(changeFor(asking, item.id, reason.trim()))}>
          {busy ? (asking === 'done' && closesWithCheck ? 'Running the check…' : 'Saving…') : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setAsking(null); setReason(''); }}>Cancel</Button>
      </div>
    </div>}
    {message && !asking && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

    {editing ? <EditForm item={item} view={view} busy={busy} onSave={(change) => void submit(change)} onCancel={() => setEditing(false)} /> : <>
      {item.detail && <Part title={item.kind === 'milestone' ? 'What it must deliver' : 'More about it'}><p className="whitespace-pre-wrap text-sm">{item.detail}</p></Part>}
      {item.waitsFor.length > 0 && <Part title="Waits for">
        <ul className="space-y-1">{item.waitsFor.map((wait) => {
          const other = byId(wait.id);
          const look = other ? itemLook(other) : null;
          return <li key={wait.id}>
            <button type="button" title={wait.label} disabled={!other} onClick={() => onOpen(wait.id)} className="flex w-full items-start gap-2 rounded-md px-1 py-0.5 text-left text-sm hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default">
              {look && <look.icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${TONE_CLASS[look.tone]}`} />}
              <span className="min-w-0">{other?.title ?? nameOf(wait)}
                {other && <span className="block text-xs text-muted-foreground">{stateLine(other, words)}</span>}</span>
            </button>
          </li>;
        })}</ul>
      </Part>}
      {item.holdsUp.length > 0 && <Part title="Holds up"><p className="text-sm">{item.holdsUp.map((label) => byLabel(label)?.title ?? label).join(', ')}</p></Part>}
      {item.kind === 'milestone' && <CheckPart item={item} evidence={view.evidence[item.id]} words={words} running={checking} readOnly={readOnly} onRun={onRunCheck} />}
      {(item.links?.repo || item.links?.branch || item.links?.workItem || item.owner) && <Part title="Where the work is">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-sm">
          {item.links?.repo && <><dt className="text-muted-foreground">Repository</dt><dd>{item.links.repo}</dd></>}
          {item.links?.branch && <><dt className="text-muted-foreground">Branch</dt><dd className="font-mono text-xs">{item.links.branch}</dd></>}
          {item.links?.workItem && <><dt className="text-muted-foreground">Work item or PR</dt><dd>{item.links.workItem}</dd></>}
          {item.owner && <><dt className="text-muted-foreground">Owner</dt><dd>{whoName(item.owner)}</dd></>}
        </dl>
      </Part>}
      {Boolean(item.history?.length) && <Part title="History">
        <ol className="space-y-1.5">{[...item.history!].reverse().map((entry, index) => <li key={`${entry.at}-${index}`} className="text-sm">
          <span className="text-xs text-muted-foreground">{[whenText(entry.at), whoName(entry.by)].filter(Boolean).join(' · ')}</span>
          <span className="block">{words.changes[entry.action] ?? entry.action}{entry.note ? `: ${shortCommits(entry.note)}` : ''}</span>
        </li>)}</ol>
      </Part>}
    </>}
  </section>;
}
