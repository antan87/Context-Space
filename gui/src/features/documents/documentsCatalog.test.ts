import { describe, expect, it } from 'vitest';
import {
  buildBreadcrumbs,
  changedLatelyItems,
  childFolders,
  cleanDocumentCatalog,
  computeRecursiveFolderCounts,
  directEvidenceSummary,
  folderItems,
  formatFolderCounts,
  searchCatalog,
  type DocumentCatalog,
} from './documentsCatalog.js';

const CATALOG: DocumentCatalog = {
  items: [
    {
      path: 'PLAN.md',
      name: 'PLAN.md',
      folder: '',
      kind: 'markdown',
      size: 400,
      modifiedAt: '2026-11-25T10:00:00.000Z',
      title: 'New canvas interaction',
      excerpt: 'One board where people and AIs collaborate.',
      evidence: false,
      editable: true,
    },
    {
      path: 'design/plans/workspace-db.md',
      name: 'workspace-db.md',
      folder: 'design/plans',
      kind: 'markdown',
      size: 620,
      modifiedAt: '2026-11-25T09:00:00.000Z',
      title: 'The workspace database',
      excerpt: 'Board data moves to SQLite.',
      evidence: false,
      editable: true,
    },
    {
      path: 'design/mocks/documents.html',
      name: 'documents.html',
      folder: 'design/mocks',
      kind: 'html',
      size: 1200,
      modifiedAt: '2026-11-25T08:00:00.000Z',
      title: 'Documents by folder',
      excerpt: 'Folders first, evidence folded.',
      evidence: false,
      editable: true,
    },
    {
      path: 'board-pictures/root.png',
      name: 'root.png',
      folder: 'board-pictures',
      kind: 'image',
      size: 4096,
      modifiedAt: '2026-11-25T10:30:00.000Z',
      title: 'Root',
      excerpt: '',
      evidence: false,
      editable: false,
    },
    {
      path: 'design/dc1-before.log',
      name: 'dc1-before.log',
      folder: 'design',
      kind: 'text',
      size: 300,
      modifiedAt: '2026-11-25T10:15:00.000Z',
      title: 'Dc1 before',
      excerpt: '',
      evidence: true,
      editable: true,
    },
    {
      path: 'design/evidence/dc1-2026-11-25/report.md',
      name: 'report.md',
      folder: 'design/evidence/dc1-2026-11-25',
      kind: 'markdown',
      size: 900,
      modifiedAt: '2026-11-25T10:20:00.000Z',
      title: 'Report',
      excerpt: '',
      evidence: true,
      editable: true,
    },
  ],
  folders: [
    { path: 'board-pictures', name: 'board-pictures', parent: '', evidence: false, summary: 'Screenshots', folderCount: 0, docCount: 0, pictureCount: 1, evidenceCount: 0 },
    { path: 'design', name: 'design', parent: '', evidence: false, summary: 'Plans and mocks', folderCount: 2, docCount: 2, pictureCount: 0, evidenceCount: 2 },
    { path: 'design/plans', name: 'plans', parent: 'design', evidence: false, summary: '', folderCount: 0, docCount: 1, pictureCount: 0, evidenceCount: 0 },
    { path: 'design/mocks', name: 'mocks', parent: 'design', evidence: false, summary: '', folderCount: 0, docCount: 1, pictureCount: 0, evidenceCount: 0 },
    { path: 'design/evidence', name: 'evidence', parent: 'design', evidence: true, summary: '', folderCount: 0, docCount: 0, pictureCount: 0, evidenceCount: 1 },
    { path: 'design/evidence/dc1-2026-11-25', name: 'dc1-2026-11-25', parent: 'design/evidence', evidence: true, summary: '', folderCount: 0, docCount: 0, pictureCount: 0, evidenceCount: 1 },
  ],
  recent: ['PLAN.md', 'design/plans/workspace-db.md', 'design/mocks/documents.html'],
};

describe('documentsCatalog helpers', () => {
  it('builds breadcrumbs cleanly for root and nested folders', () => {
    expect(buildBreadcrumbs('')).toEqual([{ path: '', label: 'All folders' }]);
    expect(buildBreadcrumbs('/design/plans/')).toEqual([
      { path: '', label: 'All folders' },
      { path: 'design', label: 'design' },
      { path: 'design/plans', label: 'plans' },
    ]);
  });

  it('lists direct folder children with evidence folded unless toggled or inside evidence', () => {
    expect(childFolders(CATALOG, '').map((f) => f.path)).toEqual(['board-pictures', 'design']);
    expect(childFolders(CATALOG, 'design').map((f) => f.path)).toEqual(['design/mocks', 'design/plans']);
    expect(childFolders(CATALOG, 'design', { includeEvidence: true }).map((f) => f.path)).toEqual([
      'design/evidence',
      'design/mocks',
      'design/plans',
    ]);
    // Inside an evidence folder, its children remain visible without needing a second toggle
    expect(childFolders(CATALOG, 'design/evidence').map((f) => f.path)).toEqual([
      'design/evidence/dc1-2026-11-25',
    ]);
  });

  it('computes recursive folder counts excluding evidence from doc counts and formatting non-zero counts', () => {
    expect(computeRecursiveFolderCounts(CATALOG.items, CATALOG.folders, 'design')).toEqual({
      folderCount: 2,
      docCount: 2,
      pictureCount: 0,
      evidenceCount: 2,
    });
    expect(formatFolderCounts({ folderCount: 2, docCount: 2, pictureCount: 0, evidenceCount: 2 })).toBe(
      '2 folders · 2 documents',
    );
    expect(formatFolderCounts({ folderCount: 0, docCount: 1, pictureCount: 1, evidenceCount: 0 })).toBe(
      '1 document · 1 picture',
    );
    expect(formatFolderCounts({ folderCount: 0, docCount: 0, pictureCount: 0, evidenceCount: 848 }, { evidence: true })).toBe(
      '848 files',
    );
  });

  it('folds direct evidence folders and files per folder without double counting', () => {
    const rootEvidence = directEvidenceSummary(CATALOG, '');
    expect(rootEvidence.totalCount).toBe(0);

    const designEvidence = directEvidenceSummary(CATALOG, 'design');
    expect(designEvidence.totalCount).toBe(2);
    expect(designEvidence.folders.map((f) => f.path)).toEqual(['design/evidence']);
    expect(designEvidence.files.map((f) => f.path)).toEqual(['design/dc1-before.log']);

    // Inside design/, evidence file is hidden when folded and shown when toggled on
    expect(folderItems(CATALOG, 'design').documents).toEqual([]);
    expect(folderItems(CATALOG, 'design', { includeEvidence: true }).documents.map((d) => d.path)).toEqual([
      'design/dc1-before.log',
    ]);
  });

  it('searches across folders by title, excerpt, and path while respecting evidence toggle', () => {
    expect(searchCatalog(CATALOG, 'SQLite').map((i) => i.path)).toEqual(['design/plans/workspace-db.md']);
    expect(searchCatalog(CATALOG, 'documents.html').map((i) => i.path)).toEqual(['design/mocks/documents.html']);
    expect(searchCatalog(CATALOG, 'workspace db').map((i) => i.path)).toEqual(['design/plans/workspace-db.md']);
    expect(searchCatalog(CATALOG, 'dc1-before')).toEqual([]);
    expect(searchCatalog(CATALOG, 'dc1-before', { includeEvidence: true }).map((i) => i.path)).toEqual([
      'design/dc1-before.log',
    ]);
  });

  it('resolves up to 4 recent non-evidence documents for Changed lately', () => {
    expect(changedLatelyItems(CATALOG, 4).map((i) => i.path)).toEqual([
      'PLAN.md',
      'design/plans/workspace-db.md',
      'design/mocks/documents.html',
    ]);
  });

  it('cleans editable and readOnlyReason fields cleanly', () => {
    const cleaned = cleanDocumentCatalog({
      items: [
        { path: 'AGENTS.md', kind: 'markdown', size: 100, modifiedAt: '' },
        { path: 'PLAN.md', kind: 'markdown', size: 100, modifiedAt: '', editable: false, readOnlyReason: 'Managed on the Board database — edit steps on the Board.' },
        { path: 'notes.md', kind: 'markdown', size: 100, modifiedAt: '' },
        { path: 'shot.png', kind: 'image', size: 100, modifiedAt: '' },
      ],
      folders: [],
      recent: [],
    });
    expect(cleaned.items[0]).toMatchObject({ path: 'AGENTS.md', editable: false, readOnlyReason: 'Generated by ContextSpace — refreshed automatically.' });
    expect(cleaned.items[1]).toMatchObject({ path: 'PLAN.md', editable: false, readOnlyReason: 'Managed on the Board database — edit steps on the Board.' });
    expect(cleaned.items[2]).toMatchObject({ path: 'notes.md', editable: true });
    expect(cleaned.items[3]).toMatchObject({ path: 'shot.png', editable: false });
  });
});
