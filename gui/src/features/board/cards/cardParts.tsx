import { useContext, useLayoutEffect, useMemo, useState, type MouseEvent, type ReactNode, type Ref } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Pin, Terminal } from 'lucide-react';

import { ChatMarkdown } from '../../../components/ChatMarkdown.js';
import { Badge, Button, Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger, FreshDot, Mark } from '../../../design/index.js';
import { cn } from '../../../lib/utils.js';
import { BoardActionsContext, bylineText, cardLinks } from '../boardActions.js';
import { askCard, type AskCard } from '../askText.js';
import type { CardData } from '../boardLayout.js';

const SIDES = [[Position.Top, 'top'], [Position.Right, 'right'], [Position.Bottom, 'bottom'], [Position.Left, 'left']] as const;

/**
 * Where a line to this node can end: one invisible point on each side, so a line leaves and enters by the sides that
 * face each other. They are the line's anchors and nothing else: nothing can be connected by hand.
 */
export function Anchors() {
  return <>{SIDES.map(([position, id]) => <Handle key={id} id={id} type="source" position={position} isConnectable={false} className="board-handle" />)}</>;
}

/**
 * A press anywhere on a compact card does the card's main action, which is what its own button does (`find` names that button). It is not
 * a button itself (a button cannot hold buttons and links), so a press on one of those keeps its own action, and a press that ends the
 * selection of some text does nothing: the text of a card can be selected.
 */
let pointerState: {
  x: number;
  y: number;
  dragged: boolean;
  beforeText: string;
  active: boolean;
  upAt: number;
  downTarget: EventTarget | null;
  /** How far the pointer may move and still be a press: a finger is less steady than a mouse. */
  slop: number;
} | null = null;
let clickDragState: {
  at: number;
  anchorNode: Node | null;
  focusNode: Node | null;
  downTarget: EventTarget | null;
} | null = null;
let clearClickDragTimer: ReturnType<typeof setTimeout> | null = null;
let pointerEventsSeen = false;
let pointerTrackerInstalled = false;

/** Pixels a press may move and still open a card. */
const MOUSE_SLOP = 4;
const TOUCH_SLOP = 10;

function clearClickDrag() {
  clickDragState = null;
  if (clearClickDragTimer !== null) {
    clearTimeout(clearClickDragTimer);
    clearClickDragTimer = null;
  }
}

function ensurePointerTracker() {
  if (pointerTrackerInstalled || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  pointerTrackerInstalled = true;
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      pointerEventsSeen = true;
      clearClickDrag();
      const beforeText = typeof window !== 'undefined' ? (window.getSelection()?.toString() ?? '') : '';
      pointerState = {
        x: event.clientX,
        y: event.clientY,
        dragged: false,
        beforeText,
        active: true,
        upAt: 0,
        downTarget: event.target,
        slop: event.pointerType === 'touch' ? TOUCH_SLOP : MOUSE_SLOP,
      };
    },
    true,
  );
  document.addEventListener(
    'pointermove',
    (event) => {
      if (!pointerState?.active || pointerState.dragged) return;
      if (Math.hypot(event.clientX - pointerState.x, event.clientY - pointerState.y) > pointerState.slop) {
        pointerState.dragged = true;
      }
    },
    true,
  );
  const finishPointer = () => {
    if (!pointerState?.active) return;
    pointerState.upAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    pointerState.active = false;
  };
  document.addEventListener('pointerup', finishPointer, true);
  document.addEventListener('pointercancel', finishPointer, true);
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        clearClickDrag();
        if (pointerState && !pointerState.active) pointerState = null;
      }
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      pointerEventsSeen = true;
      clearClickDrag();
      if (event.detail === 0) return;
      const selection = typeof window !== 'undefined' ? window.getSelection() : null;
      const selectedNow = selection && !selection.isCollapsed ? selection.toString() : '';
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!selectedNow || !pointerState || pointerState.active || now - pointerState.upAt >= 500) {
        return;
      }
      if (!pointerState.dragged && selectedNow === pointerState.beforeText) {
        // A stale selection is only cleared on the Board's own cards: a click elsewhere in the app keeps its selection
        const target = event.target;
        if (target instanceof Element && target.closest('.react-flow__node')) selection?.removeAllRanges?.();
        return;
      }
      clickDragState = {
        at: now,
        anchorNode: selection?.anchorNode ?? null,
        focusNode: selection?.focusNode ?? null,
        downTarget: pointerState.downTarget,
      };
      clearClickDragTimer = setTimeout(() => {
        clickDragState = null;
        clearClickDragTimer = null;
      }, 0);
    },
    true,
  );
}

ensurePointerTracker();

function selectionTouches(
  container: Element,
  anchorNode: Node | null,
  focusNode: Node | null,
  downTarget: EventTarget | null,
): boolean {
  return (
    container.contains(anchorNode) ||
    container.contains(focusNode) ||
    (typeof Node !== 'undefined' && downTarget instanceof Node && container.contains(downTarget))
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- a helper the cards share, not a component
export function hasDragSelection(
  target: EventTarget | null,
  event?: { detail?: number } | null,
): boolean {
  if (event && event.detail === 0) return false;
  const container = target instanceof Element ? target : null;
  if (!container) return false;

  if (pointerEventsSeen) {
    if (!clickDragState) return false;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - clickDragState.at >= 100) return false;
    return selectionTouches(
      container,
      clickDragState.anchorNode,
      clickDragState.focusNode,
      clickDragState.downTarget,
    );
  }

  const selection = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!selection || selection.isCollapsed || !selection.toString()) return false;
  return selectionTouches(container, selection.anchorNode, selection.focusNode, null);
}

// eslint-disable-next-line react-refresh/only-export-components -- a helper the cards share, not a component
export function brickPress(event: MouseEvent<HTMLElement>, find: (card: HTMLElement) => HTMLElement | null) {
  const target = event.target;
  // A press inside a dialog that the card opened bubbles up through React's tree, but is not on the card
  if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
  if (target.closest('button, a, input, textarea, select, [role="button"]')) return;
  if (hasDragSelection(event.currentTarget, event)) return;
  find(event.currentTarget)?.click();
}

/** The title of a compact card that opens, which is the card's one stop for the keyboard. The press of the whole card does what it does. */
export const TITLE_BUTTON = 'nodrag nopan select-text flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-sm text-left outline-hidden hover:underline disabled:pointer-events-none';

/**
 * "Ask in CLI" on a compact card (a document row, a picture, a file, a commit), which has no menu and no room for a labelled button.
 * One small icon button laid over a corner of the card, after the card's main press target and not inside it: it shows on hover and
 * on keyboard focus (the card must carry `group`), is 28 px (25 px on screen at the Area's 0.9 zoom), and types the same line as the
 * full card's button. Nothing is drawn for a read-only workspace, or when there is no AI session to ask.
 */
export function AskCompact({ card, label, className }: { card: AskCard; label: string; className: string }) {
  const actions = useContext(BoardActionsContext);
  if (!actions?.askInCLI || actions.readOnly) return null;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        actions.askInCLI?.(askCard(card));
      }}
      className={cn('btn-ask-card nodrag nopan absolute z-10 inline-flex size-7 cursor-pointer items-center justify-center rounded-md border border-border/80 bg-card text-primary pointer-events-none opacity-0 shadow-xs transition-opacity hover:border-primary/50 hover:bg-accent focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:pointer-events-auto group-hover:opacity-100', className)}
      aria-label={`Ask in CLI about ${label}`}
      title={`Ask in CLI about ${label}`}
    >
      <Terminal aria-hidden="true" className="size-3.5" />
    </button>
  );
}

/**
 * Whether the text in an element is cut off by its line clamp. Measured again when `key` changes and whenever the element
 * changes size: a card that arrives while the board is hidden behind another part has no size yet, and is measured when it
 * is shown.
 */
// eslint-disable-next-line react-refresh/only-export-components -- a helper the cards share, not a component
export function useCut<T extends HTMLElement>(key: string): [(element: T | null) => void, boolean] {
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
export function CardText({ text, cut, className, ref }: { text: string; cut: boolean; className?: string; ref?: Ref<HTMLDivElement> }) {
  const actions = useContext(BoardActionsContext);
  const links = useMemo(() => actions && cardLinks(actions), [actions]);
  return <div ref={ref} className={cn('board-text nodrag select-text break-words', className)}>
    <ChatMarkdown content={text} links={links ?? undefined} onCard cut={cut} />
  </div>;
}

/** The whole text of a card, for when the card shows only the start of it. A link in it that opens in the reader gives way to it. */
export function ReadAll({ data, title }: { data: CardData; /** The title of a compact card: it is the trigger then, as a button named "Read <title>", and not a "Read all" button. */ title?: ReactNode }) {
  const actions = useContext(BoardActionsContext);
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  // Whether the dialog closes to hand the keyboard to the reader, which takes it itself.
  const [handingOver, setHandingOver] = useState(false);
  const links = useMemo(() => actions && cardLinks(actions, trigger, () => { setHandingOver(true); setOpen(false); }), [actions, trigger]);
  return <Dialog open={open} onOpenChange={(next) => { if (next && hasDragSelection(trigger)) return; if (next) setHandingOver(false); setOpen(next); }}>
    <DialogTrigger render={title
      ? <button ref={setTrigger} type="button" data-card-main className={TITLE_BUTTON} aria-label={`Read ${data.title}`} onClick={(event) => { if (hasDragSelection(event.currentTarget, event)) event.preventDefault(); }} />
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
export function Byline({ data, children }: { data: CardData; children?: ReactNode }) {
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
export function CardMark({ data, markId }: { data: CardData; markId: string }) {
  const byline = bylineText(data);
  // Who made it; who changed it since is in the byline
  const ai = data.by !== 'user';
  return <div className="flex min-h-7 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
    {data.pinned && <Pin aria-hidden="true" className="size-3 shrink-0 text-primary" />}
    {data.pinned && <span className="sr-only">Pinned. </span>}
    {data.archived && <span>Archived</span>}
    {data.fresh && (
      <>
        <FreshDot />
        <span className="sr-only">New since you looked. </span>
      </>
    )}
    <Mark id={markId} ai={ai} label={byline} />
  </div>;
}
