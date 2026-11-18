import { useContext, useRef, useState, type ReactNode } from 'react';
import { type NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { InlinePlanMarkdown } from '../../../components/InlinePlanMarkdown.js';
import { cn } from '../../../lib/utils.js';
import { plainText, stripHeadingColon } from '../../../lib/plainText.js';
import { Badge, Button, CARD_BRICK as BRICK, CARD_FOCUS, Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger, rowSurface, StepCheck } from '../../../design/index.js';
import { BoardActionsContext, firstControl } from '../boardActions.js';
import type { RowHeadData, RowHeadNode } from '../boardLayout.js';
import { Anchors, brickPress } from '../cards/cardParts.js';

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
          <StepCheck
            testId={`step-checkbox-${data.stepKey}`}
            checked={isDone}
            label={isDone ? `Mark "${stepName}" not done` : `Mark "${stepName}" done`}
            title={stepError ?? (isDone ? `Mark "${stepName}" not done` : `Mark "${stepName}" done`)}
            disabled={!actions?.toggleStep || isBusy || Boolean(actions?.readOnly)}
            busy={isBusy}
            pressable={Boolean(actions?.toggleStep && !actions?.readOnly)}
            className="nodrag nopan"
            onToggle={() => {
              if (data.stepKey && !actions?.readOnly) {
                void actions?.toggleStep?.(data.stepKey, !isDone, data.text);
              }
            }}
          />
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
    <StepCheck
      testId={`step-checkbox-${data.stepKey}`}
      checked={isDone}
      label={isDone ? `Mark "${stepPlain}" not done` : `Mark "${stepPlain}" done`}
      title={stepError ?? (isDone ? `Mark "${stepPlain}" not done` : `Mark "${stepPlain}" done`)}
      disabled={!actions?.toggleStep || isBusy || Boolean(actions?.readOnly)}
      busy={isBusy}
      pressable={Boolean(actions?.toggleStep && !actions?.readOnly)}
      className="nodrag nopan"
      onToggle={() => {
        if (data.stepKey && !actions?.readOnly) {
          void actions?.toggleStep?.(data.stepKey, !isDone, data.text);
        }
      }}
    />
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
      <div className={cn('@container/now relative flex h-full w-full items-center gap-2 overflow-hidden', rowSurface({ now: true }), 'text-left')}>
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
          rowSurface({ now: Boolean(data.prominent), hover: data.prominent ? 'hover:bg-primary/5' : undefined })
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
        rowSurface({ now: Boolean(data.prominent), hover: data.prominent ? 'hover:bg-primary/10' : 'hover:bg-accent/30' }))}
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
