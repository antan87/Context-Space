import { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { type NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '../../../design/index.js';
import { cn } from '../../../lib/utils.js';
import { BoardActionsContext } from '../boardActions.js';
import type { FoldNode, MoreNode, PagerNode } from '../boardLayout.js';
import { Anchors } from '../cards/cardParts.js';
import { summaryLabel } from '../summaryLabel.js';

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
      {data.summary && !(tail && NOTHING.test(data.summary)) && <span className="shrink-0 whitespace-nowrap text-[13px] text-muted-foreground">{data.summary.split(/(\d+ changed since)/).map((part, index) => (index % 2 === 1 ? <span key={index} className="font-medium text-warning-foreground">{part}</span> : part))}</span>}
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
