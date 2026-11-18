import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return { ...real, randomBytes: vi.fn(real.randomBytes) };
});

import { randomBytes } from 'node:crypto';
import { TABLES, createStatements, newId, schemaText, KIND_LETTER, ID_PATTERN } from './index.js';
import { identityColumns, snapshotColumns } from './definitions.js';
import { apply, cleanTemp, idOf, seeded, tempWorkspace, openTest } from './testing.js';

afterEach(() => { cleanTemp(); vi.mocked(randomBytes).mockReset(); });

describe('the definitions object', () => {
  it('the tables are the ones v4 and v5 name', () => {
    expect(TABLES.map((t) => t.name)).toEqual([
      'meta', 'blocks', 'decisions', 'decision_meta', 'checks', 'check_runs', 'cards', 'links', 'positions', 'now', 'seen', 'changes', 'requests', 'exports', 'drafts', 'ids_used',
    ]);
    expect(TABLES.find((t) => t.name === 'cards')!.columns.map((c) => c.name)).toContain('legacy_id');
    expect(TABLES.find((t) => t.name === 'meta')!.meaning).toMatch(/db_id/);
  });

  it('every table and column has a one-line meaning', () => {
    for (const table of TABLES) {
      expect(table.meaning.length, table.name).toBeGreaterThan(10);
      expect(table.meaning.includes('\n'), table.name).toBe(false);
      for (const column of table.columns) {
        expect(column.meaning.length, `${table.name}.${column.name}`).toBeGreaterThan(3);
        expect(column.meaning.includes('\n'), `${table.name}.${column.name}`).toBe(false);
      }
    }
  });

  it('the CREATE statements and schemaText() come from it: the database has exactly these tables and columns', async () => {
    const { db } = await seeded();
    for (const table of TABLES) {
      const live = (db.sqlite.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(live, table.name).toEqual(table.columns.map((c) => c.name));
    }
    const tables = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(TABLES.map((t) => t.name).sort());
    const text = schemaText();
    for (const table of TABLES) {
      expect(text).toContain(`${table.name}: ${table.meaning}`);
      for (const column of table.columns) expect(text).toContain(`  ${column.name} `);
    }
    expect(createStatements().filter((s) => s.startsWith('CREATE TABLE'))).toHaveLength(TABLES.length);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('derived columns are marked in the text, recorded in history, and ignored when asking whether a row was touched', () => {
    expect(schemaText()).toMatch(/section_id TEXT \(derived\) - /);
    expect(snapshotColumns('blocks')).toContain('section_id');
    expect(identityColumns('blocks')).not.toContain('section_id');
    expect(snapshotColumns('blocks')).toContain('ord');
    expect(snapshotColumns('blocks')).toContain('rev');
  });

  it('the schema text is short enough to put in front of a model', () => {
    expect(schemaText().length).toBeLessThan(16_000);
  });

  it('foreign keys are on: a card cannot point at a step that does not exist', async () => {
    const { db } = await seeded();
    expect(() => db.sqlite.prepare("INSERT INTO cards(id, kind, title, step_id, by, at, updated_by, updated_at) VALUES ('kaaaaa', 'note', 't', 'snothere', 'u', 'x', 'u', 'x')").run()).toThrow(/FOREIGN KEY/);
  });
});

describe('ids (v5 point 4)', () => {
  it('are a kind letter and five base-32 characters', () => {
    const ws = tempWorkspace();
    const db = openTest(ws);
    for (const [kind, letter] of Object.entries(KIND_LETTER)) {
      const id = newId(db.sqlite, kind as keyof typeof KIND_LETTER);
      expect(id).toMatch(/^[a-z][0-9a-hjkmnp-tv-z]{5}$/);
      expect(id[0]).toBe(letter);
      expect(ID_PATTERN.test(id)).toBe(true);
    }
  });

  it('are random and distinct across thousands of draws', () => {
    const ws = tempWorkspace();
    const db = openTest(ws);
    const taken = new Set<string>();
    for (let i = 0; i < 5000; i += 1) newId(db.sqlite, 'step', taken);
    expect(taken.size).toBe(5000);
  });

  it('are never an id already used, a block, a card, or an old card uuid, even when the random draw repeats it', async () => {
    const { db } = await seeded();
    const made = await apply(db, [{ op: 'card.add', title: 'c' }]);
    db.sqlite.prepare("INSERT INTO ids_used(id) VALUES ('sabcde')").run();
    db.sqlite.prepare('UPDATE cards SET legacy_id = ? WHERE id = ?').run('sfghjk', made.newIds[0]!);
    const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
    const bytesFor = (suffix: string) => Buffer.from([...suffix].map((ch) => alphabet.indexOf(ch)));
    const existing = idOf(db, 'Write the file');
    // the random draw hits an id in ids_used, then a block, then a card's old uuid: each is skipped; the fourth is fresh
    const sequence = [bytesFor('abcde'), bytesFor(existing.slice(1)), bytesFor('fghjk'), bytesFor('mnpqr')];
    vi.mocked(randomBytes).mockImplementation((() => sequence.shift()!) as never);
    expect(newId(db.sqlite, 'step')).toBe('smnpqr');
    expect(sequence).toHaveLength(0);
  });

  it('a removed id stays in ids_used, so it is never issued again', async () => {
    const { db } = await seeded();
    const id = idOf(db, 'Third checkpoint');
    await apply(db, [{ op: 'remove', id, rev: 1 }]);
    expect(db.sqlite.prepare('SELECT 1 FROM blocks WHERE id = ?').get(id)).toBeUndefined();
    expect(db.sqlite.prepare('SELECT 1 FROM ids_used WHERE id = ?').get(id)).toBeDefined();
    // every id made so far is recorded
    const missing = db.sqlite.prepare('SELECT id FROM blocks WHERE id NOT IN (SELECT id FROM ids_used)').all();
    expect(missing).toEqual([]);
  });
});
