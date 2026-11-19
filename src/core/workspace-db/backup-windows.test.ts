/**
 * The Windows rules for a restore, run on every platform. Windows refuses to rename a database file another connection
 * has open (EPERM). The restore must then say so with a typed error and leave the folder exactly as it was, the
 * journal included; and if a later step fails, the old file and its journal must go back, or the error must say
 * exactly where they are (never "Nothing was changed"). The refusals are simulated (a fake `renameSync` and
 * `process.platform`), so Linux and macOS check the same code path that Windows takes; `runtime.test.ts` has the
 * real-Windows twin.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Draws of 3 bytes are the replaced file's name suffix; a test can queue them to force a name clash.
const draws = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return { ...real, randomBytes: ((size: number) => (size === 3 && draws.queue.length ? Buffer.from(draws.queue.shift()!, 'hex') : real.randomBytes(size))) as typeof real.randomBytes };
});

type Rename = (from: string, to: string) => void;
const hook = vi.hoisted(() => ({ before: null as null | Rename }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      hook.before?.(from, to);
      return real.renameSync(from, to);
    },
  };
});

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { dbFilePath, getRevision, listBackups, maybeBackup, restoreBackup } from './index.js';
import { apply, cleanTemp, idOf, seeded } from './testing.js';

const realPlatform = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { value });
afterEach(() => {
  hook.before = null;
  draws.queue = [];
  vi.useRealTimers();
  setPlatform(realPlatform);
  cleanTemp();
});

const eperm = (from: string, to: string) => Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
const JOURNAL = Buffer.alloc(64, 9);

/**
 * A workspace with a backup and one more change; the connection is closed. A junk journal cannot be written up front
 * (SQLite deletes a junk journal when the restore takes the live file's lock), so `arm` puts it there at the first
 * rename, which is the first moment a journal could matter, and takes the "before" snapshot at the same time.
 */
async function setup() {
  const { ws, db } = await seeded();
  await maybeBackup(ws);
  await apply(db, [{ op: 'tick', id: idOf(db, 'Write the file') }]);
  db.close(); // the simulated refusal stands for another handle; the real handle is closed so the test can compare files
  const live = dbFilePath(ws);
  const folder = path.join(ws, '.contextspace');
  // the .restore temp is the restore's own working file: it must be gone afterwards, so it is not part of the comparison
  const snapshot = () => ({ names: readdirSync(folder).filter((n) => !n.startsWith('.restore')).sort(), db: readFileSync(live), journal: readFileSync(`${live}-journal`) });
  const s = {
    ws, folder, live, snapshot, name: listBackups(ws)[0]!,
    before: null as null | ReturnType<typeof snapshot>,
    arm(rule: Rename) {
      let first = true;
      hook.before = (from, to) => {
        if (first) { first = false; writeFileSync(`${live}-journal`, JOURNAL); s.before = snapshot(); }
        rule(from, to);
      };
    },
  };
  return s;
}

const run = (ws: string, name: string) => { setPlatform('win32'); try { return restoreBackup(ws, name); } finally { setPlatform(realPlatform); } };
const expectUnchanged = (s: Awaited<ReturnType<typeof setup>>) => {
  const before = s.before!;
  const after = s.snapshot();
  expect(after.names).toEqual(before.names); // no .replaced spare, journal still there
  expect(readdirSync(s.folder).some((n) => n.startsWith('.restore'))).toBe(false);
  expect(after.db.equals(before.db)).toBe(true);
  expect(after.journal.equals(before.journal)).toBe(true);
};

describe('restore on Windows (simulated refusals)', () => {
  it('the first rename (the live file aside) refused: file_in_use, the folder is exactly as before, journal included', async () => {
    const s = await setup();
    s.arm((from, to) => { if (from === s.live) throw eperm(from, to); });
    expect(() => run(s.ws, s.name)).toThrow(expect.objectContaining({ code: 'file_in_use', message: expect.stringMatching(/Close ContextSpace.*backup was not installed/) }));
    expectUnchanged(s);
  });

  it('the final rename refused after the live file was moved aside: everything goes back, journal included', async () => {
    const s = await setup();
    s.arm((from, to) => { if (to === s.live && from.includes('.restore-')) throw eperm(from, to); });
    expect(() => run(s.ws, s.name)).toThrow(expect.objectContaining({ code: 'file_in_use' }));
    expectUnchanged(s);
  });

  it('any other error code at a later step also puts the old file and its journal back, and is rethrown as it was', async () => {
    const s = await setup();
    s.arm((from, to) => { if (to === s.live && from.includes('.restore-')) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); });
    expect(() => run(s.ws, s.name)).toThrow(expect.objectContaining({ code: 'EIO' }));
    expectUnchanged(s);
  });

  it('the journal cannot be moved aside: the live file goes back, nothing is lost', async () => {
    const s = await setup();
    s.arm((from, to) => { if (from === `${s.live}-journal`) throw Object.assign(new Error('EIO'), { code: 'EIO' }); });
    expect(() => run(s.ws, s.name)).toThrow(expect.objectContaining({ code: 'EIO' }));
    expectUnchanged(s);
  });

  it('recovery fails too: the error says where the old database is, never "Nothing was changed"', async () => {
    const s = await setup();
    let keptAs = '';
    s.arm((from, to) => {
      if (from === s.live) { keptAs = to; return; } // the probe succeeds
      if (to === s.live && from.includes('.restore-')) throw eperm(from, to);
      if (from === keptAs && to === s.live) throw eperm(from, to); // and the way back is refused
    });
    let error: unknown;
    try { run(s.ws, s.name); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'backup_failed' });
    const message = (error as Error).message;
    expect(message).not.toMatch(/Nothing was changed/);
    expect(message).toContain(keptAs);
    expect(message).toContain(`${keptAs}-journal`); // the journal stays beside the database it belongs to
    expect(readdirSync(s.folder)).toEqual(expect.arrayContaining([path.basename(keptAs), `${path.basename(keptAs)}-journal`]));
  });

  it('the journal cannot be moved aside and the database cannot go back: the error names where both are', async () => {
    const s = await setup();
    let keptAs = '';
    s.arm((from, to) => {
      if (from === s.live) { keptAs = to; return; }
      if (from === `${s.live}-journal`) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      if (from === keptAs && to === s.live) throw eperm(from, to);
    });
    let error: unknown;
    try { run(s.ws, s.name); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'backup_failed' });
    const message = (error as Error).message;
    expect(message).toContain(keptAs);
    expect(message).toContain(`its journal is at ${s.live}-journal`);
    expect(readFileSync(`${s.live}-journal`).equals(JOURNAL)).toBe(true);
  });

  it('a new journal appeared at the live path meanwhile: nothing is overwritten, the database is not moved back without its journal, and the error names both', async () => {
    const s = await setup();
    let keptAs = '';
    s.arm((from, to) => {
      if (from === s.live) { keptAs = to; return; }
      if (to === s.live && from.includes('.restore-')) { writeFileSync(`${s.live}-journal`, 'new'); throw eperm(from, to); }
    });
    let error: unknown;
    try { run(s.ws, s.name); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'backup_failed' });
    const message = (error as Error).message;
    expect(message).not.toMatch(/Nothing was changed\.$/);
    expect(message).toContain(keptAs);
    expect(message).toContain(`${keptAs}-journal`);
    expect(readFileSync(`${keptAs}-journal`).equals(JOURNAL)).toBe(true); // the old journal is intact beside its database
    expect(existsSync(s.live)).toBe(false); // the database was NOT moved back without its journal
    expect(readFileSync(`${s.live}-journal`, 'utf8')).toBe('new'); // and the new journal was not overwritten
  });

  it('the journal cannot be put back: the database is not moved back either, both stay under their kept names', async () => {
    const s = await setup();
    let keptAs = '';
    s.arm((from, to) => {
      if (from === s.live) { keptAs = to; return; }
      if (to === s.live && from.includes('.restore-')) throw eperm(from, to);
      if (from === `${keptAs}-journal` && to === `${s.live}-journal`) throw eperm(from, to);
    });
    let error: unknown;
    try { run(s.ws, s.name); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'backup_failed' });
    expect((error as Error).message).toContain(keptAs);
    expect((error as Error).message).toContain(`${keptAs}-journal`);
    expect(existsSync(s.live)).toBe(false);
    expect(existsSync(`${s.live}-journal`)).toBe(false);
    expect(readFileSync(`${keptAs}-journal`).equals(JOURNAL)).toBe(true);
    expect(existsSync(keptAs)).toBe(true);
  });

  it('a retry while the database is missing but its journal is still at the live path is refused before anything moves (every platform)', async () => {
    const s = await setup();
    rmSync(s.live);
    writeFileSync(`${s.live}-journal`, JOURNAL);
    const names = readdirSync(s.folder).sort();
    expect(() => restoreBackup(s.ws, s.name)).toThrow(expect.objectContaining({ code: 'backup_failed', message: expect.stringContaining(`${s.live}-journal`) }));
    expect(readdirSync(s.folder).sort()).toEqual(names); // no .restore temp, nothing moved
    expect(existsSync(s.live)).toBe(false);
  });

  it('the replaced database never takes a name that is already there: a clash draws again and the other file is untouched', async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const taken = `${s.live}.replaced-2026-01-01T00-00-00-000Z-aaaaaa`;
    writeFileSync(taken, 'someone else\'s file');
    draws.queue = ['aaaaaa', 'bbbbbb'];
    const result = run(s.ws, s.name);
    expect(result.keptAs).toBe(`${s.live}.replaced-2026-01-01T00-00-00-000Z-bbbbbb`);
    expect(readFileSync(taken, 'utf8')).toBe('someone else\'s file');
    expect(existsSync(result.keptAs!)).toBe(true);
  });

  // On Windows itself a refused rename is the real sharing error by definition; this case only checks that other platforms do not remap it.
  it.skipIf(realPlatform === 'win32')('on another platform the same rename error is not turned into file_in_use', async () => {
    const s = await setup();
    s.arm((from, to) => { if (to === s.live && from.includes('.restore-')) throw eperm(from, to); });
    expect(() => restoreBackup(s.ws, s.name)).toThrow(expect.objectContaining({ code: 'EPERM' }));
  });
});
