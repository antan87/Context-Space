import { describe, expect, it } from 'vitest';
import type { WorkDocument } from '../../types.js';
import type { PlanFileCheckpoint, PlanFileDecision, PlanFileView } from '../plan/planFile.js';
import type { NewsRepo, WhatsNewView } from '../plan/whatsNew.js';
import { BOARD_LIMITS, boardLayout, moreText, type BoardNode, type CheckpointNode, type CommitNode, type DocumentNode, type LaneNode, type PlaceholderNode } from './boardLayout.js';

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

  it('sits beside the lane of a repository that could not be read', () => {
    const nodes = boardLayout({ news: news([repo('gone', [], { problem: 'The folder is missing.' })]) });
    expect(lanes(nodes).map((lane) => lane.data.title)).toEqual(['Commits', 'gone']);
    expect(placeholders(nodes)).toHaveLength(1);
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
