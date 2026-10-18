import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import { readPlanFile } from './plan-file-store.js';
import { NEWS_LIMIT, NewsChangedError, markSeen, newsReaderName, whatsNew } from './whats-new.js';

// Well in the past, so a time marked "now" is never in the future of the machine running the tests.
const NOW = new Date('2026-06-17T12:00:00.000Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const day = (daysAgo: number) => ago(24 * daysAgo).toISOString().slice(0, 10);

let root: string;
let api: string;
let counter = 0;

const write = async (file: string, content = 'text', modified?: Date) => {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  if (modified) await fs.utimes(target, modified, modified);
};

/** A commit in the api repository, made by `author` at `when`. */
const commit = async (subject: string, when: Date, author = 'Anna') => {
  await fs.writeFile(path.join(api, `file-${++counter}.txt`), subject);
  const date = when.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const env = { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: 'a@example.com', GIT_COMMITTER_DATE: date };
  await execa('git', ['add', '.'], { cwd: api, env });
  await execa('git', ['commit', '-m', subject], { cwd: api, env });
  return (await execa('git', ['rev-parse', 'HEAD'], { cwd: api })).stdout;
};

const planChange = (by: string, text: string, when: Date, action = 'ticked', kind = 'step') =>
  JSON.stringify({ at: when.toISOString(), by, action, kind, key: text.toLowerCase().replace(/\W+/g, '-'), text });
const writePlanLog = (...lines: string[]) => write('.contextspace/plan-changes.jsonl', `${lines.join('\n')}\n`);

const knowledge = (...entries: Array<[string, string]>) =>
  write('contextspace-knowledge.md', `# Knowledge\n\n## Decisions\n\n${entries.map(([date, title]) => `### ${date} — ${title}\n**Decision:** Because.\n`).join('\n')}`);

const seenFile = () => path.join(root, '.contextspace/seen.json');
const readSeen = async () => JSON.parse(await fs.readFile(seenFile(), 'utf8'));

beforeEach(async () => {
  setActiveStorageProvider(new LocalStorageAdapter());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'whats-new-')));
  api = path.join(root, 'api');
  await fs.mkdir(api);
  await execa('git', ['init', '-b', 'main'], { cwd: api });
  await write('contextspace.json', JSON.stringify({ id: 'reports', name: 'Reports', branchName: 'reports', repos: [api], assistants: [], workspacePath: root }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('a first look', () => {
  it('reaches back three days in every section, and says it is a first look', async () => {
    await write('docs/export-flow.png', 'png', ago(1));
    await write('docs/old-notes.md', 'old', ago(24 * 5));
    await commit('Start the exporter', ago(24 * 4));
    await commit('Fix rounding in totals', ago(2));
    await knowledge([day(1), 'Plan md has its own lock'], [day(7), 'An older gotcha']);
    await writePlanLog(planChange('claude', 'Write the CSV writer', ago(24 * 4)), planChange('claude', 'Add the Export button', ago(1)));

    const news = await whatsNew(root, 'user', { now: NOW });

    expect(news).toMatchObject({ reader: 'user', basis: 'first-look', from: ago(72).toISOString(), empty: false });
    expect(news.documents.items.map((document) => [document.name, document.change])).toEqual([['docs/export-flow.png', 'changed']]);
    expect(news.commits).toEqual([{ repo: 'api', commits: [{ sha: expect.stringMatching(/^[0-9a-f]{7,}$/), subject: 'Fix rounding in totals', author: 'Anna', at: ago(2).toISOString() }], more: 0 }]);
    expect(news.knowledge.items.map((entry) => entry.title)).toEqual(['Plan md has its own lock']);
    expect(news.plan.items.map((change) => `${change.by} ${change.action} ${change.text}`)).toEqual(['claude ticked Add the Export button']);
  });

  it('says nothing changed for a workspace with nothing in the window', async () => {
    const news = await whatsNew(root, 'user', { now: NOW });
    expect(news).toMatchObject({ basis: 'first-look', empty: true, problems: [] });
    expect(news.commits).toEqual([{ repo: 'api', commits: [], more: 0 }]);
  });
});

describe('since the reader last looked', () => {
  it('shows only what is new in each section, and keeps the other readers apart', async () => {
    await write('docs/notes.md', 'one', ago(7));
    const first = await commit('Start the exporter', ago(7));
    await knowledge([day(0), 'First lesson']);
    await whatsNew(root, 'claude', { now: ago(5), mark: true });
    expect((await readSeen()).readers.claude).toMatchObject({ at: ago(5).toISOString(), repos: { api: first }, knowledge: [`${day(0)}-first-lesson`], documents: ['docs/notes.md'] });

    await write('docs/export-flow.png', 'png', ago(1));
    await write('docs/notes.md', 'two', ago(2));
    await commit('Fix rounding in totals', ago(3), 'Anna');
    await commit('Add the CSV writer', ago(1), 'Ben');
    await knowledge([day(0), 'First lesson'], [day(0), 'Second lesson']);
    await writePlanLog(planChange('codex', 'Write the CSV writer', ago(2)), planChange('claude', 'Add the Export button', ago(1)), planChange('user', 'Export archived reports?', ago(7), 'answered', 'decision'));

    const news = await whatsNew(root, 'claude', { now: NOW });

    expect(news).toMatchObject({ basis: 'last-look', from: ago(5).toISOString() });
    expect(news.documents.items.map((document) => `${document.name} ${document.change}`)).toEqual(['docs/export-flow.png added', 'docs/notes.md changed']);
    expect(news.commits[0]!.commits.map((entry) => `${entry.subject} (${entry.author})`)).toEqual(['Add the CSV writer (Ben)', 'Fix rounding in totals (Anna)']);
    expect(news.knowledge.items.map((entry) => entry.title)).toEqual(['Second lesson']);
    // The reader's own plan change is left out, and so is one from before they looked.
    expect(news.plan.items.map((change) => `${change.by} ${change.text}`)).toEqual(['codex Write the CSV writer']);

    // Another reader has not looked yet: they see all of it in their first window.
    const other = await whatsNew(root, 'codex', { now: NOW });
    expect(other.basis).toBe('first-look');
    expect(other.commits[0]!.commits).toHaveLength(3);
    expect(other.knowledge.items).toHaveLength(2);
  });

  it('shows the same changes again until the reader marks them seen, and not after', async () => {
    await commit('Start the exporter', ago(9));
    await whatsNew(root, 'claude', { now: ago(8), mark: true });
    await commit('Fix rounding in totals', ago(1));

    const peeked = await whatsNew(root, 'claude', { now: NOW });
    expect((await whatsNew(root, 'claude', { now: NOW })).commits).toEqual(peeked.commits);
    expect(peeked.commits[0]!.commits).toHaveLength(1);
    expect((await readSeen()).readers.claude.at).toBe(ago(8).toISOString());

    await whatsNew(root, 'claude', { now: NOW, mark: true });
    const after = await whatsNew(root, 'claude', { now: new Date(NOW.getTime() + 60_000) });
    expect(after).toMatchObject({ empty: true, basis: 'last-look', from: NOW.toISOString() });
  });

  it('finds a commit made after the last look by its place in the history, even when its date is older', async () => {
    await commit('Start the exporter', ago(9));
    await whatsNew(root, 'claude', { now: NOW, mark: true });
    await commit('Made after, dated before', ago(20));
    const next = await whatsNew(root, 'claude', { now: new Date(NOW.getTime() + 60_000) });
    expect(next.commits[0]!.commits.map((entry) => entry.subject)).toEqual(['Made after, dated before']);
  });

  it('does not mark a first look just because the list was read for a screen', async () => {
    await commit('Start the exporter', ago(9));
    const held = await whatsNew(root, 'user', { now: ago(1), pending: true });
    const seen = await readSeen();
    expect(seen.readers).toEqual({});
    expect(seen.pending.user).toMatchObject({ at: ago(1).toISOString(), repos: { api: expect.any(String) } });
    expect((await whatsNew(root, 'user', { now: NOW })).basis).toBe('first-look');
    expect(held.basis).toBe('first-look');
  });

  it('marks exactly the list the screen showed: what landed after it is shown next time', async () => {
    const first = await commit('Start the exporter', ago(9));
    await knowledge([day(0), 'First lesson']);
    const shown = await whatsNew(root, 'user', { now: ago(1), pending: true });
    expect(shown.commits[0]!.commits).toHaveLength(1);

    // Between reading the list and saying it was seen:
    await commit('Landed after the list was read', ago(0.5));
    await knowledge([day(0), 'First lesson'], [day(0), 'Second lesson']);
    await markSeen(root, 'user', shown.at);

    const seen = await readSeen();
    expect(seen.readers.user).toMatchObject({ at: shown.at, repos: { api: first }, knowledge: [`${day(0)}-first-lesson`] });
    expect(seen.pending).toEqual({});
    const next = await whatsNew(root, 'user', { now: NOW });
    expect(next).toMatchObject({ basis: 'last-look', from: shown.at });
    expect(next.commits[0]!.commits.map((entry) => entry.subject)).toEqual(['Landed after the list was read']);
    expect(next.knowledge.items.map((entry) => entry.title)).toEqual(['Second lesson']);
  });

  it('refuses to mark a list that is not the one last shown, and marks nothing', async () => {
    await commit('Start the exporter', ago(9));
    await expect(markSeen(root, 'user', ago(1))).rejects.toThrow(new NewsChangedError().message);

    const older = await whatsNew(root, 'user', { now: ago(2), pending: true });
    const newer = await whatsNew(root, 'user', { now: ago(1), pending: true });
    await expect(markSeen(root, 'user', older.at)).rejects.toBeInstanceOf(NewsChangedError);
    await expect(markSeen(root, 'codex', newer.at)).rejects.toBeInstanceOf(NewsChangedError);
    expect((await readSeen()).readers).toEqual({});

    // A look another way (the CLI) in between makes the screen's list out of date too.
    await whatsNew(root, 'user', { now: ago(0.5), mark: true });
    await expect(markSeen(root, 'user', newer.at)).rejects.toBeInstanceOf(NewsChangedError);
    expect((await readSeen()).readers.user.at).toBe(ago(0.5).toISOString());
  });

  it('marks a list once: asking again for the same one is refused', async () => {
    const shown = await whatsNew(root, 'user', { now: ago(1), pending: true });
    await markSeen(root, 'user', shown.at);
    await expect(markSeen(root, 'user', shown.at)).rejects.toBeInstanceOf(NewsChangedError);
  });

  it('refuses a time that is not one, as an error of its own', async () => {
    const error = await markSeen(root, 'user', 'yesterday-ish').catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NewsChangedError);
    expect(error.message).toContain('not a date');
  });

  it('uses a time asked for instead of the record, listing every document as changed', async () => {
    await write('docs/notes.md', 'one', ago(10));
    await whatsNew(root, 'claude', { now: ago(1), mark: true });
    const news = await whatsNew(root, 'claude', { now: NOW, since: ago(12).toISOString() });
    expect(news.basis).toBe('time');
    expect(news.documents.items.map((document) => [document.name, document.change])).toEqual([['docs/notes.md', 'changed']]);
    await expect(whatsNew(root, 'claude', { since: 'last tuesday-ish' })).rejects.toThrow('not a date and time');
  });
});

describe('the plan section', () => {
  it('notices a direct edit of PLAN.md, whoever made it', async () => {
    await write('PLAN.md', '# Reports\n\n## Checkpoints\n\n- [ ] Reports export to CSV\n  - [ ] Write the CSV writer\n');
    await readPlanFile(root);
    await write('PLAN.md', '# Reports\n\n## Checkpoints\n\n- [ ] Reports export to CSV\n  - [x] Write the CSV writer\n');

    const news = await whatsNew(root, 'claude', { since: new Date(Date.now() - 60_000).toISOString() });

    expect(news.plan.items.map((change) => `${change.by} ${change.action} ${change.text}`)).toEqual(['file ticked Write the CSV writer']);
  });

  it('shows a direct edit once: in the report that noticed it, and not again after that report is marked', async () => {
    await write('PLAN.md', '# Reports\n\n## Checkpoints\n\n- [ ] Reports export to CSV\n  - [ ] Write the CSV writer\n');
    await readPlanFile(root);
    await write('PLAN.md', '# Reports\n\n## Checkpoints\n\n- [ ] Reports export to CSV\n  - [x] Write the CSV writer\n');

    const first = await whatsNew(root, 'claude', { since: new Date(Date.now() - 60_000).toISOString(), mark: true });
    const second = await whatsNew(root, 'claude');

    expect(first.plan.items).toHaveLength(1);
    expect(second.plan.items).toEqual([]);
  });

  it('leaves a change made after the time of the report for the next one', async () => {
    await writePlanLog(planChange('codex', 'Write the CSV writer', ago(1)), planChange('codex', 'Add the Export button', new Date(NOW.getTime() + 60_000)));
    expect((await whatsNew(root, 'claude', { now: NOW })).plan.items.map((change) => change.text)).toEqual(['Write the CSV writer']);
  });

  it('keeps the changes of readers that do not say who they are, and leaves out only a named reader\'s own', async () => {
    await writePlanLog(planChange('ai', 'Write the CSV writer', ago(2)), planChange('contextspace', 'Reports export to CSV', ago(1), 'ticked', 'checkpoint'));
    expect((await whatsNew(root, 'ai', { now: NOW })).plan.items).toHaveLength(2);
    expect((await whatsNew(root, 'contextspace', { now: NOW })).plan.items).toHaveLength(1);
  });
});

describe('what is left out', () => {
  it('lists documents and images the AIs leave, not the generated or ContextSpace files or a repository\'s own files', async () => {
    for (const file of ['AGENTS.md', 'CLAUDE.md', 'WORKSPACE.md', 'PLAN.md', 'contextspace-knowledge.md', 'contextspace-plan.md', 'contextspace-handoff.md', '.claude/skills/review/SKILL.md', '.agents/skills/review/SKILL.md', '.github/copilot-instructions.md', 'api/README.md', 'api/docs/design.md', 'contextspace-work.json', '.contextspace/notes.md']) {
      await write(file, 'generated', ago(1));
    }
    for (const file of ['notes.md', 'docs/spec.md', 'AGENTS.md.bak.txt', '.claude/notes/plan.md', 'sub/AGENTS.md']) await write(file, 'kept', ago(1));

    const names = (await whatsNew(root, 'user', { now: NOW })).documents.items.map((document) => document.name).sort();

    expect(names).toEqual(['.claude/notes/plan.md', 'AGENTS.md.bak.txt', 'docs/spec.md', 'notes.md', 'sub/AGENTS.md']);
  });

  it('does not walk a repository: its folder is left out of the document listing', async () => {
    await write('api/node_modules/pkg/README.md', 'x', ago(1));
    await write('api/docs/design.md', 'x', ago(1));
    await write('notes.md', 'x', ago(1));
    const news = await whatsNew(root, 'user', { now: NOW });
    expect(news.documents.items.map((document) => document.name)).toEqual(['notes.md']);
  });
});

describe('caps', () => {
  it('lists the newest ten of each section and counts the rest', async () => {
    for (let index = 0; index < 13; index++) {
      await write(`docs/doc-${index}.md`, 'x', ago(1 + index / 100));
      await commit(`Commit ${index}`, ago(1 + index / 100));
    }
    await writePlanLog(...Array.from({ length: 12 }, (_, index) => planChange('codex', `Step ${index}`, ago(10 - index / 10))));
    await knowledge(...Array.from({ length: 11 }, (_, index) => [day(index % 3), `Lesson ${index}`] as [string, string]));

    const news = await whatsNew(root, 'user', { now: NOW });

    expect(news.documents).toMatchObject({ more: 3 });
    expect(news.documents.items).toHaveLength(NEWS_LIMIT);
    expect(news.commits[0]).toMatchObject({ more: 3 });
    expect(news.commits[0]!.commits).toHaveLength(NEWS_LIMIT);
    expect(news.knowledge).toMatchObject({ more: 1 });
    // Oldest first, but the ten listed are the newest.
    expect(news.plan.more).toBe(2);
    expect(news.plan.items.map((change) => change.text)).toEqual(Array.from({ length: 10 }, (_, index) => `Step ${index + 2}`));
  });

  it('counts at most a hundred commits of a repository, and says so', async () => {
    await commit('Start', ago(3));
    const seconds = Math.floor(ago(2).getTime() / 1000);
    const stream = Array.from({ length: 105 }, (_, index) => [
      'commit refs/heads/main',
      `author Anna <a@example.com> ${seconds + index} +0000`, `committer Anna <a@example.com> ${seconds + index} +0000`, 'data 6', `bulk ${index % 10}`,
      ...(index === 0 ? ['from refs/heads/main^0'] : []), '',
    ].join('\n')).join('\n');
    await execa('git', ['fast-import', '--quiet'], { cwd: api, input: `${stream}\n` });
    expect((await execa('git', ['rev-list', '--count', 'HEAD'], { cwd: api })).stdout).toBe('106');

    const news = await whatsNew(root, 'user', { now: NOW });

    expect(news.commits[0]!.commits).toHaveLength(NEWS_LIMIT);
    expect(news.commits[0]).toMatchObject({ more: 90, moreAtLeast: true });
  });
});

describe('the commits section', () => {
  it('falls back to the time when the recorded commit is gone', async () => {
    await commit('Start the exporter', ago(9));
    await write('.contextspace/seen.json', JSON.stringify({ version: 1, readers: { claude: { at: ago(5).toISOString(), repos: { api: 'f'.repeat(40) }, knowledge: [], documents: [] } } }));
    await commit('Fix rounding in totals', ago(1));

    const news = await whatsNew(root, 'claude', { now: NOW });

    expect(news.commits[0]!.commits.map((entry) => entry.subject)).toEqual(['Fix rounding in totals']);
  });

  it('lists a repository that cannot be read with one line why, and still reports the others', async () => {
    const plain = path.join(root, 'web');
    await fs.mkdir(plain);
    await write('contextspace.json', JSON.stringify({ id: 'reports', name: 'Reports', branchName: 'reports', repos: [api, plain, path.join(root, 'gone')], assistants: [], workspacePath: root }));
    await commit('Fix rounding in totals', ago(1));

    const news = await whatsNew(root, 'user', { now: NOW });

    expect(news.commits.map((repo) => [repo.repo, repo.commits.length, repo.problem])).toEqual([
      ['api', 1, undefined], ['web', 0, 'This is not a git repository.'], ['gone', 0, 'The folder is missing.'],
    ]);
    expect(news.empty).toBe(false);
  });

  it('has nothing to say about a repository without commits', async () => {
    expect((await whatsNew(root, 'user', { now: NOW })).commits).toEqual([{ repo: 'api', commits: [], more: 0 }]);
  });

  it('reports a manifest it cannot read as a problem, not a failure', async () => {
    await write('contextspace.json', '{ not json');
    await write('docs/notes.md', 'x', ago(1));
    const news = await whatsNew(root, 'user', { now: NOW });
    expect(news.problems).toContainEqual(expect.stringContaining('The list of repositories could not be read'));
    expect(news.documents.items).toHaveLength(1);
  });
});

describe('the seen record', () => {
  it('starts over from a first look when the file is damaged, and repairs it on the next mark', async () => {
    await write('.contextspace/seen.json', '{ nope');
    expect((await whatsNew(root, 'claude', { now: NOW, mark: true })).basis).toBe('first-look');
    expect((await readSeen()).readers.claude.at).toBe(NOW.toISOString());
  });

  it('reads a reader named like an object property as any other reader', async () => {
    expect((await whatsNew(root, 'constructor', { now: NOW, mark: true })).basis).toBe('first-look');
    expect((await whatsNew(root, 'constructor', { now: new Date(NOW.getTime() + 1000) })).basis).toBe('last-look');
  });

  it('ignores a record whose fields are not usable', async () => {
    await write('.contextspace/seen.json', JSON.stringify({ version: 1, readers: { claude: { at: 'never', repos: {} }, codex: { at: ago(2).toISOString(), repos: { api: '--output=x', web: 5 }, knowledge: [1, 'a'], documents: 'x' } } }));
    expect((await whatsNew(root, 'claude', { now: NOW })).basis).toBe('first-look');
    await whatsNew(root, 'gemini', { now: NOW, mark: true });
    expect((await readSeen()).readers.codex).toEqual({ at: ago(2).toISOString(), repos: {}, knowledge: ['a'], documents: [] });
  });

  it('keeps the other readers when one marks, and only the most recent twenty', async () => {
    for (let index = 0; index < 22; index++) await whatsNew(root, `reader-${index}`, { now: ago(30 - index), mark: true });
    const readers = Object.keys((await readSeen()).readers);
    expect(readers).toHaveLength(20);
    expect(readers).toContain('reader-21');
    expect(readers).not.toContain('reader-0');
  });

  it('holds the pending lists of only the most recent twenty readers', async () => {
    for (let index = 0; index < 22; index++) await whatsNew(root, `reader-${index}`, { now: ago(30 - index), pending: true });
    const pending = Object.keys((await readSeen()).pending);
    expect(pending).toHaveLength(20);
    expect(pending).toContain('reader-21');
    expect(pending).not.toContain('reader-0');
  });

  it('keeps every reader when several mark at once', async () => {
    const readers = ['claude', 'codex', 'gemini', 'user'];
    await Promise.all(readers.map((reader) => whatsNew(root, reader, { now: ago(2), pending: true })));
    await Promise.all(readers.map((reader) => markSeen(root, reader, ago(2))));
    const seen = await readSeen();
    expect(Object.keys(seen.readers).sort()).toEqual(readers);
    expect(seen.pending).toEqual({});
  });

  it('never reads or writes the record through a link', async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'whats-new-outside-')));
    try {
      await fs.symlink(outside, path.join(root, '.contextspace'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(whatsNew(root, 'claude', { now: NOW, mark: true })).rejects.toThrow('Linked path');
      await expect(whatsNew(root, 'claude', { now: NOW, pending: true })).rejects.toThrow('Linked path');
      await expect(markSeen(root, 'claude', NOW)).rejects.toThrow('Linked path');
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('reader names', () => {
  it('keeps a short lower case name and refuses what could not be a key', () => {
    expect(newsReaderName(' Claude ')).toBe('claude');
    expect(newsReaderName('Claude Code')).toBe('claude-code');
    for (const name of ['', '__proto__', '../x', 'a/b', 'x'.repeat(41)]) expect(() => newsReaderName(name)).toThrow('not a name to read as');
  });
});
