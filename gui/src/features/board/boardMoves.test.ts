import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../lib/api/client.js';
import type { PlanFileCheckpoint, PlanFileView } from '../plan/planFile.js';
import type { WhatsNewView } from '../plan/whatsNew.js';
import type { WorkDocument } from '../../types.js';
import { boardKey, type BoardCard, type BoardView } from './boardData.js';
import { boardLayout, type BoardNode } from './boardLayout.js';
import { MOVE_HELP, NUDGE_STEP, canvasPlace, clearedPlace, isMovable, moveChange, moveNodeWith, moveProblem, nudged, placeHeld, placeOf, revealed, samePlace, undoChange, withMoves, withPlace } from './boardMoves.js';

vi.mock('../../lib/api/client.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api/client.js')>()), apiFetch: vi.fn() }));
const post = vi.mocked(apiFetch);

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-10-23T09:00:00.000Z';
const slug = (words: string) => words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const checkpoint = (title: string, fields: Partial<PlanFileCheckpoint> = {}): PlanFileCheckpoint => ({ key: slug(title), title, done: false, steps: [], decisions: [], ...fields });
const plan = (checkpoints: PlanFileCheckpoint[], fields: Partial<PlanFileView> = {}): PlanFileView => ({
  file: 'PLAN.md', source: 'file', title: 'Plan', intro: '', sections: [], steps: [], decisions: [], changes: [], checkpoints, waiting: [], ...fields,
});
const note = (n: number): BoardCard => ({ id: uuid(n), kind: 'note', title: `Note ${n}`, body: '', pinned: false, archived: false, by: 'claude', at: AT, updatedBy: 'claude', updatedAt: AT });
const doc = (id: string, title: string): WorkDocument => ({ id, title, role: 'design', status: 'approved', scope: {}, summary: '', createdAt: AT, updatedAt: AT });
const boardOf = (fields: Partial<BoardView> = {}): BoardView => ({ revision: 1, cards: [], links: [], positions: {}, ...fields });
const news = (): WhatsNewView => ({
  at: AT, from: AT, basis: 'seen', plan: { items: [], more: 0 }, documents: { items: [], more: 0 }, knowledge: { items: [], more: 0 }, empty: false,
  commits: [{ repo: 'api', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'Write it', at: AT }] }], problems: [],
} as unknown as WhatsNewView);
const byId = (nodes: BoardNode[], id: string) => nodes.find((node) => node.id === id)!;

describe('isMovable', () => {
  it('is a card, and only a card', () => {
    expect(isMovable({ id: uuid(1) })).toBe(true);
    expect(isMovable({ id: uuid(2) })).toBe(true);
  });

  it('is not a checkpoint, a document or a commit: the app places those itself, in their group and order', () => {
    for (const id of ['checkpoint:reports-export-to-csv', 'checkpoint:same#2', `document:${uuid(7)}`, 'commit:billing api:a91f2e0c4d5b']) {
      expect(isMovable({ id }), id).toBe(false);
    }
  });

  it('is not a lane, the placeholder, the plan\'s own frame or anything the board cannot keep a place for', () => {
    for (const id of ['lane:documents', 'lane:commits:api', 'lane:board', 'placeholder:commits', 'plan:own', 'document:export-requirements', 'commit:api:xyz', '', 'constructor']) {
      expect(isMovable({ id }), id).toBe(false);
    }
  });
});

describe('withMoves', () => {
  const nodes = boardLayout({
    now: Date.parse(AT),
    plan: plan([checkpoint('One'), checkpoint('Two')], { steps: [{ key: 'loose', text: 'Loose', done: false }] }),
    documents: [doc(uuid(50), 'Brief')],
    news: news(),
    board: boardOf({ cards: [note(1), note(2)], positions: { [uuid(1)]: { x: 700, y: 900 }, 'commit:api:a91f2e0': { x: 2000, y: 0 } } }),
    // Everything open, so there is a node for each thing the board draws.
    folds: { 'plan:own': true, 'checkpoint:one': true, 'lane:documents': true, 'lane:commits:api': true },
  });
  const moved = withMoves(nodes, 'moving-help');

  it('makes the cards draggable, in the band or not, and a stop for the keyboard that says how to move it', () => {
    for (const id of [uuid(1), uuid(2)]) expect(byId(moved, id), id).toMatchObject({ draggable: true, focusable: true });
    expect(byId(moved, uuid(1)).parentId).toBeUndefined();
    expect(byId(moved, uuid(2)).parentId).toBe('lane:board');
    // Named for what it is; how to move it is the description, one element for all of them.
    expect(byId(moved, uuid(1)).ariaLabel).toBe('Note 1');
    expect(byId(moved, uuid(1)).domAttributes).toEqual({ 'aria-describedby': 'moving-help' });
    expect(MOVE_HELP).toMatch(/Shift and an arrow key/);
  });

  it('leaves everything else as the layout made it: checkpoints, documents, commits, the lanes and the plan\'s own frame are not dragged or focused', () => {
    const rest = ['plan:own', 'checkpoint:one', 'checkpoint:two', `document:${uuid(50)}`, 'commit:api:a91f2e0c4d5b', 'lane:documents', 'lane:commits:api', 'lane:board'];
    for (const id of rest) {
      expect(byId(moved, id), id).toMatchObject({ draggable: false });
      expect(byId(moved, id).focusable, id).toBeUndefined();
      expect(byId(moved, id).ariaLabel, id).toBeUndefined();
      expect(byId(moved, id).domAttributes, id).toBeUndefined();
    }
    for (const node of moved) expect(node).toMatchObject({ selectable: false, connectable: false, deletable: false });
  });

  it('tells every node the size it has, so the lines keep their anchors when a node changes', () => {
    for (const node of moved) expect(node.measured, node.id).toEqual({ width: node.width, height: node.height });
  });

  it('does not change the nodes it was given', () => {
    expect(nodes.every((node) => node.draggable === false && node.measured === undefined)).toBe(true);
  });
});

describe('canvasPlace', () => {
  const nodes = boardLayout({ now: Date.parse(AT), plan: plan([checkpoint('One')]), board: boardOf({ cards: [note(1), note(2)], positions: { [uuid(2)]: { x: 40, y: 50 } } }) });

  it('is the position itself for a node that stands on its own', () => {
    expect(canvasPlace(nodes, uuid(2), { x: 40, y: 50 })).toEqual({ x: 40, y: 50 });
    expect(canvasPlace(nodes, 'checkpoint:one', { x: 7, y: 8 })).toEqual({ x: 7, y: 8 });
    expect(canvasPlace(nodes, 'not-a-node', { x: 7, y: 8 })).toEqual({ x: 7, y: 8 });
  });

  it('adds the lane\'s place to the position in the lane for a node that stands in one', () => {
    const lane = byId(nodes, 'lane:board');
    const card = byId(nodes, uuid(1));
    expect(card.parentId).toBe('lane:board');
    expect(canvasPlace(nodes, uuid(1), card.position)).toEqual({ x: lane.position.x + card.position.x, y: lane.position.y + card.position.y });
    expect(canvasPlace(nodes, uuid(1), { x: 0, y: 0 })).toEqual(lane.position);
  });
});

describe('clearedPlace', () => {
  const sources = { now: Date.parse(AT), plan: plan([checkpoint('One', { done: true }), checkpoint('Two', { steps: [{ key: 'a', text: 'A', done: false }, { key: 'b', text: 'B', done: false }] })]), board: boardOf({ cards: [note(1), note(2)], positions: { [uuid(1)]: { x: 3000, y: 3000 }, [uuid(2)]: { x: 3000, y: 4000 } } }) };
  // One checkpoint is open (the work), the other folded: a card dropped on either lands clear of the group as it is when open.
  const nodes = withMoves(boardLayout(sources), 'help');
  const one = nodes.find((node) => node.id === 'checkpoint:one')!;
  const two = nodes.find((node) => node.id === 'checkpoint:two')!;
  const openHeight = (node: BoardNode) => (node as { data: { openHeight: number } }).data.openHeight;

  it('puts a card dropped on an open group just below it, as a whole number, and the same place again when asked again', () => {
    const at = clearedPlace(nodes, uuid(1), { x: two.position.x + 40.4, y: 30 });
    expect(at).toEqual({ x: Math.round(two.position.x + 40.4), y: openHeight(two) + 12 });
    expect(clearedPlace(nodes, uuid(1), at)).toEqual(at);
  });

  it('puts a card dropped under a folded summary below the group as it is when open, not just below its summary', () => {
    expect(one.height).toBeLessThan(openHeight(one));
    expect(clearedPlace(nodes, uuid(1), { x: one.position.x + 5, y: (one.height ?? 0) + 4 })).toEqual({ x: one.position.x + 5, y: openHeight(one) + 12 });
  });

  it('leaves a place that is clear where it is, and a node it does not know as it was asked', () => {
    expect(clearedPlace(nodes, uuid(1), { x: 5000, y: -400 })).toEqual({ x: 5000, y: -400 });
    expect(clearedPlace(nodes, uuid(99), { x: two.position.x, y: 10 })).toEqual({ x: two.position.x, y: 10 });
  });
});

describe('placeHeld', () => {
  const nodes = withMoves(boardLayout({ now: Date.parse(AT), board: boardOf({ cards: [note(1), note(2)], positions: { [uuid(1)]: { x: 10, y: 20 }, [uuid(2)]: { x: 30, y: 40 } } }) }), 'help');

  it('is the same list when nothing is held', () => {
    expect(placeHeld(nodes, {})).toBe(nodes);
  });

  it('draws only the held node where it is held, in front, and keeps every other node as it was', () => {
    const shown = placeHeld(nodes, { [uuid(1)]: { x: 111, y: 222 } });
    expect(byId(shown, uuid(1)).position).toEqual({ x: 111, y: 222 });
    expect(byId(shown, uuid(1)).zIndex).toBeGreaterThan(20);
    expect(byId(shown, uuid(2))).toBe(byId(nodes, uuid(2)));
    expect(byId(nodes, uuid(1)).position).toEqual({ x: 10, y: 20 });
  });

  it('draws a node of a lane where it is held on the canvas, by the position in its lane that puts it there', () => {
    const inLane = withMoves(boardLayout({ now: Date.parse(AT), plan: plan([checkpoint('One')]), board: boardOf({ cards: [note(1)] }) }), 'help');
    const lane = byId(inLane, 'lane:board');
    expect(byId(inLane, uuid(1)).parentId).toBe('lane:board');
    const shown = placeHeld(inLane, { [uuid(1)]: { x: lane.position.x + 500, y: lane.position.y - 80 } });
    expect(byId(shown, uuid(1)).position).toEqual({ x: 500, y: -80 });
    expect(byId(shown, uuid(1)).parentId).toBe('lane:board');
    expect(byId(shown, 'lane:board')).toBe(lane);
  });
});

describe('placeOf', () => {
  it('keeps whole numbers', () => {
    expect(placeOf({ x: 10.4, y: -3.5 })).toEqual({ x: 10, y: -3 });
    expect(placeOf({ x: 1060.6, y: 0.2 })).toEqual({ x: 1061, y: 0 });
  });

  it('stays inside the limits of the board file, and takes a number that is not one for the corner', () => {
    expect(placeOf({ x: 5_000_000, y: -5_000_000 })).toEqual({ x: 1_000_000, y: -1_000_000 });
    expect(placeOf({ x: Number.NaN, y: Infinity })).toEqual({ x: 0, y: 0 });
  });
});

describe('moveChange and undoChange', () => {
  it('moves one node to a place, as the backend takes a move', () => {
    expect(moveChange(uuid(1), { x: 120, y: -40 })).toEqual({ op: 'move', nodes: [{ id: uuid(1), x: 120, y: -40 }] });
    expect(moveChange('checkpoint:one', { x: 0, y: 0 })).toEqual({ op: 'move', nodes: [{ id: 'checkpoint:one', x: 0, y: 0 }] });
  });

  it('forgets a place with null for x and y', () => {
    expect(moveChange(uuid(1), null)).toEqual({ op: 'move', nodes: [{ id: uuid(1), x: null, y: null }] });
  });

  it('undoes a move by putting the node back at its saved place, or by forgetting the place when it had none', () => {
    expect(undoChange(uuid(1), { x: 5, y: 6 })).toEqual({ op: 'move', nodes: [{ id: uuid(1), x: 5, y: 6 }] });
    expect(undoChange(uuid(1), undefined)).toEqual({ op: 'move', nodes: [{ id: uuid(1), x: null, y: null }] });
  });

  it('names no revision: a place does not depend on the rest of the board', () => {
    expect(JSON.stringify({ changes: [moveChange(uuid(1), { x: 1, y: 2 })] })).not.toContain('revision');
  });
});

describe('withPlace and samePlace', () => {
  const board = boardOf({ revision: 3, positions: { [uuid(1)]: { x: 1, y: 2 } } });

  it('sets a place, replaces one and forgets one, without changing the board it was given', () => {
    expect(withPlace(board, uuid(2), { x: 9, y: 9 }).positions).toEqual({ [uuid(1)]: { x: 1, y: 2 }, [uuid(2)]: { x: 9, y: 9 } });
    expect(withPlace(board, uuid(1), { x: 7, y: 8 }).positions).toEqual({ [uuid(1)]: { x: 7, y: 8 } });
    expect(withPlace(board, uuid(1), null).positions).toEqual({});
    expect(withPlace(board, uuid(2), null).positions).toEqual({ [uuid(1)]: { x: 1, y: 2 } });
    expect(withPlace(board, uuid(2), { x: 9, y: 9 }).revision).toBe(3);
    expect(board.positions).toEqual({ [uuid(1)]: { x: 1, y: 2 } });
  });

  it('compares places, and no place with no place', () => {
    expect(samePlace({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(samePlace({ x: 1, y: 2 }, { x: 1, y: 3 })).toBe(false);
    expect(samePlace({ x: 1, y: 2 }, undefined)).toBe(false);
    expect(samePlace(undefined, null)).toBe(true);
  });
});

describe('moveProblem', () => {
  it('uses the first sentence of what the backend said, in lower case after the colon', () => {
    const archived = new ApiError('Workspace "demo" is archived, so it cannot change the board. Its record stays readable; unarchive it (ctxspace unarchive demo) to work in it again.', 409);
    expect(moveProblem(archived)).toBe('Could not save the place: workspace "demo" is archived, so it cannot change the board');
    expect(moveProblem(new ApiError('Workspace not found.', 404))).toBe('Could not save the place: workspace not found');
    expect(moveProblem(new ApiError('Change 1, nodes.0.x: Must be a finite number.', 400))).toBe('Could not save the place: change 1, nodes.0.x: Must be a finite number');
  });

  it('leaves a first word that is not a plain word as it is', () => {
    expect(moveProblem(new ApiError('EACCES is not what this is', 400))).toBe('Could not save the place: EACCES is not what this is');
  });

  it('does not show an id, which says nothing to a person', () => {
    expect(moveProblem(new ApiError(`Change 1: there is no card ${uuid(7)} on the board.`, 400))).toBe('Could not save the place: that card is no longer on the board');
  });

  it('does not repeat words that are long, or that come from a server that failed', () => {
    expect(moveProblem(new ApiError(`${'The board is very very busy '.repeat(5)}.`, 409))).toBe('Could not save the place: the server refused it');
    expect(moveProblem(new ApiError("EACCES: permission denied, open '/home/anna/contextspace-board.json'", 500))).toBe('Could not save the place: something went wrong on the server');
    expect(moveProblem(new ApiError('', 400))).toBe('Could not save the place: the server refused it');
  });

  it('says the app could not be reached for an error that is not the backend\'s answer', () => {
    expect(moveProblem(new TypeError('Failed to fetch'))).toBe('Could not save the place: the app could not be reached');
    expect(moveProblem('x')).toBe('Could not save the place: the app could not be reached');
  });
});

describe('nudged', () => {
  const from = { x: 100, y: 200 };

  it('moves one step with an arrow key', () => {
    expect(NUDGE_STEP).toBe(24);
    expect(nudged(from, 'ArrowRight')).toEqual({ x: 124, y: 200 });
    expect(nudged(from, 'ArrowLeft')).toEqual({ x: 76, y: 200 });
    expect(nudged(from, 'ArrowUp')).toEqual({ x: 100, y: 176 });
    expect(nudged(from, 'ArrowDown')).toEqual({ x: 100, y: 224 });
    expect(nudged(from, 'ArrowDown', 10)).toEqual({ x: 100, y: 210 });
  });

  it('is nothing for any other key, however it is spelt', () => {
    for (const key of ['a', 'Enter', 'Shift', '+', 'constructor', 'toString', '']) expect(nudged(from, key), key).toBeNull();
  });
});

describe('revealed', () => {
  const size = { width: 1000, height: 600 };
  const view = { x: 0, y: 0, zoom: 1 };

  it('leaves the view alone when the rect is whole inside it', () => {
    expect(revealed({ x: 10, y: 10, width: 200, height: 100 }, view, size)).toBeNull();
    expect(revealed({ x: 800, y: 500, width: 200, height: 100 }, view, size)).toBeNull();
  });

  it('moves the view just far enough, with a little room from the edge', () => {
    expect(revealed({ x: 900, y: 100, width: 200, height: 100 }, view, size, 20)).toEqual({ x: -120, y: 0, zoom: 1 });
    expect(revealed({ x: -50, y: 100, width: 200, height: 100 }, view, size, 20)).toEqual({ x: 70, y: 0, zoom: 1 });
    expect(revealed({ x: 100, y: 550, width: 200, height: 100 }, view, size, 20)).toEqual({ x: 0, y: -70, zoom: 1 });
    expect(revealed({ x: 100, y: -80, width: 200, height: 100 }, view, size, 20)).toEqual({ x: 0, y: 100, zoom: 1 });
  });

  it('counts in screen pixels, so the zoom and the pan are taken into account', () => {
    // At half size, a rect at x 1800 is at 900 + 100 on the screen, past the right edge.
    expect(revealed({ x: 1800, y: 0, width: 200, height: 100 }, { x: 100, y: 0, zoom: 0.5 }, size, 20)).toEqual({ x: -20, y: 0, zoom: 0.5 });
    expect(revealed({ x: 1000, y: 0, width: 200, height: 100 }, { x: -400, y: 0, zoom: 0.5 }, size, 20)).toBeNull();
  });

  it('lines a rect that is bigger than the view up at its top left corner', () => {
    expect(revealed({ x: 300, y: 400, width: 2000, height: 1000 }, view, size, 20)).toEqual({ x: -280, y: -380, zoom: 1 });
  });

  it('moves along one axis only when only that one is out', () => {
    expect(revealed({ x: 10, y: 500, width: 100, height: 150 }, view, size, 20)?.x).toBe(0);
  });
});

describe('moveNodeWith', () => {
  const KEY = boardKey('demo');
  const ID = uuid(1);
  const OLD = { x: 10, y: 20 };
  const NEW = { x: 300, y: 400 };
  const reply = (revision: number, positions: BoardView['positions']) => ({ ...boardOf({ revision, positions }), results: [{}] });
  let queryClient: QueryClient;
  let invalidated: unknown[];
  const cached = () => queryClient.getQueryData<BoardView>(KEY);
  /** A POST that is answered by hand. */
  const held = () => {
    const answer: { ok: (value: unknown) => void; fail: (error: unknown) => void } = { ok: () => {}, fail: () => {} };
    post.mockImplementationOnce(() => new Promise((resolve, reject) => { answer.ok = resolve; answer.fail = reject; }));
    return answer;
  };

  beforeEach(() => {
    queryClient = new QueryClient();
    invalidated = [];
    vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async (filters) => { invalidated.push(filters?.queryKey); });
    post.mockReset();
    queryClient.setQueryData(KEY, boardOf({ revision: 4, positions: { [ID]: OLD } }));
  });

  it('changes the board you see before it asks, and sends the one move with no revision', async () => {
    const answer = held();
    const moving = moveNodeWith(queryClient, 'demo', ID, NEW);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(cached()?.positions[ID]).toEqual(NEW);
    const [path, init] = post.mock.calls[0]!;
    expect(path).toBe('/api/workspace/demo/board/changes');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ changes: [{ op: 'move', nodes: [{ id: ID, x: 300, y: 400 }] }] });
    answer.ok(reply(5, { [ID]: NEW }));
    // What the node had, for Undo.
    await expect(moving).resolves.toEqual(OLD);
  });

  it('takes the board of the reply, which has the move in it', async () => {
    const answer = held();
    const moving = moveNodeWith(queryClient, 'demo', ID, NEW);
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    answer.ok(reply(5, { [ID]: NEW, [uuid(2)]: { x: 1, y: 1 } }));
    await moving;
    expect(cached()).toEqual(boardOf({ revision: 5, positions: { [ID]: NEW, [uuid(2)]: { x: 1, y: 1 } } }));
  });

  it('keeps a board that was read meanwhile and is newer than the reply', async () => {
    const answer = held();
    const moving = moveNodeWith(queryClient, 'demo', ID, NEW);
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    const newer = boardOf({ revision: 9, positions: { [ID]: NEW, [uuid(3)]: { x: 5, y: 5 } } });
    queryClient.setQueryData(KEY, newer);
    answer.ok(reply(5, { [ID]: NEW }));
    await moving;
    expect(cached()).toEqual(newer);
    // The same revision is the same board: the reply is taken.
    const answerAgain = held();
    const again = moveNodeWith(queryClient, 'demo', ID, OLD);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    answerAgain.ok(reply(9, { [ID]: OLD }));
    await again;
    expect(cached()?.positions).toEqual({ [ID]: OLD });
  });

  it('reads the board again, and does not fail, when the reply is not a board', async () => {
    post.mockResolvedValueOnce({ hello: 'an older backend' });
    await expect(moveNodeWith(queryClient, 'demo', ID, NEW)).resolves.toEqual(OLD);
    expect(invalidated).toEqual([KEY]);
    expect(cached()?.positions[ID]).toEqual(NEW);
  });

  it('puts the place back when the move is refused, and asks for the board again', async () => {
    const answer = held();
    const moving = moveNodeWith(queryClient, 'demo', ID, NEW);
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    const refused = new ApiError('The board is busy.', 409);
    answer.fail(refused);
    await expect(moving).rejects.toBe(refused);
    expect(cached()).toEqual(boardOf({ revision: 4, positions: { [ID]: OLD } }));
    // A read that was cancelled for the move may have been asked for by an AI's change, and no event follows a failed move.
    expect(invalidated).toEqual([KEY]);
  });

  it('forgets a place that the node did not have before, when its first move is refused', async () => {
    const other = uuid(2);
    post.mockRejectedValueOnce(new ApiError('Nope.', 400));
    await expect(moveNodeWith(queryClient, 'demo', other, NEW)).rejects.toThrow('Nope.');
    expect(cached()?.positions).toEqual({ [ID]: OLD });
  });

  it('does not put back a place over one that a read brought meanwhile', async () => {
    const answer = held();
    const moving = moveNodeWith(queryClient, 'demo', ID, NEW);
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    const theirs = { x: 777, y: 888 };
    queryClient.setQueryData(KEY, boardOf({ revision: 6, positions: { [ID]: theirs } }));
    answer.fail(new ApiError('The board is busy.', 409));
    await expect(moving).rejects.toThrow();
    expect(cached()?.positions[ID]).toEqual(theirs);
    expect(invalidated).toEqual([KEY]);
  });

  it('forgets a place the same way, and puts it back when that is refused', async () => {
    post.mockResolvedValueOnce(reply(5, {}));
    await expect(moveNodeWith(queryClient, 'demo', ID, null)).resolves.toEqual(OLD);
    expect(JSON.parse(post.mock.calls[0]![1]!.body as string)).toEqual({ changes: [{ op: 'move', nodes: [{ id: ID, x: null, y: null }] }] });
    expect(cached()?.positions).toEqual({});

    queryClient.setQueryData(KEY, boardOf({ revision: 5, positions: { [ID]: OLD } }));
    post.mockRejectedValueOnce(new ApiError('Nope.', 400));
    await expect(moveNodeWith(queryClient, 'demo', ID, null)).rejects.toThrow();
    expect(cached()?.positions).toEqual({ [ID]: OLD });
  });

  it('cancels a read that is out, so it cannot bring the old place back over the new one, but not when there is no board yet', async () => {
    const cancel = vi.spyOn(queryClient, 'cancelQueries');
    post.mockResolvedValue(reply(5, { [ID]: NEW }));
    await moveNodeWith(queryClient, 'demo', ID, NEW);
    expect(cancel).toHaveBeenCalledTimes(1);

    cancel.mockClear();
    queryClient.removeQueries({ queryKey: KEY });
    await moveNodeWith(queryClient, 'demo', ID, NEW);
    expect(cancel).not.toHaveBeenCalled();
    // The board is not made up from the move: what comes back is the board.
    expect(cached()).toEqual(boardOf({ revision: 5, positions: { [ID]: NEW } }));
  });

  it('leaves the board that is not there alone when the move is refused', async () => {
    queryClient.removeQueries({ queryKey: KEY });
    post.mockRejectedValueOnce(new ApiError('Nope.', 400));
    await expect(moveNodeWith(queryClient, 'demo', ID, NEW)).rejects.toThrow();
    expect(cached()).toBeUndefined();
  });
});
