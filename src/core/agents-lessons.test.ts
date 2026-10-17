import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';

import { refreshAgentsLessons } from './agents-lessons.js';
import { checkGenerationLock } from './generation-lock.js';
import { addBaseKnowledge, addWorkspaceKnowledge, readKnowledgeLessons } from './knowledge.js';
import { acquireLock } from './locks.js';
import { getStorageProvider, setActiveStorageProvider } from './adapters/registry.js';
import { PRIMARY_MANIFEST_FILE } from './constants.js';
import { generateContextFiles } from '../generators/index.js';
import type { WorkspaceContext } from '../types.js';

describe('lessons in AGENTS.md', () => {
  let workspacePath: string;
  let repoPath: string;
  let home: string;
  const originalHome = process.env.NEXUSFLOW_HOME;

  const read = (name: string) => fs.readFile(path.join(workspacePath, name), 'utf-8');
  const add = (title: string, type: 'gotcha' | 'decision' = 'gotcha', date = '2026-10-16') =>
    addWorkspaceKnowledge(workspacePath, { type, title, message: `${title}: the rule and why.`, timestamp: `${date}T00:00:00.000Z` });

  async function generate(): Promise<void> {
    const ctx: WorkspaceContext = {
      feature: {
        id: 'lessons-test', branchName: 'lessons-test', description: 'keep lessons current', mode: 'worktree',
        repos: [repoPath], assistants: ['claude', 'copilot', 'cursor'], workspacePath, createdAt: '2026-10-16T00:00:00.000Z',
      },
      repos: [{ name: 'repo', path: repoPath, defaultBranch: 'main' }],
    };
    await fs.writeFile(path.join(workspacePath, PRIMARY_MANIFEST_FILE), JSON.stringify(ctx.feature));
    await generateContextFiles(ctx, ['claude', 'copilot', 'cursor'], workspacePath);
  }
  const addToRepo = (title: string, type: 'gotcha' | 'decision' = 'gotcha', date = '2026-09-01') =>
    addBaseKnowledge(workspacePath, 'repo', { type, title, message: `${title}: the rule and why.`, timestamp: `${date}T00:00:00.000Z` });

  beforeEach(async () => {
    setActiveStorageProvider(getStorageProvider('local'));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-lessons-ws-'));
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-lessons-home-'));
    process.env.NEXUSFLOW_HOME = home;
    repoPath = path.join(workspacePath, 'repo');
    await fs.mkdir(repoPath);
    await execa('git', ['init'], { cwd: repoPath });
    await execa('git', ['config', 'user.name', 'ContextSpace Test'], { cwd: repoPath });
    await execa('git', ['config', 'user.email', 'contextspace-test@local'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'README.md'), '# repo\n');
    await execa('git', ['add', 'README.md'], { cwd: repoPath });
    await execa('git', ['commit', '-m', 'fixture'], { cwd: repoPath });
  });

  afterEach(async () => {
    if (originalHome !== undefined) process.env.NEXUSFLOW_HOME = originalHome;
    else delete process.env.NEXUSFLOW_HOME;
    // A background `git gc --auto` from the workspace auto-commit can still be writing packs; rm's retries ride it out.
    await fs.rm(workspacePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('are listed by a refresh from the knowledge file, however the entry got there', async () => {
    await generate();
    expect(await read('AGENTS.md')).not.toContain('Lessons');
    await fs.appendFile(path.join(workspacePath, 'contextspace-knowledge.md'), '\n## Known Gotchas\n\n### 2026-10-16 — plan-md-has-its-own-lock\n**Gotcha:** written by hand.\n');

    await generate();

    expect(await read('AGENTS.md')).toContain('- gotcha: Plan md has its own lock\n');
  });

  it('list a title as it was written, and an older slug heading as words', async () => {
    await generate();
    await fs.appendFile(path.join(workspacePath, 'contextspace-knowledge.md'), '\n## Known Gotchas\n\n### 2026-10-15 — plan-slowness-is-the-ai-s-loop\n**Gotcha:** stored by an older version.\n');

    await add("PLAN.md has its own lock, apart from the AI's re-fetch", 'gotcha', '2026-10-17');
    await addToRepo('EBUSY on Windows: fs.rm needs retries');

    const lines = (await read('AGENTS.md')).split('\n').filter((line) => /^- (gotcha|decision)/.test(line));
    expect(lines).toEqual([
      "- gotcha: PLAN.md has its own lock, apart from the AI's re-fetch",
      '- gotcha: Plan slowness is the ai s loop',
      '- gotcha (repo): EBUSY on Windows: fs.rm needs retries',
    ]);
    await expect(checkGenerationLock(workspacePath)).resolves.toMatchObject({ fresh: true, drift: [] });
  });

  it('follow a new entry at once, in AGENTS.md and the views copied from it, without reading as drift', async () => {
    await generate();

    await add('plan-md-has-its-own-lock');
    await add('the-plan-is-plan-md', 'decision', '2026-10-17');

    for (const view of ['AGENTS.md', '.github/copilot-instructions.md', '.cursor/rules/contextspace.mdc']) {
      const text = await read(view);
      expect(text, view).toContain('- decision: The plan is plan md\n- gotcha: Plan md has its own lock\n');
      expect(text.indexOf('## Lessons from earlier sessions'), view).toBeLessThan(text.indexOf('## Where to look'));
    }
    expect(await read('CLAUDE.md')).not.toContain('Lessons');
    await expect(checkGenerationLock(workspacePath)).resolves.toMatchObject({ fresh: true, drift: [] });
  });

  it('are the same text a refresh writes, so the next refresh changes nothing', async () => {
    await generate();
    await add('plan-md-has-its-own-lock');
    await add('the-plan-is-plan-md', 'decision', '2026-10-17');
    const inPlace = await read('AGENTS.md');
    const lock = await read('contextspace.lock');

    await generate();

    expect(await read('AGENTS.md')).toBe(inPlace);
    expect(JSON.parse(await read('contextspace.lock')).outputs).toEqual(JSON.parse(lock).outputs);
  });

  it('do not make a stale context look fresh', async () => {
    await generate();
    await fs.writeFile(path.join(repoPath, 'README.md'), '# changed\n');

    await add('plan-md-has-its-own-lock');

    const check = await checkGenerationLock(workspacePath);
    expect(check.drift.map((item) => item.kind)).toEqual(['repo']);
  });

  it('leave an AGENTS.md someone edited by hand alone', async () => {
    await generate();
    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), '# My own AGENTS.md\n\n## Where to look\n\nhere\n');

    await add('plan-md-has-its-own-lock');

    expect(await read('AGENTS.md')).toBe('# My own AGENTS.md\n\n## Where to look\n\nhere\n');
    const check = await checkGenerationLock(workspacePath);
    expect(check.drift).toEqual([expect.objectContaining({ kind: 'output', name: 'AGENTS.md' })]);
  });

  it('change nothing in a workspace whose files were never generated', async () => {
    await fs.writeFile(path.join(workspacePath, PRIMARY_MANIFEST_FILE), JSON.stringify({ id: 'lessons-test', branchName: 'lessons-test', repos: [repoPath], assistants: [], workspacePath, createdAt: '2026-10-16T00:00:00.000Z' }));
    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), '# Mine\n\n## Where to look\n');

    await add('plan-md-has-its-own-lock');

    expect(await read('AGENTS.md')).toBe('# Mine\n\n## Where to look\n');
    await expect(fs.access(path.join(workspacePath, '.contextspace', 'generation.lock'))).rejects.toThrow();
  });

  it('wait for a refresh in progress and then list the entry', async () => {
    await generate();
    const release = await acquireLock(path.join(workspacePath, '.contextspace', 'generation.lock'), { staleMs: 60_000, timeoutMs: 1000, timeoutMessage: 'held' });

    const adding = add('plan-md-has-its-own-lock');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await read('AGENTS.md')).not.toContain('Lessons');
    await release();
    await adding;

    expect(await read('AGENTS.md')).toContain('- gotcha: Plan md has its own lock\n');
  });

  it('read the knowledge only once they hold the files, so two entries at once leave the full list', async () => {
    await generate();

    await Promise.all([add('first-entry'), add('second-entry', 'decision', '2026-10-17'), add('third-entry', 'gotcha', '2026-10-18')]);

    const listed = (await read('AGENTS.md')).split('\n').filter((line) => /^- (gotcha|decision): /.test(line));
    expect(listed).toEqual(['- gotcha: Third entry', '- decision: Second entry', '- gotcha: First entry']);
    expect((await readKnowledgeLessons(workspacePath)).map((lesson) => lesson.title)).toEqual(['Third entry', 'Second entry', 'First entry']);
  });

  describe('from the base knowledge of a repo in the workspace', () => {
    it('reach a new workspace on that repo when it is generated, labelled with the repo', async () => {
      // An earlier workspace promoted these into the repo's base knowledge; this one has none of its own yet.
      await fs.writeFile(path.join(workspacePath, PRIMARY_MANIFEST_FILE), JSON.stringify({ id: 'lessons-test', branchName: 'lessons-test', repos: [repoPath], assistants: [], workspacePath, createdAt: '2026-10-16T00:00:00.000Z' }));
      await addToRepo('port-clash');
      await addToRepo('keep-the-lock', 'decision', '2026-09-02');

      await generate();

      expect(await read('AGENTS.md')).toContain('- decision (repo): Keep the lock\n- gotcha (repo): Port clash\n');
      await expect(checkGenerationLock(workspacePath)).resolves.toMatchObject({ fresh: true, drift: [] });
    });

    it('follow a new entry in the repo\'s base knowledge at once, after the workspace\'s own', async () => {
      await generate();
      await add('plan-md-has-its-own-lock');

      await addToRepo('port-clash');

      const lines = (await read('AGENTS.md')).split('\n').filter((line) => /^- (gotcha|decision)/.test(line));
      expect(lines).toEqual(['- gotcha: Plan md has its own lock', '- gotcha (repo): Port clash']);
      await expect(checkGenerationLock(workspacePath)).resolves.toMatchObject({ fresh: true, drift: [] });
    });

    it('are the same text a refresh writes, so the next refresh changes nothing', async () => {
      await generate();
      await add('plan-md-has-its-own-lock');
      await addToRepo('port-clash');
      const inPlace = await read('AGENTS.md');

      await generate();

      expect(await read('AGENTS.md')).toBe(inPlace);
    });
  });

  it('refreshAgentsLessons says which views it changed', async () => {
    await generate();

    expect(await refreshAgentsLessons(workspacePath, async () => [{ title: 'One', type: 'gotcha' }]))
      .toEqual(expect.arrayContaining(['AGENTS.md', '.github/copilot-instructions.md']));
    expect(await refreshAgentsLessons(workspacePath, async () => [{ title: 'One', type: 'gotcha' }])).toEqual([]);
  });
});
