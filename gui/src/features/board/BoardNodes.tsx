import { Fragment, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type MouseEvent, type ReactNode, type Ref } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Archive, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleCheck, Circle, CircleHelp, ExternalLink, File, FileCode, FileImage, FileText, Globe, GitCommitHorizontal, GitCompare, MoreHorizontal, PanelRightOpen, Pencil, Pin, Plus, ShieldCheck, Terminal, type LucideIcon } from 'lucide-react';

import { ChatMarkdown } from '../../components/ChatMarkdown.js';
import { classifyMarkdownLink } from '../../components/markdownLinks.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from '../../components/ui/dialog.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../../components/ui/menu.js';
import { InlinePlanMarkdown } from '../../components/InlinePlanMarkdown.js';
import { cn } from '../../lib/utils.js';
import { NoteDialog } from './NoteDialog.js';
import { useAnswerDecision, useChangePlanFile } from '../plan/planFile.js';
import { suggestedAnswers } from '../plan/planView.js';
import { plainText, stripHeadingColon } from '../../lib/plainText.js';
import { agoText } from '../plan/whatsNew.js';
import { BoardActionsContext, BoardReadingContext, bylineText, cardLinks, documentFileUrl, firstControl, parseCommitNodeId } from './boardActions.js';
import { ANSWER_HOLD_OFF_MS } from './answerHoldOff.js';
import { areaCountItems, areaCounts, foldLabel, MINI_STATUS_LINE, miniShowsPicture, stepsText, waitingText, type AreaData, type AreaFoldNode, type AreaMiniNode, type AreaNode, type AreaRowNode } from './boardAreas.js';
import { formatWorkspaceFileCounts } from './workspaceFilesArea.js';
import { answersThatFit, ROW_SIZE } from './boardRows.js';
import { BOARD_SIZE, imageAlt, moreText, type BoardDecision, type CardData, type CheckpointData, type CheckpointNode, type CommitNode, type DocumentNode, type FileNode, type FileType, type FoldNode, type LaneNode, type MoreNode, type RowHeadNode, type NoteNode, type PagerNode, type PlaceholderNode, type UncommittedNode, type RowHeadData } from './boardLayout.js';
import { openCodeWindow } from '../workspace-shell/openRequests.js';

const ROLE_LABEL = { requirements: 'Requirements', design: 'Design', evidence: 'Evidence', reference: 'Reference' } as const;
const STATUS_LABEL = { draft: 'Draft', approved: 'Approved', superseded: 'Superseded' } as const;
const STATUS_BADGE = { draft: 'warning', approved: 'success', superseded: 'secondary' } as const;

const SIDES = [[Position.Top, 'top'], [Position.Right, 'right'], [Position.Bottom, 'bottom'], [Position.Left, 'left']] as const;

/**
 * Where a line to this node can end: one invisible point on each side, so a line leaves and enters by the sides that
 * face each other. They are the line's anchors and nothing else: nothing can be connected by hand.
 */
function Anchors() {
  return <>{SIDES.map(([position, id]) => <Handle key={id} id={id} type="source" position={position} isConnectable={false} className="board-handle" />)}</>;
}

/** What names a folded group to those who cannot see it: what it says of itself. That it can be opened is said by its state (aria-expanded). */
const summaryLabel = (parts: Array<string | false | undefined>) => parts.filter(Boolean).join(', ');

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
  const fit = useMemo(() => answersThatFit(options, width), [options, width]);
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
      className="nodrag nopan box-border outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 flex flex-col justify-between overflow-hidden rounded-lg border border-warning/40 bg-warning/8 px-2.5 py-[7px] text-foreground shadow-2xs"
    >
      <div className="flex items-start gap-2">
        <CircleHelp aria-hidden="true" className="mt-px size-4 shrink-0 text-warning-foreground" />
        <span className="line-clamp-2 min-w-0 break-words text-[14px] font-medium leading-[18px]" title={plain}>
          <span className="sr-only">Waiting for you: </span>
          <InlinePlanMarkdown content={decision.question} />
        </span>
      </div>

      {/* The line takes 24 px of the card's height, but is 32 px tall (4 px pulled back above and below, into the card's padding), so that a focus
          ring (2 px and 1 px offset) is whole inside the clip that keeps a button the estimate let through from ever printing over the ghost button. */}
      <div className="-my-1 flex h-8 min-w-0 items-center gap-1.5">
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
          <DialogPopup className="max-w-lg" data-testid="decision-dialog" initialFocus={allAnswers ? question : input} onClick={(e) => e.stopPropagation()}>
            <DialogHeader>
              <DialogTitle className="text-sm font-semibold text-muted-foreground">Waits for you</DialogTitle>
              <DialogDescription className="sr-only">Answer this question with a suggestion or in your own words</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="space-y-3">
                <div ref={question} tabIndex={-1} className="select-text break-words text-base font-medium leading-relaxed text-foreground outline-none"><InlinePlanMarkdown content={decision.question} /></div>
                {decision.detail && <div className="board-text select-text break-words text-sm leading-6 text-muted-foreground"><ChatMarkdown content={decision.detail} /></div>}
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
            </DialogPanel>
            <DialogFooter variant="bare">
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
      await changePlan.mutateAsync({
        type: 'add',
        step,
        ...(checkpointKey ? { checkpoint: checkpointKey } : {}),
      });
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
              <button
                type="button"
                role="checkbox"
                data-testid={`checkpoint-step-checkbox-${step.key}`}
                aria-checked={step.done}
                aria-label={step.done ? `Mark "${plainText(step.text)}" not done` : `Mark "${plainText(step.text)}" done`}
                title={stepError ?? (step.done ? `Mark "${plainText(step.text)}" not done` : `Mark "${plainText(step.text)}" done`)}
                disabled={!actions?.toggleStep || isBusy || Boolean(actions?.readOnly)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isBusy) {
                    void actions?.toggleStep?.(step.key, !step.done, step.text);
                  }
                }}
                className={cn(
                  'nodrag nopan flex size-6 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                  step.done
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted-foreground/40 bg-background hover:border-primary',
                  isBusy && 'opacity-50 cursor-not-allowed',
                  !isBusy && actions?.toggleStep && 'cursor-pointer'
                )}
              >
                {step.done ? (
                  <svg className="size-3.5" fill="none" height="24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" viewBox="0 0 24 24" width="24">
                    <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
                  </svg>
                ) : null}
              </button>
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

/**
 * A press anywhere on a compact card does the card's main action, which is what its own button does (`find` names that button). It is not
 * a button itself (a button cannot hold buttons and links), so a press on one of those keeps its own action, and a press that ends the
 * selection of some text does nothing: the text of a card can be selected.
 */
function brickPress(event: MouseEvent<HTMLElement>, find: (card: HTMLElement) => HTMLElement | null) {
  const target = event.target;
  // A press inside a dialog that the card opened bubbles up through React's tree, but is not on the card
  if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
  if (target.closest('button, a, input, textarea, select, [role="button"]')) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString() && event.currentTarget.contains(selection.anchorNode) && event.currentTarget.contains(selection.focusNode)) return;
  find(event.currentTarget)?.click();
}
const BRICK = 'board-brick cursor-pointer';
/** The keyboard on a compact card shows as a ring around the whole card, not around its title. */
const CARD_FOCUS = 'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring';
/** The title of a compact card that opens, which is the card's one stop for the keyboard. The press of the whole card does what it does. */
const TITLE_BUTTON = 'nodrag nopan flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-sm text-left outline-hidden hover:underline disabled:pointer-events-none';

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
          <span className="size-1.5 shrink-0 rounded-full bg-primary" title="New since you looked" aria-hidden="true" />
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
            <span className="size-1.5 shrink-0 rounded-full bg-primary" title="New since you looked" aria-hidden="true" />
            <span className="sr-only">New since you looked. </span>
          </>
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={data.author}>{data.author}</span>
        {ago && <time dateTime={data.at} className="shrink-0 whitespace-nowrap text-muted-foreground">{ago}</time>}
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
                src={documentFileUrl(actions.workspaceId, pic.path)}
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
            <span className="size-1.5 shrink-0 rounded-full bg-primary" title="New since you looked" aria-hidden="true" />
            <span className="sr-only">New since you looked. </span>
          </>
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={data.author}>{data.author}</span>
        {ago && <time dateTime={data.at} className="shrink-0 whitespace-nowrap text-muted-foreground">{ago}</time>}
      </div>
      <span className="shrink-0 rounded bg-muted/80 px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">commit</span>
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
              src={documentFileUrl(actions.workspaceId, pic.path)}
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

const FILE_LABEL: Record<FileType, string> = { image: 'Picture', html: 'HTML page', pdf: 'PDF', markdown: 'Markdown', other: 'File' };
const FILE_ICON: Record<FileType, LucideIcon> = { image: FileImage, html: Globe, pdf: FileText, markdown: FileCode, other: File };

/**
 * Whether the text in an element is cut off by its line clamp. Measured again when `key` changes and whenever the element
 * changes size: a card that arrives while the board is hidden behind another part has no size yet, and is measured when it
 * is shown.
 */
function useCut<T extends HTMLElement>(key: string): [(element: T | null) => void, boolean] {
  // The element is state, not a ref object, so a title that becomes a button (a new element) is measured as soon as it is there
  const [element, setElement] = useState<T | null>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, key]);
  return [setElement, cut];
}

/**
 * The text of a card as Markdown, so its links work: one to the web opens in a new tab, one to a file of the workspace in
 * the reader. A press on a link is only a press: it does not move the card or the view. `cut` is whether the card shows only
 * the start of the text: the links are then not stops for the keyboard, since some may be in the part that cannot be seen, and
 * "Read all" shows them all.
 */
function CardText({ text, cut, className, ref }: { text: string; cut: boolean; className?: string; ref?: Ref<HTMLDivElement> }) {
  const actions = useContext(BoardActionsContext);
  const links = useMemo(() => actions && cardLinks(actions), [actions]);
  return <div ref={ref} className={cn('board-text break-words', className)}>
    <ChatMarkdown content={text} links={links ?? undefined} onCard cut={cut} />
  </div>;
}

/** The whole text of a card, for when the card shows only the start of it. A link in it that opens in the reader gives way to it. */
function ReadAll({ data, title }: { data: CardData; /** The title of a compact card: it is the trigger then, as a button named "Read <title>", and not a "Read all" button. */ title?: ReactNode }) {
  const actions = useContext(BoardActionsContext);
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  // Whether the dialog closes to hand the keyboard to the reader, which takes it itself.
  const [handingOver, setHandingOver] = useState(false);
  const links = useMemo(() => actions && cardLinks(actions, trigger, () => { setHandingOver(true); setOpen(false); }), [actions, trigger]);
  return <Dialog open={open} onOpenChange={(next) => { if (next) setHandingOver(false); setOpen(next); }}>
    <DialogTrigger render={title
      ? <button ref={setTrigger} type="button" data-card-main className={TITLE_BUTTON} aria-label={`Read ${data.title}`} />
      : <Button ref={setTrigger} size="xs" variant="ghost" className="nodrag nopan text-[13px]" aria-label={`Read all of ${data.title}`} />}>{title ?? 'Read all'}</DialogTrigger>
    <DialogPopup className="max-w-lg" finalFocus={() => !handingOver}>
      <DialogHeader>
        <DialogTitle className="break-words pr-8 text-base leading-snug">{data.title}</DialogTitle>
        <DialogDescription>{bylineText(data)}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="board-text break-words text-sm leading-6 text-foreground"><ChatMarkdown content={data.text} links={links ?? undefined} onCard /></div>
      </DialogPanel>
    </DialogPopup>
  </Dialog>;
}

/** The line under a card's text: who put it there and when, and whether it is pinned or put away. */
function Byline({ data, children }: { data: CardData; children?: ReactNode }) {
  const byline = bylineText(data);
  return <div className="flex h-6 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
    {data.pinned && <Pin aria-hidden="true" className="size-3 shrink-0 text-primary" />}
    {data.pinned && <span className="sr-only">Pinned. </span>}
    <span className="min-w-0 flex-1 truncate" title={byline}>{byline}</span>
    {data.archived && <Badge variant="secondary" size="sm">Archived</Badge>}
    {children}
  </div>;
}

/** The top right of a compact card: whether it is pinned or put away, and a mark for who made it ("you" or "AI"). The whole byline is the mark's tooltip, and what the card is described by. */
function CardMark({ data, markId }: { data: CardData; markId: string }) {
  const byline = bylineText(data);
  // Who made it; who changed it since is in the byline
  const ai = data.by !== 'user';
  return <div className="flex min-h-7 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
    {data.pinned && <Pin aria-hidden="true" className="size-3 shrink-0 text-primary" />}
    {data.pinned && <span className="sr-only">Pinned. </span>}
    {data.archived && <span>Archived</span>}
    {data.fresh && (
      <>
        <span className="size-1.5 shrink-0 rounded-full bg-primary" title="New since you looked" aria-hidden="true" />
        <span className="sr-only">New since you looked. </span>
      </>
    )}
    <span id={markId} title={byline} className={cn('rounded-full px-1.5 text-[12.5px] leading-4', ai ? 'bg-state-ai/12 font-medium text-state-ai' : 'text-muted-foreground')}>
      <span aria-hidden="true">{ai ? 'AI' : 'you'}</span><span className="sr-only">{byline}</span>
    </span>
  </div>;
}

/** The frame every card shares. A card that is new, or was just changed by someone else, glows for a moment; the one open in the reader has a ring. */
function CardFrame({ data, labelledBy, describedBy, reading = false, compact = false, onPress, onDoubleClick, children }: { data: CardData; labelledBy: string; describedBy?: string; reading?: boolean; compact?: boolean; onPress?: (event: MouseEvent<HTMLElement>) => void; onDoubleClick?: (event: MouseEvent<HTMLElement>) => void; children: ReactNode }) {
  return <article
    aria-labelledby={labelledBy} aria-describedby={describedBy} aria-current={reading ? 'true' : undefined} onClick={onPress} onDoubleClick={onDoubleClick}
    className={cn('group relative flex h-full w-full flex-col overflow-hidden rounded-xl border px-3.5 shadow-xs transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md hover:border-border/80', compact ? 'py-2' : 'py-2.5', compact && CARD_FOCUS, onPress && BRICK,
      data.archived ? 'border-dashed border-border bg-muted text-muted-foreground' : data.pinned ? 'border-primary/50 bg-card text-card-foreground' : 'border-border bg-card text-card-foreground', reading && 'ring-2 ring-primary')}
  >
    <Anchors />
    {data.fresh && <span key={data.updatedAt} aria-hidden="true" className="board-fresh" />}
    {children}
  </article>;
}

/** A note someone put on the board: its title, the start of its text (Markdown, with links that work), who wrote it and when. The whole text is one button away. */
export function BoardNote({ id, data }: NodeProps<NoteNode>) {
  const titleId = useId();
  const markId = useId();
  const actions = useContext(BoardActionsContext);
  const [editOpen, setEditOpen] = useState(false);
  const [titleRef, titleCut] = useCut<HTMLElement>(data.title);
  const [bodyRef, bodyCut] = useCut<HTMLDivElement>(data.text);

  const noteActionsMenu = actions && !actions.readOnly && (
    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 transition-opacity pointer-coarse:opacity-100">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 nodrag nopan text-muted-foreground hover:text-foreground"
        aria-label={`Edit ${data.title}`}
        onClick={(e) => {
          e.stopPropagation();
          setEditOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.stopPropagation();
            setEditOpen(true);
          }
        }}
      >
        <Pencil className="size-3" aria-hidden="true" />
      </Button>
      <Menu>
        <MenuTrigger
          className="size-6 nodrag nopan inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
          aria-label={`Actions for ${data.title}`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="size-3.5" aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="end" className="w-36 p-1">
          <MenuItem
            onClick={() => setEditOpen(true)}
            className="flex items-center gap-2 text-[12.5px]"
          >
            <Pencil className="size-3.5" aria-hidden="true" />
            <span>Edit note</span>
          </MenuItem>
          <MenuItem
            onClick={() => void actions.updateNote?.(id, { pinned: !data.pinned })}
            className="flex items-center gap-2 text-[12.5px]"
          >
            <Pin className="size-3.5" aria-hidden="true" />
            <span>{data.pinned ? 'Unpin note' : 'Pin note'}</span>
          </MenuItem>
          <MenuItem
            onClick={() => void actions.updateNote?.(id, { archived: !data.archived })}
            className="flex items-center gap-2 text-[12.5px]"
          >
            <Archive className="size-3.5" aria-hidden="true" />
            <span>{data.archived ? 'Restore note' : 'Archive note'}</span>
          </MenuItem>
          {actions.askInCLI && (
            <MenuItem
              onClick={() => {
                const noteSummary = data.title?.trim() || data.text?.slice(0, 60).trim() || 'note';
                actions.askInCLI?.(noteSummary);
              }}
              className="flex items-center gap-2 text-[12.5px]"
            >
              <Terminal className="size-3.5" aria-hidden="true" />
              <span>Ask in CLI</span>
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </div>
  );

  const dialog = actions && (
    <NoteDialog
      open={editOpen}
      onOpenChange={setEditOpen}
      note={{
        id,
        title: data.title,
        body: data.text,
        pinned: data.pinned,
        archived: data.archived,
        area: data.area,
        step: data.step,
      }}
      areas={actions.availableAreas}
      onSave={async (updates) => {
        const ok = await actions.updateNote?.(id, updates);
        return ok;
      }}
    />
  );

  if (data.compact) {
    const cut = titleCut || bodyCut;
    const title = <span ref={titleRef} id={titleId} className="min-w-0 line-clamp-1 break-words" title={data.title}>{data.title}</span>;
    return (
      <>
        <CardFrame
          data={data}
          labelledBy={titleId}
          describedBy={markId}
          compact
          onDoubleClick={(event) => {
            if (actions?.readOnly) return;
            event.stopPropagation();
            setEditOpen(true);
          }}
        >
          <div className="flex shrink-0 items-start gap-1.5">
            <h2 className={cn('flex min-h-7 min-w-0 flex-1 items-center text-sm font-semibold leading-5', data.archived ? 'text-muted-foreground' : 'text-foreground')}>
              {cut ? <ReadAll data={data} title={title} /> : title}
            </h2>
            <div className="flex items-center gap-1 shrink-0">
              <CardMark data={data} markId={markId} />
              {noteActionsMenu}
            </div>
          </div>
          <CardText ref={bodyRef} text={data.text} cut={bodyCut} className="board-text-compact line-clamp-2 max-h-[34px] shrink-0 overflow-hidden text-[13px] leading-[17px]" />
        </CardFrame>
        {dialog}
      </>
    );
  }

  return (
    <>
      <CardFrame
        data={data}
        labelledBy={titleId}
        onDoubleClick={(event) => {
          if (actions?.readOnly) return;
          event.stopPropagation();
          setEditOpen(true);
        }}
      >
        <div className="flex shrink-0 items-start justify-between gap-1.5">
          <h2 ref={titleRef} id={titleId} className={cn('line-clamp-2 shrink-0 break-words text-sm font-semibold leading-5 flex-1', data.archived ? 'text-muted-foreground' : 'text-foreground')} title={data.title}>
            {data.title}
          </h2>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="rounded bg-muted/80 px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">note</span>
            {noteActionsMenu}
          </div>
        </div>
        <CardText ref={bodyRef} text={data.text} cut={bodyCut} className="mt-1 line-clamp-4 shrink-0 text-[12.5px] leading-[18px]" />
        <div className="mt-auto" />
        <div className="flex items-center justify-between gap-1 pt-1.5 border-t border-border/40">
          <Byline data={data}>{(titleCut || bodyCut) && <ReadAll data={data} />}</Byline>
          {actions?.askInCLI && !actions.readOnly && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const noteSummary = data.title?.trim() || data.text?.slice(0, 60).trim() || 'note';
                actions.askInCLI?.(noteSummary);
              }}
              className="btn-ask-card nodrag nopan inline-flex h-6 min-h-[24px] shrink-0 items-center gap-1 rounded border border-border/80 px-2 text-[11.5px] font-medium text-primary hover:border-primary/50 hover:bg-primary/10 transition-colors cursor-pointer"
              title={`Ask about "${data.title || 'note'}" in CLI`}
            >
              <span>Ask in CLI</span>
              <span aria-hidden="true">↗</span>
            </button>
          )}
        </div>
      </CardFrame>
      {dialog}
    </>
  );
}

/** What stands in a file card where a picture would: the kind of file, and where it is. */
function FileKind({ type, path }: { type: FileType; path: string }) {
  const Icon = FILE_ICON[type];
  return <div className="flex size-full flex-col items-center justify-center gap-1 px-3 text-center">
    <Icon aria-hidden="true" className="size-8 text-muted-foreground" />
    <span className="text-xs font-medium">{FILE_LABEL[type]}</span>
    <code className="max-w-full truncate font-mono text-[12.5px] text-muted-foreground" title={path}>{path}</code>
  </div>;
}

/** A file someone put on the board: a picture shows itself; anything else shows its kind. Open shows it in the reader beside the board. */
export function BoardFile({ id, data }: NodeProps<FileNode>) {
  const titleId = useId();
  const markId = useId();
  const actions = useContext(BoardActionsContext);
  const reading = useContext(BoardReadingContext) === id;
  // The path of a picture that would not load, so a card that now names another file tries it.
  const [brokenPath, setBrokenPath] = useState<string | null>(null);
  const [titleRef, titleCut] = useCut<HTMLElement>(data.title);
  const [textRef, textCut] = useCut<HTMLDivElement>(data.text);
  const picture = data.fileType === 'image' && actions && brokenPath !== data.path;
  if (data.compact && (data.group === 'documents' || data.group === 'pages')) {
    const Icon = FILE_ICON[data.fileType];
    const folderLabel = data.folder || 'Workspace root';
    const openItem = (event: MouseEvent<HTMLElement>) => actions?.openInReader(
      { path: data.path, title: data.title, card: id, ...(data.text ? { text: data.text } : {}) },
      event.currentTarget,
    );
    const content = (
      <>
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span id={titleId} className="min-w-0 max-w-[52%] shrink-0 truncate text-[13.5px] font-medium leading-5 text-foreground" title={data.title}>
          {data.title}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] leading-4 text-muted-foreground" title={folderLabel}>
          {folderLabel}
        </span>
        {data.age && (
          <span id={markId} className="shrink-0 whitespace-nowrap text-[13px] leading-4 text-muted-foreground tabular-nums">
            {data.age}
          </span>
        )}
      </>
    );
    return (
      <article
        aria-labelledby={titleId}
        aria-describedby={data.age ? markId : undefined}
        aria-current={reading ? 'true' : undefined}
        onClick={actions ? (event) => brickPress(event, (card) => firstControl(card, '[data-card-main]')) : undefined}
        className={cn(
          'group relative flex h-full w-full items-center overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xs transition-colors hover:bg-accent/35 hover:border-border/80 border-border',
          CARD_FOCUS,
          actions && BRICK,
          reading && 'ring-2 ring-primary',
        )}
      >
        <Anchors />
        {actions ? (
          <button
            type="button"
            data-card-main
            aria-label={`Open ${data.title}`}
            onClick={openItem}
            className="nodrag nopan flex h-full w-full min-w-0 items-center gap-2.5 px-3 text-left outline-hidden hover:no-underline cursor-pointer"
          >
            {content}
          </button>
        ) : (
          <div className="flex h-full w-full min-w-0 items-center gap-2.5 px-3">{content}</div>
        )}
      </article>
    );
  }
  if (data.compact && data.group === 'pictures') {
    const Icon = FILE_ICON[data.fileType];
    const title = <span ref={titleRef} id={titleId} className="min-w-0 truncate" title={data.title}>{data.title}</span>;
    return (
      <article
        aria-labelledby={titleId}
        aria-describedby={data.age ? markId : undefined}
        aria-current={reading ? 'true' : undefined}
        onClick={actions ? (event) => brickPress(event, (card) => firstControl(card, '[data-card-main]')) : undefined}
        className={cn(
          'group relative flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xs transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md hover:border-border/80',
          CARD_FOCUS,
          actions && BRICK,
          reading && 'ring-2 ring-primary',
        )}
      >
        <Anchors />
        <div className="min-h-0 flex-1 w-full overflow-hidden border-b border-border/60 bg-black/40">
          {picture
            ? <img
              src={documentFileUrl(actions.workspaceId, data.path)}
              alt={imageAlt({ title: data.title, description: data.text, path: data.path })}
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => setBrokenPath(data.path)}
              className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
            />
            : <div className="flex size-full flex-col items-center justify-center gap-0.5 px-2 text-center">
              <Icon aria-hidden="true" className="size-6 text-muted-foreground" />
              <span className="text-[12.5px] font-medium leading-4">{FILE_LABEL[data.fileType]}</span>
            </div>}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-1.5 px-2.5 py-0.5">
          <h2 className="flex min-h-7 min-w-0 flex-1 items-center text-[13.5px] font-medium leading-5 text-foreground">
            {actions
              ? <button
                type="button"
                data-card-main
                className={cn(TITLE_BUTTON, 'flex min-h-7 items-center text-[13.5px] font-medium')}
                aria-label={`Open ${data.title}`}
                onClick={(event) => actions.openInReader({ path: data.path, title: data.title, card: id, ...(data.text ? { text: data.text } : {}) }, event.currentTarget)}
              >{title}</button>
              : title}
          </h2>
          {data.age && (
            <span id={markId} className="shrink-0 whitespace-nowrap text-[13px] leading-4 text-muted-foreground tabular-nums">
              {data.age}
            </span>
          )}
        </div>
      </article>
    );
  }
  if (data.compact) {
    const Icon = FILE_ICON[data.fileType];
    const title = <span ref={titleRef} id={titleId} className="min-w-0 line-clamp-1 break-words" title={data.title}>{data.title}</span>;
    const describedBy = !data.readOnly || data.age ? markId : undefined;
    return <CardFrame data={data} labelledBy={titleId} describedBy={describedBy} reading={reading} compact onPress={actions ? (event) => brickPress(event, (card) => firstControl(card, '[data-card-main]')) : undefined}>
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="h-16 w-24 shrink-0 overflow-hidden rounded-md border border-border/80 bg-black/40">
          {picture
            ? <img
              src={documentFileUrl(actions.workspaceId, data.path)} alt={imageAlt({ title: data.title, description: data.text, path: data.path })}
              loading="lazy" decoding="async" draggable={false} onError={() => setBrokenPath(data.path)} className="size-full object-cover"
            />
            : <div className="flex size-full flex-col items-center justify-center gap-0.5 px-1 text-center">
              <Icon aria-hidden="true" className="size-6 text-muted-foreground" />
              <span className="text-[12.5px] font-medium leading-4">{FILE_LABEL[data.fileType]}</span>
              <span className="sr-only">{data.path}</span>
            </div>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-start gap-1.5">
          <h2 className={cn('flex min-h-7 min-w-0 flex-1 items-center text-sm font-semibold leading-5', data.archived ? 'text-muted-foreground' : 'text-foreground')}>
            {actions
              ? <button type="button" data-card-main className={TITLE_BUTTON} aria-label={`Open ${data.title}`} onClick={(event) => actions.openInReader({ path: data.path, title: data.title, card: id, ...(data.text ? { text: data.text } : {}), ...(data.readOnly ? {} : { byline: bylineText(data) }) }, event.currentTarget)}>{title}</button>
              : title}
          </h2>
          {data.readOnly
            ? (data.age ? <span id={markId} className="shrink-0 whitespace-nowrap pt-1 text-xs leading-4 text-muted-foreground tabular-nums">{data.age}</span> : null)
            : <CardMark data={data} markId={markId} />}
          </div>
          <CardText ref={textRef} text={data.text} cut={textCut} className="board-text-compact line-clamp-2 max-h-[34px] shrink-0 overflow-hidden text-[13px] leading-[17px]" />
        </div>
      </div>
    </CardFrame>;
  }
  return <CardFrame data={data} labelledBy={titleId} reading={reading} onPress={actions ? (event) => brickPress(event, (card) => firstControl(card, 'button[aria-label^="Open "]')) : undefined}>
    <div className="flex shrink-0 items-start justify-between gap-1.5">
      <h2 ref={titleRef} id={titleId} className={cn('line-clamp-2 shrink-0 break-words text-[13px] font-semibold leading-5 flex-1', data.archived ? 'text-muted-foreground' : 'text-foreground')} title={data.title}>{data.title}</h2>
      <span className="shrink-0 rounded bg-muted/80 px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">
        {data.fileType === 'image' ? 'picture' : data.fileType}
      </span>
    </div>
    <div className="group/thumb relative mt-1.5 h-24 shrink-0 overflow-hidden rounded-md border border-border/80 bg-black/40">
      {picture
        ? <>
          <img
            src={documentFileUrl(actions.workspaceId, data.path)} alt={imageAlt({ title: data.title, description: data.text, path: data.path })}
            loading="lazy" decoding="async" draggable={false} onError={() => setBrokenPath(data.path)} className="size-full object-cover transition-transform duration-200 group-hover/thumb:scale-105 cursor-pointer"
            onClick={(event) => actions?.openInReader({ path: data.path, title: data.title, card: id, ...(data.text ? { text: data.text } : {}), byline: bylineText(data) }, event.currentTarget)}
          />
          <span className="absolute bottom-1 right-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition-opacity group-hover/thumb:opacity-100 pointer-events-none">
            Double-click to enlarge
          </span>
        </>
        : <FileKind type={data.fileType} path={data.path} />}
    </div>
    {data.text && <CardText ref={textRef} text={data.text} cut={textCut} className="mt-1 line-clamp-2 shrink-0 text-xs leading-[16px]" />}
    <div className="mt-auto" />
    <div className="flex items-center justify-between gap-1 pt-1.5 border-t border-border/40">
      <span className="truncate text-xs text-muted-foreground" title={data.readOnly ? (data.age ?? '') : (bylineText(data) || 'live visual snapshot')}>
        {data.readOnly ? (data.age ?? '') : (bylineText(data) || 'live visual snapshot')}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="xs" variant="ghost" className="nodrag nopan h-6 px-1.5 text-xs" aria-label={`Open ${data.title}`} onClick={(event) => actions?.openInReader({ path: data.path, title: data.title, card: id, ...(data.text ? { text: data.text } : {}), ...(data.readOnly ? {} : { byline: bylineText(data) }) }, event.currentTarget)} disabled={!actions}><PanelRightOpen aria-hidden="true" className="size-3" />Open</Button>
        {(titleCut || textCut) && <ReadAll data={data} />}
        {actions?.askInCLI && !actions.readOnly && !data.readOnly && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const fileSummary = data.title?.trim() || data.path?.trim() || 'file';
              actions.askInCLI?.(fileSummary);
            }}
            className="btn-ask-card nodrag nopan inline-flex h-6 min-h-[24px] items-center gap-1 rounded border border-border/80 px-2 text-[11.5px] font-medium text-primary hover:border-primary/50 hover:bg-primary/10 transition-colors cursor-pointer"
            title={`Ask about "${data.title || data.path || 'file'}" in CLI`}
          >
            <span>Ask in CLI</span>
            <span aria-hidden="true">↗</span>
          </button>
        )}
      </div>
    </div>
  </CardFrame>;
}

/** How far an Area is, as words. */
const areaSteps = (data: AreaData) => data.kind === 'plan'
  ? (data.stepsTotal ? `${data.stepsTotal} ${data.stepsTotal === 1 ? 'step' : 'steps'} outside the checkpoints` : 'Steps outside the checkpoints')
  : stepsText(data);

/** What names an Area to those who cannot see it: its title, its state, its steps, what waits, what it holds and any problem. */
function areaLabel(data: AreaData): string {
  const counts = areaCounts(data);
  return summaryLabel([
    data.title,
    data.done ? 'done' : data.nowSet ? 'now' : data.current ? 'next up' : data.kind === 'checkpoint' ? 'not done' : undefined,
    data.kind !== 'work' && data.kind !== 'files' ? areaSteps(data).toLowerCase() : undefined,
    data.waitingCount > 0 ? (data.waitingCount === 1 ? 'waits for you' : `${data.waitingCount} wait for you`) : undefined,
    counts.length > 0 ? counts.join(', ') : undefined,
    data.warning?.toLowerCase(),
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
                <Badge variant={data.nowSet ? 'default' : 'outline'} className="board-area-badge sm:h-5 sm:text-[13.5px]">{data.nowSet ? 'Now' : 'Next up'}</Badge>
              ) : null
            )}
            {data.kind === 'plan' && <Badge variant="outline" className="board-area-badge sm:h-5 sm:text-[13.5px]">Plan</Badge>}
            {waiting > 0 && <Badge variant="warning" className="board-area-badge sm:h-5 sm:text-[13.5px]">{waitingText(waiting)}</Badge>}
            <ChevronRight aria-hidden="true" className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </span>

          <span className="mt-1.5 line-clamp-2 shrink-0 text-sm font-semibold leading-5 text-foreground" title={data.title}>
            {data.fresh && !data.current && !data.done && (
              <span className="mr-1.5 inline-block size-1.5 shrink-0 rounded-full bg-primary align-middle" title="New since you looked" aria-hidden="true" />
            )}
            {data.title}
          </span>

          {data.kind !== 'work' && data.kind !== 'files' && (
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
                  src={documentFileUrl(actions.workspaceId, pic.path)}
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
                    className="nodrag nopan inline-flex min-h-[24px] items-center rounded px-1 text-[12px] leading-4 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring cursor-pointer"
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

/** Whether an Area is done, under way ("Now") or neither, as a mark that stays quiet: neither is the usual and says nothing. */
function AreaMark({ data }: { data: AreaData }) {
  if (data.done) return <span className="inline-flex items-center"><CircleCheck aria-hidden="true" className="size-4 shrink-0 text-state-done" /><span className="sr-only">Done</span></span>;
  if (data.nowSet) return <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center"><span className="board-now-dot size-2 rounded-full bg-state-now" /></span>;
  if (data.kind === 'files') return <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />;
  return <Circle aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/50" />;
}

/** An area at Level 0 as one line, where the cards would not be readable: its state, its title, how far it is, and a thin bar. A press steps into it, as on the card. */
export function BoardAreaRow({ id, data }: NodeProps<AreaRowNode>) {
  const actions = useContext(BoardActionsContext);
  const progress = data.stepsTotal ? (data.stepsDone / data.stepsTotal) * 100 : 0;
  const isNotStarted = data.kind !== 'work' && data.kind !== 'files' && data.stepsTotal > 0 && data.stepsDone === 0;
  const fileCounts = data.kind === 'files' ? formatWorkspaceFileCounts(data, { compact: true }).join(' · ') : '';
  const fileFullCounts = data.kind === 'files' ? areaCounts(data).join(' · ') : '';

  return (
    <div
      className={cn(
        'relative flex h-full w-full items-center gap-2.5 overflow-hidden rounded-lg bg-card px-3 text-left text-card-foreground transition-colors hover:bg-accent',
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
        aria-label={areaLabel(data)}
        className={cn(
          'board-area nodrag nopan flex items-center gap-2.5 text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-ring rounded',
          data.kind === 'files' ? 'shrink-0' : 'min-w-0 flex-1',
        )}
      >
        <AreaMark data={data} />
        <span className={cn('text-sm font-medium leading-5 text-foreground', data.kind === 'files' ? 'whitespace-nowrap' : 'min-w-0 flex-1 truncate')} title={data.title}>
          {data.fresh && !data.current && !data.done && (
            <span className="mr-1.5 inline-block size-1.5 shrink-0 rounded-full bg-primary align-middle" title="New since you looked" aria-hidden="true" />
          )}
          {data.title}
        </span>
      </button>
      {/* Tier 2: Waits for you, with the question's first words */}
      {data.tier === 2 && (data.waitingQuestion || data.waitingCount > 0) && (
        <span className="min-w-0 max-w-[24ch] truncate text-xs font-medium text-state-needs" title={data.waitingQuestion ?? waitingText(data.waitingCount)}>
          <span aria-hidden="true" className="mr-1 inline-block size-1.5 rounded-full bg-state-needs" />
          {data.waitingQuestion ?? waitingText(data.waitingCount)}
        </span>
      )}
      {/* Tier 3: Moved since you looked, saying what ("2 commits, 1 picture") */}
      {data.tier === 3 && data.newsItems && data.newsItems.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1 text-xs" title={data.newsSummary}>
          {data.newsItems.map((item, idx) => (
            <Fragment key={item.kind}>
              {idx > 0 && <span aria-hidden="true" className="-ml-1 select-none text-muted-foreground/60">,</span>}
              <button
                type="button"
                aria-label={item.actionLabel}
                title={item.actionLabel}
                onClick={(e) => {
                  e.stopPropagation();
                  actions?.openCount?.(id, item.kind, e.currentTarget);
                }}
                className="nodrag nopan inline-flex min-h-[24px] items-center rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring cursor-pointer"
              >
                {item.label}
              </button>
            </Fragment>
          ))}
        </span>
      ) : data.tier === 3 && data.newsSummary ? (
        <span className="shrink-0 text-xs text-muted-foreground" title={data.newsSummary}>
          {data.newsSummary}
        </span>
      ) : null}
      {/* Tier 4: its next open step in place of a bare count, and 0 of 4 quietly at the end */}
      {data.tier === 4 && data.nextOpenStep && (
        <span className="min-w-0 max-w-[28ch] truncate text-xs text-muted-foreground" title={data.nextOpenStep}>
          {data.nextOpenStep}
        </span>
      )}
      {!data.done && data.current && data.kind !== 'work' && data.kind !== 'files' && <span className={cn('shrink-0 text-xs font-medium', data.nowSet ? 'text-state-now' : 'text-muted-foreground')}>{data.nowSet ? 'Now' : 'Next up'}</span>}
      {data.waitingCount > 0 && data.tier !== 2 && (
        <span aria-hidden="true" title={waitingText(data.waitingCount)} className="flex shrink-0 items-center gap-1 text-xs font-medium text-state-needs">
          <span className="size-1.5 rounded-full bg-state-needs" />Waiting
        </span>
      )}
      {fileCounts && data.tier !== 2 && data.tier !== 3 && (
        <span className="min-w-0 flex-1 text-right text-xs leading-4 text-muted-foreground break-words" title={fileFullCounts || fileCounts}>
          {fileCounts}
        </span>
      )}
      {data.kind !== 'work' && data.kind !== 'files' && data.stepsTotal > 0 && (
        <>
          <span className={cn('shrink-0 text-xs tabular-nums', isNotStarted ? 'text-muted-foreground/70' : 'text-muted-foreground')}>
            {data.stepsDone} of {data.stepsTotal}
          </span>
          <span aria-hidden="true" className={cn('h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted-foreground/20', (data.waitingCount > 0 || Boolean(data.nextOpenStep)) && 'hidden @[28rem]:block')}>
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
  const hasStatus = (data.current && data.kind !== 'work' && data.kind !== 'files') ||
    data.waitingCount > 0 ||
    Boolean(data.tier === 2 && (data.waitingQuestion || data.waitingCount > 0)) ||
    Boolean(data.tier === 3 && (data.newsItems?.length || data.newsSummary));
  const showPicture = Boolean(picture && actions && miniShowsPicture(width ?? 0, height ?? 0, hasStatus));
  const statusLine = (height ?? 0) >= MINI_STATUS_LINE;
  const hasSteps = data.kind !== 'work' && data.kind !== 'files' && data.stepsTotal > 0;
  const progress = data.stepsTotal ? (data.stepsDone / data.stepsTotal) * 100 : 0;
  const isNotStarted = data.kind !== 'work' && data.kind !== 'files' && data.stepsTotal > 0 && data.stepsDone === 0;

  const hasCountButtons = Boolean(data.tier === 3 && data.newsItems && data.newsItems.length > 0 && actions);

  const isTwoLineTitle = (data.title?.length ?? 0) > 25;
  const [overlayPos, setOverlayPos] = useState<{ top: number; left: number }>({
    top: statusLine ? (isTwoLineTitle ? 52 : 34) : 48,
    left: statusLine ? 36 : 12,
  });

  useLayoutEffect(() => {
    if (placeholderRef.current && cardRef.current) {
      const pRect = placeholderRef.current.getBoundingClientRect();
      const cardRect = cardRef.current.getBoundingClientRect();
      if (cardRect.width > 0 && pRect.width > 0) {
        setOverlayPos({
          top: Math.round(pRect.top - cardRect.top),
          left: Math.round(pRect.left - cardRect.left),
        });
      }
    }
  }, [data.title, data.newsSummary, width, height, statusLine]);

  if (data.kind === 'files') {
    const pics = data.pictures.filter((pic) => !failedPics.includes(pic.path)).slice(0, 3);
    const fullCounts = areaCounts(data).join(' · ');
    const fileCounts = formatWorkspaceFileCounts(data, { compact: true }).join(' · ');
    const thumbSize = (height ?? 0) >= 108 ? 'h-9 w-14' : (height ?? 0) >= 90 ? 'h-7 w-12' : 'h-6 w-10';
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
          className="board-area nodrag nopan flex w-full min-w-0 items-center gap-2 rounded text-left focus-visible:outline-2 focus-visible:outline-ring cursor-pointer"
        >
          <AreaMark data={data} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5 text-foreground" title={data.title}>
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
                  src={documentFileUrl(actions.workspaceId, pic.path)}
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
        {pics.length === 0 && data.preview && (
          <span className="line-clamp-1 text-xs leading-4 text-muted-foreground">{data.preview}</span>
        )}
        {fileCounts && (
          <span className="min-w-0 text-xs leading-4 text-muted-foreground break-words" title={fullCounts}>
            {fileCounts}
          </span>
        )}
      </div>
    );
  }

  const status = (
    <>
      {data.tier === 2 && (data.waitingQuestion || data.waitingCount > 0) && (
        <span aria-hidden="true" title={data.waitingQuestion ?? waitingText(data.waitingCount)} className="flex max-w-[22ch] shrink-0 items-center gap-1 truncate text-xs font-medium leading-4 text-state-needs">
          <span className="size-1.5 rounded-full bg-state-needs" />{data.waitingQuestion ?? 'Waiting'}
        </span>
      )}
      {data.tier === 3 && data.newsSummary && (
        <span
          ref={placeholderRef}
          className={cn(
            'flex shrink-0 items-center truncate text-xs leading-4 text-muted-foreground',
            hasCountButtons ? 'h-6 invisible' : ''
          )}
          title={data.newsSummary}
        >
          {data.newsSummary}
        </span>
      )}
      {!data.done && data.tier !== 2 && data.tier !== 3 && data.current && data.kind !== 'work' && (
        <span className={cn('shrink-0 text-xs font-medium leading-4', data.nowSet ? 'text-state-now' : 'text-muted-foreground')}>
          {data.nowSet ? 'Now' : 'Next up'}
        </span>
      )}
      {data.tier !== 2 && data.waitingCount > 0 && (
        <span aria-hidden="true" title={waitingText(data.waitingCount)} className="flex shrink-0 items-center gap-1 text-xs font-medium leading-4 text-state-needs">
          <span className="size-1.5 rounded-full bg-state-needs" />Waiting
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
        aria-label={areaLabel(data)}
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
                  <span className="mr-1.5 inline-block size-1.5 shrink-0 rounded-full bg-primary align-middle" title="New since you looked" aria-hidden="true" />
                )}
                {data.title}
              </span>
            </span>
            {statusLine && hasStatus && <span className="flex items-center gap-2 pl-6">{status}</span>}
          </span>
          {(hasSteps || (!statusLine && hasStatus)) && (
            <span className="flex min-w-0 items-center gap-2">
              {!statusLine && status}
              {data.tier === 4 && data.nextOpenStep && (
                <span className="min-w-0 max-w-[22ch] truncate text-xs leading-4 text-muted-foreground" title={data.nextOpenStep}>
                  {data.nextOpenStep}
                </span>
              )}
              {hasSteps && (
                <>
                  <span className={cn('shrink-0 text-xs leading-4 tabular-nums', isNotStarted ? 'text-muted-foreground/70' : 'text-muted-foreground')}>{data.stepsDone} of {data.stepsTotal}</span>
                  <span aria-hidden="true" className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted-foreground/20">
                    <span className={cn('block h-full rounded-full', data.done ? 'bg-success' : 'bg-primary')} style={{ width: `${progress}%` }} />
                  </span>
                </>
              )}
            </span>
          )}
        </span>
        {showPicture && picture && actions && (
          <img
            src={documentFileUrl(actions.workspaceId, picture.path)}
            alt=""
            aria-hidden="true"
            loading="lazy"
            onError={() => setFailedPics((prev) => (prev.includes(picture.path) ? prev : [...prev, picture.path]))}
            className="w-20 shrink-0 self-stretch rounded-lg border border-border/50 object-cover dark:brightness-90"
          />
        )}
      </button>

      {/* Sibling count buttons for Tier 3, positioned over the status line */}
      {hasCountButtons && data.newsItems && (
        <span
          className="nodrag nopan absolute z-10 flex items-center gap-1 text-xs leading-4"
          style={{ top: `${overlayPos.top}px`, left: `${overlayPos.left}px` }}
        >
          {data.newsItems.map((item, idx) => (
            <Fragment key={item.kind}>
              {idx > 0 && <span aria-hidden="true" className="-ml-1 select-none text-muted-foreground/60">,</span>}
              <button
                type="button"
                aria-label={item.actionLabel}
                title={item.actionLabel}
                onClick={(e) => {
                  e.stopPropagation();
                  actions?.openCount?.(id, item.kind, e.currentTarget);
                }}
                className="nodrag nopan inline-flex min-h-[24px] items-center rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring cursor-pointer"
              >
                {item.label}
              </button>
            </Fragment>
          ))}
        </span>
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


// ─── Rows inside an Area ────────────────────────────────────────────────────

const STATE_LABEL = { current: 'Now', next: 'Next', open: 'Step', done: 'Done', plain: '' } as const;
/** What a step row calls itself: the plan's first step in the focus Area is "Next up", not "Next". */
const stateWord = (data: { state: keyof typeof STATE_LABEL; title: string }) => (data.state === 'next' && data.title === 'Next up' ? 'Next up' : STATE_LABEL[data.state]);

/** A dialog showing the untruncated step title, its status, and controls to toggle or close. */
function StepDetailDialog({
  stepKey,
  title,
  state,
  stepError,
  isDone,
  isBusy,
  onToggle,
  label,
  main = true,
  rowFallback = false,
  className,
  children,
}: {
  stepKey?: string;
  title: string;
  state: 'current' | 'next' | 'open' | 'done' | 'plain';
  stepError?: string;
  isDone: boolean;
  isBusy: boolean;
  onToggle?: () => void;
  /** The name of the button that opens it, when it is not "View step: …". */
  label?: string;
  /** Whether the button is the main control of a card (`data-card-main`), which a press on the card goes to. */
  main?: boolean;
  /** Marks the button as where the keyboard goes when a row has no control of its own (the Now row with no step open). */
  rowFallback?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const actions = useContext(BoardActionsContext);
  // Saying which step is worked on is for the open steps that can be worked on, not for headings or done steps
  const canSetNow = Boolean(actions?.setNow && !actions.readOnly && stepKey && !isDone && actions.nowKeys?.has(stepKey));
  const isNowStep = Boolean(stepKey && actions?.nowKey === stepKey);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            {...(main ? { 'data-card-main': true } : {})}
            {...(rowFallback ? { 'data-row-fallback': true } : {})}
            data-testid={stepKey ? `step-trigger-${stepKey}` : 'step-trigger'}
            className={cn("nodrag nopan flex min-w-0 flex-1 flex-col justify-center text-left rounded-md px-1 py-0.5 outline-hidden transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 cursor-pointer", className)}
            aria-label={label ?? `View step: ${plainText(title)}`}
            onClick={(e) => {
              e.stopPropagation();
            }}
          />
        }
      >
        {children}
      </DialogTrigger>
      <DialogPopup className="max-w-lg" data-testid="step-detail-dialog">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Badge variant={isDone ? 'success' : 'outline'}>
              {isDone ? 'Done' : 'Open'}
            </Badge>
            {state === 'current' && <Badge variant="secondary">Now</Badge>}
            <DialogTitle className="text-sm font-semibold text-muted-foreground">
              Step details
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            {isDone ? 'Completed step details' : 'Open step details'}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <div className="break-words text-base leading-relaxed text-foreground select-text font-normal">
              <InlinePlanMarkdown content={title} />
            </div>
            {stepError && (
              <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                {stepError}
              </div>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          {canSetNow && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isBusy}
              data-testid="step-dialog-now"
              onClick={() => { void actions!.setNow!(isNowStep ? null : stepKey!).then((ok) => { if (ok) setOpen(false); }); }}
            >
              {isNowStep ? 'Stop working on this' : 'Work on this now'}
            </Button>
          )}
          {onToggle && (
            <Button
              type="button"
              size="sm"
              variant={isDone ? 'outline' : 'default'}
              disabled={isBusy}
              data-testid="step-dialog-toggle"
              onClick={() => {
                onToggle();
              }}
            >
              {isDone ? 'Mark as open' : 'Mark as done'}
            </Button>
          )}
          <DialogClose render={<Button type="button" variant="ghost" size="sm" data-testid="step-dialog-close" />}>
            Close
          </DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The tabs on the header line of the row of cards tied to no step: pictures and files, and notes. One tab stop; Left and Right move and select. */
function RowTabs({ rowId, tabs }: { rowId: string; tabs: NonNullable<RowHeadData['tabs']> }) {
  const actions = useContext(BoardActionsContext);
  const list = useRef<HTMLDivElement>(null);
  const kinds = [{ key: 'media' as const, name: 'Media', count: tabs.media }, { key: 'notes' as const, name: 'Notes', count: tabs.notes }];
  const choose = (key: 'media' | 'notes', focus: boolean) => {
    actions?.setRowTab?.(rowId, key);
    if (focus) list.current?.querySelector<HTMLElement>(`[data-tab="${key}"]`)?.focus({ preventScroll: true });
  };
  return <div ref={list} role="tablist" aria-label="Kinds of cards" className="nodrag nopan flex shrink-0 items-center gap-0.5">
    {kinds.map((kind) => {
      const selected = tabs.active === kind.key;
      return <button
        key={kind.key} type="button" role="tab" data-tab={kind.key} aria-selected={selected} tabIndex={selected ? 0 : -1} disabled={!actions}
        onClick={() => choose(kind.key, false)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          e.stopPropagation();
          choose(kind.key === 'media' ? 'notes' : 'media', true);
        }}
        className={cn('nodrag nopan inline-flex h-7 min-w-7 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[13.5px] font-medium leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground')}
      >{kind.name}<span className={selected ? 'text-muted-foreground' : ''}>{kind.count}</span></button>;
    })}
  </div>;
}

/**
 * The header of a row, which stands above its things as a line of its own: its name and what it holds, as a button that opens the row
 * where it stands and closes it when it is open already; its chevron shows when the keyboard or the pointer is on it. The header of the
 * current step (or the next one) is the exception: it says all it can of the step, in up to two lines, and is there even when the step
 * has nothing on it yet.
 */
export function BoardRowHead({ data }: NodeProps<RowHeadNode>) {
  const actions = useContext(BoardActionsContext);
  const isStep = data.text !== undefined;
  const isDone = data.state === 'done';
  const isBusy = Boolean(data.stepKey && actions?.busyStepKeys?.has(data.stepKey));
  const stepError = data.stepKey ? actions?.stepErrors?.[data.stepKey] : undefined;
  const stepPlain = plainText(data.text ?? data.title);
  const label = [isStep ? `${stateWord(data)}: ${stepPlain}` : data.title, data.summary || data.caption].filter(Boolean).join(', ');
  const Chevron = data.expanded ? ChevronUp : ChevronDown;

  if (data.static) {
    const stepText = stripHeadingColon(data.text ?? data.title);
    const stepName = plainText(stepText);
    return (
      <div
        className={cn(
          'nodrag nopan relative flex h-full w-full items-center gap-2 overflow-hidden rounded-xl border border-border bg-card px-3 py-1 text-left',
          CARD_FOCUS,
          BRICK
        )}
        onClick={(e) => {
          e.stopPropagation();
          brickPress(e, (card) => firstControl(card, '[data-card-main]'));
        }}
      >
        <Anchors />
        {data.stepKey && (
          <button
            type="button"
            role="checkbox"
            data-testid={`step-checkbox-${data.stepKey}`}
            aria-checked={isDone}
            aria-label={isDone ? `Mark "${stepName}" not done` : `Mark "${stepName}" done`}
            title={stepError ?? (isDone ? `Mark "${stepName}" not done` : `Mark "${stepName}" done`)}
            disabled={!actions?.toggleStep || isBusy || Boolean(actions?.readOnly)}
            onClick={(e) => {
              e.stopPropagation();
              if (data.stepKey && !isBusy && !actions?.readOnly) {
                void actions?.toggleStep?.(data.stepKey, !isDone, data.text);
              }
            }}
            className={cn(
              'nodrag nopan flex size-6 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              isDone
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-muted-foreground/40 bg-background hover:border-primary',
              isBusy && 'opacity-50 cursor-not-allowed',
              !isBusy && actions?.toggleStep && !actions?.readOnly && 'cursor-pointer'
            )}
          >
            {isDone ? (
              <svg className="size-3.5" fill="none" height="24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" viewBox="0 0 24 24" width="24">
                <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
              </svg>
            ) : null}
          </button>
        )}
        <StepDetailDialog
          stepKey={data.stepKey}
          title={stepText}
          state={data.state}
          stepError={stepError}
          isDone={isDone}
          isBusy={isBusy}
          onToggle={
            !actions?.readOnly && data.stepKey && actions?.toggleStep
              ? () => actions?.toggleStep?.(data.stepKey!, !isDone, data.text)
              : undefined
          }
        >
          <span className="truncate text-[12.5px] leading-4 text-muted-foreground">
            {stateWord(data)}
            {stepError && <span role="alert" className="ml-1 text-[12.5px] text-destructive">{stepError}</span>}
          </span>
          <span
            className={cn(
              'line-clamp-1 text-[13px] font-medium leading-[17px]',
              isDone ? 'text-muted-foreground line-through' : 'text-foreground'
            )}
            title={stepName}
          >
            <InlinePlanMarkdown content={stepText} />
          </span>
        </StepDetailDialog>
      </div>
    );
  }

  const checkboxButton = isStep && data.stepKey ? (
    <button
      type="button"
      role="checkbox"
      data-testid={`step-checkbox-${data.stepKey}`}
      aria-checked={isDone}
      aria-label={isDone ? `Mark "${stepPlain}" not done` : `Mark "${stepPlain}" done`}
      title={stepError ?? (isDone ? `Mark "${stepPlain}" not done` : `Mark "${stepPlain}" done`)}
      disabled={!actions?.toggleStep || isBusy || Boolean(actions?.readOnly)}
      onClick={(e) => {
        e.stopPropagation();
        if (data.stepKey && !isBusy && !actions?.readOnly) {
          void actions?.toggleStep?.(data.stepKey, !isDone, data.text);
        }
      }}
      className={cn(
        'nodrag nopan flex size-6 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        isDone
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-muted-foreground/40 bg-background hover:border-primary',
        isBusy && 'opacity-50 cursor-not-allowed',
        !isBusy && actions?.toggleStep && !actions?.readOnly && 'cursor-pointer'
      )}
    >
      {isDone ? (
        <svg className="size-3.5" fill="none" height="24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" viewBox="0 0 24 24" width="24">
          <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
        </svg>
      ) : null}
    </button>
  ) : null;

  const body = isStep && data.prominent
    ? null
    : <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className={cn('truncate text-[14px] font-semibold leading-5', isDone ? 'text-muted-foreground line-through' : 'text-foreground')} title={isStep ? stepPlain : data.title}>{isStep ? <InlinePlanMarkdown content={stripHeadingColon(data.text ?? '')} /> : data.title}</span>
      {stepError ? (
        <span role="alert" className="shrink-0 whitespace-nowrap text-[12.5px] leading-5 text-destructive">{stepError}</span>
      ) : (data.summary || data.caption) && (
        <span className="shrink-0 whitespace-nowrap text-[13px] leading-5 text-muted-foreground" title={data.caption}>{data.summary}</span>
      )}
    </span>;

  // The current step: the state and the heading above it, then the step itself. A press on the first line opens or closes the row; a press on the
  // words of the step opens the whole step (as a step tile does), so a long step can be read in full by keyboard and touch, and when the
  // step has nothing on it there is no row to open: the first line is only said, and the words, named "Now: …", open the whole step.
  if (isStep && data.prominent) {
    const first = <>
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', data.state === 'current' ? 'board-now-dot bg-state-now' : 'bg-muted-foreground/60')} />
      <span className="shrink-0">{stateWord(data)}</span>
      {stepError && <span role="alert" className="min-w-0 truncate text-[12.5px] font-normal text-destructive">{stepError}</span>}
      {data.heading && !stepError && <span className="hidden min-w-0 flex-1 items-center gap-1.5 text-[12.5px] font-normal text-muted-foreground @[40rem]/now:flex"><span aria-hidden="true">·</span><span className="truncate" title={plainText(data.heading)}>{plainText(data.heading)}</span></span>}
    </>;
    return (
      <div className="@container/now relative flex h-full w-full items-center gap-2 overflow-hidden rounded-xl border border-l-4 border-primary/40 border-l-state-now bg-gradient-to-r from-state-now/10 via-primary/5 to-transparent px-3 text-left">
        <Anchors />
        {checkboxButton}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          {data.empty
            ? <div className="flex h-7 items-center gap-1.5 whitespace-nowrap px-1 text-[13px] font-semibold leading-4 text-foreground">{first}</div>
            : <button
              type="button" data-row-control={data.rowId} aria-expanded={data.expanded} aria-label={label} disabled={!actions}
              onClick={() => actions?.toggleRow?.(data.rowId)}
              className="board-row-control nodrag nopan flex h-7 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-1 text-left text-[13px] font-semibold leading-4 text-foreground hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {first}
              <Chevron aria-hidden="true" className="ml-auto size-4 shrink-0 text-muted-foreground" />
            </button>}
          <StepDetailDialog
            main={false}
            rowFallback={data.empty}
            className="min-h-7"
            label={data.empty ? label : undefined}
            stepKey={data.stepKey}
            title={stripHeadingColon(data.text ?? '')}
            state={data.state}
            stepError={stepError}
            isDone={isDone}
            isBusy={isBusy}
            onToggle={!actions?.readOnly && data.stepKey && actions?.toggleStep ? () => actions?.toggleStep?.(data.stepKey!, !isDone, data.text) : undefined}
          >
            <span className={cn('line-clamp-2 text-[14px] font-semibold leading-[18px]', isDone ? 'text-muted-foreground line-through' : 'text-foreground')} title={stepPlain}><InlinePlanMarkdown content={stripHeadingColon(data.text ?? '')} /></span>
          </StepDetailDialog>
        </div>
      </div>
    );
  }

  if (isStep) {
    return (
      <div
        className={cn(
          'relative flex h-full w-full items-center gap-2 overflow-hidden text-left',
          data.prominent
            ? 'rounded-xl border border-primary/40 bg-gradient-to-r from-state-now/10 via-primary/5 to-transparent px-3 border-l-4 border-l-state-now hover:bg-primary/5'
            : 'rounded-lg px-1'
        )}
      >
        <Anchors />
        {checkboxButton}
        <button
          type="button"
          data-row-control={data.rowId}
          aria-expanded={data.expanded}
          aria-label={label}
          disabled={!actions}
          onClick={() => actions?.toggleRow?.(data.rowId)}
          className={cn(
            'board-row-control nodrag nopan relative flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            !data.prominent && 'hover:bg-accent/30'
          )}
        >
          {body}
          <Chevron aria-hidden="true" className={cn('size-4 shrink-0 text-muted-foreground', data.prominent ? 'absolute right-0 top-1/2 -translate-y-1/2' : 'board-row-chevron')} />
        </button>
      </div>
    );
  }

  const toggle = (
    <button
      type="button" data-row-control={data.rowId} aria-expanded={data.expanded} aria-label={label} disabled={!actions}
      onClick={() => actions?.toggleRow?.(data.rowId)}
      className={cn('board-row-control nodrag nopan relative flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left',
        data.prominent ? 'rounded-xl border border-primary/40 bg-gradient-to-r from-state-now/10 via-primary/5 to-transparent px-3 hover:bg-primary/10 border-l-4 border-l-state-now' : 'rounded-lg px-1 hover:bg-accent/30')}
    >
      {body}
      <Chevron aria-hidden="true" className={cn('size-4 shrink-0 text-muted-foreground', data.prominent ? 'absolute right-3 top-1/2 -translate-y-1/2' : 'board-row-chevron')} />
    </button>
  );
  if (data.tabs) {
    return <div className="relative flex h-full w-full items-center gap-1">
      <Anchors />
      {toggle}
      <RowTabs rowId={data.rowId} tabs={data.tabs} />
    </div>;
  }
  return <div className="relative h-full w-full">
    <Anchors />
    {toggle}
  </div>;
}

/** What a folded row says when it holds nothing: not worth a word of its own beside a preview. */
const NOTHING = /^(No cards|Nothing attached|0 commits)$/;

/** A row folded to one line: what it is, what it holds, and the first of the things it holds. Pressing it opens the row. */
export function BoardFoldRow({ data }: NodeProps<FoldNode>) {
  const actions = useContext(BoardActionsContext);
  const tail = data.preview ?? data.note;
  return <div className="relative h-full w-full">
    <Anchors />
    <button
      type="button" data-row-control={data.rowId} aria-expanded="false" aria-label={summaryLabel([data.title, data.summary, data.current && 'current step', data.note, data.warning?.toLowerCase()])}
      disabled={!actions} onClick={() => actions?.toggleRow?.(data.rowId)}
      className={cn('board-row-control nodrag nopan flex h-full w-full items-center gap-3 rounded-xl border px-3 text-left hover:bg-accent/30',
        data.current ? 'border-primary/40 bg-gradient-to-r from-state-now/10 via-primary/5 to-transparent border-l-4 border-l-state-now' : 'border-border/60 bg-card/50')}
    >
      <span className="min-w-0 max-w-[45%] shrink-0 truncate text-[14px] font-semibold text-foreground" title={data.title}>{data.title}</span>
      {data.summary && !(tail && NOTHING.test(data.summary)) && <span className="shrink-0 whitespace-nowrap text-[13px] text-muted-foreground">{data.summary}</span>}
      {tail && <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground" title={tail}>{tail}</span>}
      {data.warning && <span className="min-w-0 max-w-[40%] truncate text-[13px] text-destructive-foreground" title={data.warning}>{data.warning}</span>}
      {!tail && <span className="flex-1" />}
      <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </button>
  </div>;
}

/** "+N more" at the end of the line of a row that has more than fits: a quiet button. Pressing it opens the row. */
export function BoardMoreTile({ data }: NodeProps<MoreNode>) {
  const actions = useContext(BoardActionsContext);
  return <div className="relative h-full w-full">
    <Anchors />
    <button
      type="button" data-row-control={data.rowId} aria-expanded="false" aria-label={`Show ${data.count} more for ${data.rowTitle}`} disabled={!actions}
      onClick={() => actions?.toggleRow?.(data.rowId)}
      className="board-row-control nodrag nopan flex h-full w-full items-center justify-end whitespace-nowrap rounded-lg px-2 text-[13px] font-medium text-muted-foreground hover:bg-accent/30 hover:text-foreground"
    >{data.title}</button>
  </div>;
}

/** The buttons that page through an opened row, on the line of its header: "‹ 1–4 of 12 ›". The keyboard moves to the other button when the one it is on has no page left. */
export function BoardPager({ data }: NodeProps<PagerNode>) {
  const actions = useContext(BoardActionsContext);
  const newer = useRef<HTMLButtonElement>(null);
  const older = useRef<HTMLButtonElement>(null);
  const atStart = data.page <= 0;
  const atEnd = data.page >= data.pages - 1;
  useEffect(() => {
    const active = document.activeElement;
    if (atEnd && !atStart && active === older.current) newer.current?.focus({ preventScroll: true });
    else if (atStart && !atEnd && active === newer.current) older.current?.focus({ preventScroll: true });
  }, [atStart, atEnd]);
  // A live change can take the pager away while the keyboard is on it: it goes to the header of the row, and not to the page.
  const nav = useRef<HTMLElement>(null);
  const rowId = data.rowId;
  useLayoutEffect(() => {
    const element = nav.current;
    return () => {
      if (!element || !element.contains(document.activeElement)) return;
      document.querySelector<HTMLElement>(`[data-row-control="${CSS.escape(rowId)}"]`)?.focus({ preventScroll: true });
    };
  }, [rowId]);
  return <nav ref={nav} aria-label={`Pages of ${data.title}`} className="flex h-full w-full items-center justify-end gap-0.5">
    <Anchors />
    <Button ref={newer} type="button" size="icon-xs" variant="ghost" className="board-row-control nodrag nopan" aria-label={data.what === 'questions' ? 'Earlier questions' : 'Newer cards'} title={data.what === 'questions' ? 'Earlier' : 'Newer'} disabled={!actions || atStart} onClick={() => actions?.setRowPage?.(data.rowId, data.page - 1)}><ChevronLeft aria-hidden="true" /></Button>
    <span role="status" aria-live="polite" className="whitespace-nowrap px-1 text-[13px] text-muted-foreground">{data.from}–{data.to} of {data.total}</span>
    <Button ref={older} type="button" size="icon-xs" variant="ghost" className="board-row-control nodrag nopan" aria-label={data.what === 'questions' ? 'Later questions' : 'Older cards'} title={data.what === 'questions' ? 'Later' : 'Older'} disabled={!actions || atEnd} onClick={() => actions?.setRowPage?.(data.rowId, data.page + 1)}><ChevronRight aria-hidden="true" /></Button>
  </nav>;
}
