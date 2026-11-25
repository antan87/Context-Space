import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';

import { migrateWorkspace } from '../core/plan-migrate.js';
import { closeAppDb } from '../core/workspace-db-app.js';
import { boardDbForApp } from '../core/board-db-app.js';
import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { getStorageProvider, setActiveStorageProvider } from '../core/adapters/registry.js';
import { enabledTools, findTool, type ToolContext } from './tools.js';
import type { NexusFlowConfig } from '../types.js';

const config: NexusFlowConfig = {
  version: '1.0',
  devDir: '/dev',
  workspacesDir: '/dev/workspaces',
  defaultAssistant: null,
  scanDepth: 2,
};

let tempDir: string;
let root: string;
let c1: string;

const gitEnv = {
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '2026-10-01T10:00:00Z',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_COMMITTER_DATE: '2026-10-01T10:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
};

const ctx = (): ToolContext => ({ config, workspacePath: root });

async function call(name: string, args: Record<string, unknown> = {}) {
  const tool = findTool(name);
  if (!tool) throw new Error(`Missing MCP tool: ${name}`);
  const result = await tool.handler(args, ctx());
  const text = result.content[0]!.text;
  return {
    isError: Boolean(result.isError),
    text,
    body: result.isError ? undefined : JSON.parse(text),
  };
}

beforeEach(async () => {
  setActiveStorageProvider(new LocalStorageAdapter());
  tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-commit-note-')));
  root = path.join(tempDir, 'ws');
  const repoDir = path.join(root, 'NexusFlow');
  await fs.mkdir(repoDir, { recursive: true });
  await execa('git', ['init', '-b', 'main'], { cwd: repoDir, env: { ...process.env, ...gitEnv } });
  await fs.writeFile(path.join(repoDir, 'a.txt'), 'a\n');
  await execa('git', ['add', 'a.txt'], { cwd: repoDir, env: { ...process.env, ...gitEnv } });
  await execa('git', ['commit', '-m', 'Initial'], { cwd: repoDir, env: { ...process.env, ...gitEnv } });
  c1 = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();

  await fs.writeFile(
    path.join(root, 'contextspace.json'),
    JSON.stringify({
      id: 'ws-mcp-note',
      name: 'ws-mcp-note',
      branchName: 'main',
      repos: ['NexusFlow'],
      assistants: [],
      workspacePath: root,
    }),
  );
});

afterEach(async () => {
  vi.useRealTimers();
  await closeAppDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('commit note MCP tools', () => {
  it('adds and lists a moved commit note as one database card and link', async () => {
    setActiveStorageProvider(getStorageProvider('local'));
    await fs.writeFile(path.join(root, 'PLAN.md'), '# Plan\n\n## Checkpoints\n\n- [ ] Ship it\n');
    await migrateWorkspace(root, { by: 'user', backup: false, findOlderWriters: async () => [] });
    const added = await call('note_on_commit', { commit: 'HEAD', text: 'Keep both changes', harness: 'codex' });
    expect(added.isError, added.text).toBe(false);
    const { note, commitNodeId } = added.body;
    expect(note).toMatchObject({ id: /^k/, sha: c1, by: 'codex' });
    const listed = await call('notes_on_commit', { commit: c1.slice(0, 7) });
    expect(listed.body.notes).toEqual([note]);
    expect((await boardDbForApp(root)).links).toContainEqual(expect.objectContaining({ from: note.id, to: commitNodeId }));
    await expect(fs.access(path.join(root, 'contextspace-board.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('registers note_on_commit and notes_on_commit with right schemas, hints, and role scoping', () => {
    const writeTool = findTool('note_on_commit')!;
    const readTool = findTool('notes_on_commit')!;
    expect(writeTool).toBeDefined();
    expect(readTool).toBeDefined();

    expect(writeTool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(readTool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(writeTool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['commit', 'text'] });
    expect(readTool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });

    for (const role of ['readonly', 'review'] as const) {
      const names = enabledTools(config, role).map((tool) => tool.name);
      expect(names).toContain('notes_on_commit');
      expect(names).not.toContain('note_on_commit');
    }
    for (const role of ['developer', 'interactive', 'full'] as const) {
      const names = enabledTools(config, role).map((tool) => tool.name);
      expect(names).toContain('notes_on_commit');
      expect(names).toContain('note_on_commit');
    }
  });

  it('adds and reads commit notes, returning newest first and surfacing clear errors', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T10:00:00.000Z'));
    const first = await call('note_on_commit', {
      commit: c1.slice(0, 7),
      text: 'Kept both conflict hunks\nNeed manual check in rows.',
      harness: 'claude',
    });
    expect(first.isError, first.text).toBe(false);
    expect(first.body.note).toMatchObject({
      repo: 'NexusFlow',
      sha: c1,
      shortSha: c1.slice(0, 7),
      title: 'Kept both conflict hunks',
      by: 'claude',
    });

    vi.setSystemTime(new Date('2026-10-14T10:02:00.000Z'));
    const second = await call('note_on_commit', {
      commit: 'HEAD',
      text: 'Follow-up note body',
      title: 'Explicit MCP title',
      harness: 'user',
    });
    expect(second.isError, second.text).toBe(false);
    expect(second.body.note.by).toBe('ai');

    const listed = await call('notes_on_commit', { commit: c1.slice(0, 7) });
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.body.notes.map((n: { id: string }) => n.id)).toEqual([
      second.body.note.id,
      first.body.note.id,
    ]);

    const bad = await call('note_on_commit', { commit: 'deadbeef1234', text: 'Not here' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/was not found/);

    const extraProp = await call('notes_on_commit', { bogus: true });
    expect(extraProp.isError).toBe(true);
  });

  it('resolves workspace root from a repo subdirectory and never returns empty notes when notes exist', async () => {
    const otherDir = path.join(root, 'Other');
    const nestedDir = path.join(otherDir, 'src', 'deep');
    await fs.mkdir(nestedDir, { recursive: true });
    await execa('git', ['init', '-b', 'main'], { cwd: otherDir, env: { ...process.env, ...gitEnv } });
    await fs.writeFile(path.join(otherDir, 'o.txt'), 'o\n');
    await execa('git', ['add', 'o.txt'], { cwd: otherDir, env: { ...process.env, ...gitEnv } });
    await execa('git', ['commit', '-m', 'Other init'], { cwd: otherDir, env: { ...process.env, ...gitEnv } });

    await fs.writeFile(
      path.join(root, 'contextspace.json'),
      JSON.stringify({
        id: 'ws-mcp-note',
        name: 'ws-mcp-note',
        branchName: 'main',
        repos: ['NexusFlow', 'Other'],
        assistants: [],
        workspacePath: root,
      }),
    );

    const writeTool = findTool('note_on_commit')!;
    const readTool = findTool('notes_on_commit')!;

    // Calling from root repo note first
    await call('note_on_commit', { commit: c1.slice(0, 7), text: 'Root note on NexusFlow' });

    // Calling from <ws>/Other and <ws>/Other/src/deep resolves root AND prefers Other for HEAD.
    const subWrite = await writeTool.handler(
      { commit: 'HEAD', text: 'Note from subdir', harness: 'claude' },
      { config, workspacePath: otherDir },
    );
    expect(subWrite.isError, subWrite.content[0]!.text).toBeFalsy();
    expect(JSON.parse(subWrite.content[0]!.text).note.repo).toBe('Other');

    const subList = await readTool.handler({}, { config, workspacePath: nestedDir });
    expect(subList.isError, subList.content[0]!.text).toBeFalsy();
    const listed = JSON.parse(subList.content[0]!.text).notes as Array<{ repo: string; title: string }>;
    expect(listed.map((n) => n.title)).toEqual(['Note from subdir', 'Root note on NexusFlow']);

    // No stray board file created inside the subdirectory.
    await expect(fs.access(path.join(otherDir, 'contextspace-board.json'))).rejects.toThrow();

    // Non-workspace directory errors cleanly rather than returning [].
    const outside = path.join(tempDir, 'not-a-workspace');
    await fs.mkdir(outside, { recursive: true });
    const badList = await readTool.handler({}, { config, workspacePath: outside });
    expect(badList.isError).toBe(true);
  });
});
