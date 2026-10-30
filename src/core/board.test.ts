import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  BOARD_CHANGES_KEPT,
  BOARD_FILE,
  BOARD_LIMITS,
  BoardChangeError,
  BoardConflictError,
  BoardFileError,
  BoardInputError,
  BoardWorkspaceError,
  boardActorName,
  changeBoard,
  isBoardAreaId,
  isBoardNodeId,
  isBoardStepKey,
  parseBoardChanges,
  readBoard,
  readBoardChanges,
  type Board,
  type BoardChange,
} from './board.js';
import { parsePlanFile } from './plan-file.js';
import { ArchivedWorkspaceError } from './archive-guard.js';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import { acquireLock } from './locks.js';
import { BOARD_EVENTS_FILE, listBoardEvents, listScreenEvents } from './screen-events.js';

let root: string;
let storage: LocalStorageAdapter;

const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({ id: 'canvas', name: 'Canvas', branchName: 'canvas', repos: [], assistants: [], workspacePath: root, ...extra });
const boardPath = () => path.join(root, BOARD_FILE);
const stored = async () => JSON.parse(await fs.readFile(boardPath(), 'utf8')) as Board;
const note = (title: string, extra: Record<string, unknown> = {}): BoardChange => ({ op: 'add_card', kind: 'note', title, ...extra }) as BoardChange;
const file = (filePath: string, extra: Record<string, unknown> = {}): BoardChange => ({ op: 'add_card', kind: 'file', path: filePath, ...extra }) as BoardChange;
const as = (by: string, revision?: number) => ({ by, ...(revision === undefined ? {} : { revision }) });
const write = async (name: string, content = 'x') => {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await fs.writeFile(path.join(root, name), content);
};
const card = (n: number) => ({ id: randomUUID(), kind: 'note', title: `Card ${n}`, body: '', pinned: false, archived: false, by: 'user', at: '2026-10-01T10:00:00.000Z', updatedBy: 'user', updatedAt: '2026-10-01T10:00:00.000Z' });
const seed = (board: Record<string, unknown>) => fs.writeFile(boardPath(), JSON.stringify({ version: 1, revision: 4, cards: [], links: [], positions: {}, ...board }));

beforeEach(async () => {
  storage = new LocalStorageAdapter();
  setActiveStorageProvider(storage);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-core-')));
  await fs.writeFile(path.join(root, 'contextspace.json'), manifest());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('the board file', () => {
  it('reads as an empty board when there is no file, and writes nothing for a read', async () => {
    expect(await readBoard(root)).toEqual({ version: 1, revision: 0, cards: [], links: [], positions: {} });
    await expect(fs.access(boardPath())).rejects.toThrow();
  });

  it('is read and written through the storage port, as versioned JSON', async () => {
    const write = vi.spyOn(storage, 'writeWorkspaceFile');
    const read = vi.spyOn(storage, 'readWorkspaceFile');
    await changeBoard(root, [note('First')], as('user'));
    expect(write).toHaveBeenCalledWith(root, 'canvas', BOARD_FILE, expect.stringContaining('"version": 1'));
    expect(read).toHaveBeenCalledWith(root, 'canvas', BOARD_FILE);
    expect(await stored()).toMatchObject({ version: 1, revision: 1, cards: [{ title: 'First' }] });
    expect((await fs.readdir(root)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('rebuilds what it reads field by field and drops what is not usable', async () => {
    const good = card(1);
    const other = card(2);
    const shown = { ...card(3), kind: 'file', path: 'docs/overview.html', description: 'A page', body: 'ignored', secret: 'dropped' };
    await seed({
      cards: [
        { ...good, injected: 'dropped', title: `  Spaced \u0007 out   ${'x'.repeat(300)}` },
        { ...good, title: 'Same id twice' },
        other,
        shown,
        { ...card(4), kind: 'drawing' },
        { ...card(5), title: '' },
        { ...card(6), id: 'not-a-uuid' },
        { ...card(7), at: 'someday' },
        { ...card(8), kind: 'file', path: '../outside.md' },
        { ...card(9), kind: 'file', path: '/etc/passwd.md' },
        { ...card(10), kind: 'file', path: '.git/config.md' },
        { ...card(11), kind: 'file', path: 'C:/x.md' },
        'a string', null, 7,
      ],
      links: [
        { id: randomUUID(), from: good.id, to: 'checkpoint:reports-export', label: 'explains', by: 'claude', at: '2026-10-01T10:00:00.000Z', extra: 1 },
        { id: randomUUID(), from: good.id, to: 'checkpoint:reports-export', by: 'claude', at: '2026-10-01T10:00:00.000Z' },
        { id: randomUUID(), from: good.id, to: randomUUID(), by: 'claude', at: '2026-10-01T10:00:00.000Z' },
        { id: randomUUID(), from: good.id, to: good.id, by: 'claude', at: '2026-10-01T10:00:00.000Z' },
        { id: randomUUID(), from: good.id, to: 'somewhere', by: 'claude', at: '2026-10-01T10:00:00.000Z' },
        { id: randomUUID(), from: good.id, to: other.id, by: '', at: '2026-10-01T10:00:00.000Z' },
      ],
      positions: {
        [good.id]: { x: 10, y: -20, z: 3 },
        'checkpoint:reports-export': { x: 1.5, y: 2 },
        'document:11111111-1111-4111-8111-111111111111': { x: 1e9, y: 0 },
        'commit:api:abc1234': { x: 'left', y: 0 },
        [randomUUID()]: { x: 1, y: 1 },
        'lane:documents': { x: 1, y: 1 },
      },
    });
    const board = await readBoard(root);
    expect(board.cards.map((c) => c.id)).toEqual([good.id, other.id, shown.id]);
    expect(board.cards[0]).toEqual({ ...good, title: `Spaced out ${'x'.repeat(300)}`.slice(0, BOARD_LIMITS.title).trim() });
    expect(board.cards[2]).toEqual({ ...shown, body: undefined, secret: undefined, path: 'docs/overview.html', description: 'A page' });
    expect(Object.keys(board.cards[2]!)).not.toContain('secret');
    expect(board.links).toHaveLength(1);
    expect(board.links[0]).toMatchObject({ from: good.id, to: 'checkpoint:reports-export', label: 'explains', by: 'claude' });
    expect(Object.keys(board.links[0]!)).not.toContain('extra');
    expect(board.positions).toEqual({ [good.id]: { x: 10, y: -20 }, 'checkpoint:reports-export': { x: 1.5, y: 2 } });
  });

  it.each([
    ['text that is not JSON', '{ not json'],
    ['an empty file', ''],
    ['a list', '[]'],
    ['no version', JSON.stringify({ revision: 1, cards: [] })],
    ['a version of 0', JSON.stringify({ version: 0, revision: 1 })],
    ['no revision', JSON.stringify({ version: 1, cards: [] })],
    ['a fractional revision', JSON.stringify({ version: 1, revision: 1.5 })],
    ['cards that are not a list', JSON.stringify({ version: 1, revision: 1, cards: {} })],
    ['links that are not a list', JSON.stringify({ version: 1, revision: 1, links: 'x' })],
    ['positions that are not an object', JSON.stringify({ version: 1, revision: 1, positions: [] })],
  ])('reports %s as an error and never overwrites it', async (_name, content) => {
    await fs.writeFile(boardPath(), content);
    await expect(readBoard(root)).rejects.toBeInstanceOf(BoardFileError);
    await expect(readBoard(root)).rejects.toThrow(/left as it is/);
    await expect(changeBoard(root, [note('Lost?')], as('user'))).rejects.toBeInstanceOf(BoardFileError);
    expect(await fs.readFile(boardPath(), 'utf8')).toBe(content);
    expect(await readBoardChanges(root)).toEqual([]);
    await expect(fs.access(path.join(root, '.contextspace', BOARD_EVENTS_FILE))).rejects.toThrow();
  });

  it('names a board from a newer version as such, and leaves it alone', async () => {
    const content = JSON.stringify({ version: 2, revision: 9, shapes: [] });
    await fs.writeFile(boardPath(), content);
    await expect(changeBoard(root, [note('x')], as('user'))).rejects.toThrow(/newer version/);
    expect(await fs.readFile(boardPath(), 'utf8')).toBe(content);
  });

  it('does not follow a board file that is a link', async () => {
    await fs.writeFile(path.join(root, 'elsewhere.json'), JSON.stringify({ version: 1, revision: 1, cards: [card(1)] }));
    await fs.symlink(path.join(root, 'elsewhere.json'), boardPath());
    await expect(readBoard(root)).rejects.toBeInstanceOf(BoardFileError);
    await expect(changeBoard(root, [note('x')], as('user'))).rejects.toBeInstanceOf(BoardFileError);
  });

  it('reports a folder where the board file should be as an error, and changes nothing', async () => {
    await fs.mkdir(boardPath());
    await expect(readBoard(root)).rejects.toBeInstanceOf(BoardFileError);
    await expect(readBoard(root)).rejects.toThrow(/could not be read.*left as it is/);
    await expect(readBoard(root)).rejects.not.toThrow(/link/);
    await expect(changeBoard(root, [note('x')], as('user'))).rejects.toBeInstanceOf(BoardFileError);
    expect((await fs.stat(boardPath())).isDirectory()).toBe(true);
    expect(await readBoardChanges(root)).toEqual([]);
  });

  it('reports a board file it may not read as what it is, and not as a link', async () => {
    await seed({ cards: [card(1)] });
    const before = await fs.readFile(boardPath(), 'utf8');
    vi.spyOn(storage, 'readWorkspaceFile').mockRejectedValue(Object.assign(new Error('EACCES: permission denied, open board'), { code: 'EACCES' }));
    await expect(readBoard(root)).rejects.toBeInstanceOf(BoardFileError);
    await expect(readBoard(root)).rejects.toThrow(/EACCES.*left as it is/);
    await expect(changeBoard(root, [note('x')], as('user'))).rejects.toBeInstanceOf(BoardFileError);
    vi.restoreAllMocks();
    expect(await fs.readFile(boardPath(), 'utf8')).toBe(before);
  });

  it('recovers: once the corrupt file is removed, the board works again', async () => {
    await fs.writeFile(boardPath(), '{ broken');
    await expect(changeBoard(root, [note('x')], as('user'))).rejects.toThrow(BoardFileError);
    await fs.rm(boardPath());
    expect((await changeBoard(root, [note('x')], as('user'))).board.revision).toBe(1);
  });
});

describe('node ids', () => {
  it.each([
    randomUUID(),
    'checkpoint:reports-export-to-csv',
    'checkpoint:reports-export-to-csv-2',
    'checkpoint:ünïcode-schlüssel',
    'checkpoint:plan#2',
    'document:7f3c1c6e-3c35-4f0a-9a3d-0b6a2d6f8d11',
    'commit:NexusFlow:abc1234',
    'commit:my repo:0123456789abcdef0123456789abcdef01234567',
    'commit:a:b:abc1234',
  ])('accepts %s', (id) => {
    expect(isBoardNodeId(id)).toBe(true);
  });

  it.each([
    '', 'x', 'checkpoint:', 'checkpoint:-x', 'checkpoint:a/b', 'checkpoint:a b', 'document:1234', 'document:not-a-uuid',
    'commit:api', 'commit::abc1234', 'commit:api:xyz', 'commit:api:abc12', 'commit:a/b:abc1234', 'commit:a\\b:abc1234',
    'lane:documents', 'CHECKPOINT:x', randomUUID().toUpperCase(), `checkpoint:${'a'.repeat(200)}`, 42, null, {},
  ])('refuses %j', (id) => {
    expect(isBoardNodeId(id)).toBe(false);
  });
});

describe('area ids', () => {
  it.each([
    'checkpoint:reports-export-to-csv',
    'checkpoint:reports-export-to-csv-2',
    'checkpoint:ünïcode-schlüssel',
    'checkpoint:plan#2',
    'plan:own',
  ])('accepts %s', (id) => {
    expect(isBoardAreaId(id)).toBe(true);
  });

  it.each([
    '', 'x', randomUUID(), 'document:7f3c1c6e-3c35-4f0a-9a3d-0b6a2d6f8d11',
    'commit:NexusFlow:abc1234', 'lane:documents', 'checkpoint:', 'checkpoint:-x',
    'checkpoint:a/b', 'checkpoint:a b', 'CHECKPOINT:x', `checkpoint:${'a'.repeat(401)}`,
    42, null, {},
  ])('refuses %j', (id) => {
    expect(isBoardAreaId(id)).toBe(false);
  });
});

describe('cards', () => {
  it('adds a note, recording who made it and when, and bumps the revision', async () => {
    const { board, results } = await changeBoard(root, [note('  Export finding  ', { body: 'Line one\r\nLine two', pinned: true })], as('claude'));
    expect(board.revision).toBe(1);
    expect(results).toEqual([{ op: 'add_card', id: board.cards[0]!.id }]);
    expect(board.cards[0]).toMatchObject({
      kind: 'note', title: 'Export finding', body: 'Line one\nLine two', pinned: true, archived: false,
      by: 'claude', updatedBy: 'claude',
    });
    expect(board.cards[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(board.cards[0]!.at)).not.toBeNaN();
    expect(board.cards[0]!.updatedAt).toBe(board.cards[0]!.at);
    expect(await readBoard(root)).toEqual(board);
  });

  it('adds a file card for a file that exists, titled by its name unless told otherwise', async () => {
    await write('docs/overview.html', '<h1>Hi</h1>');
    await write('docs/shot.png', 'png');
    await write('.claude/notes.md', 'notes');
    const { board } = await changeBoard(root, [
      file('docs/overview.html', { description: 'The overview page' }),
      file('docs\\shot.png', { title: 'Screenshot', pinned: true }),
      file('.claude/notes.md'),
    ], as('claude'));
    expect(board.cards).toMatchObject([
      { kind: 'file', path: 'docs/overview.html', title: 'overview.html', description: 'The overview page', pinned: false },
      { kind: 'file', path: 'docs/shot.png', title: 'Screenshot', description: '', pinned: true },
      { kind: 'file', path: '.claude/notes.md', title: 'notes.md' },
    ]);
  });

  it('adds a card with an area, for notes and files alike', async () => {
    await write('docs/overview.html', '<h1>Hi</h1>');
    const { board } = await changeBoard(root, [
      note('Checkpoint note', { area: 'checkpoint:reports-export' }),
      note('Plan note', { area: 'plan:own' }),
      file('docs/overview.html', { area: 'checkpoint:reports-export' }),
    ], as('claude'));
    expect(board.cards[0]!.area).toBe('checkpoint:reports-export');
    expect(board.cards[1]!.area).toBe('plan:own');
    expect(board.cards[2]!.area).toBe('checkpoint:reports-export');
    expect((await stored()).cards[0]!.area).toBe('checkpoint:reports-export');
  });

  it('updates a card area, sets it as sole field, and clears with null', async () => {
    const { board: made } = await changeBoard(root, [note('A note')], as('user'));
    const id = made.cards[0]!.id;
    expect('area' in made.cards[0]!).toBe(false);

    // Set area as sole field
    const { board: step1 } = await changeBoard(root, [{ op: 'update_card', id, area: 'checkpoint:reports-export' }], as('user'));
    expect(step1.cards[0]!.area).toBe('checkpoint:reports-export');

    // Change area
    const { board: step2 } = await changeBoard(root, [{ op: 'update_card', id, area: 'plan:own' }], as('user'));
    expect(step2.cards[0]!.area).toBe('plan:own');

    // Clear area with null
    const { board: step3 } = await changeBoard(root, [{ op: 'update_card', id, area: null }], as('user'));
    expect('area' in step3.cards[0]!).toBe(false);
    expect(step3.cards[0]!.area).toBeUndefined();

    // Verify stored JSON has no "area" key
    const onDisk = await stored();
    expect('area' in onDisk.cards[0]!).toBe(false);
    expect(JSON.stringify(onDisk)).not.toContain('"area"');
  });

  it('refuses invalid area on add_card and update_card', async () => {
    const id = randomUUID();
    for (const badArea of ['', 'document:7f3c1c6e-3c35-4f0a-9a3d-0b6a2d6f8d11', 'lane:board', 123]) {
      expect(() => parseBoardChanges([{ op: 'add_card', kind: 'note', title: 'T', area: badArea }])).toThrow(BoardInputError);
      expect(() => parseBoardChanges([{ op: 'update_card', id, area: badArea }])).toThrow(BoardInputError);
      await expect(changeBoard(root, [{ op: 'add_card', kind: 'note', title: 'T', area: badArea }], as('user'))).rejects.toThrow(BoardInputError);
      await expect(changeBoard(root, [{ op: 'update_card', id, area: badArea }], as('user'))).rejects.toThrow(BoardInputError);
    }
  });

  it('keeps valid area and drops invalid area when rebuilding cards', async () => {
    const cardWithArea = { ...card(1), area: 'checkpoint:reports-export' };
    const cardWithPlanOwn = { ...card(2), area: 'plan:own' };
    const cardWithBadArea1 = { ...card(3), area: '' };
    const cardWithBadArea2 = { ...card(4), area: 'lane:documents' };
    const cardWithBadArea3 = { ...card(5), area: randomUUID() };
    const cardWithBadArea4 = { ...card(6), area: 42 };
    const cardWithNullArea = { ...card(7), area: null };
    await seed({
      cards: [cardWithArea, cardWithPlanOwn, cardWithBadArea1, cardWithBadArea2, cardWithBadArea3, cardWithBadArea4, cardWithNullArea],
    });
    const board = await readBoard(root);
    expect(board.cards).toHaveLength(7);
    expect(board.cards[0]!.area).toBe('checkpoint:reports-export');
    expect(board.cards[1]!.area).toBe('plan:own');
    for (let i = 2; i < 7; i++) {
      expect('area' in board.cards[i]!).toBe(false);
      expect(board.cards[i]!.area).toBeUndefined();
    }
  });

  it('adds and updates step and look, stamps lookAt itself, and clears with null', async () => {
    const { board: made } = await changeBoard(root, [note('A note', { step: 'build-the-search-box', look: '  check the new search box ' })], as('claude'));
    const added = made.cards[0]!;
    expect(added).toMatchObject({ step: 'build-the-search-box', look: 'check the new search box' });
    expect(added.lookAt).toBe(added.at);
    const id = added.id;
    expect('step' in (await changeBoard(root, [note('Plain')], as('user'))).board.cards[1]!).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const { board: same } = await changeBoard(root, [{ op: 'update_card', id, title: 'Renamed' }], as('user'));
    expect(same.cards[0]!.lookAt).toBe(added.lookAt);
    const { board: changed } = await changeBoard(root, [{ op: 'update_card', id, look: 'now the filters' }], as('user'));
    expect(changed.cards[0]!.look).toBe('now the filters');
    expect(changed.cards[0]!.lookAt).toBe(changed.cards[0]!.updatedAt);
    expect(changed.cards[0]!.lookAt).not.toBe(added.lookAt);
    expect(changed.cards[0]!.step).toBe('build-the-search-box');

    const { board: cleared } = await changeBoard(root, [{ op: 'update_card', id, look: null, step: null }], as('user'));
    for (const field of ['step', 'look', 'lookAt']) expect(field in cleared.cards[0]!).toBe(false);
    expect(JSON.stringify(await stored())).not.toMatch(/"(step|look|lookAt)"/);
  });

  it('refuses a look with a line break or too long, a bad step key, and a lookAt from the caller', async () => {
    const id = randomUUID();
    for (const bad of ['two\nlines', 'x'.repeat(BOARD_LIMITS.look + 1), '   ', 5]) {
      expect(() => parseBoardChanges([{ op: 'add_card', kind: 'note', title: 'T', look: bad }])).toThrow(BoardInputError);
      expect(() => parseBoardChanges([{ op: 'update_card', id, look: bad }])).toThrow(BoardInputError);
    }
    for (const bad of ['', 'Not A Key', 'has space', 'x'.repeat(BOARD_LIMITS.stepKey + 1), 7]) {
      expect(() => parseBoardChanges([{ op: 'add_card', kind: 'note', title: 'T', step: bad }])).toThrow(BoardInputError);
      expect(() => parseBoardChanges([{ op: 'update_card', id, step: bad }])).toThrow(BoardInputError);
    }
    expect(() => parseBoardChanges([{ op: 'update_card', id, lookAt: '2026-10-01T10:00:00.000Z' }])).toThrow(BoardInputError);
    expect(() => parseBoardChanges([{ op: 'add_card', kind: 'note', title: 'T', look: 'ok', lookAt: '2026-10-01T10:00:00.000Z' }])).toThrow(BoardInputError);
  });

  it('keeps a valid step, look and lookAt and drops junk when rebuilding cards', async () => {
    const lookAt = '2026-10-02T10:00:00.000Z';
    await seed({
      cards: [
        { ...card(1), step: 'build-it', look: 'see this', lookAt },
        { ...card(2), step: 'Not A Key', look: 'x'.repeat(BOARD_LIMITS.look + 1), lookAt },
        { ...card(3), step: 4, look: 7, lookAt },
        { ...card(4), step: null, look: '   ' },
        { ...card(5), look: 'no time', lookAt: 'yesterday' },
      ],
    });
    const { cards } = await readBoard(root);
    expect(cards[0]).toMatchObject({ step: 'build-it', look: 'see this', lookAt });
    for (const i of [1, 2, 3]) for (const field of ['step', 'look', 'lookAt']) expect(field in cards[i]!, `${i} ${field}`).toBe(false);
    expect('step' in cards[3]!).toBe(false);
    expect(cards[4]).toMatchObject({ look: 'no time', lookAt: card(5).updatedAt });
  });

  it('keeps a hinted step without an area, clears the area with null, and clears the old area for a step the plan does not know', async () => {
    await fs.writeFile(path.join(root, 'PLAN.md'), '# Plan\n\n- [ ] Loose step\n');
    const { board: hinted } = await changeBoard(root, [note('H', { step: 'loose-step' })], { ...as('claude'), stepIsHint: true });
    expect(hinted.cards[0]).toMatchObject({ step: 'loose-step' });
    expect(hinted.cards[0]!.area).toBeUndefined();
    const { board: pinned } = await changeBoard(root, [note('P', { step: 'loose-step' })], as('user'));
    expect(pinned.cards[1]!.area).toBe('plan:own');
    const id = pinned.cards[1]!.id;
    const { board: kept } = await changeBoard(root, [{ op: 'update_card', id, area: null }], as('user'));
    expect(kept.cards[1]).toMatchObject({ step: 'loose-step' });
    expect(kept.cards[1]!.area).toBeUndefined();
    // A step the plan does not know cannot say an area, so the area the caller gave (null too) is applied.
    await changeBoard(root, [{ op: 'update_card', id, area: 'plan:own' }], as('user'));
    const { board: unknown } = await changeBoard(root, [{ op: 'update_card', id, step: 'not-in-the-plan', area: null }], as('user'));
    expect(unknown.cards[1]).toMatchObject({ step: 'not-in-the-plan' });
    expect(unknown.cards[1]!.area).toBeUndefined();
    // An unreadable plan does the same.
    await fs.rm(path.join(root, 'PLAN.md'));
    await changeBoard(root, [{ op: 'update_card', id, area: 'plan:own' }], as('user'));
    const { board: noPlan } = await changeBoard(root, [{ op: 'update_card', id, step: 'loose-step', area: null }], as('user'));
    expect(noPlan.cards[1]).toMatchObject({ step: 'loose-step' });
    expect(noPlan.cards[1]!.area).toBeUndefined();
  });

  it('keeps lookAt when the same look is repeated, and cleans a look like a title', async () => {
    const { board: made } = await changeBoard(root, [note('N', { look: 'first\tlook\u0007 here' })], as('claude'));
    const card = made.cards[0]!;
    expect(card.look).toBe('first look here');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { board: again } = await changeBoard(root, [{ op: 'update_card', id: card.id, look: 'first look here' }], as('claude'));
    expect(again.cards[0]!.lookAt).toBe(card.lookAt);
    for (const bad of ['a\rb', 'a\u0085b', 'a\u2028b', 'a\u2029b']) expect(() => parseBoardChanges([note('N', { look: bad })])).toThrow(BoardInputError);
    await expect(changeBoard(root, [note('N', { look: '\u0007\u0007' })], as('user'))).rejects.toThrow(/cannot be empty/);
  });

  it('accepts every key the plan makes for a step', () => {
    const long = 'Undo by Ctrl/Cmd+Z right after Shift+arrow moves or while a later drop is still running somewhere';
    const plan = parsePlanFile(['# P', '', '- [ ] Reports export to CSV', '- [ ] Reports export to CSV', `- [ ] ${long}`, `- [ ] ${long}`, '- [ ] Ünïcode and 2nd step', `- [ ] ${'word-'.repeat(20)}`, '- [ ] `Code` and **bold**'].join('\n'));
    const keys = plan.steps.map((step) => step.key);
    expect(keys.some((key) => key.endsWith('-'))).toBe(true);
    expect(keys.some((key) => key.includes('--'))).toBe(true);
    for (const key of keys) expect(isBoardStepKey(key), key).toBe(true);
    for (const bad of ['', '-x', 'a b', 'a/b', 'x'.repeat(BOARD_LIMITS.stepKey + 1)]) expect(isBoardStepKey(bad), bad).toBe(false);
  });

  it('lets the plan step decide the area of a card, and drops the step when the area moves away', async () => {
    await fs.writeFile(path.join(root, 'PLAN.md'), '# Plan\n\n- [ ] Loose step\n\n## Checkpoints\n\n- [ ] Outcome one\n  - [ ] Step in one\n');
    const { board } = await changeBoard(root, [note('A', { step: 'step-in-one' }), note('B', { step: 'loose-step' }), note('C', { step: 'not-in-the-plan' })], as('user'));
    expect(board.cards.map((card) => card.area)).toEqual(['checkpoint:outcome-one', 'plan:own', undefined]);
    await expect(changeBoard(root, [note('D', { step: 'loose-step', area: 'checkpoint:outcome-one' })], as('user'))).rejects.toThrow(/in plan:own, not checkpoint:outcome-one/);
    const id = board.cards[0]!.id;
    const { board: moved } = await changeBoard(root, [{ op: 'update_card', id, step: 'loose-step' }], as('user'));
    expect(moved.cards[0]).toMatchObject({ step: 'loose-step', area: 'plan:own' });
    const { board: kept } = await changeBoard(root, [{ op: 'update_card', id, area: 'plan:own' }], as('user'));
    expect(kept.cards[0]!.step).toBe('loose-step');
    const { board: away } = await changeBoard(root, [{ op: 'update_card', id, area: 'checkpoint:outcome-one' }], as('user'));
    expect(away.cards[0]).toMatchObject({ area: 'checkpoint:outcome-one' });
    expect('step' in away.cards[0]!).toBe(false);
    // Naming a known step while clearing the area stores the step's own area.
    const { board: stepped } = await changeBoard(root, [{ op: 'update_card', id, step: 'loose-step', area: null }], as('user'));
    expect(stepped.cards[0]).toMatchObject({ step: 'loose-step', area: 'plan:own' });
    // A step the plan does not know is left alone.
    const unknown = board.cards[2]!.id;
    const { board: stays } = await changeBoard(root, [{ op: 'update_card', id: unknown, area: 'plan:own' }], as('user'));
    expect(stays.cards[2]).toMatchObject({ step: 'not-in-the-plan', area: 'plan:own' });
  });

  it('accepts a card id of the caller, so one request can add a card and then link and place it', async () => {
    const id = randomUUID();
    const { board } = await changeBoard(root, [
      note('Linked at once', { id, position: { x: 40, y: 80 } }),
      { op: 'link', from: id, to: 'checkpoint:reports-export', label: 'about' },
    ], as('user'));
    expect(board.cards[0]!.id).toBe(id);
    expect(board.positions[id]).toEqual({ x: 40, y: 80 });
    expect(board.links).toMatchObject([{ from: id, to: 'checkpoint:reports-export', label: 'about' }]);
    await expect(changeBoard(root, [note('Again', { id })], as('user'))).rejects.toThrow(/already on the board/);
  });

  it('updates a note and a file card, and says who and when', async () => {
    await write('docs/a.pdf');
    const { board: made } = await changeBoard(root, [note('Old', { body: 'old' }), file('docs/a.pdf')], as('claude'));
    const [noteId, fileId] = made.cards.map((c) => c.id) as [string, string];
    const { board } = await changeBoard(root, [
      { op: 'update_card', id: noteId, title: 'New', body: 'new text', pinned: true },
      { op: 'update_card', id: fileId, description: 'Read page 3', archived: true },
    ], as('codex'));
    expect(board.revision).toBe(2);
    expect(board.cards[0]).toMatchObject({ title: 'New', body: 'new text', pinned: true, archived: false, by: 'claude', updatedBy: 'codex' });
    expect(board.cards[1]).toMatchObject({ title: 'a.pdf', description: 'Read page 3', archived: true, updatedBy: 'codex' });
    expect(board.cards[0]!.at).toBe(made.cards[0]!.at);
    expect((await changeBoard(root, [{ op: 'update_card', id: noteId, archived: true }], as('user'))).board.cards[0]!.archived).toBe(true);
  });

  it('refuses an update that names the wrong field for the card, an empty title, or a card that is not there', async () => {
    await write('docs/a.pdf');
    const { board } = await changeBoard(root, [note('Note'), file('docs/a.pdf')], as('user'));
    const [noteId, fileId] = board.cards.map((c) => c.id) as [string, string];
    await expect(changeBoard(root, [{ op: 'update_card', id: fileId, body: 'x' }], as('user'))).rejects.toThrow(/description, not a body/);
    await expect(changeBoard(root, [{ op: 'update_card', id: noteId, description: 'x' }], as('user'))).rejects.toThrow(/body, not a description/);
    await expect(changeBoard(root, [{ op: 'update_card', id: noteId, title: '   ' }], as('user'))).rejects.toThrow(BoardInputError);
    await expect(changeBoard(root, [{ op: 'update_card', id: noteId, title: '\u0007\u0008' }], as('user'))).rejects.toThrow(/title cannot be empty/);
    await expect(changeBoard(root, [{ op: 'update_card', id: noteId }], as('user'))).rejects.toThrow(/at least one thing/);
    await expect(changeBoard(root, [{ op: 'update_card', id: randomUUID(), title: 'x' }], as('user'))).rejects.toThrow(/no card with id/);
    expect((await readBoard(root)).revision).toBe(1);
  });

  it('removes a card with its lines and its place, and keeps everything else', async () => {
    const { board: made } = await changeBoard(root, [note('Keep'), note('Go')], as('user'));
    const [keep, go] = made.cards.map((c) => c.id) as [string, string];
    await changeBoard(root, [
      { op: 'link', from: keep, to: go }, { op: 'link', from: go, to: 'document:7f3c1c6e-3c35-4f0a-9a3d-0b6a2d6f8d11' },
      { op: 'link', from: keep, to: 'checkpoint:a' },
      { op: 'move', nodes: [{ id: keep, x: 1, y: 2 }, { id: go, x: 3, y: 4 }, { id: 'checkpoint:a', x: 5, y: 6 }] },
    ], as('user'));
    const { board } = await changeBoard(root, [{ op: 'remove_card', id: go }], as('user'));
    expect(board.cards.map((c) => c.id)).toEqual([keep]);
    expect(board.links.map((l) => [l.from, l.to])).toEqual([[keep, 'checkpoint:a']]);
    expect(board.positions).toEqual({ [keep]: { x: 1, y: 2 }, 'checkpoint:a': { x: 5, y: 6 } });
    await expect(changeBoard(root, [{ op: 'remove_card', id: go }], as('user'))).rejects.toThrow(/no card with id/);
  });

  it('moves cards and generated nodes, and moves them again', async () => {
    const { board: made } = await changeBoard(root, [note('A')], as('user'));
    const id = made.cards[0]!.id;
    const nodes = [{ id, x: 10, y: 20 }, { id: 'checkpoint:export', x: -5.5, y: 0 }, { id: 'commit:api:abc1234', x: 1, y: 1 }, { id: 'document:7f3c1c6e-3c35-4f0a-9a3d-0b6a2d6f8d11', x: 2, y: 2 }];
    const { board, results } = await changeBoard(root, [{ op: 'move', nodes }], as('user'));
    expect(results).toEqual([{ op: 'move', count: 4 }]);
    expect(board.positions).toEqual({ [id]: { x: 10, y: 20 }, 'checkpoint:export': { x: -5.5, y: 0 }, 'commit:api:abc1234': { x: 1, y: 1 }, 'document:7f3c1c6e-3c35-4f0a-9a3d-0b6a2d6f8d11': { x: 2, y: 2 } });
    expect((await changeBoard(root, [{ op: 'move', nodes: [{ id, x: 99, y: 98 }] }], as('user'))).board.positions[id]).toEqual({ x: 99, y: 98 });
    await expect(changeBoard(root, [{ op: 'move', nodes: [{ id: randomUUID(), x: 1, y: 1 }] }], as('user'))).rejects.toThrow(/no card with id/);
  });

  it('forgets the place of a node when given null for it, and frees room at the limit', async () => {
    const { board: made } = await changeBoard(root, [note('A')], as('user'));
    const id = made.cards[0]!.id;
    await changeBoard(root, [{ op: 'move', nodes: [{ id, x: 1, y: 2 }, { id: 'checkpoint:gone', x: 3, y: 4 }, { id: 'commit:api:abc1234', x: 5, y: 6 }] }], as('user'));
    const { board, results } = await changeBoard(root, [{ op: 'move', nodes: [{ id: 'checkpoint:gone', x: null, y: null }, { id: 'commit:api:abc1234', x: null, y: null }, { id, x: 7, y: 8 }] }], as('claude'));
    expect(board.positions).toEqual({ [id]: { x: 7, y: 8 } });
    expect(results).toEqual([{ op: 'move', count: 3 }]);
    expect((await readBoardChanges(root, 1))[0]).toMatchObject({ action: 'move', by: 'claude', text: 'moved 1 node, forgot 2 places' });
    // Forgetting what is not remembered, or the place of a card that is gone, is not an error: the place is gone either way.
    await changeBoard(root, [{ op: 'move', nodes: [{ id: 'checkpoint:never-placed', x: null, y: null }, { id: randomUUID(), x: null, y: null }] }], as('user'));
    expect((await readBoardChanges(root, 1))[0]!.text).toBe('forgot 2 places');
    // The place is dropped from the file, not set to something.
    expect((await stored()).positions).toEqual({ [id]: { x: 7, y: 8 } });
  });

  it('lets a board that remembers 2000 places move again once some are forgotten', async () => {
    await seed({ positions: Object.fromEntries(Array.from({ length: BOARD_LIMITS.positions }, (_, n) => [`checkpoint:p${n}`, { x: n, y: n }])) });
    await expect(changeBoard(root, [{ op: 'move', nodes: [{ id: 'checkpoint:new', x: 0, y: 0 }] }], as('user'))).rejects.toThrow(/2000 positions/);
    await changeBoard(root, [{ op: 'move', nodes: [{ id: 'checkpoint:p0', x: null, y: null }] }], as('user'));
    expect((await changeBoard(root, [{ op: 'move', nodes: [{ id: 'checkpoint:new', x: 0, y: 0 }] }], as('user'))).board.positions['checkpoint:new']).toEqual({ x: 0, y: 0 });
    // In one request, in order: forgetting first makes room for the node after it.
    await expect(changeBoard(root, [{ op: 'move', nodes: [{ id: 'checkpoint:another', x: 1, y: 1 }] }], as('user'))).rejects.toThrow(/2000 positions/);
    const { board } = await changeBoard(root, [{ op: 'move', nodes: [{ id: 'checkpoint:p1', x: null, y: null }, { id: 'checkpoint:another', x: 1, y: 1 }] }], as('user'));
    expect(Object.keys(board.positions)).toHaveLength(BOARD_LIMITS.positions);
  });

  it.each([
    ['only x null', { x: null, y: 1 }],
    ['only y null', { x: 1, y: null }],
    ['x missing', { y: 1 }],
    ['null that is text', { x: 'null', y: 'null' }],
  ])('refuses a node with %s', async (_name, coordinates) => {
    await expect(changeBoard(root, [{ op: 'move', nodes: [{ id: 'checkpoint:a', ...coordinates }] }], as('user'))).rejects.toThrow(/nodes\.0/);
    await expect(fs.access(boardPath())).rejects.toThrow();
  });

  it('links two things and unlinks them, by id or by both ends', async () => {
    const { board: made } = await changeBoard(root, [note('A'), note('B')], as('user'));
    const [a, b] = made.cards.map((c) => c.id) as [string, string];
    const { board, results } = await changeBoard(root, [
      { op: 'link', from: a, to: b, label: '  blocks  ' }, { op: 'link', from: a, to: 'checkpoint:export' },
      { op: 'link', from: 'commit:api:abc1234', to: a },
    ], as('claude'));
    expect(board.links).toMatchObject([{ from: a, to: b, label: 'blocks', by: 'claude' }, { from: a, to: 'checkpoint:export' }, { from: 'commit:api:abc1234', to: a }]);
    expect(Object.keys(board.links[1]!)).not.toContain('label');
    const first = results[0]!.id!;
    const afterId = await changeBoard(root, [{ op: 'unlink', id: first }], as('user'));
    expect(afterId.board.links).toHaveLength(2);
    const afterEnds = await changeBoard(root, [{ op: 'unlink', from: a, to: 'checkpoint:export' }], as('user'));
    expect(afterEnds.board.links.map((l) => l.from)).toEqual(['commit:api:abc1234']);
    await expect(changeBoard(root, [{ op: 'unlink', id: first }], as('user'))).rejects.toThrow(/no such link/);
    await expect(changeBoard(root, [{ op: 'unlink', from: a, to: b }], as('user'))).rejects.toThrow(/no such link/);
  });

  it('checks the shape of a link end, and a card end must be a card on the board', async () => {
    const { board } = await changeBoard(root, [note('A')], as('user'));
    const a = board.cards[0]!.id;
    await expect(changeBoard(root, [{ op: 'link', from: a, to: 'whatever' }], as('user'))).rejects.toThrow(/not a board node id/);
    await expect(changeBoard(root, [{ op: 'link', from: a, to: a }], as('user'))).rejects.toThrow(/two different ends/);
    await expect(changeBoard(root, [{ op: 'link', from: a, to: randomUUID() }], as('user'))).rejects.toThrow(/no card with id/);
    // A generated node is only checked for its shape: it may have gone from the board for now.
    await changeBoard(root, [{ op: 'link', from: a, to: 'checkpoint:not-in-the-plan-any-more' }], as('user'));
    await expect(changeBoard(root, [{ op: 'link', from: a, to: 'checkpoint:not-in-the-plan-any-more' }], as('user'))).rejects.toThrow(/already linked/);
    // The other way round is another line.
    await changeBoard(root, [{ op: 'link', from: 'checkpoint:not-in-the-plan-any-more', to: a }], as('user'));
    expect((await readBoard(root)).links).toHaveLength(2);
  });
});

describe('validation and limits', () => {
  it.each([
    ['a note without a title', note('', {}), /Change 1, title/],
    ['a title over the limit', note('x'.repeat(BOARD_LIMITS.title + 1)), /title/],
    ['a body over the limit', note('x', { body: 'y'.repeat(BOARD_LIMITS.body + 1) }), /body/],
    ['a path on a note', note('x', { path: 'a.md' }), /no path/],
    ['a description on a note', note('x', { description: 'd' }), /body, not a description/],
    ['a file card without a path', { op: 'add_card', kind: 'file', title: 'x' }, /needs the path/],
    ['a body on a file card', file('a.md', { body: 'b' }), /description, not a body/],
    ['a description over the limit', file('a.md', { description: 'd'.repeat(BOARD_LIMITS.description + 1) }), /description/],
    ['a kind that does not exist', { op: 'add_card', kind: 'drawing', title: 'x' }, /kind/],
    ['a field that does not exist', note('x', { colour: 'red' }), /colour/],
    ['an id that is not a uuid', note('x', { id: 'card-1' }), /uuid/],
    ['an operation that does not exist', { op: 'explode' }, /"op" must be one of/],
    ['a change that is not an object', 'add a card', /"op" must be one of/],
    ['a label over the limit', { op: 'link', from: 'checkpoint:a', to: 'checkpoint:b', label: 'l'.repeat(BOARD_LIMITS.label + 1) }, /label/],
    ['a position that is far too large', { op: 'move', nodes: [{ id: 'checkpoint:a', x: BOARD_LIMITS.coordinate + 1, y: 0 }] }, /nodes\.0\.x/],
    ['a position that is not finite', { op: 'move', nodes: [{ id: 'checkpoint:a', x: Infinity, y: 0 }] }, /nodes\.0\.x/],
    ['a position that is not a number', { op: 'move', nodes: [{ id: 'checkpoint:a', x: Number.NaN, y: 0 }] }, /nodes\.0\.x/],
    ['a position that is text', { op: 'move', nodes: [{ id: 'checkpoint:a', x: '4', y: 0 }] }, /nodes\.0\.x/],
    ['a move of nothing', { op: 'move', nodes: [] }, /nodes/],
    ['a move to a node that has no valid id', { op: 'move', nodes: [{ id: 'banner', x: 0, y: 0 }] }, /not a board node id/],
    ['an unlink of nothing', { op: 'unlink' }, /by its id, or by both/],
    ['an unlink of an id and an end', { op: 'unlink', id: randomUUID(), from: 'checkpoint:a' }, /by its id, or by both/],
    ['an unlink of one end', { op: 'unlink', from: 'checkpoint:a' }, /by its id, or by both/],
  ])('refuses %s, and says which change and field', async (_name, change, message) => {
    await expect(changeBoard(root, [change], as('user'))).rejects.toThrow(BoardInputError);
    await expect(changeBoard(root, [change], as('user'))).rejects.toThrow(message);
    await expect(fs.access(boardPath())).rejects.toThrow();
  });

  it('names the change in a list that is wrong', () => {
    expect(() => parseBoardChanges([note('fine'), note('')])).toThrow(/^Change 2, title/);
  });

  it('wants at least one change and at most a hundred', async () => {
    await expect(changeBoard(root, [], as('user'))).rejects.toThrow(/at least one change/);
    await expect(changeBoard(root, undefined, as('user'))).rejects.toThrow(/at least one change/);
    await expect(changeBoard(root, Array.from({ length: BOARD_LIMITS.changes + 1 }, (_, n) => note(`n${n}`)), as('user'))).rejects.toThrow(/At most 100/);
    expect((await changeBoard(root, Array.from({ length: BOARD_LIMITS.changes }, (_, n) => note(`n${n}`)), as('user'))).board.cards).toHaveLength(100);
  });

  it('cuts nothing silently: text over a limit is refused, and exactly at the limit is kept whole', async () => {
    const title = 'T'.repeat(BOARD_LIMITS.title);
    const body = 'b'.repeat(BOARD_LIMITS.body);
    const { board } = await changeBoard(root, [note(title, { body })], as('user'));
    expect(board.cards[0]).toMatchObject({ title, body });
  });

  it('keeps at most 500 cards, 1000 links and 2000 positions, and says so', async () => {
    const cards = Array.from({ length: BOARD_LIMITS.cards }, (_, n) => card(n));
    const links = Array.from({ length: BOARD_LIMITS.links }, (_, n) => ({ id: randomUUID(), from: cards[n % cards.length]!.id, to: `checkpoint:c${n}`, by: 'user', at: '2026-10-01T10:00:00.000Z' }));
    const positions = Object.fromEntries(Array.from({ length: BOARD_LIMITS.positions }, (_, n) => [`checkpoint:p${n}`, { x: n, y: n }]));
    await seed({ cards, links, positions });
    const before = await fs.readFile(boardPath(), 'utf8');

    await expect(changeBoard(root, [note('one too many')], as('user'))).rejects.toThrow(/at most 500 cards/);
    await expect(changeBoard(root, [{ op: 'link', from: cards[0]!.id, to: 'checkpoint:one-more' }], as('user'))).rejects.toThrow(/1000 links/);
    await expect(changeBoard(root, [{ op: 'move', nodes: [{ id: 'checkpoint:new', x: 0, y: 0 }] }], as('user'))).rejects.toThrow(/2000 positions/);
    expect(await fs.readFile(boardPath(), 'utf8')).toBe(before);

    // Moving what is already remembered is not a new position, and removing makes room.
    await changeBoard(root, [{ op: 'move', nodes: [{ id: 'checkpoint:p0', x: -1, y: -1 }] }], as('user'));
    await changeBoard(root, [{ op: 'remove_card', id: cards[0]!.id }, note('room again')], as('user'));
    expect((await readBoard(root)).cards).toHaveLength(BOARD_LIMITS.cards);
  });

  it('does not let a hand-edited file make the board bigger than its limits', async () => {
    await seed({
      cards: Array.from({ length: BOARD_LIMITS.cards + 20 }, (_, n) => card(n)),
      positions: Object.fromEntries(Array.from({ length: BOARD_LIMITS.positions + 50 }, (_, n) => [`checkpoint:p${n}`, { x: n, y: n }])),
    });
    const board = await readBoard(root);
    expect(board.cards).toHaveLength(BOARD_LIMITS.cards);
    expect(Object.keys(board.positions)).toHaveLength(BOARD_LIMITS.positions);
  });
});

describe('file cards', () => {
  // A folder of its own for each test, beside the workspace, holding the file that must stay out of reach.
  let outside: string;
  beforeEach(async () => {
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-outside-')));
    await write('docs/overview.html', '<p>ok</p>');
    await write('notes.md', 'fine');
    await write('src/main.ts', 'export {}');
    await write('.git/config.md', 'inside git');
    await write('.contextspace/chat.md', 'private');
    await write('.env.md', 'secret');
    await fs.mkdir(path.join(root, 'a-folder'));
    await fs.writeFile(path.join(outside, 'secret.md'), 'secret');
    await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'linked-file.md'));
    await fs.symlink(path.join(root, 'docs'), path.join(root, 'linked-folder'));
    await fs.symlink(outside, path.join(root, 'linked-out'));
  });
  afterEach(async () => { await fs.rm(outside, { recursive: true, force: true }); });

  // `{secret}` stands for the file outside the workspace, and `{climb}` for the way up and out to it.
  const where = (given: string) => given
    .replace('{secret}', path.join(outside, 'secret.md'))
    .replace('{climb}', path.relative(root, path.join(outside, 'secret.md')).split(path.sep).join('/'));

  it.each([
    ['an absolute path', '{secret}', /not inside the workspace/],
    ['an absolute path to a file inside the workspace', '/notes.md', /not inside the workspace/],
    ['a path from the root of a drive', 'C:/Windows/notes.md', /not inside the workspace/],
    ['a Windows path from the root', '\\notes.md', /not inside the workspace/],
    ['a path that climbs', '{climb}', /inside this workspace/],
    ['a path that climbs from inside', 'docs/../{climb}', /inside this workspace/],
    ['a path that climbs and returns', 'docs/../notes.md', /inside this workspace/],
    ['a path with an empty part', 'docs//overview.html', /inside this workspace/],
    ['a path with a dot part', './notes.md', /inside this workspace/],
    ['a file that is a link', 'linked-file.md', /link/],
    ['a file in a folder that is a link', 'linked-folder/overview.html', /link/],
    ['a file that is reached through a link out of the workspace', 'linked-out/secret.md', /link/],
    ['a hidden folder', '.git/config.md', /Hidden files and folders/],
    ['the ContextSpace folder', '.contextspace/chat.md', /Hidden files and folders/],
    ['a hidden file', '.env.md', /Hidden files and folders/],
    ['a file that is not there', 'docs/missing.html', /no file "docs\/missing.html"/],
    ['a folder where a file should be', 'a-folder', /can't be opened|folder/],
    ['a folder with a name the panel would open', 'docs', /can't be opened|folder/],
    ['a kind of file the documents panel cannot open', 'src/main.ts', /can't be opened here/],
    ['a name with a stream or a control character', 'notes.md:stream', /inside this workspace/],
    ['an empty path', '  ', /path/],
    ['a path that is too long', `${'d/'.repeat(600)}x.md`, /path/],
  ])('refuses %s', async (_name, filePath, message) => {
    await expect(changeBoard(root, [file(where(filePath))], as('claude'))).rejects.toThrow(message);
    await expect(fs.access(boardPath())).rejects.toThrow();
  });

  it('keeps a card whose file has gone, and needs the file only when a card is made', async () => {
    await changeBoard(root, [file('notes.md')], as('claude'));
    await fs.rm(path.join(root, 'notes.md'));
    // The file may come back, so the card stays.
    expect((await readBoard(root)).cards).toHaveLength(1);
    await expect(changeBoard(root, [file('notes.md')], as('claude'))).rejects.toThrow(/no file/);
  });

  it('keeps nothing of a list when one file card in it is refused', async () => {
    await expect(changeBoard(root, [note('fine'), file('notes.md'), file(where('{climb}'))], as('claude'))).rejects.toThrow();
    await expect(fs.access(boardPath())).rejects.toThrow();
  });
});

describe('who changed what, and when', () => {
  it('keeps the latest 300 changes in a log beside the board, newest first, naming who made each', async () => {
    const lines = Array.from({ length: BOARD_CHANGES_KEPT - 1 }, (_, n) => JSON.stringify({ at: '2026-10-01T10:00:00.000Z', by: 'old', revision: n, action: 'add_card', id: randomUUID(), text: `old ${n}` }));
    await fs.mkdir(path.join(root, '.contextspace'), { recursive: true });
    await fs.writeFile(path.join(root, '.contextspace', 'board-changes.jsonl'), `${lines.join('\n')}\n`);

    const { board } = await changeBoard(root, [note('One'), note('Two')], as('claude'));
    await changeBoard(root, [{ op: 'move', nodes: [{ id: board.cards[0]!.id, x: 1, y: 2 }, { id: 'checkpoint:a', x: 3, y: 4 }] }], as('user'));

    const log = await readBoardChanges(root, 1000);
    expect(log).toHaveLength(BOARD_CHANGES_KEPT);
    expect(log.slice(0, 3)).toMatchObject([
      { by: 'user', revision: 2, action: 'move', id: board.cards[0]!.id, text: 'moved 2 nodes' },
      { by: 'claude', revision: 1, action: 'add_card', text: 'Two' },
      { by: 'claude', revision: 1, action: 'add_card', text: 'One' },
    ]);
    expect(log.at(-1)).toMatchObject({ by: 'old', text: 'old 2' });
    expect(await readBoardChanges(root, 2)).toHaveLength(2);
  });

  it('rebuilds log lines field by field and skips the ones that cannot be read', async () => {
    const good = { at: '2026-10-01T10:00:00.000Z', by: 'user', revision: 1, action: 'link', id: 'x', text: 'ok' };
    await fs.mkdir(path.join(root, '.contextspace'), { recursive: true });
    await fs.writeFile(path.join(root, '.contextspace', 'board-changes.jsonl'), [
      'garbage', '{"at":"nope"}', JSON.stringify({ ...good, action: 'delete_everything' }), JSON.stringify({ ...good, revision: 'one' }),
      JSON.stringify({ ...good, by: '' }), JSON.stringify({ ...good, id: 7 }), JSON.stringify({ ...good, secret: 'dropped' }),
    ].join('\n'));
    expect(await readBoardChanges(root)).toEqual([good]);
  });

  it('still makes the change when the log cannot be written', async () => {
    await fs.mkdir(path.join(root, '.contextspace', 'board-changes.jsonl'), { recursive: true });
    const { board } = await changeBoard(root, [note('Saved anyway')], as('user'));
    expect(board.revision).toBe(1);
    expect((await stored()).cards[0]!.title).toBe('Saved anyway');
  });

  it('records the name of the tool that made a change in a plain form, and "ai" when there is none', async () => {
    const { board } = await changeBoard(root, [note('A')], as('  Claude\u0007 Code  '));
    expect(board.cards[0]!.by).toBe('claude-code');
    expect((await changeBoard(root, [note('B')], { by: '' })).board.cards[1]!.by).toBe('ai');
    expect((await changeBoard(root, [note('C')], as('n'.repeat(100)))).board.cards[2]!.by).toHaveLength(40);
  });

  it.each([
    ['a name with a zero-width space', 'user\u200b', 'user'],
    ['a name that starts with a right-to-left override', '\u202euser', 'user'],
    ['a name with a letter that only looks like another', 'us\u0435r', 'us-r'],
    ['a name with a full-width letter', '\uff55ser', 'ser'],
    ['a name with a combining mark', 'use\u0301r', 'use-r'],
    ['a name padded with separators', '..-_Claude_-..', 'claude'],
    ['a name with spaces and capitals', 'My Tool  v2', 'my-tool-v2'],
    ['a name of nothing but symbols', '\u202e\u200b!!', undefined],
    ['not a name at all', 42, undefined],
  ])('writes %s as a plain name, so it cannot read as another', (_name, given, expected) => {
    expect(boardActorName(given)).toBe(expected);
  });

  it('keeps what a look-alike or hidden character would have hidden, as the name that is really there', async () => {
    const { board } = await changeBoard(root, [note('A')], as('us\u0435r'));
    expect(board.cards[0]!.by).toBe('us-r');
    await seed({ cards: [{ ...card(1), by: 'user\u200b', updatedBy: '\u202euser' }] });
    expect((await readBoard(root)).cards[0]).toMatchObject({ by: 'user', updatedBy: 'user' });
  });

  it('writes a line for the live feed by the person for what the app did, and by the agent for the rest', async () => {
    await changeBoard(root, [note('A')], as('claude'));
    await changeBoard(root, [note('B')], as('user'));
    const ledger = (await fs.readFile(path.join(root, '.contextspace', BOARD_EVENTS_FILE), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(ledger.map((line) => [line.harness, line.author, line.event])).toEqual([['claude', 'agent', 'board'], ['user', 'human', 'board']]);
  });
});

describe('two writers', () => {
  it('keeps both when they change different things at once', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, n) => changeBoard(root, [note(`Card ${n}`)], as(n % 2 ? 'claude' : 'user'))));
    const board = await readBoard(root);
    expect(board.cards).toHaveLength(12);
    expect(new Set(board.cards.map((c) => c.title)).size).toBe(12);
    expect(board.revision).toBe(12);
    expect(results.map((r) => r.board.revision).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, n) => n + 1));
  });

  it('applies a change to the board as it is when the lock is taken, not as the writer last saw it', async () => {
    const { board } = await changeBoard(root, [note('A')], as('user'));
    const id = board.cards[0]!.id;
    await Promise.all([
      changeBoard(root, [{ op: 'update_card', id, title: 'Renamed' }], as('claude')),
      changeBoard(root, [{ op: 'update_card', id, pinned: true }], as('user')),
      changeBoard(root, [{ op: 'move', nodes: [{ id, x: 5, y: 6 }] }], as('codex')),
      changeBoard(root, [note('B')], as('user')),
    ]);
    const after = await readBoard(root);
    expect(after.cards[0]).toMatchObject({ title: 'Renamed', pinned: true });
    expect(after.positions[id]).toEqual({ x: 5, y: 6 });
    expect(after.cards).toHaveLength(2);
  });

  it('waits for another process that holds the lock, then goes on and keeps what that process wrote meanwhile', async () => {
    const release = await acquireLock(path.join(root, '.contextspace', 'board.lock'), { staleMs: 60_000, timeoutMs: 1000, timeoutMessage: 'held' });
    let done = false;
    const pending = changeBoard(root, [note('Waited')], as('user')).then((result) => { done = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(done).toBe(false);
    await expect(fs.access(boardPath())).rejects.toThrow();
    // The holder writes a card while the change waits; a change that read the board before the lock would drop it.
    const theirs = card(1);
    await seed({ revision: 1, cards: [theirs] });
    await release();
    const { board } = await pending;
    expect(board.cards.map((c) => c.title)).toEqual(['Card 1', 'Waited']);
    expect(board.revision).toBe(2);
    expect((await stored()).cards).toHaveLength(2);
  });

  it('does not make the boards of different workspaces wait for each other', async () => {
    const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-core-other-')));
    try {
      await fs.writeFile(path.join(other, 'contextspace.json'), JSON.stringify({ id: 'other', name: 'Other', branchName: 'other', repos: [], assistants: [], workspacePath: other }));
      const release = await acquireLock(path.join(root, '.contextspace', 'board.lock'), { staleMs: 60_000, timeoutMs: 1000, timeoutMessage: 'held' });
      const blocked = changeBoard(root, [note('Blocked')], as('user'));
      const free = await changeBoard(other, [note('Free')], as('user'));
      expect(free.board.cards[0]!.title).toBe('Free');
      await release();
      expect((await blocked).board.cards[0]!.title).toBe('Blocked');
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it('refuses a change made on a stale revision, and changes nothing', async () => {
    const first = await changeBoard(root, [note('One')], as('user'));
    expect(first.board.revision).toBe(1);
    await changeBoard(root, [note('Two')], as('claude'));
    const stale = changeBoard(root, [note('Three')], as('user', 1));
    await expect(stale).rejects.toBeInstanceOf(BoardConflictError);
    await expect(stale).rejects.toThrow(/revision 2, not 1/);
    expect((await readBoard(root)).cards.map((c) => c.title)).toEqual(['One', 'Two']);
    expect((await changeBoard(root, [note('Three')], as('user', 2))).board.revision).toBe(3);
    // Revision 0 is a revision too: it is only right for a board nobody has changed.
    await expect(changeBoard(root, [note('Four')], as('user', 0))).rejects.toBeInstanceOf(BoardConflictError);
  });

  it('accepts revision 0 for a board that has no file yet', async () => {
    expect((await changeBoard(root, [note('First')], as('user', 0))).board.revision).toBe(1);
  });
});

describe('a list of changes', () => {
  it('is applied in order, so a later change can use an earlier one', async () => {
    const id = randomUUID();
    const { board, results } = await changeBoard(root, [note('A', { id }), { op: 'update_card', id, title: 'B' }, { op: 'remove_card', id }, note('C')], as('user'));
    expect(board.cards.map((c) => c.title)).toEqual(['C']);
    expect(results.map((r) => r.op)).toEqual(['add_card', 'update_card', 'remove_card', 'add_card']);
    expect(board.revision).toBe(1);
  });

  it('is applied all or none: a change that fails undoes the ones before it', async () => {
    const { board } = await changeBoard(root, [note('Existing')], as('user'));
    const before = await fs.readFile(boardPath(), 'utf8');
    const logBefore = await readBoardChanges(root);
    await expect(changeBoard(root, [
      note('Would be added'),
      { op: 'update_card', id: board.cards[0]!.id, title: 'Would be renamed' },
      { op: 'remove_card', id: randomUUID() },
    ], as('user'))).rejects.toThrow(/no card with id/);
    expect(await fs.readFile(boardPath(), 'utf8')).toBe(before);
    expect(await readBoardChanges(root)).toEqual(logBefore);
    expect(await listBoardEvents(root)).toHaveLength(1);
  });

  it('leaves the file as it was when writing it fails', async () => {
    const { board } = await changeBoard(root, [note('Existing')], as('user'));
    const before = await fs.readFile(boardPath(), 'utf8');
    vi.spyOn(storage, 'writeWorkspaceFile').mockRejectedValueOnce(new Error('disk full'));
    await expect(changeBoard(root, [note('Lost')], as('user'))).rejects.toThrow('disk full');
    expect(await fs.readFile(boardPath(), 'utf8')).toBe(before);
    // And the board is not stuck: the lock was let go.
    expect((await changeBoard(root, [note('Next')], as('user'))).board.revision).toBe(board.revision + 1);
  });
});

describe('archived and missing workspaces', () => {
  it('refuses every change in an archived workspace, and still reads', async () => {
    await changeBoard(root, [note('Before')], as('user'));
    await fs.writeFile(path.join(root, 'contextspace.json'), manifest({ archivedAt: '2026-09-28T10:00:00.000Z' }));
    const before = await fs.readFile(boardPath(), 'utf8');
    await expect(changeBoard(root, [note('After')], as('user'))).rejects.toBeInstanceOf(ArchivedWorkspaceError);
    await expect(changeBoard(root, [note('After')], as('user'))).rejects.toThrow(/archived/);
    expect(await fs.readFile(boardPath(), 'utf8')).toBe(before);
    expect((await readBoard(root)).cards.map((c) => c.title)).toEqual(['Before']);
  });

  it('tells a workspace that has gone from a request that is wrong, and both from a failure', async () => {
    await expect(changeBoard(root, [{ op: 'remove_card', id: randomUUID() }], as('user'))).rejects.toBeInstanceOf(BoardChangeError);
    await expect(changeBoard(root, [file('docs/missing.html')], as('user'))).rejects.toBeInstanceOf(BoardChangeError);
    await expect(changeBoard(root, [file('../escape.md')], as('user'))).rejects.toBeInstanceOf(BoardChangeError);
    await expect(changeBoard(root, [note('')], as('user'))).rejects.toBeInstanceOf(BoardInputError);

    await fs.rm(path.join(root, 'contextspace.json'));
    await expect(changeBoard(root, [note('x')], as('user'))).rejects.toBeInstanceOf(BoardWorkspaceError);
    await fs.rm(root, { recursive: true, force: true });
    await expect(changeBoard(root, [note('x')], as('user'))).rejects.toBeInstanceOf(BoardWorkspaceError);
    await expect(readBoard(root)).rejects.toBeInstanceOf(BoardWorkspaceError);
  });

  it('does not call a failure to write a refused change', async () => {
    vi.spyOn(storage, 'writeWorkspaceFile').mockRejectedValueOnce(new Error('disk full'));
    const failure = await changeBoard(root, [note('x')], as('user')).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    for (const kind of [BoardChangeError, BoardInputError, BoardConflictError, BoardFileError, BoardWorkspaceError, ArchivedWorkspaceError]) expect(failure).not.toBeInstanceOf(kind);
  });

  it('writes no board into a folder that is not a workspace', async () => {
    await fs.rm(path.join(root, 'contextspace.json'));
    await expect(changeBoard(root, [note('x')], as('user'))).rejects.toThrow(/Workspace not found/);
    await expect(fs.access(boardPath())).rejects.toThrow();
  });
});

describe('telling open screens', () => {
  it('appends a board event for each change request, naming who made it', async () => {
    await changeBoard(root, [note('A'), note('B')], as('claude'));
    await changeBoard(root, [note('C')], as('user'));
    const events = await listBoardEvents(root);
    expect(events.map((event) => [event.harness, event.payload])).toEqual([['claude', { revision: 1, changes: 2 }], ['user', { revision: 2, changes: 1 }]]);
  });

  it('says nothing when the change is refused', async () => {
    await expect(changeBoard(root, [note('')], as('user'))).rejects.toThrow();
    await expect(changeBoard(root, [{ op: 'remove_card', id: randomUUID() }], as('user'))).rejects.toThrow();
    expect(await listBoardEvents(root)).toEqual([]);
    expect(await listScreenEvents(root)).toEqual([]);
  });

  it('does not fail a change that was made because no screen could be told', async () => {
    // The ledger is a folder, so nothing can be appended to it.
    await fs.mkdir(path.join(root, '.contextspace', BOARD_EVENTS_FILE), { recursive: true });
    const { board } = await changeBoard(root, [note('Made anyway')], as('user'));
    expect(board.revision).toBe(1);
    expect((await readBoard(root)).cards[0]!.title).toBe('Made anyway');
  });
});
