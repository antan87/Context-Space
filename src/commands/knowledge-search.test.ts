import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { knowledgeSearchCommand, knowledgeShowCommand } from './knowledge.js';
import { addBaseKnowledge, addWorkspaceKnowledge } from '../core/knowledge.js';
import { getStorageProvider, setActiveStorageProvider } from '../core/adapters/registry.js';
import { PRIMARY_KNOWLEDGE_FILE, PRIMARY_MANIFEST_FILE } from '../core/constants.js';
import * as resolve from '../utils/resolve-workspace.js';

vi.mock('../utils/resolve-workspace.js');

const KNOWLEDGE = [
  '# Workspace Knowledge — search-test',
  '',
  '## Known Gotchas',
  '',
  '### 2026-10-16 — plan-md-has-its-own-lock',
  '**Gotcha:** Moving an old plan runs the old store, which takes its own lock, so PLAN.md locks a different file.',
  '**Scope:** `repo:api`',
  '',
  '### 2026-10-17 — archive-leaves-the-plan-open',
  '**Gotcha:** Archiving a workspace does not close its plan.',
  '',
  '## Architecture Decisions',
  '',
  '### 2026-10-17 — the-plan-is-plan-md',
  '**Decision:** Every AI edits PLAN.md directly; the plan has no lock of its own in the app.',
  '',
].join('\n');

describe('knowledge search', () => {
  let dir: string;
  let repo: string;
  let home: string;
  const originalHome = process.env.NEXUSFLOW_HOME;
  let out: string[];

  beforeEach(async () => {
    setActiveStorageProvider(getStorageProvider('local'));
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-ksearch-ws-'));
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-ksearch-home-'));
    process.env.NEXUSFLOW_HOME = home;
    repo = path.join(dir, 'api');
    await fs.mkdir(repo);
    await execa('git', ['init'], { cwd: repo });
    await fs.writeFile(path.join(dir, PRIMARY_MANIFEST_FILE), JSON.stringify({
      id: 'search-test', branchName: 'search-test', description: 'x', mode: 'in-place', repos: [repo], assistants: [], workspacePath: dir, createdAt: '2026-10-16T00:00:00.000Z',
    }));
    await fs.writeFile(path.join(dir, PRIMARY_KNOWLEDGE_FILE), KNOWLEDGE);
    vi.mocked(resolve.resolveWorkspaceQuiet).mockResolvedValue(dir);
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { out.push(args.join(' ')); });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    if (originalHome !== undefined) process.env.NEXUSFLOW_HOME = originalHome;
    else delete process.env.NEXUSFLOW_HOME;
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  it('prints each match in full: its title, type and date, then every line under the heading', async () => {
    await knowledgeSearchCommand(['archiving'], {});

    expect(out).toEqual([[
      'Archive leaves the plan open',
      'gotcha · 2026-10-17',
      '**Gotcha:** Archiving a workspace does not close its plan.',
    ].join('\n')]);
  });

  it('prints a title exactly as it was written when the entry was added: capitals, dot, apostrophe, hyphen', async () => {
    const title = "PLAN.md has its own lock, apart from the AI's re-fetch";
    await addWorkspaceKnowledge(dir, { type: 'gotcha', title, message: 'Mind the re-fetch.', timestamp: '2026-10-18T00:00:00.000Z' });

    expect(await fs.readFile(path.join(dir, PRIMARY_KNOWLEDGE_FILE), 'utf8')).toContain(`### 2026-10-18 — ${title}\n`);
    await knowledgeSearchCommand(['re-fetch'], {});

    expect(out[0]!.split('\n').slice(0, 3)).toEqual([title, 'gotcha · 2026-10-18', '**Gotcha:** Mind the re-fetch.']);
  });

  it('prints a title an older version stored as a slug in words', async () => {
    await knowledgeSearchCommand(['archiving'], { json: true });

    expect(JSON.parse(out[0]!)[0].title).toBe('Archive leaves the plan open');
  });

  it('keeps the scope and evidence lines of an entry, which are part of what it says', async () => {
    await knowledgeSearchCommand(['old', 'store'], {});

    expect(out[0]).toContain('**Scope:** `repo:api`');
    expect(out[0]).toContain('Moving an old plan runs the old store');
  });

  it('puts the entry that matches more of the words first, with a blank line between entries', async () => {
    await knowledgeSearchCommand(['plan', 'lock'], {});

    const titles = out[0]!.split('\n\n').map((block) => block.split('\n')[0]);
    expect(titles).toEqual(['Plan md has its own lock', 'The plan is plan md', 'Archive leaves the plan open']);
  });

  it('filters by type and scope, and stops at the limit', async () => {
    await knowledgeSearchCommand(['plan'], { type: 'decision' });
    expect(out[0]).toContain('The plan is plan md');
    expect(out[0]).not.toContain('Archive leaves');

    out.length = 0;
    await knowledgeSearchCommand(['plan'], { scope: 'repo:api' });
    expect(out[0]!.split('\n\n')).toHaveLength(1);

    out.length = 0;
    await knowledgeSearchCommand(['plan'], { limit: '2' });
    expect(out[0]!.split('\n\n')).toHaveLength(2);
  });

  it('says in one line that nothing matches, and suggests fewer words', async () => {
    await knowledgeSearchCommand(['kubernetes', 'ingress'], {});

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Nothing in the knowledge matches "kubernetes ingress".');
    expect(out[0]).toContain('Try fewer or different words.');
    expect(out[0]).not.toContain('\n');
  });

  it('prints JSON with the same facts, an empty list when nothing matches', async () => {
    await knowledgeSearchCommand(['archiving'], { json: true });
    expect(JSON.parse(out[0]!)).toEqual([{
      title: 'Archive leaves the plan open',
      type: 'gotcha',
      date: '2026-10-17',
      source: 'workspace',
      section: 'Known Gotchas',
      body: '**Gotcha:** Archiving a workspace does not close its plan.',
      score: 1,
    }]);

    out.length = 0;
    await knowledgeSearchCommand(['kubernetes'], { json: true });
    expect(JSON.parse(out[0]!)).toEqual([]);
  });

  it('finds an entry in a repo\'s base knowledge and names where it came from', async () => {
    await addBaseKnowledge(dir, 'api', { type: 'gotcha', title: 'Port clash', message: 'Port 8080 clashes with the backend.' });

    await knowledgeSearchCommand(['8080'], { repo: 'api' });

    expect(out[0]).toContain('Port clash');
    expect(out[0]).toMatch(/gotcha · \d{4}-\d{2}-\d{2} · api base knowledge/);
    expect(out[0]).toContain('Port 8080 clashes with the backend.');
  });

  describe('refuses what it cannot search by throwing, so the command exits with an error, and searches nothing', () => {
    it('a type that does not exist', async () => {
      await expect(knowledgeSearchCommand(['plan'], { type: 'rumor' })).rejects.toThrow('Invalid --type "rumor". Use one of: decision, gotcha, assumption, question');

      expect(out).toEqual([]);
    });

    it.each(['0', '21', 'five', '2.5', '-1'])('a limit of %s', async (limit) => {
      await expect(knowledgeSearchCommand(['plan'], { limit })).rejects.toThrow(`Invalid --limit "${limit}". Use a whole number from 1 to 20.`);

      expect(out).toEqual([]);
    });

    it('a repo that is not in the workspace, naming those that are', async () => {
      await expect(knowledgeSearchCommand(['plan'], { repo: 'web' })).rejects.toThrow('Repository "web" is not in this workspace. Available: api.');

      expect(out).toEqual([]);
    });

    it('no workspace, saying how to name one', async () => {
      vi.mocked(resolve.resolveWorkspaceQuiet).mockResolvedValue(null);

      await expect(knowledgeSearchCommand(['plan'], {})).rejects.toThrow('No workspace here. Run this inside a workspace folder, or pass --workspace <path>.');

      expect(out).toEqual([]);
    });
  });

  it('never asks which workspace to use: an AI runs it, and a prompt would hang it', async () => {
    vi.mocked(resolve.resolveWorkspaceQuiet).mockResolvedValue(null);

    await expect(knowledgeSearchCommand(['plan'], {})).rejects.toThrow();
    await knowledgeSearchCommand(['plan'], { workspace: 'search-test' }).catch(() => {});

    expect(resolve.resolveWorkspaceInteractive).not.toHaveBeenCalled();
  });

  it('knowledge show --scope finds the entry a contract names, whether its title is words or an older slug', async () => {
    vi.mocked(resolve.resolveWorkspaceInteractive).mockResolvedValue(dir);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, PRIMARY_MANIFEST_FILE), 'utf8'));
    await fs.writeFile(path.join(dir, PRIMARY_MANIFEST_FILE), JSON.stringify({
      ...manifest,
      contracts: [
        { from: 'api', to: 'api/web', kind: 'plan-seam', entry: '2026-10-16-plan-md-has-its-own-lock' },
        { from: 'api', to: 'api/web', kind: 'plan-seam', entry: '2026-10-18-the-plan-is-plan-md' },
      ],
    }));
    await addWorkspaceKnowledge(dir, { type: 'decision', title: 'The plan is PLAN.md', message: 'Edited directly.', timestamp: '2026-10-18T00:00:00.000Z' });

    await knowledgeShowCommand(undefined, { scope: 'seam:plan-seam' });

    expect(out[0]).toContain('### 2026-10-16 — plan-md-has-its-own-lock');
    expect(out[0]).toContain('### 2026-10-18 — The plan is PLAN.md');
    expect(out[0]).not.toContain('archive-leaves-the-plan-open');
  });

  it('searches the workspace named with --workspace', async () => {
    await knowledgeSearchCommand(['plan'], { workspace: 'search-test' });

    expect(resolve.resolveWorkspaceQuiet).toHaveBeenCalledWith('search-test');
    expect(out).not.toEqual([]);
  });
});
