import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { enabledTools, findTool, INPUT_REQUEST_MAX_LENGTH, type ToolContext } from './tools.js';
import * as workspace from '../core/workspace.js';
import { PRIMARY_MANIFEST_FILE, readWorkspaceChatMessages } from '../core/constants.js';
import { INPUT_REQUEST_HARNESS_LIMIT } from '../core/attention.js';
import { changePlan, readPlan, PLAN_STORE_FILE } from '../core/plan.js';
import { questionTitle } from '../core/plan-questions.js';
import type { NexusFlowConfig } from '../types.js';

const config: NexusFlowConfig = {
  version: '1.0',
  devDir: '/dev',
  workspacesDir: '/dev/workspaces',
  defaultAssistant: null,
  scanDepth: 2,
};

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const target of cleanupPaths.splice(0)) {
    const resolved = path.resolve(target);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      await fs.rm(resolved, { recursive: true, force: true }).catch(() => {});
    }
  }
});

async function makeWorkspace(options: { legacy?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-input-request-'));
  cleanupPaths.push(root);
  const dir = path.join(root, 'ws-one');
  await fs.mkdir(path.join(dir, options.legacy ? '.nexusflow' : '.contextspace'), { recursive: true });
  // A real manifest lets findWorkspaceRoot climb from a subfolder.
  await fs.writeFile(path.join(dir, PRIMARY_MANIFEST_FILE), '{}\n', 'utf8');
  vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue({
    id: 'ws-one',
    branchName: 'ws-one',
    description: 'Test workspace',
    mode: 'worktree',
    repos: [],
    assistants: [],
    workspacePath: dir,
    createdAt: new Date().toISOString(),
  });
  return { dir, ledger: path.join(dir, options.legacy ? '.nexusflow' : '.contextspace', 'chat.jsonl') };
}

const tool = () => findTool('request_user_input')!;
const ctxFor = (workspacePath: string): ToolContext => ({ config, workspacePath });
const body = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);

async function ledgerEntries(ledger: string): Promise<any[]> {
  const raw = await fs.readFile(ledger, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('request_user_input', () => {
  it('is registered as a non-read-only tool that tells the agent to end its turn', () => {
    expect(tool()).toBeDefined();
    expect(tool().annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tool().description).toContain('end your turn');
    expect(tool().inputSchema).toMatchObject({ required: ['message'] });
  });

  it('is offered to developer, interactive and full sessions only', () => {
    for (const role of ['developer', 'interactive', 'full'] as const) {
      expect(enabledTools(config, role).map((t) => t.name)).toContain('request_user_input');
    }
    for (const role of ['readonly', 'review', 'ci'] as const) {
      expect(enabledTools(config, role).map((t) => t.name)).not.toContain('request_user_input');
    }
    expect(enabledTools(config, 'interactive', undefined, ['request_user_input']).map((t) => t.name))
      .not.toContain('request_user_input');
  });

  it('appends one input_request entry to the ledger and tells the agent to wait', async () => {
    const { dir, ledger } = await makeWorkspace();

    const result = await tool().handler({ message: '  Which branch should I target?  ', harness: 'claude' }, ctxFor(dir));

    expect(result.isError).toBeFalsy();
    const payload = body(result);
    expect(payload).toMatchObject({ status: 'requested', workspaceId: 'ws-one', harness: 'claude' });
    expect(payload.message).toContain('end your turn');

    const entries = await ledgerEntries(ledger);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'input_request',
      author: 'agent',
      harness: 'claude',
      message: 'Which branch should I target?',
      timestamp: payload.timestamp,
    });
    expect(typeof entries[0].id).toBe('string');
    expect(entries[0].id.length).toBeGreaterThan(0);
  });

  it('puts the question in the plan too, held up by the milestone in progress, and tells the AI its code', async () => {
    const { dir } = await makeWorkspace();
    const user = { actor: { by: 'user' } } as const;
    await changePlan(dir, { type: 'add', kind: 'milestone', title: 'Chat docked' }, user);
    await changePlan(dir, { type: 'start', id: 'M1' }, user);

    const payload = body(await tool().handler({ message: 'Which branch should I target?', options: ['main', 'release'], harness: 'claude' }, ctxFor(dir)));
    expect(payload).toMatchObject({ status: 'requested', planQuestion: 'Q1 Which branch should I target?' });
    expect(payload.message).toContain('record it: ctxspace plan answer Q1 "<their answer>"');

    const plan = await readPlan(dir);
    const question = plan.items.find((item) => item.id === 'Q1')!;
    expect(question).toMatchObject({ kind: 'question', owner: 'user', status: 'todo', title: 'Which branch should I target?', detail: 'Suggested answers: main · release' });
    expect(question.history[0]).toMatchObject({ by: 'claude', action: 'added' });
    // The milestone cannot be finished while the user's question is open.
    expect(plan.items.find((item) => item.id === 'M1')!.waitsFor).toEqual(['Q1']);

    // The same question asked again after the repeat window, still open in the plan: one question.
    vi.useFakeTimers({ now: Date.now() + 10 * 60_000, toFake: ['Date'] });
    try {
      expect(body(await tool().handler({ message: 'Which branch should I target?', harness: 'claude' }, ctxFor(dir)))).toMatchObject({ planQuestion: 'Q1 Which branch should I target?' });
    } finally {
      vi.useRealTimers();
    }
    expect((await readPlan(dir)).items.filter((item) => item.kind === 'question')).toHaveLength(1);
  });

  it('still alerts the user when the plan cannot be changed', async () => {
    const { dir, ledger } = await makeWorkspace();
    await fs.writeFile(path.join(dir, PLAN_STORE_FILE), '{ broken', 'utf8');
    const payload = body(await tool().handler({ message: 'Ship it?', harness: 'claude' }, ctxFor(dir)));
    expect(payload).toMatchObject({ status: 'requested' });
    expect(payload).not.toHaveProperty('planQuestion');
    expect(await ledgerEntries(ledger)).toHaveLength(1);
  });

  it('names a long question by its opening, cut at a word, and keeps the whole question as its detail', () => {
    const long = `Should the reader ${'open each document in its own tab and remember the scroll position, '.repeat(4)}or not?`;
    const title = questionTitle(long);
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.endsWith('…')).toBe(true);
    expect(long.startsWith(title.slice(0, -1).trimEnd())).toBe(true);
    expect(questionTitle('  Which   branch?\n')).toBe('Which branch?');
  });

  it('defaults the harness to "agent"', async () => {
    const { dir, ledger } = await makeWorkspace();
    await tool().handler({ message: 'Ready for review?' }, ctxFor(dir));
    expect((await ledgerEntries(ledger))[0].harness).toBe('agent');
  });

  describe('keeps what it stores safe to show', () => {
    it('strips control characters from the message and compares the cleaned text', async () => {
      const { dir, ledger } = await makeWorkspace();
      const first = await tool().handler({ message: '\u001b[31mDelete\u0007 it?\u0000' }, ctxFor(dir));
      // The same text without the control characters is the same request.
      const second = await tool().handler({ message: '[31mDelete it?' }, ctxFor(dir));

      expect(body(first).status).toBe('requested');
      expect(body(second).status).toBe('already_requested');
      const entries = await ledgerEntries(ledger);
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe('[31mDelete it?');
    });

    it('rejects a message that is only control characters', async () => {
      const { dir, ledger } = await makeWorkspace();
      const result = await tool().handler({ message: '\u0007\u0000\u001b' }, ctxFor(dir));
      expect(result.isError).toBe(true);
      expect(await ledgerEntries(ledger)).toEqual([]);
    });

    it.each([
      ['whitespace only', '   ', 'agent'],
      ['control characters only', '\u0007\u0000', 'agent'],
      ['control characters inside', 'cl\u001bau\u0000de', 'claude'],
      ['longer than the limit', 'h'.repeat(100), 'h'.repeat(INPUT_REQUEST_HARNESS_LIMIT)],
    ])('cleans a harness name that is %s', async (_label, harness, expected) => {
      const { dir, ledger } = await makeWorkspace();
      await tool().handler({ message: 'Ready?', harness }, ctxFor(dir));
      expect((await ledgerEntries(ledger))[0].harness).toBe(expected);
    });
  });

  it('writes to the workspace root when the server runs in a subfolder', async () => {
    const { dir, ledger } = await makeWorkspace();
    const sub = path.join(dir, 'NexusFlow', 'src');
    await fs.mkdir(sub, { recursive: true });

    const result = await tool().handler({ message: 'Keep the old API?' }, ctxFor(sub));

    expect(result.isError).toBeFalsy();
    expect(await ledgerEntries(ledger)).toHaveLength(1);
    await expect(fs.access(path.join(sub, '.contextspace'))).rejects.toThrow();
  });

  it('keeps writing to a legacy .nexusflow ledger and preserves its history', async () => {
    const { dir, ledger } = await makeWorkspace({ legacy: true });
    await fs.writeFile(ledger, JSON.stringify({ id: 'old-1', timestamp: '2026-09-01T00:00:00.000Z', author: 'agent', message: 'Earlier handoff' }) + '\n', 'utf8');

    await tool().handler({ message: 'Need a decision' }, ctxFor(dir));

    const { messages, ledgerInfo } = await readWorkspaceChatMessages(dir);
    expect(ledgerInfo.isLegacy).toBe(true);
    expect(messages.map((m) => m.message)).toEqual(['Earlier handoff', 'Need a decision']);
    await expect(fs.access(path.join(dir, '.contextspace', 'chat.jsonl'))).rejects.toThrow();
  });

  describe('rejects bad input without touching the ledger', () => {
    it.each([
      ['an empty message', ''],
      ['a whitespace-only message', '   \n\t '],
      ['a missing message', undefined],
    ])('%s', async (_label, message) => {
      const { dir, ledger } = await makeWorkspace();
      const result = await tool().handler(message === undefined ? {} : { message }, ctxFor(dir));
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('cannot be empty');
      expect(await ledgerEntries(ledger)).toEqual([]);
    });

    it('a message over the length limit, naming the limit', async () => {
      const { dir, ledger } = await makeWorkspace();
      const result = await tool().handler({ message: 'x'.repeat(INPUT_REQUEST_MAX_LENGTH + 1) }, ctxFor(dir));
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(String(INPUT_REQUEST_MAX_LENGTH));
      expect(await ledgerEntries(ledger)).toEqual([]);
    });

    it('accepts a message exactly at the limit', async () => {
      const { dir, ledger } = await makeWorkspace();
      const result = await tool().handler({ message: 'x'.repeat(INPUT_REQUEST_MAX_LENGTH) }, ctxFor(dir));
      expect(result.isError).toBeFalsy();
      expect(await ledgerEntries(ledger)).toHaveLength(1);
    });

    it('a directory that is not a workspace', async () => {
      const { dir, ledger } = await makeWorkspace();
      vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue(null);
      const result = await tool().handler({ message: 'Anyone there?' }, ctxFor(dir));
      expect(result.isError).toBe(true);
      expect(await ledgerEntries(ledger)).toEqual([]);
    });
  });

  describe('repeat requests', () => {
    it('collapses an identical request from the same harness into one alert', async () => {
      const { dir, ledger } = await makeWorkspace();
      const first = await tool().handler({ message: 'Proceed?', harness: 'codex' }, ctxFor(dir));
      const second = await tool().handler({ message: 'Proceed?', harness: 'codex' }, ctxFor(dir));

      expect(body(first).status).toBe('requested');
      expect(body(second)).toMatchObject({ status: 'already_requested', timestamp: body(first).timestamp });
      expect(body(second).message).toContain('end your turn');
      expect(await ledgerEntries(ledger)).toHaveLength(1);
    });

    it('does not collapse a different message or a different harness', async () => {
      const { dir, ledger } = await makeWorkspace();
      await tool().handler({ message: 'Proceed?', harness: 'codex' }, ctxFor(dir));
      await tool().handler({ message: 'Proceed with the rewrite?', harness: 'codex' }, ctxFor(dir));
      await tool().handler({ message: 'Proceed?', harness: 'pi' }, ctxFor(dir));
      expect(await ledgerEntries(ledger)).toHaveLength(3);
    });

    it('alerts again once the repeat window has passed', async () => {
      const { dir, ledger } = await makeWorkspace();
      const old = new Date(Date.now() - 10 * 60_000).toISOString();
      await fs.writeFile(ledger, JSON.stringify({ id: 'old', timestamp: old, harness: 'agent', author: 'agent', kind: 'input_request', message: 'Proceed?' }) + '\n', 'utf8');

      const result = await tool().handler({ message: 'Proceed?' }, ctxFor(dir));

      expect(body(result).status).toBe('requested');
      expect(await ledgerEntries(ledger)).toHaveLength(2);
    });

    it('raises a new alert for the same generic question asked again after the user answered', async () => {
      // The tool cannot see the user's reply in the terminal, so a repeat a couple of
      // minutes later must not be swallowed as a duplicate.
      const { dir, ledger } = await makeWorkspace();
      const earlier = new Date(Date.now() - 2 * 60_000).toISOString();
      await fs.writeFile(ledger, JSON.stringify({ id: 'q1', timestamp: earlier, harness: 'agent', author: 'agent', kind: 'input_request', message: 'Proceed?' }) + '\n', 'utf8');

      const result = await tool().handler({ message: 'Proceed?' }, ctxFor(dir));

      expect(body(result).status).toBe('requested');
      expect(await ledgerEntries(ledger)).toHaveLength(2);
    });

    it('treats a recent identical request written by another process as a repeat', async () => {
      const { dir, ledger } = await makeWorkspace();
      const recent = new Date(Date.now() - 10_000).toISOString();
      await fs.writeFile(ledger, JSON.stringify({ id: 'other', timestamp: recent, harness: 'agent', author: 'agent', kind: 'input_request', message: 'Proceed?' }) + '\n', 'utf8');

      const result = await tool().handler({ message: 'Proceed?' }, ctxFor(dir));

      expect(body(result).status).toBe('already_requested');
      expect(await ledgerEntries(ledger)).toHaveLength(1);
    });

    it('does not treat an ordinary handoff with the same text as a repeat', async () => {
      const { dir, ledger } = await makeWorkspace();
      await fs.writeFile(ledger, JSON.stringify({ id: 'h', timestamp: new Date().toISOString(), harness: 'agent', author: 'agent', message: 'Proceed?' }) + '\n', 'utf8');

      const result = await tool().handler({ message: 'Proceed?' }, ctxFor(dir));

      expect(body(result).status).toBe('requested');
      expect(await ledgerEntries(ledger)).toHaveLength(2);
    });
  });

  describe('concurrency and recovery', () => {
    it('writes exactly one entry when identical calls arrive in parallel', async () => {
      const { dir, ledger } = await makeWorkspace();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => tool().handler({ message: 'Parallel question' }, ctxFor(dir))),
      );

      expect(results.map((r) => body(r).status).sort()).toEqual([
        'already_requested', 'already_requested', 'already_requested', 'already_requested', 'requested',
      ]);
      expect(await ledgerEntries(ledger)).toHaveLength(1);
    });

    it('keeps every distinct request when calls arrive in parallel', async () => {
      const { dir, ledger } = await makeWorkspace();
      await Promise.all(
        Array.from({ length: 6 }, (_, i) => tool().handler({ message: `Question ${i}` }, ctxFor(dir))),
      );

      const entries = await ledgerEntries(ledger);
      expect(entries.map((e) => e.message).sort()).toEqual(Array.from({ length: 6 }, (_, i) => `Question ${i}`));
      expect(new Set(entries.map((e) => e.id)).size).toBe(6);
    });

    it('still works after an earlier call failed', async () => {
      const { dir, ledger } = await makeWorkspace();
      const failed = await tool().handler({ message: '' }, ctxFor(dir));
      expect(failed.isError).toBe(true);

      const ok = await tool().handler({ message: 'Second try' }, ctxFor(dir));
      expect(body(ok).status).toBe('requested');
      expect(await ledgerEntries(ledger)).toHaveLength(1);
    });

    it('ignores a malformed ledger line and still records the request', async () => {
      const { dir, ledger } = await makeWorkspace();
      await fs.writeFile(ledger, 'this is not json\n{"truncated":\n', 'utf8');

      const result = await tool().handler({ message: 'After corruption' }, ctxFor(dir));

      expect(result.isError).toBeFalsy();
      const { messages } = await readWorkspaceChatMessages(dir);
      expect(messages.map((m) => m.message)).toEqual(['After corruption']);
    });

    it('reports a filesystem failure as a tool error instead of throwing', async () => {
      const { dir, ledger } = await makeWorkspace();
      // A directory where the ledger file should be makes the append fail.
      await fs.mkdir(ledger);

      const result = await tool().handler({ message: 'Will this save?' }, ctxFor(dir));

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Error requesting user input');
    });
  });
});

describe('request_user_input answer options', () => {
  it('advertises options in its schema, limited to six short answers', () => {
    const schema = tool().inputSchema as { properties: { options: { type: string; maxItems: number; items: { maxLength: number } } } };
    expect(schema.properties.options).toMatchObject({ type: 'array', maxItems: 6, items: { maxLength: 80 } });
    expect(tool().description).toContain('press Enter');
  });

  it('stores the options with the request, cleaned, so a button can fill the prompt', async () => {
    const { dir, ledger } = await makeWorkspace();
    const result = await tool().handler({ message: 'Remove the size picker?', options: ['Remove it', '  Keep it \n', '', 'Remove it', '\u0007Both'] }, ctxFor(dir));
    expect(body(result).status).toBe('requested');
    expect((await ledgerEntries(ledger))[0].options).toEqual(['Remove it', 'Keep it', 'Both']);
  });

  it('keeps the ledger entry as it was when no options are given', async () => {
    const { dir, ledger } = await makeWorkspace();
    await tool().handler({ message: 'Ready?' }, ctxFor(dir));
    expect(await ledgerEntries(ledger)).toEqual([expect.not.objectContaining({ options: expect.anything() })]);
  });

  it('keeps no key at all when every option is blank', async () => {
    const { dir, ledger } = await makeWorkspace();
    await tool().handler({ message: 'Ready?', options: ['  ', '\n'] }, ctxFor(dir));
    expect((await ledgerEntries(ledger))[0]).not.toHaveProperty('options');
  });

  it('refuses options that are not a list, and writes nothing', async () => {
    const { dir, ledger } = await makeWorkspace();
    const result = await tool().handler({ message: 'Ready?', options: 'Yes' }, ctxFor(dir));
    expect(result.isError).toBe(true);
    expect(await ledgerEntries(ledger)).toEqual([]);
  });

  it('treats the same question with different options as a new request, and the same options as a repeat', async () => {
    const { dir, ledger } = await makeWorkspace();
    expect(body(await tool().handler({ message: 'Which?', options: ['A', 'B'] }, ctxFor(dir))).status).toBe('requested');
    expect(body(await tool().handler({ message: 'Which?', options: ['A', 'B'] }, ctxFor(dir))).status).toBe('already_requested');
    expect(body(await tool().handler({ message: 'Which?', options: ['A', 'C'] }, ctxFor(dir))).status).toBe('requested');
    expect(await ledgerEntries(ledger)).toHaveLength(2);
  });
});
