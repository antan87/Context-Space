import { useContext, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CircleCheck, Circle, CircleHelp, ExternalLink, File, FileCode, FileImage, FileText, Globe, GitCommitHorizontal, Pin, type LucideIcon } from 'lucide-react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from '../../components/ui/dialog.js';
import { cn } from '../../lib/utils.js';
import { agoText } from '../plan/whatsNew.js';
import { BoardActionsContext, documentFileUrl } from './boardActions.js';
import { BOARD_SIZE, authorName, imageAlt, moreText, type CardData, type CheckpointNode, type CommitNode, type DocumentNode, type FileNode, type FileType, type LaneNode, type NoteNode, type PlaceholderNode } from './boardLayout.js';

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

/** The title of a lane: what its cards are, and what it leaves out. Its cards are separate nodes drawn over it. */
export function BoardLane({ data }: NodeProps<LaneNode>) {
  return <div className="flex h-full w-full flex-col rounded-2xl border border-dashed border-border bg-muted/40">
    <div className="px-4 pt-3" style={{ height: BOARD_SIZE.laneHeader }}>
      <h2 className="truncate text-sm font-semibold leading-5 text-foreground" title={data.title}>{data.title}</h2>
      <p className="truncate text-xs leading-4 text-muted-foreground">{data.caption}</p>
    </div>
    {data.note && <p className="line-clamp-2 px-4 text-xs leading-5 text-destructive-foreground" style={{ height: BOARD_SIZE.laneNote }}>{data.note}</p>}
    {data.more > 0 && <p className="mt-auto flex items-center px-4 text-xs text-muted-foreground" style={{ height: BOARD_SIZE.laneMore }}>
      {moreText(data.more, data.moreAtLeast)}
    </p>}
  </div>;
}

/** One checkpoint of PLAN.md: whether it is done, how far its steps are, what waits for the user, and the first steps. */
export function BoardCheckpoint({ data }: NodeProps<CheckpointNode>) {
  const titleId = useId();
  const waiting = data.waiting.length + data.moreWaiting;
  const progress = data.stepsTotal ? (data.stepsDone / data.stepsTotal) * 100 : 0;
  return <article
    aria-labelledby={titleId}
    className={cn('flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs',
      waiting ? 'border-warning/60' : data.done ? 'border-success/50' : 'border-border')}
  >
    <Anchors />
    <header className="border-b border-border/60 px-3 pt-3" style={{ height: BOARD_SIZE.frameHeader }}>
      {data.kind === 'plan'
        ? <div className="h-10">
          <h2 id={titleId} className="truncate text-sm font-semibold leading-5 text-foreground">{data.title}</h2>
          <p className="truncate text-xs leading-5 text-muted-foreground">Steps and decisions outside the checkpoints</p>
        </div>
        : <h2 id={titleId} className="line-clamp-2 h-10 text-sm font-semibold leading-5 text-foreground" title={data.title}>{data.title}</h2>}
      <div className="mt-1.5 flex h-5 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
        {data.kind === 'checkpoint' && <Badge variant={data.done ? 'success' : 'outline'}>{data.done ? 'Done' : 'Not done'}</Badge>}
        <span>{data.stepsTotal ? `${data.stepsDone} of ${data.stepsTotal} ${data.stepsTotal === 1 ? 'step' : 'steps'}` : 'No steps'}</span>
        {waiting > 0 && <Badge variant="warning">{waiting === 1 ? 'Waits for you' : `${waiting} wait for you`}</Badge>}
      </div>
      <div aria-hidden="true" className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-success" style={{ width: `${progress}%` }} />
      </div>
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

/** A source document: its role and status, and the first lines of its summary. A superseded one recedes but keeps its status. */
export function BoardDocument({ data }: NodeProps<DocumentNode>) {
  const titleId = useId();
  return <article
    aria-labelledby={titleId}
    className={cn('flex h-full w-full flex-col gap-1.5 overflow-hidden rounded-lg border px-3 py-2.5 shadow-xs',
      data.dimmed ? 'border-dashed border-border bg-muted text-muted-foreground' : 'border-border bg-card text-card-foreground')}
  >
    <Anchors />
    <div className="flex h-5 items-center gap-1.5">
      <FileText aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <p id={titleId} className={cn('min-w-0 flex-1 truncate text-sm font-semibold', data.dimmed ? 'text-muted-foreground' : 'text-foreground')} title={data.title}>{data.title}</p>
    </div>
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

/** The whole text of a card, for when the card shows only the start of it. */
function ReadAll({ data }: { data: CardData }) {
  return <Dialog>
    <DialogTrigger render={<Button size="xs" variant="ghost" className="nodrag nopan" aria-label={`Read all of ${data.title}`} />}>Read all</DialogTrigger>
    <DialogPopup className="max-w-lg">
      <DialogHeader>
        <DialogTitle className="break-words pr-8 text-base leading-snug">{data.title}</DialogTitle>
        <DialogDescription>{bylineText(data)}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{data.text}</p>
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

/** The frame every card shares. A card that is new, or was just changed by someone else, glows for a moment. */
function CardFrame({ data, labelledBy, children }: { data: CardData; labelledBy: string; children: ReactNode }) {
  return <article
    aria-labelledby={labelledBy}
    className={cn('relative flex h-full w-full flex-col overflow-hidden rounded-lg border px-3 py-2.5 shadow-xs',
      data.archived ? 'border-dashed border-border bg-muted text-muted-foreground' : data.pinned ? 'border-primary/50 bg-card text-card-foreground' : 'border-border bg-card text-card-foreground')}
  >
    <Anchors />
    {data.fresh && <span key={data.updatedAt} aria-hidden="true" className="board-fresh" />}
    {children}
  </article>;
}

/** A note someone put on the board: its title, the start of its text, who wrote it and when. The whole text is one button away. */
export function BoardNote({ data }: NodeProps<NoteNode>) {
  const titleId = useId();
  const [titleRef, titleCut] = useCut<HTMLHeadingElement>(data.title);
  const [bodyRef, bodyCut] = useCut<HTMLParagraphElement>(data.text);
  return <CardFrame data={data} labelledBy={titleId}>
    <h2 ref={titleRef} id={titleId} className={cn('line-clamp-2 shrink-0 break-words text-sm font-semibold leading-5', data.archived ? 'text-muted-foreground' : 'text-foreground')} title={data.title}>{data.title}</h2>
    <p ref={bodyRef} className="mt-1 line-clamp-4 shrink-0 whitespace-pre-line break-words text-xs leading-[18px]">{data.text}</p>
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

/** A file someone put on the board: a picture shows itself; anything else shows its kind. Open shows it where the app shows documents. */
export function BoardFile({ data }: NodeProps<FileNode>) {
  const titleId = useId();
  const actions = useContext(BoardActionsContext);
  // The path of a picture that would not load, so a card that now names another file tries it.
  const [brokenPath, setBrokenPath] = useState<string | null>(null);
  const [titleRef, titleCut] = useCut<HTMLHeadingElement>(data.title);
  const [textRef, textCut] = useCut<HTMLParagraphElement>(data.text);
  const picture = data.fileType === 'image' && actions && brokenPath !== data.path;
  return <CardFrame data={data} labelledBy={titleId}>
    <h2 ref={titleRef} id={titleId} className={cn('line-clamp-2 shrink-0 break-words text-sm font-semibold leading-5', data.archived ? 'text-muted-foreground' : 'text-foreground')} title={data.title}>{data.title}</h2>
    <div className="mt-1.5 h-24 shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted/60">
      {picture
        ? <img
          src={documentFileUrl(actions.workspaceId, data.path)} alt={imageAlt({ title: data.title, description: data.text, path: data.path })}
          loading="lazy" decoding="async" draggable={false} onError={() => setBrokenPath(data.path)} className="size-full object-contain"
        />
        : <FileKind type={data.fileType} path={data.path} />}
    </div>
    <p ref={textRef} className="mt-1.5 line-clamp-3 shrink-0 whitespace-pre-line break-words text-xs leading-[18px]">{data.text}</p>
    <div className="mt-auto" />
    <Byline data={data} />
    <div className="flex h-7 shrink-0 items-center gap-1">
      <Button size="xs" variant="outline" className="nodrag nopan" aria-label={`Open ${data.title}`} onClick={() => actions?.openFile(data.path)} disabled={!actions}><ExternalLink aria-hidden="true" />Open</Button>
      {(titleCut || textCut) && <ReadAll data={data} />}
    </div>
  </CardFrame>;
}
