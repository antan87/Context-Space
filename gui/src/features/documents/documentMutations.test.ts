import { describe, expect, it, vi, afterEach } from 'vitest';
import { ApiError } from '../../lib/api/client.js';
import {
  clearDocumentDraftStore,
  DocumentConflictError,
  getWorkspaceDocumentDrafts,
  isManagedReadOnlyItem,
  parseDocumentConflict,
  resolveNewDocumentPath,
  resolveNewFolderPath,
  saveDocument,
  setWorkspaceDocumentDrafts,
  suggestCopyPath,
  suggestNumberedPath,
  uploadDocument,
  validateUploadFile,
} from './documentMutations.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('documentMutations path helpers', () => {
  it('resolves new document paths and auto-appends .md when no extension is provided', () => {
    expect(resolveNewDocumentPath('', 'release-notes')).toEqual({
      ok: true,
      path: 'release-notes.md',
      folder: '',
      fileName: 'release-notes.md',
      autoAppendedMd: true,
    });
    expect(resolveNewDocumentPath('design/plans/', 'api-v2')).toEqual({
      ok: true,
      path: 'design/plans/api-v2.md',
      folder: 'design/plans',
      fileName: 'api-v2.md',
      autoAppendedMd: true,
    });
    expect(resolveNewDocumentPath('design', 'sub/page.html')).toEqual({
      ok: true,
      path: 'design/sub/page.html',
      folder: 'design/sub',
      fileName: 'page.html',
      autoAppendedMd: false,
    });
    expect(resolveNewDocumentPath('', 'spec.json')).toEqual({
      ok: true,
      path: 'spec.json',
      folder: '',
      fileName: 'spec.json',
      autoAppendedMd: false,
    });
    expect(resolveNewDocumentPath('.claude', 'notes')).toEqual({
      ok: true,
      path: '.claude/notes.md',
      folder: '.claude',
      fileName: 'notes.md',
      autoAppendedMd: true,
    });
  });

  it('rejects hidden, traversal, binary, unsupported, and guarded filenames', () => {
    expect(resolveNewDocumentPath('', '')).toMatchObject({ ok: false });
    expect(resolveNewDocumentPath('', 'folder/')).toMatchObject({ ok: false });
    expect(resolveNewDocumentPath('', '.env')).toMatchObject({ ok: false });
    expect(resolveNewDocumentPath('', '.md')).toMatchObject({ ok: false });
    expect(resolveNewDocumentPath('', '../escape.md')).toMatchObject({ ok: false });
    expect(resolveNewDocumentPath('.git', 'notes.md')).toMatchObject({ ok: false });
    expect(resolveNewDocumentPath('', 'C:/bad.md')).toMatchObject({ ok: false });
    expect(resolveNewDocumentPath('', 'tool.exe')).toMatchObject({ ok: false });
    expect(resolveNewDocumentPath('', 'shot.png')).toMatchObject({ ok: false });
    expect(resolveNewDocumentPath('', 'AGENTS.md')).toMatchObject({ ok: false });
    expect(resolveNewDocumentPath('', 'contextspace-plan.json')).toMatchObject({ ok: false });
    // Nested AGENTS.md inside a folder is normal documentation
    expect(resolveNewDocumentPath('docs', 'AGENTS.md')).toMatchObject({
      ok: true,
      path: 'docs/AGENTS.md',
    });
  });

  it('resolves new folder paths safely', () => {
    expect(resolveNewFolderPath('', 'design/drafts')).toEqual({ ok: true, folder: 'design/drafts' });
    expect(resolveNewFolderPath('design', '2026/q4')).toEqual({ ok: true, folder: 'design/2026/q4' });
    expect(resolveNewFolderPath('', '')).toMatchObject({ ok: false });
    expect(resolveNewFolderPath('', '../escape')).toMatchObject({ ok: false });
    expect(resolveNewFolderPath('', '.git')).toMatchObject({ ok: false });
    expect(resolveNewFolderPath('', 'node_modules')).toMatchObject({ ok: false });
  });

  it('suggests non-colliding copy and numbered paths', () => {
    expect(suggestCopyPath('notes.md')).toBe('notes-copy.md');
    expect(suggestCopyPath('design/notes.md')).toBe('design/notes-copy.md');
    expect(suggestCopyPath('design/v1.spec.md')).toBe('design/v1.spec-copy.md');
    expect(suggestCopyPath('notes.md', new Set(['notes-copy.md']))).toBe('notes-copy-2.md');
    expect(suggestCopyPath('notes.md', new Set(['notes-copy.md', 'notes-copy-2.md']))).toBe('notes-copy-3.md');

    expect(suggestNumberedPath('notes.md')).toBe('notes-2.md');
    expect(suggestNumberedPath('design/notes.md', new Set(['design/notes-2.md']))).toBe('design/notes-3.md');
    expect(suggestNumberedPath('README')).toBe('README-2');
  });

  it('validates upload files for extension, hidden names, and size limits', () => {
    expect(validateUploadFile({ name: 'notes.md', size: 100 })).toEqual({ ok: true, fileName: 'notes.md' });
    expect(validateUploadFile({ name: 'C:\\fakepath\\chart.png', size: 2048 })).toEqual({ ok: true, fileName: 'chart.png' });
    expect(validateUploadFile({ name: 'app.exe', size: 10 })).toMatchObject({ ok: false });
    expect(validateUploadFile({ name: '.env', size: 10 })).toMatchObject({ ok: false });
    expect(validateUploadFile({ name: 'huge.md', size: 1024 * 1024 + 1 })).toMatchObject({ ok: false });
    expect(validateUploadFile({ name: 'huge.pdf', size: 25 * 1024 * 1024 + 1 })).toMatchObject({ ok: false });
  });

  it('identifies managed read-only items without misclassifying binary files', () => {
    expect(isManagedReadOnlyItem({ path: 'AGENTS.md', kind: 'markdown', editable: false })).toBe(true);
    expect(isManagedReadOnlyItem({ path: 'PLAN.md', kind: 'markdown', editable: false })).toBe(true);
    expect(isManagedReadOnlyItem({ path: 'PLAN.md', kind: 'markdown', editable: true })).toBe(false);
    expect(isManagedReadOnlyItem({ path: 'shot.png', kind: 'image', editable: false })).toBe(false);
  });
});

describe('documentMutations conflict parsing & API helpers', () => {
  it('parses 409 CONFLICT and ALREADY_EXISTS responses into DocumentConflictError', async () => {
    const conflictBody = {
      error: '"notes.md" changed on disk while you were editing.',
      code: 'CONFLICT',
      currentRevision: 'a'.repeat(64),
      currentContent: '# From disk',
      currentModifiedAt: '2026-11-25T12:00:00.000Z',
    };
    const apiErr = new ApiError(conflictBody.error, 409, conflictBody);
    expect(parseDocumentConflict(apiErr)).toEqual({
      code: 'CONFLICT',
      currentRevision: 'a'.repeat(64),
      currentContent: '# From disk',
      currentModifiedAt: '2026-11-25T12:00:00.000Z',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(conflictBody), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      saveDocument('demo', { name: 'notes.md', content: '# Mine', expectedRevision: 'b'.repeat(64) }),
    ).rejects.toBeInstanceOf(DocumentConflictError);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Exists', code: 'ALREADY_EXISTS', currentRevision: null }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    await expect(uploadDocument('demo', { file, folder: 'design' })).rejects.toMatchObject({
      name: 'DocumentConflictError',
      code: 'ALREADY_EXISTS',
      currentRevision: null,
    });
  });

  it('persists unsaved side and reader drafts per workspace, clones snapshots, and clears cleanly', () => {
    clearDocumentDraftStore();
    expect(getWorkspaceDocumentDrafts('ws-a')).toBeNull();

    setWorkspaceDocumentDrafts('ws-a', {
      folder: 'design/plans',
      sideDraft: {
        path: 'design/plans/spec.md',
        folder: 'design/plans',
        content: '# Unsaved draft',
        baseContent: '# Original',
        baseRevision: 'rev-1',
        conflict: null,
        saveError: null,
        dirty: true,
      },
      readerPath: 'PLAN.md',
      readerDrafts: {
        'PLAN.md': {
          editing: true,
          dirty: true,
          draft: '# Reader draft',
          baseContent: '# Plan',
          baseRevision: 'rev-2',
        },
        'clean.md': {
          editing: false,
          dirty: false,
          draft: 'clean',
          baseContent: 'clean',
        },
      },
    });

    // Scoped strictly to ws-a
    expect(getWorkspaceDocumentDrafts('ws-b')).toBeNull();
    const restored = getWorkspaceDocumentDrafts('ws-a');
    expect(restored).toEqual({
      folder: 'design/plans',
      sideDraft: {
        path: 'design/plans/spec.md',
        folder: 'design/plans',
        content: '# Unsaved draft',
        baseContent: '# Original',
        baseRevision: 'rev-1',
        conflict: null,
        saveError: null,
        dirty: true,
      },
      readerPath: 'PLAN.md',
      readerDrafts: {
        'PLAN.md': {
          editing: true,
          dirty: true,
          draft: '# Reader draft',
          baseContent: '# Plan',
          baseRevision: 'rev-2',
        },
      },
    });

    // Empty update deletes entry
    setWorkspaceDocumentDrafts('ws-a', {
      folder: 'design/plans',
      sideDraft: null,
      readerPath: 'PLAN.md',
      readerDrafts: {},
    });
    expect(getWorkspaceDocumentDrafts('ws-a')).toBeNull();

    setWorkspaceDocumentDrafts('ws-b', {
      folder: '',
      sideDraft: {
        path: 'README.md',
        folder: '',
        content: '# B',
        baseContent: '# B0',
        conflict: null,
        saveError: null,
        dirty: true,
      },
      readerPath: null,
      readerDrafts: {},
    });
    clearDocumentDraftStore('ws-a');
    expect(getWorkspaceDocumentDrafts('ws-b')).not.toBeNull();
    clearDocumentDraftStore();
    expect(getWorkspaceDocumentDrafts('ws-b')).toBeNull();
  });
});
