import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type Ref } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleCheck, Circle, CircleHelp, ExternalLink, File, FileCode, FileImage, FileText, Globe, GitCommitHorizontal, PanelRightOpen, Pin, type LucideIcon } from 'lucide-react';

import { ChatMarkdown } from '../../components/ChatMarkdown.js';
import { classifyMarkdownLink } from '../../components/markdownLinks.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from '../../components/ui/dialog.js';
import { cn } from '../../lib/utils.js';
import { agoText } from '../plan/whatsNew.js';
import { BoardActionsContext, BoardReadingContext, bylineText, cardLinks, documentFileUrl, firstControl, parseCommitNodeId } from './boardActions.js';
import { stepsText, waitingText, type AreaNode } from './boardAreas.js';
import { BOARD_SIZE, imageAlt, moreText, type CardData, type CheckpointData, type CheckpointNode, type CommitNode, type DocumentNode, type FileNode, type FileType, type FoldNode, type LaneNode, type MoreNode, type RowHeadNode, type NoteNode, type PagerNode, type PlaceholderNode } from './boardLayout.js';

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

/**
 * The decisions that wait for you, inside an Area: "Waits for you" and the first decisions, and a button that opens the rest (and, when
 * they are open, closes them again). The Area's own name is in the header above, and is not said again here.
 */
function WaitingFrame({ data, border, titleId }: { data: CheckpointData; border: string; titleId: string }) {
  const actions = useContext(BoardActionsContext);
  const expanded = data.waitingExpanded === true;
  return <article tabIndex={-1} aria-labelledby={titleId} className={cn('flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs', border)}>
    <Anchors />
    <header className="flex h-8 items-center gap-1.5 px-3 pt-1">
      <span aria-hidden="true" className="size-2 rounded-full bg-state-needs" />
      <h2 id={titleId} className="text-[13px] font-semibold leading-5 text-foreground">Waits for you</h2>
    </header>
    <ul aria-label="Decisions waiting for you" className="min-h-0 flex-1">
      {data.waiting.map((decision) => <li key={decision.key} className="flex items-start gap-2 border-l-2 border-warning bg-warning/8 px-3 py-1 text-[12.5px] leading-4 text-foreground" style={{ height: BOARD_SIZE.decisionRow }}>
        <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
        <span className="line-clamp-2" title={decision.question}>{decision.question}</span>
      </li>)}
    </ul>
    {(data.moreWaiting > 0 || expanded) && <button
      type="button" data-row-control={data.rowId} aria-expanded={expanded} disabled={!actions} onClick={() => data.rowId && actions?.toggleRow?.(data.rowId)}
      aria-label={expanded ? 'Show fewer decisions waiting for you' : `Show ${data.moreWaiting} more decisions waiting for you`}
      className="board-row-control nodrag nopan flex shrink-0 items-center justify-center border-t border-border/60 px-3 text-[12.5px] font-medium text-foreground hover:bg-accent/40" style={{ height: BOARD_SIZE.moreRow + 6 }}
    >{expanded ? 'Show fewer' : `+${data.moreWaiting} more`}</button>}
  </article>;
}

/**
 * One checkpoint of PLAN.md: whether it is done, how far its steps are, what waits for the user, and the first steps.
 * Folded, it is the header alone, as one button that opens it.
 */
export function BoardCheckpoint({ id, data }: NodeProps<CheckpointNode>) {
  const titleId = useId();
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
  if (data.waitingOnly) return <WaitingFrame data={data} border={border} titleId={titleId} />;
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
    {data.waiting.length > 0 && <ul aria-label="Decisions waiting for you">
      {data.waiting.map((decision) => <li key={decision.key} className="flex items-start gap-2 border-l-2 border-warning bg-warning/8 px-3 py-1 text-[12.5px] leading-4 text-foreground" style={{ height: BOARD_SIZE.decisionRow }}>
        <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
        <span className="line-clamp-2" title={decision.question}><span className="sr-only">Waiting for you: </span>{decision.question}</span>
      </li>)}
      {data.moreWaiting > 0 && <li className="flex items-center border-l-2 border-warning bg-warning/8 px-3 text-[12.5px] text-muted-foreground" style={{ height: BOARD_SIZE.moreRow }}>+{data.moreWaiting} more waiting</li>}
    </ul>}
    {!data.waitingOnly && <ul className="px-3">
      {data.steps.map((step) => <li key={step.key} className="flex items-center gap-2 text-[12.5px]" style={{ height: BOARD_SIZE.stepRow }}>
        {step.done
          ? <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-success-foreground" />
          : <Circle aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className={cn('min-w-0 flex-1 truncate', step.done ? 'text-muted-foreground line-through' : 'text-foreground')} title={step.text}>
          <span className="sr-only">{step.done ? 'Done: ' : 'Not done: '}</span>{step.text}
        </span>
      </li>)}
      {data.steps.length === 0 && <li className="flex items-center text-[12.5px] text-muted-foreground" style={{ height: BOARD_SIZE.stepRow }}>No steps yet</li>}
      {data.moreSteps > 0 && <li className="flex items-center text-[12.5px] text-muted-foreground" style={{ height: BOARD_SIZE.moreRow }}>+{data.moreSteps} more</li>}
    </ul>}
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
  const title = <span id={titleId} className={cn('min-w-0 flex-1 truncate text-sm font-semibold', data.dimmed ? 'text-muted-foreground' : 'text-foreground')} title={data.title}>{data.title}</span>;
  if (data.compact) {
    const opens = Boolean(actions && data.filename) || Boolean(href);
    return <article
      tabIndex={-1} aria-labelledby={titleId} aria-current={reading ? 'true' : undefined}
      onClick={opens ? (event) => brickPress(event, (card) => firstControl(card)) : undefined}
      className={cn('flex h-full w-full flex-col justify-between overflow-hidden rounded-lg border px-3 py-2 shadow-xs', CARD_FOCUS, opens && BRICK,
        data.dimmed ? 'border-dashed border-border bg-muted text-muted-foreground' : 'border-border bg-card text-card-foreground', reading && 'ring-2 ring-primary')}
    >
      <Anchors />
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
    className={cn('flex h-full w-full flex-col gap-1.5 overflow-hidden rounded-lg border px-3 py-2.5 shadow-xs',
      data.dimmed ? 'border-dashed border-border bg-muted text-muted-foreground' : 'border-border bg-card text-card-foreground', reading && 'ring-2 ring-primary')}
  >
    <Anchors />
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
      className={cn('flex h-full w-full flex-col justify-center gap-1 overflow-hidden rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-xs', CARD_FOCUS, opens && BRICK, reading && 'ring-2 ring-primary')}
    >
      <Anchors />
      <div className="flex h-5 items-center gap-2 text-[13px]">
        <GitCommitHorizontal aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <code id={shaId} className="shrink-0 font-mono text-primary">{data.sha}</code>
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
    </article>;
  }
  return <article
    tabIndex={-1}
    aria-labelledby={shaId}
    aria-current={reading ? 'true' : undefined}
    className={cn('flex h-full w-full flex-col gap-1 overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5 text-card-foreground shadow-xs', reading && 'ring-2 ring-primary')}
  >
    <Anchors />
    <div className="flex h-4 items-center gap-2 text-xs">
      <GitCommitHorizontal aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <code id={shaId} className="shrink-0 font-mono text-primary">{data.sha}</code>
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
        className="nodrag nopan block w-full min-w-0 rounded-sm text-left outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
      >
        <span className="line-clamp-2 text-sm leading-[18px] text-foreground" title={data.subject}>{data.subject}</span>
      </button>
    ) : (
      <p className="line-clamp-2 text-sm leading-[18px] text-foreground" title={data.subject}>{data.subject}</p>
    )}
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
    <span id={markId} title={byline} className={cn('rounded-full px-1.5 text-[12.5px] leading-4', ai ? 'bg-state-ai/12 font-medium text-state-ai' : 'text-muted-foreground')}>
      <span aria-hidden="true">{ai ? 'AI' : 'you'}</span><span className="sr-only">{byline}</span>
    </span>
  </div>;
}

/** The frame every card shares. A card that is new, or was just changed by someone else, glows for a moment; the one open in the reader has a ring. */
function CardFrame({ data, labelledBy, describedBy, reading = false, compact = false, onPress, children }: { data: CardData; labelledBy: string; describedBy?: string; reading?: boolean; compact?: boolean; onPress?: (event: MouseEvent<HTMLElement>) => void; children: ReactNode }) {
  return <article
    aria-labelledby={labelledBy} aria-describedby={describedBy} aria-current={reading ? 'true' : undefined} onClick={onPress}
    className={cn('relative flex h-full w-full flex-col overflow-hidden rounded-lg border px-3 shadow-xs', compact ? 'py-2' : 'py-2.5', compact && CARD_FOCUS, onPress && BRICK,
      data.archived ? 'border-dashed border-border bg-muted text-muted-foreground' : data.pinned ? 'border-primary/50 bg-card text-card-foreground' : 'border-border bg-card text-card-foreground', reading && 'ring-2 ring-primary')}
  >
    <Anchors />
    {data.fresh && <span key={data.updatedAt} aria-hidden="true" className="board-fresh" />}
    {children}
  </article>;
}

/** A note someone put on the board: its title, the start of its text (Markdown, with links that work), who wrote it and when. The whole text is one button away. */
export function BoardNote({ data }: NodeProps<NoteNode>) {
  const titleId = useId();
  const markId = useId();
  const [titleRef, titleCut] = useCut<HTMLElement>(data.title);
  const [bodyRef, bodyCut] = useCut<HTMLDivElement>(data.text);
  if (data.compact) {
    const cut = titleCut || bodyCut;
    const title = <span ref={titleRef} id={titleId} className="min-w-0 line-clamp-1 break-words" title={data.title}>{data.title}</span>;
    return <CardFrame data={data} labelledBy={titleId} describedBy={markId} compact onPress={cut ? (event) => brickPress(event, (card) => firstControl(card, '[data-card-main]')) : undefined}>
      <div className="flex shrink-0 items-start gap-1.5">
        <h2 className={cn('flex min-h-7 min-w-0 flex-1 items-center text-sm font-semibold leading-5', data.archived ? 'text-muted-foreground' : 'text-foreground')}>{cut ? <ReadAll data={data} title={title} /> : title}</h2>
        <CardMark data={data} markId={markId} />
      </div>
      <CardText ref={bodyRef} text={data.text} cut={bodyCut} className="board-text-compact line-clamp-2 max-h-[34px] shrink-0 overflow-hidden text-[13px] leading-[17px]" />
    </CardFrame>;
  }
  return <CardFrame data={data} labelledBy={titleId}>
    <h2 ref={titleRef} id={titleId} className={cn('line-clamp-2 shrink-0 break-words text-sm font-semibold leading-5', data.archived ? 'text-muted-foreground' : 'text-foreground')} title={data.title}>{data.title}</h2>
    <CardText ref={bodyRef} text={data.text} cut={bodyCut} className="mt-1 line-clamp-4 shrink-0 text-xs leading-[18px]" />
    <div className="mt-auto" />
    <Byline data={data}>{(titleCut || bodyCut) && <ReadAll data={data} />}</Byline>
  </CardFrame>;
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
  if (data.compact) {
    const Icon = FILE_ICON[data.fileType];
    const title = <span ref={titleRef} id={titleId} className="min-w-0 line-clamp-1 break-words" title={data.title}>{data.title}</span>;
    return <CardFrame data={data} labelledBy={titleId} describedBy={markId} reading={reading} compact onPress={actions ? (event) => brickPress(event, (card) => firstControl(card, '[data-card-main]')) : undefined}>
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="h-16 w-24 shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted/60">
          {picture
            ? <img
              src={documentFileUrl(actions.workspaceId, data.path)} alt={imageAlt({ title: data.title, description: data.text, path: data.path })}
              loading="lazy" decoding="async" draggable={false} onError={() => setBrokenPath(data.path)} className="size-full object-contain"
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
              ? <button type="button" data-card-main className={TITLE_BUTTON} aria-label={`Open ${data.title}`} onClick={(event) => actions.openInReader({ path: data.path, title: data.title, card: id, ...(data.text ? { text: data.text } : {}), byline: bylineText(data) }, event.currentTarget)}>{title}</button>
              : title}
          </h2>
          <CardMark data={data} markId={markId} />
          </div>
          <CardText ref={textRef} text={data.text} cut={textCut} className="board-text-compact line-clamp-2 max-h-[34px] shrink-0 overflow-hidden text-[13px] leading-[17px]" />
        </div>
      </div>
    </CardFrame>;
  }
  return <CardFrame data={data} labelledBy={titleId} reading={reading}>
    <h2 ref={titleRef} id={titleId} className={cn('line-clamp-2 shrink-0 break-words text-sm font-semibold leading-5', data.archived ? 'text-muted-foreground' : 'text-foreground')} title={data.title}>{data.title}</h2>
    <div className="mt-1.5 h-24 shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted/60">
      {picture
        ? <img
          src={documentFileUrl(actions.workspaceId, data.path)} alt={imageAlt({ title: data.title, description: data.text, path: data.path })}
          loading="lazy" decoding="async" draggable={false} onError={() => setBrokenPath(data.path)} className="size-full object-contain"
        />
        : <FileKind type={data.fileType} path={data.path} />}
    </div>
    <CardText ref={textRef} text={data.text} cut={textCut} className="mt-1.5 line-clamp-3 shrink-0 text-xs leading-[18px]" />
    <div className="mt-auto" />
    <Byline data={data} />
    <div className="flex h-7 shrink-0 items-center gap-1">
      <Button size="xs" variant="outline" className="nodrag nopan" aria-label={`Open ${data.title}`} onClick={(event) => actions?.openInReader({ path: data.path, title: data.title, card: id }, event.currentTarget)} disabled={!actions}><PanelRightOpen aria-hidden="true" />Open</Button>
      {(titleCut || textCut) && <ReadAll data={data} />}
    </div>
  </CardFrame>;
}

/** An area at Level 0: an interactive overview card summarizing a checkpoint or logical area. */
export function BoardArea({ id, data }: NodeProps<AreaNode>) {
  const actions = useContext(BoardActionsContext);
  const [failedPics, setFailedPics] = useState<string[]>([]);
  const visiblePics = data.pictures.filter((pic) => !failedPics.includes(pic.path));
  const waiting = data.waitingCount;
  const border = waiting > 0 ? 'border-warning/60' : data.done ? 'border-success/50' : 'border-border';

  const statusPart = data.done
    ? 'done'
    : data.current
      ? 'current'
      : data.kind === 'checkpoint'
        ? 'not done'
        : undefined;

  const stepsLabel = data.kind === 'plan'
    ? (data.stepsTotal ? `${data.stepsTotal} ${data.stepsTotal === 1 ? 'step' : 'steps'} outside the checkpoints` : 'Steps outside the checkpoints')
    : (data.stepsTotal ? `${data.stepsDone} of ${data.stepsTotal} ${data.stepsTotal === 1 ? 'step' : 'steps'}` : 'No steps');

  const stepsPart = data.kind !== 'work' ? stepsLabel.toLowerCase() : undefined;
  const waitingPart = waiting > 0 ? (waiting === 1 ? 'waits for you' : `${waiting} wait for you`) : undefined;

  const countItems: string[] = [];
  if (data.noteCount > 0) countItems.push(`${data.noteCount} ${data.noteCount === 1 ? 'note' : 'notes'}`);
  if (data.pictureCount > 0) countItems.push(`${data.pictureCount} ${data.pictureCount === 1 ? 'picture' : 'pictures'}`);
  if (data.fileCount > data.pictureCount) {
    const otherFiles = data.fileCount - data.pictureCount;
    countItems.push(`${otherFiles} ${otherFiles === 1 ? 'file' : 'files'}`);
  }
  if (data.documentCount > 0) countItems.push(`${data.documentCount} ${data.documentCount === 1 ? 'document' : 'documents'}`);
  if (data.commitCount > 0) countItems.push(`${data.commitCount} ${data.commitCount === 1 ? 'commit' : 'commits'}`);
  const countsPart = countItems.length > 0 ? countItems.join(', ') : 'no items yet';

  const label = summaryLabel([
    data.title,
    statusPart,
    stepsPart,
    waitingPart,
    countsPart,
    data.warning?.toLowerCase(),
  ]);

  const progress = data.stepsTotal ? (data.stepsDone / data.stepsTotal) * 100 : 0;

  return (
    <div className="relative h-full w-full rounded-2xl">
      <Anchors />
      {data.fresh && <span key={data.freshKey ?? data.title} aria-hidden="true" className="board-fresh" />}
      <button
        type="button"
        onClick={(event) => actions?.openArea?.(id, event.currentTarget)}
        aria-label={label}
        className={cn(
          'board-area nodrag nopan relative flex h-full w-full flex-col overflow-hidden rounded-2xl border bg-card p-4 text-left text-card-foreground shadow-xs transition-colors hover:bg-accent/35',
          border,
        )}
      >
        <span className="flex h-5 w-full items-center gap-1.5 whitespace-nowrap text-[12.5px] text-muted-foreground">
          {data.kind === 'checkpoint' && (
            data.done ? (
              <Badge variant="success" className="board-area-badge">Done</Badge>
            ) : data.current ? (
              <Badge variant="default" className="board-area-badge">Current</Badge>
            ) : (
              <Badge variant="outline" className="board-area-badge sm:text-[12.5px]">Not done</Badge>
            )
          )}
          {data.kind === 'plan' && <Badge variant="outline" className="board-area-badge">Plan</Badge>}
          {data.kind === 'work' && <Badge variant="default" className="board-area-badge">Current</Badge>}
          {waiting > 0 && <Badge variant="warning">{waitingText(waiting)}</Badge>}
          <ChevronRight aria-hidden="true" className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </span>

        <span className="mt-1.5 line-clamp-2 block text-sm font-semibold leading-5 text-foreground" title={data.title}>
          {data.title}
        </span>

        {data.kind !== 'work' && (
          <span className="mt-1 block">
            <span className="block truncate text-[12.5px] leading-4 text-muted-foreground">{stepsLabel}</span>
            <span aria-hidden="true" className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted">
              <span
                className={cn('block h-full rounded-full', data.done ? 'bg-success' : 'bg-primary')}
                style={{ width: `${progress}%` }}
              />
            </span>
          </span>
        )}

        <span className="mt-2 flex min-h-0 flex-1 flex-col justify-center">
          {visiblePics.length > 0 && actions ? (
            <span className="flex h-16 items-center gap-2 overflow-hidden rounded-md">
              {visiblePics.map((pic) => (
                <img
                  key={pic.path}
                  src={documentFileUrl(actions.workspaceId, pic.path)}
                  alt=""
                  aria-hidden="true"
                  loading="lazy"
                  onError={() => {
                    setFailedPics((prev) => (prev.includes(pic.path) ? prev : [...prev, pic.path]));
                  }}
                  className="h-full w-20 rounded border border-border/50 object-cover"
                />
              ))}
            </span>
          ) : data.preview ? (
            <span className="line-clamp-2 block text-[12.5px] leading-4 text-muted-foreground">{data.preview}</span>
          ) : null}
        </span>

        <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border/50 pt-2 text-[12.5px] text-muted-foreground">
          {countItems.length > 0 ? (
            <span className="truncate">{countItems.join(' · ')}</span>
          ) : (
            <span>Empty</span>
          )}
          {data.warning && (
            <span className="text-destructive-foreground">{data.warning}</span>
          )}
        </span>
      </button>
    </div>
  );
}


// ─── Rows inside an Area ────────────────────────────────────────────────────

const STATE_LABEL = { current: 'Now', next: 'Next', open: 'Step', done: 'Done', plain: '' } as const;

/**
 * The header of a row, which stands above its things as a line of its own: its name and what it holds, as a button that opens the row
 * where it stands and closes it when it is open already; its chevron shows when the keyboard or the pointer is on it. The header of the
 * current step (or the next one) is the exception: it says all it can of the step, in up to two lines, and is there even when the step
 * has nothing on it yet.
 */
export function BoardRowHead({ data }: NodeProps<RowHeadNode>) {
  const actions = useContext(BoardActionsContext);
  const isStep = data.text !== undefined;
  const label = [isStep ? `${STATE_LABEL[data.state]}: ${data.text}` : data.title, data.summary || data.caption].filter(Boolean).join(', ');
  const Chevron = data.expanded ? ChevronUp : ChevronDown;
  if (data.static) {
    return <div className="flex h-full w-full flex-col justify-center overflow-hidden rounded-xl border border-border bg-card px-3 py-1 text-left">
      <Anchors />
      <span className="truncate text-[12.5px] leading-4 text-muted-foreground">{STATE_LABEL[data.state]}</span>
      <span className="line-clamp-1 text-[13px] font-medium leading-[17px] text-foreground" title={data.text}>{data.text}</span>
    </div>;
  }
  const body = data.prominent
    ? <span className="flex min-w-0 flex-1 flex-col justify-center pr-6">
      <span className="flex items-center gap-1.5 whitespace-nowrap text-[13px] font-semibold leading-4 text-foreground">
        <span aria-hidden="true" className={cn('size-2 rounded-full', data.state === 'current' ? 'board-now-dot bg-state-now' : 'bg-muted-foreground/60')} />
        {STATE_LABEL[data.state]}
        {data.empty && <span className="text-[13px] font-normal text-muted-foreground">{data.summary}</span>}
      </span>
      <span className="line-clamp-2 text-[14px] font-semibold leading-[18px] text-foreground" title={data.text}>{data.text}</span>
    </span>
    : <span className="flex min-w-0 items-baseline gap-2">
      <span className={cn('truncate text-[14px] font-semibold leading-5 text-foreground')} title={isStep ? data.text : data.title}>{isStep ? data.text : data.title}</span>
      {(data.summary || data.caption) && <span className="shrink-0 whitespace-nowrap text-[13px] leading-5 text-muted-foreground" title={data.caption}>{data.summary}</span>}
    </span>;
  return <div className="relative h-full w-full">
    <Anchors />
    <button
      type="button" data-row-control={data.rowId} aria-expanded={data.expanded} aria-label={label} disabled={!actions}
      onClick={() => actions?.toggleRow?.(data.rowId)}
      className={cn('board-row-control nodrag nopan relative flex h-full w-full items-center gap-1.5 overflow-hidden text-left',
        data.prominent ? 'rounded-xl border border-primary bg-primary/5 px-3 hover:bg-primary/10' : 'rounded-lg px-1 hover:bg-accent/30')}
    >
      {body}
      <Chevron aria-hidden="true" className={cn('size-4 shrink-0 text-muted-foreground', data.prominent ? 'absolute right-3 top-1/2 -translate-y-1/2' : 'board-row-chevron')} />
    </button>
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
        data.current ? 'border-primary bg-primary/5' : 'border-border/60 bg-card/50')}
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
      className="board-row-control nodrag nopan flex h-full w-full items-center justify-end rounded-lg px-2 text-[13px] font-medium text-muted-foreground hover:bg-accent/30 hover:text-foreground"
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
    <Button ref={newer} type="button" size="icon-xs" variant="ghost" className="board-row-control nodrag nopan" aria-label="Newer cards" title="Newer" disabled={!actions || atStart} onClick={() => actions?.setRowPage?.(data.rowId, data.page - 1)}><ChevronLeft aria-hidden="true" /></Button>
    <span role="status" aria-live="polite" className="whitespace-nowrap px-1 text-[13px] text-muted-foreground">{data.from}–{data.to} of {data.total}</span>
    <Button ref={older} type="button" size="icon-xs" variant="ghost" className="board-row-control nodrag nopan" aria-label="Older cards" title="Older" disabled={!actions || atEnd} onClick={() => actions?.setRowPage?.(data.rowId, data.page + 1)}><ChevronRight aria-hidden="true" /></Button>
  </nav>;
}
