/**
 * Moving things on the Board: what may be dragged, how a drop is saved, and the keyboard's way of doing the same. A place
 * is kept in the workspace's board file by node id (a `move` change, POST /api/workspace/:id/board/changes), so it is
 * there after a reload and for everyone else. The pure parts are tested alone; the hooks hold what the screen needs
 * between a drop and the answer of the backend.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { NodeChange, OnNodeDrag, ReactFlowInstance } from '@xyflow/react';
import { ApiError, apiFetch } from '../../lib/api/client.js';
import { BOARD_DATA_LIMITS, boardKey, cleanBoard, isBoardNodeId, type BoardPoint, type BoardView } from './boardData.js';
import { nodeTitle, type BoardNode, type Rect } from './boardLayout.js';
import type { Size, Viewport } from './boardView.js';

/** How far Shift and an arrow key move a node, in canvas units. */
export const NUDGE_STEP = 24;
/** A run of key presses is saved this long after the last one. */
export const NUDGE_SAVE_MS = 400;
/** How long Undo is offered after a move. */
export const UNDO_MS = 8000;
/** In front of every other node, for as long as a node is held in the hand. */
const LIFTED = 30;
/** What a node that may be moved says about it when it is focused, for those who cannot see that it can be dragged. */
export const MOVE_HELP = 'Press Shift and an arrow key to move it. Control or Command and Z take the last move back.';
/** How much room a node is given from the edge when the view moves to show it. */
const REVEAL_MARGIN = 24;

// ─── What may be moved ──────────────────────────────────────────────────────

/**
 * Whether a node may be dragged: the board can keep a place for it (a card, or a checkpoint, document or commit, on its
 * own or standing in a lane; not a lane, the placeholder or the plan's own frame). A thing that stands in a lane leaves it
 * where it is dropped.
 */
export const isMovable = (node: Pick<BoardNode, 'id'>): boolean => isBoardNodeId(node.id);

/**
 * Where a node stands on the canvas, given its position as React Flow has it: relative to its lane for a thing that stands
 * in one, the canvas's own for the rest. A place is always saved on the canvas, so it is the same wherever the node stood.
 */
export function canvasPlace(nodes: BoardNode[], id: string, at: BoardPoint): BoardPoint {
  const parentId = nodes.find((node) => node.id === id)?.parentId;
  const parent = parentId === undefined ? undefined : nodes.find((node) => node.id === parentId);
  return parent ? { x: parent.position.x + at.x, y: parent.position.y + at.y } : at;
}

/**
 * The nodes made ready for moving. The ones that may be moved become draggable and a stop for the keyboard, named for what
 * they are and described by the element `helpId` names (which says `MOVE_HELP`). Every node is told the size it is known to have: when a node changes (it is held in the
 * hand, or the board is read again) React Flow takes a node it has no size for to be new, and forgets the anchors the
 * lines are drawn to until it has measured it again, so the lines would go while a card is moved.
 */
export function withMoves(nodes: BoardNode[], helpId: string): BoardNode[] {
  return nodes.map((node) => {
    const sized = node.width !== undefined && node.height !== undefined ? { ...node, measured: { width: node.width, height: node.height } } : node;
    return isMovable(node)
      ? { ...sized, draggable: true, focusable: true, ariaLabel: nodeTitle(node), domAttributes: { 'aria-describedby': helpId } } as BoardNode
      : sized;
  });
}

/**
 * The nodes that are being moved drawn where they are held (a place on the canvas), in front of the rest. A node that
 * stands in a lane is given its position in the lane that puts it there. Everything else is left as it is.
 */
export function placeHeld(nodes: BoardNode[], held: Record<string, BoardPoint>): BoardNode[] {
  if (Object.keys(held).length === 0) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    const at = held[node.id];
    if (!at) return node;
    const parent = node.parentId === undefined ? undefined : byId.get(node.parentId);
    return { ...node, position: parent ? { x: at.x - parent.position.x, y: at.y - parent.position.y } : at, zIndex: LIFTED };
  });
}

// ─── Places and the changes that save them ──────────────────────────────────

/** A place as the board file keeps it: whole numbers, inside the limits. */
export function placeOf(point: BoardPoint): BoardPoint {
  const keep = (value: number) => (Number.isFinite(value) ? Math.max(-BOARD_DATA_LIMITS.coordinate, Math.min(BOARD_DATA_LIMITS.coordinate, Math.round(value))) : 0);
  return { x: keep(point.x), y: keep(point.y) };
}

export const samePlace = (a: BoardPoint | null | undefined, b: BoardPoint | null | undefined): boolean => (a && b ? a.x === b.x && a.y === b.y : !a && !b);

/** A `move` as the backend takes it. `null` for x and y forgets a node's place, so it goes back to its automatic one. */
export interface BoardMoveChange { op: 'move'; nodes: Array<{ id: string; x: number | null; y: number | null }> }

export function moveChange(id: string, to: BoardPoint | null): BoardMoveChange {
  return { op: 'move', nodes: [{ id, x: to ? to.x : null, y: to ? to.y : null }] };
}

/** What undoes a move: the place the node had before it, or no place at all when it had none. */
export const undoChange = (id: string, before: BoardPoint | undefined): BoardMoveChange => moveChange(id, before ?? null);

/** The board with one place set, or forgotten with `null`: what the screen shows before the backend has answered. */
export function withPlace(board: BoardView, id: string, to: BoardPoint | null): BoardView {
  const positions = { ...board.positions };
  if (to) positions[id] = to; else delete positions[id];
  return { ...board, positions };
}

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Why a place could not be saved, in plain words. The backend's own words are used when they are short and say what is wrong. */
export function moveProblem(error: unknown): string {
  const lead = 'Could not save the place';
  if (!(error instanceof ApiError)) return `${lead}: the app could not be reached`;
  // Something the request did not cause (a write, the disk) may name paths: say only that it went wrong.
  if (error.status >= 500) return `${lead}: something went wrong on the server`;
  const sentence = error.message.split(/(?<=[.!?])\s/)[0]?.trim().replace(/[.!?]+$/, '') ?? '';
  // An id says nothing to a person; the backend names one when the thing is not there.
  if (UUID_IN_TEXT.test(sentence)) return `${lead}: that card is no longer on the board`;
  if (!sentence || sentence.length > 100) return `${lead}: the server refused it`;
  return `${lead}: ${/^[A-Z][a-z]/.test(sentence) ? sentence[0]!.toLowerCase() + sentence.slice(1) : sentence}`;
}

// ─── The keyboard ───────────────────────────────────────────────────────────

const ARROWS: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** Where a node goes when an arrow key is pressed with Shift, or null for any other key. */
export function nudged(from: BoardPoint, key: string, step: number = NUDGE_STEP): BoardPoint | null {
  const direction = Object.hasOwn(ARROWS, key) ? ARROWS[key] : undefined;
  return direction ? { x: from.x + direction[0] * step, y: from.y + direction[1] * step } : null;
}

/**
 * Where to put the view so `rect` is whole inside it: moved only as far as it takes, with a little room from the edge.
 * Null when it is in view already. A rect bigger than the view is lined up at its top left corner.
 */
export function revealed(rect: Rect, view: Viewport, size: Size, margin: number = REVEAL_MARGIN): Viewport | null {
  const along = (start: number, length: number, offset: number, room: number): number => {
    const from = start * view.zoom + offset;
    const span = length * view.zoom;
    if (from >= 0 && from + span <= room) return offset;
    if (from < 0 || span + 2 * margin > room) return margin - start * view.zoom;
    return room - margin - span - start * view.zoom;
  };
  const x = along(rect.x, rect.width, view.x, size.width);
  const y = along(rect.y, rect.height, view.y, size.height);
  return x === view.x && y === view.y ? null : { ...view, x, y };
}

// ─── Saving ─────────────────────────────────────────────────────────────────

/**
 * Puts a node somewhere on the board, or takes its place away with `null`. The board you see changes first, so a node that
 * was dropped stays where it was dropped; then the move is sent as the user, and taken back again here if it is refused.
 * It names its node and nothing else (no revision), so it is never held up by what an AI changed meanwhile. Resolves with
 * the place the node had, for Undo; rejects with the backend's error.
 */
export async function moveNodeWith(queryClient: QueryClient, workspace: string, id: string, to: BoardPoint | null): Promise<BoardPoint | undefined> {
  const key = boardKey(workspace);
  const cached = queryClient.getQueryData<BoardView>(key);
  const before = cached?.positions[id];
  // A read that began before the move would bring the old place back over the new one. With no board yet there is no place
  // to protect, and cancelling the first read would leave the board without data and without a reason to ask again.
  if (cached) await queryClient.cancelQueries({ queryKey: key });
  queryClient.setQueryData<BoardView>(key, (board) => board && withPlace(board, id, to));
  let reply: unknown;
  try {
    reply = await apiFetch<unknown>(`/api/workspace/${encodeURIComponent(workspace)}/board/changes`, { method: 'POST', body: JSON.stringify({ changes: [moveChange(id, to)] }) });
  } catch (error) {
    // Unless a read has brought another place since, the node goes back to where it was. A read that was cancelled for the
    // move (an AI's change may be what it was asked for) is asked for again, since no event will follow a move that failed.
    queryClient.setQueryData<BoardView>(key, (board) => (board && samePlace(board.positions[id], to) ? withPlace(board, id, before ?? null) : board));
    void queryClient.invalidateQueries({ queryKey: key });
    throw error;
  }
  // The reply is the board with the move in it. A read that is newer already has it, and keeps any later change.
  try {
    const fresh = cleanBoard(reply);
    queryClient.setQueryData<BoardView>(key, (board) => (!board || fresh.revision >= board.revision ? fresh : board));
  } catch {
    void queryClient.invalidateQueries({ queryKey: key });
  }
  return before;
}

/** `moveNodeWith` for the board of a workspace. */
export function useMoveNode(workspace: string) {
  const queryClient = useQueryClient();
  return (id: string, to: BoardPoint | null) => moveNodeWith(queryClient, workspace, id, to);
}

/** What the board says about the last move: that it was made, with Undo, or why it was not. `id` is the node it is about. */
export interface MoveNotice { id: string; text: string; failed: boolean; undo?: () => void }

export interface BoardMoves {
  /** The nodes, with the ones in the hand drawn where they are held. */
  shown: BoardNode[];
  notice: MoveNotice | null;
  onNodesChange: (changes: NodeChange<BoardNode>[]) => void;
  onNodeDragStart: OnNodeDrag<BoardNode>;
  onNodeDragStop: OnNodeDrag<BoardNode>;
  /** Handles Shift and an arrow key on a node that may be moved, and Control or Command and Z while Undo is offered; false for any other key press. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean;
  /** Puts the message away, and the keyboard back on the node it was about. */
  dismiss: () => void;
  /** While the pointer or the keyboard is on the message it stays, so there is time to reach Undo. */
  keepNotice: (on: boolean) => void;
}

/**
 * Dragging a node, or moving it with Shift and the arrow keys, and saving where it ended up. While a node is in the
 * hand it is drawn where the hand put it: a read of the board that comes in meanwhile cannot move it, and the lines
 * follow. It stays there while the move is saved, and after that the board's own place is the one that counts. A run of
 * key presses is saved once, a moment after the last. Each save offers Undo for a while (Control or Command and Z too),
 * or says why it failed.
 */
export function useBoardMoves({ workspaceId, nodes, flow, size, reveal, focusNode }: {
  workspaceId: string;
  /** The nodes as the layout puts them, with the movable ones marked. */
  nodes: BoardNode[];
  flow: RefObject<ReactFlowInstance<BoardNode> | null>;
  size: Size;
  /** Moves the view to show a node that the keyboard pushed out of it. */
  reveal: (view: Viewport) => void;
  /** Puts the keyboard on a node, or on the canvas when the node is gone: where it was before Undo or Dismiss took the button away. */
  focusNode: (id: string) => void;
}): BoardMoves {
  const moveNode = useMoveNode(workspaceId);
  // The places in the hand, on the canvas, kept in a ref as well so a second key press sees the first one before the screen has drawn it.
  const [held, setHeld] = useState<Record<string, BoardPoint>>({});
  const heldNow = useRef(held);
  const [notice, setNotice] = useState<MoveNotice | null>(null);
  const [onNotice, setOnNotice] = useState(false);
  const dragged = useRef<{ id: string; at: BoardPoint; nudged: boolean } | null>(null);
  const keys = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  const hold = (id: string, at: BoardPoint | null) => {
    const next = { ...heldNow.current };
    if (at) next[id] = at; else delete next[id];
    heldNow.current = next;
    setHeld(next);
  };

  const send = (id: string, to: BoardPoint | null, undoable: boolean) => {
    const place = to && placeOf(to);
    hold(id, place);
    const title = nodeTitleOf(nodes, id);
    // The place stays in the hand until the answer, unless the node was picked up again meanwhile.
    const release = () => { if (place && heldNow.current[id] === place) hold(id, null); };
    void moveNode(id, place).then(
      (before) => {
        release();
        // An Undo that has been answered leaves the board's message alone: it may be about a move made since.
        if (!undoable) return;
        const offered: MoveNotice = {
          id, text: `Moved “${title}”`, failed: false,
          undo: () => { setNotice((now) => (now === offered ? null : now)); focusNode(id); send(id, before ?? null, false); },
        };
        setNotice(offered);
      },
      (error: unknown) => { release(); setNotice({ id, text: moveProblem(error), failed: true }); },
    );
  };

  const saveKeys = () => {
    const run = keys.current;
    if (!run) return;
    clearTimeout(run.timer);
    keys.current = null;
    const at = heldNow.current[run.id];
    if (at) send(run.id, at, true);
  };
  // A run that is still waiting when the board goes away is saved, not lost.
  const latest = useRef(saveKeys);
  useEffect(() => { latest.current = saveKeys; });
  useEffect(() => () => latest.current(), []);

  // Undo is offered for a while, and not while it is being reached for.
  useEffect(() => {
    if (!notice) { setOnNotice(false); return; }
    if (notice.failed || onNotice) return;
    const timer = setTimeout(() => setNotice((now) => (now === notice ? null : now)), UNDO_MS);
    return () => clearTimeout(timer);
  }, [notice, onNotice]);

  return {
    shown: placeHeld(nodes, held),
    notice,
    onNodesChange: (changes) => {
      for (const change of changes) {
        if (change.type !== 'position') continue;
        if (change.dragging && change.position) hold(change.id, canvasPlace(nodes, change.id, change.position));
        // The drag is over. When it ends by the hand's doing, onNodeDragStop follows and holds the place it saves, in the
        // same batch. When the node went away while it was in the hand (an AI archived it, a second touch) nothing follows,
        // and the node must not stay drawn where the hand left it.
        else if (change.dragging === false) hold(change.id, null);
      }
    },
    onNodeDragStart: (_event, node) => {
      // Keys pressed a moment ago are part of this move: the drag goes on from where they put the node, and saves once.
      const run = keys.current;
      const nudgedBefore = run?.id === node.id;
      if (run && nudgedBefore) { clearTimeout(run.timer); keys.current = null; }
      dragged.current = { id: node.id, at: canvasPlace(nodes, node.id, node.position), nudged: nudgedBefore };
    },
    onNodeDragStop: (_event, node) => {
      const start = dragged.current;
      dragged.current = null;
      const to = placeOf(canvasPlace(nodes, node.id, node.position));
      // Picked up and put down where it was: nothing to save, unless keys had moved it first.
      if (start?.id === node.id && !start.nudged && samePlace(placeOf(start.at), to)) { hold(node.id, null); return; }
      send(node.id, to, true);
    },
    onKeyDown: (event) => {
      if (event.ctrlKey || event.metaKey) {
        // Take the last move back, from the board and not from a field or the dialog that a card opens (which React
        // passes its keys up through, though it is not in the board).
        const target = event.target as HTMLElement;
        if (event.key.toLowerCase() !== 'z' || event.shiftKey || event.altKey || !notice?.undo || !event.currentTarget.contains(target)) return false;
        if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return false;
        event.preventDefault();
        notice.undo();
        return true;
      }
      if (!event.shiftKey || event.altKey) return false;
      const target = event.target as HTMLElement;
      const node = target.classList.contains('react-flow__node') && target.classList.contains('draggable') ? nodes.find((entry) => entry.id === target.dataset.id) : undefined;
      const to = node && nudged(heldNow.current[node.id] ?? canvasPlace(nodes, node.id, node.position), event.key);
      if (!node || !to) return false;
      event.preventDefault();
      // Another node's run is over: it is saved now, and this one begins.
      if (keys.current && keys.current.id !== node.id) saveKeys();
      if (keys.current) clearTimeout(keys.current.timer);
      hold(node.id, to);
      keys.current = { id: node.id, timer: setTimeout(saveKeys, NUDGE_SAVE_MS) };
      const view = flow.current?.getViewport();
      const next = view && revealed({ ...to, width: node.width ?? 0, height: node.height ?? 0 }, view, size);
      if (next) reveal(next);
      return true;
    },
    dismiss: () => { if (notice) focusNode(notice.id); setNotice(null); },
    keepNotice: setOnNotice,
  };
}

const nodeTitleOf = (nodes: BoardNode[], id: string): string => {
  const node = nodes.find((entry) => entry.id === id);
  return node ? nodeTitle(node) : 'the card';
};
