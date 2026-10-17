import { useState, type ReactNode } from 'react';
import { ChevronRight, Clock, ListPlus, Play, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Textarea } from '../../components/ui/textarea.js';
import { InlinePlanMarkdown } from '../../components/InlinePlanMarkdown.js';
import { usePlan, useChangePlan, useRunMilestoneCheck } from '../../lib/api/queries.js';
import { cn } from '../../lib/utils.js';
import { AddPlanItemDialog } from './AddPlanItem.js';
import { AnswerBox } from './AnswerBox.js';
import { PlanItemDetail } from './PlanItemDetail.js';
import {
  TONE_CLASS, changeText, itemLook, milestoneProgress, nameOf, proposalLine, questionWhy, shortCommits, stateLine, tasksUnderMilestones,
  visibleChanges, whenText, whoName,
} from './planView.js';
import type { PlanChangeInput, PlanItemView, PlanView } from './planTypes.js';

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return <section className="space-y-1.5">
    <h4 className="flex items-center gap-1.5 px-1 text-xs font-semibold text-foreground/80">
      <span>{title}</span>
      {hint && <><span className="font-normal text-muted-foreground">·</span> <span className="font-normal tracking-normal text-muted-foreground">{hint}</span></>}
    </h4>
    {children}
  </section>;
}

/** Who owns an item and when it last changed: "Claude · 2 h ago". */
function rowMeta(item: PlanItemView): string {
  const when = whenText(item.updatedAt);
  return [whoName(item.owner ?? 'user'), when].filter(Boolean).join(' · ');
}

/**
 * One item as a row: the whole row opens it. The status word starts the line under the name, so no legend
 * is needed; the code is in the tooltip. Tasks a milestone waits for are shown under it.
 */
function ItemRow({ item, view, selected, onOpen, onStart, nested }: {
  item: PlanItemView; view: PlanView; selected: boolean; onOpen: (item: PlanItemView) => void; onStart?: (item: PlanItemView) => void;
  /** The tasks shown under this milestone. */
  nested?: PlanItemView[];
}) {
  const { icon: Icon, tone } = itemLook(item);
  const finished = item.status === 'done' || item.status === 'dropped';
  const ready = Boolean(onStart) && view.ready.includes(item.label);
  const line = stateLine(item, view.words);
  return <li>
    <div className="flex items-start gap-1">
      <button type="button" onClick={() => onOpen(item)} aria-current={selected || undefined} title={item.label}
        className={cn('group flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring', selected && 'bg-accent/60')}>
        <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${TONE_CLASS[tone]}`} />
        <span className="min-w-0 flex-1">
          <span className={`text-xs font-medium leading-snug sm:text-[13px] ${finished ? 'text-muted-foreground line-through opacity-70' : 'text-foreground'}`}><InlinePlanMarkdown content={item.title} /></span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground" title={line}><InlinePlanMarkdown content={line} /></span>
        </span>
        <span className="hidden shrink-0 pt-0.5 text-[11px] text-muted-foreground sm:block">{rowMeta(item)}</span>
        <ChevronRight aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
      {ready && <Button size="xs" variant="outline" className="mt-1 h-7 shrink-0 px-2.5 text-xs" aria-label={`Start a session on ${item.label}`} onClick={() => onStart!(item)}><Play className="size-3" />Start</Button>}
    </div>
    {nested && nested.length > 0 && <ul aria-label={`Tasks for ${item.title}`} className="ml-[1.1rem] border-l border-border/60 pl-1.5">
      {nested.map((task) => <ItemRow key={task.id} item={task} view={view} selected={false} onOpen={onOpen} onStart={onStart} />)}
    </ul>}
  </li>;
}

type QuestionAction = 'later' | 'drop';
const QUESTION_ASK: Record<QuestionAction, string> = { later: 'When should it be looked at again?', drop: 'Why is it not needed any more?' };

/**
 * A question for the user, answered in place: who asked, when, why and what it holds up, the answers the AI
 * suggested, and a box that takes several lines. A stale question can be put off or dropped from here.
 */
function QuestionRow({ item, busy, readOnly, onChange, onOpen }: {
  item: PlanItemView; busy: boolean; readOnly: boolean; onChange: (change: PlanChangeInput) => Promise<boolean>; onOpen: () => void;
}) {
  const [asking, setAsking] = useState<QuestionAction | null>(null);
  const [reason, setReason] = useState('');
  const added = item.history?.find((entry) => entry.action === 'added');
  const asked = added ? `${whoName(added.by)} asked${whenText(added.at) ? ` ${whenText(added.at)}` : ''}` : 'Question';
  const holdsUp = item.holdsUp.map((label) => label.replace(/^\S+\s/, ''));
  const why = questionWhy(item.detail);

  return <li className="space-y-1.5 p-3">
    <div className="flex items-start justify-between gap-2">
      <p className="min-w-0 text-[11px] font-medium text-[var(--state-needs)]">
        {asked}{holdsUp.length ? <span className="font-normal text-muted-foreground"> · holds up {holdsUp.join(', ')}</span> : null}
      </p>
      {!readOnly && <div className="-my-1 flex shrink-0 items-center">
        <IconButton label="Put off…" icon={<Clock />} disabled={busy} onClick={() => { setAsking('later'); setReason(''); }} />
        <IconButton label="Drop…" icon={<Trash2 />} disabled={busy} onClick={() => { setAsking('drop'); setReason(''); }} />
      </div>}
    </div>
    <button type="button" title={item.label} className="block w-full text-left text-xs font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:text-[13px]" onClick={onOpen}>
      <span className="leading-snug"><InlinePlanMarkdown content={item.title} /></span>
    </button>
    {why && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{why}</p>}
    {!readOnly && (asking ? <form className="flex flex-wrap items-center gap-1.5" onSubmit={(event) => {
      event.preventDefault();
      const text = reason.trim();
      if (!text) return;
      void onChange(asking === 'later' ? { type: 'later', id: item.id, revisitWhen: text } : { type: 'drop', id: item.id, reason: text }).then((ok) => { if (ok) setAsking(null); });
    }}>
      <Input aria-label={QUESTION_ASK[asking]} autoFocus placeholder={QUESTION_ASK[asking]} className="h-7 min-w-48 flex-1 text-xs" value={reason} onChange={(event) => setReason(event.target.value)} />
      <Button size="xs" type="submit" disabled={busy || !reason.trim()}>{asking === 'later' ? 'Put off' : 'Drop'}</Button>
      <Button size="xs" type="button" variant="ghost" disabled={busy} onClick={() => setAsking(null)}>Cancel</Button>
    </form> : <AnswerBox question={item.title} detail={item.detail} busy={busy} onAnswer={(text) => onChange({ type: 'answer', id: item.id, answer: text })} />)}
  </li>;
}

/** A close an AI proposed under the earlier rule: the user accepts it or sends it back. */
function ProposalRow({ item, busy, readOnly, onAccept, onReject, onOpen }: {
  item: PlanItemView; busy: boolean; readOnly: boolean; onAccept: () => void; onReject: (reason: string) => Promise<boolean>; onOpen: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const proposal = item.proposal!;
  const withCheck = item.kind === 'milestone' && proposal.action === 'done' && Boolean(item.gate?.required || item.gate?.command);
  const yes = { done: 'Yes, it is done', answer: 'Use this answer', drop: 'Drop it', later: 'Move to later', reopen: 'Reopen it' }[proposal.action];
  return <li className="space-y-1.5 p-3">
    <p className="text-[11px] font-medium text-[var(--state-ai)]">{proposalLine(item)} · check and decide{whenText(proposal.at) ? ` · ${whenText(proposal.at)}` : ''}</p>
    <button type="button" title={item.label} className="block w-full text-left text-xs font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:text-[13px]" onClick={onOpen}>
      <span className="leading-snug"><InlinePlanMarkdown content={item.title} /></span>
    </button>
    <p className="border-l-2 border-[color-mix(in_oklab,var(--state-ai)_35%,transparent)] pl-2 text-xs italic leading-relaxed text-muted-foreground">“<InlinePlanMarkdown content={shortCommits(proposal.note)} />”</p>
    {!readOnly && (rejecting ? <div className="space-y-2 pt-0.5">
      <label className="block text-xs font-medium text-muted-foreground">What still needs doing?<Textarea className="mt-1 text-xs" autoFocus value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <div className="flex gap-1.5">
        <Button size="xs" className="h-7 px-2.5 text-xs font-medium" disabled={busy || !reason.trim()} onClick={() => void onReject(reason.trim()).then((ok) => ok && setRejecting(false))}>Send back to {whoName(proposal.by)}</Button>
        <Button size="xs" variant="ghost" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => setRejecting(false)}>Cancel</Button>
      </div>
    </div> : <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
      <Button size="xs" className="h-7 px-2.5 text-xs font-medium" disabled={busy} onClick={onAccept}>{busy && withCheck ? 'Running the check…' : yes}</Button>
      <Button size="xs" variant="outline" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => setRejecting(true)}>Not yet</Button>
      {withCheck && <span className="text-[11px] text-muted-foreground">Its check runs first.</span>}
    </div>)}
  </li>;
}

/**
 * The Plan tab: Needs you, Milestones in order with their tasks, Other open work, Done and dropped, What
 * changed. The same plan, in the same words, that AI tools read and change with `ctxspace plan`. An item
 * opens beside the list when there is room, and in its place when there is not.
 */
export function PlanChecklist({ workspaceId, readOnly = false, onChanged, onStartSession }: {
  workspaceId: string; readOnly?: boolean; onChanged?: () => void;
  /** Starts a session on a ready item; without it, rows have no Start. */
  onStartSession?: (item: PlanItemView) => void;
}) {
  const plan = usePlan(workspaceId);
  const change = useChangePlan(workspaceId);
  const runCheck = useRunMilestoneCheck(workspaceId);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [allChanges, setAllChanges] = useState(false);
  const [message, setMessage] = useState('');
  const view = plan.data;
  const error = change.error instanceof Error ? change.error.message : runCheck.error instanceof Error ? runCheck.error.message : undefined;

  const apply = async (input: PlanChangeInput): Promise<boolean> => {
    setMessage('');
    try {
      const result = await change.mutateAsync({ change: input, ifRevision: view?.revision });
      setMessage(result.message);
      onChanged?.();
      return true;
    } catch {
      return false;
    }
  };

  if (plan.isPending) return <div className="space-y-2" aria-label="Loading the plan"><Skeleton className="h-5 w-40" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>;
  if (!view) {
    return <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
      The plan could not be read: {plan.error instanceof Error ? plan.error.message : 'unknown error'}
      <Button size="xs" variant="outline" onClick={() => void plan.refetch()}><RefreshCw />Retry</Button>
    </div>;
  }

  const everything = [...view.needsYou, ...view.milestones, ...view.otherOpen, ...view.closed];
  const opened = openId ? everything.find((item) => item.id === openId) : undefined;
  const open = (item: PlanItemView) => { setOpenId(item.id); change.reset(); runCheck.reset(); };
  const close = () => { setOpenId(null); change.reset(); runCheck.reset(); };

  const progress = milestoneProgress(view);
  const counts = view.counts;
  const needsCount = view.needsYou?.length ?? counts.needsYou;
  const needsYouText = needsCount === 0 ? 'all clear' : needsCount === 1 ? '1 thing waits for you' : `${needsCount} things wait for you`;
  const { byMilestone, nested } = tasksUnderMilestones(view);
  const closedMilestones = new Set(view.milestones.filter((item) => item.status === 'done' || item.status === 'dropped').map((item) => item.id));
  const otherOpen = view.otherOpen.filter((item) => !nested.has(item.id));
  const closedOther = view.closed.filter((item) => !closedMilestones.has(item.id) && !nested.has(item.id));
  const changes = visibleChanges(view.changes);
  const shownChanges = allChanges ? changes : changes.slice(0, 6);
  const start = readOnly ? undefined : onStartSession;

  return <div className="@container">
    <div className={opened ? 'grid items-start gap-4 @min-[45rem]:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]' : ''}>
      <section aria-label="The plan" className={cn('space-y-4 rounded-xl border border-border/40 bg-card/60 px-4 py-3 shadow-2xs backdrop-blur-xs', opened && 'hidden @min-[45rem]:block')}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/30 px-1 pb-2.5">
          <h3 className="text-xs font-semibold text-foreground/85">Plan</h3>
          <p className="text-xs text-muted-foreground">{view.words.needsYou.label} {counts.needsYou} · {view.words.statuses.in_progress.label} {counts.inProgress} · {view.words.statuses.todo.label} {counts.todo} · {view.words.statuses.done.label} {counts.done}</p>
          <span className="flex-1" />
          {!readOnly && <IconButton label="Add to the plan" icon={<ListPlus size={14} />} className="text-muted-foreground hover:text-foreground" onClick={() => setAdding(true)} />}
        </header>
        {progress.total > 0 && <div className="px-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted/60" role="progressbar" aria-label="Milestones done" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
            <div className="h-full rounded-full bg-[var(--state-done)] transition-all duration-300" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
          <p className="mt-1 text-[11px] font-medium text-muted-foreground">{progress.done} of {progress.total} milestones done</p>
        </div>}
        {message && !opened && <p role="status" className="px-2 text-sm text-muted-foreground">{message}</p>}
        {error && !adding && !opened && <p role="alert" className="px-2 text-sm text-destructive">{error}</p>}

        <Section title={view.words.needsYou.label} hint={needsYouText}>
          {view.needsYou.length === 0 ? <p className="px-2 text-sm text-muted-foreground">Nothing needs you right now.</p> : (
            <div className="overflow-hidden rounded-xl border border-[color-mix(in_oklab,var(--state-needs)_25%,transparent)] bg-[color-mix(in_oklab,var(--state-needs)_3%,transparent)] shadow-2xs">
              <ul className="divide-y divide-border/50">
                {view.needsYou.map((item) => item.proposal
                  ? <ProposalRow key={item.id} item={item} busy={change.isPending} readOnly={readOnly} onOpen={() => open(item)}
                    onAccept={() => void apply({ type: 'accept', id: item.id })} onReject={(reason) => apply({ type: 'reject', id: item.id, reason })} />
                  : <QuestionRow key={item.id} item={item} busy={change.isPending} readOnly={readOnly} onOpen={() => open(item)} onChange={apply} />)}
              </ul>
            </div>
          )}
        </Section>

        <Section title="Milestones" hint="in order">
          {view.milestones.length === 0 ? <div className="flex items-center gap-2 px-2">
            <p className="text-sm text-muted-foreground">No milestones yet. Most work does not need them; add some when it has steps worth checking off.</p>
            {!readOnly && <Button size="xs" variant="outline" onClick={() => setAdding(true)}>Add a milestone</Button>}
          </div> : <ol>{view.milestones.map((item) => <ItemRow key={item.id} item={item} view={view} selected={item.id === openId} onOpen={open} onStart={start}
            nested={item.status === 'done' || item.status === 'dropped' ? undefined : byMilestone.get(item.id)} />)}</ol>}
        </Section>

        {otherOpen.length > 0 && <Section title="Other open work">
          <ul>{otherOpen.map((item) => <ItemRow key={item.id} item={item} view={view} selected={item.id === openId} onOpen={open} onStart={start} />)}</ul>
        </Section>}

        {closedOther.length > 0 && <Section title="Done and dropped" hint={<button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowDone(!showDone)}>
          {counts.done} done · {counts.dropped} dropped · {showDone ? 'hide' : 'show'}
        </button>}>
          {showDone && <ul>{closedOther.map((item) => <ItemRow key={item.id} item={item} view={view} selected={item.id === openId} onOpen={open} />)}</ul>}
        </Section>}

        {changes.length > 0 && <Section title="What changed">
          <ul className="space-y-1 px-2">{shownChanges.map((entry, index) => <li key={`${entry.at}-${entry.itemId}-${index}`} className="flex gap-2 text-sm">
            <span className="shrink-0 font-medium text-foreground">{whoName(entry.by)}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={shortCommits(changeText(entry, view.words))}>{shortCommits(changeText(entry, view.words).replace(entry.label, nameOf({ id: entry.itemId, label: entry.label })))}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{whenText(entry.at)}</span>
          </li>)}</ul>
          {changes.length > 6 && <button type="button" className="px-2 text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setAllChanges(!allChanges)}>
            {allChanges ? 'Show fewer' : 'Show more'}
          </button>}
        </Section>}
        {!readOnly && <AddPlanItemDialog view={view} open={adding} busy={change.isPending} error={adding ? error : undefined} onClose={() => { setAdding(false); change.reset(); }} onAdd={apply} />}
      </section>

      {opened && <PlanItemDetail item={opened} view={view} readOnly={readOnly} busy={change.isPending} checking={runCheck.isPending} error={error} message={message}
        onClose={close} onOpen={(id) => setOpenId(id)} onChange={apply} onRunCheck={() => runCheck.mutate(opened.id)} />}
    </div>
  </div>;
}
