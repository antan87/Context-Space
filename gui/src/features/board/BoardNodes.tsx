import { useId } from 'react';
import type { NodeProps } from '@xyflow/react';
import { CircleCheck, Circle, CircleHelp, FileText, GitCommitHorizontal } from 'lucide-react';

import { Badge } from '../../components/ui/badge.js';
import { cn } from '../../lib/utils.js';
import { agoText } from '../plan/whatsNew.js';
import { BOARD_SIZE, moreText, type CheckpointNode, type CommitNode, type DocumentNode, type LaneNode, type PlaceholderNode } from './boardLayout.js';

const ROLE_LABEL = { requirements: 'Requirements', design: 'Design', evidence: 'Evidence', reference: 'Reference' } as const;
const STATUS_LABEL = { draft: 'Draft', approved: 'Approved', superseded: 'Superseded' } as const;
const STATUS_BADGE = { draft: 'warning', approved: 'success', superseded: 'secondary' } as const;

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
