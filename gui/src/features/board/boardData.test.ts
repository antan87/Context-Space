import { describe, expect, it } from 'vitest';
import { BOARD_DATA_LIMITS, cleanBoard, cleanCardPath, isBoardAreaId, isBoardNodeId } from './boardData.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-10-23T09:00:00.000Z';
const note = (n: number, fields: Record<string, unknown> = {}) => ({ id: uuid(n), kind: 'note', title: `Note ${n}`, body: 'Text.', pinned: false, archived: false, by: 'claude', at: AT, updatedBy: 'user', updatedAt: '2026-10-23T09:05:00.000Z', ...fields });
const file = (n: number, fields: Record<string, unknown> = {}) => ({ id: uuid(n), kind: 'file', title: `File ${n}`, path: 'docs/overview.html', description: 'See it.', pinned: true, archived: false, by: 'codex', at: AT, updatedBy: 'codex', updatedAt: AT, ...fields });
const link = (n: number, fields: Record<string, unknown> = {}) => ({ id: uuid(900 + n), from: uuid(1), to: 'checkpoint:reports-export-to-csv', label: 'found while', by: 'claude', at: AT, ...fields });
const reply = (fields: Record<string, unknown> = {}) => ({ version: 1, revision: 12, cards: [], links: [], positions: {}, ...fields });

describe('cleanBoard', () => {
  it('reads a board as the backend sends it', () => {
    const board = cleanBoard(reply({
      cards: [note(1), file(2)], links: [link(1)],
      positions: { [uuid(1)]: { x: 120, y: 40 }, 'checkpoint:reports-export-to-csv': { x: 400, y: 0 } },
    }));
    expect(board.revision).toBe(12);
    expect(board.cards).toEqual([
      { id: uuid(1), kind: 'note', title: 'Note 1', body: 'Text.', pinned: false, archived: false, by: 'claude', at: AT, updatedBy: 'user', updatedAt: '2026-10-23T09:05:00.000Z' },
      { id: uuid(2), kind: 'file', title: 'File 2', path: 'docs/overview.html', description: 'See it.', pinned: true, archived: false, by: 'codex', at: AT, updatedBy: 'codex', updatedAt: AT },
    ]);
    expect(board.links).toEqual([{ id: uuid(901), from: uuid(1), to: 'checkpoint:reports-export-to-csv', label: 'found while', by: 'claude', at: AT }]);
    expect(board.positions).toEqual({ [uuid(1)]: { x: 120, y: 40 }, 'checkpoint:reports-export-to-csv': { x: 400, y: 0 } });
  });

  it('refuses a reply that is not a board, so an older backend is not read as an empty one', () => {
    for (const raw of [null, undefined, 'x', 7, [], {}, { cards: [] }, { revision: 1 }, { revision: '1', cards: [] }, { revision: -1, cards: [] }, { revision: 1.5, cards: [] }, { revision: 1, cards: {} }]) {
      expect(() => cleanBoard(raw), JSON.stringify(raw)).toThrow(/does not read/);
    }
  });

  it('takes an empty board, and a reply with no lines or places', () => {
    expect(cleanBoard(reply())).toEqual({ revision: 12, cards: [], links: [], positions: {} });
    expect(cleanBoard({ revision: 0, cards: [] })).toEqual({ revision: 0, cards: [], links: [], positions: {} });
    expect(cleanBoard({ revision: 0, cards: [], links: 'x', positions: [] })).toEqual({ revision: 0, cards: [], links: [], positions: {} });
  });

  it('drops a card that is not usable, and keeps the rest', () => {
    const bad: unknown[] = [
      null, 'x', 7, [], {},
      note(3, { id: 'checkpoint:build-it' }), note(4, { id: 'not-a-uuid' }), note(5, { id: undefined }),
      note(6, { title: '' }), note(7, { title: '   ' }), note(8, { title: 5 }), note(9, { kind: 'drawing' }), note(10, { kind: undefined }),
      note(11, { by: 'Claude Code' }), note(12, { by: '' }), note(13, { by: 7 }), note(14, { at: 'yesterday' }), note(15, { at: 7 }),
      file(16, { path: '/etc/passwd' }), file(17, { path: '../secret.png' }), file(18, { path: 'a/../b.png' }), file(19, { path: 'C:\\x.png' }), file(20, { path: '' }), file(21, { path: 7 }),
    ];
    const board = cleanBoard(reply({ cards: [note(1), ...bad, file(2)] }));
    expect(board.cards.map((card) => card.id)).toEqual([uuid(1), uuid(2)]);
  });

  it('rebuilds a card from its known fields only', () => {
    const [card] = cleanBoard(reply({ cards: [{ ...note(1), body: 7, pinned: 'yes', archived: 1, extra: '<script>', updatedBy: 'No One', updatedAt: 'later' }] })).cards;
    expect(card).toEqual({ id: uuid(1), kind: 'note', title: 'Note 1', body: '', pinned: false, archived: false, by: 'claude', at: AT, updatedBy: 'claude', updatedAt: AT });
    expect(Object.keys(card)).not.toContain('extra');
  });

  it('preserves valid area and drops invalid area', () => {
    const validCheckpoint = note(1, { area: 'checkpoint:reports-export' });
    const validPlanOwn = file(2, { area: 'plan:own' });
    const badEmpty = note(3, { area: '' });
    const badLane = note(4, { area: 'lane:documents' });
    const badNull = note(5, { area: null });
    const badNum = note(6, { area: 7 });
    const badUuid = note(7, { area: uuid(99) });
    const noArea = note(8);

    const board = cleanBoard(reply({
      cards: [validCheckpoint, validPlanOwn, badEmpty, badLane, badNull, badNum, badUuid, noArea],
    }));

    expect(board.cards).toHaveLength(8);
    expect(board.cards[0].area).toBe('checkpoint:reports-export');
    expect(board.cards[1].area).toBe('plan:own');
    for (let i = 2; i < 8; i++) {
      expect('area' in board.cards[i]).toBe(false);
      expect(board.cards[i].area).toBeUndefined();
      expect(Object.keys(board.cards[i])).not.toContain('area');
    }
  });

  it('cuts text to the limits, and keeps a card with no text', () => {
    const [long, bare] = cleanBoard(reply({ cards: [note(1, { title: 'T'.repeat(500), body: 'B'.repeat(9000) }), note(2, { body: undefined })] })).cards;
    expect(long.title).toHaveLength(BOARD_DATA_LIMITS.title);
    expect(long.kind === 'note' && long.body).toHaveLength(BOARD_DATA_LIMITS.text);
    expect(bare.kind === 'note' && bare.body).toBe('');
  });

  it('keeps a card once, and the file path in its plain form', () => {
    const board = cleanBoard(reply({ cards: [note(1), note(1, { title: 'Again' }), file(2, { path: ' docs\\pics\\flow.png ' })] }));
    expect(board.cards.map((card) => card.title)).toEqual(['Note 1', 'File 2']);
    expect(board.cards[1].kind === 'file' && board.cards[1].path).toBe('docs/pics/flow.png');
  });

  it('drops a line that is not usable', () => {
    const bad: unknown[] = [
      null, 7, link(2, { id: 'x' }), link(3, { from: 'somewhere' }), link(4, { to: '' }), link(5, { from: uuid(1), to: uuid(1) }), link(6, { by: 'A B' }), link(7, { at: 'x' }),
      link(8, { to: 'commit:api:abc' }), link(9, { from: 'document:not-a-uuid' }),
    ];
    const board = cleanBoard(reply({ links: [link(1), ...bad, link(1, { label: 'a repeat' }), link(10, { label: '   ' }), link(11, { label: 'x'.repeat(500), to: `document:${uuid(5)}` }), link(12, { to: 'commit:billing api:a91f2e0#2' })] }));
    expect(board.links.map((entry) => entry.id)).toEqual([uuid(901), uuid(910), uuid(911), uuid(912)]);
    expect(board.links[1].label).toBeUndefined();
    expect(board.links[2].label).toHaveLength(BOARD_DATA_LIMITS.label);
  });

  it('drops a place that is not usable', () => {
    // Parsed, not written out, so that `__proto__` is a key of its own, as it is in a reply.
    const positions = JSON.parse(JSON.stringify({
      [uuid(1)]: { x: 1, y: 2 }, 'checkpoint:ok': { x: -1e6, y: 1e6 }, [`document:${uuid(2)}`]: { x: 0.5, y: -0.5 },
      'checkpoint:far': { x: 1_000_001, y: 0 }, 'checkpoint:nan': { x: null, y: 0 }, 'checkpoint:text': { x: '1', y: 2 }, 'checkpoint:one': { x: 1 }, 'checkpoint:no': null,
      'checkpoint:array': [1, 2], 'not a node': { x: 1, y: 1 }, constructor: { x: 1, y: 1 }, 'commit:api:short': { x: 1, y: 1 },
    }).replace('{', '{"__proto__":{"x":1,"y":1},'));
    expect(Object.keys(positions)).toContain('__proto__');
    const board = cleanBoard(reply({ positions }));
    expect(Object.keys(board.positions).sort()).toEqual([uuid(1), 'checkpoint:ok', `document:${uuid(2)}`].sort());
    expect(Object.getPrototypeOf(board.positions)).toBe(Object.prototype);
  });

  it('keeps no more than the board allows', () => {
    const cards = Array.from({ length: BOARD_DATA_LIMITS.cards + 5 }, (_, index) => note(index + 1));
    const links = Array.from({ length: BOARD_DATA_LIMITS.links + 5 }, (_, index) => link(index + 1, { id: uuid(5000 + index) }));
    const positions = Object.fromEntries(Array.from({ length: BOARD_DATA_LIMITS.positions + 5 }, (_, index) => [`checkpoint:c${index}`, { x: index, y: 0 }]));
    const board = cleanBoard(reply({ cards, links, positions }));
    expect(board.cards).toHaveLength(BOARD_DATA_LIMITS.cards);
    expect(board.links).toHaveLength(BOARD_DATA_LIMITS.links);
    expect(Object.keys(board.positions)).toHaveLength(BOARD_DATA_LIMITS.positions);
  });
});

describe('isBoardNodeId', () => {
  it('knows the shapes the backend accepts', () => {
    for (const id of [uuid(1), 'checkpoint:reports-export-to-csv', 'checkpoint:réports-2', 'checkpoint:a#2', `document:${uuid(2)}`, `document:${uuid(2)}#12`, 'commit:billing api:a91f2e0', 'commit:x:y:abcdef0123456789#3']) {
      expect(isBoardNodeId(id), id).toBe(true);
    }
  });

  it('refuses the rest', () => {
    for (const id of ['', 'lane:documents', 'plan:own', 'checkpoint:', 'checkpoint:-a', 'checkpoint:a b', 'checkpoint:a#', 'document:abc', 'commit:api:abc123', 'commit:api:ABCDEF0', 'commit::a91f2e0', 'commit:a/b:a91f2e0', `commit:api:${'a'.repeat(65)}`, 'x'.repeat(401), 7, null, undefined]) {
      expect(isBoardNodeId(id), String(id)).toBe(false);
    }
  });
});

describe('isBoardAreaId', () => {
  it('knows the shapes the board accepts for an area', () => {
    for (const id of ['checkpoint:reports-export-to-csv', 'checkpoint:réports-2', 'checkpoint:a#2', 'plan:own']) {
      expect(isBoardAreaId(id), id).toBe(true);
    }
  });

  it('refuses the rest', () => {
    for (const id of ['', uuid(1), 'lane:documents', 'checkpoint:', 'checkpoint:-a', 'checkpoint:a b', 'checkpoint:a#', `document:${uuid(2)}`, 'commit:api:abc1234', 'x'.repeat(401), 7, null, undefined]) {
      expect(isBoardAreaId(id), String(id)).toBe(false);
    }
  });
});

describe('cleanCardPath', () => {
  it('takes a plain path inside the workspace', () => {
    expect(cleanCardPath('docs/overview.html')).toBe('docs/overview.html');
    expect(cleanCardPath('.claude/notes.md')).toBe('.claude/notes.md');
    expect(cleanCardPath('a\\b.png')).toBe('a/b.png');
  });

  it('refuses a path that leaves it', () => {
    for (const path of ['/a.png', '../a.png', 'a/./b.png', 'a//b.png', 'a/', 'C:/a.png', 'a\u0000.png', 'x'.repeat(1001), '', ' ', 5]) {
      expect(cleanCardPath(path), String(path)).toBeNull();
    }
  });
});
