import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  insertUnderHeading,
  formatEntry,
  parseKnowledgeEntries,
  addWorkspaceKnowledge,
  addBaseKnowledge,
  promoteKnowledge,
  readWorkspaceKnowledge,
  searchKnowledge,
  describeKnowledgeEntry,
  knowledgeTitle,
  knowledgeTitleSlug,
  knowledgeTitleWords,
  knowledgeEntryId,
  hasKnowledgeEntry,
  listKnowledgeLessons,
  readKnowledgeLessons,
  MAX_ENTRY_CHARS,
  MAX_TITLE_CHARS,
} from './knowledge.js';
import { PRIMARY_KNOWLEDGE_FILE } from './constants.js';
import * as storage from './storage.js';
import * as workspace from './workspace.js';
import * as generators from '../generators/index.js';
import * as fs from 'node:fs/promises';
import * as workspaceGit from './workspace-git.js';
import * as locks from './locks.js';
import { refreshAgentsLessons } from './agents-lessons.js';

vi.mock('./storage.js');
vi.mock('./agents-lessons.js');
vi.mock('./workspace.js');
vi.mock('../generators/index.js');
vi.mock('./workspace-git.js');
vi.mock('./locks.js');
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, access: vi.fn() };
});

function missingGitRepository(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('insertUnderHeading', () => {
  it('inserts under an existing heading and strips the placeholder', () => {
    const md = `## Known Gotchas\n\n<!-- keep me -->\n\n_(No gotchas recorded yet.)_\n`;
    const out = insertUnderHeading(md, ['Known Gotchas'], '- **2026-07-04:** watch the cache');

    expect(out).toContain('- **2026-07-04:** watch the cache');
    expect(out).not.toContain('No gotchas recorded yet');
    expect(out).toContain('<!-- keep me -->'); // comments are preserved
  });

  it('matches a heading via an alias', () => {
    const md = `## Discovered Gotchas & Watch-outs\n\n- None recorded yet.\n`;
    const out = insertUnderHeading(
      md,
      ['Discovered Gotchas & Watch-outs', 'Known Gotchas'],
      '- **2026-07-04:** x',
    );
    expect(out).toContain('- **2026-07-04:** x');
    expect(out).not.toContain('None recorded yet');
  });

  it('appends a new section when the heading is missing', () => {
    const md = `# Workspace Knowledge — feat\n`;
    const out = insertUnderHeading(
      md,
      ['Architecture Decisions'],
      '### 2026-07-04 — Chose X\n**Decision:** because reasons',
    );
    expect(out).toContain('## Architecture Decisions');
    expect(out).toContain('**Decision:** because reasons');
  });

  it('preserves CRLF line endings', () => {
    const md = `## Known Gotchas\r\n\r\n_(No gotchas recorded yet.)_\r\n`;
    const out = insertUnderHeading(md, ['Known Gotchas'], '- foo');
    expect(out.includes('\r\n')).toBe(true);
    // No bare LF (every \n must be preceded by \r).
    expect(/[^\r]\n/.test(out)).toBe(false);
  });

  it('passes through a leading YAML frontmatter block', () => {
    const md = `---\ntags: ["x"]\ntype: workspace-context\n---\n\n## Known Gotchas\n\n_(No gotchas recorded yet.)_\n`;
    const out = insertUnderHeading(md, ['Known Gotchas'], '- foo');
    expect(out.startsWith('---')).toBe(true);
    expect(out).toContain('tags: ["x"]');
    expect(out).toContain('- foo');
  });

  it('does not destroy an existing entry when adding another', () => {
    const md = `## Known Gotchas\n\n- **2026-07-01:** first\n`;
    const out = insertUnderHeading(md, ['Known Gotchas'], '- **2026-07-04:** second');
    expect(out).toContain('- **2026-07-01:** first');
    expect(out).toContain('- **2026-07-04:** second');
  });
});

describe('formatEntry', () => {
  const ts = '2026-07-04T10:00:00.000Z';

  it('formats a decision with a title as a dated ### block', () => {
    const out = formatEntry({ type: 'decision', message: 'use worktrees', title: 'Worktrees', timestamp: ts }, 'workspace');
    expect(out).toBe('### 2026-07-04 — Worktrees\n**Decision:** use worktrees');
  });

  it('leads a gotcha with its title so the file stays skimmable', () => {
    // The file only grows, so a reader must be able to judge relevance from the
    // first few words instead of reading every entry.
    const out = formatEntry(
      { type: 'gotcha', title: 'EBUSY on Windows', message: 'fs.rm needs maxRetries', timestamp: ts },
      'workspace',
    );
    expect(out).toBe('### 2026-07-04 — EBUSY on Windows\n**Gotcha:** fs.rm needs maxRetries');
  });

  it('rejects a missing title instead of deriving and truncating a heading', () => {
    expect(() => formatEntry({ type: 'gotcha', message: 'EBUSY on Windows', timestamp: ts }, 'workspace'))
      .toThrow(/title is required/);
  });

  it('does not format legacy progress without a searchable title', () => {
    expect(() => formatEntry({ type: 'progress', message: 'shipped rollback', timestamp: ts }, 'workspace'))
      .toThrow(/title is required/);
  });
});

describe('entry length cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({ id: 'feat', repos: ['/repos/repo-a'] } as never);
    vi.mocked(storage.workspaceFileExists).mockResolvedValue(false);
    vi.mocked(storage.baseFileExists).mockResolvedValue(false);
    vi.mocked(storage.writeWorkspaceFile).mockResolvedValue(undefined as never);
    vi.mocked(storage.writeBaseFile).mockResolvedValue(undefined as never);
    vi.mocked(generators.buildBaseKnowledgeContent).mockReturnValue('# Base\n');
    vi.mocked(workspaceGit.commitExactWorkspaceArtifacts).mockResolvedValue({ committed: false });
    vi.mocked(locks.acquireLock).mockResolvedValue(vi.fn().mockResolvedValue(undefined));
    vi.mocked(fs.access).mockRejectedValue(missingGitRepository());
  });

  const tooLong = 'x'.repeat(MAX_ENTRY_CHARS + 1);

  // Enforced in core precisely because the MCP tool and the HTTP endpoint call
  // these directly; a cap in the CLI handler bound neither.
  it('rejects an over-long workspace entry and writes nothing', async () => {
    await expect(
      addWorkspaceKnowledge('/ws', { type: 'decision', message: tooLong }),
    ).rejects.toThrow(/limit is 300/);

    expect(storage.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it('rejects an over-long base entry and writes nothing', async () => {
    await expect(
      addBaseKnowledge('/ws', 'repo-a', { type: 'gotcha', message: tooLong }),
    ).rejects.toThrow(/limit is 300/);

    expect(storage.writeBaseFile).not.toHaveBeenCalled();
  });

  it('explains how to shorten rather than only refusing', async () => {
    await expect(
      addWorkspaceKnowledge('/ws', { type: 'decision', message: tooLong }),
    ).rejects.toThrow(/separate entries/);
  });

  it('accepts an entry at the limit', async () => {
    await expect(
      addWorkspaceKnowledge('/ws', { type: 'decision', title: 'At limit', message: 'x'.repeat(MAX_ENTRY_CHARS) }),
    ).resolves.toBeTruthy();
  });

  it('stores the same collapsed string it measured', async () => {
    // Validating the trimmed form and storing the raw one let embedded newlines
    // past the limit and broke the one-entry-per-line shape.
    await addWorkspaceKnowledge('/ws', {
      type: 'gotcha',
      title: 'Spacing',
      message: '  keep   it\n\n  on one line  ',
      timestamp: '2026-07-04T10:00:00.000Z',
    });

    const written = vi.mocked(storage.writeWorkspaceFile).mock.calls[0]![3] as string;
    expect(written).toContain('### 2026-07-04 — Spacing\n**Gotcha:** keep it on one line');
    expect(written).not.toMatch(/keep {2,}it/);
  });

  it('still rejects an empty message', async () => {
    await expect(
      addWorkspaceKnowledge('/ws', { type: 'decision', message: '   ' }),
    ).rejects.toThrow(/cannot be empty/);
  });

  it('requires a title and rejects rather than truncating long titles', async () => {
    await expect(addWorkspaceKnowledge('/ws', { type: 'gotcha', message: 'rule' }))
      .rejects.toThrow(/title is required/);
    await expect(addWorkspaceKnowledge('/ws', { type: 'gotcha', title: 'x'.repeat(61), message: 'rule' }))
      .rejects.toThrow(/rejected rather than truncated/);
  });

  it('rejects authored progress and invalid scope traversal', async () => {
    await expect(addWorkspaceKnowledge('/ws', { type: 'progress', title: 'Done', message: 'done' }))
      .rejects.toThrow(/derived from live git state/);
    await expect(addWorkspaceKnowledge('/ws', { type: 'gotcha', title: 'Scope', scope: 'path:../secret', message: 'rule' }))
      .rejects.toThrow(/parent traversal/);
  });

  it('renders scope and evidence as searchable metadata', async () => {
    await addWorkspaceKnowledge('/ws', {
      type: 'gotcha', title: 'BFF error encoding', scope: 'seam:bff-spa', evidence: 'commit abc123', message: 'Decode once.',
      timestamp: '2026-08-25T00:00:00.000Z',
    });
    const written = vi.mocked(storage.writeWorkspaceFile).mock.calls.at(-1)![3] as string;
    expect(written).toContain('### 2026-08-25 — BFF error encoding');
    expect(written).toContain('**Scope:** `seam:bff-spa`');
    expect(written).toContain('**Evidence:** commit abc123');
  });
});

describe('parseKnowledgeEntries', () => {
  it('parses bullet entries and decision blocks with their types', () => {
    const md = [
      '## Known Gotchas',
      '',
      '- **2026-07-04:** watch out',
      '',
      '## Architecture Decisions',
      '',
      '### 2026-07-04 — Chose X',
      '**Decision:** because',
      '',
    ].join('\n');

    const parsed = parseKnowledgeEntries(md);

    expect(parsed).toContainEqual({
      section: 'Known Gotchas',
      type: 'gotcha',
      text: '- **2026-07-04:** watch out',
    });
    const decision = parsed.find((p) => p.type === 'decision');
    expect(decision?.text).toContain('### 2026-07-04 — Chose X');
    expect(decision?.text).toContain('**Decision:** because');
  });

  it('ignores placeholder and comment lines', () => {
    const md = `## Known Gotchas\n\n<!-- hint -->\n\n_(No gotchas recorded yet.)_\n`;
    expect(parseKnowledgeEntries(md)).toHaveLength(0);
  });
});

describe('knowledgeTitle', () => {
  it('keeps the title as written: capitals, dots, apostrophes and hyphens', () => {
    expect(knowledgeTitle("PLAN.md has its own lock, apart from the AI's re-fetch")).toBe("PLAN.md has its own lock, apart from the AI's re-fetch");
  });

  it('puts it on one line: whitespace collapsed, control characters removed', () => {
    expect(knowledgeTitle('  Two \t  words\u0007 here  ')).toBe('Two words here');
    expect(knowledgeTitle('Trailing newline\n')).toBe('Trailing newline');
  });

  it('refuses a title with a line break, one that starts with #, or one with no letter or digit', () => {
    expect(() => knowledgeTitle('Two\nlines')).toThrow(/one line/);
    expect(() => knowledgeTitle('Two\r\nlines')).toThrow(/one line/);
    expect(() => knowledgeTitle('# A heading')).toThrow(/cannot start with #/);
    expect(() => knowledgeTitle('--- !!!')).toThrow(/at least one letter or number/);
  });

  it('accepts a title that is only letters of another alphabet', () => {
    expect(knowledgeTitle('Größe der Warteschlange')).toBe('Größe der Warteschlange');
    expect(knowledgeTitle('日本語')).toBe('日本語');
  });

  it('requires one and refuses one over the limit rather than cutting it', () => {
    expect(() => knowledgeTitle('   ')).toThrow(/title is required/);
    expect(() => knowledgeTitle(undefined as unknown as string)).toThrow(/title is required/);
    expect(knowledgeTitle('x'.repeat(MAX_TITLE_CHARS))).toHaveLength(MAX_TITLE_CHARS);
    expect(() => knowledgeTitle('x'.repeat(MAX_TITLE_CHARS + 1))).toThrow(/rejected rather than truncated/);
  });

  it('has a slug for what needs an identifier', () => {
    expect(knowledgeTitleSlug("PLAN.md has its own lock, apart from the AI's loop")).toBe('plan-md-has-its-own-lock-apart-from-the-ai-s-loop');
    expect(knowledgeTitleSlug('日本語')).toBe('entry');
  });
});

describe('knowledge entry ids', () => {
  it('are the same for a title written as words and for the slug older versions wrote', () => {
    expect(knowledgeEntryId('### 2026-08-25 — BFF error-encoding')).toBe('2026-08-25-bff-error-encoding');
    expect(knowledgeEntryId('### 2026-08-25 — bff-error-encoding\n**Gotcha:** x')).toBe('2026-08-25-bff-error-encoding');
    expect(knowledgeEntryId('### Undated title')).toBeNull();
    expect(knowledgeEntryId('- a bullet')).toBeNull();
  });

  it('find an entry in a file written either way', () => {
    const words = '## Known Gotchas\n\n### 2026-08-25 — BFF error encoding\n**Gotcha:** x\n';
    const slug = '## Known Gotchas\n\n### 2026-08-25 — bff-error-encoding\n**Gotcha:** x\n';

    expect(hasKnowledgeEntry(words, '2026-08-25-bff-error-encoding')).toBe(true);
    expect(hasKnowledgeEntry(slug, '2026-08-25-bff-error-encoding')).toBe(true);
    expect(hasKnowledgeEntry(words, '2026-08-26-bff-error-encoding')).toBe(false);
  });
});

describe('describing an entry', () => {
  it('writes a slug title in words and keeps a title already written in words', () => {
    expect(knowledgeTitleWords('plan-md-has-its-own-lock')).toBe('Plan md has its own lock');
    expect(knowledgeTitleWords('plan_md--lock')).toBe('Plan md lock');
    expect(knowledgeTitleWords('Re-run the check')).toBe('Re-run the check');
  });

  it('keeps a title written as words exactly, whatever its case, dots, apostrophes and hyphens', () => {
    for (const title of ['PLAN.md has its own lock', "The AI's loop, not the app", 'Re-run', 'iOS notes', 'README', 'v2.1-beta notes']) {
      expect(knowledgeTitleWords(title), title).toBe(title);
    }
  });

  it('splits a dated heading into title, date and the text under it', () => {
    const entry = {
      section: 'Known Gotchas',
      type: 'gotcha' as const,
      text: '### 2026-10-16 — needs-you-clutter\n**Gotcha:** the migration left items.\n**Scope:** `repo:api`',
    };

    expect(describeKnowledgeEntry(entry)).toEqual({
      title: 'Needs you clutter',
      date: '2026-10-16',
      body: '**Gotcha:** the migration left items.\n**Scope:** `repo:api`',
    });
  });

  it('gives a title written as words back exactly as it is in the file', () => {
    const text = "### 2026-10-17 — PLAN.md has its own lock, apart from Tanstack's re-fetch\n**Gotcha:** x";

    expect(describeKnowledgeEntry({ section: 'Known Gotchas', type: 'gotcha', text }))
      .toEqual({ title: "PLAN.md has its own lock, apart from Tanstack's re-fetch", date: '2026-10-17', body: '**Gotcha:** x' });
  });

  it('gives a heading written by hand its title, without a date', () => {
    expect(describeKnowledgeEntry({ section: 'Known Gotchas', type: 'gotcha', text: '### Cache is shared\nit is.' }))
      .toEqual({ title: 'Cache is shared', date: null, body: 'it is.' });
  });

  it('describes a bullet by its section, since a bullet has no title', () => {
    expect(describeKnowledgeEntry({ section: 'Known Gotchas', type: 'gotcha', text: '- **2026-07-04:** watch out' }))
      .toEqual({ title: 'Known Gotchas', date: null, body: '**2026-07-04:** watch out' });
  });
});

describe('listKnowledgeLessons', () => {
  const file = [
    '# Workspace Knowledge — feat',
    '',
    '## Feature Goal',
    '',
    '### Not an entry',
    '',
    '## Known Gotchas',
    '',
    '- a bullet has no title',
    '',
    '### 2026-10-16 — older-gotcha',
    '**Gotcha:** a',
    '',
    '### 2026-10-17 — newer-gotcha',
    '**Gotcha:** b',
    '',
    '## Architecture Decisions',
    '',
    '### 2026-10-17 — newest-decision-the-same-day',
    '**Decision:** c',
    '',
    '## Implementation Progress',
    '',
    '### 2026-10-18 — a-progress-note',
    '',
  ].join('\n');

  it('lists the titled entries newest first, the later one of a day first', () => {
    expect(listKnowledgeLessons(file)).toEqual([
      { title: 'Newest decision the same day', type: 'decision' },
      { title: 'Newer gotcha', type: 'gotcha' },
      { title: 'Older gotcha', type: 'gotcha' },
    ]);
  });

  it('leaves out bullets, progress notes and headings outside the known sections', () => {
    expect(listKnowledgeLessons(file).map((lesson) => lesson.title)).not.toContain('Not an entry');
    expect(listKnowledgeLessons(file).map((lesson) => lesson.title)).not.toContain('A progress note');
    expect(listKnowledgeLessons(file)).toHaveLength(3);
  });

  it('lists nothing for an empty file', () => {
    expect(listKnowledgeLessons('')).toEqual([]);
  });

  it('labels each entry with the repo when it comes from a repo\'s base knowledge', () => {
    const md = '## Discovered Gotchas & Watch-outs\n\n### 2026-10-01 — port-clash\n**Gotcha:** x\n';

    expect(listKnowledgeLessons(md, 'api')).toEqual([{ title: 'Port clash', type: 'gotcha', repo: 'api' }]);
    expect(listKnowledgeLessons(md)).toEqual([{ title: 'Port clash', type: 'gotcha' }]);
  });

  it('lists a title written as words as it is written and an older slug heading as words', () => {
    const md = [
      '## Known Gotchas',
      '',
      '### 2026-10-16 — plan-md-has-its-own-lock',
      '**Gotcha:** an older entry, stored as a slug',
      '',
      "### 2026-10-17 — PLAN.md has its own lock, apart from the AI's loop",
      '**Gotcha:** a newer entry, stored as written',
      '',
    ].join('\n');

    expect(listKnowledgeLessons(md).map((lesson) => lesson.title)).toEqual([
      "PLAN.md has its own lock, apart from the AI's loop",
      'Plan md has its own lock',
    ]);
  });

  it('puts an entry without a date last', () => {
    const md = '## Known Gotchas\n\n### Undated\nx\n\n### 2026-01-01 — dated\ny\n';

    expect(listKnowledgeLessons(md).map((lesson) => lesson.title)).toEqual(['Dated', 'Undated']);
  });
});

// ─── Adapter-routed I/O (in-memory storage mock) ────────────────────────────

describe('knowledge I/O', () => {
  const ws = new Map<string, string>();
  const base = new Map<string, string>();

  beforeEach(() => {
    vi.clearAllMocks();
    ws.clear();
    base.clear();
    vi.mocked(workspaceGit.commitExactWorkspaceArtifacts).mockResolvedValue({ committed: false });
    vi.mocked(locks.acquireLock).mockResolvedValue(vi.fn().mockResolvedValue(undefined));
    vi.mocked(fs.access).mockRejectedValue(missingGitRepository());

    vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({ id: 'feat', repos: ['/repos/api'] } as any);
    vi.mocked(generators.buildBaseKnowledgeContent).mockImplementation(
      (repo: string) =>
        `# Base Codebase Knowledge — ${repo}\n\n## Discovered Gotchas & Watch-outs\n- None recorded yet.\n\n## Architecture Decisions\n- None recorded yet.\n`,
    );

    vi.mocked(storage.workspaceFileExists).mockImplementation(async (_w, fid, fn) => ws.has(`${fid}/${fn}`));
    vi.mocked(storage.readWorkspaceFile).mockImplementation(async (_w, fid, fn) => ws.get(`${fid}/${fn}`)!);
    vi.mocked(storage.writeWorkspaceFile).mockImplementation(async (_w, fid, fn, c) => {
      ws.set(`${fid}/${fn}`, c);
    });
    vi.mocked(storage.resolveWorkspaceFileUrl).mockImplementation((_w, fid, fn) => `ws:/${fid}/${fn}`);

    vi.mocked(storage.baseFileExists).mockImplementation(async (_w, repo, fn) => base.has(`${repo}/${fn}`));
    vi.mocked(storage.readBaseFile).mockImplementation(async (_w, repo, fn) => base.get(`${repo}/${fn}`)!);
    vi.mocked(storage.writeBaseFile).mockImplementation(async (_w, repo, fn, c) => {
      base.set(`${repo}/${fn}`, c);
    });
    vi.mocked(storage.resolveBaseFileUrl).mockImplementation((_w, repo, fn) => `base:/${repo}/${fn}`);
  });

  it('creates the workspace knowledge file when missing and records the entry', async () => {
    const result = await addWorkspaceKnowledge('/wsp', {
      type: 'decision',
      message: 'store knowledge via the adapter',
      title: 'Adapter routing',
    });

    expect(result.createdFile).toBe(true);
    const content = ws.get(`feat/${PRIMARY_KNOWLEDGE_FILE}`)!;
    expect(content).toContain('## Architecture Decisions');
    expect(content).toContain('**Decision:** store knowledge via the adapter');
  });

  it('treats an identical retry as success without appending a duplicate', async () => {
    const entry = {
      type: 'decision' as const,
      message: 'store knowledge once',
      title: 'Idempotent remember',
      timestamp: '2026-08-26T00:00:00.000Z',
    };
    await addWorkspaceKnowledge('/wsp', entry);
    const retry = await addWorkspaceKnowledge('/wsp', entry);

    expect(retry.duplicate).toBe(true);
    expect(ws.get(`feat/${PRIMARY_KNOWLEDGE_FILE}`)!.match(/### 2026-08-26 — Idempotent remember/g)).toHaveLength(1);
  });

  it('treats the same date, type and title as the same entry, however the title is spelled', async () => {
    ws.set(`feat/${PRIMARY_KNOWLEDGE_FILE}`, '# Workspace Knowledge — feat\n\n## Known Gotchas\n\n### 2026-08-26 — plan-md-has-its-own-lock\n**Gotcha:** The plan locks its own file.\n');

    // An entry an older version wrote as a slug, retried now with the title as written.
    const retry = await addWorkspaceKnowledge('/wsp', { type: 'gotcha', title: 'PLAN.md has its own lock', message: 'The plan locks its own file.', timestamp: '2026-08-26T00:00:00.000Z' });

    expect(retry.duplicate).toBe(true);
    expect(ws.get(`feat/${PRIMARY_KNOWLEDGE_FILE}`)!.match(/^### /gm)).toHaveLength(1);
    // The same title on the same day with other text is a collision, whichever way the first was spelled.
    await expect(addWorkspaceKnowledge('/wsp', { type: 'gotcha', title: 'PLAN.md has its own lock', message: 'Something else.', timestamp: '2026-08-26T00:00:00.000Z' }))
      .rejects.toThrow(/already exists with different content/);
  });

  it('stores a new title as written, and names the commit after its slug', async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined);

    await addWorkspaceKnowledge('/wsp', { type: 'gotcha', title: "PLAN.md has its own lock, apart from the AI's loop", message: 'Rule.', timestamp: '2026-08-26T00:00:00.000Z' });

    expect(ws.get(`feat/${PRIMARY_KNOWLEDGE_FILE}`)).toContain("### 2026-08-26 — PLAN.md has its own lock, apart from the AI's loop\n**Gotcha:** Rule.");
    expect(workspaceGit.commitExactWorkspaceArtifacts).toHaveBeenCalledWith('/wsp', 'docs(knowledge): remember plan-md-has-its-own-lock-apart-from-the-ai-s-loop', [PRIMARY_KNOWLEDGE_FILE]);
  });

  it('stores a title in a repo\'s base knowledge as written too', async () => {
    await addBaseKnowledge('/wsp', 'api', { type: 'gotcha', title: 'EBUSY on Windows', message: 'fs.rm needs maxRetries.', timestamp: '2026-08-26T00:00:00.000Z' });

    expect(base.get(`api/${PRIMARY_KNOWLEDGE_FILE}`)).toContain('### 2026-08-26 — EBUSY on Windows\n**Gotcha:** fs.rm needs maxRetries.');
  });

  it('promotes entries with either kind of heading, by copy and by move, keeping the heading as it is', async () => {
    const asWords = "### 2026-08-26 — PLAN.md has its own lock, apart from the AI's loop\n**Gotcha:** Rule one.";
    const asSlug = '### 2026-08-25 — old-slug-heading\n**Gotcha:** Rule two.';
    ws.set(`feat/${PRIMARY_KNOWLEDGE_FILE}`, `# Workspace Knowledge — feat\n\n## Known Gotchas\n\n${asSlug}\n\n${asWords}\n`);
    const entries = parseKnowledgeEntries((await readWorkspaceKnowledge('/wsp'))!);

    await promoteKnowledge('/wsp', { repoName: 'api', entries, mode: 'copy' });
    expect(base.get(`api/${PRIMARY_KNOWLEDGE_FILE}`)).toContain(asWords);
    expect(base.get(`api/${PRIMARY_KNOWLEDGE_FILE}`)).toContain(asSlug);
    expect(ws.get(`feat/${PRIMARY_KNOWLEDGE_FILE}`)).toContain(asWords);

    // Promoting the same entries again adds nothing: they are already there under either spelling.
    const again = await promoteKnowledge('/wsp', { repoName: 'api', entries, mode: 'move' });
    expect(again.promotedCount).toBe(2);
    expect(base.get(`api/${PRIMARY_KNOWLEDGE_FILE}`)!.match(/^### /gm)).toHaveLength(2);
    expect(ws.get(`feat/${PRIMARY_KNOWLEDGE_FILE}`)).not.toContain('PLAN.md has its own lock');
    expect(ws.get(`feat/${PRIMARY_KNOWLEDGE_FILE}`)!.match(/Promoted to api base knowledge/g)).toHaveLength(2);
  });

  it('rejects a same-day title collision with different content', async () => {
    await addWorkspaceKnowledge('/wsp', {
      type: 'decision', title: 'Stable identity', message: 'first rule', timestamp: '2026-08-26T00:00:00.000Z',
    });

    await expect(addWorkspaceKnowledge('/wsp', {
      type: 'decision', title: 'Stable identity', message: 'different rule', timestamp: '2026-08-26T01:00:00.000Z',
    })).rejects.toThrow(/already exists with different content/);
  });

  it('reports a Git commit failure without failing the completed knowledge write', async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(workspaceGit.commitExactWorkspaceArtifacts).mockRejectedValue(new Error('index locked'));

    const result = await addWorkspaceKnowledge('/wsp', {
      type: 'gotcha', title: 'Commit recovery', message: 'Keep the durable adapter write.',
      timestamp: '2026-08-26T00:00:00.000Z',
    });

    expect(result.commit).toEqual({ status: 'failed', message: 'index locked' });
    expect(ws.get(`feat/${PRIMARY_KNOWLEDGE_FILE}`)).toContain('Keep the durable adapter write.');
  });

  it('rejects an empty message', async () => {
    await expect(
      addWorkspaceKnowledge('/wsp', { type: 'gotcha', message: '   ' }),
    ).rejects.toThrow(/cannot be empty/i);
  });

  describe('the lessons AGENTS.md lists', () => {
    const entry = { type: 'gotcha' as const, title: 'Keep the list', message: 'Lessons follow the knowledge.', timestamp: '2026-08-26T00:00:00.000Z' };

    it('are brought up to date after a new entry, from the knowledge as it then is', async () => {
      await addWorkspaceKnowledge('/wsp', entry);

      expect(refreshAgentsLessons).toHaveBeenCalledTimes(1);
      expect(refreshAgentsLessons).toHaveBeenCalledWith('/wsp', expect.any(Function));
      const readLessons = vi.mocked(refreshAgentsLessons).mock.calls[0]![1];
      expect(await readLessons()).toEqual([{ title: 'Keep the list', type: 'gotcha' }]);
    });

    it('are left alone when the entry was already there', async () => {
      await addWorkspaceKnowledge('/wsp', entry);
      vi.mocked(refreshAgentsLessons).mockClear();

      expect((await addWorkspaceKnowledge('/wsp', entry)).duplicate).toBe(true);

      expect(refreshAgentsLessons).not.toHaveBeenCalled();
    });

    it('never fail the entry they follow', async () => {
      vi.mocked(refreshAgentsLessons).mockRejectedValue(new Error('a refresh holds AGENTS.md'));

      const result = await addWorkspaceKnowledge('/wsp', entry);

      expect(result.duplicate).toBe(false);
      expect(ws.get(`feat/${PRIMARY_KNOWLEDGE_FILE}`)).toContain('Lessons follow the knowledge.');
    });

    it('are updated when entries are promoted to a repo, by copy or by move, and not when nothing was promoted', async () => {
      ws.set(`feat/${PRIMARY_KNOWLEDGE_FILE}`, '# Workspace Knowledge — feat\n\n## Known Gotchas\n\n- **2026-07-04:** shared learning\n');
      const entries = parseKnowledgeEntries((await readWorkspaceKnowledge('/wsp'))!);

      await promoteKnowledge('/wsp', { repoName: 'api', entries: [], mode: 'copy' });
      expect(refreshAgentsLessons).not.toHaveBeenCalled();

      await promoteKnowledge('/wsp', { repoName: 'api', entries, mode: 'copy' });
      await promoteKnowledge('/wsp', { repoName: 'api', entries, mode: 'move' });
      expect(refreshAgentsLessons).toHaveBeenCalledTimes(2);
    });

    it('are updated when an entry is added to a repo\'s base knowledge, not when it was already there', async () => {
      const entry = { type: 'gotcha' as const, title: 'Port clash', message: 'Port 8080 clashes with the backend.', timestamp: '2026-08-26T00:00:00.000Z' };

      await addBaseKnowledge('/wsp', 'api', entry);
      expect(refreshAgentsLessons).toHaveBeenCalledTimes(1);

      await addBaseKnowledge('/wsp', 'api', entry);
      expect(refreshAgentsLessons).toHaveBeenCalledTimes(1);
    });

    it('are none when there is no knowledge file', async () => {
      expect(await readKnowledgeLessons('/wsp')).toEqual([]);
    });

    describe('from the repos in the workspace', () => {
      const baseFile = (entries: string[]) => `# Base Codebase Knowledge — x\n\n## Discovered Gotchas & Watch-outs\n\n${entries.join('\n\n')}\n\n## Architecture Decisions\n\n- None recorded yet.\n`;

      beforeEach(() => {
        vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({ id: 'feat', repos: ['/repos/api', '/repos/web'] } as any);
      });

      it('follow the workspace\'s own, newest first and labelled with the repo, across all repos', async () => {
        ws.set(`feat/${PRIMARY_KNOWLEDGE_FILE}`, '## Known Gotchas\n\n### 2026-10-01 — own-old\n**Gotcha:** a\n\n### 2026-10-03 — own-new\n**Gotcha:** b\n');
        base.set(`api/${PRIMARY_KNOWLEDGE_FILE}`, baseFile(['### 2026-09-01 — api-old\n**Gotcha:** c', '### 2026-09-20 — api-new\n**Gotcha:** d']));
        base.set(`web/${PRIMARY_KNOWLEDGE_FILE}`, baseFile(['### 2026-09-10 — web-middle\n**Gotcha:** e']));

        expect(await readKnowledgeLessons('/wsp')).toEqual([
          { title: 'Own new', type: 'gotcha' },
          { title: 'Own old', type: 'gotcha' },
          { title: 'Api new', type: 'gotcha', repo: 'api' },
          { title: 'Web middle', type: 'gotcha', repo: 'web' },
          { title: 'Api old', type: 'gotcha', repo: 'api' },
        ]);
      });

      it('are listed when the workspace has no knowledge of its own', async () => {
        base.set(`api/${PRIMARY_KNOWLEDGE_FILE}`, baseFile(['### 2026-09-01 — api-old\n**Gotcha:** c']));

        expect(await readKnowledgeLessons('/wsp')).toEqual([{ title: 'Api old', type: 'gotcha', repo: 'api' }]);
      });

      it('are listed once when an entry promoted by copy is in both files', async () => {
        const entry = '### 2026-09-01 — shared-rule\n**Gotcha:** c';
        ws.set(`feat/${PRIMARY_KNOWLEDGE_FILE}`, `## Known Gotchas\n\n${entry}\n`);
        base.set(`api/${PRIMARY_KNOWLEDGE_FILE}`, baseFile([entry]));

        expect(await readKnowledgeLessons('/wsp')).toEqual([{ title: 'Shared rule', type: 'gotcha' }]);
      });

      it('skip a repo whose base knowledge cannot be read, and list the others', async () => {
        base.set(`api/${PRIMARY_KNOWLEDGE_FILE}`, baseFile(['### 2026-09-01 — api-old\n**Gotcha:** c']));
        base.set(`web/${PRIMARY_KNOWLEDGE_FILE}`, baseFile(['### 2026-09-10 — web-middle\n**Gotcha:** e']));
        vi.mocked(storage.readBaseFile).mockImplementation(async (_w, repo, fn) => {
          if (repo === 'api') throw new Error('store unreadable');
          return base.get(`${repo}/${fn}`)!;
        });

        expect(await readKnowledgeLessons('/wsp')).toEqual([{ title: 'Web middle', type: 'gotcha', repo: 'web' }]);
      });

      it('are none from a repo that has no base knowledge yet', async () => {
        expect(await readKnowledgeLessons('/wsp')).toEqual([]);
      });
    });
  });

  it('adds to a repo base file, bootstrapping it from the template', async () => {
    const result = await addBaseKnowledge('/wsp', 'api', { type: 'gotcha', title: 'Flaky CI test', message: 'flaky test on CI' });
    expect(result.createdFile).toBe(true);
    const content = base.get(`api/${PRIMARY_KNOWLEDGE_FILE}`)!;
    expect(content).toContain('## Discovered Gotchas & Watch-outs');
    expect(content).toContain('flaky test on CI');
  });

  it('rejects traversal and unknown repo names before touching base storage', async () => {
    await expect(addBaseKnowledge('/wsp', '../outside', {
      type: 'gotcha', title: 'Traversal', message: 'must stay contained',
    })).rejects.toThrow(/Invalid repository name/);
    await expect(addBaseKnowledge('/wsp', 'unknown', {
      type: 'gotcha', title: 'Unknown', message: 'must be configured',
    })).rejects.toThrow(/not in this workspace/);

    expect(storage.baseFileExists).not.toHaveBeenCalled();
    expect(storage.writeBaseFile).not.toHaveBeenCalled();
  });

  it('promotes a gotcha to base knowledge (copy leaves the workspace entry)', async () => {
    ws.set(
      `feat/${PRIMARY_KNOWLEDGE_FILE}`,
      `# Workspace Knowledge — feat\n\n## Known Gotchas\n\n- **2026-07-04:** shared learning\n`,
    );
    const entries = parseKnowledgeEntries((await readWorkspaceKnowledge('/wsp'))!);

    const result = await promoteKnowledge('/wsp', { repoName: 'api', entries, mode: 'copy' });

    expect(result.promotedCount).toBe(1);
    expect(base.get(`api/${PRIMARY_KNOWLEDGE_FILE}`)).toContain('- **2026-07-04:** shared learning');
    // Copy mode keeps the original.
    expect(ws.get(`feat/${PRIMARY_KNOWLEDGE_FILE}`)).toContain('- **2026-07-04:** shared learning');
  });

  it('move mode replaces the promoted workspace entry with a note', async () => {
    ws.set(
      `feat/${PRIMARY_KNOWLEDGE_FILE}`,
      `# Workspace Knowledge — feat\n\n## Known Gotchas\n\n- **2026-07-04:** shared learning\n`,
    );
    const entries = parseKnowledgeEntries((await readWorkspaceKnowledge('/wsp'))!);

    await promoteKnowledge('/wsp', { repoName: 'api', entries, mode: 'move' });

    const wsContent = ws.get(`feat/${PRIMARY_KNOWLEDGE_FILE}`)!;
    expect(wsContent).not.toContain('shared learning');
    expect(wsContent).toContain('Promoted to api base knowledge');
    expect(base.get(`api/${PRIMARY_KNOWLEDGE_FILE}`)).toContain('shared learning');
  });

  describe('searchKnowledge', () => {
    it('finds matching entries across workspace and base knowledge', async () => {
      ws.set(
        'feat/nexusflow-knowledge.md',
        `# Workspace Knowledge — feat\n\n## Architecture Decisions\n\n### 2026-08-25 — worktree-isolation\n**Decision:** isolate repos dynamically\n**Scope:** \`repo:api\`\n`,
      );
      base.set(
        'api/nexusflow-knowledge.md',
        `# Base Knowledge — api\n\n## Known Gotchas\n\n### 2026-08-20 — port-conflict\n**Gotcha:** port 8080 conflicts with backend\n`,
      );

      const results = await searchKnowledge('/wsp', 'isolate');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        source: 'workspace',
        type: 'decision',
        text: expect.stringContaining('isolate repos dynamically'),
      });

      const gotchaResults = await searchKnowledge('/wsp', 'conflict');
      expect(gotchaResults).toHaveLength(1);
      expect(gotchaResults[0]).toMatchObject({
        source: 'base',
        repo: 'api',
        type: 'gotcha',
        text: expect.stringContaining('port 8080 conflicts'),
      });
    });

    it('filters by type and scope', async () => {
      ws.set(
        'feat/nexusflow-knowledge.md',
        `# Workspace Knowledge — feat\n\n## Architecture Decisions\n\n### 2026-08-25 — auth-token\n**Decision:** use bearer token\n**Scope:** \`repo:api\`\n\n## Known Gotchas\n\n### 2026-08-25 — token-expiry\n**Gotcha:** token expires in 5m\n**Scope:** \`repo:api\`\n`,
      );

      const gotchas = await searchKnowledge('/wsp', 'token', { type: 'gotcha' });
      expect(gotchas).toHaveLength(1);
      expect(gotchas[0]!.type).toBe('gotcha');

      const scoped = await searchKnowledge('/wsp', 'token', { scope: 'repo:api' });
      expect(scoped.length).toBeGreaterThanOrEqual(2);
    });
  });
});
