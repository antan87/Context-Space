import { Diagram } from '../../components/Diagram.js';
import { Fragment, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type MouseEvent, type ReactNode } from 'react';
import { type NodeProps } from '@xyflow/react';
import { Check, ChevronDown, ChevronRight, ChevronUp, CircleCheck, Circle, CircleHelp, ExternalLink, FileText, GitCommitHorizontal, GitCompare, PanelRightOpen, Plus, ShieldCheck, StickyNote, TriangleAlert } from 'lucide-react';

import { ChatMarkdown } from '../../components/ChatMarkdown.js';
import { classifyMarkdownLink } from '../../components/markdownLinks.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from '../../components/ui/dialog.js';
import { InlinePlanMarkdown } from '../../components/InlinePlanMarkdown.js';
import { cn } from '../../lib/utils.js';
import { useAnswerDecision, useChangePlanFile } from '../plan/planFile.js';
import { suggestedAnswers } from '../plan/planView.js';
import { plainText } from '../../lib/plainText.js';
import { agoText } from '../plan/whatsNew.js';
import { CommitNotesContext, noteCountText, notesOfCommit, requestNotesView } from './commitNotes.js';
import { BoardActionsContext, BoardReadingContext, firstControl, parseCommitNodeId, pictureSrc } from './boardActions.js';
import { ANSWER_HOLD_OFF_MS } from './answerHoldOff.js';
import { fitNewsItems, newsButtonFit } from './boardCountNav.js';
import { AREA_ROW, areaCountItems, areaCounts, areaFocusWord, areaRowSecondaryRoom, foldLabel, isStepless, MINI_STATUS_LINE, miniSecondLine, miniShowsPicture, stepsText, textEm, waitingText, type AreaData, type AreaFoldNode, type AreaMiniNode, type AreaNode, type AreaRowNode } from './boardAreas.js';
import { formatWorkspaceFileCounts } from './workspaceFilesArea.js';
import { answerCountWords, codeHeadParts, codeStatus, codeOpenLine, differingLines, readableText, type AnswerCardData } from './questionsArea.js';
import { answersThatFit, ROW_SIZE, READABLE_ZOOM, type AnswersFit } from './boardRows.js';
import { BOARD_SIZE, moreText, type AnswerNode, type BoardDecision, type CheckpointData, type CheckpointNode, type CommitNode, type DocumentNode, type LaneNode, type PlaceholderNode, type UncommittedNode } from './boardLayout.js';
import { openCodeWindow } from '../workspace-shell/openRequests.js';
import { CARD_BRICK as BRICK, CARD_FOCUS, FreshDot, Pill, StepCheck } from '../../design/index.js';
import { Anchors, brickPress, TITLE_BUTTON } from './cards/cardParts.js';
import { summaryLabel } from './summaryLabel.js';
import { BoardNote } from './cards/NoteCard.js';
import { BoardFile } from './cards/FileCard.js';

import { BoardRowHead } from './rows/RowHead.js';
import { BoardFoldRow, BoardMoreTile, BoardPager } from './rows/RowControls.js';

export { BoardNote, BoardFile, BoardRowHead, BoardFoldRow, BoardMoreTile, BoardPager };

const ROLE_LABEL = { requirements: 'Requirements', design: 'Design', evidence: 'Evidence', reference: 'Reference' } as const;
const STATUS_LABEL = { draft: 'Draft', approved: 'Approved', superseded: 'Superseded' } as const;
const STATUS_BADGE = { draft: 'warning', approved: 'success', superseded: 'secondary' } as const;


/** The ref for a group's button, which puts the keyboard on it when it takes the place of the one that was pressed (BoardActions.keepFocus). */
function useKeepFocus(id: string) {
  const actions = useContext(BoardActionsContext);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (ref.current) actions?.keepFocus(id, ref.current); }, [actions, id]);
  return ref;
}

/**
 * A group folded into one summary, which is one button: a press anywhere on it opens the group where it stands. It is not
 * a place to start moving the view from, so a press on it is only a press.
 */
function FoldedGroup({ id, label, className, children }: { id: string; label: string; className: string; children: ReactNode }) {
  const actions = useContext(BoardActionsContext);
  const ref = useKeepFocus(id);
  return <div className="relative h-full w-full">
    <Anchors />
    <button
      ref={ref} type="button" data-fold aria-label={label} aria-expanded="false" disabled={!actions} onClick={() => actions?.toggleGroup(id, true)}
      className={cn('board-fold nodrag nopan relative flex h-full w-full flex-col overflow-hidden px-3 pt-3 text-left shadow-xs', className)}
    >
      {children}
      <ChevronDown aria-hidden="true" className="absolute right-2.5 top-3 size-4 text-muted-foreground" />
    </button>
  </div>;
}

/** The button in the header of an open group that folds it again. */
function FoldButton({ id, title }: { id: string; title: string }) {
  const actions = useContext(BoardActionsContext);
  const ref = useKeepFocus(id);
  return <Button
    ref={ref} type="button" size="icon-xs" variant="ghost" data-fold className="nodrag nopan absolute right-1.5 top-1.5"
    aria-label={`Fold ${title}`} aria-expanded="true" title="Fold" disabled={!actions} onClick={() => actions?.toggleGroup(id, false)}
  ><ChevronUp aria-hidden="true" /></Button>;
}

/** The title of a lane: what its cards are, and what it leaves out. Its cards are separate nodes drawn over it. Folded, it is one summary of them. */
export function BoardLane({ id, data }: NodeProps<LaneNode>) {
  const group = data.group;
  if (group && !group.open) {
    return <FoldedGroup id={id} className="rounded-2xl border border-dashed border-border bg-muted/40 text-foreground hover:bg-muted/70"
      label={summaryLabel([data.title, group.summary.headline, group.summary.byline ? `latest: ${group.summary.detail} by ${group.summary.byline}` : group.summary.detail, group.summary.warning?.toLowerCase()])}>
      <span className="block w-full truncate pr-6 text-sm font-semibold leading-5" title={data.title}>{data.title}</span>
      <span className="block w-full truncate text-xs leading-4 text-muted-foreground">{group.summary.headline}</span>
      {group.summary.detail && <span className="mt-1 block w-full truncate text-xs leading-4 text-foreground" title={group.summary.detail}>{group.summary.detail}</span>}
      {group.summary.byline && <span className="block w-full truncate text-xs leading-4 text-muted-foreground">{group.summary.byline}</span>}
      {group.summary.warning && <span className="block w-full truncate text-xs leading-4 text-destructive-foreground">{group.summary.warning}</span>}
    </FoldedGroup>;
  }
  return <div className="relative flex h-full w-full flex-col rounded-2xl border border-dashed border-border bg-muted/40">
    <div className="px-4 pt-3" style={{ height: BOARD_SIZE.laneHeader }}>
      <h2 className={cn('truncate text-sm font-semibold leading-5 text-foreground', group && 'pr-6')} title={data.title}>{data.title}</h2>
      <p className="truncate text-xs leading-4 text-muted-foreground">{data.caption}</p>
    </div>
    {group && group.collapsible !== false && <FoldButton id={id} title={data.title} />}
    {data.note && <p className="line-clamp-2 px-4 text-xs leading-5 text-destructive-foreground" style={{ height: BOARD_SIZE.laneNote }}>{data.note}</p>}
    {data.more > 0 && <p className="mt-auto flex items-center px-4 text-xs text-muted-foreground" style={{ height: BOARD_SIZE.laneMore }}>
      {moreText(data.more, data.moreAtLeast)}
    </p>}
  </div>;
}

/** What a frame says in its header, open or folded: whether it is done, how far its steps are, what waits, and a bar. */
function FrameFacts({ data }: { data: CheckpointData }) {
  const waiting = data.waiting.length + data.moreWaiting;
  const progress = data.stepsTotal ? (data.stepsDone / data.stepsTotal) * 100 : 0;
  return <>
    <div className="mt-1.5 flex h-5 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      {data.kind === 'checkpoint' && <Badge className="sm:text-[12.5px]" variant={data.done ? 'success' : 'outline'}>{data.done ? 'Done' : 'Not done'}</Badge>}
      <span>{stepsText(data)}</span>
      {waiting > 0 && <Badge variant="warning">{waitingText(waiting)}</Badge>}
    </div>
    <div aria-hidden="true" className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-success" style={{ width: `${progress}%` }} />
    </div>
  </>;
}

/** What the plan's own frame says it holds. */
const planSubtitle = (data: CheckpointData, open: boolean) =>
  open ? 'Steps and decisions outside the checkpoints'
    : data.stepsTotal ? `${data.stepsTotal} ${data.stepsTotal === 1 ? 'step' : 'steps'} outside the checkpoints` : 'Decisions outside the checkpoints';

interface WaitingDecisionCardProps {
  decision: BoardDecision;
  onAnswer: (key: string, answer: string, expected?: string, options?: { optimistic?: boolean }) => Promise<boolean>;
  /** The width of the node the card is on, when it is the compact card of the Area's waiting frame: one line of answers, the rest in a dialog. */
  width?: number;
  /** Said when the card leaves the board with its dialog open and no answer sent: the question changed in the plan (or was answered elsewhere). */
  onLost?: () => void;
}

/**
 * The keyboard after an answer: the decision it was on has left the board (or was put back, after a failure), and focus would fall to the page.
 * It goes to the card of the decision that follows, else of the first one that waits, else to the Now row's step or the row after the waiting card. The
 * layout is drawn again a frame or two after the plan changes, so this looks for a few frames; if the keyboard has been put somewhere else
 * meanwhile, it is left there.
 */
function focusAfterAnswer(card: HTMLElement, nextTestId: string | null, ownKey: string | null) {
  const area = card.closest('#board-area') ?? document;
  let frames = 0;
  const lost = () => {
    const active = document.activeElement;
    return !active || active === document.body || !active.isConnected || document.querySelector('[data-testid="decision-dialog"]')?.contains(active) === true;
  };
  const attempt = () => {
    if (!lost()) return;
    frames += 1;
    const cards = Array.from(area.querySelectorAll<HTMLElement>('[data-testid^="decision-card-"]'));
    const target = (ownKey && cards.find((entry) => entry.dataset.testid === `decision-card-${ownKey}`))
      || (nextTestId && cards.find((entry) => entry.dataset.testid === nextTestId))
      || cards[0];
    // Never on an answer button: a second press meant for the first decision would answer this one unread. The next Tab reaches its answers.
    if (target) { target.focus({ preventScroll: true }); return; }
    if (frames < 20) { requestAnimationFrame(attempt); return; }
    (area.querySelector<HTMLElement>('[data-row-fallback]') ?? area.querySelector<HTMLElement>('[data-row-control]:not([data-row-control="row:waiting"])'))?.focus({ preventScroll: true });
  };
  requestAnimationFrame(attempt);
}


const lastAnswerOnFrame = new WeakMap<object, number>();
const frameOf = (element: Element) => element.closest('#board-area') ?? document;

/**
 * The one place that decides whether a press on a suggested answer counts. Spread on the card; it sees every press first (also those from
 * the dialog, which is a child of the card in React). A repeat of a held key, the second press of a double click, and any press within
 * the hold-off after an answer on this frame are dropped; a deliberate press later answers.
 */
const answerPressGuard = {
  onClickCapture(event: ReactMouseEvent<HTMLElement>) { guardPress(event, event.detail > 1); },
  onKeyDownCapture(event: ReactKeyboardEvent<HTMLElement>) { if (event.key === 'Enter' || event.key === ' ') guardPress(event, event.repeat); },
};
function guardPress(event: { type: string; nativeEvent: Event; target: EventTarget; currentTarget: HTMLElement; preventDefault(): void; stopPropagation(): void }, repeated: boolean) {
  const button = (event.target as Element).closest?.('[role="group"] button');
  // (the dialog is drawn outside the card, but its presses reach the card's handlers through React)
  if (!button) return;
  // an event is decided once: it can reach this handler more than once on its way, and must not be dropped by its own stamp
  const decided = decisions.get(event.nativeEvent);
  const frame = frameOf(event.currentTarget);
  const drop = decided ?? (repeated || performance.now() - (lastAnswerOnFrame.get(frame) ?? -Infinity) < ANSWER_HOLD_OFF_MS);
  decisions.set(event.nativeEvent, drop);
  if (drop) {
    event.preventDefault(); event.stopPropagation();
    // The mouse-down of a dropped click has already put the focus on this card's answer, with no ring: a later Enter would answer unread.
    // The keyboard goes to the card itself (the click comes after the mouse-down, so the browser's own focus has happened).
    if (event.type === 'click' && event.currentTarget.contains(button) && document.activeElement === button) event.currentTarget.focus({ preventScroll: true });
    return;
  }
  if (event.type === 'click' && decided === undefined) lastAnswerOnFrame.set(frame, performance.now());
}
const decisions = new WeakMap<Event, boolean>();

/** What answering a decision takes: its suggested answers, a free answer, and whether the last try failed. */
function useDecisionAnswer({ decision, onAnswer }: WaitingDecisionCardProps) {
  const actions = useContext(BoardActionsContext);
  const [customAnswer, setCustomAnswer] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const failure = error ?? actions?.decisionErrors?.[decision.key] ?? null;
  const displayError = failure && failure !== dismissed ? failure : null;

  const options = useMemo(() => {
    if (decision.suggested && decision.suggested.length > 0) return decision.suggested;
    if (decision.detail) {
      const line = decision.detail.split('\n').find((l) => /^(?:suggested answers|suggested)\s*:/i.test(l.trim()));
      if (line) {
        return line.trim().replace(/^(?:suggested answers|suggested)\s*:\s*/i, '').split(' · ').map((s) => s.trim()).filter(Boolean);
      }
    }
    return suggestedAnswers(decision.detail);
  }, [decision.suggested, decision.detail]);

  /**
   * `fromDialog`: the answer is not optimistic (the decision stays until the server has said yes), so a failure keeps the dialog open with
   * the typed words and the keyboard where it was. A press on the card is optimistic: the decision leaves the board at once.
   */
  const refocus = useRef<HTMLElement | null>(null);
  const sent = useRef(false);
  const submitAnswer = async (answer: string, fromDialog = false, card?: HTMLElement | null) => {
    const text = answer.trim();
    if (!text || saving) return;
    const active = document.activeElement as HTMLElement | null;
    const hadFocus = Boolean(card && (card.contains(active) || document.querySelector('[data-testid="decision-dialog"]')?.contains(active)));
    const next = card?.nextElementSibling?.getAttribute('data-testid') ?? null;
    if (fromDialog) refocus.current = active;
    if (card) lastAnswerOnFrame.set(frameOf(card), performance.now());
    setSaving(true);
    sent.current = true;
    setError(null);
    setDismissed(null);
    try {
      const ok = await onAnswer(decision.key, text, decision.question, fromDialog ? { optimistic: false } : undefined);
      if (!ok) { setError('Could not save answer.'); sent.current = false; }
      if (ok && hadFocus) focusAfterAnswer(card!, next, null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save answer.');
      sent.current = false;
      if (hadFocus && !fromDialog) focusAfterAnswer(card!, null, decision.key);
    } finally {
      setSaving(false);
    }
  };
  // The keyboard stays on what it was on in the dialog while it saves and when the answer fails (the buttons are off for a moment)
  useEffect(() => {
    if (saving || !refocus.current) return;
    const element = refocus.current;
    refocus.current = null;
    if (element.isConnected) element.focus({ preventScroll: true });
  }, [saving]);

  return { actions, options, sent, customAnswer, setCustomAnswer, saving, displayError, dismissError: () => { setDismissed(failure); setError(null); }, submitAnswer };
}

const ANSWER_BUTTON = 'nodrag nopan inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-md border border-border/80 bg-background/80 px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-accent cursor-pointer disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1';
const GHOST_BUTTON = 'nodrag nopan inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1';

/** Asks about the question in the CLI; the question without its marks. */
function AskInCliButton({ question }: { question: string }) {
  const actions = useContext(BoardActionsContext);
  if (!actions?.askInCLI || actions.readOnly) return null;
  const plain = plainText(question) || question;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        actions.askInCLI?.(plain);
      }}
      className="btn-ask-card nodrag nopan inline-flex h-6 min-h-[24px] items-center gap-1 rounded px-2 text-[12px] text-muted-foreground hover:text-foreground hover:bg-background/80 transition-colors cursor-pointer"
      title={`Ask about "${plain}" in CLI`}
    >
      <span>Ask in CLI</span>
      <span aria-hidden="true">↗</span>
    </button>
  );
}

/**
 * A waiting decision on the Area's frame: a fixed card that never scrolls. The question is up to two lines (all of it in the dialog and the
 * title), then one line: the suggested answers that fit whole, one press answers, and a quiet button that opens the dialog with every answer,
 * the full question, a free answer and "Ask in CLI". A failed answer is said in place of the answers on that line, so the card keeps its height.
 */
function CompactDecisionCard(props: WaitingDecisionCardProps) {
  const { decision, width = ROW_SIZE.decisionWidth } = props;
  const { options, sent, customAnswer, setCustomAnswer, saving, displayError, dismissError, submitAnswer } = useDecisionAnswer(props);
  const estimate = useMemo(() => answersThatFit(options, width), [options, width]);
  const answerLine = useRef<HTMLDivElement>(null);
  const answerMeasure = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ options: string[]; fit: AnswersFit } | null>(null);
  const fit = measured?.options === options ? measured.fit : estimate;
  useLayoutEffect(() => {
    const line = answerLine.current;
    const probes = answerMeasure.current;
    if (!line || !probes) return;
    const measure = () => {
      const room = line.getBoundingClientRect().width;
      if (room <= 0) return;
      // All dimensions are in screen pixels, including the gap: no rounded offsetWidth or guessed font metrics.
      const next = answersThatFit(options, width, {
        line: room,
        buttons: Array.from(probes.querySelectorAll('[data-answer-width]'), (el) => el.getBoundingClientRect().width),
        ghost: Math.max(...Array.from(probes.querySelectorAll('[data-ghost-width]'), (el) => el.getBoundingClientRect().width)),
        gap: probes.querySelector('[data-answer-gap]')!.getBoundingClientRect().width,
      });
      const held = document.activeElement;
      // If a late font/resize hides the focused answer, its complete version stays behind this control.
      if (held instanceof HTMLElement && line.contains(held) && held.closest('[data-testid="decision-answers"]')
        && !next.shown.includes(held.textContent ?? '')) {
        line.querySelector<HTMLElement>('[data-testid="decision-more-answers"]')?.focus({ preventScroll: true });
      }
      setMeasured((previous) => previous?.options === options && previous.fit.ghost === next.ghost
        && previous.fit.shown.length === next.shown.length && previous.fit.shown.every((option, i) => option === next.shown[i])
        ? previous : { options, fit: next });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    for (const el of probes.children) observer.observe(el);
    return () => observer.disconnect();
  }, [options, width]);
  const plain = plainText(decision.question);
  const [open, setOpen] = useState(false);
  const card = useRef<HTMLLIElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const question = useRef<HTMLDivElement>(null);
  // "Other answer…" opens on the free answer; "All answers…" opens on the question, so that neither a second Enter nor a space answers by
  // accident: an answer needs a press of its own. The question is read first by a screen reader, and Tab reaches the answers from it.
  const allAnswers = fit.hidden > 0;
  const [again, setAgain] = useState(false);
  // The decision's key is its question, so a question edited in the plan is another card: this one goes, and its dialog with it. Say so.
  const openNow = useRef(false);
  useEffect(() => { openNow.current = open; }, [open]);
  const onLost = props.onLost;
  useEffect(() => () => { if (openNow.current && !sent.current) onLost?.(); }, [onLost, sent]);
  useEffect(() => {
    if (!again || displayError) return;
    setAgain(false);
    card.current?.querySelector<HTMLElement>('[role="group"] button:not(:disabled), [data-testid="decision-more-answers"]')?.focus({ preventScroll: true });
  }, [again, displayError]);

  return (
    <li
      ref={card}
      tabIndex={-1}
      {...answerPressGuard}
      data-testid={`decision-card-${decision.key}`}
      style={{ height: ROW_SIZE.decisionCard }}
      className="relative nodrag nopan box-border outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 flex flex-col justify-between overflow-hidden rounded-lg border border-warning/40 bg-warning/8 px-2.5 py-[7px] text-foreground shadow-2xs"
    >
      <div className="flex items-start gap-2">
        <CircleHelp aria-hidden="true" className="mt-px size-4 shrink-0 text-warning-foreground" />
        <span className="line-clamp-2 min-w-0 break-words text-[14px] font-medium leading-[18px]" title={plain}>
          <span className="sr-only">Waiting for you: </span>
          <InlinePlanMarkdown content={decision.question} />
        </span>
      </div>

      {/* Invisible, noninteractive copies use exactly the answer/ghost typography and padding, including the actual platform font. */}
      <div aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 size-0 overflow-clip">
      <div ref={answerMeasure} className="flex w-max items-center">
        {options.map((option) => <span key={option} data-answer-width="" className={ANSWER_BUTTON}>{option}</span>)}
        <span data-ghost-width="" className={GHOST_BUTTON}>All answers…</span>
        <span data-ghost-width="" className={GHOST_BUTTON}>Other answer…</span>
        <span data-answer-gap="" className="w-1.5 shrink-0" />
      </div>
      </div>
      {/* The line takes 24 px of the card's height, but is 32 px tall (4 px pulled back above and below, into the card's padding), so that a focus
          ring (2 px and 1 px offset) is whole inside the clip. Rendered measurements keep every shown button whole. */}
      <div ref={answerLine} className="-my-1 flex h-8 min-w-0 items-center gap-1.5">
        {displayError ? (
          <>
            <p role="alert" className="min-w-0 flex-1 truncate text-[12.5px] text-destructive" title={displayError}>{displayError}</p>
            <button type="button" onClick={() => { setAgain(true); dismissError(); }} className={GHOST_BUTTON}>Answer again</button>
          </>
        ) : fit.shown.length > 0 && (
          <div data-testid="decision-answers" className="-mx-1 min-w-0 overflow-clip px-1 py-1">
            <div role="group" aria-label="Suggested answers" className="flex w-max items-center gap-1.5">
              {fit.shown.map((option) => (
                <button key={option} type="button" disabled={saving} onClick={() => void submitAnswer(option, false, card.current)} className={ANSWER_BUTTON}>{option}</button>
              ))}
            </div>
          </div>
        )}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<button type="button" data-testid="decision-more-answers" className={cn(GHOST_BUTTON, 'ml-auto')} aria-haspopup="dialog" />}>{fit.ghost}</DialogTrigger>
          <DialogPopup
            className="max-w-lg max-h-[min(85dvh,calc(100dvh-2rem))]"
            bottomStickOnMobile={false}
            data-testid="decision-dialog"
            initialFocus={allAnswers ? question : input}
            onClick={(e) => e.stopPropagation()}
          >
            <DialogHeader className="shrink-0 pb-2">
              <DialogTitle className="text-sm font-semibold text-muted-foreground">Waits for you</DialogTitle>
              <DialogDescription className="sr-only">Answer this question with a suggestion or in your own words</DialogDescription>
            </DialogHeader>
            <div ref={question} tabIndex={-1} className="shrink-0 select-text break-words px-6 pb-3 text-base font-medium leading-relaxed text-foreground outline-none"><InlinePlanMarkdown content={decision.question} /></div>
            {decision.detail && (
              <div
                tabIndex={0}
                aria-label="Decision details"
                data-testid="decision-detail"
                className="min-h-0 min-w-0 shrink overflow-y-auto px-6 py-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <div className="board-text select-text min-w-0 [overflow-wrap:anywhere] text-sm leading-6 text-muted-foreground">
                  <ChatMarkdown content={decision.detail} compact />
                </div>
              </div>
            )}
            <div className={cn('shrink-0 space-y-3 px-6 pb-1', decision.detail && 'pt-3')}>
              {options.length > 0 && (
                <div role="group" aria-label="All suggested answers" className="flex flex-wrap gap-1.5">
                  {options.map((option) => (
                    <button key={option} type="button" disabled={saving} onClick={() => void submitAnswer(option, true, card.current)} className={cn(ANSWER_BUTTON, 'h-auto min-h-7 whitespace-normal py-1 text-left')}>{option}</button>
                  ))}
                </div>
              )}
              <form aria-busy={saving} onSubmit={(e) => { e.preventDefault(); void submitAnswer(customAnswer, true, card.current); }} className="flex items-center gap-1.5">
                <input
                  ref={input}
                  type="text"
                  value={customAnswer}
                  readOnly={saving}
                  onChange={(e) => setCustomAnswer(e.target.value)}
                  placeholder="Your answer"
                  aria-label={`Your answer to ${plain}`}
                  className="h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring read-only:opacity-50"
                />
                <Button type="submit" size="sm" disabled={saving || !customAnswer.trim()}>{saving ? 'Saving…' : 'Answer'}</Button>
              </form>
              {saving && <p role="status" className="text-sm text-muted-foreground">Saving…</p>}
              {displayError && <p role="alert" className="break-words text-sm text-destructive">{displayError}</p>}
            </div>
            <DialogFooter variant="bare" className="shrink-0 pt-3">
              <AskInCliButton question={decision.question} />
              <DialogClose render={<Button type="button" variant="ghost" size="sm" />}>Close</DialogClose>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      </div>
    </li>
  );
}

/** The decision in a checkpoint's own frame (not inside an Area): the whole form on the card, in a list that scrolls. */
function FullDecisionCard(props: WaitingDecisionCardProps) {
  const { decision } = props;
  const { actions, options, customAnswer, setCustomAnswer, saving, displayError, submitAnswer } = useDecisionAnswer(props);

  return (
    <li
      tabIndex={-1}
      {...answerPressGuard}
      data-testid={`decision-card-${decision.key}`}
      className="nodrag nopan outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/8 p-2.5 text-foreground transition-colors shadow-2xs"
    >
      <div className="flex items-start gap-2">
        <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
        <span className="text-[12.5px] font-medium leading-snug break-words" title={decision.question}>
          <span className="sr-only">Waiting for you: </span>
          <InlinePlanMarkdown content={decision.question} />
        </span>
      </div>

      {options.length > 0 && (
        <div role="group" aria-label="Suggested answers" className="flex flex-wrap gap-1.5 pl-5">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={saving}
              onClick={() => void submitAnswer(option)}
              className="nodrag nopan inline-flex min-h-6 items-center rounded-md border border-border/80 bg-background/80 hover:bg-accent px-2 text-[12.5px] font-medium text-foreground transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              {option}
            </button>
          ))}
        </div>
      )}

      <form
        aria-busy={saving}
        onSubmit={(e) => {
          e.preventDefault();
          void submitAnswer(customAnswer);
        }}
        className="nodrag nopan flex items-center gap-1.5 pl-5"
      >
        <input
          type="text"
          value={customAnswer}
          disabled={saving}
          onChange={(e) => setCustomAnswer(e.target.value)}
          placeholder="Your answer"
          aria-label={`Your answer to ${decision.question.replace(/\*\*|`/g, '')}`}
          className="nodrag nopan h-7 min-w-0 flex-1 rounded border border-input bg-background/90 px-2 text-[12.5px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={saving || !customAnswer.trim()}
          className="nodrag nopan inline-flex h-7 shrink-0 items-center justify-center rounded bg-primary px-2.5 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          {saving ? 'Saving…' : 'Answer'}
        </button>
      </form>

      {displayError && (
        <p role="alert" className="pl-5 text-[12.5px] text-destructive">
          {displayError}
        </p>
      )}

      {actions?.askInCLI && !actions.readOnly && (
        <div className="flex justify-end pl-5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const q = decision.question.replace(/[*_`#]/g, '').trim() || decision.question;
              actions.askInCLI?.(q);
            }}
            className="btn-ask-card nodrag nopan inline-flex h-6 min-h-[24px] items-center gap-1 rounded px-2 text-[12px] text-muted-foreground hover:text-foreground hover:bg-background/80 transition-colors cursor-pointer"
            title={`Ask about "${decision.question.replace(/[*_`#]/g, '').trim() || decision.question}" in CLI`}
          >
            <span>Ask in CLI</span>
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      )}
    </li>
  );
}


function WaitingDecisionCard(props: WaitingDecisionCardProps) {
  return props.width !== undefined ? <CompactDecisionCard {...props} /> : <FullDecisionCard {...props} />;
}

function CheckpointCheckFooter({ data, cpKey }: { data: CheckpointData; cpKey: string }) {
  const actions = useContext(BoardActionsContext);
  const isBusy = Boolean(cpKey && actions?.busyStepKeys?.has(cpKey));
  const checkError = cpKey ? actions?.stepErrors?.[cpKey] : undefined;
  const statusText = checkError ?? (data.proof?.canProgress
    ? (data.proof.lastVerificationSha ? `Check passed on ${data.proof.lastVerificationSha.slice(0, 7)}` : 'Check passed')
    : data.proof ? 'Check failed' : 'Check configured');
  return (
    <footer className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 bg-muted/20 px-3 py-1.5">
      <span
        className={cn('truncate text-[12.5px]', checkError ? 'text-destructive font-medium' : 'text-muted-foreground')}
        role={checkError ? 'alert' : undefined}
        title={checkError ?? (typeof data.check === 'string' ? data.check : undefined)}
      >
        {statusText}
      </span>
      <button
        type="button"
        data-testid={`run-check-${cpKey}`}
        disabled={!actions?.runCheck || isBusy || Boolean(actions?.readOnly)}
        onClick={(e) => {
          e.stopPropagation();
          if (actions?.runCheck && cpKey && !isBusy) {
            void actions.runCheck(cpKey);
          }
        }}
        className={cn(
          'nodrag nopan inline-flex min-h-6 items-center gap-1 rounded border border-border/80 bg-background px-2 py-0.5 text-[12.5px] font-medium text-foreground hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 transition-colors',
          !isBusy && actions?.runCheck && 'cursor-pointer'
        )}
      >
        <ShieldCheck className="size-3.5" />
        <span>{isBusy ? 'Checking…' : 'Run check'}</span>
      </button>
    </footer>
  );
}

/**
 * The decisions that wait for you, inside an Area: "Waits for you" and the first decisions, and a button that opens the rest (and, when
 * they are open, closes them again). The Area's own name is in the header above, and is not said again here.
 */
function WaitingFrame({ id, data, border, titleId, width }: { id?: string; data: CheckpointData; border: string; titleId: string; width?: number }) {
  const actions = useContext(BoardActionsContext);
  const fallbackMutation = useAnswerDecision(actions?.workspaceId ?? '');
  const handleAnswer = async (key: string, answer: string, expected?: string, options?: { optimistic?: boolean }) => {
    if (actions?.answerDecision) {
      return actions.answerDecision(key, answer, expected, options);
    }
    if (actions?.workspaceId) {
      await fallbackMutation.mutateAsync({ key, answer, expected, ...(options ?? {}) });
      return true;
    }
    return false;
  };

  const frame = useRef<HTMLElement>(null);
  const [lost, setLost] = useState(false);
  const onLost = useCallback(() => {
    setLost(true);
    let frames = 0;
    const attempt = () => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected && !document.querySelector('[data-testid="decision-dialog"]')) return;
      frames += 1;
      const target = frame.current?.querySelector<HTMLElement>('[data-testid^="decision-card-"]') ?? frame.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
      else if (frames < 20) requestAnimationFrame(attempt);
    };
    requestAnimationFrame(() => requestAnimationFrame(attempt));
  }, []);
  useEffect(() => {
    if (!lost) return;
    const timer = window.setTimeout(() => setLost(false), 8000);
    return () => window.clearTimeout(timer);
  }, [lost]);

  const expanded = data.waitingExpanded === true;
  // A paged frame has its pager on the header line, at the right: the header keeps that room, and a notice that does not fit in what is left goes on a line of its own.
  const paged = expanded && data.moreWaiting > 0;
  const pagerRoom = paged ? ROW_SIZE.pager + ROW_SIZE.gap + 4 : 0;
  const noticeApart = lost && paged && (width ?? ROW_SIZE.decisionWidth) < 540;
  const notice = <p role="status" title="The question changed in the plan; your answer was not sent." className={cn('min-w-0 break-words text-[12.5px] leading-[14px] text-muted-foreground', noticeApart ? 'shrink-0 px-3 pb-0.5' : 'ml-1 flex-1')}>Question changed; answer not sent</p>;
  const cpKey = data.checkpointKey ?? (id ? id.replace(/^area:checkpoint:|^checkpoint:/, '') : undefined);

  return <article ref={frame} tabIndex={-1} aria-labelledby={titleId} className={cn('flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs', border)}>
    <Anchors />
    <header className="flex h-8 shrink-0 items-center gap-1.5 px-3 pt-1" style={pagerRoom ? { paddingRight: pagerRoom } : undefined}>
      {data.waiting.length > 0 ? (
        <>
          <span aria-hidden="true" className="size-2 rounded-full bg-state-needs" />
          <h2 id={titleId} className="shrink-0 whitespace-nowrap text-[13px] font-semibold leading-5 text-foreground">Waits for you</h2>
        </>
      ) : (
        <>
          <ShieldCheck aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <h2 id={titleId} className="shrink-0 whitespace-nowrap text-[13px] font-semibold leading-5 text-foreground">Check</h2>
        </>
      )}
      {lost && !noticeApart && notice}
    </header>
    {noticeApart && notice}
    {data.waiting.length > 0 && (
      <ul aria-label="Decisions waiting for you" className={cn('flex min-h-0 flex-1 flex-col gap-2 px-2.5', noticeApart ? 'pb-2' : 'pb-4')}>
        {data.waiting.map((decision) => (
          <WaitingDecisionCard key={decision.key} decision={decision} onAnswer={handleAnswer} onLost={onLost} width={width ?? ROW_SIZE.decisionWidth} />
        ))}
      </ul>
    )}
    {(data.moreWaiting > 0 || expanded) && <button
      type="button" data-row-control={data.rowId} aria-expanded={expanded} disabled={!actions} onClick={() => data.rowId && actions?.toggleRow?.(data.rowId)}
      aria-label={expanded ? 'Show fewer decisions waiting for you' : `Show ${data.moreWaiting} more decisions waiting for you`}
      className="board-row-control nodrag nopan flex shrink-0 items-center justify-center border-t border-border/60 px-3 text-[12.5px] font-medium text-foreground hover:bg-accent/40" style={{ height: BOARD_SIZE.moreRow + 6 }}
    >{expanded ? 'Show fewer' : `+${data.moreWaiting} more`}</button>}
    {data.check && !data.done && cpKey && (
      <CheckpointCheckFooter data={data} cpKey={cpKey} />
    )}
  </article>;
}

export function AddStepInline({
  checkpointKey,
  workspaceId,
  defaultOpen = false,
}: {
  checkpointKey?: string;
  workspaceId?: string;
  defaultOpen?: boolean;
}) {
  const actions = useContext(BoardActionsContext);
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const changePlan = useChangePlanFile(workspaceId ?? '');
  const busy = changePlan.isPending;

  if (actions?.readOnly) return null;

  if (!open) {
    return (
      <div className="pt-0.5 pb-1">
        <button
          type="button"
          data-testid={`checkpoint-add-step-trigger${checkpointKey ? `-${checkpointKey}` : ''}`}
          aria-label="Add a step"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
            setError(null);
          }}
          className="nodrag nopan inline-flex min-h-[24px] items-center gap-1 rounded px-1.5 py-0.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 cursor-pointer"
        >
          <Plus aria-hidden="true" className="size-3.5 shrink-0" />
          <span>Add step</span>
        </button>
      </div>
    );
  }

  const submit = async () => {
    const step = text.trim();
    if (!step || busy || submittingRef.current) return;
    if (!workspaceId) {
      setError('No workspace selected.');
      return;
    }
    submittingRef.current = true;
    setError(null);
    try {
      if (actions?.addStep) {
        // The page around the card owns the write (the design page's is inert).
        if (!(await actions.addStep({ step, ...(checkpointKey ? { checkpoint: checkpointKey } : {}) }))) throw new Error('Could not add step.');
      } else {
        await changePlan.mutateAsync({
          type: 'add',
          step,
          ...(checkpointKey ? { checkpoint: checkpointKey } : {}),
        });
      }
      setText('');
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add step.');
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <form
      data-testid={`checkpoint-add-step-form${checkpointKey ? `-${checkpointKey}` : ''}`}
      className="nodrag nopan pt-1 pb-1 space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          data-testid="checkpoint-add-step-input"
          aria-label="The new step"
          placeholder="What needs doing…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              setText('');
              setError(null);
            }
          }}
          className="min-h-[28px] h-7 flex-1 text-[12.5px] px-2 py-1"
        />
        <Button
          size="xs"
          type="submit"
          data-testid="checkpoint-add-step-submit"
          disabled={busy || !text.trim()}
          className="min-h-[24px] text-[12.5px] px-2.5 py-0.5 cursor-pointer"
        >
          {busy ? 'Adding…' : 'Add'}
        </Button>
        <Button
          size="xs"
          type="button"
          variant="ghost"
          data-testid="checkpoint-add-step-cancel"
          onClick={() => {
            setOpen(false);
            setText('');
            setError(null);
          }}
          className="min-h-[24px] text-[12.5px] px-2 py-0.5 cursor-pointer"
        >
          Cancel
        </Button>
      </div>
      {error && <p role="alert" className="text-[12.5px] text-destructive">{error}</p>}
    </form>
  );
}

/**
 * One checkpoint of PLAN.md: whether it is done, how far its steps are, what waits for the user, and the first steps.
 * Folded, it is the header alone, as one button that opens it.
 */
export function BoardCheckpoint({ id, data, width }: NodeProps<CheckpointNode>) {
  const titleId = useId();
  const actions = useContext(BoardActionsContext);
  const fallbackMutation = useAnswerDecision(actions?.workspaceId ?? '');
  const handleAnswer = async (key: string, answer: string, expected?: string, options?: { optimistic?: boolean }) => {
    if (actions?.answerDecision) {
      return actions.answerDecision(key, answer, expected, options);
    }
    if (actions?.workspaceId) {
      await fallbackMutation.mutateAsync({ key, answer, expected, ...(options ?? {}) });
      return true;
    }
    return false;
  };

  const waiting = data.waiting.length + data.moreWaiting;
  const border = waiting ? 'border-warning/60' : data.done ? 'border-success/50' : 'border-border';
  if (!data.open) {
    return <FoldedGroup id={id} className={cn('rounded-xl border bg-card text-card-foreground hover:bg-accent/40', border)}
      label={summaryLabel(data.kind === 'plan'
        ? [data.title, planSubtitle(data, false), waiting > 0 && waitingText(waiting).toLowerCase()]
        : [data.title, data.done ? 'done' : 'not done', stepsText(data).toLowerCase(), waiting > 0 && waitingText(waiting).toLowerCase()])}>
      <span className="block h-10 w-full pr-6">
        <span className={cn('block w-full text-sm font-semibold leading-5 text-foreground', data.kind === 'plan' ? 'truncate' : 'line-clamp-2')} title={data.title}>{data.title}</span>
        {data.kind === 'plan' && <span className="block w-full truncate text-[12.5px] leading-5 text-muted-foreground">{planSubtitle(data, false)}</span>}
      </span>
      <FrameFacts data={data} />
    </FoldedGroup>;
  }
  if (data.waitingOnly) return <WaitingFrame id={id} data={data} border={border} titleId={titleId} width={width} />;

  const cpKey = data.checkpointKey ?? (data.kind === 'plan' ? undefined : id.replace(/^area:checkpoint:|^checkpoint:/, ''));

  return <article
    tabIndex={-1}
    aria-labelledby={titleId}
    className={cn('flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs', border)}
  >
    <Anchors />
    <header className="relative border-b border-border/60 px-3 pt-3" style={{ height: BOARD_SIZE.frameHeader }}>
      {data.kind === 'plan'
        ? <div className="h-10 pr-6">
          <h2 id={titleId} className="truncate text-sm font-semibold leading-5 text-foreground">{data.title}</h2>
          <p className="truncate text-[12.5px] leading-5 text-muted-foreground">{planSubtitle(data, true)}</p>
        </div>
        : <h2 id={titleId} className="line-clamp-2 h-10 pr-6 text-sm font-semibold leading-5 text-foreground" title={data.title}>{data.title}</h2>}
      <FrameFacts data={data} />
      {data.collapsible !== false && <FoldButton id={id} title={data.title} />}
    </header>
    {data.waiting.length > 0 && <ul aria-label="Decisions waiting for you" className="nowheel min-h-0 max-h-60 overflow-y-auto space-y-2 p-2.5">
      {data.waiting.map((decision) => (
        <WaitingDecisionCard key={decision.key} decision={decision} onAnswer={handleAnswer} />
      ))}
      {data.moreWaiting > 0 && <li className="flex items-center border-l-2 border-warning bg-warning/8 px-3 text-[12.5px] text-muted-foreground" style={{ height: BOARD_SIZE.moreRow }}>+{data.moreWaiting} more waiting</li>}
    </ul>}
    {!data.waitingOnly && <div className="nowheel min-h-0 flex-1 overflow-y-auto px-3">
      <ul>
        {data.steps.map((step) => {
          const isBusy = Boolean(actions?.busyStepKeys?.has(step.key));
          const stepError = actions?.stepErrors?.[step.key];
          return (
            <li key={step.key} className="flex items-center gap-2 text-[12.5px]" style={{ height: BOARD_SIZE.stepRow }}>
              <StepCheck
                testId={`checkpoint-step-checkbox-${step.key}`}
                checked={step.done}
                label={step.done ? `Mark "${plainText(step.text)}" not done` : `Mark "${plainText(step.text)}" done`}
                title={stepError ?? (step.done ? `Mark "${plainText(step.text)}" not done` : `Mark "${plainText(step.text)}" done`)}
                disabled={!actions?.toggleStep || isBusy || Boolean(actions?.readOnly)}
                busy={isBusy}
                pressable={Boolean(actions?.toggleStep)}
                className="nodrag nopan"
                onToggle={() => { void actions?.toggleStep?.(step.key, !step.done, step.text); }}
              />
              <span className={cn('min-w-0 flex-1 truncate', step.done ? 'text-muted-foreground line-through' : 'text-foreground')} title={plainText(step.text)}>
                <span className="sr-only">{step.done ? 'Done: ' : 'Not done: '}</span><InlinePlanMarkdown content={step.text} />
              </span>
              {stepError && <span role="alert" className="shrink-0 text-[12.5px] text-destructive">{stepError}</span>}
            </li>
          );
        })}
        {data.steps.length === 0 && <li className="flex items-center text-[12.5px] text-muted-foreground" style={{ height: BOARD_SIZE.stepRow }}>No steps yet</li>}
        {data.moreSteps > 0 && <li className="flex items-center text-[12.5px] text-muted-foreground" style={{ height: BOARD_SIZE.moreRow }}>+{data.moreSteps} more</li>}
      </ul>
      {!actions?.readOnly && <AddStepInline checkpointKey={cpKey} workspaceId={actions?.workspaceId} />}
    </div>}
    {data.check && !data.done && (() => {
      const checkKey = cpKey ?? id.replace(/^area:checkpoint:|^checkpoint:/, '');
      return <CheckpointCheckFooter data={data} cpKey={checkKey} />;
    })()}
  </article>;
}

/** The title row of a card that opens: the whole row is the button, and a small icon at its end says where it opens. */
const OPENER = 'nodrag nopan flex h-5 w-full items-center gap-1.5 rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none';

/**
 * A source document: its role and status, and the first lines of its summary. A superseded one recedes but keeps its status.
 * Its title row opens it in the reader beside the board; a document that is a link opens on the web, in a new tab.
 */
export function BoardDocument({ id, data }: NodeProps<DocumentNode>) {
  const titleId = useId();
  const actions = useContext(BoardActionsContext);
  const reading = useContext(BoardReadingContext) === id;
  const web = data.url ? classifyMarkdownLink(data.url) : undefined;
  const href = web?.kind === 'external' && !web.href.startsWith('mailto:') ? web.href : undefined;
  const icon = <FileText aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />;
  const title = (
    <span id={titleId} className={cn('min-w-0 flex-1 truncate text-sm font-semibold inline-flex items-center gap-1.5', data.dimmed ? 'text-muted-foreground' : 'text-foreground')} title={data.title}>
      {data.fresh && (
        <>
          <FreshDot />
          <span className="sr-only">New since you looked. </span>
        </>
      )}
      <span className="truncate">{data.title}</span>
    </span>
  );
  if (data.compact) {
    const opens = Boolean(actions && data.filename) || Boolean(href);
    return <article
      tabIndex={-1} aria-labelledby={titleId} aria-current={reading ? 'true' : undefined}
      onClick={opens ? (event) => brickPress(event, (card) => firstControl(card)) : undefined}
      className={cn('relative flex h-full w-full flex-col justify-between overflow-hidden rounded-lg border px-3 py-2 shadow-xs', CARD_FOCUS, opens && BRICK,
        data.dimmed ? 'border-dashed border-border bg-muted text-muted-foreground' : 'border-border bg-card text-card-foreground', reading && 'ring-2 ring-primary')}
    >
      <Anchors />
      {data.fresh && <span aria-hidden="true" className="board-fresh" />}
      {data.filename
        ? <button type="button" data-card-main className={TITLE_BUTTON} aria-label={`Open ${data.title}`} disabled={!actions}
          onClick={(event) => actions?.openInReader({ path: data.filename!, title: data.title, card: id, source: data.sourceId }, event.currentTarget)}
        >{icon}{title}</button>
        : href
          ? <a href={href} target="_blank" rel="noopener noreferrer" data-card-main className={TITLE_BUTTON} aria-label={`Open ${data.title} (opens outside the app)`}>
            {icon}{title}<ExternalLink aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          </a>
          : <div className="flex h-5 items-center gap-1.5">{icon}{title}</div>}
      <div className="flex h-[20px] items-center gap-1.5">
        <Badge variant="outline">{ROLE_LABEL[data.role] ?? data.role}</Badge>
        <Badge variant={STATUS_BADGE[data.status] ?? 'outline'}>{STATUS_LABEL[data.status] ?? data.status}</Badge>
      </div>
      <p className="line-clamp-1 text-[13px] leading-[17px] text-muted-foreground">{data.summary}</p>
    </article>;
  }
  return <article
    tabIndex={-1}
    aria-labelledby={titleId} aria-current={reading ? 'true' : undefined}
    className={cn('relative flex h-full w-full flex-col gap-1.5 overflow-hidden rounded-lg border px-3 py-2.5 shadow-xs',
      data.dimmed ? 'border-dashed border-border bg-muted text-muted-foreground' : 'border-border bg-card text-card-foreground', reading && 'ring-2 ring-primary')}
  >
    <Anchors />
    {data.fresh && <span aria-hidden="true" className="board-fresh" />}
    {data.filename
      ? <button
        type="button" className={OPENER} aria-label={`Open ${data.title}`} disabled={!actions}
        onClick={(event) => actions?.openInReader({ path: data.filename!, title: data.title, card: id, source: data.sourceId }, event.currentTarget)}
      >{icon}{title}<PanelRightOpen aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /></button>
      : href
        ? <a href={href} target="_blank" rel="noopener noreferrer" className={OPENER} aria-label={`Open ${data.title} (opens outside the app)`}>
          {icon}{title}<ExternalLink aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        </a>
        : <div className="flex h-5 items-center gap-1.5">{icon}{title}</div>}
    <div className="flex h-[18px] items-center gap-1.5">
      <Badge variant="outline">{ROLE_LABEL[data.role] ?? data.role}</Badge>
      <Badge variant={STATUS_BADGE[data.status] ?? 'outline'}>{STATUS_LABEL[data.status] ?? data.status}</Badge>
    </div>
    <p className="line-clamp-3 text-xs leading-[18px] text-muted-foreground">{data.summary}</p>
  </article>;
}

/**
 * "1 note" on a commit card: the notes an AI left on that commit. Its own button (the card is not one), it opens Review on the commit with
 * the notes in view. Nothing is drawn for a commit without notes.
 */
function CommitNoteMarker({ id, subject, commit }: { id: string; subject: string; commit: { repo: string; sha: string } | null }) {
  const notes = useContext(CommitNotesContext);
  const actions = useContext(BoardActionsContext);
  if (!commit) return null;
  const mine = notesOfCommit(notes, commit.repo, commit.sha);
  const latest = mine[0];
  if (!latest) return null;
  const text = noteCountText(mine.length);
  const look = 'inline-flex h-6 min-h-6 shrink-0 items-center gap-1 rounded px-1.5 -my-0.5 text-xs font-medium whitespace-nowrap text-violet-700 dark:text-violet-300';
  if (!actions) return <span data-testid="commit-note-marker" title={latest.title} className={look}><StickyNote aria-hidden="true" className="size-3" />{text}</span>;
  return (
    <button
      type="button"
      data-testid="commit-note-marker"
      title={latest.title}
      aria-label={`${text}: ${latest.title}. Open in Review`}
      onClick={(event) => {
        event.stopPropagation();
        requestNotesView(commit.repo, commit.sha);
        actions.openInReader({ path: `${commit.repo} · ${commit.sha}`, title: subject, card: id, commit }, event.currentTarget);
      }}
      className={cn(look, 'nodrag nopan cursor-pointer hover:bg-violet-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
    >
      <StickyNote aria-hidden="true" className="size-3" />{text}
    </button>
  );
}

/** One commit: its short sha, who made it and when, and its subject. */
export function BoardCommit({ id, data }: NodeProps<CommitNode>) {
  const shaId = useId();
  const ago = agoText(data.at);
  const actions = useContext(BoardActionsContext);
  const reading = useContext(BoardReadingContext) === id;
  const commit = parseCommitNodeId(id);
  const opens = Boolean(actions && commit);

  const openCommit = (button: HTMLElement) => {
    if (!commit) return;
    actions?.openInReader({ path: `${commit.repo} · ${data.sha}`, title: data.subject, card: id, commit }, button);
  };

  const onSubjectClick = (event: MouseEvent<HTMLButtonElement>) => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString() && event.currentTarget.contains(selection.anchorNode) && event.currentTarget.contains(selection.focusNode)) {
      return;
    }
    openCommit(event.currentTarget);
  };

  if (data.compact) {
    return <article
      tabIndex={-1}
      aria-labelledby={shaId}
      aria-current={reading ? 'true' : undefined}
      onClick={opens ? (event) => brickPress(event, (card) => firstControl(card)) : undefined}
      className={cn('relative flex h-full w-full flex-col justify-center gap-1 overflow-hidden rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-xs', CARD_FOCUS, opens && BRICK, reading && 'ring-2 ring-primary')}
    >
      <Anchors />
      {data.fresh && <span aria-hidden="true" className="board-fresh" />}
      <div className="flex h-5 items-center gap-2 text-[13px]">
        <GitCommitHorizontal aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <code id={shaId} className="shrink-0 font-mono text-primary">{data.sha}</code>
        {data.fresh && (
          <>
            <FreshDot />
            <span className="sr-only">New since you looked. </span>
          </>
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={data.author}>{data.author}</span>
        {ago && <time dateTime={data.at} className="shrink-0 whitespace-nowrap text-muted-foreground">{ago}</time>}
        <CommitNoteMarker id={id} subject={data.subject} commit={commit} />
      </div>
      {commit ? (
        <button
          type="button"
          data-card-main
          aria-label={`Open ${data.subject}`}
          disabled={!actions}
          onClick={onSubjectClick}
          className="nodrag nopan block w-full min-w-0 rounded-sm text-left outline-hidden hover:underline disabled:pointer-events-none"
        >
          <span className="line-clamp-2 text-[13px] leading-[17px] text-foreground" title={data.subject}>{data.subject}</span>
        </button>
      ) : (
        <p className="line-clamp-2 text-[13px] leading-[17px] text-foreground" title={data.subject}>{data.subject}</p>
      )}
      {data.pictures && data.pictures.length > 0 && actions && (
        <div className="flex items-center gap-1.5 overflow-hidden pt-0.5">
          {data.pictures.map((pic) => (
            <button
              key={pic.path}
              type="button"
              className="cursor-pointer rounded border border-border/40 p-0 overflow-hidden hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring"
              title={`View picture: ${pic.title}`}
              aria-label={`View picture: ${pic.title}`}
              onClick={(e) => {
                e.stopPropagation();
                actions.openInReader({ path: pic.path, title: pic.title || pic.path }, e.currentTarget);
              }}
            >
              <img
                src={pictureSrc(actions, pic.path)}
                alt=""
                aria-hidden="true"
                loading="lazy"
                className="h-6 w-9 shrink-0 object-cover bg-muted/20"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            </button>
          ))}
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {data.pictures.length} {data.pictures.length === 1 ? 'pic' : 'pics'}
          </span>
        </div>
      )}
    </article>;
  }
  return <article
    tabIndex={-1}
    aria-labelledby={shaId}
    aria-current={reading ? 'true' : undefined}
    className={cn('relative flex h-full w-full flex-col gap-1 overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5 text-card-foreground shadow-xs', reading && 'ring-2 ring-primary')}
  >
    <Anchors />
    {data.fresh && <span aria-hidden="true" className="board-fresh" />}
    <div className="flex h-4 items-center justify-between gap-2 text-xs">
      <div className="flex items-center gap-1.5 min-w-0">
        <GitCommitHorizontal aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <code id={shaId} className="shrink-0 font-mono text-primary font-medium">{data.sha}</code>
        {data.fresh && (
          <>
            <FreshDot />
            <span className="sr-only">New since you looked. </span>
          </>
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={data.author}>{data.author}</span>
        {ago && <time dateTime={data.at} className="shrink-0 whitespace-nowrap text-muted-foreground">{ago}</time>}
        <CommitNoteMarker id={id} subject={data.subject} commit={commit} />
      </div>
      <Pill className="shrink-0">commit</Pill>
    </div>
    {commit ? (
      <button
        type="button"
        data-card-main
        aria-label={`Open ${data.subject}`}
        disabled={!actions}
        onClick={onSubjectClick}
        className="nodrag nopan block w-full min-w-0 rounded-sm text-left outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
      >
        <span className="line-clamp-2 text-sm leading-[18px] text-foreground" title={data.subject}>{data.subject}</span>
      </button>
    ) : (
      <p className="line-clamp-2 text-sm leading-[18px] text-foreground" title={data.subject}>{data.subject}</p>
    )}
    {data.pictures && data.pictures.length > 0 && actions && (
      <div className="flex items-center gap-1.5 overflow-hidden pt-1">
        {data.pictures.map((pic) => (
          <button
            key={pic.path}
            type="button"
            className="cursor-pointer rounded border border-border/40 p-0 overflow-hidden hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring"
            title={`View picture: ${pic.title}`}
            aria-label={`View picture: ${pic.title}`}
            onClick={(e) => {
              e.stopPropagation();
              actions.openInReader({ path: pic.path, title: pic.title || pic.path }, e.currentTarget);
            }}
          >
            <img
              src={pictureSrc(actions, pic.path)}
              alt=""
              aria-hidden="true"
              title={pic.title}
              loading="lazy"
              className="h-7 w-11 shrink-0 object-cover bg-muted/20"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          </button>
        ))}
        <span className="truncate text-xs text-muted-foreground">
          {data.pictures.length} {data.pictures.length === 1 ? 'picture' : 'pictures'}
        </span>
      </div>
    )}
    {actions?.askInCLI && !actions.readOnly && (
      <div className="flex justify-end pt-1 border-t border-border/40">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            const commitSummary = data.subject ? `${data.sha}: ${data.subject}` : `commit ${data.sha}`;
            actions.askInCLI?.(commitSummary);
          }}
          className="btn-ask-card nodrag nopan inline-flex h-6 min-h-[24px] items-center gap-1 rounded border border-border/80 px-2 text-[11.5px] font-medium text-primary hover:border-primary/50 hover:bg-primary/10 transition-colors cursor-pointer"
          title={`Ask about commit ${data.sha} in CLI`}
        >
          <span>Ask in CLI</span>
          <span aria-hidden="true">↗</span>
        </button>
      </div>
    )}
  </article>;
}

/**
 * The work in a repository that is not committed yet, first in its commits row. It is the size of a commit card and, like one,
 * the whole card is one press: it opens the Code window on the first changed file. No sha: it is not a commit.
 */
export function BoardUncommitted({ id, data }: NodeProps<UncommittedNode>) {
  const titleId = useId();
  const actions = useContext(BoardActionsContext);
  const opens = Boolean(actions);
  const open = (button: HTMLElement) => {
    openCodeWindow(actions!.workspaceId, { opener: button, area: actions?.activeAreaTitle, file: { repoName: data.repoName, repoPath: data.repoPath, file: data.firstFile } });
  };
  return <article
    tabIndex={-1}
    data-uncommitted={id}
    aria-labelledby={titleId}
    onClick={opens ? (event) => brickPress(event, (card) => firstControl(card)) : undefined}
    className={cn('relative flex h-full w-full flex-col justify-center gap-1 overflow-hidden rounded-lg border border-dashed border-primary/50 bg-card px-3 py-2 text-card-foreground shadow-xs', CARD_FOCUS, opens && BRICK)}
  >
    <Anchors />
    <div className="flex h-5 items-center gap-2 text-[13px]">
      <GitCompare aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
      <button
        type="button"
        id={titleId}
        data-card-main
        aria-label={`Open ${data.title} in Review`}
        disabled={!opens}
        onClick={(event) => open(event.currentTarget)}
        className="nodrag nopan min-w-0 truncate rounded-sm text-left font-medium text-foreground outline-hidden hover:underline disabled:pointer-events-none"
      >{data.title}</button>
      {data.numbers && (
        <span className="ml-auto shrink-0 font-mono text-[12px] tabular-nums">
          <span className="text-success-foreground">{data.numbers.split(' ')[0]}</span>{' '}<span className="text-destructive-foreground">{data.numbers.split(' ')[1]}</span>
        </span>
      )}
    </div>
    <p className="truncate font-mono text-[12px] leading-4 text-muted-foreground" title={data.names.join(', ')}>{data.names.join(', ')}</p>
  </article>;
}

/** Stands in a lane that has nothing in it, so the gap is explained and not mistaken for something that failed to load. */
export function BoardPlaceholder({ data }: NodeProps<PlaceholderNode>) {
  return <p className={cn('flex h-full w-full items-center overflow-hidden rounded-lg border border-dashed border-border bg-card/60 px-3 text-muted-foreground', data.compact ? 'text-[13px] leading-[17px]' : 'text-xs leading-4')}>{data.text}</p>;
}

// ─── Cards ──────────────────────────────────────────────────────────────────

const ANSWER_CARD = 'group relative flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xs transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md hover:border-border/80';
const ANSWER_MAIN = 'nodrag nopan flex h-full w-full min-w-0 flex-col gap-1 px-3 py-2 text-left outline-hidden cursor-pointer';

/** The status line of a code card: what the check found, with a mark that does not rely on colour. */
function CodeStatusLine({ data, id }: { data: Extract<AnswerCardData, { variant: 'code' }>; id: string }) {
  const status = codeStatus(data.check, data.where);
  if (!status) return null;
  const Mark = status.tone === 'ok' ? Check : status.tone === 'warn' ? TriangleAlert : CircleHelp;
  return (
    <span className="flex shrink-0 flex-col">
      <span id={id} data-status={data.check.status} className={cn('flex h-[18px] items-center gap-1 text-[12px] font-medium leading-4', status.tone === 'ok' ? 'text-state-done' : status.tone === 'warn' ? 'text-warning-foreground' : 'text-muted-foreground')}>
        <Mark aria-hidden="true" className="size-3.5 shrink-0" />
        {status.label}
      </span>
      {status.hint && <span className="truncate text-[12px] leading-4 text-muted-foreground" title={status.hint}>{status.hint}</span>}
    </span>
  );
}

/** What the compare view says when a refresh has turned the check into something else, by what it now is. */
function compareWords(status: string): string {
  switch (status) {
    case 'gone': return 'The file is gone.';
    case 'unreadable': return 'The file can no longer be read.';
    case 'not-in-workspace': return 'The file is no longer in this workspace.';
    default: return 'The copy matches the file again.';
  }
}

/** The file a code card opens in the Code window, and at which line; null when it names none. */
function codeTarget(data: Extract<AnswerCardData, { variant: 'code' }>) {
  const line = codeOpenLine(data);
  return data.file ? { ...(data.repo && data.repoPath ? { repo: { name: data.repo, path: data.repoPath } } : {}), file: data.file, ...(line ? { line } : {}) } : null;
}

/** The copy as the answer has it beside the same lines now, with the lines that differ marked. */
function CompareCode({ data }: { data: Extract<AnswerCardData, { variant: 'code' }> }) {
  const before = data.copy.split('\n');
  if (data.check.status !== 'changed') return <p className="text-sm text-muted-foreground">{compareWords(data.check.status)}</p>;
  const nowText = data.check.current ?? '';
  const after = nowText === '' ? [] : nowText.split('\n');
  const marks = differingLines(before, after);
  const start = data.start ?? 1;
  const column = (title: string, lines: string[], differs: boolean[], sign: string, empty: string) => (
    <section className="min-w-0 flex-1" aria-label={title}>
      <h3 className="mb-1 text-[12px] font-semibold text-muted-foreground">{title}</h3>
      <div className="max-h-[50vh] overflow-auto rounded-md border border-border bg-muted/30 py-1 font-mono text-[12px] leading-4">
        {lines.length === 0 && <p className="px-2 font-sans text-muted-foreground">{empty}</p>}
        {lines.map((line, index) => (
          <div key={index} data-differs={differs[index] ? 'true' : undefined} className={cn('flex gap-2 px-2', differs[index] && (sign === '-' ? 'bg-destructive/10' : 'bg-success/10'))}>
            <span aria-hidden="true" className="w-8 shrink-0 select-none text-right text-muted-foreground tabular-nums">{start + index}</span>
            <span aria-hidden="true" className="w-3 shrink-0 select-none text-muted-foreground">{differs[index] ? sign : ''}</span>
            <span className="min-w-0 whitespace-pre-wrap break-all">{line === '' ? ' ' : line}</span>
          </div>
        ))}
      </div>
    </section>
  );
  return (
    <div className="@container">
    <div className="flex flex-col gap-3 @[44rem]:flex-row">
      {column('In the answer', before, marks.before, '-', 'Nothing')}
      {column('Now', after, marks.after, '+', 'Those lines are no longer in the file.')}
    </div>
    </div>
  );
}

/**
 * A card of an answer in the Questions space: text, a copied block of code with the check of its place, a picture, or a diagram.
 * The whole card is its one button, named by what it opens: the reader (at the part's heading), the picture, the real file in the
 * Code window, or, when the copy no longer matches, a view that shows the copy beside the lines now.
 */
export function BoardAnswerCard({ id, data }: NodeProps<AnswerNode>) {
  const actions = useContext(BoardActionsContext);
  const reading = useContext(BoardReadingContext) === id;
  const titleId = useId();
  const statusId = useId();
  const main = useRef<HTMLButtonElement>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  // The view closed on a card that no longer says "Changed since": its button is a new one, so the keyboard is given to it
  const compareWasOpen = useRef(false);
  const stillChanged = data.variant === 'code' && data.check.status === 'changed';
  // "Open the file" from a view that no longer shows a change: the Code window is opened once the card's new button is there, so that is its opener
  const openAfter = useRef(false);
  useEffect(() => {
    if (compareWasOpen.current && !compare && !stillChanged) {
      main.current?.focus();
      if (openAfter.current && data.variant === 'code') {
        openAfter.current = false;
        const again = codeTarget(data);
        if (again) actions?.openCode?.(again, main.current);
      }
    }
    compareWasOpen.current = compare;
  }, [compare, stillChanged, data, actions]);
  const readAnswer = (event: MouseEvent<HTMLElement>) => actions?.openInReader({ path: data.path, title: data.question, card: id, ...(data.heading ? { heading: data.heading } : {}) }, event.currentTarget);
  const frame = (label: string, describedBy: string | undefined, content: ReactNode, press: ((event: MouseEvent<HTMLElement>) => void) | null, extra?: ReactNode) => (
    <article
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      aria-current={reading ? 'true' : undefined}
      data-answer-card={data.variant}
      onClick={actions ? (event) => brickPress(event, (card) => firstControl(card, '[data-card-main]')) : undefined}
      className={cn(ANSWER_CARD, CARD_FOCUS, actions && BRICK, reading && 'ring-2 ring-primary')}
    >
      <Anchors />
      {actions && press ? (
        <button ref={main} type="button" data-card-main aria-label={label} onClick={press} className={ANSWER_MAIN}>{content}</button>
      ) : (
        <div className={ANSWER_MAIN}>{content}</div>
      )}
      {extra}
    </article>
  );

  if (data.variant === 'text') {
    return frame(`Read ${data.title}`, undefined, <>
      <span id={titleId} className="sr-only">{data.title}</span>
      <span className="line-clamp-5 break-words text-[13px] leading-[18px] text-foreground">{readableText(data.text)}</span>
    </>, readAnswer);
  }

  if (data.variant === 'diagram') {
    return frame('Read the diagram', undefined, <>
      <span id={titleId} className="truncate text-[12px] font-semibold uppercase leading-4 tracking-wide text-muted-foreground">Diagram</span>
      <Diagram source={data.source} card cardZoom={READABLE_ZOOM} />
    </>, readAnswer);
  }

  if (data.variant === 'picture') {
    const shown = data.src && broken !== data.src && actions;
    if (!shown) {
      return frame(`Read ${data.title}`, undefined, <>
        <span id={titleId} className="truncate text-[12px] font-semibold uppercase leading-4 tracking-wide text-muted-foreground">Picture</span>
        <span role="status" className="flex flex-1 items-center break-all text-[13px] leading-[18px] text-muted-foreground">Picture not found: {data.rawPath}</span>
      </>, readAnswer);
    }
    return frame(`Open ${data.title}`, undefined, <>
      <span className="relative min-h-0 w-full flex-1 overflow-hidden rounded-md border border-border/60 bg-black/40">
        <img
          src={pictureSrc(actions, data.src!)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(data.src)}
          className="size-full object-cover"
        />
      </span>
      <span id={titleId} className="truncate text-[12.5px] leading-4 text-foreground">{data.title}</span>
    </>, (event) => actions.openInReader({ path: data.src!, title: data.title, card: id }, event.currentTarget));
  }

  // Code
  const status = codeStatus(data.check, data.where);
  const head = codeHeadParts(data, data.check);
  const lines = data.copy.split('\n').slice(0, status?.hint ? 2 : 3).join('\n');
  const content = (
    <>
      <span id={titleId} className="flex min-w-0 font-mono text-[12px] font-medium leading-[18px] text-foreground" title={data.title}>
        {/* A long place is cut at its start, so the file's name and the lines always show */}
        <span className="min-w-0 truncate" style={{ direction: 'rtl', textAlign: 'left' }}>{head.name}</span>
        <span className="shrink-0 whitespace-pre">{head.lines}</span>
      </span>
      <pre className={cn('overflow-hidden whitespace-pre font-mono text-[12px] leading-4 text-muted-foreground', status?.hint ? 'h-8' : 'h-12')}>{lines === '' ? ' ' : lines}</pre>
      <CodeStatusLine data={data} id={statusId} />
    </>
  );
  const label = `${data.title}${status ? `, ${status.label}` : ''}`;
  const target = codeTarget(data);
  // Drawn while the view is open, whatever the check now says: a refresh must not close it or drop the keyboard
  if ((data.check.status === 'changed' || compare) && target && actions) {
    return (
      <article
        aria-labelledby={titleId}
        aria-describedby={statusId}
        data-answer-card="code"
        onClick={(event) => brickPress(event, (card) => firstControl(card, '[data-card-main]'))}
        className={cn(ANSWER_CARD, CARD_FOCUS, BRICK, 'border-warning/50')}
      >
        <Anchors />
        <Dialog open={compare} onOpenChange={setCompare}>
          <DialogTrigger render={<button ref={main} type="button" data-card-main aria-label={`Compare ${label}`} className={ANSWER_MAIN} onClick={(event) => event.stopPropagation()} />}>
            {content}
          </DialogTrigger>
          <DialogPopup className="max-w-5xl" data-testid="answer-compare">
            <DialogHeader>
              <DialogTitle className="font-mono text-sm font-semibold">{data.title}</DialogTitle>
              <DialogDescription>{data.check.status === 'changed' ? 'The copy in the answer no longer matches the file. Lines that differ are marked.' : 'The file has changed since this view was opened.'}</DialogDescription>
            </DialogHeader>
            <DialogPanel><CompareCode data={data} /></DialogPanel>
            <DialogFooter variant="bare">
              {(data.check.status === 'changed' || data.check.status === 'matches' || data.check.status === 'moved') && (
                <Button
                  type="button" size="sm" variant="outline" data-testid="answer-open-file"
                  onClick={() => {
                    if (data.check.status === 'changed') { setCompare(false); actions.openCode?.(target, main.current); } else { openAfter.current = true; setCompare(false); }
                  }}
                >Open the file</Button>
              )}
              <DialogClose render={<Button type="button" variant="ghost" size="sm" />}>Close</DialogClose>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      </article>
    );
  }
  const opens = (data.check.status === 'matches' || data.check.status === 'moved') && target;
  return frame(
    opens ? `Open ${label}` : `Read ${label}`,
    status ? statusId : undefined,
    content,
    opens ? (event) => actions?.openCode?.(target, event.currentTarget) : readAnswer,
  );
}

/** How far an Area is, as words. */
const areaSteps = (data: AreaData) => data.kind === 'plan'
  ? (data.stepsTotal ? `${data.stepsTotal} ${data.stepsTotal === 1 ? 'step' : 'steps'} outside the checkpoints` : 'Steps outside the checkpoints')
  : stepsText(data);

/** What names an Area to those who cannot see it: its title, its state, its steps, what waits, what it holds and any problem. */
function areaLabel(data: AreaData, hiddenSubtitle?: string): string {
  const counts = areaCounts(data);
  return summaryLabel([
    data.title,
    data.done ? 'done' : data.current ? areaFocusWord(data).toLowerCase() : data.kind === 'checkpoint' ? 'not done' : undefined,
    !isStepless(data.kind) ? areaSteps(data).toLowerCase() : undefined,
    data.waitingCount > 0 ? (data.waitingCount === 1 ? 'waits for you' : `${data.waitingCount} wait for you`) : undefined,
    counts.length > 0 ? counts.join(', ') : undefined,
    data.warning?.toLowerCase(),
    hiddenSubtitle,
  ]);
}

/** What the card's text is, at 13.5 px so that it is still 12 px at the least zoom of the overview (0.9). */
const AREA_TEXT = 'text-[13.5px] leading-4 text-muted-foreground';

/** An area at Level 0: an interactive overview card summarizing a checkpoint or logical area. It shows only what the Area has. */
export function BoardArea({ id, data }: NodeProps<AreaNode>) {
  const actions = useContext(BoardActionsContext);
  const [failedPics, setFailedPics] = useState<string[]>([]);
  const visiblePics = data.pictures.filter((pic) => !failedPics.includes(pic.path));
  const waiting = data.waitingCount;
  const border = waiting > 0 ? 'border-warning/60' : data.done ? 'border-success/50' : 'border-border';
  const countItems = areaCountItems(data);
  const stepsLabel = areaSteps(data);
  const progress = data.stepsTotal ? (data.stepsDone / data.stepsTotal) * 100 : 0;
  const showFooter = data.heroShowFooter ?? true;
  const footer = showFooter && (countItems.length > 0 || Boolean(data.warning));
  const showPictures = data.heroShowPictures ?? true;
  const showPreview = data.heroShowPreview ?? true;
  const stepLimit = data.heroOpenStepLimit ?? 3;

  return (
    <div className="relative h-full w-full rounded-2xl">
      <Anchors />
      {data.fresh && <span key={data.freshKey ?? data.title} aria-hidden="true" className="board-fresh" />}
      <div
        className={cn(
          'nodrag nopan relative flex h-full w-full flex-col overflow-hidden rounded-2xl border bg-card p-3 text-left text-card-foreground shadow-xs transition-colors hover:bg-accent/35',
          border,
        )}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button')) return;
          actions?.openArea?.(id, event.currentTarget);
        }}
      >
        <button
          type="button"
          onClick={(event) => actions?.openArea?.(id, event.currentTarget)}
          aria-label={areaLabel(data)}
          className="board-area nodrag nopan flex w-full flex-col text-left focus-visible:outline-2 focus-visible:outline-ring rounded-lg cursor-pointer"
        >
          <span className={cn('flex h-5 w-full shrink-0 items-center gap-1.5 whitespace-nowrap', AREA_TEXT)}>
            {data.kind === 'checkpoint' && (
              data.done ? (
                <Badge variant="success" className="board-area-badge sm:h-5 sm:text-[13.5px]">Done</Badge>
              ) : data.current ? (
                <Badge variant={data.nowSet ? 'default' : 'outline'} className="board-area-badge sm:h-5 sm:text-[13.5px]">{areaFocusWord(data)}</Badge>
              ) : null
            )}
            {data.kind === 'plan' && <Badge variant="outline" className="board-area-badge sm:h-5 sm:text-[13.5px]">Plan</Badge>}
            {waiting > 0 && <Badge variant="warning" className="board-area-badge sm:h-5 sm:text-[13.5px]">{waitingText(waiting)}</Badge>}
            <ChevronRight aria-hidden="true" className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </span>

          <span className="mt-1.5 line-clamp-2 shrink-0 text-sm font-semibold leading-5 text-foreground" title={data.title}>
            {data.fresh && !data.current && !data.done && (
              <FreshDot inline />
            )}
            {data.title}
          </span>

          {!isStepless(data.kind) && (
            <span className="mt-1 block shrink-0 w-full">
              <span className={cn('block truncate', AREA_TEXT)}>{stepsLabel}</span>
              <span aria-hidden="true" className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted">
                <span
                  className={cn('block h-full rounded-full', data.done ? 'bg-success' : 'bg-primary')}
                  style={{ width: `${progress}%` }}
                />
              </span>
            </span>
          )}
        </button>

        {/* The open steps inside the focus Area: Now/Next up step and the next two open steps, each a real button in the tab order */}
        {data.openSteps && data.openSteps.length > 0 && stepLimit > 0 && (
          <div className="mt-2 space-y-1">
            {data.openSteps.slice(0, stepLimit).map((step, idx) => {
              const isNow = idx === 0 && data.nowSet;
              const isNextUp = idx === 0 && !data.nowSet;
              const text = plainText(step.text);
              return (
                <button
                  key={step.key}
                  type="button"
                  data-step-key={step.key}
                  title={text}
                  aria-label={text}
                  onClick={(e) => {
                    e.stopPropagation();
                    actions?.openStep?.(id, step.key, e.currentTarget);
                  }}
                  className={cn(
                    'nodrag nopan flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring cursor-pointer',
                    idx === 0 ? 'bg-muted/40 font-medium text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {isNow && <span aria-hidden="true" className="board-now-dot size-2 shrink-0 rounded-full bg-state-now" />}
                  {isNextUp && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />}
                  {idx > 0 && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-muted-foreground/30" />}
                  {idx === 0 && (
                    <span className={cn('shrink-0 font-semibold', isNow ? 'text-state-now' : 'text-muted-foreground')}>
                      {data.nowSet ? 'Now' : 'Next up'}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{text}</span>
                </button>
              );
            })}
          </div>
        )}

        {showPictures && visiblePics.length > 0 && actions ? (
          <div className="mt-2 flex h-16 shrink-0 items-center gap-2 overflow-hidden rounded-md">
            {visiblePics.map((pic) => (
              <button
                key={pic.path}
                type="button"
                data-path={pic.path}
                aria-label={pic.alt || pic.path}
                title={pic.alt || pic.path}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.openInReader({ path: pic.path, title: pic.alt || pic.path }, e.currentTarget);
                }}
                className="nodrag nopan relative h-full w-20 shrink-0 overflow-hidden rounded border border-border/50 cursor-pointer focus-visible:outline-2 focus-visible:outline-ring hover:opacity-85 transition-opacity"
              >
                <img
                  src={pictureSrc(actions, pic.path)}
                  alt=""
                  aria-hidden="true"
                  loading="lazy"
                  onError={() => {
                    setFailedPics((prev) => (prev.includes(pic.path) ? prev : [...prev, pic.path]));
                  }}
                  className="h-full w-full object-cover"
                />
              </button>
            ))}
          </div>
        ) : showPreview && data.preview ? (
          <span className={cn('mt-2 line-clamp-2 shrink-0', AREA_TEXT)}>{data.preview}</span>
        ) : null}

        {footer && (
          <>
            <span aria-hidden="true" className="min-h-2 flex-1" />
            <div className={cn('flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-border/50 pt-2', AREA_TEXT)}>
              {countItems.map((item, idx) => (
                <Fragment key={item.kind}>
                  {idx > 0 && <span aria-hidden="true" className="select-none text-muted-foreground/60">·</span>}
                  <button
                    type="button"
                    data-count-kind={item.kind}
                    aria-label={item.actionLabel}
                    title={item.actionLabel}
                    onClick={(e) => {
                      e.stopPropagation();
                      actions?.openCount?.(id, item.kind, e.currentTarget);
                    }}
                    className={cn('nodrag nopan inline-flex min-h-[24px] items-center rounded px-1 text-[12px] leading-4 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring cursor-pointer', item.warn && 'font-medium text-warning-foreground')}
                  >
                    {item.label}
                  </button>
                </Fragment>
              ))}
              {data.warning && <span className="text-destructive-foreground">{data.warning}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The count line of an answer in the overview, on one line: the counts are cut at their end when the card is narrow, and
 * "N changed since" stays whole, in the warning colour, because it is the one that wants a look.
 */
function AnswerCountLine({ data }: { data: AreaData }) {
  const words = answerCountWords(data.answerCounts ?? { parts: 0, code: 0, pictures: 0, changed: 0 });
  const changed = words.find((word) => word.kind === 'changed');
  const rest = words.filter((word) => word.kind !== 'changed').map((word) => word.label).join(' · ');
  return (
    <span className="flex min-w-0 whitespace-nowrap">
      <span className="min-w-0 truncate">{rest}</span>
      {changed && <span className="shrink-0 whitespace-pre font-medium text-warning-foreground">{rest ? ' · ' : ''}{changed.label}</span>}
    </span>
  );
}

/** How wide a count button's words are at 12 px, with its padding: a guess made without the browser. */
const newsLabelWidth = (label: string) => Math.ceil(textEm(label) * 12) + 8;

/**
 * "1 question" on a row or card of an Area: the answers about it, as a button of its own that opens the newest answer.
 * On `BoardAreaRow`, this always renders as its own non-shrinking button so disposable secondary news never clips it.
 */
function QuestionCount({ id, data, className }: { id: string; data: AreaData; className?: string }) {
  const actions = useContext(BoardActionsContext);
  const item = data.questionItem;
  if (!item) return null;
  return (
    <button
      type="button"
      data-count-kind="question"
      aria-label={item.actionLabel}
      title={item.actionLabel}
      onClick={(e) => {
        e.stopPropagation();
        actions?.openCount?.(id, 'question', e.currentTarget);
      }}
      className={cn('nodrag nopan inline-flex min-h-[24px] shrink-0 items-center whitespace-nowrap rounded px-1 text-[12px] leading-4 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring cursor-pointer', className)}
    >
      {item.label}
    </button>
  );
}

/** Whether an Area is done, under way ("Now") or neither, as a mark that stays quiet: neither is the usual and says nothing. */
function AreaMark({ data }: { data: AreaData }) {
  if (data.done) return <span className="inline-flex items-center"><CircleCheck aria-hidden="true" className="size-4 shrink-0 text-state-done" /><span className="sr-only">Done</span></span>;
  if (data.nowSet) return <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center"><span className="board-now-dot size-2 rounded-full bg-state-now" /></span>;
  if (data.kind === 'questions') return <CircleHelp aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />;
  if (data.kind === 'files') return <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />;
  return <Circle aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/50" />;
}

/** An area at Level 0 as one line, where the cards would not be readable: its state, its title, how far it is, and a thin bar. A press steps into it, as on the card. */
export function BoardAreaRow({ id, data, width }: NodeProps<AreaRowNode>) {
  const actions = useContext(BoardActionsContext);
  const progress = data.stepsTotal ? (data.stepsDone / data.stepsTotal) * 100 : 0;
  const isNotStarted = !isStepless(data.kind) && data.stepsTotal > 0 && data.stepsDone === 0;
  const listArea = data.kind === 'files' || data.kind === 'questions';
  const fileCounts = data.kind === 'files' ? formatWorkspaceFileCounts(data, { compact: true }).join(' · ') : data.kind === 'questions' ? areaCounts(data).join(' · ') : '';
  const fileFullCounts = listArea ? areaCounts(data).join(' · ') : '';
  const rowWidth = width ?? AREA_ROW.minWidth;
  const rowLayout = areaRowSecondaryRoom(data, rowWidth, { fileCounts });

  // Disposable news buttons stand in at most 45% of the row and never squeeze the title or "1 question" (rendered separately via QuestionCount)
  const rawNewsItems = data.newsItems ?? [];
  const disposableNews = rawNewsItems.filter((item) => item.kind !== 'question');
  const newsBudget = Math.max(0, Math.min(rowWidth * 0.45 * 0.92, rowLayout.room));
  let newsShown: typeof rawNewsItems = [];
  if (rowLayout.showSecondary && disposableNews.length > 0) {
    const hasQuestionNews = rawNewsItems.some((item) => item.kind === 'question');
    const questionNewsReserve = hasQuestionNews && data.questionItem ? newsLabelWidth(data.questionItem.label) + 10 : 0;
    newsShown = hasQuestionNews
      ? fitNewsItems(rawNewsItems, newsBudget + questionNewsReserve, newsLabelWidth).filter((item) => item.kind !== 'question')
      : [...disposableNews];
    while (newsShown.length > 0) {
      const used = newsShown.reduce((sum, item, idx) => sum + newsLabelWidth(item.label) + (idx > 0 ? 8 : 0), 0);
      if (used <= newsBudget) break;
      newsShown = newsShown.slice(0, -1);
    }
  }

  const waitingTextValue = data.waitingQuestion ?? (data.waitingCount > 0 ? waitingText(data.waitingCount) : undefined);
  const hiddenSubtitle =
    !rowLayout.showSecondary && data.tier === 2 ? waitingTextValue
      : !rowLayout.showSecondary && data.tier === 4 ? data.nextOpenStep
        : undefined;

  return (
    <div
      className={cn(
        '@container relative flex h-full w-full items-center gap-2.5 overflow-hidden rounded-lg bg-card px-3 text-left text-card-foreground transition-colors hover:bg-accent',
        isNotStarted && 'opacity-85'
      )}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        actions?.openArea?.(id, event.currentTarget);
      }}
    >
      <Anchors />
      {data.fresh && <span key={data.freshKey ?? data.title} aria-hidden="true" className="board-fresh rounded-lg" />}
      <button
        type="button"
        onClick={(event) => actions?.openArea?.(id, event.currentTarget)}
        aria-label={areaLabel(data, hiddenSubtitle)}
        className={cn(
          'board-area nodrag nopan flex items-center gap-2.5 text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-ring rounded',
          listArea
            ? (rowLayout.showSecondary ? 'shrink-0' : 'min-w-0 shrink')
            : (rowLayout.showSecondary ? 'grow shrink-0' : 'min-w-0 flex-auto'),
        )}
      >
        <AreaMark data={data} />
        <span className={cn('text-sm font-medium leading-5 text-foreground', listArea ? 'min-w-0 truncate whitespace-nowrap' : 'min-w-0 flex-auto truncate')} title={data.title}>
          {data.fresh && !data.current && !data.done && (
            <FreshDot inline />
          )}
          {data.title}
        </span>
      </button>
      {/* Tier 2: Waits for you, with the question's first words */}
      {data.tier === 2 && waitingTextValue && (
        rowLayout.showSecondary ? (
          <span className="min-w-0 max-w-[24ch] shrink-[100] truncate text-xs font-medium text-state-needs" title={waitingTextValue}>
            <span aria-hidden="true" className="mr-1 inline-block size-1.5 rounded-full bg-state-needs" />
            {waitingTextValue}
          </span>
        ) : (
          <span className="sr-only">{waitingTextValue}</span>
        )
      )}
      {/* Tier 3: Moved since you looked, saying what ("2 commits, 1 picture") */}
      {data.tier === 3 && newsShown.length > 0 ? (
        <span className="flex min-w-0 max-w-[45%] shrink-[100] items-center gap-1 overflow-hidden text-xs" title={data.newsSummary}>
          {newsShown.map((item, idx) => (
            <Fragment key={item.kind}>
              {idx > 0 && <span aria-hidden="true" className="-ml-1 shrink-0 select-none text-muted-foreground/60">,</span>}
              <button
                type="button"
                aria-label={item.actionLabel}
                title={item.actionLabel}
                onClick={(e) => {
                  e.stopPropagation();
                  actions?.openCount?.(id, item.kind, e.currentTarget);
                }}
                data-count-kind={item.kind}
                className={cn('nodrag nopan inline-flex min-h-[24px] items-center rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring cursor-pointer', newsButtonFit(data, item.kind))}
              >
                <span className="truncate">{item.label}</span>
              </button>
            </Fragment>
          ))}
        </span>
      ) : data.tier === 3 && rawNewsItems.length === 0 && data.newsSummary && rowLayout.showSecondary ? (
        <span className="min-w-0 max-w-[45%] shrink-[100] truncate text-xs text-muted-foreground" title={data.newsSummary}>
          {data.newsSummary}
        </span>
      ) : null}
      {/* Tier 4: its next open step in place of a bare count, and 0 of 4 quietly at the end */}
      {data.tier === 4 && data.nextOpenStep && rowLayout.showSecondary && (
        <span className="min-w-0 max-w-[28ch] shrink-[100] truncate text-xs text-muted-foreground" title={data.nextOpenStep}>
          {data.nextOpenStep}
        </span>
      )}
      {!data.done && data.current && !isStepless(data.kind) && <span className={cn('shrink-0 whitespace-nowrap text-xs font-medium', data.nowSet ? 'text-state-now' : 'text-muted-foreground')}>{areaFocusWord(data)}</span>}
      {data.waitingCount > 0 && (data.tier !== 2 || !rowLayout.showSecondary) && (
        <span aria-hidden="true" title={waitingText(data.waitingCount)} className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium text-state-needs">
          <span className="size-1.5 shrink-0 rounded-full bg-state-needs" />Waiting
        </span>
      )}
      <QuestionCount id={id} data={data} />
      {fileCounts && data.tier !== 2 && data.tier !== 3 && rowLayout.showSecondary && (
        <span className="min-w-0 flex-1 shrink-[100] truncate text-right text-xs leading-4 text-muted-foreground" title={fileFullCounts || fileCounts}>
          {data.kind === 'questions' ? <AnswerCountLine data={data} /> : fileCounts}
        </span>
      )}
      {!isStepless(data.kind) && data.stepsTotal > 0 && (
        <>
          <span className={cn('shrink-0 whitespace-nowrap text-xs tabular-nums', isNotStarted ? 'text-muted-foreground/70' : 'text-muted-foreground')}>
            {data.stepsDone} of {data.stepsTotal}
          </span>
          <span
            aria-hidden="true"
            className={cn(
              'h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted-foreground/20',
              (data.waitingCount > 0 || Boolean(data.nextOpenStep) || (data.tier === 3 && Boolean(data.newsSummary)) || (data.tier === 2 && Boolean(data.waitingQuestion)) || (!data.done && data.current)) && 'hidden @[28rem]:block'
            )}
          >
            <span className={cn('block h-full rounded-full', data.done ? 'bg-success' : 'bg-primary')} style={{ width: `${progress}%` }} />
          </span>
        </>
      )}
    </div>
  );
}

/**
 * An area at Level 0 as a small card, where the full cards would not be readable but a grid of them fits: its state, its title,
 * how far it is, and a picture when there is room. The whole card is the button, and a press steps into it, as on the card.
 */
export function BoardAreaMini({ id, data, width, height }: NodeProps<AreaMiniNode>) {
  const actions = useContext(BoardActionsContext);
  const cardRef = useRef<HTMLDivElement>(null);
  const placeholderRef = useRef<HTMLSpanElement>(null);
  const [failedPics, setFailedPics] = useState<string[]>([]);
  const picture = data.pictures.find((pic) => !failedPics.includes(pic.path));
  const hasStatus = (data.current && !isStepless(data.kind)) ||
    data.waitingCount > 0 ||
    Boolean(data.tier === 2 && (data.waitingQuestion || data.waitingCount > 0)) ||
    Boolean(data.tier === 3 && (data.newsItems?.length || data.newsSummary));
  const showPicture = Boolean(picture && actions && miniShowsPicture(width ?? 0, height ?? 0, hasStatus));
  const statusLine = (height ?? 0) >= MINI_STATUS_LINE;
  const hasSteps = !isStepless(data.kind) && data.stepsTotal > 0;
  const progress = data.stepsTotal ? (data.stepsDone / data.stepsTotal) * 100 : 0;
  const isNotStarted = !isStepless(data.kind) && data.stepsTotal > 0 && data.stepsDone === 0;

  const hasCountButtons = Boolean(data.tier === 3 && data.newsItems && data.newsItems.length > 0 && actions);
  const newsRoom = Math.max(0, ((width ?? 240) - 26 - (showPicture ? 92 : 0) - (statusLine ? 24 : hasSteps ? Math.ceil(textEm(`${data.stepsDone} of ${data.stepsTotal}`) * 12) + 10 : 0)) * 0.97);
  const newsShown = fitNewsItems(data.newsItems ?? [], newsRoom, newsLabelWidth);
  // "1 question" stands at the end of the card's last line, as a button of its own over room the line keeps free for it; where the card
  // has its buttons for what is new it stands among them
  const showQuestion = Boolean(data.questionItem && actions && !hasCountButtons);
  const questionRoom = data.questionItem ? Math.ceil(textEm(data.questionItem.label) * 12) + 16 : 0;

  // The second line draws its subtitle with room for about 12 characters or not at all, and its bar only where it is 32 px or more
  const subtitleText = !statusLine && data.tier === 2 ? data.waitingQuestion : data.tier === 4 ? data.nextOpenStep : undefined;
  const otherPx = statusLine ? 0
    : (data.tier === 3 ? Math.min(120, newsShown.length > 0 ? newsShown.reduce((sum, item) => sum + newsLabelWidth(item.label) + 4, 0) : Math.ceil(textEm(data.newsSummary ?? '') * 12)) : 0)
      + (!data.done && data.tier !== 2 && data.tier !== 3 && data.current && data.kind !== 'work' ? Math.ceil(textEm(areaFocusWord(data)) * 12) + 8 : 0)
      + (data.tier !== 2 && data.waitingCount > 0 ? 72 : 0);
  const secondLine = miniSecondLine({
    room: (width ?? 240) - 24 - (showPicture ? 92 : 0) - (showQuestion ? questionRoom : 0) - (data.tier === 2 && subtitleText ? 10 : 0),
    stepsPx: Math.ceil(textEm(`${data.stepsDone} of ${data.stepsTotal}`) * 12) + 4,
    subtitle: subtitleText,
    hasSteps,
    other: otherPx,
  });
  const isTwoLineTitle = (data.title?.length ?? 0) > 25;
  const [overlayPos, setOverlayPos] = useState<{ top: number; left: number; maxWidth?: number }>({
    top: statusLine ? (isTwoLineTitle ? 52 : 34) : 48,
    left: statusLine ? 36 : 12,
  });

  useLayoutEffect(() => {
    if (placeholderRef.current && cardRef.current) {
      const pRect = placeholderRef.current.getBoundingClientRect();
      const cardRect = cardRef.current.getBoundingClientRect();
      if (cardRect.width > 0 && pRect.width > 0) {
        const scale = cardRef.current.offsetWidth > 0 ? cardRect.width / cardRef.current.offsetWidth : 1;
        const next = {
          top: Math.round((pRect.top - cardRect.top) / scale),
          left: Math.round((pRect.left - cardRect.left) / scale),
          maxWidth: Number((pRect.width / scale).toFixed(2)),
        };
        setOverlayPos((prev) =>
          prev.top === next.top && prev.left === next.left && prev.maxWidth === next.maxWidth ? prev : next,
        );
      }
    }
  }, [
    data.title,
    data.newsSummary,
    data.newsItems,
    data.stepsDone,
    data.stepsTotal,
    data.waitingCount,
    data.nowSet,
    data.focusSource,
    data.done,
    hasStatus,
    showPicture,
    hasCountButtons,
    width,
    height,
    statusLine,
  ]);

  if (data.kind === 'files' || data.kind === 'questions') {
    const pics = data.pictures.filter((pic) => !failedPics.includes(pic.path)).slice(0, 3);
    const fullCounts = areaCounts(data).join(' · ');
    const fileCounts = data.kind === 'questions' ? areaCounts(data).join(' · ') : formatWorkspaceFileCounts(data, { compact: true }).join(' · ');
    const thumbSize = (height ?? 0) >= 108 ? 'h-9 w-14' : (height ?? 0) >= 90 ? 'h-7 w-12' : 'h-6 w-10';
    // A question may run to two lines; the first line of its answer is then shown only where there is room for both
    const isQuestion = data.kind === 'questions';
    const twoLineTitle = isQuestion && textEm(data.title) * 14 * 1.08 > Math.max(60, (width ?? 240) - 24 - 24 - 12);
    // What moved ("Answer updated") takes the place of the first line of the answer
    const showNews = isQuestion && Boolean(data.newsSummary);
    const showPreview = !showNews && pics.length === 0 && Boolean(data.preview) && (!twoLineTitle || (height ?? 0) >= 100);
    return (
      <div
        ref={cardRef}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button')) return;
          actions?.openArea?.(id, event.currentTarget);
        }}
        className={cn(
          'nodrag nopan relative flex h-full w-full flex-col justify-between overflow-hidden rounded-xl border border-border/60 bg-card px-3 text-left text-card-foreground shadow-xs cursor-pointer',
          (height ?? 0) < 96 ? 'gap-0.5 py-1.5' : 'gap-1 py-2',
          'transition-[transform,box-shadow,border-color] duration-150 ease-out hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md',
          'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        )}
      >
        <Anchors />
        {data.fresh && <span key={data.freshKey ?? data.title} aria-hidden="true" className="board-fresh rounded-xl" />}
        <button
          type="button"
          onClick={(event) => actions?.openArea?.(id, event.currentTarget)}
          aria-label={areaLabel(data)}
          className={cn('board-area nodrag nopan flex w-full min-w-0 gap-2 rounded text-left focus-visible:outline-2 focus-visible:outline-ring cursor-pointer', isQuestion ? 'items-start' : 'items-center')}
        >
          <span className={cn(isQuestion && 'mt-0.5')}><AreaMark data={data} /></span>
          <span className={cn('min-w-0 flex-1 text-sm font-medium leading-5 text-foreground', isQuestion ? 'line-clamp-2' : 'truncate')} title={data.title}>
            {data.title}
          </span>
        </button>
        {pics.length > 0 && actions && (
          <div className="flex shrink-0 items-center gap-1.5 overflow-hidden">
            {pics.map((pic) => (
              <button
                key={pic.path}
                type="button"
                data-path={pic.path}
                aria-label={pic.alt || pic.path}
                title={pic.alt || pic.path}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.openInReader({ path: pic.path, title: pic.alt || pic.path }, e.currentTarget);
                }}
                className={cn(
                  'nodrag nopan relative shrink-0 overflow-hidden rounded border border-border/50 cursor-pointer focus-visible:outline-2 focus-visible:outline-ring hover:opacity-85 transition-opacity',
                  thumbSize,
                )}
              >
                <img
                  src={pictureSrc(actions, pic.path)}
                  alt=""
                  aria-hidden="true"
                  loading="lazy"
                  onError={() => setFailedPics((prev) => (prev.includes(pic.path) ? prev : [...prev, pic.path]))}
                  className="h-full w-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
        {showNews && <span className="line-clamp-1 text-xs font-medium leading-4 text-foreground" title={data.newsSummary}>{data.newsSummary}</span>}
        {showPreview && (
          <span className="line-clamp-1 text-xs leading-4 text-muted-foreground">{data.preview}</span>
        )}
        {fileCounts && (
          <span className={cn('min-w-0 text-xs leading-4 text-muted-foreground', data.kind !== 'questions' && 'break-words')} title={fullCounts}>
            {data.kind === 'questions' ? <AnswerCountLine data={data} /> : fileCounts}
          </span>
        )}
      </div>
    );
  }

  const status = (
    <>
      {data.tier === 2 && (data.waitingQuestion || data.waitingCount > 0) && (statusLine || !data.waitingQuestion || secondLine.subtitle) && (
        <span aria-hidden="true" data-area-subtitle={statusLine ? undefined : ''} title={data.waitingQuestion ?? waitingText(data.waitingCount)} style={!statusLine && data.waitingQuestion ? { maxWidth: secondLine.subtitleMax + 10 } : undefined} className="flex min-w-0 max-w-[22ch] items-center gap-1 text-xs font-medium leading-4 text-state-needs">
          <span className="size-1.5 shrink-0 rounded-full bg-state-needs" />
          <span className="min-w-0 truncate">{data.waitingQuestion ?? 'Waiting'}</span>
        </span>
      )}
      {data.tier === 3 && hasCountButtons && newsShown.length > 0 ? (
        <span
          ref={placeholderRef}
          aria-hidden="true"
          title={data.newsSummary}
          className="invisible flex h-6 min-w-0 items-center gap-1 overflow-hidden text-xs leading-4"
        >
          {newsShown.map((item, idx) => (
            <Fragment key={item.kind}>
              {idx > 0 && <span className="-ml-1 shrink-0 select-none">,</span>}
              <span className={cn('inline-flex min-h-[24px] items-center px-1 text-xs', newsButtonFit(data, item.kind))}>
                <span className="truncate">{item.label}</span>
              </span>
            </Fragment>
          ))}
        </span>
      ) : data.tier === 3 && data.newsSummary ? (
        <span
          ref={placeholderRef}
          className="min-w-0 truncate text-xs leading-4 text-muted-foreground"
          title={data.newsSummary}
        >
          {data.newsSummary}
        </span>
      ) : null}
      {!data.done && data.tier !== 2 && data.tier !== 3 && data.current && data.kind !== 'work' && (
        <span className={cn('shrink-0 whitespace-nowrap text-xs font-medium leading-4', data.nowSet ? 'text-state-now' : 'text-muted-foreground')}>
          {areaFocusWord(data)}
        </span>
      )}
      {data.tier !== 2 && data.waitingCount > 0 && (
        <span aria-hidden="true" title={waitingText(data.waitingCount)} className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium leading-4 text-state-needs">
          <span className="size-1.5 shrink-0 rounded-full bg-state-needs" />Waiting
        </span>
      )}
    </>
  );

  return (
    <div ref={cardRef} className={cn('relative h-full w-full rounded-xl', isNotStarted && 'opacity-85')}>
      <Anchors />
      {data.fresh && <span key={data.freshKey ?? data.title} aria-hidden="true" className="board-fresh rounded-xl" />}
      <button
        type="button"
        onClick={(event) => actions?.openArea?.(id, event.currentTarget)}
        aria-label={areaLabel(data, !secondLine.subtitle ? subtitleText : undefined)}
        title={!secondLine.subtitle && subtitleText ? `${data.title}: ${subtitleText}` : undefined}
        className={cn(
          'board-area nodrag nopan relative flex h-full w-full items-stretch gap-3 overflow-hidden rounded-xl border bg-card px-3 py-2.5 text-left text-card-foreground shadow-xs',
          'transition-[transform,box-shadow,border-color] duration-150 ease-out hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md',
          'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
          data.current ? 'border-primary/40' : 'border-border/60',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col justify-between gap-1">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-start gap-2">
              <span className="mt-0.5"><AreaMark data={data} /></span>
              <span className="line-clamp-2 min-w-0 text-sm font-medium leading-5 text-foreground" title={data.title}>
                {data.fresh && !data.current && !data.done && (
                  <FreshDot inline />
                )}
                {data.title}
              </span>
            </span>
            {statusLine && hasStatus && <span className="flex min-w-0 items-center gap-2 pl-6">{status}</span>}
          </span>
          {(hasSteps || (!statusLine && hasStatus) || showQuestion) && (
            <span className="flex min-w-0 items-center gap-2" style={showQuestion ? { paddingRight: questionRoom } : undefined}>
              {!statusLine && status}
              {data.tier === 4 && data.nextOpenStep && secondLine.subtitle && (
                <span data-area-subtitle="" style={{ maxWidth: secondLine.subtitleMax }} className="min-w-0 max-w-[22ch] truncate text-xs leading-4 text-muted-foreground" title={data.nextOpenStep}>
                  {data.nextOpenStep}
                </span>
              )}
              {hasSteps && (
                <>
                  <span className={cn('shrink-0 whitespace-nowrap text-xs leading-4 tabular-nums', isNotStarted ? 'text-muted-foreground/70' : 'text-muted-foreground')}>{data.stepsDone} of {data.stepsTotal}</span>
                  {secondLine.bar && (
                    <span aria-hidden="true" data-area-progress="" className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-muted-foreground/20">
                      <span className={cn('block h-full rounded-full', data.done ? 'bg-success' : 'bg-primary')} style={{ width: `${progress}%` }} />
                    </span>
                  )}
                </>
              )}
            </span>
          )}
        </span>
        {showPicture && picture && actions && (
          <img
            src={pictureSrc(actions, picture.path)}
            alt=""
            aria-hidden="true"
            loading="lazy"
            onError={() => setFailedPics((prev) => (prev.includes(picture.path) ? prev : [...prev, picture.path]))}
            className="w-20 shrink-0 self-stretch rounded-lg border border-border/50 object-cover dark:brightness-90"
          />
        )}
      </button>

      {/* Sibling count buttons for Tier 3, positioned over the status line */}
      {hasCountButtons && newsShown.length > 0 && (
        <span
          className="nodrag nopan absolute z-10 flex items-center gap-1 overflow-hidden text-xs leading-4"
          style={{
            top: `${overlayPos.top}px`,
            left: `${overlayPos.left}px`,
            ...(overlayPos.maxWidth !== undefined ? { maxWidth: `${overlayPos.maxWidth}px` } : {}),
          }}
        >
          {newsShown.map((item, idx) => (
            <Fragment key={item.kind}>
              {idx > 0 && <span aria-hidden="true" className="-ml-1 shrink-0 select-none text-muted-foreground/60">,</span>}
              <button
                type="button"
                aria-label={item.actionLabel}
                title={item.actionLabel}
                onClick={(e) => {
                  e.stopPropagation();
                  actions?.openCount?.(id, item.kind, e.currentTarget);
                }}
                data-count-kind={item.kind}
                className={cn('nodrag nopan inline-flex min-h-[24px] items-center rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring cursor-pointer', newsButtonFit(data, item.kind))}
              >
                <span className="truncate">{item.label}</span>
              </button>
            </Fragment>
          ))}
        </span>
      )}

      {showQuestion && data.questionItem && (
        <button
          type="button"
          data-count-kind="question"
          aria-label={data.questionItem.actionLabel}
          title={data.questionItem.actionLabel}
          onClick={(e) => {
            e.stopPropagation();
            actions?.openCount?.(id, 'question', e.currentTarget);
          }}
          style={{ right: showPicture ? 105 : 13 }}
          className="nodrag nopan absolute bottom-[7px] z-10 inline-flex min-h-[24px] items-center whitespace-nowrap rounded px-1 text-[12px] leading-4 text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring cursor-pointer"
        >
          {data.questionItem.label}
        </button>
      )}

      {/* Sibling thumbnail button over picture */}
      {showPicture && picture && actions && (
        <button
          type="button"
          data-path={picture.path}
          aria-label={picture.alt || picture.path}
          title={picture.alt || picture.path}
          onClick={(e) => {
            e.stopPropagation();
            actions.openInReader({ path: picture.path, title: picture.alt || picture.path }, e.currentTarget);
          }}
          className="nodrag nopan absolute right-3 top-2.5 bottom-2.5 w-20 rounded-lg cursor-pointer focus-visible:outline-2 focus-visible:outline-ring hover:bg-black/10 dark:hover:bg-white/10 transition-colors z-10"
        />
      )}
    </div>
  );
}

/** The last row of the overview: "N done" (or "N more") holds the Areas that did not fit, and opens them on a press. */
export function BoardAreaFold({ data }: NodeProps<AreaFoldNode>) {
  return (
    <button
      type="button"
      aria-expanded={data.expanded}
      onClick={data.onToggle}
      className="board-area-fold nodrag nopan relative flex h-full w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/45 hover:text-foreground"
    >
      {data.expanded ? <ChevronUp aria-hidden="true" className="size-4 shrink-0" /> : <ChevronDown aria-hidden="true" className="size-4 shrink-0" />}
      {foldLabel(data)}
    </button>
  );
}
