import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectListedRepositoryFiles, UNTRACKED_COUNT_LIMIT } from './listed-file-inspection.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

// This preload executes inside the real inspection child. It schedules real
// filesystem replacements around the adapter's actual synchronous OS calls.
const preload = String.raw`
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.env.LISTING_RACE_CONFIG, 'utf8'));
const path = require('node:path');
const original = { open: fs.openSync, close: fs.closeSync, lstat: fs.lstatSync, read: fs.readSync,
  readFile: fs.readFileSync, chdir: process.chdir.bind(process) };
const target = path.join(config.repo, 'nested', 'new.txt');
const parent = path.dirname(target);
const saved = path.join(config.repo, 'nested-saved');
const outside = path.join(config.root, 'outside');
const sentinel = fs.statSync(path.join(outside, 'new.txt'), { bigint: true });
let phase, swapped = false, restored = false, repeated = false, changed = false;
const descriptors = new Set();
let active = 0, peak = 0;
const event = (value) => fs.appendFileSync(config.trace, JSON.stringify(value) + '\n');
const swap = () => { fs.renameSync(parent, saved); fs.symlinkSync(outside, parent, 'dir'); swapped = true; };
fs.readFileSync = function(file, ...args) {
  const result = original.readFile(file, ...args);
  if (file === 0) { phase = JSON.parse(result).mode; event({ phase }); }
  return result;
};
process.chdir = function(directory) {
  if (config.race === 'before-anchor' && directory === parent && !changed) {
    swap(); changed = true; event({ anchorRedirected: true });
  }
  return original.chdir(directory);
};
fs.openSync = function(name, flags, ...args) {
  if (name === 'new.txt' && phase === 'counts' && !changed) {
    changed = true;
    if (config.race === 'repeated-swap') { swap(); event({ swapped: true }); }
    if (config.race === 'fifo') {
      fs.unlinkSync(target); require('node:child_process').execFileSync('mkfifo', [target]);
      event({ fifo: true, nonblocking: typeof flags === 'number' && !!(flags & fs.constants.O_NONBLOCK) });
      if (typeof flags !== 'number' || !(flags & fs.constants.O_NONBLOCK)) throw new Error('Prevent hanging test');
    }
    if (config.race === 'empty') fs.truncateSync(target, 0);
  }
  const fd = original.open(name, flags, ...args);
  if (name !== 'new.txt' && !String(name).endsWith('.txt')) return fd;
  descriptors.add(fd); active++; peak = Math.max(peak, active);
  event({ opened: name, active, peak });
  return fd;
};
fs.lstatSync = function(name, ...args) {
  const result = original.lstat(name, ...args);
  if (name === 'new.txt' && swapped && !repeated) {
    fs.unlinkSync(parent); fs.renameSync(saved, parent); swapped = false; restored = true;
    // Exercise both swaps from the rejected pathname-validation design.
    swap(); repeated = true; event({ restored, reswapped: true });
  }
  return result;
};
fs.readSync = function(fd, buffer, offset, length, position) {
  if (descriptors.has(fd) && config.race === 'grow' && !repeated) {
    fs.appendFileSync(target, Buffer.alloc(config.limit * 4, 10)); repeated = true; event({ grew: true });
  }
  const result = original.read(fd, buffer, offset, length, position);
  if (descriptors.has(fd)) {
    const stat = fs.fstatSync(fd, { bigint: true });
    event({ bytes: result, external: stat.ino === sentinel.ino && stat.dev === sentinel.dev });
  }
  return result;
};
fs.closeSync = function(fd) {
  if (descriptors.delete(fd)) { active--; event({ closed: true, active }); }
  return original.close(fd);
};
`;

async function fixture(race?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-listed-anchor-')); roots.push(root);
  const repo = path.join(root, 'repo'); await fs.mkdir(path.join(repo, 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'outside'));
  await fs.writeFile(path.join(repo, 'nested', 'new.txt'), 'one\n');
  await fs.writeFile(path.join(root, 'outside', 'new.txt'), 'external\nsentinel\nthird\n');
  const trace = path.join(root, 'trace.jsonl');
  if (race) {
    const config = path.join(root, 'config.json'); const script = path.join(root, 'preload.cjs');
    await fs.writeFile(script, preload);
    await fs.writeFile(config, JSON.stringify({ root, repo, trace, race, limit: UNTRACKED_COUNT_LIMIT }));
    vi.stubEnv('LISTING_RACE_CONFIG', config);
    vi.stubEnv('NODE_OPTIONS', `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(script)}`);
  }
  const events = async () => (await fs.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, repo, events };
}

const bytes = (events: Array<{ bytes?: number; external?: boolean }>, externalOnly = false) =>
  events.reduce((total, event) => total + ((!externalOnly || event.external) ? event.bytes ?? 0 : 0), 0);

describe('listed file inspection through stable parent directories', () => {
  it.skipIf(process.platform === 'win32')('survives repeated parent swaps with zero external descriptor bytes', async () => {
    const { repo, events } = await fixture('repeated-swap');
    const before = process.cwd();
    expect(await inspectListedRepositoryFiles(repo, ['nested/new.txt'], 'counts'))
      .toEqual([expect.objectContaining({ file: 'nested/new.txt', size: 4, additions: 1 })]);
    const trace = await events();
    expect(trace).toContainEqual({ swapped: true });
    expect(trace).toContainEqual({ restored: true, reswapped: true });
    expect(bytes(trace)).toBe(4); expect(bytes(trace, true)).toBe(0);
    expect(process.cwd()).toBe(before);
  });

  it.skipIf(process.platform === 'win32')('rejects a cwd redirected externally before its native anchor validation', async () => {
    const { repo, events } = await fixture('before-anchor');
    expect(await inspectListedRepositoryFiles(repo, ['nested/new.txt'], 'counts')).toEqual([]);
    const trace = await events();
    expect(trace).toContainEqual({ anchorRedirected: true });
    expect(bytes(trace, true)).toBe(0);
    expect(trace.some(event => event.opened)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('opens a FIFO replacement nonblocking and never reads it', async () => {
    const { repo, events } = await fixture('fifo');
    expect(await inspectListedRepositoryFiles(repo, ['nested/new.txt'], 'counts')).toEqual([]);
    const trace = await events();
    expect(trace).toContainEqual({ fifo: true, nonblocking: true });
    expect(bytes(trace)).toBe(0);
  });

  it('bounds actual descriptor bytes when a file grows after fstat', async () => {
    const { repo, events } = await fixture('grow');
    const rows = await inspectListedRepositoryFiles(repo, ['nested/new.txt'], 'counts');
    const trace = await events();
    expect(trace).toContainEqual({ grew: true });
    expect(bytes(trace)).toBe(UNTRACKED_COUNT_LIMIT + 1);
    expect(rows[0]?.additions).toBeUndefined();
  });

  it('counts zero when the file is emptied after metadata', async () => {
    const { repo } = await fixture('empty');
    const [metadata] = await inspectListedRepositoryFiles(repo, ['nested/new.txt'], 'metadata');
    // Run counts on a newly nonempty file so the count-phase race is exercised.
    await fs.writeFile(path.join(repo, 'nested', 'new.txt'), 'one\n');
    const [counted] = await inspectListedRepositoryFiles(repo, ['nested/new.txt'], 'counts');
    expect(metadata?.size).toBe(4); expect(counted?.additions).toBe(0);
  });

  it('keeps metadata, text/binary limits, Unicode and deleted-file behavior', async () => {
    const { repo } = await fixture();
    const binary = Buffer.alloc(UNTRACKED_COUNT_LIMIT, 10); binary[binary.length - 1] = 0;
    await fs.writeFile(path.join(repo, 'late-nul.bin'), binary);
    await fs.writeFile(path.join(repo, 'boundary.txt'), Buffer.alloc(UNTRACKED_COUNT_LIMIT, 10));
    await fs.writeFile(path.join(repo, 'large.txt'), Buffer.alloc(UNTRACKED_COUNT_LIMIT + 1, 10));
    await fs.writeFile(path.join(repo, 'å space.txt'), 'one\ntwo');
    const rows = await inspectListedRepositoryFiles(repo, ['late-nul.bin', 'boundary.txt', 'large.txt', 'å space.txt', 'deleted.txt'], 'counts');
    expect(rows.find(row => row.file === 'late-nul.bin')?.additions).toBeUndefined();
    expect(rows.find(row => row.file === 'large.txt')?.additions).toBeUndefined();
    expect(rows.find(row => row.file === 'boundary.txt')?.additions).toBe(UNTRACKED_COUNT_LIMIT);
    expect(rows.find(row => row.file === 'å space.txt')).toMatchObject({ size: 7, additions: 2 });
    expect(rows.some(row => row.file === 'deleted.txt')).toBe(false);
  });

  it('supports a trusted root alias and rejects linked parents and absolute/escaping names', async () => {
    const { root, repo } = await fixture();
    const alias = path.join(root, 'alias'); const linked = path.join(repo, 'linked');
    await fs.symlink(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(path.join(root, 'outside'), linked, process.platform === 'win32' ? 'junction' : 'dir');
    const rows = await inspectListedRepositoryFiles(alias,
      ['nested/new.txt', 'linked/new.txt', '../outside/new.txt', path.join(root, 'outside', 'new.txt')], 'counts');
    expect(rows).toEqual([expect.objectContaining({ file: 'nested/new.txt', additions: 1 })]);
  });

  it('keeps descriptor use constant for a large file set', async () => {
    const { repo, events } = await fixture('budget');
    const files = Array.from({ length: 80 }, (_, i) => `${i}.txt`);
    await Promise.all(files.map(file => fs.writeFile(path.join(repo, file), 'a\nb\n')));
    const rows = await inspectListedRepositoryFiles(repo, files, 'counts');
    expect(rows).toHaveLength(80);
    expect(rows.every(row => row.size === 4 && row.additions === 2)).toBe(true);
    const trace = await events();
    expect(Math.max(...trace.filter(event => event.peak).map(event => event.peak))).toBe(1);
    expect(trace.at(-1)).toEqual({ closed: true, active: 0 });
  });
});
