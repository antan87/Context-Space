import { describe, expect, it } from 'vitest';
import type { WorkDocument } from '../../types.js';
import type { PlanFileCheckpoint, PlanFileDecision, PlanFileView } from '../plan/planFile.js';
import type { NewsRepo, WhatsNewView } from '../plan/whatsNew.js';
import type { BoardCard, BoardLink, BoardView } from './boardData.js';
import {
  BOARD_LIMITS, BOARD_SIZE, FRESH_MS, authorName, boardEdges, boardLayout, clearPlace, fileTypeOf, imageAlt, isFolded, isFresh, isGroup, moreText, nodeRects, nodeResolver, sidesBetween,
  type BoardNode, type BoardSources, type CheckpointNode, type CommitNode, type DocumentNode, type FileNode, type LaneNode, type NoteNode, type PlaceholderNode,
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
/** The board with every group open: for the specs about what is in a group. By default only the work under way is open. */
const open = (sources: BoardSources) => boardLayout({ ...sources, folds: Object.fromEntries(boardLayout(sources).filter(isGroup).map((node) => [node.id, true])) });

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
    expect(open({ documents: [doc('Design brief')] }).map((node) => node.type)).toEqual(['lane', 'document']);
  });

  it('keeps two checkpoints with one title apart', () => {
    const twins = boardLayout({ plan: plan([checkpoint('Same'), checkpoint('Same')]) });
    expect(new Set(twins.map((node) => node.id)).size).toBe(2);
  });

  it('marks nothing as draggable, linkable or pickable itself: what may be moved is for the board moves to say', () => {
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
    const [short, long] = frames(open({ plan: plan([
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
  const nodes = open({ documents: [
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

  it('carry where the document is kept, or the link it stands for, so it can be opened; and nothing else for one with neither', () => {
    const kept = open({ documents: [
      doc('Kept', { filename: 'contextspace-document-1.md' }),
      doc('Linked', { url: 'https://example.com/spec' }),
      doc('Neither'),
    ] });
    const [first, second, third] = documents(kept).map((card) => card.data);
    expect(first).toMatchObject({ filename: 'contextspace-document-1.md', sourceId: 'kept' });
    expect(second).toMatchObject({ sourceId: 'linked' });
    expect(first).not.toHaveProperty('url');
    expect(second).toMatchObject({ url: 'https://example.com/spec' });
    expect(second).not.toHaveProperty('filename');
    expect(third).not.toHaveProperty('filename');
    expect(third).not.toHaveProperty('url');
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
    const nodes = open({ news: news([
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
    const [card] = commits(open({ news: news([repo('api', [{ sha: 'a1b2c3d4e5f6a7b8', author: 'Ben', subject: 'Cache invoice lookups', at: minutesAgo(3) }])]) }));
    expect(card.data).toEqual({ sha: 'a1b2c3d', subject: 'Cache invoice lookups', author: 'Ben', at: minutesAgo(3) });
  });

  it(`keep the ${BOARD_LIMITS.commits} newest commits of a repository and count the rest, however they came in`, () => {
    // Twenty commits, listed oldest to newest here: the newest twelve are the ones that stay, newest first.
    const many = Array.from({ length: 20 }, (_, index) => commit(`${(index + 1).toString(16).padStart(7, '0')}`, 200 - index * 10));
    const nodes = open({ news: news([repo('api', many, { more: 5 })]) });
    const cards = commits(nodes);
    expect(cards).toHaveLength(BOARD_LIMITS.commits);
    expect(cards.map((card) => card.data.sha)).toEqual(many.slice(-BOARD_LIMITS.commits).reverse().map((entry) => entry.sha));
    // The eight cut here, and the five the list itself left out.
    expect(lanes(nodes)[0].data.more).toBe(13);
  });

  it('cap each repository on its own', () => {
    const many = (prefix: string) => Array.from({ length: 15 }, (_, index) => commit(`${prefix}${index.toString(16).padStart(6, '0')}`, index + 1));
    const nodes = open({ news: news([repo('api', many('a')), repo('web', many('b'))]) });
    const [api, web] = lanes(nodes);
    expect(commits(nodes).filter((card) => card.parentId === api.id)).toHaveLength(BOARD_LIMITS.commits);
    expect(commits(nodes).filter((card) => card.parentId === web.id)).toHaveLength(BOARD_LIMITS.commits);
    expect([api.data.more, web.data.more]).toEqual([3, 3]);
  });

  it('say when the count of what is left out is only a lower bound', () => {
    const [lane] = lanes(open({ news: news([repo('api', [commit('a1b2c3d', 1)], { more: 90, moreAtLeast: true })]) }));
    expect(lane.data).toMatchObject({ more: 90, moreAtLeast: true });
  });

  it('skip a repository with nothing new, and say why one could not be read', () => {
    const nodes = open({ news: news([
      repo('quiet', []),
      repo('gone', [], { problem: 'The folder is missing.' }),
      repo('busy', [commit('a1b2c3d', 1)]),
    ]) });
    expect(lanes(nodes).map((lane) => lane.data.title)).toEqual(['gone', 'busy']);
    expect(lanes(nodes)[0].data.note).toContain('The folder is missing.');
    expect(commits(nodes).map((card) => card.parentId)).toEqual([lanes(nodes)[1].id]);
  });

  it('put a commit with no readable time after the ones that have one', () => {
    const cards = commits(open({ news: news([repo('api', [commit('a1b2c3d', 1), { ...commit('b2c3d4e', 1), at: 'sometime' }, commit('c3d4e5f', 2)])]) }));
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


describe('folded groups', () => {
  const sources = {
    now: NOW,
    plan: plan([
      checkpoint('Done one', { done: true, steps: [step('Query', true)] }),
      checkpoint('Under way', { steps: [step('Write', true), step('Test'), step('Ship')], decisions: [decision('Which key?')] }),
      checkpoint('Later', { steps: Array.from({ length: 9 }, (_, index) => step(`Later step ${index + 1}`)) }),
    ], { steps: [step('Tidy the script'), step('Rename the module', true)], decisions: [decision('Which framework?')] }),
    documents: [doc('Requirements'), doc('Rough notes', { status: 'draft' }), doc('Old design', { status: 'superseded' }), doc('Other draft', { status: 'draft' })],
    news: news([repo('api', [commit('a1b2c3d4e5', 5, 'Write the writer'), { ...commit('b2c3d4e5f6', 1, 'Fix the header'), author: 'Ben' }], { more: 3 }), repo('web', [commit('c3d4e5f6a7', 7)])]),
  };
  const groupIds = ['lane:documents', 'plan:own', 'checkpoint:done-one', 'checkpoint:under-way', 'checkpoint:later', 'lane:commits:api', 'lane:commits:web'];
  const groups = (nodes: BoardNode[]) => nodes.filter(isGroup);
  const by = (nodes: BoardNode[], id: string) => nodes.find((node) => node.id === id)!;

  it('open the work under way and fold every other group, whatever it holds', () => {
    const nodes = boardLayout(sources);
    expect(groups(nodes).map((node) => [node.id, !isFolded(node)])).toEqual(groupIds.map((id) => [id, id === 'checkpoint:under-way']));
    expect(frames(nodes).map((frame) => [frame.id, frame.data.open])).toEqual([['plan:own', false], ['checkpoint:done-one', false], ['checkpoint:under-way', true], ['checkpoint:later', false]]);
  });

  it('give a folded group one small fixed height, the same for every kind, so the columns line up', () => {
    const nodes = boardLayout(sources);
    for (const node of groups(nodes).filter(isFolded)) expect(node.height, node.id).toBe(BOARD_SIZE.folded);
    expect(by(nodes, 'checkpoint:under-way').height).toBeGreaterThan(BOARD_SIZE.folded);
    // However much it holds: nine steps fold to the same height as none.
    expect(by(nodes, 'checkpoint:later').height).toBe(by(nodes, 'checkpoint:done-one').height);
  });

  it('draw none of the cards of a folded lane, and all of them when it is open', () => {
    const folded = boardLayout(sources);
    expect(documents(folded)).toEqual([]);
    expect(commits(folded)).toEqual([]);
    expect(lanes(folded).filter((entry) => entry.data.group).map((entry) => entry.height)).toEqual([BOARD_SIZE.folded, BOARD_SIZE.folded, BOARD_SIZE.folded]);
    const opened = open(sources);
    expect(documents(opened)).toHaveLength(4);
    expect(commits(opened)).toHaveLength(3);
  });

  it('keep what a folded checkpoint says: whether it is done, its steps, and the decisions that wait', () => {
    const nodes = boardLayout(sources);
    expect((by(nodes, 'checkpoint:done-one') as CheckpointNode).data).toMatchObject({ title: 'Done one', done: true, stepsDone: 1, stepsTotal: 1, open: false });
    expect((by(nodes, 'checkpoint:later') as CheckpointNode).data).toMatchObject({ done: false, stepsDone: 0, stepsTotal: 9, open: false });
    // The decision that waits is still flagged when it is folded, and it stays folded: only the user opens it.
    expect((by(nodes, 'plan:own') as CheckpointNode).data).toMatchObject({ open: false, stepsDone: 1, stepsTotal: 2, waiting: [{ key: 'which-framework', question: 'Which framework?' }] });
    expect(by(boardLayout({ ...sources, plan: plan([checkpoint('Asks', { decisions: [decision('Which one?')] }), checkpoint('Next')]) }), 'checkpoint:asks')).toMatchObject({ data: { open: true } });
  });

  it('fold the documents into how many there are and how many are drafts or superseded', () => {
    const [folded] = lanes(boardLayout(sources)).filter((entry) => entry.id === 'lane:documents');
    expect(folded.data.group).toMatchObject({ open: false, summary: { headline: '4 documents', detail: '2 drafts · 1 superseded' } });
    const summary = (documentsOf: WorkDocument[]) => lanes(boardLayout({ documents: documentsOf }))[0].data.group!.summary;
    expect(summary([doc('One')])).toEqual({ headline: '1 document' });
    expect(summary([doc('One'), doc('Two', { status: 'draft' })])).toEqual({ headline: '2 documents', detail: '1 draft' });
  });

  it('fold a lane of commits into how many are new and the newest one, with its author', () => {
    const lane = (id: string) => lanes(boardLayout(sources)).find((entry) => entry.id === id)!;
    // Two listed and three more that the list leaves out; the newest is the one with the latest time, not the first.
    expect(lane('lane:commits:api').data).toMatchObject({ title: 'api', group: { open: false, summary: { headline: '5 new since you last looked', detail: 'Fix the header', byline: 'Ben' } } });
    expect(lane('lane:commits:web').data.group!.summary).toEqual({ headline: '1 new since you last looked', detail: 'Change c3d4e5f6a7', byline: 'Anna' });
    const first = { basis: 'first-look' as const, at: '2026-10-22T12:00:00.000Z', from: '2026-10-19T12:00:00.000Z' };
    expect(lanes(boardLayout({ news: news([repo('api', [commit('a1b2c3d', 1)], { more: 90, moreAtLeast: true })], first) }))[0].data.group!.summary.headline).toBe('91+ in the last 3 days');
  });

  it('say on a folded lane of commits that the repository could not be read in full, so the note it hides is not lost', () => {
    const lane = (nodes: BoardNode[]) => lanes(nodes).find((entry) => entry.id === 'lane:commits:api')!;
    const partly = { news: news([repo('api', [commit('a1b2c3d4e5', 5)], { problem: 'Some history is missing.' })]) };
    expect(lane(boardLayout(partly)).data.group!.summary).toMatchObject({ headline: '1 new since you last looked', warning: 'Could not read everything' });
    // Open, the lane says why itself, and its summary is not needed.
    expect(lane(open(partly)).data.note).toContain('Some history is missing.');
    // Without a problem there is no warning.
    expect(lane(boardLayout({ news: news([repo('api', [commit('a1b2c3d4e5', 5)])]) })).data.group!.summary).not.toHaveProperty('warning');
  });

  it('stand in the same columns, open or folded, so nothing jumps sideways', () => {
    const base = boardLayout(sources);
    const everything = open(sources);
    const xs = (nodes: BoardNode[]) => groups(nodes).map((node) => [node.id, node.position.x]);
    expect(xs(everything)).toEqual(xs(base));
    for (const id of groupIds) expect(by(base, id).position.y, id).toBe(0);
    // Whatever is opened or folded, a column is where it was.
    expect(xs(boardLayout({ ...sources, folds: { 'checkpoint:under-way': false, 'checkpoint:later': true } }))).toEqual(xs(base));
  });

  it('leave every other node where it was when a group opens, and fold back to where it was', () => {
    const cards = { board: boardOf({ cards: [note(1), note(2), note(3)] }) };
    const before = boardLayout({ ...sources, ...cards });
    const after = boardLayout({ ...sources, ...cards, folds: { 'checkpoint:later': true } });
    // The group that opened is as tall as its details; nothing else is touched, the band and its cards included.
    expect(by(after, 'checkpoint:later').height).toBeGreaterThan(by(before, 'checkpoint:later').height!);
    for (const node of before.filter((entry) => entry.id !== 'checkpoint:later')) expect(after.find((entry) => entry.id === node.id), node.id).toEqual(node);
    // Folded again, it is where it was.
    expect(boardLayout({ ...sources, ...cards, folds: { 'checkpoint:later': false } })).toEqual(before);
  });

  it('keep the band clear of every group that is open and of the summaries of the rest', () => {
    const cards = { board: boardOf({ cards: [note(1)] }) };
    for (const folds of [{}, { 'checkpoint:later': true }, { 'checkpoint:under-way': false }, Object.fromEntries(groupIds.map((id) => [id, true]))]) {
      const nodes = boardLayout({ ...sources, ...cards, folds });
      const rects = nodeRects(nodes);
      for (const entry of frames(nodes)) expect(overlaps(rects.get(entry.id)!, rects.get('lane:board')!), `${entry.id} ${JSON.stringify(folds)}`).toBe(false);
    }
  });

  it('follow the user\'s choices over the default, and the default again for a group they did not choose', () => {
    const nodes = boardLayout({ ...sources, folds: { 'checkpoint:under-way': false, 'checkpoint:done-one': true, 'lane:documents': true } });
    expect(groups(nodes).map((node) => [node.id, !isFolded(node)])).toEqual([
      ['lane:documents', true], ['plan:own', false], ['checkpoint:done-one', true], ['checkpoint:under-way', false], ['checkpoint:later', false], ['lane:commits:api', false], ['lane:commits:web', false],
    ]);
  });

  it('open the plan\'s own frame when there is no checkpoint, and nothing when there is no frame at all', () => {
    expect(groups(boardLayout({ plan: plan([], { steps: [step('Loose')] }), documents: [doc('Brief')] })).map((node) => [node.id, !isFolded(node)])).toEqual([['lane:documents', false], ['plan:own', true]]);
    expect(groups(boardLayout({ documents: [doc('Brief')] })).map((node) => [node.id, !isFolded(node)])).toEqual([['lane:documents', false]]);
  });

  it('leave a lane with nothing to fold as it is: the placeholder and a repository that could not be read', () => {
    const nodes = boardLayout({ plan: plan([checkpoint('One')]), news: news([repo('gone', [], { problem: 'The folder is missing.' }), repo('api', [])]) });
    expect(lanes(nodes).map((entry) => [entry.id, entry.data.group])).toEqual([['lane:commits', undefined], ['lane:commits:gone', undefined]]);
    expect(lanes(nodes)[1].data.note).toContain('The folder is missing.');
    expect(placeholders(nodes)).toHaveLength(1);
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

  it('start under the first checkpoint, oldest first, and go on to the right of it and round to the first, whatever the work is on', () => {
    const nodes = boardLayout({
      now: NOW, plan: plan([checkpoint('Done', { done: true }), checkpoint('Under way'), checkpoint('Later')]),
      board: boardOf({ cards: [note(1), note(2), note(3), note(4)] }),
    });
    const column = (index: number) => BOARD_SIZE.pad + index * (BOARD_SIZE.column + BOARD_SIZE.columnGap);
    const at = (title: string) => notes(nodes).find((card) => card.data.title === title)!.position;
    expect(at('Note 1')).toMatchObject({ x: column(0) });
    expect(at('Note 2')).toMatchObject({ x: column(1) });
    expect(at('Note 3')).toMatchObject({ x: column(2) });
    expect(at('Note 1').y).toBe(at('Note 3').y);
    expect(at('Note 4')).toMatchObject({ x: column(0), y: at('Note 1').y + BOARD_SIZE.note + BOARD_SIZE.gap });
    for (const card of notes(nodes)) expect(card.parentId).toBe('lane:board');
  });

  it('give a new card the next free place, and leave the cards already there where they are', () => {
    const sources = { now: NOW, plan: plan([checkpoint('One', { done: true }), checkpoint('Two'), checkpoint('Three')]) };
    const placesOf = (cards: BoardCard[]) => new Map(notes(boardLayout({ ...sources, board: boardOf({ cards }) })).map((card) => [card.id, card.position]));
    const before = placesOf([note(1), note(2), note(3), note(4)]);
    const after = placesOf([note(1), note(2), note(3), note(4), note(5, { at: minutesAgo(0) })]);
    for (const [id, position] of before) expect(after.get(id), id).toEqual(position);
    // The new one is the next in line: the second column's place in the second row.
    expect(after.get(uuidOf(5))).toEqual({ x: BOARD_SIZE.pad + (BOARD_SIZE.column + BOARD_SIZE.columnGap), y: before.get(uuidOf(4))!.y });
    // A card made earlier than the others comes first, whatever order the list is in.
    const early = placesOf([note(2), note(1, { at: minutesAgo(900) })]);
    expect(early.get(uuidOf(1))!.x).toBeLessThan(early.get(uuidOf(2))!.x);
  });

  it('do not move any card of the band when the work moves on, or when a checkpoint is ticked, or when a group is opened or folded', () => {
    const cards = [note(1), note(2), note(3), note(4)];
    const asked = [decision('Which format?'), decision('Which zone?')];
    const sources = (doneCount: number, folds?: BoardSources['folds']) => ({
      now: NOW, board: boardOf({ cards }), folds,
      plan: plan([checkpoint('One', { done: doneCount > 0, decisions: asked }), checkpoint('Two', { done: doneCount > 1 }), checkpoint('Three')]),
    });
    const band = (nodes: BoardNode[]) => [nodes.find((entry) => entry.id === 'lane:board')!.position, ...notes(nodes).map((card) => [card.id, card.position])];
    const base = band(boardLayout(sources(0)));
    // The work moves on to the next checkpoint, and on to the last.
    expect(band(boardLayout(sources(1)))).toEqual(base);
    expect(band(boardLayout(sources(2)))).toEqual(base);
    // Any group opened or folded, as the user likes: the tallest frame, one that is short, and all of them at once.
    for (const folds of [{ 'checkpoint:one': false }, { 'checkpoint:two': true }, { 'checkpoint:three': true }, { 'checkpoint:one': true, 'checkpoint:two': true, 'checkpoint:three': true }]) {
      expect(band(boardLayout(sources(0, folds))), JSON.stringify(folds)).toEqual(base);
    }
    // It stands under the tallest a frame can be, with every decision waiting, though that frame is folded or ticked.
    const first = frames(open(sources(0))).find((frame) => frame.data.title === 'One')!;
    expect(base[0]).toMatchObject({ y: first.height! + BOARD_SIZE.columnGap });
    for (const folds of [{}, { 'checkpoint:one': false }]) {
      const nodes = boardLayout(sources(0, folds));
      for (const frame of frames(nodes)) expect(frame.position.y + frame.height!, frame.id).toBeLessThanOrEqual((base[0] as { y: number }).y);
    }
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

  it('are drawn fixed like the rest, whether they are in the lane or have a place of their own: the board moves make them draggable', () => {
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

  it('ignore a saved place for a checkpoint, a document and a commit, which keep the place the board gives them', () => {
    const sources = { plan: plan([checkpoint('One'), checkpoint('Two'), checkpoint('Three')]), documents: [doc('Brief'), doc('Other')], news: news([repo('api', [commit('a1b2c3d4e5', 5), commit('b2c3d4e5f6', 9)])]) };
    const places = { 'checkpoint:two': { x: 500, y: 300 }, [`document:${slug('Brief')}`]: { x: 900, y: 10 }, 'commit:api:b2c3d4e5f6': { x: 910, y: 400 } };
    // Folded and open alike: the same nodes, in the same columns, as if no place had been saved.
    expect(boardLayout({ ...sources, board: boardOf({ positions: places }) })).toEqual(boardLayout(sources));
    expect(open({ ...sources, board: boardOf({ positions: places }) })).toEqual(open(sources));
    const nodes = open({ ...sources, board: boardOf({ positions: places }) });
    expect(frames(nodes).find((entry) => entry.data.title === 'Two')!.position).toEqual({ x: 2 * (BOARD_SIZE.column + BOARD_SIZE.columnGap), y: 0 });
    expect(documents(nodes).map((card) => card.parentId)).toEqual(['lane:documents', 'lane:documents']);
    expect(commits(nodes).map((card) => card.parentId)).toEqual(['lane:commits:api', 'lane:commits:api']);
    expect(lanes(nodes).map((entry) => entry.id)).toEqual(['lane:documents', 'lane:commits:api']);
  });

  it('keep a lane of commits whatever places were saved for them, since the commits stay in it', () => {
    const nodes = open({ news: news([repo('api', [commit('a1b2c3d4e5', 5)], { more: 4 })]), board: boardOf({ positions: { 'commit:api:a1b2c3d4e5': { x: 1, y: 2 } } }) });
    expect(lanes(nodes).map((entry) => [entry.data.title, entry.data.more])).toEqual([['api', 4]]);
    expect(commits(nodes)[0].parentId).toBe('lane:commits:api');
  });

  it('keep the place of a card, and no other', () => {
    const sources = { now: NOW, plan: plan([checkpoint('One')]), documents: [doc('Brief')], news: news([repo('api', [commit('a1b2c3d4e5', 5)])]) };
    const base = boardLayout({ ...sources, board: boardOf({ cards: [note(1), note(2)] }) });
    const placed = boardLayout({ ...sources, board: boardOf({ cards: [note(1), note(2)], positions: { [uuid(2)]: { x: 2000, y: -120 }, 'checkpoint:one': { x: 5, y: 5 }, [`document:${slug('Brief')}`]: { x: 6, y: 6 }, 'commit:api:a1b2c3d4e5': { x: 7, y: 7 } } }) });
    expect(notes(placed).find((card) => card.id === uuid(2))!.position).toEqual({ x: 2000, y: -120 });
    // Everything that is not that card is where it was without the places, the card in the band included.
    expect(placed.filter((node) => node.id !== uuid(2) && node.id !== 'lane:board')).toEqual(base.filter((node) => node.id !== uuid(2) && node.id !== 'lane:board'));
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

  describe('under a group, folded or open', () => {
    const base = {
      now: NOW, documents: [doc('Brief'), doc('Other')],
      plan: plan([checkpoint('One', { done: true }), checkpoint('Two', { steps: [step('A'), step('B'), step('C')] }), checkpoint('Ship it', { steps: Array.from({ length: 6 }, (_, index) => step(`Step ${index}`)), decisions: [decision('Who signs off?')] })]),
      news: news([repo('api', [commit('a1b2c3d4e5', 5), commit('b2c3d4e5f6', 9)])]),
    };
    const GROUPS = ['lane:documents', 'checkpoint:one', 'checkpoint:two', 'checkpoint:ship-it', 'lane:commits:api'];
    /** A card put under each column, just below where the folded summary stands, so a group that opens grows over it. */
    const placed = Object.fromEntries([0, 1, 2, 3, 4, 5].map((column) => [uuid(column + 1), { x: column * (BOARD_SIZE.column + BOARD_SIZE.columnGap) + 8, y: BOARD_SIZE.folded + 20 }]));
    const cards = [1, 2, 3, 4, 5, 6].map((n) => note(n));
    const free = (nodes: BoardNode[]) => nodes.filter((node) => node.parentId === undefined && node.type === 'note');
    const subsets = Array.from({ length: 1 << GROUPS.length }, (_, mask) => Object.fromEntries(GROUPS.map((id, index) => [id, Boolean(mask & (1 << index))])));
    const layout = (folds: Record<string, boolean>, positions = placed) => boardLayout({ ...base, board: boardOf({ cards, positions }), folds });
    const placesOf = (nodes: BoardNode[]) => free(nodes).map((node) => [node.id, node.position]);
    /** A group as it is when open: the room a card keeps clear, whether or not the group is open now. */
    const footprint = (nodes: BoardNode[], id: string) => {
      const node = nodes.find((entry) => entry.id === id)!;
      return { ...nodeRects(nodes).get(id)!, height: node.type === 'checkpoint' ? (node as CheckpointNode).data.openHeight : (node as LaneNode).data.group!.openHeight };
    };

    it('draw a card in the same place whatever is open or folded, and clear of every group as it is when open', () => {
      const every = placesOf(layout(subsets[0]!));
      for (const folds of subsets) {
        const nodes = layout(folds);
        expect(placesOf(nodes), JSON.stringify(folds)).toEqual(every);
        for (const card of free(nodes)) for (const id of GROUPS) expect(overlaps(nodeRects(nodes).get(card.id)!, footprint(nodes, id)), `${card.id} over ${id} with ${JSON.stringify(folds)}`).toBe(false);
      }
    });

    it('put a card in the way just below the group, with the room between things, and leave a card that is not in the way where it was put', () => {
      const nodes = layout({});
      const card = (n: number) => nodes.find((node) => node.id === uuid(n))!;
      const ship = footprint(nodes, 'checkpoint:ship-it');
      // The open frame is taller than its summary, and the card is just below the open frame: not under its steps, folded or not.
      expect(ship.height).toBeGreaterThan(BOARD_SIZE.folded + 20);
      expect(card(4).position).toEqual({ x: placed[uuid(4)]!.x, y: ship.y + ship.height + BOARD_SIZE.gap });
      // A card the group does not reach is where it was put: the one far from every column.
      const far = boardLayout({ ...base, board: boardOf({ cards: [note(1)], positions: { [uuid(1)]: { x: 5000, y: 20 } } }) });
      expect(free(far)[0]!.position).toEqual({ x: 5000, y: 20 });
    });

    it('draw a raw saved place that is under a group clear of it, without changing what is saved', () => {
      const raw = { [uuid(4)]: { x: placed[uuid(4)]!.x, y: BOARD_SIZE.folded + 20 } };
      const board = boardOf({ cards: [note(4)], positions: raw });
      const nodes = boardLayout({ ...base, board });
      expect(free(nodes)[0]!.position.y).toBeGreaterThan(BOARD_SIZE.folded + 20);
      // The board that was given is as it was: the place saved is the one that was put, and it is what a read of the board says.
      expect(board.positions).toEqual(raw);
    });

    it('clear a card of the band too, and every group it would be put under, when several are in the way', () => {
      // One card wide enough to be under two columns at once.
      const both = { [uuid(1)]: { x: 2 * (BOARD_SIZE.column + BOARD_SIZE.columnGap) + 200, y: BOARD_SIZE.folded + 20 } };
      const nodes = boardLayout({ ...base, board: boardOf({ cards: [note(1), note(2)], positions: both }), folds: { 'checkpoint:two': true, 'checkpoint:ship-it': true } });
      const rects = nodeRects(nodes);
      const card = rects.get(uuid(1))!;
      for (const id of ['checkpoint:two', 'checkpoint:ship-it']) expect(overlaps(card, footprint(nodes, id)), id).toBe(false);
      expect(overlaps(card, rects.get('lane:board')!)).toBe(false);
      expect(card.y).toBeGreaterThanOrEqual(rects.get('lane:board')!.y + rects.get('lane:board')!.height + BOARD_SIZE.gap);
    });

    it('give clearPlace, for a drop or a nudge, the place the layout draws, and the same place when asked again', () => {
      const nodes = layout({});
      const size = { width: BOARD_SIZE.card, height: BOARD_SIZE.note };
      for (const [id, at] of Object.entries(placed)) {
        const cleared = clearPlace(nodes, at, size);
        expect(cleared, id).toEqual(nodes.find((node) => node.id === id)!.position);
        expect(clearPlace(nodes, cleared, size), id).toEqual(cleared);
      }
      // A place that is clear is returned as it is.
      expect(clearPlace(nodes, { x: 9000, y: 9000 }, size)).toEqual({ x: 9000, y: 9000 });
    });
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
  const nodes = open(sources);
  const folded = boardLayout(sources);

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
    const longer = open({ ...sources, news: news([repo('api', [commit('a1b2c3d4e5f6a7b8c9d0', 5)])]) });
    expect(boardEdges(longer, [link(1, uuid(1), 'commit:api:a1b2c3d4e5')])[0].target).toBe('commit:api:a1b2c3d4e5f6a7b8c9d0');
    const shorter = open({ ...sources, news: news([repo('api', [commit('a1b2c3d', 5)])]) });
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

  it('go to the summary of a folded group for a thing inside it, so no line points at nothing, and keep their labels', () => {
    expect(folded.some((node) => node.id === 'commit:api:a1b2c3d4e5f6' || node.id === `document:${slug('Brief')}`)).toBe(false);
    const edges = boardEdges(folded, [link(1, uuid(1), 'commit:api:a1b2c3d', 'found while'), link(2, uuid(2), `document:${slug('Brief')}`), link(3, uuid(1), 'checkpoint:build-it')]);
    expect(edges.map((edge) => [edge.id, edge.source, edge.target])).toEqual([[uuid(901), uuid(1), 'lane:commits:api'], [uuid(902), uuid(2), 'lane:documents'], [uuid(903), uuid(1), 'checkpoint:build-it']]);
    expect(edges[0].label).toBe('found while');
    expect(edges[0].ariaLabel).toBe('Link from Note 1 to api: found while');
    expect(edges[1].ariaLabel).toBe('Link from Note 2 to Documents');
    // Every end of every line is a node that is drawn.
    const drawn = new Set(folded.map((node) => node.id));
    for (const edge of edges) { expect(drawn.has(edge.source), edge.id).toBe(true); expect(drawn.has(edge.target), edge.id).toBe(true); }
  });

  it('come back to the thing itself when its group opens', () => {
    const links = [link(1, uuid(1), 'commit:api:a1b2c3d', 'found while')];
    expect(boardEdges(folded, links)[0].target).toBe('lane:commits:api');
    const opened = boardLayout({ ...sources, folds: { 'lane:commits:api': true } });
    expect(boardEdges(opened, links)[0].target).toBe('commit:api:a1b2c3d4e5f6');
  });

  it('leave out a line between two things of the same folded group, which would only loop on its summary', () => {
    const two = boardLayout({ ...sources, news: news([repo('api', [commit('a1b2c3d4e5f6', 5), commit('b2c3d4e5f6a7', 9)])]) });
    expect(boardEdges(two, [link(1, 'commit:api:a1b2c3d', 'commit:api:b2c3d4e')])).toEqual([]);
    // From one folded group to another, or to an open frame, it is drawn.
    expect(boardEdges(two, [link(2, 'commit:api:a1b2c3d', `document:${slug('Brief')}`)]).map((edge) => [edge.source, edge.target])).toEqual([['lane:commits:api', 'lane:documents']]);
  });

  it('still skip a line to a thing that is not in the group it would be folded into', () => {
    expect(boardEdges(folded, [link(1, uuid(1), 'commit:api:deadbeef'), link(2, uuid(1), 'commit:web:a1b2c3d')])).toEqual([]);
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
