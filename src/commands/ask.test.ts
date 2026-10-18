import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { askCommand, askHarness } from './ask.js';
import * as workspace from '../core/workspace.js';
import * as resolve from '../utils/resolve-workspace.js';
import { PRIMARY_MANIFEST_FILE } from '../core/constants.js';

vi.mock('../utils/resolve-workspace.js');

describe('askHarness', () => {
  it('prefers --harness, then CTXSPACE_HARNESS, then Claude Code, then just "agent"', () => {
    expect(askHarness({ harness: 'gemini' }, { CTXSPACE_HARNESS: 'codex', CLAUDECODE: '1' })).toBe('gemini');
    expect(askHarness({}, { CTXSPACE_HARNESS: 'codex', CLAUDECODE: '1' })).toBe('codex');
    expect(askHarness({}, { CLAUDECODE: '1' })).toBe('claude');
    expect(askHarness({}, {})).toBe('agent');
  });

  it('writes the name the way the plan does: trimmed and in lower case, and "agent" for a blank one', () => {
    expect(askHarness({ harness: '  Codex ' }, {})).toBe('codex');
    expect(askHarness({ harness: '  ' }, {})).toBe('agent');
  });

  it('lets a blank name fall through to the next one', () => {
    expect(askHarness({ harness: ' ' }, { CTXSPACE_HARNESS: '', CLAUDECODE: '1' })).toBe('claude');
  });
});

describe('askCommand', () => {
  let dir: string;
  let ledger: string;
  let output: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-ask-'));
    await fs.mkdir(path.join(dir, '.contextspace'), { recursive: true });
    await fs.writeFile(path.join(dir, PRIMARY_MANIFEST_FILE), '{}\n', 'utf8');
    ledger = path.join(dir, '.contextspace', 'chat.jsonl');
    vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue({
      id: 'ws-one', branchName: 'ws-one', description: 'Test workspace', mode: 'worktree', repos: [], assistants: [], workspacePath: dir, createdAt: new Date().toISOString(),
    });
    vi.mocked(resolve.resolveWorkspaceQuiet).mockResolvedValue(dir);
    output = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { output.push(args.join(' ')); });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const entries = async () => (await fs.readFile(ledger, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));

  it('raises the alert the MCP tool raises and tells the AI to wait for the answer in the chat', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CTXSPACE_HARNESS', '');

    await askCommand('Which branch should I target?', { option: ['main', 'release'] });

    expect(await entries()).toEqual([expect.objectContaining({
      kind: 'input_request', author: 'agent', harness: 'claude', message: 'Which branch should I target?', options: ['main', 'release'],
    })]);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain('The user has been alerted. Write your full question in the chat and end your turn');
  });

  it('puts the question in the plan too, as the MCP tool does', async () => {
    await askCommand('Which branch should I target?', {});

    expect(await fs.readFile(path.join(dir, 'PLAN.md'), 'utf8')).toContain('Which branch should I target?');
    expect(output[0]).toContain('It is a decision in PLAN.md too');
  });

  it('counts the same question asked twice in a row as one alert', async () => {
    await askCommand('Proceed?', { harness: 'codex' });
    await askCommand('Proceed?', { harness: 'codex' });

    expect(await entries()).toHaveLength(1);
    expect(output).toHaveLength(2);
    expect(output[1]).toContain('end your turn');
  });

  it('refuses an empty or over-long question and writes nothing', async () => {
    await expect(askCommand('   ', {})).rejects.toThrow('The request message cannot be empty.');
    await expect(askCommand('x'.repeat(501), {})).rejects.toThrow('keep it to 500 or fewer');

    expect(await entries()).toEqual([]);
    expect(output).toEqual([]);
  });

  it('says so when it runs outside a workspace', async () => {
    vi.mocked(resolve.resolveWorkspaceQuiet).mockResolvedValue(null);

    await expect(askCommand('Proceed?', {})).rejects.toThrow('No workspace here');
  });

  it('asks in the workspace named with --workspace', async () => {
    await askCommand('Proceed?', { workspace: 'ws-one' });

    expect(resolve.resolveWorkspaceQuiet).toHaveBeenCalledWith('ws-one');
  });
});
