import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, CircleHelp, CornerDownLeft, RotateCcw, X } from 'lucide-react';

import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import type { MilestoneFact, MilestoneState, ProgressFacts, RepoChangeListing, WorkGuidance } from '../../types.js';
import type { PlanItemView } from '../plan/planTypes.js';
import { checkIsFailing, formatAge, verificationLine, type ActiveProposal, type StripTone } from './progressView.js';
import { questionContext } from './stripPlan.js';

/** Mirrors the backend's limit on a reopen reason. */
export const REOPEN_REASON_MAX = 500;
/** Most changed files listed before the rest are summed up. */
const TOUCHED_LIST_MAX = 25;

const STATE_WORD: Record<MilestoneState, string> = { done: 'Done', in_progress: 'In progress', reopened: 'Reopened', blocked: 'Blocked', upcoming: 'Not started' };
const STATE_TONE: Record<MilestoneState, StripTone> = { done: 'done', in_progress: 'ai', reopened: 'reopened', blocked: 'needs', upcoming: 'idle' };
const MINUS = '−';

const Heading = ({ id, children, action }: { id: string; children: string; action?: ReactNode }) => (
  <div className="mb-1.5 flex min-h-6 items-center justify-between gap-2">
    <h3 id={id} className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>
    {action}
  </div>
);

export interface ReopenFormProps {
  id: string;
  title: string;
  reason: string;
  pending: boolean;
  error?: string;
  onChange: (reason: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** Asks why a finished milestone needs another go. The reason is required and travels with the milestone. */
export function ReopenForm({ id, title, reason, pending, error, onChange, onSubmit, onCancel }: ReopenFormProps) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  return (
    <form
      className="mt-1.5 flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-2"
      onSubmit={(event) => { event.preventDefault(); if (reason.trim() && !pending) onSubmit(); }}
    >
      <label htmlFor={id} className="text-xs font-medium">Why does &ldquo;{title}&rdquo; need rework?</label>
      <Input id={id} ref={field} value={reason} maxLength={REOPEN_REASON_MAX} required onChange={(event) => onChange(event.target.value)} placeholder="What is missing or wrong" />
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-1.5">
        <Button type="submit" size="xs" disabled={!reason.trim() || pending}>{pending ? 'Reopening...' : 'Reopen milestone'}</Button>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/** A question in the plan, answered from the panel. The box takes several lines; Ctrl+Enter sends it. */
function PlanQuestion({ item, onAnswer }: { item: PlanItemView; onAnswer: (id: string, answer: string) => Promise<boolean> }) {
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const submit = () => {
    const text = answer.trim();
    if (!text || sending) return;
    setSending(true);
    void onAnswer(item.id, text).then((ok) => { setSending(false); if (ok) setAnswer(''); });
  };
  return (
    <li className="rounded-md border border-border p-2">
      <p className="text-[11px] text-muted-foreground">{questionContext(item)}</p>
      <p className="mt-0.5 whitespace-pre-wrap break-words">{item.title}</p>
      <form className="mt-1.5 flex items-end gap-1.5" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Textarea aria-label={`Your answer to ${item.title}`} rows={1} value={answer} placeholder="Your answer" className="max-h-32 flex-1 text-xs" style={{ minHeight: '2rem' }}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); } }} />
        <Button type="submit" size="xs" disabled={sending || !answer.trim()}>{sending ? 'Saving…' : 'Answer'}</Button>
      </form>
    </li>
  );
}

function milestoneNotes(milestone: MilestoneFact, titles: ReadonlyMap<string, string>, now: number): string[] {
  const notes: string[] = [];
  if (milestone.reopen) {
    const who = milestone.reopen.by === 'agent' ? 'the AI' : 'you';
    const when = formatAge(milestone.reopen.at, now);
    notes.push(`Reopened by ${who}${when ? ` ${when}` : ''}${milestone.reopen.reason ? `: ${milestone.reopen.reason}` : ''}`);
  } else if (milestone.state === 'done' && milestone.reopenCount > 0) {
    notes.push(`Reopened ${milestone.reopenCount === 1 ? 'once' : `${milestone.reopenCount} times`} before`);
  }
  if (milestone.state === 'blocked') notes.push(milestone.blockedReason ?? milestone.unblockCondition ?? 'No reason was given.');
  if (milestone.state === 'upcoming' && milestone.waitingOn.length) notes.push(`Waiting on ${milestone.waitingOn.map((id) => `"${titles.get(id) ?? id}"`).join(', ')}`);
  if (milestone.verified && milestone.state !== 'upcoming') notes.push('Checks passed');
  return notes;
}

export interface ProgressPanelProps {
  id: string;
  facts: ProgressFacts;
  guidance?: WorkGuidance;
  proposals: readonly ActiveProposal[];
  /** The files changed in each repository, or undefined while they load. */
  changes?: readonly RepoChangeListing[];
  changesError?: string;
  /** Which part to bring into view when the panel opens from the Next button. */
  focusSection?: 'open' | 'milestones';
  now?: number;
  /** The plan's questions for the developer that the chat is not asking already. */
  planQuestions?: readonly PlanItemView[];
  /** With milestones, each says what it delivers, so the brief's own expected output and stop condition are left out. */
  hasMilestones?: boolean;
  acknowledging: boolean;
  /** Resolves to an error message, or null once the milestone is reopened. */
  onReopen: (stepId: string, reason: string) => Promise<string | null>;
  onDismissProposal: (eventId: string) => void;
  onFill: (text: string) => void;
  onOpenFile: (reference: { path: string; line?: number }) => void;
  onAcknowledge: () => void;
  /** Resolves true once the answer is in the plan. */
  onAnswer?: (id: string, answer: string) => Promise<boolean>;
}

/** The detail behind the strip: the goal, every milestone, what waits on the developer, and what was touched. */
export function ProgressPanel(props: ProgressPanelProps) {
  const { id, facts, guidance, proposals, changes, changesError, focusSection, onFill, onOpenFile } = props;
  // Read once when the panel opens, so the ages in it do not shift on every render.
  const [now] = useState(() => props.now ?? Date.now());
  const titles = new Map(facts.milestones.map((milestone) => [milestone.id, milestone.title]));
  const [reopening, setReopening] = useState<{ stepId: string; reason: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [reopened, setReopened] = useState<{ title: string; reason: string } | null>(null);
  const openSection = useRef<HTMLElement>(null);
  const milestoneSection = useRef<HTMLElement>(null);

  useEffect(() => {
    const target = focusSection === 'open' ? openSection.current : focusSection === 'milestones' ? milestoneSection.current : null;
    target?.scrollIntoView?.({ block: 'nearest' });
  }, [focusSection]);

  const startReopen = (stepId: string, reason = '') => { setReopening({ stepId, reason }); setError(undefined); setReopened(null); };
  const submitReopen = async () => {
    if (!reopening) return;
    setPending(true);
    setError(undefined);
    const title = titles.get(reopening.stepId) ?? reopening.stepId;
    const failure = await props.onReopen(reopening.stepId, reopening.reason.trim());
    setPending(false);
    if (failure) { setError(failure); return; }
    setReopened({ title, reason: reopening.reason.trim() });
    setReopening(null);
  };

  const questions = facts.openQuestions;
  const blocked = facts.milestones.filter((milestone) => milestone.state === 'blocked');
  const verification = verificationLine(facts, now);
  const planQuestions = props.planQuestions ?? [];
  const waiting = questions.length > 0 || planQuestions.length > 0 || blocked.length > 0 || checkIsFailing(facts);
  const assignment = guidance?.assignment;
  const files = (changes ?? []).flatMap((repo) => repo.files.map((file) => ({ repo, file })));

  return (
    <div className="grid gap-x-6 gap-y-4 text-xs sm:grid-cols-2">
      {/* Two columns so neither leaves a gap under a short section. What needs the developer comes first, which also puts it on top when they stack. */}
      <div className="space-y-4">
        <section aria-labelledby={`${id}-open`} ref={openSection}>
          <Heading
            id={`${id}-open`}
            action={questions.length > 0 ? (
              <IconButton label="I answered in the chat" icon={<Check />} disabled={props.acknowledging} onClick={props.onAcknowledge} />
            ) : undefined}
          >Waiting on you</Heading>
          {!waiting && <p className="text-muted-foreground">Nothing is waiting on you.</p>}
          <ul className="space-y-2">
            {questions.map((question) => (
              <li key={question.id} className="rounded-md border border-border p-2">
                <p className="text-[11px] text-muted-foreground">The AI asked{formatAge(question.timestamp, now) ? ` ${formatAge(question.timestamp, now)}` : ''}:</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words">{question.message}</p>
                {question.options && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Suggested answers">
                    {question.options.map((option) => <Button key={option} size="xs" variant="outline" title="Adds this to the chat prompt. You press Enter." onClick={() => onFill(option)}>{option}</Button>)}
                  </div>
                )}
              </li>
            ))}
            {props.onAnswer && planQuestions.map((item) => <PlanQuestion key={item.id} item={item} onAnswer={props.onAnswer!} />)}
            {blocked.map((milestone) => (
              <li key={milestone.id}><span className="state-chip" data-tone="needs">Blocked</span> &ldquo;{milestone.title}&rdquo;: {milestone.blockedReason ?? milestone.unblockCondition ?? 'no reason given'}</li>
            ))}
          </ul>
          {verification && (
            <p className={`mt-2 ${verification.tone === 'bad' ? 'text-[var(--state-needs)]' : verification.tone === 'ok' ? 'text-[var(--state-done)]' : 'text-muted-foreground'}`}>{verification.text}</p>
          )}
        </section>

        <section aria-labelledby={`${id}-goal`}>
          <Heading id={`${id}-goal`}>Goal</Heading>
          {assignment ? (
            <dl className="space-y-1">
              <div><dt className="inline font-medium">Stage: </dt><dd className="inline capitalize">{assignment.stage}</dd></div>
              <div><dt className="inline font-medium">Objective: </dt><dd className="inline">{assignment.objective || <span className="text-muted-foreground">Not set</span>}</dd></div>
              {!props.hasMilestones && <>
                <div><dt className="inline font-medium">Expected output: </dt><dd className="inline">{assignment.expectedOutput || <span className="text-muted-foreground">Not set</span>}</dd></div>
                <div><dt className="inline font-medium">Stop when: </dt><dd className="inline">{assignment.stopCondition || <span className="text-muted-foreground">Not set</span>}</dd></div>
              </>}
            </dl>
          ) : <p className="text-muted-foreground">The goal has not loaded.</p>}
        </section>

      </div>
      <div className="space-y-4">
        <section aria-labelledby={`${id}-milestones`} ref={milestoneSection}>
          <Heading id={`${id}-milestones`}>Milestones</Heading>
          {reopened && (
            <div role="status" className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
              <span>&ldquo;{reopened.title}&rdquo; is reopened.</span>
              <IconButton label="Tell the AI" icon={<CornerDownLeft />} onClick={() => onFill(`Milestone "${reopened.title}" was reopened: ${reopened.reason}. Please redo it.`)} />
            </div>
          )}
          {facts.milestones.length === 0 && <p className="text-muted-foreground">No milestones are planned yet.</p>}
          <ol className="space-y-2">
            {facts.milestones.map((milestone) => {
              const proposal = proposals.find((candidate) => candidate.milestone.id === milestone.id);
              const notes = milestoneNotes(milestone, titles, now);
              return (
                <li key={milestone.id}>
                  <div className="flex items-start gap-2">
                    <span className="state-chip mt-0.5 w-24 shrink-0" data-tone={STATE_TONE[milestone.state]}>{STATE_WORD[milestone.state]}</span>
                    <div className="min-w-0 flex-1">
                      <p className="break-words font-medium">{milestone.title}</p>
                      {notes.map((note) => <p key={note} className="break-words text-muted-foreground">{note}</p>)}
                    </div>
                    {milestone.state === 'done' && !(reopening?.stepId === milestone.id) && (
                      <IconButton label={`Reopen "${milestone.title}"`} icon={<RotateCcw />} onClick={() => startReopen(milestone.id)} />
                    )}
                  </div>
                  {proposal && reopening?.stepId !== milestone.id && (
                    <div className="ml-26 mt-1.5 flex items-start gap-1 rounded-md border border-border bg-muted/30 py-1.5 pl-2 pr-1">
                      <p className="min-w-0 flex-1 pt-0.5"><span className="font-medium">{proposal.event.payload.proposal === 'reopen' ? 'The AI suggests reopening this' : 'The AI thinks this is done'}:</span> {proposal.event.payload.reason}</p>
                      <div className="flex shrink-0 items-center">
                        {proposal.event.payload.proposal === 'reopen'
                          ? <IconButton label="Reopen with this reason" icon={<RotateCcw />} onClick={() => startReopen(milestone.id, proposal.event.payload.reason)} />
                          : <IconButton label="Ask for proof" icon={<CircleHelp />} onClick={() => onFill(`What shows that "${milestone.title}" is done? Show me.`)} />}
                        <IconButton label="Dismiss" icon={<X />} onClick={() => props.onDismissProposal(proposal.event.id)} />
                      </div>
                    </div>
                  )}
                  {reopening?.stepId === milestone.id && (
                    <ReopenForm
                      id={`${id}-reopen-${milestone.id}`} title={milestone.title} reason={reopening.reason} pending={pending} error={error}
                      onChange={(reason) => setReopening({ stepId: milestone.id, reason })} onSubmit={() => { void submitReopen(); }} onCancel={() => { setReopening(null); setError(undefined); }}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </section>

        <section aria-labelledby={`${id}-touched`}>
          <Heading id={`${id}-touched`}>Touched</Heading>
          {facts.changes.files === 0 && !facts.unavailable.some((entry) => entry.source === 'changes') && <p className="text-muted-foreground">No changes yet.</p>}
          {facts.changes.files > 0 && <p className="mb-1.5 text-muted-foreground">{facts.changes.files} {facts.changes.files === 1 ? 'file' : 'files'}, +{facts.changes.additions} {MINUS}{facts.changes.deletions}</p>}
          {facts.changes.repos.filter((repo) => repo.unavailable).map((repo) => <p key={repo.repoName} className="text-muted-foreground">Could not read the changes in {repo.repoName}.</p>)}
          {changesError && <p role="alert" className="text-destructive">{changesError}</p>}
          {facts.changes.files > 0 && !changes && !changesError && <p className="text-muted-foreground">Loading files...</p>}
          <ul>
            {files.slice(0, TOUCHED_LIST_MAX).map(({ repo, file }) => (
              <li key={`${repo.repoName}/${file.file}`}>
                <button
                  type="button" title={`${repo.repoName}/${file.file}`}
                  className="flex w-full min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-accent/70 focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => onOpenFile({ path: `${repo.repoName}/${file.file}` })}
                >
                  <span className="min-w-0 flex-1 truncate">{file.file}</span>
                  {(file.additions !== undefined || file.deletions !== undefined) && <span className="shrink-0 tabular-nums text-muted-foreground">+{file.additions ?? 0} {MINUS}{file.deletions ?? 0}</span>}
                </button>
              </li>
            ))}
          </ul>
          {files.length > TOUCHED_LIST_MAX && <p className="mt-1 text-muted-foreground">and {files.length - TOUCHED_LIST_MAX} more</p>}
        </section>

      </div>
      {facts.unavailable.length > 0 && (
        <p className="text-muted-foreground sm:col-span-2">Could not read: {facts.unavailable.map((entry) => `${entry.source} (${entry.reason})`).join('; ')}. Those facts are left out, not counted as zero.</p>
      )}
    </div>
  );
}
