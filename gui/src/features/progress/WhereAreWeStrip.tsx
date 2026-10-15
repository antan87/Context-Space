import { useRef, type Ref } from 'react';
import { ArrowRight, Check, ChevronDown, MessageCircleQuestion, RefreshCw } from 'lucide-react';

import { Button } from '../../components/ui/button.js';
import { ContextRing } from '../../components/ui/context-ring.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Popover, PopoverPopup } from '../../components/ui/popover.js';
import { ApiError } from '../../lib/api/client.js';
import { cn } from '../../lib/utils.js';
import type { OpenQuestion, ProgressFacts, WorkGuidance } from '../../types.js';
import { nameOf } from '../plan/planView.js';
import { ProgressPanel } from './ProgressPanel.js';
import { currentMilestoneIndex, factsLine, goalLine, ringMilestones, stripState, type NextAction } from './progressView.js';
import { AiClosedBar, PlanQuestionBar } from './StripNotices.js';
import { planQuestionFor } from './stripPlan.js';
import type { WhereAreWe } from './useWhereAreWe.js';

const RING_SIZE = 20;

export interface WhereAreWeBarProps {
  facts: ProgressFacts;
  guidance?: WorkGuidance;
  action: NextAction | null;
  expanded: boolean;
  panelId: string;
  notice: string;
  /** Questions in the plan that wait for the developer, beside the AI's chat questions. */
  planQuestions?: number;
  toggleRef?: Ref<HTMLButtonElement>;
  onToggle: () => void;
  onNext: (action: NextAction) => void;
}

/**
 * Where the work stands, in one line in the chat's toolbar: the ring, what is being worked on now (else the
 * goal), the state, a few checkable facts, and the Next button. The goal is in the tooltip.
 */
export function WhereAreWeBar({ facts, guidance, action, expanded, panelId, notice, planQuestions = 0, toggleRef, onToggle, onNext }: WhereAreWeBarProps) {
  const goal = goalLine(guidance, facts);
  const current = facts.milestones.find((milestone) => milestone.id === facts.currentMilestoneId);
  const state = planQuestions > 0 && stripState(facts).tone !== 'needs' ? { tone: 'needs' as const, label: 'Needs you' } : stripState(facts);
  const line = factsLine(facts);
  const tooltip = [goal.full ?? goal.text, ...line].filter(Boolean).join(' · ');
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        ref={toggleRef} type="button" aria-expanded={expanded} aria-controls={panelId} onClick={onToggle} title={tooltip || undefined}
        className="flex h-6 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* The counts are in the facts line, so the ring is left out of the accessible name. */}
        <ContextRing aria-hidden="true" size={RING_SIZE} milestones={ringMilestones(facts)} currentIndex={currentMilestoneIndex(facts)} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {current ? <><span className="font-normal text-muted-foreground">Now · </span>{current.title}</>
            : goal.text || <span className="font-normal text-muted-foreground">No goal set yet</span>}
        </span>
        <span className="state-chip shrink-0 text-[11px]" data-tone={state.tone}>{state.label}</span>
        <span className="hidden min-w-0 shrink truncate text-[11px] text-muted-foreground @xl:inline">
          {line.map((fact) => <span key={fact}><span aria-hidden="true"> &middot; </span>{fact}</span>)}
        </span>
        <ChevronDown aria-hidden="true" className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
      </button>
      {action && (
        <Button
          size="xs" variant="ghost" className="max-w-[16rem] min-w-0 shrink text-foreground" title={action.reason}
          aria-label={`Next: ${action.label}. ${action.reason}`}
          onClick={() => onNext(action)}
        >
          <span className="truncate">{action.label}</span>
          <ArrowRight aria-hidden="true" className="text-primary" />
        </Button>
      )}
      {/* Always present, so a screen reader hears the notice; it is shown above the chat while there is one. */}
      <span role="status" className="sr-only">{notice}</span>
    </div>
  );
}

export interface AnswerBarProps {
  /** The newest question the AI is waiting on. */
  question: OpenQuestion;
  /** What it holds up in the plan, when the AI put it there. */
  context?: string;
  /** How many older ones are still open. */
  earlier: number;
  acknowledging: boolean;
  onFill: (text: string) => void;
  onAcknowledge: () => void;
  onShowAll: () => void;
}

/**
 * What the AI is waiting for, in plain sight above the chat, with its suggested answers one click away. A suggested
 * answer is typed into the prompt and the developer presses Enter; the line they send closes the question, so there
 * is nothing else to mark. The check is for an answer given some other way.
 */
export function AnswerBar({ question, context, earlier, acknowledging, onFill, onAcknowledge, onShowAll }: AnswerBarProps) {
  const options = question.options ?? [];
  return (
    <div role="group" aria-label="The AI is waiting for your answer" className="flex items-start gap-2.5 border-b border-[color-mix(in_oklab,var(--state-needs)_45%,transparent)] bg-[color-mix(in_oklab,var(--state-needs)_7%,var(--card))] px-3 py-2">
      <MessageCircleQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--state-needs)]" />
      <div className="min-w-0 flex-1">
        {context && <p className="mb-0.5 text-[11px] text-muted-foreground">{context}</p>}
        {/* The agent wrote this: plain text only. */}
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-snug text-foreground">{question.message}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {options.length > 0 && (
            <div role="group" aria-label="Suggested answers" className="flex flex-wrap gap-1.5">
              {options.map((option) => (
                <Button key={option} size="xs" variant="outline" title="Adds this to the chat prompt. You press Enter." onClick={() => onFill(option)}>{option}</Button>
              ))}
            </div>
          )}
          <span className="text-[11px] text-muted-foreground">
            {options.length > 0 ? 'Pick one and press Enter, or type your own answer in the chat.' : 'Type your answer in the chat and press Enter.'}
          </span>
          {earlier > 0 && (
            <button type="button" onClick={onShowAll} className="cursor-pointer text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
              {earlier === 1 ? '1 earlier question' : `${earlier} earlier questions`}
            </button>
          )}
        </div>
      </div>
      <IconButton label="I answered in the chat" icon={<Check />} disabled={acknowledging} onClick={onAcknowledge} />
    </div>
  );
}


/** The summary in the chat's toolbar, and the panel behind it, which opens over the chat. */
export function WhereAreWeSummary({ strip }: { strip: WhereAreWe }) {
  const anchor = useRef<HTMLElement>(null);
  const { facts, factsQuery } = strip;
  if (!facts) {
    return (
      <section aria-label="Where are we" className="flex min-w-0 items-center gap-2 px-1.5 text-[12px] text-muted-foreground">
        <ContextRing aria-hidden="true" size={RING_SIZE} milestones={[]} />
        {factsQuery.isError ? (
          <>
            <span role="status" className="truncate">Progress is unavailable{factsQuery.error instanceof ApiError ? ` (${factsQuery.error.message})` : ''}.</span>
            <Button size="xs" variant="ghost" onClick={() => { void factsQuery.refetch(); }}><RefreshCw aria-hidden="true" />Try again</Button>
          </>
        ) : <span role="status">Loading progress...</span>}
      </section>
    );
  }
  return (
    <section aria-label="Where are we" ref={anchor} className="@container min-w-0">
      <WhereAreWeBar
        facts={facts} guidance={strip.guidance} action={strip.action} expanded={strip.expanded} panelId={strip.panelId} notice={strip.notice}
        planQuestions={strip.planQuestions.length} toggleRef={strip.toggleRef}
        onToggle={() => { if (strip.expanded) strip.closePanel(); else strip.openPanel(); }} onNext={strip.runNext}
      />
      <Popover open={strip.expanded} onOpenChange={(open) => { if (!open) strip.closePanel(); }}>
        <PopoverPopup anchor={anchor} align="start" className="w-[min(48rem,calc(100vw-1.5rem))]">
          <div id={strip.panelId} role="region" aria-label="Progress details" className="max-h-[min(70vh,32rem)] overflow-y-auto pr-1">
            <ProgressPanel
              id={strip.panelId} facts={facts} guidance={strip.guidance} proposals={strip.proposals} focusSection={strip.section}
              planQuestions={strip.planQuestions} hasMilestones={facts.milestones.length > 0}
              changes={strip.changes.data} changesError={strip.changes.isError ? 'Could not list the changed files.' : undefined}
              acknowledging={strip.acknowledge.isPending}
              onReopen={async (stepId, reason) => {
                try { await strip.reopen.mutateAsync({ stepId, reason }); return null; }
                catch (error) { return error instanceof Error ? error.message : 'Could not reopen the milestone.'; }
              }}
              onDismissProposal={strip.dismissProposal}
              onFill={strip.fill} onOpenFile={strip.openFile}
              onAnswer={strip.answerInPlan}
              onAcknowledge={() => strip.acknowledge.mutate()}
            />
          </div>
        </PopoverPopup>
      </Popover>
    </section>
  );
}

/**
 * What waits for the developer, above the chat while there is something: the AI's question in the chat
 * (with what it holds up in the plan), else a question in the plan to answer here, else what the AI closed.
 * One at a time, so the chat keeps its room; the panel lists everything.
 */
export function WhereAreWeNotices({ strip }: { strip: WhereAreWe }) {
  const { questions, planQuestions, closes, plan, notice } = strip;
  const latest = questions[questions.length - 1];
  const twin = latest ? planQuestionFor(plan, latest) : undefined;
  const close = closes[0];
  const closedTitle = close ? (plan?.milestones.find((item) => item.id === close.itemId)?.title ?? nameOf({ id: close.itemId, label: close.label })) : '';
  return (
    <>
      {latest ? (
        <AnswerBar
          question={latest} earlier={questions.length - 1} acknowledging={strip.acknowledge.isPending}
          context={twin?.holdsUp.length ? `Holds up ${twin.holdsUp.map((label) => label.replace(/^\S+\s/, '')).join(', ')}` : undefined}
          onFill={strip.fill} onAcknowledge={() => strip.acknowledge.mutate()} onShowAll={() => strip.openPanel('open')}
        />
      ) : planQuestions[0] ? (
        <PlanQuestionBar
          key={planQuestions[0].id} item={planQuestions[0]} more={planQuestions.length - 1} busy={strip.changePlan.isPending}
          error={strip.changePlan.error instanceof Error ? strip.changePlan.error.message : undefined}
          onAnswer={(answer) => strip.answerInPlan(planQuestions[0]!.id, answer)} onShowAll={() => strip.openPanel('open')}
        />
      ) : close ? (
        <AiClosedBar
          workspace={strip.workspace} entry={close} title={closedTitle} more={closes.length - 1}
          onReopen={(reason) => strip.reopenInPlan(close.itemId, reason)} onSeen={strip.seeCloses}
          onOpenPlan={() => strip.navigate(`/workspaces/${encodeURIComponent(strip.workspace)}/plan`)}
        />
      ) : null}
      {notice && <p aria-hidden="true" className="border-b border-border bg-card px-3 py-1 text-[11px] text-muted-foreground">{notice}</p>}
    </>
  );
}
