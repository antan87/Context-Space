import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { setActiveStorageProvider } from '../core/adapters/registry.js';
import { explainCommand, registerExplainCommand } from './explain.js';

let tempDir: string;
let ws: string;
let out: string[];
let err: string[];

const put = async (name: string, content: string) => {
  await fs.mkdir(path.dirname(path.join(ws, name)), { recursive: true });
  await fs.writeFile(path.join(ws, name), content);
};
const answer = (copy: string[], area?: string) => [
  ...(area ? ['---', `area: ${area}`, '---'] : []),
  '# How does it work?', '', 'Plainly.', '', '## The part', '```ts Repo/src/a.ts:2-3', ...copy, '```',
].join('\n');

beforeEach(async () => {
  setActiveStorageProvider(new LocalStorageAdapter());
  tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explain-cmd-')));
  ws = path.join(tempDir, 'workspace');
  await fs.mkdir(path.join(ws, 'Repo/src'), { recursive: true });
  await fs.writeFile(path.join(ws, 'Repo/src/a.ts'), 'one\ntwo\nthree\nfour\n');
  await fs.writeFile(path.join(ws, 'contextspace.json'), JSON.stringify({
    id: 'ws-explain', name: 'ws-explain', branchName: 'main', repos: [path.join(ws, 'Repo')], assistants: [], workspacePath: ws,
  }));
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => { out.push(String(msg ?? '')); });
  vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => { err.push(String(msg ?? '')); });
  process.exitCode = undefined;
});
afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ctxspace explain', () => {
  it('says "All copies match" and exits 0 when every copy matches, listing path, question, area, parts and code blocks', async () => {
    await put('explain/how.md', answer(['two', 'three'], 'plan:own'));
    expect(await explainCommand({ workspace: ws })).toBe(true);
    const text = out.join('\n');
    expect(text).toContain('explain/how.md');
    expect(text).toContain('How does it work?');
    expect(text).toContain('area: plan:own');
    expect(text).toContain('parts: The part');
    expect(text).toContain('code blocks: 1');
    expect(text).toContain('All copies match');
    expect(process.exitCode).toBeUndefined();
  });

  it('lists a changed copy with where and its status, and a moved one with the new lines, and still exits 0', async () => {
    await put('explain/changed.md', answer(['two', 'THREE']));
    await put('explain/moved.md', answer(['three', 'four']));
    expect(await explainCommand({ workspace: ws })).toBe(true);
    const text = out.join('\n');
    expect(text).toContain('area: no area');
    expect(text).toContain('refresh: Refresh the answer explain/changed.md ("How does it work?"): these copies no longer match: Repo/src/a.ts:2-3 (changed). Follow the contextspace-explain skill and run ctxspace explain until all copies match.');
    expect(text).toContain('does not match: Repo/src/a.ts:2-3 changed');
    expect(text).toContain('does not match: Repo/src/a.ts:2-3 moved (now 3-4');
    expect(text).not.toContain('All copies match');
    expect(process.exitCode).toBeUndefined();
  });

  it('gives the same data as JSON', async () => {
    await put('explain/changed.md', answer(['two', 'THREE'], 'checkpoint:first'));
    await explainCommand({ workspace: ws, json: true });
    expect(JSON.parse(out.join('\n'))).toEqual({
      allMatch: false,
      answers: [{ path: 'explain/changed.md', question: 'How does it work?',
        refresh: 'Refresh the answer explain/changed.md ("How does it work?"): these copies no longer match: Repo/src/a.ts:2-3 (changed). Follow the contextspace-explain skill and run ctxspace explain until all copies match.', area: 'checkpoint:first', parts: ['The part'], codeBlocks: 1, notMatching: [{ where: 'Repo/src/a.ts:2-3', status: 'changed' }] }],
    });
    out.length = 0;
    await put('explain/changed.md', answer(['two', 'three']));
    await explainCommand({ workspace: ws, json: true });
    expect(JSON.parse(out.join('\n'))).toMatchObject({ allMatch: true });
  });

  it('says there are no answers, without failing, when there is no explain folder', async () => {
    expect(await explainCommand({ workspace: ws })).toBe(true);
    expect(out.join('\n')).toMatch(/No answers yet/);
    out.length = 0;
    await explainCommand({ workspace: ws, json: true });
    expect(JSON.parse(out.join('\n'))).toEqual({ answers: [], allMatch: true });
  });

  it('writes nothing', async () => {
    await put('explain/how.md', answer(['two', 'three']));
    const before = await fs.readdir(ws, { recursive: true });
    await explainCommand({ workspace: ws });
    await explainCommand({ workspace: ws, areas: true });
    expect(await fs.readdir(ws, { recursive: true })).toEqual(before);
  });

  it('--areas lists the Area ids and titles an answer can use, the same ones board_read gives', async () => {
    await put('PLAN.md', '# Plan\n\nGoal.\n\n## Checkpoints\n\n- [x] Open root reports\n- [ ] Reports export to CSV\n  - [ ] Query the rows\n');
    expect(await explainCommand({ workspace: ws, areas: true })).toBe(true);
    const text = out.join('\n');
    expect(text).toContain('checkpoint:open-root-reports  Open root reports');
    expect(text).toContain('checkpoint:reports-export-to-csv  Reports export to CSV  (current)');
    out.length = 0;
    await explainCommand({ workspace: ws, areas: true, json: true });
    const { areas } = JSON.parse(out.join('\n'));
    expect(areas.current).toBe('checkpoint:reports-export-to-csv');
    expect(areas.items.map((item: { id: string }) => item.id)).toEqual(['checkpoint:open-root-reports', 'checkpoint:reports-export-to-csv']);
  });

  it('is registered as `explain`, with --json and --areas', async () => {
    await put('explain/how.md', answer(['two', 'three']));
    const program = new Command();
    program.exitOverride();
    registerExplainCommand(program);
    await program.parseAsync(['node', 'ctxspace', 'explain', '-w', ws, '--json']);
    expect(JSON.parse(out.join('\n')).allMatch).toBe(true);
    out.length = 0;
    await program.parseAsync(['node', 'ctxspace', 'explain', '--areas', '-w', ws]);
    expect(out.join('\n')).toBeTruthy();
    expect(err).toEqual([]);
  });

  it('outside a workspace says so in one plain line and exits 1; with --json it gives { error } and exits 1', async () => {
    const outside = path.join(tempDir, 'nowhere');
    await fs.mkdir(outside);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(outside);
    expect(await explainCommand({})).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/Not inside a ContextSpace workspace/);
    expect(err[0]).not.toMatch(/\n\s+at /);
    process.exitCode = undefined;
    err.length = 0;
    expect(await explainCommand({ json: true })).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out.join('\n'))).toEqual({ error: expect.stringMatching(/Not inside a ContextSpace workspace/) });
    expect(err).toEqual([]);
    cwd.mockRestore();
  });

  it('-w <bad> says so in one plain line, with no stack trace, and exits 1; with --json it gives { error }', async () => {
    expect(await explainCommand({ workspace: path.join(tempDir, 'nonexistent') })).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/Invalid workspace/);
    expect(err[0]).not.toMatch(/\n\s+at /);
    process.exitCode = undefined;
    out.length = 0;
    expect(await explainCommand({ workspace: path.join(tempDir, 'nonexistent'), json: true })).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out.join('\n'))).toEqual({ error: expect.stringMatching(/Invalid workspace/) });
  });
});
