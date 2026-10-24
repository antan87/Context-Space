import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronRight, ChevronUp, CircleCheck, Circle, CircleHelp, ExternalLink, File, FileCode, FileImage, FileText, Globe, GitCommitHorizontal, PanelRightOpen, Pin, type LucideIcon } from 'lucide-react';

import { ChatMarkdown } from '../../components/ChatMarkdown.js';
import { classifyMarkdownLink } from '../../components/markdownLinks.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from '../../components/ui/dialog.js';
import { cn } from '../../lib/utils.js';
import { agoText } from '../plan/whatsNew.js';
import { BoardActionsContext, BoardReadingContext, cardLinks, documentFileUrl } from './boardActions.js';
import { stepsText, waitingText, type AreaNode } from './boardAreas.js';
import { BOARD_SIZE, authorName, imageAlt, moreText, type CardData, type CheckpointData, type CheckpointNode, type CommitNode, type DocumentNode, type FileNode, type FileType, type LaneNode, type NoteNode, type PlaceholderNode } from './boardLayout.js';

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
      {data.kind === 'checkpoint' && <Badge variant={data.done ? 'success' : 'outline'}>{data.done ? 'Done' : 'Not done'}</Badge>}
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
        {data.kind === 'plan' && <span className="block w-full truncate text-xs leading-5 text-muted-foreground">{planSubtitle(data, false)}</span>}
      </span>
      <FrameFacts data={data} />
    </FoldedGroup>;
  }
  return <article
    aria-labelledby={titleId}
    className={cn('flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs', border)}
  >
    <Anchors />
    <header className="relative border-b border-border/60 px-3 pt-3" style={{ height: BOARD_SIZE.frameHeader }}>
      {data.kind === 'plan'
        ? <div className="h-10 pr-6">
          <h2 id={titleId} className="truncate text-sm font-semibold leading-5 text-foreground">{data.title}</h2>
          <p className="truncate text-xs leading-5 text-muted-foreground">{planSubtitle(data, true)}</p>
        </div>
        : <h2 id={titleId} className="line-clamp-2 h-10 pr-6 text-sm font-semibold leading-5 text-foreground" title={data.title}>{data.title}</h2>}
      <FrameFacts data={data} />
      {data.collapsible !== false && <FoldButton id={id} title={data.title} />}
    </header>
    {data.waiting.length > 0 && <ul aria-label="Decisions waiting for you">
      {data.waiting.map((decision) => <li key={decision.key} className="flex items-start gap-2 border-l-2 border-warning bg-warning/8 px-3 py-1 text-xs leading-4 text-foreground" style={{ height: BOARD_SIZE.decisionRow }}>
        <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
        <span className="line-clamp-2" title={decision.question}><span className="sr-only">Waiting for you: </span>{decision.question}</span>
      </li>)}
      {data.moreWaiting > 0 && <li className="flex items-center border-l-2 border-warning bg-warning/8 px-3 text-xs text-muted-foreground" style={{ height: BOARD_SIZE.moreRow }}>+{data.moreWaiting} more waiting</li>}
    </ul>}
    <ul className="px-3">
      {data.steps.map((step) => <li key={step.key} className="flex items-center gap-2 text-xs" style={{ height: BOARD_SIZE.stepRow }}>
        {step.done
          ? <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-success-foreground" />
          : <Circle aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className={cn('min-w-0 flex-1 truncate', step.done ? 'text-muted-foreground line-through' : 'text-foreground')} title={step.text}>
          <span className="sr-only">{step.done ? 'Done: ' : 'Not done: '}</span>{step.text}
        </span>
      </li>)}
      {data.steps.length === 0 && <li className="flex items-center text-xs text-muted-foreground" style={{ height: BOARD_SIZE.stepRow }}>No steps yet</li>}
      {data.moreSteps > 0 && <li className="flex items-center text-xs text-muted-foreground" style={{ height: BOARD_SIZE.moreRow }}>+{data.moreSteps} more</li>}
    </ul>
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
  const title = <span id={titleId} className={cn('min-w-0 flex-1 truncate text-sm font-semibold', data.dimmed ? 'text-muted-foreground' : 'text-foreground')} title={data.title}>{data.title}</span>;
  return <article
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
export function BoardCommit({ data }: NodeProps<CommitNode>) {
  const shaId = useId();
  const ago = agoText(data.at);
  return <article aria-labelledby={shaId} className="flex h-full w-full flex-col gap-1 overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5 text-card-foreground shadow-xs">
    <Anchors />
    <div className="flex h-4 items-center gap-2 text-xs">
      <GitCommitHorizontal aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <code id={shaId} className="shrink-0 font-mono text-primary">{data.sha}</code>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={data.author}>{data.author}</span>
      {ago && <time dateTime={data.at} className="shrink-0 whitespace-nowrap text-muted-foreground">{ago}</time>}
    </div>
    <p className="line-clamp-2 text-sm leading-[18px] text-foreground" title={data.subject}>{data.subject}</p>
  </article>;
}

/** Stands in a lane that has nothing in it, so the gap is explained and not mistaken for something that failed to load. */
export function BoardPlaceholder({ data }: NodeProps<PlaceholderNode>) {
  return <p className="flex h-full w-full items-center rounded-lg border border-dashed border-border bg-card/60 px-3 text-xs leading-4 text-muted-foreground">{data.text}</p>;
}

// ─── Cards ──────────────────────────────────────────────────────────────────

const FILE_LABEL: Record<FileType, string> = { image: 'Picture', html: 'HTML page', pdf: 'PDF', markdown: 'Markdown', other: 'File' };
const FILE_ICON: Record<FileType, LucideIcon> = { image: FileImage, html: Globe, pdf: FileText, markdown: FileCode, other: File };

/**
 * Whether the text in an element is cut off by its line clamp. Measured again when `key` changes and whenever the element
 * changes size: a card that arrives while the board is hidden behind another part has no size yet, and is measured when it
 * is shown.
 */
function useCut<T extends HTMLElement>(key: string): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [key]);
  return [ref, cut];
}

/** "by claude · 5 min ago", and who changed it since when someone did. */
function bylineText(data: CardData): string {
  const made = agoText(data.at);
  const edited = Date.parse(data.updatedAt) - Date.parse(data.at) > 1000
    ? ` · edited${data.updatedBy === data.by ? '' : ` by ${authorName(data.updatedBy)}`} ${agoText(data.updatedAt)}`.trimEnd()
    : '';
  return `by ${authorName(data.by)}${made ? ` · ${made}` : ''}${edited}`;
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
function ReadAll({ data }: { data: CardData }) {
  const actions = useContext(BoardActionsContext);
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  // Whether the dialog closes to hand the keyboard to the reader, which takes it itself.
  const [handingOver, setHandingOver] = useState(false);
  const links = useMemo(() => actions && cardLinks(actions, trigger, () => { setHandingOver(true); setOpen(false); }), [actions, trigger]);
  return <Dialog open={open} onOpenChange={(next) => { if (next) setHandingOver(false); setOpen(next); }}>
    <DialogTrigger render={<Button ref={setTrigger} size="xs" variant="ghost" className="nodrag nopan" aria-label={`Read all of ${data.title}`} />}>Read all</DialogTrigger>
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

/** The frame every card shares. A card that is new, or was just changed by someone else, glows for a moment; the one open in the reader has a ring. */
function CardFrame({ data, labelledBy, reading = false, children }: { data: CardData; labelledBy: string; reading?: boolean; children: ReactNode }) {
  return <article
    aria-labelledby={labelledBy} aria-current={reading ? 'true' : undefined}
    className={cn('relative flex h-full w-full flex-col overflow-hidden rounded-lg border px-3 py-2.5 shadow-xs',
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
  const [titleRef, titleCut] = useCut<HTMLHeadingElement>(data.title);
  const [bodyRef, bodyCut] = useCut<HTMLDivElement>(data.text);
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
    <code className="max-w-full truncate font-mono text-[11px] text-muted-foreground" title={path}>{path}</code>
  </div>;
}

/** A file someone put on the board: a picture shows itself; anything else shows its kind. Open shows it in the reader beside the board. */
export function BoardFile({ id, data }: NodeProps<FileNode>) {
  const titleId = useId();
  const actions = useContext(BoardActionsContext);
  const reading = useContext(BoardReadingContext) === id;
  // The path of a picture that would not load, so a card that now names another file tries it.
  const [brokenPath, setBrokenPath] = useState<string | null>(null);
  const [titleRef, titleCut] = useCut<HTMLHeadingElement>(data.title);
  const [textRef, textCut] = useCut<HTMLDivElement>(data.text);
  const picture = data.fileType === 'image' && actions && brokenPath !== data.path;
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
        <span className="flex h-5 w-full items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
          {data.kind === 'checkpoint' && (
            data.done ? (
              <Badge variant="success" className="board-area-badge">Done</Badge>
            ) : data.current ? (
              <Badge variant="default" className="board-area-badge">Current</Badge>
            ) : (
              <Badge variant="outline" className="board-area-badge">Not done</Badge>
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
            <span className="block truncate text-xs leading-4 text-muted-foreground">{stepsLabel}</span>
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
            <span className="line-clamp-2 block text-xs leading-4 text-muted-foreground">{data.preview}</span>
          ) : null}
        </span>

        <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border/50 pt-2 text-xs text-muted-foreground">
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

