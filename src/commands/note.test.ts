import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';

import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { setActiveStorageProvider } from '../core/adapters/registry.js';
import { noteAddCommand, noteListCommand, registerNoteCommand } from './note.js';

let tempDir: string;
let workspaceDir: string;
let c1: string;
let c2: string;

const gitEnv = {
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '2026-10-01T10:00:00Z',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_COMMITTER_DATE: '2026-10-01T10:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
};

async function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execa('git', args, { cwd, env: { ...process.env, ...gitEnv, ...env } });
}

beforeEach(async () => {
  setActiveStorageProvider(new LocalStorageAdapter());
  tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'note-cmd-test-')));
  workspaceDir = path.join(tempDir, 'workspace');
  const repoPath = path.join(workspaceDir, 'NexusFlow');
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, ['init', '-b', 'main']);
  await fs.writeFile(path.join(repoPath, 'a.txt'), 'a\n');
  await git(repoPath, ['add', 'a.txt']);
  await git(repoPath, ['commit', '-m', 'First']);
  c1 = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

  await fs.writeFile(path.join(repoPath, 'b.txt'), 'b\n');
  await git(repoPath, ['add', 'b.txt']);
  await git(repoPath, ['commit', '-m', 'Second'], {
    GIT_AUTHOR_DATE: '2026-10-01T11:00:00Z',
    GIT_COMMITTER_DATE: '2026-10-01T11:00:00Z',
  });
  c2 = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

  await fs.writeFile(
    path.join(workspaceDir, 'contextspace.json'),
    JSON.stringify({
      id: 'ws-note-cmd',
      name: 'ws-note-cmd',
      branchName: 'main',
      repos: ['NexusFlow'],
      assistants: [],
      workspacePath: workspaceDir,
    }),
  );
  process.exitCode = undefined;
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ctxspace note CLI command', () => {
  it('adds and lists notes via CLI handlers, newest first with hash, repo, who, when, title, and body', async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => out.push(String(msg ?? '')));
    vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => err.push(String(msg ?? '')));

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T08:00:00.000Z'));
    expect(await noteAddCommand(c1.slice(0, 7), 'First finding\nCheck edge case', { workspace: workspaceDir, harness: 'claude' })).toBe(true);

    vi.setSystemTime(new Date('2026-10-12T08:05:00.000Z'));
    expect(await noteAddCommand('HEAD', 'Updated body text', { workspace: workspaceDir, title: 'Rebase choice', harness: 'codex' })).toBe(true);

    out.length = 0;
    expect(await noteListCommand(undefined, { workspace: workspaceDir })).toBe(true);
    const rendered = out.join('\n');
    expect(rendered).toContain(c2.slice(0, 7));
    expect(rendered).toContain(c1.slice(0, 7));
    expect(rendered).toContain('NexusFlow');
    expect(rendered).toContain('codex');
    expect(rendered).toContain('claude');
    expect(rendered).toContain('2026-10-12T08:05:00.000Z');
    expect(rendered).toContain('2026-10-12T08:00:00.000Z');
    expect(rendered).toContain('Rebase choice');
    expect(rendered).toContain('Updated body text');
    expect(rendered).toContain('First finding');
    expect(rendered).toContain('Check edge case');
    // Newest first (c2 before c1)
    expect(rendered.indexOf('Rebase choice')).toBeLessThan(rendered.indexOf('First finding'));
    expect(err).toEqual([]);
  });

  it('wires Commander parsing for both `note <commit> "<text>"` and `note list [<commit>]`', async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => out.push(String(msg ?? '')));
    vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => err.push(String(msg ?? '')));

    const program = new Command();
    program.exitOverride();
    registerNoteCommand(program);

    await program.parseAsync([
      'node', 'ctxspace',
      'note', c1.slice(0, 7), 'Conflict fixed',
      '--repo', 'NexusFlow',
      '--title', 'Merge decision',
      '--harness', 'gemini',
      '-w', workspaceDir,
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(out.join('\n')).toContain('Merge decision');

    out.length = 0;
    await program.parseAsync([
      'node', 'ctxspace',
      'note', 'list', 'HEAD~1',
      '--repo', 'NexusFlow',
      '-w', workspaceDir,
      '--json',
    ]);
    const parsed = JSON.parse(out.join('\n')) as { notes: Array<{ sha: string; title: string; by: string }> };
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]).toMatchObject({ sha: c1, title: 'Merge decision', by: 'gemini' });

    out.length = 0;
    await program.parseAsync(['node', 'ctxspace', 'note', 'list', '-w', workspaceDir, '--json']);
    const listedAll = JSON.parse(out.join('\n')) as { notes: Array<{ sha: string }> };
    expect(listedAll.notes.map((n) => n.sha)).toEqual([c1]);

    // Unknown commit fails cleanly with exitCode = 1
    out.length = 0;
    err.length = 0;
    await program.parseAsync(['node', 'ctxspace', 'note', 'deadbeef999', 'Nope', '-w', workspaceDir]);
    expect(process.exitCode).toBe(1);
    expect(err.join('\n')).toContain('was not found');
  });

  it('prefers the repository containing cwd for HEAD in multi-repo workspaces, and still asks for --repo at root', async () => {
    const appDir = path.join(workspaceDir, 'NexusFlow');
    const otherDir = path.join(workspaceDir, 'Other');
    await fs.mkdir(otherDir, { recursive: true });
    await git(otherDir, ['init', '-b', 'main']);
    await fs.writeFile(path.join(otherDir, 'other.txt'), 'o\n');
    await git(otherDir, ['add', 'other.txt']);
    await git(otherDir, ['commit', '-m', 'Other init']);
    await fs.writeFile(
      path.join(workspaceDir, 'contextspace.json'),
      JSON.stringify({
        id: 'ws-note-cmd',
        name: 'ws-note-cmd',
        branchName: 'main',
        repos: ['NexusFlow', 'Other'],
        assistants: [],
        workspacePath: workspaceDir,
      }),
    );

    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => out.push(String(msg ?? '')));
    vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => err.push(String(msg ?? '')));

    const cwdSpy = vi.spyOn(process, 'cwd');
    const program = new Command();
    program.exitOverride();
    registerNoteCommand(program);

    // cd ws/NexusFlow && ctxspace note HEAD "x" stores the note on NexusFlow without --repo
    cwdSpy.mockReturnValue(appDir);
    await program.parseAsync(['node', 'ctxspace', 'note', 'HEAD', 'x']);
    expect(process.exitCode).toBeUndefined();
    expect(out.join('\n')).toContain('(NexusFlow)');

    // From workspace root, HEAD still asks for --repo
    out.length = 0;
    err.length = 0;
    cwdSpy.mockReturnValue(workspaceDir);
    await program.parseAsync(['node', 'ctxspace', 'note', 'HEAD', 'x']);
    expect(process.exitCode).toBe(1);
    expect(err.join('\n')).toContain('--repo');
  });

  it('accepts note text starting with "-" via "--" with trailing options, "--text", and stdin ("-"), and shows them in --help', async () => {
    const otherDir = path.join(workspaceDir, 'Other');
    await fs.mkdir(otherDir, { recursive: true });
    await git(otherDir, ['init', '-b', 'main']);
    await fs.writeFile(path.join(otherDir, 'o.txt'), 'o\n');
    await git(otherDir, ['add', 'o.txt']);
    await git(otherDir, ['commit', '-m', 'Other']);
    await fs.writeFile(
      path.join(workspaceDir, 'contextspace.json'),
      JSON.stringify({
        id: 'ws-note-cmd',
        name: 'ws-note-cmd',
        branchName: 'main',
        repos: ['NexusFlow', 'Other'],
        assistants: [],
        workspacePath: workspaceDir,
      }),
    );

    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => out.push(String(msg ?? '')));
    vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => err.push(String(msg ?? '')));

    // 1. `--` followed by text starting with `-` and trailing `--repo Other`
    {
      const program = new Command();
      program.exitOverride();
      registerNoteCommand(program);
      await program.parseAsync([
        'node', 'ctxspace',
        'note', 'HEAD', '--', '--force-push happened', '--repo', 'Other', '-w', workspaceDir,
      ]);
      expect(process.exitCode).toBeUndefined();
    }

    // 2. `--text "<text>"`
    {
      const program = new Command();
      program.exitOverride();
      registerNoteCommand(program);
      await program.parseAsync([
        'node', 'ctxspace',
        'note', 'HEAD', '--text', '--rebase aborted', '--repo', 'Other', '-w', workspaceDir,
      ]);
      expect(process.exitCode).toBeUndefined();
    }

    // 3. Stdin with `-` (both positional `-` and `--text -`)
    {
      const program = new Command();
      program.exitOverride();
      (registerNoteCommand as (p: Command, io?: { stdin?: NodeJS.ReadableStream }) => void)(
        program,
        { stdin: Readable.from(['--stdin-pos happened\nsecond line\n']) },
      );
      await program.parseAsync([
        'node', 'ctxspace',
        'note', 'HEAD', '-', '--repo', 'Other', '-w', workspaceDir,
      ]);
      expect(process.exitCode).toBeUndefined();
    }
    {
      const program = new Command();
      program.exitOverride();
      (registerNoteCommand as (p: Command, io?: { stdin?: NodeJS.ReadableStream }) => void)(
        program,
        { stdin: Readable.from(['--stdin-opt happened\n']) },
      );
      await program.parseAsync([
        'node', 'ctxspace',
        'note', 'HEAD', '--text', '-', '--repo', 'Other', '-w', workspaceDir,
      ]);
      expect(process.exitCode).toBeUndefined();
    }

    // Verify all 4 notes were recorded with exact leading `-` bodies on Other
    out.length = 0;
    await noteListCommand(undefined, { workspace: workspaceDir, repo: 'Other', json: true });
    const parsed = JSON.parse(out.join('\n')) as { notes: Array<{ body: string; repo: string }> };
    expect(parsed.notes.map((n) => n.body)).toEqual(
      expect.arrayContaining([
        '--force-push happened',
        '--rebase aborted',
        '--stdin-pos happened\nsecond line',
        '--stdin-opt happened',
      ]),
    );
    expect(parsed.notes.every((n) => n.repo === 'Other')).toBe(true);

    // 4. Help output documents --text, -, and --
    const helpProgram = new Command();
    registerNoteCommand(helpProgram);
    const helpText = helpProgram.commands.find((c) => c.name() === 'note')!.helpInformation();
    expect(helpText).toContain('--text');
    expect(helpText).toContain('stdin');
    expect(helpText).toContain(' -- ');
    expect(err).toEqual([]);
  });

  it('prints "No notes on commits in <repo>." when note list --repo <repo> has no notes', async () => {
    const otherDir = path.join(workspaceDir, 'Other');
    await fs.mkdir(otherDir, { recursive: true });
    await git(otherDir, ['init', '-b', 'main']);
    await fs.writeFile(path.join(otherDir, 'o.txt'), 'o\n');
    await git(otherDir, ['add', 'o.txt']);
    await git(otherDir, ['commit', '-m', 'Other']);
    await fs.writeFile(
      path.join(workspaceDir, 'contextspace.json'),
      JSON.stringify({
        id: 'ws-note-cmd',
        name: 'ws-note-cmd',
        branchName: 'main',
        repos: ['NexusFlow', 'Other'],
        assistants: [],
        workspacePath: workspaceDir,
      }),
    );

    await noteAddCommand(c1.slice(0, 7), 'Note only in NexusFlow', { workspace: workspaceDir, repo: 'NexusFlow' });
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => out.push(String(msg ?? '')));

    expect(await noteListCommand(undefined, { workspace: workspaceDir, repo: 'Other' })).toBe(true);
    expect(out.join('\n')).toBe('No notes on commits in Other.');
  });
});
