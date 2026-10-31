import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  viewMimeType,
  ViewTokenStore,
  issueWorkspaceViewLink,
  parseViewRequestPath,
  isSegmentsAllowedInScope,
  openScopedViewFile,
  computeFileEtag,
  matchesIfNoneMatch,
  parseSingleByteRange,
  createFileByteStream,
  ViewLinkInputError,
  ViewNotFoundError,
} from './workspace-file-stream.js';
import * as fsSafety from '../resources/fs-safety.js';

describe('workspace-file-stream', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'view-stream-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('viewMimeType allowlist', () => {
    it('allows valid document, media, and web extensions', () => {
      expect(viewMimeType('index.html')).toBe('text/html; charset=utf-8');
      expect(viewMimeType('INDEX.HTML')).toBe('text/html; charset=utf-8');
      expect(viewMimeType('page.htm')).toBe('text/html; charset=utf-8');
      expect(viewMimeType('styles.css')).toBe('text/css; charset=utf-8');
      expect(viewMimeType('app.js')).toBe('text/javascript; charset=utf-8');
      expect(viewMimeType('module.mjs')).toBe('text/javascript; charset=utf-8');
      expect(viewMimeType('data.json')).toBe('application/json; charset=utf-8');
      expect(viewMimeType('calc.wasm')).toBe('application/wasm');
      expect(viewMimeType('icon.svg')).toBe('image/svg+xml');
      expect(viewMimeType('pic.png')).toBe('image/png');
      expect(viewMimeType('photo.jpg')).toBe('image/jpeg');
      expect(viewMimeType('photo.jpeg')).toBe('image/jpeg');
      expect(viewMimeType('anim.gif')).toBe('image/gif');
      expect(viewMimeType('pic.webp')).toBe('image/webp');
      expect(viewMimeType('pic.avif')).toBe('image/avif');
      expect(viewMimeType('favicon.ico')).toBe('image/x-icon');
      expect(viewMimeType('font.woff2')).toBe('font/woff2');
      expect(viewMimeType('font.woff')).toBe('font/woff');
      expect(viewMimeType('font.ttf')).toBe('font/ttf');
      expect(viewMimeType('font.otf')).toBe('font/otf');
      expect(viewMimeType('doc.pdf')).toBe('application/pdf');
      expect(viewMimeType('video.mp4')).toBe('video/mp4');
      expect(viewMimeType('video.webm')).toBe('video/webm');
      expect(viewMimeType('audio.mp3')).toBe('audio/mpeg');
      expect(viewMimeType('audio.wav')).toBe('audio/wav');
      expect(viewMimeType('audio.ogg')).toBe('audio/ogg');
      expect(viewMimeType('notes.txt')).toBe('text/plain; charset=utf-8');
      expect(viewMimeType('README.md')).toBe('text/plain; charset=utf-8');
      expect(viewMimeType('spec.markdown')).toBe('text/plain; charset=utf-8');
      expect(viewMimeType('table.csv')).toBe('text/plain; charset=utf-8');
    });

    it('returns null for disallowed extensions and extensionless files', () => {
      expect(viewMimeType('.env')).toBeNull();
      expect(viewMimeType('secrets.env')).toBeNull();
      expect(viewMimeType('script.ts')).toBeNull();
      expect(viewMimeType('script.py')).toBeNull();
      expect(viewMimeType('run.sh')).toBeNull();
      expect(viewMimeType('program.exe')).toBeNull();
      expect(viewMimeType('config.yml')).toBeNull();
      expect(viewMimeType('config.yaml')).toBeNull();
      expect(viewMimeType('config.toml')).toBeNull();
      expect(viewMimeType('package-lock.json.lock')).toBeNull();
      expect(viewMimeType('word.docx')).toBeNull();
      expect(viewMimeType('Makefile')).toBeNull();
      expect(viewMimeType('config')).toBeNull();
    });
  });

  describe('ViewTokenStore', () => {
    it('issues 256-bit base64url tokens and retrieves them within TTL', () => {
      const store = new ViewTokenStore({ maxTokens: 10, ttlMs: 10_000 });
      const token = store.issue({
        workspaceId: 'ws-1',
        workspaceRoot: '/tmp/ws-1',
        scopeFolder: 'design',
        excludedFolders: [],
      });
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const entry = store.get(token);
      expect(entry).not.toBeNull();
      expect(entry?.workspaceId).toBe('ws-1');
      expect(entry?.scopeFolder).toBe('design');
    });

    it('expires tokens after ttlMs', () => {
      const store = new ViewTokenStore({ maxTokens: 10, ttlMs: 50 });
      const token = store.issue({
        workspaceId: 'ws-1',
        workspaceRoot: '/tmp/ws-1',
        scopeFolder: '',
        excludedFolders: [],
      });
      expect(store.get(token)).not.toBeNull();

      // Fast forward creation time to simulate expiry
      const entry = (store as any).tokens.get(token);
      entry.createdAt = Date.now() - 100;
      expect(store.get(token)).toBeNull();
      expect(store.size()).toBe(0);
    });

    it('evicts oldest tokens on bounded capacity overflow', () => {
      const store = new ViewTokenStore({ maxTokens: 3, ttlMs: 60_000 });
      const t1 = store.issue({ workspaceId: 'ws-1', workspaceRoot: '/1', scopeFolder: '', excludedFolders: [] });
      const t2 = store.issue({ workspaceId: 'ws-2', workspaceRoot: '/2', scopeFolder: '', excludedFolders: [] });
      const t3 = store.issue({ workspaceId: 'ws-3', workspaceRoot: '/3', scopeFolder: '', excludedFolders: [] });

      expect(store.size()).toBe(3);
      expect(store.get(t1)).not.toBeNull();

      // 4th token evicts t1
      const t4 = store.issue({ workspaceId: 'ws-4', workspaceRoot: '/4', scopeFolder: '', excludedFolders: [] });
      expect(store.size()).toBe(3);
      expect(store.get(t1)).toBeNull();
      expect(store.get(t2)).not.toBeNull();
      expect(store.get(t3)).not.toBeNull();
      expect(store.get(t4)).not.toBeNull();
    });

    it('supports delete and clear', () => {
      const store = new ViewTokenStore();
      const t1 = store.issue({ workspaceId: 'ws', workspaceRoot: '/', scopeFolder: '', excludedFolders: [] });
      store.delete(t1);
      expect(store.get(t1)).toBeNull();
      const t2 = store.issue({ workspaceId: 'ws', workspaceRoot: '/', scopeFolder: '', excludedFolders: [] });
      store.clear();
      expect(store.get(t2)).toBeNull();
      expect(store.size()).toBe(0);
    });
  });

  describe('issueWorkspaceViewLink', () => {
    it('issues a link for a valid root file', async () => {
      await fs.writeFile(path.join(tmpDir, 'index.html'), '<h1>Hello</h1>');
      const store = new ViewTokenStore();
      const result = await issueWorkspaceViewLink({
        workspaceId: 'ws-test',
        workspaceRoot: tmpDir,
        name: 'index.html',
        store,
      });

      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.url).toBe(`/view/${result.token}/index.html`);
      expect(result.scope).toBe('.');
      const entry = store.get(result.token);
      expect(entry?.scopeFolder).toBe('');
    });

    it('issues a link for a folder-scoped file', async () => {
      await fs.mkdir(path.join(tmpDir, 'design'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'design', 'plan.html'), '<p>Plan</p>');
      const store = new ViewTokenStore();
      const result = await issueWorkspaceViewLink({
        workspaceId: 'ws-test',
        workspaceRoot: tmpDir,
        name: 'design/plan.html',
        store,
      });

      expect(result.url).toBe(`/view/${result.token}/design/plan.html`);
      expect(result.scope).toBe('design');
      const entry = store.get(result.token);
      expect(entry?.scopeFolder).toBe('design');
    });

    it('permits open hidden folders (.claude, .agents, .github) at index 0', async () => {
      await fs.mkdir(path.join(tmpDir, '.claude', 'docs'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, '.claude', 'docs', 'readme.md'), '# Claude docs');
      const result = await issueWorkspaceViewLink({
        workspaceId: 'ws-test',
        workspaceRoot: tmpDir,
        name: '.claude/docs/readme.md',
      });
      expect(result.scope).toBe('.claude');
    });

    it('rejects invalid names, disallowed hidden files, and unsupported extensions', async () => {
      await fs.writeFile(path.join(tmpDir, 'script.ts'), 'console.log()');
      await fs.writeFile(path.join(tmpDir, '.env'), 'SECRET=1');
      await fs.mkdir(path.join(tmpDir, '.git'));
      await fs.writeFile(path.join(tmpDir, '.git', 'config.html'), 'fake');

      await expect(issueWorkspaceViewLink({ workspaceId: 'ws', workspaceRoot: tmpDir, name: '' }))
        .rejects.toThrow(ViewLinkInputError);
      await expect(issueWorkspaceViewLink({ workspaceId: 'ws', workspaceRoot: tmpDir, name: '/index.html' }))
        .rejects.toThrow(ViewLinkInputError);
      await expect(issueWorkspaceViewLink({ workspaceId: 'ws', workspaceRoot: tmpDir, name: 'folder\\index.html' }))
        .rejects.toThrow(ViewLinkInputError);
      await expect(issueWorkspaceViewLink({ workspaceId: 'ws', workspaceRoot: tmpDir, name: 'index.html:stream' }))
        .rejects.toThrow(ViewLinkInputError);
      await expect(issueWorkspaceViewLink({ workspaceId: 'ws', workspaceRoot: tmpDir, name: 'script.ts' }))
        .rejects.toThrow(ViewLinkInputError);
      await expect(issueWorkspaceViewLink({ workspaceId: 'ws', workspaceRoot: tmpDir, name: '.env' }))
        .rejects.toThrow(ViewLinkInputError);
      await expect(issueWorkspaceViewLink({ workspaceId: 'ws', workspaceRoot: tmpDir, name: '.git/config.html' }))
        .rejects.toThrow(ViewLinkInputError);
    });

    it('rejects missing files and symlinks with ViewNotFoundError', async () => {
      await expect(issueWorkspaceViewLink({ workspaceId: 'ws', workspaceRoot: tmpDir, name: 'missing.html' }))
        .rejects.toThrow(ViewNotFoundError);

      // Symlink rejection
      await fs.writeFile(path.join(tmpDir, 'target.html'), 'target');
      await fs.symlink(path.join(tmpDir, 'target.html'), path.join(tmpDir, 'linked.html'));
      await expect(issueWorkspaceViewLink({ workspaceId: 'ws', workspaceRoot: tmpDir, name: 'linked.html' }))
        .rejects.toThrow(ViewNotFoundError);
    });

    it('excludes configured repo checkouts when issuing a root-scoped token', async () => {
      await fs.writeFile(path.join(tmpDir, 'contextspace.json'), JSON.stringify({
        id: 'ws-test',
        branchName: 'main',
        description: 'Test',
        repos: ['repoA'],
        assistants: [],
      }));
      await fs.mkdir(path.join(tmpDir, 'repoA'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'repoA', 'page.html'), 'inside repo');

      await expect(issueWorkspaceViewLink({
        workspaceId: 'ws-test',
        workspaceRoot: tmpDir,
        name: 'repoA/page.html',
      })).rejects.toThrow(ViewLinkInputError);
    });
  });

  describe('parseViewRequestPath', () => {
    const validToken = 'A'.repeat(43);

    it('parses valid paths with token and segments', () => {
      expect(parseViewRequestPath(`/view/${validToken}/index.html`)).toEqual({
        token: validToken,
        segments: ['index.html'],
      });
      expect(parseViewRequestPath(`/view/${validToken}/design/plan.html`)).toEqual({
        token: validToken,
        segments: ['design', 'plan.html'],
      });
      expect(parseViewRequestPath(`/view/${validToken}/sub%20folder/file%201.html`)).toEqual({
        token: validToken,
        segments: ['sub folder', 'file 1.html'],
      });
      // Strips query string and hash
      expect(parseViewRequestPath(`/view/${validToken}/index.html?v=1#sec`)).toEqual({
        token: validToken,
        segments: ['index.html'],
      });
    });

    it('rejects traversal, backslash, encoded slashes, encoded NUL, and malformed paths', () => {
      // Missing prefix
      expect(parseViewRequestPath('/other')).toBeNull();
      expect(parseViewRequestPath('/view')).toBeNull();
      expect(parseViewRequestPath('/view/')).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}`)).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}/`)).toBeNull();

      // Invalid tokens
      expect(parseViewRequestPath('/view/short/file.html')).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}!/file.html`)).toBeNull();

      // Backslash and encoded slashes/NUL
      expect(parseViewRequestPath(`/view/${validToken}/sub\\file.html`)).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}/sub%2ffile.html`)).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}/sub%2Ffile.html`)).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}/sub%5cfile.html`)).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}/sub%5Cfile.html`)).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}/sub%00file.html`)).toBeNull();

      // Dots and traversal
      expect(parseViewRequestPath(`/view/${validToken}/.`)).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}/..`)).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}/%2e`)).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}/%2e%2e`)).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}/foo/../bar.html`)).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}/foo/%2e%2e/bar.html`)).toBeNull();

      // Colons and control chars
      expect(parseViewRequestPath(`/view/${validToken}/doc.md:stream`)).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}/bad%0afile.html`)).toBeNull();
      expect(parseViewRequestPath(`/view/${validToken}/bad%7ffile.html`)).toBeNull();

      // Empty segments
      expect(parseViewRequestPath(`/view/${validToken}/foo//bar.html`)).toBeNull();
    });
  });

  describe('isSegmentsAllowedInScope', () => {
    it('enforces top-level folder scope', () => {
      const entry: any = {
        scopeFolder: 'design',
        excludedFolders: [],
      };

      expect(isSegmentsAllowedInScope(['design', 'plan.html'], entry)).toBe(true);
      expect(isSegmentsAllowedInScope(['design', 'sub', 'img.png'], entry)).toBe(true);
      expect(isSegmentsAllowedInScope(['other', 'plan.html'], entry)).toBe(false);
      expect(isSegmentsAllowedInScope(['index.html'], entry)).toBe(false);
      expect(isSegmentsAllowedInScope(['design', '.git', 'config'], entry)).toBe(false);
      expect(isSegmentsAllowedInScope(['design'], entry)).toBe(false);
    });

    it('enforces open hidden folder scope (.claude, .agents, .github)', () => {
      const claudeEntry: any = {
        scopeFolder: '.claude',
        excludedFolders: [],
      };
      expect(isSegmentsAllowedInScope(['.claude', 'notes.md'], claudeEntry)).toBe(true);
      expect(isSegmentsAllowedInScope(['.claude', 'sub', 'test.html'], claudeEntry)).toBe(true);
      expect(isSegmentsAllowedInScope(['.claude', '.secret', 'test.html'], claudeEntry)).toBe(false);
      expect(isSegmentsAllowedInScope(['.agents', 'agent.md'], claudeEntry)).toBe(false);
      expect(isSegmentsAllowedInScope(['.claude'], claudeEntry)).toBe(false);
    });

    it('enforces root scope minus excluded repo folders and hidden files', () => {
      const rootEntry: any = {
        scopeFolder: '',
        excludedFolders: ['repoA', 'packages/core'],
      };

      expect(isSegmentsAllowedInScope(['index.html'], rootEntry)).toBe(true);
      expect(isSegmentsAllowedInScope(['assets', 'style.css'], rootEntry)).toBe(true);

      // Hidden segments rejected
      expect(isSegmentsAllowedInScope(['.env'], rootEntry)).toBe(false);
      expect(isSegmentsAllowedInScope(['.git', 'config'], rootEntry)).toBe(false);
      expect(isSegmentsAllowedInScope(['.claude', 'settings.json'], rootEntry)).toBe(false);
      expect(isSegmentsAllowedInScope(['docs', '.private.md'], rootEntry)).toBe(false);

      // Excluded repository checkouts rejected
      expect(isSegmentsAllowedInScope(['repoA'], rootEntry)).toBe(false);
      expect(isSegmentsAllowedInScope(['repoA', 'index.html'], rootEntry)).toBe(false);
      expect(isSegmentsAllowedInScope(['packages', 'core', 'index.html'], rootEntry)).toBe(false);
      expect(isSegmentsAllowedInScope(['packages', 'other', 'index.html'], rootEntry)).toBe(true);
    });
  });

  describe('ETag and Range parsing', () => {
    it('computes strong ETag and matches If-None-Match', () => {
      const etag = computeFileEtag(1024, 5000000n);
      expect(etag).toBe('"400-4c4b40"');

      expect(matchesIfNoneMatch(etag, etag)).toBe(true);
      expect(matchesIfNoneMatch(`W/${etag}`, etag)).toBe(true);
      expect(matchesIfNoneMatch('*', etag)).toBe(true);
      expect(matchesIfNoneMatch('"other", "400-4c4b40"', etag)).toBe(true);
      expect(matchesIfNoneMatch('"nomatch"', etag)).toBe(false);
      expect(matchesIfNoneMatch(undefined, etag)).toBe(false);
    });

    it('parses valid single byte ranges', () => {
      expect(parseSingleByteRange('bytes=0-49', 100)).toEqual({ kind: 'ok', start: 0, end: 49 });
      expect(parseSingleByteRange('bytes=50-', 100)).toEqual({ kind: 'ok', start: 50, end: 99 });
      expect(parseSingleByteRange('bytes=-20', 100)).toEqual({ kind: 'ok', start: 80, end: 99 });
      expect(parseSingleByteRange('bytes=-200', 100)).toEqual({ kind: 'ok', start: 0, end: 99 });
      expect(parseSingleByteRange('bytes=0-999', 100)).toEqual({ kind: 'ok', start: 0, end: 99 });
    });

    it('rejects invalid or unsatisfiable byte ranges', () => {
      expect(parseSingleByteRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
      expect(parseSingleByteRange('bytes=50-10', 100)).toEqual({ kind: 'unsatisfiable' });
      expect(parseSingleByteRange('bytes=-', 100)).toEqual({ kind: 'unsatisfiable' });
      expect(parseSingleByteRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
      expect(parseSingleByteRange('bytes=0-1,4-5', 100)).toEqual({ kind: 'unsatisfiable' });
      expect(parseSingleByteRange('items=0-5', 100)).toEqual({ kind: 'unsatisfiable' });
      expect(parseSingleByteRange('bytes=0-10', 0)).toEqual({ kind: 'unsatisfiable' });
    });
  });

  describe('createFileByteStream', () => {
    it('streams accurate byte chunks and closes handle on EOF', async () => {
      const filePath = path.join(tmpDir, 'data.txt');
      const payload = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
      await fs.writeFile(filePath, payload);

      const handle = await fs.open(filePath, 'r');
      const stream = createFileByteStream(handle, 10, 25);
      const reader = stream.getReader();

      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const result = Buffer.concat(chunks);
      expect(result.toString('utf-8')).toBe('KLMNOPQRSTUVWXYZ');

      // Handle should be closed
      await expect(handle.stat()).rejects.toThrow();
    });

    it('closes handle when stream is cancelled or aborted', async () => {
      const filePath = path.join(tmpDir, 'data.txt');
      await fs.writeFile(filePath, Buffer.alloc(100_000, 1));

      const handle = await fs.open(filePath, 'r');
      const controller = new AbortController();
      const stream = createFileByteStream(handle, 0, 99_999, controller.signal);
      const reader = stream.getReader();

      // Read one chunk
      const { value } = await reader.read();
      expect(value).toBeDefined();

      // Abort
      controller.abort();
      await reader.read().catch(() => {});

      // Handle should be closed
      await expect(handle.stat()).rejects.toThrow();
    });
  });

  describe('TOCTOU safety in openScopedViewFile', () => {
    it('throws ViewNotFoundError for missing files or symlinked files', async () => {
      await expect(openScopedViewFile(tmpDir, ['missing.html'])).rejects.toThrow(ViewNotFoundError);

      await fs.writeFile(path.join(tmpDir, 'real.html'), 'hello');
      await fs.symlink(path.join(tmpDir, 'real.html'), path.join(tmpDir, 'link.html'));
      await expect(openScopedViewFile(tmpDir, ['link.html'])).rejects.toThrow(ViewNotFoundError);
    });

    it('throws ViewNotFoundError if file is swapped for a symlink right before handle stat verification', async () => {
      const filePath = path.join(tmpDir, 'swapped.html');
      await fs.writeFile(filePath, 'hello');

      // Spy on assertFileHandleMatchesPath to simulate swapping file for symlink
      const spy = vi.spyOn(fsSafety, 'assertFileHandleMatchesPath').mockRejectedValueOnce(
        new Error('Open file no longer matches its regular path')
      );

      await expect(openScopedViewFile(tmpDir, ['swapped.html'])).rejects.toThrow(ViewNotFoundError);
      spy.mockRestore();
    });
  });
});
