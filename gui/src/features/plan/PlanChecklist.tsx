import { useState, type ReactNode } from 'react';
import { ChevronRight, CircleHelp, ListPlus, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Textarea } from '../../components/ui/textarea.js';
import { usePlan, useChangePlan, useRunMilestoneCheck } from '../../lib/api/queries.js';
import { AddPlanItemDialog } from './AddPlanItem.js';
import { HowItWorksDialog, StatusKey } from './HowItWorks.js';
import { PlanItemDetail } from './PlanItemDetail.js';
import { TONE_CLASS, changeText, howItWorksSeen, itemLook, milestoneProgress, proposalLine, stateLine, whenText, whoName } from './planView.js';
import type { PlanChangeInput, PlanItemView, PlanView } from './planTypes.js';

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return <section className="space-y-1">
    <h4 className="flex items-baseline gap-2 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}{hint && <span className="font-normal normal-case tracking-normal">{hint}</span>}</h4>
    {children}
  </section>;
}

/** One item as a row: the whole row opens it. Names first; the code is small. */
function ItemRow({ item, view, onOpen }: { item: PlanItemView; view: PlanView; onOpen: () => void }) {
  const { icon: Icon, tone } = itemLook(item);
  const finished = item.status === 'done' || item.status === 'dropped';
  return <li>
    <button type="button" onClick={onOpen} className="group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring">
      <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${TONE_CLASS[tone]}`} />
      <span className="min-w-0 flex-1">
        <span className={`text-sm ${finished ? 'text-muted-foreground' : 'text-foreground'}`}>{item.title}</span>
        <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{item.id}</span>
        <span className="block truncate text-xs text-muted-foreground" title={stateLine(item, view.words)}>{stateLine(item, view.words)}</span>
      </span>
      <ChevronRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
    </button>
  </li>;
}

/** A question for the user, answered in place. */
function QuestionRow({ item, busy, readOnly, onAnswer, onOpen }: {
  item: PlanItemView; busy: boolean; readOnly: boolean; onAnswer: (answer: string) => Promise<boolean>; onOpen: () => void;
}) {
  const [answer, setAnswer] = useState('');
  const asker = item.history?.find((entry) => entry.action === 'added')?.by;
  return <li className="space-y-1.5 rounded-lg border border-border/80 px-3 py-2">
    <p className="text-xs text-muted-foreground">Question{asker ? ` from ${whoName(asker)}` : ''}{item.holdsUp.length ? ` · holds up ${item.holdsUp.join(', ')}` : ''}</p>
    <button type="button" className="text-left text-sm font-medium text-foreground hover:underline" onClick={onOpen}>{item.title} <span className="font-mono text-[11px] font-normal text-muted-foreground">{item.id}</span></button>
    {!readOnly && <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void onAnswer(answer.trim()).then((ok) => ok && setAnswer('')); }}>
      <Input aria-label={`Your answer to ${item.title}`} className="h-8" placeholder="Your answer" value={answer} onChange={(event) => setAnswer(event.target.value)} />
      <Button size="sm" type="submit" disabled={busy || !answer.trim()}>Answer</Button>
    </form>}
  </li>;
}

/** An AI's close of the user's item or a milestone: the user accepts it or sends it back. */
function ProposalRow({ item, busy, readOnly, onAccept, onReject, onOpen }: {
  item: PlanItemView; busy: boolean; readOnly: boolean; onAccept: () => void; onReject: (reason: string) => Promise<boolean>; onOpen: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const proposal = item.proposal!;
  const withCheck = item.kind === 'milestone' && proposal.action === 'done' && Boolean(item.gate?.required || item.gate?.command);
  const yes = { done: 'Yes, it is done', answer: 'Use this answer', drop: 'Drop it', later: 'Move to later', reopen: 'Reopen it' }[proposal.action];
  return <li className="space-y-1.5 rounded-lg border border-border/80 px-3 py-2">
    <p className="text-xs text-muted-foreground">{proposalLine(item)} · check and decide</p>
    <button type="button" className="text-left text-sm font-medium text-foreground hover:underline" onClick={onOpen}>{item.title} <span className="font-mono text-[11px] font-normal text-muted-foreground">{item.id}</span></button>
    <p className="text-sm text-muted-foreground">“{proposal.note}”</p>
    {!readOnly && (rejecting ? <div className="space-y-2">
      <label className="block text-sm">What still needs doing?<Textarea className="mt-1" autoFocus value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !reason.trim()} onClick={() => void onReject(reason.trim()).then((ok) => ok && setRejecting(false))}>Send back to {whoName(proposal.by)}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>Cancel</Button>
      </div>
    </div> : <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={busy} onClick={onAccept}>{busy && withCheck ? 'Running the check…' : yes}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}>Not yet</Button>
      {withCheck && <span className="text-xs text-muted-foreground">Its check runs first.</span>}
    </div>)}
  </li>;
}

/**
 * The Plan tab: Needs you, Milestones in order, Other open work, Done and dropped, What changed. The
 * same plan, in the same words, that AI tools read and change with `ctxspace plan`.
 */
export function PlanChecklist({ workspaceId, readOnly = false, onChanged }: { workspaceId: string; readOnly?: boolean; onChanged?: () => void }) {
  const plan = usePlan(workspaceId);
  const change = useChangePlan(workspaceId);
  const runCheck = useRunMilestoneCheck(workspaceId);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [howOpen, setHowOpen] = useState(() => !howItWorksSeen());
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
  if (opened) {
    return <PlanItemDetail item={opened} view={view} readOnly={readOnly} busy={change.isPending} checking={runCheck.isPending} error={error}
      onBack={() => { setOpenId(null); change.reset(); runCheck.reset(); }} onChange={apply} onRunCheck={() => runCheck.mutate(opened.id)} />;
  }

  const progress = milestoneProgress(view);
  const counts = view.counts;
  const needsYouText = counts.needsYou === 0 ? 'all clear' : counts.needsYou === 1 ? '1 thing waits for you' : `${counts.needsYou} things wait for you`;
  const closedMilestones = new Set(view.milestones.filter((item) => item.status === 'done' || item.status === 'dropped').map((item) => item.id));
  const closedOther = view.closed.filter((item) => !closedMilestones.has(item.id));
  const changes = allChanges ? view.changes : view.changes.slice(0, 6);

  return <section aria-label="The plan" className="space-y-4 rounded-xl border border-border bg-card px-3 py-3">
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Plan</h3>
      <p className="text-xs text-muted-foreground">{view.words.needsYou.label} {counts.needsYou} · {view.words.statuses.in_progress.label} {counts.inProgress} · {view.words.statuses.todo.label} {counts.todo} · {view.words.statuses.done.label} {counts.done}</p>
      <span className="flex-1" />
      <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setHowOpen(true)}><CircleHelp />How it works</Button>
      {!readOnly && <IconButton label="Add to the plan" icon={<ListPlus />} className="text-muted-foreground" onClick={() => setAdding(true)} />}
    </header>
    {progress.total > 0 && <div className="px-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Milestones done" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
        <div className="h-full rounded-full bg-[var(--state-done)]" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{progress.done} of {progress.total} milestones done</p>
    </div>}
    {message && <p role="status" className="px-2 text-sm text-muted-foreground">{message}</p>}
    {error && !adding && <p role="alert" className="px-2 text-sm text-destructive">{error}</p>}

    <Section title={view.words.needsYou.label} hint={needsYouText}>
      {view.needsYou.length === 0 ? <p className="px-2 text-sm text-muted-foreground">Nothing needs you right now.</p> : <ul className="space-y-2">
        {view.needsYou.map((item) => item.proposal
          ? <ProposalRow key={item.id} item={item} busy={change.isPending} readOnly={readOnly} onOpen={() => setOpenId(item.id)}
            onAccept={() => void apply({ type: 'accept', id: item.id })} onReject={(reason) => apply({ type: 'reject', id: item.id, reason })} />
          : <QuestionRow key={item.id} item={item} busy={change.isPending} readOnly={readOnly} onOpen={() => setOpenId(item.id)}
            onAnswer={(answer) => apply({ type: 'answer', id: item.id, answer })} />)}
      </ul>}
    </Section>

    <Section title="Milestones" hint="in order">
      {view.milestones.length === 0 ? <div className="flex items-center gap-2 px-2">
        <p className="text-sm text-muted-foreground">No milestones yet. Most work does not need them; add some when it has steps worth checking off.</p>
        {!readOnly && <Button size="xs" variant="outline" onClick={() => setAdding(true)}>Add a milestone</Button>}
      </div> : <ol>{view.milestones.map((item) => <ItemRow key={item.id} item={item} view={view} onOpen={() => setOpenId(item.id)} />)}</ol>}
    </Section>

    {view.otherOpen.length > 0 && <Section title="Other open work">
      <ul>{view.otherOpen.map((item) => <ItemRow key={item.id} item={item} view={view} onOpen={() => setOpenId(item.id)} />)}</ul>
    </Section>}

    {closedOther.length > 0 && <Section title="Done and dropped" hint={<button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowDone(!showDone)}>
      {counts.done} done · {counts.dropped} dropped · {showDone ? 'hide' : 'show'}
    </button>}>
      {showDone && <ul>{closedOther.map((item) => <ItemRow key={item.id} item={item} view={view} onOpen={() => setOpenId(item.id)} />)}</ul>}
    </Section>}

    {view.changes.length > 0 && <Section title="What changed">
      <ul className="space-y-1 px-2">{changes.map((entry, index) => <li key={`${entry.at}-${entry.itemId}-${index}`} className="flex gap-2 text-sm">
        <span className="shrink-0 font-medium text-foreground">{whoName(entry.by)}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={changeText(entry, view.words)}>{changeText(entry, view.words)}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{whenText(entry.at)}</span>
      </li>)}</ul>
      {view.changes.length > 6 && <button type="button" className="px-2 text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setAllChanges(!allChanges)}>
        {allChanges ? 'Show fewer' : 'Show more'}
      </button>}
    </Section>}

    <div className="px-2"><StatusKey words={view.words} /></div>
    <HowItWorksDialog words={view.words} open={howOpen} onClose={() => setHowOpen(false)} />
    {!readOnly && <AddPlanItemDialog view={view} open={adding} busy={change.isPending} error={adding ? error : undefined} onClose={() => { setAdding(false); change.reset(); }} onAdd={apply} />}
  </section>;
}
