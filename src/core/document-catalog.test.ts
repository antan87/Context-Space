import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import * as fsSafety from '../resources/fs-safety.js';
import { registerWorkGuidanceRoutes } from '../http/work-guidance-routes.js';
import {
  buildDocumentCatalog,
  clearDocumentCatalogCache,
  extractDocumentMetadata,
  humanizeDocumentFilename,
  isEvidencePath,
} from './document-catalog.js';

let root: string;

beforeEach(async () => {
  clearDocumentCatalogCache();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-catalog-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('isEvidencePath', () => {
  it('classifies evidence folders and log/hash/patch artifacts', () => {
    expect(isEvidencePath('design/evidence')).toBe(true);
    expect(isEvidencePath('design/evidence/dc1-2026-11-25/report.md')).toBe(true);
    expect(isEvidencePath('evidence')).toBe(true);
    expect(isEvidencePath('sub/evidence/run.md')).toBe(true);
    expect(isEvidencePath('dc1-before.log')).toBe(true);
    expect(isEvidencePath('logs/run.log')).toBe(true);
    expect(isEvidencePath('dc1.patch')).toBe(true);
    expect(isEvidencePath('dc1-hashes.txt')).toBe(true);
    expect(isEvidencePath('dc1-source-hashes.txt')).toBe(true);
    expect(isEvidencePath('frozen-tree.txt')).toBe(true);

    expect(isEvidencePath('PLAN.md')).toBe(false);
    expect(isEvidencePath('design/packets/dc1-documents-page.md')).toBe(false);
    expect(isEvidencePath('design/evidence-summary.md')).toBe(false);
    expect(isEvidencePath('board-pictures/root.png')).toBe(false);
  });
});

describe('extractDocumentMetadata', () => {
  it('extracts markdown title and excerpt stripping comments, frontmatter, and inline markdown', () => {
    const content = [
      '---',
      'title: Ignored frontmatter',
      'status: draft',
      '---',
      '<!-- CONTEXTSPACE:FRESHNESS:START -->',
      '<!-- hidden comment -->',
      '# **DC1**: The `Documents` [page](docs/page.md) <!-- step:dc1-id -->',
      '',
      '<!-- another comment',
      'spanning two lines -->',
      'First **prose** line with `code` and a [link](https://example.com).',
      'Second prose line explaining folders and previews.',
      '',
      '## Next heading ignored',
      'More text',
    ].join('\n');

    expect(extractDocumentMetadata('markdown', 'PLAN.md', content)).toEqual({
      title: 'DC1: The Documents page',
      excerpt: 'First prose line with code and a link. Second prose line explaining folders and previews.',
    });
  });

  it('preserves placeholders, snake_case identifiers, trailing C#, and horizontal rules', () => {
    expect(
      extractDocumentMetadata(
        'markdown',
        'packet.md',
        '# <slice>: <short title>\n\nUse `board_add_card` and `foo_bar_baz` inside <scratch>/report.md.',
      ),
    ).toEqual({
      title: '<slice>: <short title>',
      excerpt: 'Use board_add_card and foo_bar_baz inside <scratch>/report.md.',
    });

    expect(
      extractDocumentMetadata(
        'markdown',
        'csharp.md',
        '---\n\n# Guide to C# ##\n\n---\n\nCovers `my_var_name` and _real italics_.',
      ),
    ).toEqual({
      title: 'Guide to C#',
      excerpt: 'Covers my_var_name and real italics.',
    });
  });

  it('extracts HTML title/h1 and meta description or first paragraph', () => {
    const withMeta = '<!doctype html><html><head><title>Documents &amp; Folders</title><meta content="Calm folder browser" name="description"></head><body><h1>Ignored</h1><p>Body</p></body></html>';
    expect(extractDocumentMetadata('html', 'mock.html', withMeta)).toEqual({
      title: 'Documents & Folders',
      excerpt: 'Calm folder browser',
    });

    const withH1AndP = '<html><head><style>body{color:red}</style></head><body><h1>Overview Mock</h1><p>Shows <strong>folders</strong> and previews.</p></body></html>';
    expect(extractDocumentMetadata('html', 'overview.html', withH1AndP)).toEqual({
      title: 'Overview Mock',
      excerpt: 'Shows folders and previews.',
    });
  });

  it('extracts first non-empty line for text and humanizes fallback titles', () => {
    expect(extractDocumentMetadata('text', 'meeting_notes-v2.txt', '\n\n   Agenda for the meeting   \nSecond line\n')).toEqual({
      title: 'Meeting notes v2',
      excerpt: 'Agenda for the meeting',
    });
    expect(humanizeDocumentFilename('design/packets/my_work-order.md')).toBe('My work order');
  });
});

describe('buildDocumentCatalog', () => {
  it('excludes repo folders, closed hidden segments, ContextSpace stores, and symlinks', async () => {
    await fs.mkdir(path.join(root, 'NexusFlow', 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'NexusFlow', 'README.md'), '# Repo readme');
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.git', 'notes.md'), '# Hidden git');
    await fs.mkdir(path.join(root, '.contextspace'));
    await fs.writeFile(path.join(root, '.contextspace', 'internal.md'), '# Internal');
    await fs.mkdir(path.join(root, '.agents', 'skills', 'dev'), { recursive: true });
    await fs.writeFile(path.join(root, '.agents', 'skills', 'dev', 'SKILL.md'), '# Dev Skill\n\nHelps develop.');
    await fs.writeFile(path.join(root, 'contextspace.json'), '{}');
    await fs.writeFile(path.join(root, 'contextspace-plan.json'), '{}');
    await fs.writeFile(path.join(root, 'PLAN.md'), '# Workspace Plan <!-- id:root -->\n\nBuild the board.');

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.md'), '# Secret');
      await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'linked.md'));
      await fs.symlink(outside, path.join(root, 'linked-dir'));

      const catalog = await buildDocumentCatalog(root, { repoFolders: ['NexusFlow'] });
      const paths = catalog.items.map((item) => item.path);
      const folderPaths = catalog.folders.map((folder) => folder.path);

      expect(paths).toContain('PLAN.md');
      expect(paths).toContain('.agents/skills/dev/SKILL.md');
      expect(paths).not.toContain('NexusFlow/README.md');
      expect(paths).not.toContain('.git/notes.md');
      expect(paths).not.toContain('.contextspace/internal.md');
      expect(paths).not.toContain('contextspace.json');
      expect(paths).not.toContain('contextspace-plan.json');
      expect(paths).not.toContain('linked.md');
      expect(paths).not.toContain('linked-dir/secret.md');

      expect(folderPaths).not.toContain('NexusFlow');
      expect(folderPaths).not.toContain('.git');
      expect(folderPaths).not.toContain('.contextspace');
      expect(folderPaths).not.toContain('linked-dir');
      expect(folderPaths).toContain('.agents');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('extracts folder README summaries, folds evidence without reading evidence files, and orders recent docs', async () => {
    await fs.mkdir(path.join(root, 'design', 'plans'), { recursive: true });
    await fs.mkdir(path.join(root, 'design', 'evidence', 'dc1-run'), { recursive: true });
    await fs.mkdir(path.join(root, 'board-pictures'), { recursive: true });

    await fs.writeFile(path.join(root, 'design', 'README.md'), '# Design\n\nPlans, packets, mocks and the look.');
    await fs.writeFile(path.join(root, 'design', 'plans', 'roadmap.md'), '# Roadmap <!-- plan:1 -->\n\nDeliver documents page first.');
    await fs.writeFile(path.join(root, 'design', 'plans', 'mock.html'), '<title>Folder Mock</title><p>Interactive preview.</p>');
    await fs.writeFile(path.join(root, 'board-pictures', 'shot.png'), 'png');
    await fs.writeFile(path.join(root, 'notes.txt'), 'Quick meeting takeaway');
    await fs.writeFile(path.join(root, 'spec.pdf'), '%PDF-1.7');

    // Evidence files that MUST NOT be read
    await fs.writeFile(path.join(root, 'design', 'evidence', 'dc1-run', 'report.md'), '# SECRET EVIDENCE SHOULD NOT BE READ');
    await fs.writeFile(path.join(root, 'design', 'evidence', 'dc1-run', 'README.md'), '# Evidence readme\n\nShould not be read');
    await fs.writeFile(path.join(root, 'design', 'dc1-before.log'), 'LOG LINE SHOULD NOT BE READ');
    await fs.writeFile(path.join(root, 'frozen-tree.txt'), 'TREE HASH SHOULD NOT BE READ');
    await fs.writeFile(path.join(root, 'dc1-source-hashes.txt'), 'HASHES SHOULD NOT BE READ');

    // Set deterministic modified times so recent ordering is unambiguous
    const now = Date.now();
    const touch = async (rel: string, secondsAgo: number) => {
      const time = new Date(now - secondsAgo * 1000);
      await fs.utimes(path.join(root, rel), time, time);
    };
    await touch('design/evidence/dc1-run/report.md', 1); // newest on disk, but evidence!
    await touch('board-pictures/shot.png', 2); // image, excluded from recent
    await touch('design/plans/roadmap.md', 5);
    await touch('design/plans/mock.html', 10);
    await touch('spec.pdf', 15);
    await touch('notes.txt', 20);
    await touch('design/README.md', 25);

    const readSpy = vi.spyOn(fsSafety, 'readFileHandleAtMost');
    const catalog = await buildDocumentCatalog(root);

    // Evidence files were never read
    const evidenceItem = catalog.items.find((i) => i.path === 'design/evidence/dc1-run/report.md');
    expect(evidenceItem).toMatchObject({
      evidence: true,
      title: 'Report',
      excerpt: '',
    });
    expect(catalog.items.find((i) => i.path === 'design/dc1-before.log')?.evidence).toBe(true);
    expect(catalog.items.find((i) => i.path === 'frozen-tree.txt')?.evidence).toBe(true);
    expect(catalog.items.find((i) => i.path === 'dc1-source-hashes.txt')?.evidence).toBe(true);
    // 4 non-evidence text/md/html files read: design/README.md, roadmap.md, mock.html, notes.txt
    expect(readSpy).toHaveBeenCalledTimes(4);

    // Folder summaries and recursive counts
    const designFolder = catalog.folders.find((f) => f.path === 'design');
    expect(designFolder).toMatchObject({
      path: 'design',
      name: 'design',
      parent: '',
      evidence: false,
      summary: 'Plans, packets, mocks and the look.',
      folderCount: 1, // design/plans (non-evidence)
      docCount: 3, // design/README.md + roadmap.md + mock.html
      pictureCount: 0,
      evidenceCount: 3, // dc1-before.log + evidence/dc1-run/report.md + evidence/dc1-run/README.md
    });

    const evidenceFolder = catalog.folders.find((f) => f.path === 'design/evidence');
    expect(evidenceFolder).toMatchObject({
      evidence: true,
      summary: '',
      docCount: 0,
      evidenceCount: 2,
    });

    // Recent order: newest non-evidence markdown/text/html/pdf, excluding images and evidence
    expect(catalog.recent).toEqual([
      'design/plans/roadmap.md',
      'design/plans/mock.html',
      'spec.pdf',
      'notes.txt',
      'design/README.md',
    ]);
  });

  it('reuses cached metadata and invalidates on size or mtime change', async () => {
    await fs.writeFile(path.join(root, 'guide.md'), '# First Title\n\nFirst excerpt.');
    const readSpy = vi.spyOn(fsSafety, 'readFileHandleAtMost');

    const first = await buildDocumentCatalog(root);
    expect(first.items.find((i) => i.path === 'guide.md')).toMatchObject({
      title: 'First Title',
      excerpt: 'First excerpt.',
    });
    expect(readSpy).toHaveBeenCalledTimes(1);

    // Unchanged file hits cache
    const second = await buildDocumentCatalog(root);
    expect(second.items.find((i) => i.path === 'guide.md')?.title).toBe('First Title');
    expect(readSpy).toHaveBeenCalledTimes(1);

    // Update content & advance mtime
    const future = new Date(Date.now() + 5000);
    await fs.writeFile(path.join(root, 'guide.md'), '# Updated Title\n\nUpdated excerpt.');
    await fs.utimes(path.join(root, 'guide.md'), future, future);

    const third = await buildDocumentCatalog(root);
    expect(third.items.find((i) => i.path === 'guide.md')).toMatchObject({
      title: 'Updated Title',
      excerpt: 'Updated excerpt.',
    });
    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it('serves GET /api/workspace/:id/documents/catalog without altering GET /documents', async () => {
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'test', branchName: 'test', description: 'Test', repos: [], assistants: [] }));
    await fs.writeFile(path.join(root, 'PLAN.md'), '# Plan\n\nStep one.');
    const app = new Hono();
    registerWorkGuidanceRoutes(app, async (id) => (id === 'test' ? root : null));

    const catalogRes = await app.request('/api/workspace/test/documents/catalog');
    expect(catalogRes.status).toBe(200);
    const catalogJson = await catalogRes.json();
    expect(catalogJson.items[0]).toMatchObject({ path: 'PLAN.md', title: 'Plan', excerpt: 'Step one.' });
    expect(catalogJson.recent).toEqual(['PLAN.md']);

    const legacyRes = await app.request('/api/workspace/test/documents');
    expect(legacyRes.status).toBe(200);
    const legacyJson = await legacyRes.json();
    expect(legacyJson.documents.map((d: { name: string }) => d.name)).toEqual(['PLAN.md']);

    expect((await app.request('/api/workspace/missing/documents/catalog')).status).toBe(404);
  });

  it('caps head reads at the 300 newest non-evidence text documents', async () => {
    const baseTime = Date.now() - 1000 * 1000;
    await fs.mkdir(path.join(root, 'bulk'), { recursive: true });
    for (let i = 0; i < 305; i++) {
      const name = `doc-${String(i).padStart(3, '0')}.md`;
      const file = path.join(root, 'bulk', name);
      await fs.writeFile(file, `# Heading ${i}\n\nExcerpt ${i}`);
      const mtime = new Date(baseTime + i * 1000);
      await fs.utimes(file, mtime, mtime);
    }

    const readSpy = vi.spyOn(fsSafety, 'readFileHandleAtMost');
    const catalog = await buildDocumentCatalog(root);

    expect(readSpy).toHaveBeenCalledTimes(300);
    // Newest 300 (doc-005..doc-304) have extracted headings; oldest 5 (doc-000..doc-004) fall back cleanly
    expect(catalog.items.find((item) => item.path === 'bulk/doc-304.md')).toMatchObject({
      title: 'Heading 304',
      excerpt: 'Excerpt 304',
    });
    expect(catalog.items.find((item) => item.path === 'bulk/doc-000.md')).toMatchObject({
      title: 'Doc 000',
      excerpt: '',
    });
  });

  it('omits empty folders and folds folders that contain only evidence artifacts', async () => {
    await fs.mkdir(path.join(root, 'empty-dir'), { recursive: true });
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(root, 'scripts', 'helper.sh'), '#!/bin/sh\necho ok');
    await fs.mkdir(path.join(root, 'docs', 'empty-sub'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs', 'logs'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs', 'logs', 'run.log'), 'log line');
    await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n\nUseful doc.');

    const catalog = await buildDocumentCatalog(root);
    const folderPaths = catalog.folders.map((f) => f.path);

    expect(folderPaths).not.toContain('empty-dir');
    expect(folderPaths).not.toContain('scripts');
    expect(folderPaths).not.toContain('docs/empty-sub');
    expect(catalog.folders.find((f) => f.path === 'docs/logs')).toMatchObject({
      evidence: true,
      evidenceCount: 1,
      docCount: 0,
    });
    expect(catalog.folders.find((f) => f.path === 'docs')).toMatchObject({
      folderCount: 0,
      docCount: 1,
      evidenceCount: 1,
    });
  });
});
