import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enabledTools, findTool, type ToolContext } from './tools.js';
import { boardTools } from './board-tools.js';
import { BOARD_FILE, readBoard, readBoardChanges, type Board } from '../core/board.js';
import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { setActiveStorageProvider } from '../core/adapters/registry.js';
import { BOARD_EVENTS_FILE, SCREEN_EVENTS_FILE } from '../core/screen-events.js';
import type { NexusFlowConfig } from '../types.js';

const config: NexusFlowConfig = { version: '1.0', devDir: '/dev', workspacesDir: '/dev/workspaces', defaultAssistant: null, scanDepth: 2 };
const NAMES = ['board_read', 'board_add_card', 'board_update_card', 'board_remove_card', 'board_move', 'board_link', 'board_unlink'];

let root: string;
const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({ id: 'canvas', name: 'Canvas', branchName: 'canvas', description: 'A canvas', repos: [], assistants: [], workspacePath: root, ...extra });
const ctx = (): ToolContext => ({ config, workspacePath: root });
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await findTool(name)!.handler(args, ctx());
  const text = result.content[0]!.text;
  return { isError: Boolean(result.isError), text, body: result.isError ? undefined : JSON.parse(text) };
};
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await call(name, args);
  expect(result.isError, result.text).toBe(false);
  return result.body;
};
const ledgerLines = (name: string) => async () => (await fs.readFile(path.join(root, '.contextspace', name), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
const screenLines = ledgerLines(SCREEN_EVENTS_FILE);
const boardLines = ledgerLines(BOARD_EVENTS_FILE);
const boardFile = () => path.join(root, BOARD_FILE);

beforeEach(async () => {
  setActiveStorageProvider(new LocalStorageAdapter());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-board-')));
  await fs.writeFile(path.join(root, 'contextspace.json'), manifest());
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs', 'overview.html'), '<h1>Overview</h1>');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('registration', () => {
  it('registers every board tool with a strict schema, the optional harness and workspace, and the right hints', () => {
    for (const name of NAMES) {
      const tool = findTool(name)!;
      expect(tool, name).toBeDefined();
      expect(boardTools).toContain(tool);
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      const properties = tool.inputSchema.properties as Record<string, { type?: string }>;
      expect(properties.harness, name).toMatchObject({ type: 'string', maxLength: 40 });
      expect(properties.workspaceId, name).toMatchObject({ type: 'string' });
      expect(tool.annotations).toMatchObject({ openWorldHint: false, readOnlyHint: name === 'board_read', destructiveHint: name === 'board_remove_card' || name === 'board_unlink' });
    }
  });

  it('publishes the same limits the board keeps, and requires what a tool cannot work without', () => {
    const schema = (name: string) => findTool(name)!.inputSchema as { required?: string[]; properties: Record<string, any> };
    expect(schema('board_add_card').required).toEqual(['kind']);
    expect(schema('board_add_card').properties.kind.enum).toEqual(['note', 'file']);
    expect(schema('board_add_card').properties.title.maxLength).toBe(200);
    expect(schema('board_add_card').properties.body.maxLength).toBe(4000);
    expect(schema('board_add_card').properties.x).toMatchObject({ type: 'number', minimum: -1_000_000, maximum: 1_000_000 });
    expect(schema('board_update_card').required).toEqual(['id']);
    expect(schema('board_remove_card').required).toEqual(['id']);
    expect(schema('board_move').required).toEqual(['nodes']);
    expect(schema('board_move').properties.nodes).toMatchObject({ type: 'array', minItems: 1, maxItems: 100 });
    expect(schema('board_link').required).toEqual(['from', 'to']);
    expect(schema('board_link').properties.label.maxLength).toBe(200);
    expect(schema('board_read').required ?? []).toEqual([]);
  });

  it('tells an AI when to use each tool, and that file cards are how to show what it made', () => {
    const add = findTool('board_add_card')!.description;
    expect(add).toMatch(/SHOW something you made/);
    for (const word of ['picture', 'HTML page', 'PDF', 'deck']) expect(add).toContain(word);
    expect(add).toMatch(/must exist/);
    expect(findTool('board_read')!.description).toMatch(/before you change the board/);
    expect(findTool('board_remove_card')!.description).toMatch(/archived true/);
    expect(findTool('board_link')!.description).toMatch(/checkpoint:<plan key>/);
    expect(findTool('board_move')!.description).toMatch(/x and y/);
    expect(findTool('board_move')!.description).toMatch(/null to make the board forget/);
    expect(findTool('board_read')!.description).toMatch(/truncated.*cardId/);
  });

  it('does not promise a picture for an SVG, and says a link can be drawn once in each direction', () => {
    const add = findTool('board_add_card')!.description;
    expect(add).toMatch(/png, jpg, gif or webp/);
    expect(add).not.toMatch(/png, jpg, gif, webp, svg/);
    expect(add).toMatch(/SVG opens as its source text/);
    expect(findTool('board_link')!.description).toMatch(/once in each direction/);
  });

  it('offers cardId to read one card, and null for a place to forget', () => {
    const read = findTool('board_read')!.inputSchema as { properties: Record<string, any>; required?: string[] };
    expect(read.properties.cardId).toMatchObject({ type: 'string' });
    expect(read.required ?? []).toEqual([]);
    const move = findTool('board_move')!.inputSchema as { properties: Record<string, any> };
    expect(JSON.stringify(move.properties.nodes.items.properties.x)).toContain('"type":"null"');
    expect(JSON.stringify(move.properties.nodes.items.properties.y)).toContain('"type":"null"');
  });

  it('offers the tools that change the board to developer, interactive and full sessions only, and board_read to read-only sessions too', () => {
    const writers = NAMES.filter((name) => name !== 'board_read');
    for (const role of ['developer', 'interactive', 'full'] as const) {
      const offered = enabledTools(config, role).map((tool) => tool.name);
      for (const name of NAMES) expect(offered, `${role} ${name}`).toContain(name);
    }
    for (const role of ['readonly', 'review'] as const) {
      const offered = enabledTools(config, role).map((tool) => tool.name);
      expect(offered, role).toContain('board_read');
      for (const name of writers) expect(offered, `${role} ${name}`).not.toContain(name);
    }
    const ci = enabledTools(config, 'ci').map((tool) => tool.name);
    for (const name of NAMES) expect(ci, `ci ${name}`).not.toContain(name);
    expect(enabledTools(config, 'full', undefined, ['board_remove_card']).map((tool) => tool.name)).not.toContain('board_remove_card');
  });
});

describe('working on the board', () => {
  it('adds a note, lays the board out and ties things together, then reads it all back', async () => {
    const added = await ok('board_add_card', { kind: 'note', title: 'Export leaks memory', body: 'Seen in the CSV writer.', pinned: true, x: 120, y: 40, harness: 'claude' });
    expect(added.revision).toBe(1);
    const id = added.card.id as string;
    expect(added.card).toMatchObject({ kind: 'note', title: 'Export leaks memory', body: 'Seen in the CSV writer.', pinned: true, by: 'claude' });

    expect((await ok('board_link', { from: id, to: 'checkpoint:reports-export', label: 'found while' })).link).toMatchObject({ from: id, to: 'checkpoint:reports-export', label: 'found while', by: 'ai' });
    expect(await ok('board_move', { nodes: [{ id, x: 10, y: 20 }, { id: 'checkpoint:reports-export', x: 300, y: 20 }] })).toEqual({ revision: 3, moved: 2, forgotten: 0 });
    expect((await ok('board_update_card', { id, title: 'Export leaks memory (fixed)', archived: true })).card).toMatchObject({ title: 'Export leaks memory (fixed)', archived: true });

    const read = await ok('board_read');
    expect(read.board).toMatchObject({
      version: 1, revision: 4,
      cards: [{ id, archived: true }],
      links: [{ from: id, to: 'checkpoint:reports-export' }],
      positions: { [id]: { x: 10, y: 20 }, 'checkpoint:reports-export': { x: 300, y: 20 } },
    });

    const linkId = read.board.links[0].id as string;
    expect(await ok('board_unlink', { id: linkId })).toEqual({ revision: 5, unlinked: linkId });
    expect(await ok('board_remove_card', { id })).toEqual({ revision: 6, removed: id });
    expect(await readBoard(root)).toMatchObject({ revision: 6, cards: [], links: [], positions: { 'checkpoint:reports-export': { x: 300, y: 20 } } });
  });

  it('shows a file the AI made, as a file card, and unlinks by both ends', async () => {
    const { card } = await ok('board_add_card', { kind: 'file', path: 'docs/overview.html', description: 'The overview page', harness: 'codex' });
    expect(card).toMatchObject({ kind: 'file', path: 'docs/overview.html', title: 'overview.html', description: 'The overview page', by: 'codex' });
    await ok('board_link', { from: card.id, to: 'commit:NexusFlow:abc1234' });
    expect(await ok('board_unlink', { from: card.id, to: 'commit:NexusFlow:abc1234' })).toMatchObject({ revision: 3 });
  });

  it('lists what a card can be linked to: the checkpoints of the plan and the source documents, and the id formats', async () => {
    await fs.writeFile(path.join(root, 'PLAN.md'), '# Plan\n\nGoal.\n\n## Checkpoints\n\n- [ ] Reports export to CSV\n  - [ ] Query the rows\n- [x] Open root reports\n');
    const document = (await ok('add_work_document', { revision: 0, title: 'Report requirements', role: 'requirements', content: '# Keep formatting' })).guidance.documents[0];
    const read = await ok('board_read');
    expect(read.canLinkTo.checkpoints).toEqual([
      { id: 'checkpoint:reports-export-to-csv', title: 'Reports export to CSV' },
      { id: 'checkpoint:open-root-reports', title: 'Open root reports' },
    ]);
    expect(read.canLinkTo.documents).toEqual([{ id: `document:${document.id}`, title: 'Report requirements' }]);
    expect(read.canLinkTo.commits).toMatch(/commit:<repository folder name>:<commit hash>/);
    expect(read.nodeIds).toMatchObject({ card: expect.any(String), checkpoint: expect.stringContaining('checkpoint:'), document: expect.stringContaining('document:'), commit: expect.stringContaining('commit:') });
    expect(read.limits).toEqual({ cards: 500, links: 1000, positions: 2000 });
    expect(read.problems).toBeUndefined();

    // The ids it lists are ones a line can end at.
    await ok('board_link', { from: read.canLinkTo.checkpoints[0].id, to: read.canLinkTo.documents[0].id, label: 'built from' });
  });

  it('answers in compact JSON, with long bodies and descriptions cut and marked, and one card in full on request', async () => {
    await fs.writeFile(path.join(root, 'docs', 'long.pdf'), 'pdf');
    const long = `${'word '.repeat(200)}end`;
    const short = await ok('board_add_card', { kind: 'note', title: 'Short', body: 'Fits.' });
    const note = await ok('board_add_card', { kind: 'note', title: 'Long note', body: long });
    const file = await ok('board_add_card', { kind: 'file', path: 'docs/long.pdf', description: long });
    const emoji = await ok('board_add_card', { kind: 'note', title: 'Emoji', body: `${'a'.repeat(299)}😀 and more` });
    await ok('board_link', { from: note.card.id, to: 'checkpoint:a' });
    await ok('board_move', { nodes: [{ id: note.card.id, x: 4, y: 5 }] });

    const result = await findTool('board_read')!.handler({}, ctx());
    expect(result.content[0]!.text).not.toMatch(/\n/);
    const read = JSON.parse(result.content[0]!.text);
    const [s, n, f, e] = read.board.cards;
    expect(s).toMatchObject({ title: 'Short', body: 'Fits.' });
    expect(s.truncated).toBeUndefined();
    expect(n.body).toHaveLength(300);
    expect(n.truncated).toBe(true);
    expect(f.description).toHaveLength(300);
    expect(f.truncated).toBe(true);
    // A character that takes two code units is not cut in half.
    expect(e.body).toBe('a'.repeat(299));
    expect(e.truncated).toBe(true);
    expect(short.revision).toBeLessThan(read.board.revision);

    const one = await ok('board_read', { cardId: note.card.id });
    expect(one).toMatchObject({ revision: read.board.revision, card: { id: note.card.id, body: long }, links: [{ from: note.card.id, to: 'checkpoint:a' }], position: { x: 4, y: 5 } });
    expect(one.card.truncated).toBeUndefined();
    expect((await ok('board_read', { cardId: file.card.id })).card.description).toBe(long);
    expect((await ok('board_read', { cardId: short.card.id })).position).toBeUndefined();
    const missing = await call('board_read', { cardId: randomUUID() });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toMatch(/no card with id/);
    expect((await call('board_read', { cardId: 'card-1' })).isError).toBe(true);

    // Reading changes nothing: the file still holds the whole text.
    expect((await readBoard(root)).cards[1]).toMatchObject({ body: long });
  });

  it('forgets a place when given null, and says how many places it moved and forgot', async () => {
    await ok('board_move', { nodes: [{ id: 'checkpoint:a', x: 1, y: 2 }, { id: 'commit:api:abc1234', x: 3, y: 4 }] });
    expect(await ok('board_move', { nodes: [{ id: 'checkpoint:a', x: null, y: null }, { id: 'checkpoint:b', x: 9, y: 9 }] })).toEqual({ revision: 2, moved: 1, forgotten: 1 });
    expect((await readBoard(root)).positions).toEqual({ 'commit:api:abc1234': { x: 3, y: 4 }, 'checkpoint:b': { x: 9, y: 9 } });
    const half = await call('board_move', { nodes: [{ id: 'checkpoint:b', x: null, y: 3 }] });
    expect(half).toMatchObject({ isError: true });
    expect(half.text).toMatch(/both as null/);
  });

  it('reads an empty board in a workspace with no plan and no documents', async () => {
    const read = await ok('board_read');
    expect(read.board).toEqual({ version: 1, revision: 0, cards: [], links: [], positions: {} });
    expect(read.canLinkTo).toMatchObject({ checkpoints: [], documents: [] });
  });

  it('works from a folder below the workspace root, and writes the board at the root', async () => {
    await fs.mkdir(path.join(root, 'NexusFlow'));
    const result = await findTool('board_add_card')!.handler({ kind: 'note', title: 'From below' }, { config, workspacePath: path.join(root, 'NexusFlow') });
    expect(result.isError).toBeUndefined();
    expect((await readBoard(root)).cards[0]!.title).toBe('From below');
    await expect(fs.access(path.join(root, 'NexusFlow', BOARD_FILE))).rejects.toThrow();
  });
});

describe('who made the change', () => {
  it('records the harness as the one who made it, in a plain lower case form', async () => {
    const { card } = await ok('board_add_card', { kind: 'note', title: 'A', harness: ' Claude ' });
    expect(card.by).toBe('claude');
    const link = (await ok('board_link', { from: card.id, to: 'checkpoint:a', harness: 'Codex CLI' })).link;
    expect(link.by).toBe('codex-cli');
    expect((await readBoardChanges(root)).map((entry) => entry.by)).toEqual(['codex-cli', 'claude']);
    expect((await boardLines()).map((line) => line.harness)).toEqual(['claude', 'codex-cli']);
  });

  it('calls a change "ai" when no harness is named, and never lets a tool pass itself off as the user', async () => {
    expect((await ok('board_add_card', { kind: 'note', title: 'No name' })).card.by).toBe('ai');
    expect((await ok('board_add_card', { kind: 'note', title: 'Posing', harness: 'user' })).card.by).toBe('ai');
    expect((await ok('board_add_card', { kind: 'note', title: 'Posing too', harness: ' USER ' })).card.by).toBe('ai');
  });

  it.each([
    ['a zero-width space after it', 'user\u200b', 'ai'],
    ['a right-to-left override before it', '\u202euser', 'ai'],
    ['a dot after it', 'user.', 'ai'],
    ['a Cyrillic letter in it', 'us\u0435r', 'us-r'],
    ['nothing but hidden characters', '\u200b\u202e', 'ai'],
  ])('does not let a harness name written with %s read as "user"', async (_name, harness, expected) => {
    const { card } = await ok('board_add_card', { kind: 'note', title: 'Posing', harness });
    expect(card.by).toBe(expected);
    expect((await readBoardChanges(root))[0]!.by).toBe(expected);
    expect((await boardLines()).at(-1)).toMatchObject({ event: 'board', harness: expected, author: 'agent' });
  });

  it('tells open screens that the board changed, once for each call', async () => {
    await ok('board_add_card', { kind: 'note', title: 'A', harness: 'claude' });
    await ok('board_add_card', { kind: 'note', title: 'B', harness: 'claude' });
    const events = await boardLines();
    expect(events.map((line) => line.payload)).toEqual([{ revision: 1, changes: 1 }, { revision: 2, changes: 1 }]);
    expect(events[0]).toMatchObject({ kind: 'screen_event', author: 'agent', harness: 'claude' });
  });
});

describe('refusals', () => {
  it('refuses a change made on a stale revision, says to read again, and changes nothing', async () => {
    const first = await ok('board_add_card', { kind: 'note', title: 'One' });
    await ok('board_add_card', { kind: 'note', title: 'Two' });
    const stale = await call('board_add_card', { kind: 'note', title: 'Three', revision: first.revision });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/changed in another session.*revision 2, not 1.*Read it again/);
    expect((await readBoard(root)).cards.map((card) => card.title)).toEqual(['One', 'Two']);
    expect((await ok('board_add_card', { kind: 'note', title: 'Three', revision: 2 })).revision).toBe(3);
  });

  it.each([
    ['board_add_card', { kind: 'note' }, /title/],
    ['board_add_card', { kind: 'drawing', title: 'x' }, /kind/],
    ['board_add_card', { kind: 'note', title: 'x', colour: 'red' }, /colour/],
    ['board_add_card', { kind: 'note', title: 'x'.repeat(201) }, /title/],
    ['board_add_card', { kind: 'note', title: 'x', x: 10 }, /both x and y/],
    ['board_add_card', { kind: 'note', title: 'x', x: 1e9, y: 0 }, /x/],
    ['board_add_card', { kind: 'note', title: 'x', path: 'a.md' }, /no path/],
    ['board_add_card', { kind: 'file' }, /needs the path/],
    ['board_add_card', { kind: 'file', path: '../outside.md' }, /inside this workspace/],
    ['board_add_card', { kind: 'file', path: '/etc/passwd' }, /not inside the workspace/],
    ['board_add_card', { kind: 'file', path: '.git/config' }, /Hidden files and folders/],
    ['board_add_card', { kind: 'file', path: 'docs/missing.html' }, /no file/],
    ['board_add_card', { kind: 'note', title: 'x', harness: 'h'.repeat(41) }, /harness/],
    ['board_update_card', { id: randomUUID() }, /at least one thing/],
    ['board_update_card', { id: randomUUID(), title: 'x' }, /no card with id/],
    ['board_update_card', { id: 'card-1', title: 'x' }, /uuid/],
    ['board_remove_card', { id: randomUUID() }, /no card with id/],
    ['board_move', { nodes: [] }, /nodes/],
    ['board_move', { nodes: [{ id: 'banner', x: 0, y: 0 }] }, /not a board node id/],
    ['board_move', { nodes: [{ id: 'checkpoint:a', x: 0 }] }, /nodes\.0\.y/],
    ['board_link', { from: 'checkpoint:a', to: 'checkpoint:a' }, /two different ends/],
    ['board_link', { from: 'checkpoint:a', to: 'somewhere' }, /not a board node id/],
    ['board_link', { from: randomUUID(), to: 'checkpoint:a' }, /no card with id/],
    ['board_unlink', {}, /by its id, or by both/],
    ['board_unlink', { from: 'checkpoint:a', to: 'checkpoint:b' }, /no such link/],
    ['board_read', { extra: 1 }, /extra/],
    ['board_read', { cardId: 'card-1' }, /uuid/],
    ['board_move', { nodes: [{ id: 'checkpoint:a', x: null, y: 3 }] }, /both as null/],
  ])('refuses %s %j with a clear message and writes nothing', async (name, args, message) => {
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(message);
    await expect(fs.access(boardFile())).rejects.toThrow();
    expect(await screenLines()).toEqual([]);
    expect(await boardLines()).toEqual([]);
  });

  it('says plainly when the workspace does not exist, and leaves nothing behind', async () => {
    await fs.rm(path.join(root, 'contextspace.json'));
    for (const [name, args] of [['board_read', {}], ['board_add_card', { kind: 'note', title: 'x' }]] as const) {
      expect(await call(name, args)).toMatchObject({ isError: true, text: 'Workspace not found.' });
    }
    await expect(fs.access(boardFile())).rejects.toThrow();
  });

  it('refuses changes in an archived workspace, and still reads', async () => {
    await ok('board_add_card', { kind: 'note', title: 'Before' });
    await fs.writeFile(path.join(root, 'contextspace.json'), manifest({ archivedAt: '2026-09-28T10:00:00.000Z' }));
    const refused = await call('board_add_card', { kind: 'note', title: 'After' });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toMatch(/archived/);
    expect((await ok('board_read')).board.cards).toHaveLength(1);
  });

  it('reports a board file that is not a board, and does not overwrite it', async () => {
    await fs.writeFile(boardFile(), '{ broken');
    for (const [name, args] of [['board_read', {}], ['board_add_card', { kind: 'note', title: 'x' }], ['board_move', { nodes: [{ id: 'checkpoint:a', x: 1, y: 1 }] }]] as const) {
      const result = await call(name, args);
      expect(result.isError, name).toBe(true);
      expect(result.text, name).toMatch(/not valid JSON.*left as it is/);
    }
    expect(await fs.readFile(boardFile(), 'utf8')).toBe('{ broken');
  });

  it('keeps a recovery path: a refused call does not stop the next one', async () => {
    expect((await call('board_add_card', { kind: 'file', path: 'docs/missing.html' })).isError).toBe(true);
    await fs.writeFile(path.join(root, 'docs', 'missing.html'), '<p>now here</p>');
    const added = await ok('board_add_card', { kind: 'file', path: 'docs/missing.html' });
    expect(added.revision).toBe(1);
    const board = (await ok('board_read')).board as Board;
    expect(board.cards).toHaveLength(1);
  });
});
