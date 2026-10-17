import { useId, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, CircleHelp, FileText, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { ChatMarkdown, type MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { InlinePlanMarkdown } from '../../components/InlinePlanMarkdown.js';
import { API_BASE } from '../../lib/apiBase.js';
import { cn } from '../../lib/utils.js';
import { goToWorkspace } from '../chat/chatRoute.js';
import { documentRequests } from '../workspace-shell/openRequests.js';
import { AnswerBox } from './AnswerBox.js';
import { changeLine, proofLook, stepsDone, useChangePlanFile, usePlanFile, type PlanFileChangeInput, type PlanFileCheckpoint, type PlanFileDecision, type PlanFileStep } from './planFile.js';
import { questionWhy, whenText } from './planView.js';

const TONE = { done: 'text-[var(--state-done)]', failed: 'text-[var(--state-reopened)]', quiet: 'text-muted-foreground' } as const;

type Apply = (change: PlanFileChangeInput) => Promise<boolean>;

function StepRow({ step, busy, readOnly, onApply }: { step: PlanFileStep; busy: boolean; readOnly: boolean; onApply: Apply }) {
  return <li className="flex items-start gap-2.5 py-1">
    <Checkbox className="mt-0.5" checked={step.done} disabled={busy || readOnly} aria-label={step.text}
      onCheckedChange={(done) => void onApply({ type: 'tick', key: step.key, done, expected: step.text })} />
    <span className={cn('min-w-0 flex-1 break-words text-sm leading-snug', step.done ? 'text-muted-foreground line-through decoration-muted-foreground/40' : 'text-foreground')}>
      <InlinePlanMarkdown content={step.text} />
    </span>
  </li>;
}

/** A decision only the user can make: open, it is answered here; answered, it says what was decided. */
function DecisionRow({ decision, holdsUp, readOnly, onApply }: { decision: PlanFileDecision; holdsUp?: string; readOnly: boolean; onApply: Apply }) {
  const titleId = useId();
  if (decision.done) {
    return <li className="flex items-start gap-2.5 py-1 text-sm">
      <CircleHelp aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 break-words text-muted-foreground">
        <InlinePlanMarkdown content={decision.question} />
        {decision.answer && <> <span className="text-foreground">— {decision.answer}</span></>}
      </span>
    </li>;
  }
  const why = questionWhy(decision.detail);
  return <li className="py-1">
    <div role="group" aria-labelledby={titleId} className="space-y-2 rounded-lg border border-[color-mix(in_oklab,var(--state-needs)_40%,transparent)] bg-[color-mix(in_oklab,var(--state-needs)_5%,var(--card))] px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleHelp aria-hidden="true" className="size-3.5 shrink-0 text-[var(--state-needs)]" />
        {holdsUp ? <>Waits for you · holds up {holdsUp}</> : 'Waits for you'}
      </p>
      <p id={titleId} className="break-words text-[15px] font-medium leading-snug text-foreground"><InlinePlanMarkdown content={decision.question} /></p>
      {why && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{why}</p>}
      {decision.ifNoAnswer && <p className="text-xs text-muted-foreground">If you don’t answer: {decision.ifNoAnswer}</p>}
      {!readOnly && <AnswerBox question={decision.question} detail={decision.suggested.length ? `Suggested answers: ${decision.suggested.join(' · ')}` : undefined}
        onAnswer={(answer) => onApply({ type: 'answer', key: decision.key, answer, expected: decision.question })} />}
    </div>
  </li>;
}

function AddStep({ checkpoint, busy, onApply }: { checkpoint?: string; busy: boolean; onApply: Apply }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  if (!open) {
    return <button type="button" className="mt-1 inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setOpen(true)}>
      <Plus aria-hidden="true" className="size-3.5" />Add a step
    </button>;
  }
  const submit = () => {
    const step = text.trim();
    if (step) void onApply({ type: 'add', step, ...(checkpoint ? { checkpoint } : {}) }).then((ok) => { if (ok) { setText(''); setOpen(false); } });
  };
  return <form className="mt-1 flex items-center gap-1.5" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <Input autoFocus aria-label="The new step" placeholder="What needs doing" value={text} className="h-7 flex-1 text-xs"
      onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }} />
    <Button size="xs" type="submit" disabled={busy || !text.trim()}>Add</Button>
    <Button size="xs" type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
  </form>;
}

/** A checkpoint: something someone could demo, its proof, its steps and the decisions it waits for. Done, it folds. */
function CheckpointCard({ checkpoint, busy, checking, readOnly, onApply, onCheck }: {
  checkpoint: PlanFileCheckpoint; busy: boolean; checking: boolean; readOnly: boolean; onApply: Apply; onCheck: () => void;
}) {
  const [unfolded, setUnfolded] = useState(false);
  const open = !checkpoint.done || unfolded;
  const progress = stepsDone(checkpoint);
  const proof = proofLook(checkpoint);
  return <li className={cn('rounded-xl border px-3.5 py-3', checkpoint.done ? 'border-border/40 bg-card/40' : 'border-border bg-card shadow-2xs')}>
    <div className="flex items-start gap-2.5">
      <Checkbox className="mt-0.5" checked={checkpoint.done} disabled={busy || readOnly || checking} aria-label={checkpoint.title}
        title={checkpoint.check !== undefined && !checkpoint.done ? 'Runs its check first: ticked only when it passes' : undefined}
        onCheckedChange={(done) => void onApply({ type: 'tick', key: checkpoint.key, done, expected: checkpoint.title })} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h4 className={cn('min-w-0 break-words text-sm font-semibold leading-snug', checkpoint.done ? 'text-muted-foreground' : 'text-foreground')}>
            <InlinePlanMarkdown content={checkpoint.title} />
          </h4>
          {progress.total > 0 && !checkpoint.done && <span className="text-xs text-muted-foreground">{progress.done} of {progress.total} steps</span>}
        </div>
        {(proof || checking) && <p className="flex flex-wrap items-center gap-1.5 text-xs">
          <ShieldCheck aria-hidden="true" className={cn('size-3.5', checking ? 'animate-pulse text-muted-foreground' : TONE[proof!.tone])} />
          <span className={checking ? 'text-muted-foreground' : TONE[proof!.tone]}>{checking ? 'Running the check…' : proof!.text}</span>
          {!readOnly && !checking && checkpoint.check !== undefined && <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={onCheck}>Run it now</button>}
        </p>}
        {checkpoint.done && checkpoint.outcome && <p className="break-words text-xs text-muted-foreground"><InlinePlanMarkdown content={checkpoint.outcome} /></p>}
        {open && checkpoint.detail && <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground" title={checkpoint.detail}>{checkpoint.detail}</p>}
        {checkpoint.done && (checkpoint.steps.length > 0 || checkpoint.decisions.length > 0) && <button type="button" aria-expanded={unfolded}
          className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setUnfolded(!unfolded)}>
          <ChevronRight aria-hidden="true" className={cn('size-3.5 transition-transform', unfolded && 'rotate-90')} />{unfolded ? 'Hide its steps' : 'Show its steps'}
        </button>}
        {open && (checkpoint.steps.length > 0 || checkpoint.decisions.length > 0) && <ul className="pt-1">
          {checkpoint.steps.map((step) => <StepRow key={step.key} step={step} busy={busy} readOnly={readOnly} onApply={onApply} />)}
          {checkpoint.decisions.map((decision) => <DecisionRow key={decision.key} decision={decision} holdsUp={checkpoint.done ? undefined : checkpoint.title} readOnly={readOnly} onApply={onApply} />)}
        </ul>}
        {open && !checkpoint.done && !readOnly && <AddStep checkpoint={checkpoint.key} busy={busy} onApply={onApply} />}
      </div>
    </div>
  </li>;
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return <section className="space-y-2">
    <div className="flex items-baseline gap-2 px-1">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
    {children}
  </section>;
}

/**
 * The Plan tab: PLAN.md, the plan any AI or person edits directly, as a document. Its free text reads as written;
 * its checkpoints, steps and decisions can be ticked and answered here, and each checkpoint shows what its check
 * proved. Every change goes into the file, where the AIs read it.
 */
export function PlanDocument({ workspaceId, workspacePath, readOnly = false, onChanged }: {
  workspaceId: string; workspacePath?: string; readOnly?: boolean; onChanged?: () => void;
}) {
  const plan = usePlanFile(workspaceId);
  const change = useChangePlanFile(workspaceId);
  const navigate = useNavigate();
  const [checking, setChecking] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [showDoneSteps, setShowDoneSteps] = useState(false);
  const [allChanges, setAllChanges] = useState(false);
  const view = plan.data;
  const error = change.error instanceof Error ? change.error.message : undefined;

  const links = useMemo<MarkdownDocumentLinks>(() => ({
    workspaceRoot: workspacePath,
    documentPath: 'PLAN.md',
    fileUrl: (name) => `${API_BASE}/api/workspace/${encodeURIComponent(workspaceId)}/documents/file?name=${encodeURIComponent(name)}`,
    onOpenFile: (name) => { documentRequests.open(workspaceId, { name }); goToWorkspace(navigate, workspaceId, 'documents'); },
  }), [navigate, workspaceId, workspacePath]);

  const apply: Apply = async (input) => {
    setMessage('');
    const checkpointCheck = input.type === 'check' || (input.type === 'tick' && input.done && view?.checkpoints.some((checkpoint) => checkpoint.key === input.key && checkpoint.check !== undefined));
    if (checkpointCheck) setChecking(input.key);
    try {
      const result = await change.mutateAsync(input);
      setMessage(result.message);
      onChanged?.();
      return true;
    } catch {
      return false;
    } finally {
      if (checkpointCheck) setChecking(null);
    }
  };

  if (plan.isPending) return <div className="space-y-2" aria-label="Loading the plan"><Skeleton className="h-5 w-40" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>;
  if (!view) {
    return <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
      The plan could not be read: {plan.error instanceof Error ? plan.error.message : 'unknown error'}
      <Button size="xs" variant="outline" onClick={() => void plan.refetch()}><RefreshCw />Retry</Button>
    </div>;
  }

  const done = view.checkpoints.filter((checkpoint) => checkpoint.done).length;
  const waiting = view.waiting.length;
  const summary = [
    view.checkpoints.length ? `${done} of ${view.checkpoints.length} checkpoints done` : '',
    waiting ? `${waiting} ${waiting === 1 ? 'decision waits' : 'decisions wait'} for you` : '',
  ].filter(Boolean).join(' · ');
  const openSteps = view.steps.filter((step) => !step.done);
  const doneSteps = view.steps.filter((step) => step.done);
  const openDecisions = view.decisions.filter((decision) => !decision.done);
  const decided = view.decisions.filter((decision) => decision.done);
  const shownChanges = allChanges ? view.changes : view.changes.slice(0, 5);
  const busy = change.isPending;

  return <section aria-label="The plan" className="space-y-5 rounded-xl border border-border/40 bg-card/60 px-4 py-3.5 shadow-2xs backdrop-blur-xs">
    <header className="flex flex-wrap items-start gap-x-3 gap-y-1.5 border-b border-border/30 pb-3">
      <div className="min-w-0 flex-1">
        <h2 className="break-words text-base font-semibold text-foreground">{view.title || 'Plan'}</h2>
        {summary && <p className="mt-0.5 text-xs text-muted-foreground">{summary}</p>}
      </div>
      {view.source === 'file' && <IconButton label="Open PLAN.md in Docs" icon={<FileText size={14} />} className="text-muted-foreground hover:text-foreground" onClick={() => links.onOpenFile('PLAN.md')} />}
    </header>

    {view.source === 'none' && <div className="space-y-2 px-1">
      <p className="text-sm text-muted-foreground">No plan yet. When the work has steps worth checking off, an AI writes PLAN.md: what it is for, the checkpoints you could demo, and the steps under each.</p>
      {!readOnly && <AddStep busy={busy} onApply={apply} />}
    </div>}

    {view.intro && <div className="px-1"><ChatMarkdown content={view.intro} links={links} /></div>}

    {view.checkpoints.length > 0 && <div className="px-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted/60" role="progressbar" aria-label="Checkpoints done" aria-valuemin={0} aria-valuemax={view.checkpoints.length} aria-valuenow={done}>
        <div className="h-full rounded-full bg-[var(--state-done)] transition-all duration-300" style={{ width: `${(done / view.checkpoints.length) * 100}%` }} />
      </div>
    </div>}
    {message && <p role="status" className="px-1 text-sm text-muted-foreground">{message}</p>}
    {error && <p role="alert" className="px-1 text-sm text-destructive">{error}</p>}

    {view.checkpoints.length > 0 && <Section title="Checkpoints" hint="what you could demo">
      <ol className="space-y-2">{view.checkpoints.map((checkpoint) => <CheckpointCard key={checkpoint.key} checkpoint={checkpoint} busy={busy}
        checking={checking === checkpoint.key} readOnly={readOnly} onApply={apply} onCheck={() => void apply({ type: 'check', key: checkpoint.key })} />)}</ol>
    </Section>}

    {(openDecisions.length > 0 || decided.length > 0) && <Section title="Decisions" hint={openDecisions.length ? 'nothing in particular waits for these' : undefined}>
      <ul className="px-1">
        {openDecisions.map((decision) => <DecisionRow key={decision.key} decision={decision} readOnly={readOnly} onApply={apply} />)}
        {decided.map((decision) => <DecisionRow key={decision.key} decision={decision} readOnly={readOnly} onApply={apply} />)}
      </ul>
    </Section>}

    {(view.steps.length > 0) && <Section title={view.checkpoints.length ? 'Other steps' : 'Steps'} hint={doneSteps.length ? <button type="button" className="underline-offset-2 hover:underline" onClick={() => setShowDoneSteps(!showDoneSteps)}>
      {doneSteps.length} done · {showDoneSteps ? 'hide' : 'show'}
    </button> : undefined}>
      <ul className="px-1">
        {openSteps.map((step) => <StepRow key={step.key} step={step} busy={busy} readOnly={readOnly} onApply={apply} />)}
        {showDoneSteps && doneSteps.map((step) => <StepRow key={step.key} step={step} busy={busy} readOnly={readOnly} onApply={apply} />)}
      </ul>
      {!readOnly && <div className="px-1"><AddStep busy={busy} onApply={apply} /></div>}
    </Section>}

    {view.sections.length > 0 && <Section title="More in PLAN.md">
      <div className="space-y-1 px-1">{view.sections.map((section) => <details key={section.heading} className="group rounded-lg border border-border/40 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-foreground">{section.heading}</summary>
        <div className="mt-2"><ChatMarkdown content={section.body} links={links} /></div>
      </details>)}</div>
    </Section>}

    {view.changes.length > 0 && <Section title="What changed">
      <ul className="space-y-1 px-1">{shownChanges.map((entry, index) => <li key={`${entry.at}-${entry.key}-${index}`} className="flex gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={changeLine(entry)}>{changeLine(entry)}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{whenText(entry.at)}</span>
      </li>)}</ul>
      {view.changes.length > 5 && <button type="button" className="px-1 text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setAllChanges(!allChanges)}>
        {allChanges ? 'Show fewer' : 'Show more'}
      </button>}
    </Section>}
  </section>;
}
