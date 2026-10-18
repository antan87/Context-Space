import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AskUserError, askUser } from './ask-user.js';
import * as workspace from './workspace.js';
import { INPUT_REQUEST_DISPLAY_LIMIT } from './attention.js';

describe('askUser', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-ask-user-'));
    await fs.mkdir(path.join(dir, '.contextspace'), { recursive: true });
    vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue({
      id: 'ws-one', branchName: 'ws-one', description: 'x', mode: 'worktree', repos: [], assistants: [], workspacePath: dir, createdAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const ledgerLines = async () => (await fs.readFile(path.join(dir, '.contextspace', 'chat.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean);

  it('records the request and says what the AI should read: wait for the answer', async () => {
    const result = await askUser(dir, { message: ' Ship it? ', options: ['Yes', 'No'], harness: 'codex' });

    expect(result).toMatchObject({ status: 'requested', workspaceId: 'ws-one', harness: 'codex', planQuestion: 'Ship it?' });
    expect(result.message).toContain('end your turn');
    // The CLI prints this too, so it names no tool.
    expect(result.message).toContain('Do not continue the task or ask again for the same question.');
    expect(await ledgerLines()).toHaveLength(1);
  });

  it('answers a repeat with the original time and writes nothing more', async () => {
    const first = await askUser(dir, { message: 'Ship it?' });
    const second = await askUser(dir, { message: 'Ship it?' });

    expect(second).toMatchObject({ status: 'already_requested', timestamp: first.timestamp });
    expect(second).not.toHaveProperty('planQuestion');
    expect(await ledgerLines()).toHaveLength(1);
  });

  describe('tells a request that is wrong how to put it right, as an AskUserError, and writes nothing', () => {
    it.each([
      ['an empty question', { message: '  ' }, 'cannot be empty'],
      ['a question that is not text', { message: 42 }, 'cannot be empty'],
      ['a question over the limit', { message: 'x'.repeat(INPUT_REQUEST_DISPLAY_LIMIT + 1) }, `keep it to ${INPUT_REQUEST_DISPLAY_LIMIT} or fewer`],
      ['options that are not a list', { message: 'Ship it?', options: 'Yes' }, 'options must be a list'],
    ])('%s', async (_label, input, words) => {
      const error = await askUser(dir, input).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AskUserError);
      expect((error as Error).message).toContain(words);
      expect(await ledgerLines()).toEqual([]);
    });

    it('a folder that is not a workspace', async () => {
      vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue(null);

      await expect(askUser(dir, { message: 'Ship it?' })).rejects.toBeInstanceOf(AskUserError);
      expect(await ledgerLines()).toEqual([]);
    });
  });
});
