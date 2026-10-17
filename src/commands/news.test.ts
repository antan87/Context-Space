import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';

import { newsCommand, newsReader, renderNews } from './news.js';
import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { setActiveStorageProvider } from '../core/adapters/registry.js';
import type { WhatsNew } from '../core/whats-new.js';
import * as resolve from '../utils/resolve-workspace.js';

vi.mock('../utils/resolve-workspace.js');

const NOW = new Date('2026-06-17T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const report = (changes: Partial<WhatsNew> = {}): WhatsNew => ({
  reader: 'user', at: NOW.toISOString(), from: ago(120), basis: 'last-look', problems: [], empty: false,
  plan: { items: [], more: 0 }, documents: { items: [], more: 0 }, knowledge: { items: [], more: 0 }, commits: [],
  ...changes,
});

describe('newsReader', () => {
  const person = { PATH: '/bin' };

  it('reads as the name given, in lower case', () => {
    expect(newsReader({ as: 'Codex' }, person, true)).toBe('codex');
    expect(newsReader({ as: 'gemini' }, { CLAUDECODE: '1' }, false)).toBe('gemini');
    expect(() => newsReader({ as: 'a/b' }, person, true)).toThrow('not a name to read as');
  });

  it('follows the rule the plan names its changes by when no name is given', () => {
    expect(newsReader({}, { CTXSPACE_HARNESS: 'codex' }, false)).toBe('codex');
    expect(newsReader({}, { CLAUDECODE: '1' }, true)).toBe('claude');
    expect(newsReader({}, person, true)).toBe('user');
    expect(newsReader({}, person, false)).toBe('ai');
  });

  it('lets only a person at their own terminal read as the user', () => {
    expect(newsReader({ as: 'user' }, person, true)).toBe('user');
    expect(newsReader({ as: 'user' }, { CLAUDECODE: '1' }, true)).toBe('claude');
    expect(newsReader({ as: 'user' }, person, false)).toBe('ai');
  });
});

describe('renderNews', () => {
  it('prints a heading, then short lines under each section that has something', () => {
    const text = renderNews(report({
      plan: { items: [
        { at: ago(40), by: 'claude', action: 'ticked', kind: 'step', key: 'a', text: 'Write the CSV writer' },
        { at: ago(30), by: 'user', action: 'answered', kind: 'decision', key: 'b', text: 'Export archived reports?', note: 'Yes, all of them' },
        { at: ago(20), by: 'file', action: 'unticked', kind: 'step', key: 'c', text: 'Add the Export button' },
      ], more: 0 },
      documents: { items: [{ name: 'docs/export-flow.png', kind: 'image', change: 'added', at: ago(60) }, { name: 'notes.md', kind: 'markdown', change: 'changed', at: ago(90) }], more: 0 },
      knowledge: { items: [{ id: '2026-06-16-plan-md-has-its-own-lock', title: 'Plan md has its own lock', date: '2026-06-16', type: 'gotcha' }], more: 0 },
      commits: [{ repo: 'api', commits: [{ sha: 'a1b2c3d', author: 'Anna', subject: 'Fix rounding in totals', at: ago(180) }], more: 0 }],
    }), NOW);

    expect(text).toBe([
      'Since you last looked, 2 h ago:',
      '',
      'Plan',
      '  Claude ticked step "Write the CSV writer" · 40 min ago',
      '  The user answered decision "Export archived reports?": Yes, all of them · 30 min ago',
      '  Someone reopened step "Add the Export button" · 20 min ago',
      '',
      'Documents',
      '  docs/export-flow.png added · 1 h ago',
      '  notes.md changed · 2 h ago',
      '',
      'Knowledge',
      '  gotcha "Plan md has its own lock" · 2026-06-16',
      '',
      'Commits',
      '  api: a1b2c3d Fix rounding in totals (Anna) · 3 h ago',
    ].join('\n'));
  });

  it('says how many more there are, and that a first look reaches back three days', () => {
    const text = renderNews(report({
      basis: 'first-look',
      plan: { items: [{ at: ago(5), by: 'codex', action: 'added', kind: 'checkpoint', key: 'a', text: 'Reports export to CSV' }], more: 4 },
      documents: { items: [{ name: 'a.md', kind: 'markdown', change: 'changed', at: ago(5) }], more: 2 },
      commits: [{ repo: 'api', commits: [{ sha: 'a1b2c3d', author: 'Anna', subject: 'One', at: ago(5) }], more: 90, moreAtLeast: true }],
    }), NOW);

    expect(text.split('\n')[0]).toBe('First look: the last 3 days:');
    expect(text).toContain('  … and 4 earlier, not shown\n  Codex added checkpoint "Reports export to CSV" · 5 min ago');
    expect(text).toContain('  a.md changed · 5 min ago\n  … and 2 more');
    expect(text).toContain('  … and 90+ more in api');
  });

  it('says "just now" for a look under a minute ago, in the heading and in the line that nothing changed', () => {
    const documents = { items: [{ name: 'a.md', kind: 'markdown' as const, change: 'changed' as const, at: ago(0.2) }], more: 0 };
    expect(renderNews(report({ from: ago(0.5), documents }), NOW)).toBe('Since you last looked just now:\n\nDocuments\n  a.md changed · just now');
    expect(renderNews(report({ from: ago(0.5), empty: true }), NOW)).toBe('Nothing changed since you last looked (just now).');
    expect(renderNews(report({ from: ago(0.5), basis: 'time', empty: true }), NOW)).toBe('Nothing changed since a moment ago.');
    expect(renderNews(report({ from: ago(1.5), empty: true }), NOW)).toBe('Nothing changed since you last looked (2 min ago).');
  });

  it('names a time that was asked for', () => {
    expect(renderNews(report({ basis: 'time', from: ago(60 * 24 * 2), documents: { items: [{ name: 'a.md', kind: 'markdown', change: 'changed', at: ago(5) }], more: 0 } }), NOW).split('\n')[0]).toBe('Since 2 days ago:');
  });

  it('says in one line when nothing changed, keeping the problems that stand in the way', () => {
    expect(renderNews(report({ empty: true }), NOW)).toBe('Nothing changed since you last looked (2 h ago).');
    expect(renderNews(report({ empty: true, basis: 'first-look' }), NOW)).toBe('Nothing changed in the last 3 days (first look).');
    expect(renderNews(report({
      empty: true, problems: ['The documents could not be read: denied'],
      commits: [{ repo: 'web', commits: [], more: 0, problem: 'This is not a git repository.' }],
    }), NOW)).toBe([
      'Nothing changed since you last looked (2 h ago).',
      'web: could not be read (This is not a git repository.)',
      'The documents could not be read: denied',
    ].join('\n'));
  });

  it('lists a repository that could not be read after the changes of the others', () => {
    const text = renderNews(report({
      commits: [{ repo: 'api', commits: [{ sha: 'a1b2c3d', author: 'Anna', subject: 'One', at: ago(5) }], more: 0 }, { repo: 'web', commits: [], more: 0, problem: 'The folder is missing.' }],
    }), NOW);
    expect(text.split('\n').slice(-3)).toEqual(['  api: a1b2c3d One (Anna) · 5 min ago', '', 'web: could not be read (The folder is missing.)']);
  });
});

describe('newsCommand', () => {
  let dir: string;
  let output: string[];

  beforeEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-news-')));
    const repo = path.join(dir, 'api');
    await fs.mkdir(repo);
    await execa('git', ['init', '-b', 'main'], { cwd: repo });
    await fs.writeFile(path.join(repo, 'a.txt'), 'a');
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['-c', 'user.name=Anna', '-c', 'user.email=a@example.com', 'commit', '-m', 'Fix rounding in totals'], { cwd: repo });
    await fs.writeFile(path.join(dir, 'contextspace.json'), JSON.stringify({ id: 'reports', name: 'Reports', branchName: 'reports', repos: [repo], assistants: [], workspacePath: dir }));
    vi.mocked(resolve.resolveWorkspaceQuiet).mockResolvedValue(dir);
    vi.stubEnv('CTXSPACE_HARNESS', 'claude');
    output = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { output.push(args.join(' ')); });
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('shows the first look, marks it seen, and then has nothing to say', async () => {
    await newsCommand({});
    expect(output[0]).toMatch(/^First look: the last 3 days:\n\nCommits\n {2}api: [0-9a-f]+ Fix rounding in totals \(Anna\) · /);
    expect(JSON.parse(await fs.readFile(path.join(dir, '.contextspace/seen.json'), 'utf8')).readers).toHaveProperty('claude');

    await newsCommand({});
    expect(output[1]).toBe('Nothing changed since you last looked (just now).');
  });

  it('looks without marking when asked to peek, so the same changes show again', async () => {
    await newsCommand({ peek: true });
    await newsCommand({ peek: true });
    expect(output).toHaveLength(2);
    expect(output[1]).toBe(output[0]);
    await expect(fs.access(path.join(dir, '.contextspace/seen.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a record for each name it reads as', async () => {
    await newsCommand({ as: 'codex' });
    await newsCommand({});
    const readers = JSON.parse(await fs.readFile(path.join(dir, '.contextspace/seen.json'), 'utf8')).readers;
    expect(Object.keys(readers).sort()).toEqual(['claude', 'codex']);
  });

  it('prints the report as JSON', async () => {
    await newsCommand({ json: true, peek: true, as: 'codex' });
    expect(JSON.parse(output[0]!)).toMatchObject({ reader: 'codex', basis: 'first-look', empty: false, commits: [{ repo: 'api', commits: [{ subject: 'Fix rounding in totals' }] }] });
  });

  it('reaches back to a time asked for', async () => {
    await newsCommand({ since: '2000-01-01T00:00:00Z', peek: true });
    expect(output[0]).toMatch(/^Since /);
    await expect(newsCommand({ since: 'whenever' })).rejects.toThrow('not a date and time');
  });

  it('refuses outside a workspace with a clear message, as JSON when asked', async () => {
    vi.mocked(resolve.resolveWorkspaceQuiet).mockResolvedValue(null);
    await expect(newsCommand({})).rejects.toThrow('No workspace here. Run this inside a workspace folder, or pass --workspace <path>.');
    expect(process.exitCode).toBeUndefined();

    await newsCommand({ json: true });
    expect(JSON.parse(output[0]!)).toEqual({ ok: false, error: 'No workspace here. Run this inside a workspace folder, or pass --workspace <path>.' });
    expect(process.exitCode).toBe(1);
  });

  it('passes the workspace option to the lookup and never prompts', async () => {
    await newsCommand({ workspace: 'reports', peek: true });
    expect(resolve.resolveWorkspaceQuiet).toHaveBeenCalledWith('reports');
  });
});
