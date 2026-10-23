import { describe, expect, it } from 'vitest';
import type { WorkDocument } from '../../types.js';
import type { PlanFileCheckpoint, PlanFileDecision, PlanFileView } from '../plan/planFile.js';
import type { NewsRepo, WhatsNewView } from '../plan/whatsNew.js';
import type { BoardCard, BoardLink, BoardView } from './boardData.js';
import {
  BOARD_LIMITS, BOARD_SIZE, FRESH_MS, authorName, boardEdges, boardLayout, fileTypeOf, imageAlt, isFresh, moreText, nodeRects, nodeResolver, sidesBetween,
  type BoardNode, type CheckpointNode, type CommitNode, type DocumentNode, type FileNode, type LaneNode, type NoteNode, type PlaceholderNode,
} from './boardLayout.js';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const slug = (words: string) => words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const step = (text: string, done = false) => ({ key: slug(text), text, done });
const decision = (question: string, fields: Partial<PlanFileDecision> = {}): PlanFileDecision => ({ key: slug(question), question, done: false, suggested: [], ...fields });
const checkpoint = (title: string, fields: Partial<PlanFileCheckpoint> = {}): PlanFileCheckpoint => ({ key: slug(title), title, done: false, steps: [], decisions: [], ...fields });

/** A plan as the app reads it; the decisions that wait are worked out the way core/plan-file does. */
const plan = (checkpoints: PlanFileCheckpoint[], fields: Partial<PlanFileView> = {}): PlanFileView => ({
  file: 'PLAN.md', source: 'file', title: 'Plan', intro: '', sections: [], steps: [], decisions: [], changes: [], checkpoints,
  waiting: [...checkpoints.filter((entry) => !entry.done).flatMap((entry) => entry.decisions), ...(fields.decisions ?? [])].filter((entry) => !entry.done).map((entry) => entry.key),
  ...fields,
});

const doc = (title: string, fields: Partial<WorkDocument> = {}): WorkDocument => ({
  id: slug(title), title, role: 'design', status: 'approved', scope: {}, summary: `About ${title}`, createdAt: minutesAgo(600), updatedAt: minutesAgo(300), ...fields,
});

const commit = (sha: string, minutes: number, subject = `Change ${sha}`) => ({ sha, author: 'Anna', subject, at: minutesAgo(minutes) });
const repo = (name: string, commits: NewsRepo['commits'], fields: Partial<NewsRepo> = {}): NewsRepo => ({ repo: name, commits, more: 0, ...fields });
const news = (commits: NewsRepo[], fields: Partial<WhatsNewView> = {}): WhatsNewView => {
  const none = { items: [], more: 0 };
  return { reader: 'user', at: minutesAgo(0), from: minutesAgo(120), basis: 'last-look', plan: none, documents: none, knowledge: none, commits, problems: [], empty: false, ...fields };
};

const ofType = <T extends BoardNode>(nodes: BoardNode[], type: T['type']) => nodes.filter((node): node is T => node.type === type);
const lanes = (nodes: BoardNode[]) => ofType<LaneNode>(nodes, 'lane');
const frames = (nodes: BoardNode[]) => ofType<CheckpointNode>(nodes, 'checkpoint');
const documents = (nodes: BoardNode[]) => ofType<DocumentNode>(nodes, 'document');
const commits = (nodes: BoardNode[]) => ofType<CommitNode>(nodes, 'commit');
const placeholders = (nodes: BoardNode[]) => ofType<PlaceholderNode>(nodes, 'placeholder');

describe('boardLayout columns', () => {
  const nodes = boardLayout({
    plan: plan([checkpoint('Read the plan'), checkpoint('Draw the board'), checkpoint('Ship it')]),
    documents: [doc('Design brief')],
    news: news([repo('api', [commit('a1b2c3d4e5', 5)]), repo('web', [commit('b2c3d4e5f6', 9)])]),
  });

  it('puts documents on the left, the checkpoints in plan order, and one commits lane per repository on the right', () => {
    const [documentsLane] = lanes(nodes).filter((lane) => lane.data.title === 'Documents');
    const commitLanes = lanes(nodes).filter((lane) => lane.data.title !== 'Documents');
    const columns = [documentsLane, ...frames(nodes), ...commitLanes];
    expect(columns.map((node) => node.data.title)).toEqual(['Documents', 'Read the plan', 'Draw the board', 'Ship it', 'api', 'web']);
    // Left to right, with room between: no column overlaps the next.
    const xs = columns.map((node) => node.position.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    columns.slice(0, -1).forEach((node, index) => expect(node.position.x + node.width!).toBeLessThan(columns[index + 1].position.x));
    // They all start at the top.
    expect(new Set(columns.map((node) => node.position.y))).toEqual(new Set([0]));
  });

  it('is the same board for the same input', () => {
    const again = boardLayout({
      plan: plan([checkpoint('Read the plan'), checkpoint('Draw the board'), checkpoint('Ship it')]),
      documents: [doc('Design brief')],
      news: news([repo('api', [commit('a1b2c3d4e5', 5)]), repo('web', [commit('b2c3d4e5f6', 9)])]),
    });
    expect(again).toEqual(nodes);
  });

  it('lists a lane before its cards, and gives every node its own id', () => {
    const ids = nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const node of nodes) if (node.parentId) expect(ids.indexOf(node.parentId)).toBeLessThan(ids.indexOf(node.id));
  });

  it('leaves out a part that is not there, and shifts the rest left', () => {
    const onlyPlan = boardLayout({ plan: plan([checkpoint('Read the plan')]) });
    expect(onlyPlan.map((node) => node.type)).toEqual(['checkpoint']);
    expect(onlyPlan[0].position).toEqual({ x: 0, y: 0 });
    expect(boardLayout({ documents: [doc('Design brief')] }).map((node) => node.type)).toEqual(['lane', 'document']);
  });

  it('keeps two checkpoints with one title apart', () => {
    const twins = boardLayout({ plan: plan([checkpoint('Same'), checkpoint('Same')]) });
    expect(new Set(twins.map((node) => node.id)).size).toBe(2);
  });

  it('lets nothing be moved, linked or picked', () => {
    for (const node of nodes) {
      expect(node.draggable).toBe(false);
      expect(node.connectable).toBe(false);
      expect(node.selectable).toBe(false);
    }
  });
});

describe('checkpoint frames', () => {
  it('say whether a checkpoint is done and how far its steps are', () => {
    const [done, open] = frames(boardLayout({ plan: plan([
      checkpoint('Finished', { done: true, steps: [step('One', true), step('Two', true)] }),
      checkpoint('Started', { steps: [step('One', true), step('Two'), step('Three')] }),
    ]) }));
    expect(done.data).toMatchObject({ title: 'Finished', done: true, stepsDone: 2, stepsTotal: 2 });
    expect(open.data).toMatchObject({ title: 'Started', done: false, stepsDone: 1, stepsTotal: 3 });
    expect(open.data.steps.map((entry) => [entry.text, entry.done])).toEqual([['One', true], ['Two', false], ['Three', false]]);
  });

  it(`show at most ${BOARD_LIMITS.steps} steps, in plan order, and count the rest`, () => {
    const steps = Array.from({ length: 10 }, (_, index) => step(`Step ${index + 1}`, index < 2));
    const [frame] = frames(boardLayout({ plan: plan([checkpoint('Big', { steps })]) }));
    expect(frame.data.steps.map((entry) => entry.text)).toEqual(['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5', 'Step 6']);
    expect(frame.data.moreSteps).toBe(4);
    // The count is of every step, not only the ones drawn.
    expect(frame.data).toMatchObject({ stepsDone: 2, stepsTotal: 10 });
  });

  it('show no extra count when the steps fit', () => {
    const steps = Array.from({ length: BOARD_LIMITS.steps }, (_, index) => step(`Step ${index + 1}`));
    const [frame] = frames(boardLayout({ plan: plan([checkpoint('Exactly', { steps })]) }));
    expect(frame.data.steps).toHaveLength(BOARD_LIMITS.steps);
    expect(frame.data.moreSteps).toBe(0);
  });

  it('grow with what they show, so a long checkpoint is taller than a short one', () => {
    const [short, long] = frames(boardLayout({ plan: plan([
      checkpoint('Short', { steps: [step('One')] }),
      checkpoint('Long', { steps: Array.from({ length: 9 }, (_, index) => step(`Step ${index}`)) }),
    ]) }));
    expect(long.height!).toBeGreaterThan(short.height!);
  });

  it('flag the decisions that wait for the user, and only those', () => {
    const waiting = decision('Which cache key?');
    const answered = decision('Which store?', { done: true, answer: 'Redis' });
    const [frame, quiet] = frames(boardLayout({ plan: plan([
      checkpoint('Cache', { decisions: [waiting, answered] }),
      checkpoint('Docs'),
    ]) }));
    expect(frame.data.waiting).toEqual([{ key: waiting.key, question: 'Which cache key?' }]);
    expect(quiet.data.waiting).toEqual([]);
  });

  it('follow the plan for what waits: a decision it does not list as waiting is not flagged', () => {
    const held = decision('Held up by the plan');
    const [frame] = frames(boardLayout({ plan: plan([checkpoint('Cache', { decisions: [held] })], { waiting: [] }) }));
    expect(frame.data.waiting).toEqual([]);
  });

  it(`show at most ${BOARD_LIMITS.waiting} waiting decisions and count the rest`, () => {
    const decisions = Array.from({ length: 5 }, (_, index) => decision(`Question ${index + 1}?`));
    const [frame] = frames(boardLayout({ plan: plan([checkpoint('Many questions', { decisions })]) }));
    expect(frame.data.waiting).toHaveLength(BOARD_LIMITS.waiting);
    expect(frame.data.moreWaiting).toBe(2);
  });

  it('are a frame, not an empty box, for a checkpoint without steps', () => {
    const [frame] = frames(boardLayout({ plan: plan([checkpoint('Nothing yet')]) }));
    expect(frame.data).toMatchObject({ stepsTotal: 0, steps: [], moreSteps: 0 });
    expect(frame.height).toBeGreaterThan(0);
  });
});

describe('the plan frame', () => {
  it('holds the plan\'s own steps and the decisions that wait, ahead of the checkpoints', () => {
    const own = decision('Which framework?');
    const nodes = boardLayout({ plan: plan([checkpoint('First'), checkpoint('Second')], { steps: [step('Tidy the old script'), step('Rename the module', true)], decisions: [own] }), documents: [doc('Brief')] });
    expect(frames(nodes).map((frame) => [frame.data.kind, frame.data.title])).toEqual([['plan', 'Plan'], ['checkpoint', 'First'], ['checkpoint', 'Second']]);
    const [loose, first] = frames(nodes);
    expect(loose.data).toMatchObject({ done: false, stepsDone: 1, stepsTotal: 2 });
    expect(loose.data.steps.map((entry) => entry.text)).toEqual(['Tidy the old script', 'Rename the module']);
    expect(loose.data.waiting).toEqual([{ key: own.key, question: 'Which framework?' }]);
    // The documents stay on the left, and the plan frame is the first column after them.
    expect(lanes(nodes)[0].position.x).toBeLessThan(loose.position.x);
    expect(loose.position.x).toBeLessThan(first.position.x);
  });

  it('is there for a plan with only loose steps, so such a plan is not an empty board', () => {
    const nodes = boardLayout({ plan: plan([], { steps: [step('Write it down')] }) });
    expect(frames(nodes)).toHaveLength(1);
    expect(frames(nodes)[0].position.x).toBe(0);
  });

  it('is there for a decision that waits even without steps, and not for one already answered', () => {
    expect(frames(boardLayout({ plan: plan([], { decisions: [decision('Which one?')] }) }))).toHaveLength(1);
    expect(boardLayout({ plan: plan([], { decisions: [decision('Which one?', { done: true, answer: 'This one' })] }) })).toEqual([]);
  });

  it('is left out when the plan has nothing of its own', () => {
    expect(frames(boardLayout({ plan: plan([checkpoint('Only')]) })).map((frame) => frame.data.kind)).toEqual(['checkpoint']);
  });

  it('keeps the same caps as a checkpoint', () => {
    const steps = Array.from({ length: 9 }, (_, index) => step(`Loose step ${index + 1}`));
    const decisions = Array.from({ length: 5 }, (_, index) => decision(`Loose question ${index + 1}?`));
    const [frame] = frames(boardLayout({ plan: plan([], { steps, decisions }) }));
    expect(frame.data.steps).toHaveLength(BOARD_LIMITS.steps);
    expect(frame.data.moreSteps).toBe(3);
    expect(frame.data.waiting).toHaveLength(BOARD_LIMITS.waiting);
    expect(frame.data.moreWaiting).toBe(2);
  });

  it('follows the plan for what waits, like a checkpoint', () => {
    const held = decision('Held up by the plan');
    expect(frames(boardLayout({ plan: plan([], { steps: [step('A step')], decisions: [held], waiting: [] }) }))[0].data.waiting).toEqual([]);
  });
});

describe('document cards', () => {
  const nodes = boardLayout({ documents: [
    doc('Requirements', { role: 'requirements', status: 'approved', summary: 'What it must do.' }),
    doc('Old design', { status: 'superseded', summary: 'Replaced.' }),
    doc('Notes', { role: 'reference', status: 'draft', summary: '' }),
  ] });

  it('show the title, role, status and summary of each, in a Documents lane they belong to', () => {
    const [lane] = lanes(nodes);
    expect(lane.data.title).toBe('Documents');
    expect(documents(nodes).map((card) => card.parentId)).toEqual([lane.id, lane.id, lane.id]);
    expect(documents(nodes).map((card) => card.data)).toEqual([
      expect.objectContaining({ title: 'Requirements', role: 'requirements', status: 'approved', summary: 'What it must do.' }),
      expect.objectContaining({ title: 'Old design', status: 'superseded', summary: 'Replaced.' }),
      expect.objectContaining({ title: 'Notes', role: 'reference', status: 'draft' }),
    ]);
  });

  it('dim a superseded document, and still say it is superseded', () => {
    expect(documents(nodes).map((card) => [card.data.title, card.data.dimmed])).toEqual([['Requirements', false], ['Old design', true], ['Notes', false]]);
    expect(documents(nodes)[1].data.status).toBe('superseded');
  });

  it('stack inside their lane without overlapping', () => {
    const [lane] = lanes(nodes);
    const cards = documents(nodes);
    cards.forEach((card, index) => {
      expect(card.position.y).toBeGreaterThanOrEqual(0);
      expect(card.position.y + card.height!).toBeLessThanOrEqual(lane.height!);
      if (index) expect(card.position.y).toBeGreaterThanOrEqual(cards[index - 1].position.y + cards[index - 1].height!);
    });
  });
});

describe('commit cards', () => {
  it('make one lane per repository, titled with its name, and keep each commit in its own repository lane', () => {
    const nodes = boardLayout({ news: news([
      repo('api', [commit('a1b2c3d4e5f6', 5), commit('b2c3d4e5f6a7', 10)]),
      repo('web', [commit('c3d4e5f6a7b8', 7)]),
    ]) });
    const [api, web] = lanes(nodes);
    expect([api.data.title, web.data.title]).toEqual(['api', 'web']);
    const byLane = (lane: LaneNode) => commits(nodes).filter((card) => card.parentId === lane.id).map((card) => card.data.sha);
    expect(byLane(api)).toEqual(['a1b2c3d', 'b2c3d4e']);
    expect(byLane(web)).toEqual(['c3d4e5f']);
  });

  it('show a 7-character sha, the subject, the author and when', () => {
    const [card] = commits(boardLayout({ news: news([repo('api', [{ sha: 'a1b2c3d4e5f6a7b8', author: 'Ben', subject: 'Cache invoice lookups', at: minutesAgo(3) }])]) }));
    expect(card.data).toEqual({ sha: 'a1b2c3d', subject: 'Cache invoice lookups', author: 'Ben', at: minutesAgo(3) });
  });

  it(`keep the ${BOARD_LIMITS.commits} newest commits of a repository and count the rest, however they came in`, () => {
    // Twenty commits, listed oldest to newest here: the newest twelve are the ones that stay, newest first.
    const many = Array.from({ length: 20 }, (_, index) => commit(`${(index + 1).toString(16).padStart(7, '0')}`, 200 - index * 10));
    const nodes = boardLayout({ news: news([repo('api', many, { more: 5 })]) });
    const cards = commits(nodes);
    expect(cards).toHaveLength(BOARD_LIMITS.commits);
    expect(cards.map((card) => card.data.sha)).toEqual(many.slice(-BOARD_LIMITS.commits).reverse().map((entry) => entry.sha));
    // The eight cut here, and the five the list itself left out.
    expect(lanes(nodes)[0].data.more).toBe(13);
  });

  it('cap each repository on its own', () => {
    const many = (prefix: string) => Array.from({ length: 15 }, (_, index) => commit(`${prefix}${index.toString(16).padStart(6, '0')}`, index + 1));
    const nodes = boardLayout({ news: news([repo('api', many('a')), repo('web', many('b'))]) });
    const [api, web] = lanes(nodes);
    expect(commits(nodes).filter((card) => card.parentId === api.id)).toHaveLength(BOARD_LIMITS.commits);
    expect(commits(nodes).filter((card) => card.parentId === web.id)).toHaveLength(BOARD_LIMITS.commits);
    expect([api.data.more, web.data.more]).toEqual([3, 3]);
  });

  it('say when the count of what is left out is only a lower bound', () => {
    const [lane] = lanes(boardLayout({ news: news([repo('api', [commit('a1b2c3d', 1)], { more: 90, moreAtLeast: true })]) }));
    expect(lane.data).toMatchObject({ more: 90, moreAtLeast: true });
  });

  it('skip a repository with nothing new, and say why one could not be read', () => {
    const nodes = boardLayout({ news: news([
      repo('quiet', []),
      repo('gone', [], { problem: 'The folder is missing.' }),
      repo('busy', [commit('a1b2c3d', 1)]),
    ]) });
    expect(lanes(nodes).map((lane) => lane.data.title)).toEqual(['gone', 'busy']);
    expect(lanes(nodes)[0].data.note).toContain('The folder is missing.');
    expect(commits(nodes).map((card) => card.parentId)).toEqual([lanes(nodes)[1].id]);
  });

  it('put a commit with no readable time after the ones that have one', () => {
    const cards = commits(boardLayout({ news: news([repo('api', [commit('a1b2c3d', 1), { ...commit('b2c3d4e', 1), at: 'sometime' }, commit('c3d4e5f', 2)])]) }));
    expect(cards.map((card) => card.data.sha)).toEqual(['a1b2c3d', 'c3d4e5f', 'b2c3d4e']);
  });
});

describe('what the commit lanes say they are', () => {
  it('say the commits are the new ones since the last look', () => {
    const nodes = boardLayout({ news: news([repo('api', [commit('a1b2c3d', 1)]), repo('web', [commit('b2c3d4e', 2)])]) });
    expect(lanes(nodes).map((lane) => lane.data.caption)).toEqual(['New since you last looked', 'New since you last looked']);
  });

  it('say how many days a first look reaches back', () => {
    const first = { basis: 'first-look' as const, at: '2026-10-22T12:00:00.000Z', from: '2026-10-19T12:00:00.000Z' };
    expect(lanes(boardLayout({ news: news([repo('api', [commit('a1b2c3d', 1)])], first) }))[0].data.caption).toBe('From the last 3 days');
    expect(lanes(boardLayout({ news: news([repo('api', [commit('a1b2c3d', 1)])], { ...first, from: '2026-10-21T12:00:00.000Z' }) }))[0].data.caption).toBe('From the last 1 day');
  });
});

describe('a board with no new commits', () => {
  it('says so in one placeholder card in a Commits lane, in place of a lane per repository', () => {
    const nodes = boardLayout({ plan: plan([checkpoint('Build it')]), news: news([repo('api', []), repo('web', [])]) });
    expect(lanes(nodes).map((lane) => [lane.data.title, lane.data.caption])).toEqual([['Commits', 'New since you last looked']]);
    expect(placeholders(nodes)).toHaveLength(1);
    expect(placeholders(nodes)[0].data.text).toBe('No new commits since you last looked.');
    expect(placeholders(nodes)[0].parentId).toBe(lanes(nodes)[0].id);
    expect(commits(nodes)).toEqual([]);
    // It stands on the right, after the checkpoints.
    expect(lanes(nodes)[0].position.x).toBeGreaterThan(frames(nodes)[0].position.x);
  });

  it('says it the way a first look reads', () => {
    const nodes = boardLayout({ documents: [doc('Brief')], news: news([], { basis: 'first-look', at: '2026-10-22T12:00:00.000Z', from: '2026-10-19T12:00:00.000Z' }) });
    expect(placeholders(nodes)[0].data.text).toBe('No commits in the last 3 days.');
    expect(lanes(nodes).map((lane) => lane.data.caption)).toEqual(['Source documents', 'From the last 3 days']);
  });

  it('stands for a workspace with no repositories too', () => {
    expect(placeholders(boardLayout({ documents: [doc('Brief')], news: news([]) }))).toHaveLength(1);
  });

  it('is not there when a repository has commits, or while the commits have not loaded', () => {
    expect(placeholders(boardLayout({ documents: [doc('Brief')], news: news([repo('api', [commit('a1b2c3d', 1)]), repo('web', [])]) }))).toEqual([]);
    expect(placeholders(boardLayout({ documents: [doc('Brief')] }))).toEqual([]);
  });

  it('never makes a board of its own: with nothing else to show the board stays empty', () => {
    expect(boardLayout({ news: news([]) })).toEqual([]);
    expect(boardLayout({ plan: plan([]), documents: [], news: news([repo('api', [])]) })).toEqual([]);
  });

  it('is left out when no repository could be read, so it never contradicts the lane that says one could not', () => {
    const nodes = boardLayout({ plan: plan([checkpoint('Build it')]), news: news([repo('gone', [], { problem: 'The folder is missing.' }), repo('also gone', [], { problem: 'No permission.' })]) });
    expect(lanes(nodes).map((lane) => lane.data.title)).toEqual(['gone', 'also gone']);
    expect(placeholders(nodes)).toEqual([]);
    expect(boardLayout({ news: news([repo('gone', [], { problem: 'The folder is missing.' })]) }).map((node) => node.type)).toEqual(['lane']);
  });

  it('says it of the other repositories when one could not be read and the rest have nothing new', () => {
    const nodes = boardLayout({ news: news([repo('gone', [], { problem: 'The folder is missing.' }), repo('api', [])]) });
    expect(lanes(nodes).map((lane) => lane.data.title)).toEqual(['Commits', 'gone']);
    expect(placeholders(nodes).map((node) => node.data.text)).toEqual(['No new commits in the other repositories since you last looked.']);
    const first = { basis: 'first-look' as const, at: '2026-10-22T12:00:00.000Z', from: '2026-10-19T12:00:00.000Z' };
    expect(placeholders(boardLayout({ news: news([repo('gone', [], { problem: 'x' }), repo('api', [])], first) }))[0].data.text).toBe('No commits in the other repositories in the last 3 days.');
  });
});

describe('moreText', () => {
  it('reads as plain counts, and marks a lower bound', () => {
    expect(moreText(4)).toBe('+4 more');
    expect(moreText(90, true)).toBe('90+ more');
    expect(moreText(90, false)).toBe('+90 more');
  });
});

describe('an empty board', () => {
  it('has no nodes when there is nothing to show', () => {
    expect(boardLayout({})).toEqual([]);
    expect(boardLayout({ plan: plan([]), documents: [], news: news([]) })).toEqual([]);
    expect(boardLayout({ plan: plan([]), documents: [], news: news([repo('api', [])]) })).toEqual([]);
  });
});


// ─── What people and AIs put on the board ───────────────────────────────────

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uuidOf = uuid;
const note = (n: number, fields: Partial<BoardCard> = {}): BoardCard => ({
  id: uuid(n), kind: 'note', title: `Note ${n}`, body: `About ${n}.`, pinned: false, archived: false,
  by: 'claude', at: minutesAgo(600 - n), updatedBy: 'claude', updatedAt: minutesAgo(600 - n), ...fields,
} as BoardCard);
const fileCard = (n: number, path: string, fields: Partial<BoardCard> = {}): BoardCard => ({
  id: uuid(n), kind: 'file', title: `File ${n}`, path, description: `The file ${n}.`, pinned: false, archived: false,
  by: 'claude', at: minutesAgo(600 - n), updatedBy: 'claude', updatedAt: minutesAgo(600 - n), ...fields,
} as BoardCard);
const link = (n: number, from: string, to: string, label?: string): BoardLink => ({ id: uuid(900 + n), from, to, ...(label ? { label } : {}), by: 'claude', at: minutesAgo(10) });
const boardOf = (fields: Partial<BoardView> = {}): BoardView => ({ revision: 1, cards: [], links: [], positions: {}, ...fields });
const notes = (nodes: BoardNode[]) => ofType<NoteNode>(nodes, 'note');
const files = (nodes: BoardNode[]) => ofType<FileNode>(nodes, 'file');
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('cards from the board', () => {
  it('draw a note with its title, text, author and times, and a file card with its path and kind', () => {
    const nodes = boardLayout({ now: NOW, board: boardOf({ cards: [note(1, { body: 'Seen in the CSV writer.', by: 'claude' }), fileCard(2, 'docs/overview.html', { description: 'Start with the diagram.' })] }) });
    expect(notes(nodes)[0].data).toMatchObject({ title: 'Note 1', text: 'Seen in the CSV writer.', by: 'claude', pinned: false, archived: false });
    expect(files(nodes)[0].data).toMatchObject({ title: 'File 2', text: 'Start with the diagram.', path: 'docs/overview.html', fileType: 'html' });
  });

  it('put the cards that have no place in a "From the board" band under the checkpoints, oldest first, a pinned one among the rest', () => {
    const nodes = boardLayout({
      now: NOW, plan: plan([checkpoint('Build it'), checkpoint('Ship it')]), documents: [doc('Brief')], news: news([repo('api', [commit('a1b2c3d4e5', 5)])]),
      board: boardOf({ cards: [note(1), note(2), note(3, { pinned: true }), note(4)] }),
    });
    const band = lanes(nodes).find((entry) => entry.id === 'lane:board')!;
    expect(band.data.title).toBe('From the board');
    const inBand = [...notes(nodes), ...files(nodes)].filter((card) => card.parentId === band.id);
    expect(inBand.map((card) => card.data.title)).toEqual(['Note 1', 'Note 2', 'Note 3', 'Note 4']);
    expect(inBand.find((card) => card.data.title === 'Note 3')!.data.pinned).toBe(true);
    // It spans the columns of the checkpoints, starts under the tallest frame, and no column beside it reaches into it.
    const row = frames(nodes);
    expect(band.position.x).toBe(row[0].position.x);
    expect(band.width).toBe(2 * BOARD_SIZE.column + BOARD_SIZE.columnGap);
    expect(band.position.y).toBeGreaterThanOrEqual(Math.max(...row.map((frame) => frame.height!)));
    const rects = nodeRects(nodes);
    for (const other of nodes.filter((node) => node.type === 'lane' && node.id !== band.id)) expect(overlaps(rects.get(other.id)!, rects.get(band.id)!), other.id).toBe(false);
    for (const frame of row) expect(overlaps(rects.get(frame.id)!, rects.get(band.id)!), frame.id).toBe(false);
  });

  it('fill the band in rows, one card under each checkpoint, and keep every card inside it', () => {
    const nodes = boardLayout({ now: NOW, plan: plan([checkpoint('One'), checkpoint('Two')]), board: boardOf({ cards: [note(1), fileCard(2, 'a.png'), note(3)] }) });
    const band = lanes(nodes).find((entry) => entry.id === 'lane:board')!;
    const [first, second, third] = [...notes(nodes), ...files(nodes)].filter((card) => card.parentId === band.id)
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    expect([first.data.title, second.data.title, third.data.title]).toEqual(['Note 1', 'File 2', 'Note 3']);
    // The first row is under the two checkpoints, the next starts under the taller card of the one before.
    expect([first.position.x, second.position.x]).toEqual([BOARD_SIZE.pad, BOARD_SIZE.pad + BOARD_SIZE.column + BOARD_SIZE.columnGap]);
    expect(first.position.y).toBe(second.position.y);
    expect(third.position).toEqual({ x: BOARD_SIZE.pad, y: first.position.y + BOARD_SIZE.file + BOARD_SIZE.gap });
    const rects = nodeRects(nodes);
    for (const card of [first, second, third]) {
      const rect = rects.get(card.id)!;
      expect(rect.x).toBeGreaterThanOrEqual(band.position.x);
      expect(rect.x + rect.width).toBeLessThanOrEqual(band.position.x + band.width!);
      expect(rect.y + rect.height).toBeLessThanOrEqual(band.position.y + band.height!);
    }
  });

  it('start under the checkpoint the work is on, oldest first, and go on to the right of it and round to the first', () => {
    const nodes = boardLayout({
      now: NOW, plan: plan([checkpoint('Done', { done: true }), checkpoint('Under way'), checkpoint('Later')]),
      board: boardOf({ cards: [note(1), note(2), note(3), note(4)] }),
    });
    const column = (index: number) => BOARD_SIZE.pad + index * (BOARD_SIZE.column + BOARD_SIZE.columnGap);
    const at = (title: string) => notes(nodes).find((card) => card.data.title === title)!.position;
    expect(at('Note 1')).toMatchObject({ x: column(1) });
    expect(at('Note 2')).toMatchObject({ x: column(2) });
    expect(at('Note 3')).toMatchObject({ x: column(0) });
    expect(at('Note 1').y).toBe(at('Note 3').y);
    expect(at('Note 4')).toMatchObject({ x: column(1), y: at('Note 1').y + BOARD_SIZE.note + BOARD_SIZE.gap });
    for (const card of notes(nodes)) expect(card.parentId).toBe('lane:board');
  });

  it('give a new card the next free place, and leave the cards already there where they are', () => {
    const sources = { now: NOW, plan: plan([checkpoint('One', { done: true }), checkpoint('Two'), checkpoint('Three')]) };
    const placesOf = (cards: BoardCard[]) => new Map(notes(boardLayout({ ...sources, board: boardOf({ cards }) })).map((card) => [card.id, card.position]));
    const before = placesOf([note(1), note(2), note(3), note(4)]);
    const after = placesOf([note(1), note(2), note(3), note(4), note(5, { at: minutesAgo(0) })]);
    for (const [id, position] of before) expect(after.get(id), id).toEqual(position);
    // The new one is the next in line: the second column's place in the second row (the row starts under the checkpoint under way).
    expect(after.get(uuidOf(5))).toEqual({ x: BOARD_SIZE.pad + 2 * (BOARD_SIZE.column + BOARD_SIZE.columnGap), y: before.get(uuidOf(4))!.y });
    // A card made earlier than the others comes first, whatever order the list is in.
    const early = placesOf([note(2), note(1, { at: minutesAgo(900) })]);
    expect(early.get(uuidOf(1))!.x).toBeLessThan(early.get(uuidOf(2))!.x);
  });

  it('move the band to the next checkpoint, as one block in the same order, when the work moves on, and keep its top', () => {
    const cards = [note(1), note(2), note(3), note(4)];
    const asked = [decision('Which format?'), decision('Which zone?')];
    const sources = (doneCount: number) => ({
      now: NOW, board: boardOf({ cards }),
      plan: plan([checkpoint('One', { done: doneCount > 0, decisions: asked }), checkpoint('Two', { done: doneCount > 1 }), checkpoint('Three')]),
    });
    const [open, ticked] = [boardLayout(sources(0)), boardLayout(sources(1))];
    const slotOf = (nodes: BoardNode[], title: string) => notes(nodes).find((card) => card.data.title === title)!.position;
    const column = (index: number) => BOARD_SIZE.pad + index * (BOARD_SIZE.column + BOARD_SIZE.columnGap);
    // Under the first checkpoint, then under the second: every card one column on, round to the first, rows unchanged.
    expect(notes(open).map((card) => [card.data.title, card.position.x, card.position.y]).sort())
      .toEqual([['Note 1', column(0), slotOf(open, 'Note 1').y], ['Note 2', column(1), slotOf(open, 'Note 1').y], ['Note 3', column(2), slotOf(open, 'Note 1').y], ['Note 4', column(0), slotOf(open, 'Note 4').y]]);
    expect(['Note 1', 'Note 2', 'Note 3', 'Note 4'].map((title) => slotOf(ticked, title).x)).toEqual([column(1), column(2), column(0), column(1)]);
    for (const title of ['Note 1', 'Note 2', 'Note 3', 'Note 4']) expect(slotOf(ticked, title).y).toBe(slotOf(open, title).y);
    // The top does not move, though the frame that had decisions waiting is shorter now, and it stands clear of every frame.
    const band = (nodes: BoardNode[]) => lanes(nodes).find((entry) => entry.id === 'lane:board')!;
    expect(band(ticked).position).toEqual(band(open).position);
    expect(frames(ticked)[0].height).toBeLessThan(frames(open)[0].height!);
    expect(frames(open)[0].data.waiting).toHaveLength(2);
    for (const frame of frames(open)) expect(frame.position.y + frame.height!).toBeLessThanOrEqual(band(open).position.y);
  });

  it('are a column of their own, after the last one, when there is no checkpoint to stand under', () => {
    const nodes = boardLayout({ now: NOW, documents: [doc('Brief')], news: news([repo('api', [commit('a1b2c3d4e5', 5)])]), board: boardOf({ cards: [note(1), note(2)] }) });
    const band = lanes(nodes).find((entry) => entry.id === 'lane:board')!;
    expect(band).toMatchObject({ position: { x: 2 * (BOARD_SIZE.column + BOARD_SIZE.columnGap), y: 0 }, width: BOARD_SIZE.column });
    expect(notes(nodes).map((card) => card.position.x)).toEqual([BOARD_SIZE.pad, BOARD_SIZE.pad]);
  });

  it('do not move the columns that are already drawn when a card arrives', () => {
    const sources = { now: NOW, plan: plan([checkpoint('Build it')]), documents: [doc('Brief')], news: news([repo('api', [commit('a1b2c3d4e5', 5)])]) };
    const before = boardLayout(sources);
    const after = boardLayout({ ...sources, board: boardOf({ cards: [note(1)] }) });
    for (const node of before) expect(after.find((entry) => entry.id === node.id)).toEqual(node);
  });

  it('are the whole board when nothing else is there', () => {
    const nodes = boardLayout({ now: NOW, board: boardOf({ cards: [note(1)] }) });
    expect(lanes(nodes).map((entry) => [entry.position.x, entry.position.y])).toEqual([[0, 0]]);
    expect(notes(nodes)).toHaveLength(1);
    expect(boardLayout({ now: NOW, board: boardOf() })).toEqual([]);
  });

  it('size a note and a file card by what they show, the same for every card', () => {
    const nodes = boardLayout({ now: NOW, board: boardOf({ cards: [note(1), note(2), fileCard(3, 'a.png')] }) });
    expect(notes(nodes).map((card) => [card.width, card.height])).toEqual([[BOARD_SIZE.card, BOARD_SIZE.note], [BOARD_SIZE.card, BOARD_SIZE.note]]);
    expect(files(nodes).map((card) => [card.width, card.height])).toEqual([[BOARD_SIZE.card, BOARD_SIZE.file]]);
  });

  it('stay out of the way: the board lane is read-only like the rest', () => {
    for (const node of boardLayout({ now: NOW, board: boardOf({ cards: [note(1), note(2)], positions: { [uuid(2)]: { x: 5, y: 5 } } }) })) {
      expect(node.draggable).toBe(false);
      expect(node.selectable).toBe(false);
    }
  });
});

describe('archived cards', () => {
  const cards = [note(1), note(2, { archived: true }), fileCard(3, 'a.png', { archived: true })];

  it('are left out until they are asked for', () => {
    const nodes = boardLayout({ now: NOW, board: boardOf({ cards }) });
    expect(notes(nodes).map((card) => card.data.title)).toEqual(['Note 1']);
    expect(files(nodes)).toEqual([]);
  });

  it('are drawn, marked archived and not new, when asked for', () => {
    const nodes = boardLayout({ now: NOW, showArchived: true, board: boardOf({ cards: [note(1), note(2, { archived: true, updatedAt: minutesAgo(0) })] }) });
    expect(notes(nodes).map((card) => [card.data.title, card.data.archived, card.data.fresh])).toEqual([['Note 1', false, false], ['Note 2', true, false]]);
    expect(notes(nodes)).toHaveLength(2);
  });

  it('take their place and their lines with them while they are hidden', () => {
    const board = boardOf({ cards, positions: { [uuid(2)]: { x: 40, y: 40 } }, links: [link(1, uuid(1), uuid(2))] });
    const hidden = boardLayout({ now: NOW, board });
    expect(hidden.some((node) => node.id === uuid(2))).toBe(false);
    expect(boardEdges(hidden, board.links)).toEqual([]);
    const shown = boardLayout({ now: NOW, showArchived: true, board });
    expect(nodeRects(shown).get(uuid(2))).toMatchObject({ x: 40, y: 40 });
    expect(boardEdges(shown, board.links)).toHaveLength(1);
  });
});

describe('saved places', () => {
  it('put a card where it was left, whatever the lane would have done', () => {
    const nodes = boardLayout({ now: NOW, board: boardOf({ cards: [note(1), note(2)], positions: { [uuid(2)]: { x: 700, y: -120 } } }) });
    const placed = notes(nodes).find((card) => card.id === uuid(2))!;
    expect(placed.parentId).toBeUndefined();
    expect(placed.position).toEqual({ x: 700, y: -120 });
    // The other one is in the lane, which has closed up around the gap.
    const stays = notes(nodes).find((card) => card.id === uuid(1))!;
    expect(stays.parentId).toBe('lane:board');
    expect(lanes(nodes).find((entry) => entry.id === 'lane:board')!.height).toBe(BOARD_SIZE.laneHeader + BOARD_SIZE.note + BOARD_SIZE.gap);
  });

  it('leave no lane when every card has a place', () => {
    const nodes = boardLayout({ now: NOW, board: boardOf({ cards: [note(1)], positions: { [uuid(1)]: { x: 0, y: 0 } } }) });
    expect(lanes(nodes)).toEqual([]);
  });

  it('override the automatic place of a checkpoint, and the rest of the row closes up around it', () => {
    const base = boardLayout({ plan: plan([checkpoint('One'), checkpoint('Two'), checkpoint('Three')]) });
    const moved = boardLayout({ plan: plan([checkpoint('One'), checkpoint('Two'), checkpoint('Three')]), board: boardOf({ positions: { 'checkpoint:two': { x: 500, y: 300 } } }) });
    const by = (nodes: BoardNode[], title: string) => frames(nodes).find((entry) => entry.data.title === title)!;
    expect(by(moved, 'Two').position).toEqual({ x: 500, y: 300 });
    expect(by(moved, 'One').position).toEqual(by(base, 'One').position);
    expect(by(moved, 'Three').position.x).toBe(by(base, 'Two').position.x);
  });

  it('take a document or a commit out of its lane and stand it at its place', () => {
    const briefId = `document:${slug('Brief')}`;
    const nodes = boardLayout({
      documents: [doc('Brief'), doc('Other')], news: news([repo('api', [commit('a1b2c3d4e5', 5), commit('b2c3d4e5f6', 9)])]),
      board: boardOf({ positions: { [briefId]: { x: 900, y: 10 }, 'commit:api:b2c3d4e5f6': { x: 910, y: 400 } } }),
    });
    const brief = documents(nodes).find((card) => card.id === briefId)!;
    expect(brief.parentId).toBeUndefined();
    expect(brief.position).toEqual({ x: 900, y: 10 });
    expect(documents(nodes).filter((card) => card.parentId).map((card) => card.data.title)).toEqual(['Other']);
    expect(commits(nodes).filter((card) => !card.parentId).map((card) => card.position)).toEqual([{ x: 910, y: 400 }]);
    // The cards that stayed are stacked from the top of their lane again.
    expect(documents(nodes).find((card) => card.parentId)!.position.y).toBe(BOARD_SIZE.laneHeader);
    expect(nodeRects(nodes).get(briefId)).toMatchObject({ x: 900, y: 10 });
  });

  it('drop a lane whose cards were all put elsewhere, unless it has something to say', () => {
    const only = boardLayout({ documents: [doc('Brief')], board: boardOf({ positions: { [`document:${slug('Brief')}`]: { x: 1, y: 2 } } }) });
    expect(lanes(only)).toEqual([]);
    const withMore = boardLayout({ news: news([repo('api', [commit('a1b2c3d4e5', 5)], { more: 4 })]), board: boardOf({ positions: { 'commit:api:a1b2c3d4e5': { x: 1, y: 2 } } }) });
    expect(lanes(withMore).map((entry) => [entry.data.title, entry.data.more])).toEqual([['api', 4]]);
  });

  it('find a commit by a hash that begins the one the board knows, or that it begins', () => {
    const sources = { news: news([repo('api', [commit('a1b2c3d4e5f6a7b8', 5)])]) };
    for (const key of ['commit:api:a1b2c3d', 'commit:api:a1b2c3d4e5f6a7b8', 'commit:api:a1b2c3d4e5f6a7b8c9d0e1f2']) {
      const [card] = commits(boardLayout({ ...sources, board: boardOf({ positions: { [key]: { x: 5, y: 6 } } }) }));
      expect(card.position, key).toEqual({ x: 5, y: 6 });
      expect(card.parentId, key).toBeUndefined();
    }
    for (const key of ['commit:api:a1b2c3e', 'commit:web:a1b2c3d', 'commit:api:a1b2c3d#2']) {
      expect(commits(boardLayout({ ...sources, board: boardOf({ positions: { [key]: { x: 5, y: 6 } } }) }))[0].parentId, key).toBeDefined();
    }
  });

  it('prefer the place written with the exact id over one found by prefix', () => {
    const [card] = commits(boardLayout({
      news: news([repo('api', [commit('a1b2c3d4e5f6', 5)])]),
      board: boardOf({ positions: { 'commit:api:a1b2c3d': { x: 1, y: 1 }, 'commit:api:a1b2c3d4e5f6': { x: 2, y: 2 } } }),
    }));
    expect(card.position).toEqual({ x: 2, y: 2 });
  });

  it('ignore a place for something that is not on the board, silently', () => {
    const base = boardLayout({ plan: plan([checkpoint('One')]), documents: [doc('Brief')] });
    const nodes = boardLayout({
      plan: plan([checkpoint('One')]), documents: [doc('Brief')],
      board: boardOf({ positions: { 'checkpoint:gone': { x: 1, y: 1 }, 'commit:api:deadbeef': { x: 2, y: 2 }, [uuid(77)]: { x: 3, y: 3 } } }),
    });
    expect(nodes).toEqual(base);
  });

  it('keep the plan frame where it is: it has no id the board knows', () => {
    const nodes = boardLayout({ plan: plan([], { steps: [step('A loose step')] }), board: boardOf({ positions: { 'plan:own': { x: 9, y: 9 } } }) });
    expect(frames(nodes)[0].position).toEqual({ x: 0, y: 0 });
  });

  it('keep cards that were placed apart from the cards in the lane: nothing overlaps unless it was put there', () => {
    const cards = Array.from({ length: 6 }, (_, index) => note(index + 1));
    const nodes = boardLayout({ now: NOW, plan: plan([checkpoint('One'), checkpoint('Two')]), documents: [doc('Brief')], board: boardOf({ cards, positions: { [uuid(2)]: { x: 2000, y: 0 } } }) });
    const rects = nodeRects(nodes);
    const drawn = nodes.filter((node) => node.type !== 'lane' || node.id === 'lane:board');
    const children = drawn.filter((node) => node.parentId);
    for (const a of children) for (const b of children) if (a.id < b.id) expect(overlaps(rects.get(a.id)!, rects.get(b.id)!), `${a.id} / ${b.id}`).toBe(false);
  });
});

describe('what is new', () => {
  it('is a card made or changed in the last minute by someone other than the user', () => {
    const mine = { updatedBy: 'user', updatedAt: new Date(NOW).toISOString() };
    expect(isFresh({ updatedBy: 'claude', updatedAt: new Date(NOW - 5_000).toISOString() }, NOW)).toBe(true);
    expect(isFresh({ updatedBy: 'claude', updatedAt: new Date(NOW - FRESH_MS - 1).toISOString() }, NOW)).toBe(false);
    expect(isFresh(mine, NOW)).toBe(false);
    expect(isFresh({ updatedBy: 'claude', updatedAt: 'not a time' }, NOW)).toBe(false);
  });

  it('marks the cards of the layout, by when each was last changed', () => {
    const nodes = boardLayout({ now: NOW, board: boardOf({ cards: [
      note(1, { at: minutesAgo(30), updatedAt: minutesAgo(0), updatedBy: 'codex' }),
      note(2, { at: minutesAgo(30), updatedAt: minutesAgo(30) }),
      note(3, { by: 'user', updatedBy: 'user', updatedAt: minutesAgo(0) }),
    ] }) });
    expect(notes(nodes).map((card) => [card.data.title, card.data.fresh]).sort()).toEqual([['Note 1', true], ['Note 2', false], ['Note 3', false]]);
  });
});

describe('words on the cards', () => {
  it('say "you" for the user and the tool\'s name for an AI', () => {
    expect(authorName('user')).toBe('you');
    expect(authorName('claude')).toBe('claude');
  });

  it('tell a picture from the kinds of file that open in Docs', () => {
    expect(['a.png', 'b/c.JPG', 'd.jpeg', 'e.gif', 'f.webp'].map(fileTypeOf)).toEqual(['image', 'image', 'image', 'image', 'image']);
    expect(['a.html', 'a.htm', 'a.pdf', 'README.md', 'a.markdown', 'a.svg', 'deck.pptx', 'notes.txt', 'png'].map(fileTypeOf)).toEqual(['html', 'html', 'pdf', 'markdown', 'markdown', 'other', 'other', 'other', 'other']);
  });

  it('name a picture by its title, or by its description when the title is only the file name', () => {
    expect(imageAlt({ title: 'Export flow', description: 'Boxes and arrows.', path: 'docs/flow.png' })).toBe('Export flow');
    expect(imageAlt({ title: 'flow.png', description: 'Boxes\nand   arrows.', path: 'docs/flow.png' })).toBe('Boxes and arrows.');
    expect(imageAlt({ title: 'flow.png', description: '  ', path: 'docs/flow.png' })).toBe('flow.png');
    expect(imageAlt({ title: 'flow.png', description: 'x'.repeat(500), path: 'flow.png' })).toHaveLength(160);
  });
});

describe('lines between things', () => {
  const sources = {
    now: NOW, plan: plan([checkpoint('Build it'), checkpoint('Ship it')]), documents: [doc('Brief')], news: news([repo('api', [commit('a1b2c3d4e5f6', 5)])]),
    board: boardOf({ cards: [note(1), note(2)] }),
  };
  const nodes = boardLayout(sources);

  it('join cards to cards, checkpoints, documents and commits', () => {
    const links = [link(1, uuid(1), 'checkpoint:build-it', 'found while'), link(2, uuid(2), `document:${slug('Brief')}`), link(3, uuid(1), uuid(2)), link(4, 'checkpoint:ship-it', 'commit:api:a1b2c3d')];
    const edges = boardEdges(nodes, links);
    expect(edges.map((edge) => [edge.id, edge.source, edge.target])).toEqual([
      [uuid(901), uuid(1), 'checkpoint:build-it'], [uuid(902), uuid(2), `document:${slug('Brief')}`], [uuid(903), uuid(1), uuid(2)], [uuid(904), 'checkpoint:ship-it', 'commit:api:a1b2c3d4e5f6'],
    ]);
    expect(edges[0].label).toBe('found while');
    expect(edges[1].label).toBeUndefined();
  });

  it('are named for someone who cannot see them, by what they join, not by ids', () => {
    const [edge] = boardEdges(nodes, [link(1, uuid(1), 'checkpoint:build-it', 'found while')]);
    expect(edge.ariaLabel).toBe('Link from Note 1 to Build it: found while');
    expect(boardEdges(nodes, [link(2, uuid(1), 'commit:api:a1b2c3d')])[0].ariaLabel).toBe('Link from Note 1 to commit a1b2c3d');
    expect(edge).toMatchObject({ focusable: false, selectable: false, deletable: false });
  });

  it('skip a line to something that is not on the board, without a word', () => {
    const links = [
      link(1, uuid(1), 'checkpoint:renamed'), link(2, 'commit:api:deadbeef', uuid(1)), link(3, uuid(99), uuid(1)), link(4, uuid(1), 'document:00000000-0000-4000-8000-0000000000aa'),
      link(5, uuid(1), uuid(1)), link(6, uuid(1), 'checkpoint:build-it'),
    ];
    expect(boardEdges(nodes, links).map((edge) => edge.id)).toEqual([uuid(906)]);
    expect(boardEdges(nodes, [])).toEqual([]);
  });

  it('find a commit by prefix, whichever of the two is shorter', () => {
    const longer = boardLayout({ ...sources, news: news([repo('api', [commit('a1b2c3d4e5f6a7b8c9d0', 5)])]) });
    expect(boardEdges(longer, [link(1, uuid(1), 'commit:api:a1b2c3d4e5')])[0].target).toBe('commit:api:a1b2c3d4e5f6a7b8c9d0');
    const shorter = boardLayout({ ...sources, news: news([repo('api', [commit('a1b2c3d', 5)])]) });
    expect(boardEdges(shorter, [link(1, uuid(1), 'commit:api:a1b2c3d4e5f6')])[0].target).toBe('commit:api:a1b2c3d');
    // Not another repository, and not another hash.
    expect(boardEdges(nodes, [link(1, uuid(1), 'commit:web:a1b2c3d'), link(2, uuid(1), 'commit:api:b1b2c3d')])).toEqual([]);
  });

  it('leave and enter by the sides that face each other', () => {
    const edges = boardEdges(nodes, [link(1, 'checkpoint:build-it', 'checkpoint:ship-it'), link(2, 'checkpoint:ship-it', 'checkpoint:build-it'), link(3, uuid(1), 'checkpoint:build-it')]);
    // The cards stand under the checkpoints, so a card's line to a checkpoint above it leaves the top.
    expect(edges.map((edge) => [edge.sourceHandle, edge.targetHandle])).toEqual([['right', 'left'], ['left', 'right'], ['top', 'bottom']]);
  });

  it('chooses sides by the larger gap', () => {
    const box = (x: number, y: number) => ({ x, y, width: 100, height: 50 });
    expect(sidesBetween(box(0, 0), box(300, 0))).toEqual(['right', 'left']);
    expect(sidesBetween(box(300, 0), box(0, 0))).toEqual(['left', 'right']);
    expect(sidesBetween(box(0, 0), box(20, 300))).toEqual(['bottom', 'top']);
    expect(sidesBetween(box(20, 300), box(0, 0))).toEqual(['top', 'bottom']);
  });

  it('follow a card that was moved', () => {
    const moved = boardLayout({ ...sources, board: boardOf({ cards: [note(1), note(2)], positions: { [uuid(1)]: { x: -900, y: 0 } } }) });
    expect(boardEdges(moved, [link(1, uuid(1), 'checkpoint:build-it')])[0]).toMatchObject({ sourceHandle: 'right', targetHandle: 'left' });
  });
});

describe('nodeResolver', () => {
  const resolve = nodeResolver(['checkpoint:a', 'commit:billing api:abcdef0123456789', 'commit:x:y:1234567#2', uuid(1)]);

  it('finds the same id, and for a commit a hash that begins the other', () => {
    expect(resolve('checkpoint:a')).toBe('checkpoint:a');
    expect(resolve(uuid(1))).toBe(uuid(1));
    expect(resolve('commit:billing api:abcdef0')).toBe('commit:billing api:abcdef0123456789');
    expect(resolve('commit:billing api:abcdef0123456789ffff')).toBe('commit:billing api:abcdef0123456789');
  });

  it('keeps repositories with a colon in the name and the copy number apart', () => {
    expect(resolve('commit:x:y:1234567abc#2')).toBe('commit:x:y:1234567#2');
    expect(resolve('commit:x:y:1234567abc')).toBeUndefined();
    expect(resolve('commit:billing:abcdef0')).toBeUndefined();
  });

  it('finds nothing for what is not there, or too short to be a hash', () => {
    expect(resolve('checkpoint:b')).toBeUndefined();
    expect(resolve('commit:billing api:abcdef')).toBeUndefined();
    expect(resolve('commit:billing api:abcdeff')).toBeUndefined();
    expect(resolve('')).toBeUndefined();
  });
});
