import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { serve } from '@hono/node-server';
import { registerViewRoutes } from './view-routes.js';
import { ViewTokenStore } from '../services/workspace-file-stream.js';
import * as fsSafety from '../resources/fs-safety.js';

describe('view-routes', () => {
  let tmpDir: string;
  let app: Hono;
  let tokenStore: ViewTokenStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'view-routes-test-'));
    tokenStore = new ViewTokenStore();
    app = new Hono();
    registerViewRoutes(app, async (id) => (id === 'test-ws' ? tmpDir : null), { store: tokenStore });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('1. 50 MB HTML file streams with flat memory', () => {
    it('streams 50 MB HTML chunk by chunk without buffering into memory', async () => {
      const fileName = 'big.html';
      const filePath = path.join(tmpDir, fileName);
      const totalSize = 50 * 1024 * 1024; // 50 MB

      // Write 50 MB file in chunks
      const handle = await fs.open(filePath, 'w');
      const chunk = Buffer.alloc(1024 * 1024, '<p>Hello world from 50MB stream!</p>\n');
      for (let i = 0; i < 50; i++) {
        await handle.write(chunk);
      }
      await handle.close();

      // Issue view link
      const linkRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fileName }),
      });
      expect(linkRes.status).toBe(200);
      const { token, url } = await linkRes.json();

      // Trigger garbage collection if available
      if (global.gc) global.gc();
      const initialHeap = process.memoryUsage().heapUsed;

      // Request /view/<token>/big.html
      const viewRes = await app.request(url);
      expect(viewRes.status).toBe(200);
      expect(viewRes.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(viewRes.headers.get('content-length')).toBe(String(totalSize));

      const reader = viewRes.body!.getReader();
      let totalBytesRead = 0;
      let maxHeapGrowth = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytesRead += value.byteLength;
        const currentHeap = process.memoryUsage().heapUsed;
        const growth = currentHeap - initialHeap;
        if (growth > maxHeapGrowth) {
          maxHeapGrowth = growth;
        }
      }

      expect(totalBytesRead).toBe(totalSize);
      // Flat memory verification: heap growth should stay well below 15 MB
      expect(maxHeapGrowth).toBeLessThan(15 * 1024 * 1024);
    });
  });

  describe('2. 300 MB .mp4 Range request', () => {
    it('handles Range requests for large files with exact byte slices', async () => {
      const fileName = 'video.mp4';
      const filePath = path.join(tmpDir, fileName);
      const totalSize = 300 * 1024 * 1024; // 314572800 bytes

      // Create sparse 300 MB file in <10ms
      const handle = await fs.open(filePath, 'w');
      await handle.truncate(totalSize);

      const headBytes = Buffer.from('HEAD_1234567890!');
      const midBytes = Buffer.from('MID__1234567890!');
      const tailBytes = Buffer.from('TAIL_1234567890!');

      await handle.write(headBytes, 0, 16, 0);
      await handle.write(midBytes, 0, 16, 150_000_000);
      await handle.write(tailBytes, 0, 16, totalSize - 16);
      await handle.close();

      const linkRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fileName }),
      });
      const { url } = await linkRes.json();

      // Middle Range request
      const midRes = await app.request(url, {
        headers: { Range: 'bytes=150000000-150000015' },
      });
      expect(midRes.status).toBe(206);
      expect(midRes.headers.get('content-range')).toBe(`bytes 150000000-150000015/${totalSize}`);
      expect(midRes.headers.get('content-length')).toBe('16');
      expect(midRes.headers.get('content-type')).toBe('video/mp4');
      const midBody = Buffer.from(await midRes.arrayBuffer());
      expect(midBody.equals(midBytes)).toBe(true);

      // Suffix Range request (tail bytes)
      const tailRes = await app.request(url, {
        headers: { Range: 'bytes=-16' },
      });
      expect(tailRes.status).toBe(206);
      expect(tailRes.headers.get('content-range')).toBe(`bytes ${totalSize - 16}-${totalSize - 1}/${totalSize}`);
      expect(tailRes.headers.get('content-length')).toBe('16');
      const tailBody = Buffer.from(await tailRes.arrayBuffer());
      expect(tailBody.equals(tailBytes)).toBe(true);

      // Bad / unsatisfiable ranges -> 416
      const badRanges = [
        'bytes=999999999-1000000000',
        'bytes=50-10',
        'bytes=-',
        'bytes=0-1,4-5',
        'items=0-5',
      ];
      for (const range of badRanges) {
        const res = await app.request(url, { headers: { Range: range } });
        expect(res.status).toBe(416);
        expect(res.headers.get('content-range')).toBe(`bytes */${totalSize}`);
      }
    });
  });

  describe('3. ETag & 304 + HEAD', () => {
    it('returns ETag and answers 304 on matching If-None-Match', async () => {
      await fs.writeFile(path.join(tmpDir, 'page.html'), '<h1>Hello</h1>');
      const linkRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'page.html' }),
      });
      const { url } = await linkRes.json();

      const res1 = await app.request(url);
      expect(res1.status).toBe(200);
      const etag = res1.headers.get('etag');
      expect(etag).toBeTruthy();
      expect(res1.headers.get('cache-control')).toBe('no-cache');

      // Conditional GET with If-None-Match
      const res304 = await app.request(url, {
        headers: { 'If-None-Match': etag! },
      });
      expect(res304.status).toBe(304);
      expect(await res304.text()).toBe('');

      // Weak ETag comparison
      const res304Weak = await app.request(url, {
        headers: { 'If-None-Match': `W/${etag}` },
      });
      expect(res304Weak.status).toBe(304);

      // Modifying file changes ETag and returns 200
      await fs.writeFile(path.join(tmpDir, 'page.html'), '<h1>Updated content!</h1>');
      const resUpdated = await app.request(url, {
        headers: { 'If-None-Match': etag! },
      });
      expect(resUpdated.status).toBe(200);
      expect(resUpdated.headers.get('etag')).not.toBe(etag);
    });

    it('answers HEAD requests with headers and empty body', async () => {
      await fs.writeFile(path.join(tmpDir, 'page.html'), '<h1>Hello</h1>');
      const linkRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'page.html' }),
      });
      const { url } = await linkRes.json();

      const headRes = await app.request(url, { method: 'HEAD' });
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(headRes.headers.get('content-length')).toBe('14');
      expect(await headRes.text()).toBe('');

      // HEAD with Range
      const headRange = await app.request(url, {
        method: 'HEAD',
        headers: { Range: 'bytes=0-3' },
      });
      expect(headRange.status).toBe(206);
      expect(headRange.headers.get('content-range')).toBe('bytes 0-3/14');
      expect(headRange.headers.get('content-length')).toBe('4');
      expect(await headRange.text()).toBe('');
    });
  });

  describe('4. Path traversal, hidden, symlink, TOCTOU, scope, and token security (404)', () => {
    it('answers 404 for programmatic and raw path violations via local HTTP socket', async () => {
      await fs.writeFile(path.join(tmpDir, 'index.html'), '<h1>Index</h1>');
      await fs.mkdir(path.join(tmpDir, 'design'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'design', 'plan.html'), '<p>Plan</p>');
      await fs.mkdir(path.join(tmpDir, 'goals-canvas'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'goals-canvas', 'Main.dc.html'), '<p>Goals</p>');

      // Root-scoped token
      const rootTokenRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'index.html' }),
      });
      const { token: rootToken } = await rootTokenRes.json();

      // Folder-scoped token
      const designTokenRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'design/plan.html' }),
      });
      const { token: designToken } = await designTokenRes.json();

      // Sibling folder access rejected (token scoped to design cannot access goals-canvas or index.html)
      expect((await app.request(`/view/${designToken}/goals-canvas/Main.dc.html`)).status).toBe(404);
      expect((await app.request(`/view/${designToken}/index.html`)).status).toBe(404);

      // Unknown token rejected
      expect((await app.request(`/view/${'B'.repeat(43)}/index.html`)).status).toBe(404);

      // Disallowed extension rejected
      await fs.writeFile(path.join(tmpDir, 'secret.ts'), 'export const x = 1;');
      expect((await app.request(`/view/${rootToken}/secret.ts`)).status).toBe(404);

      // Hidden files rejected
      await fs.writeFile(path.join(tmpDir, '.env'), 'SECRET=1');
      await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, '.git', 'config'), 'config');
      await fs.mkdir(path.join(tmpDir, '.contextspace'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, '.contextspace', 'state.json'), '{}');

      expect((await app.request(`/view/${rootToken}/.env`)).status).toBe(404);
      expect((await app.request(`/view/${rootToken}/.git/config`)).status).toBe(404);
      expect((await app.request(`/view/${rootToken}/.contextspace/state.json`)).status).toBe(404);

      // Symlinked file and symlinked parent folder rejected
      await fs.writeFile(path.join(tmpDir, 'target.html'), 'target');
      await fs.symlink(path.join(tmpDir, 'target.html'), path.join(tmpDir, 'symlink.html'));
      expect((await app.request(`/view/${rootToken}/symlink.html`)).status).toBe(404);

      await fs.mkdir(path.join(tmpDir, 'outside-folder'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'outside-folder', 'leak.html'), 'leak');
      await fs.symlink(path.join(tmpDir, 'outside-folder'), path.join(tmpDir, 'sym-dir'));
      expect((await app.request(`/view/${rootToken}/sym-dir/leak.html`)).status).toBe(404);

      // File swapped for a symlink right after assertNoLinkedPathComponents (TOCTOU simulation)
      const spy = vi.spyOn(fsSafety, 'assertFileHandleMatchesPath').mockRejectedValueOnce(
        new Error('Open file no longer matches its regular path')
      );
      expect((await app.request(`/view/${rootToken}/index.html`)).status).toBe(404);
      spy.mockRestore();

      // Configure a repo checkout inside workspace
      await fs.writeFile(path.join(tmpDir, 'contextspace.json'), JSON.stringify({
        id: 'test-ws',
        branchName: 'main',
        description: 'Test',
        repos: ['repoA'],
        assistants: [],
      }));
      await fs.mkdir(path.join(tmpDir, 'repoA'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'repoA', 'page.html'), 'repo page');

      // Requesting a file in an excluded repo checkout folder directly fails at view-link time
      const repoLinkRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'repoA/page.html' }),
      });
      expect(repoLinkRes.status).toBe(400);

      // New root token issued with repo checkouts excluded
      const freshRootTokenRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'index.html' }),
      });
      const { token: freshRootToken } = await freshRootTokenRes.json();
      expect((await app.request(`/view/${freshRootToken}/repoA/page.html`)).status).toBe(404);

      // Test real ephemeral local Node HTTP socket for un-normalized raw paths
      const server = serve({
        fetch: app.fetch,
        port: 0, // ephemeral port allocated by OS
      });

      try {
        await new Promise<void>((resolve) => server.on('listening', resolve));
        const address = server.address() as import('node:net').AddressInfo;
        const port = address.port;

        const requestRaw = (rawPath: string): Promise<number> => {
          return new Promise((resolve, reject) => {
            const req = http.request(
              {
                host: '127.0.0.1',
                port,
                path: rawPath,
                method: 'GET',
              },
              (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
              }
            );
            req.on('error', reject);
            req.end();
          });
        };

        // Traversal, encoded slashes, encoded NUL, and backslashes over real TCP
        expect(await requestRaw(`/view/${rootToken}/../index.html`)).toBe(404);
        expect(await requestRaw(`/view/${rootToken}/%2e%2e/index.html`)).toBe(404);
        expect(await requestRaw(`/view/${rootToken}/design%2fplan.html`)).toBe(404);
        expect(await requestRaw(`/view/${rootToken}/design%2Fplan.html`)).toBe(404);
        expect(await requestRaw(`/view/${rootToken}/design\\plan.html`)).toBe(404);
        expect(await requestRaw(`/view/${rootToken}/design%5cplan.html`)).toBe(404);
        expect(await requestRaw(`/view/${rootToken}/design%5Cplan.html`)).toBe(404);
        expect(await requestRaw(`/view/${rootToken}/index%00.html`)).toBe(404);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('5. Method, Host, Cross-site, and Headers', () => {
    it('rejects disallowed methods with 405 and Allow: GET, HEAD', async () => {
      await fs.writeFile(path.join(tmpDir, 'page.html'), 'hello');
      const linkRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'page.html' }),
      });
      const { url } = await linkRes.json();

      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const res = await app.request(url, { method });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      }
    });

    it('rejects non-local Host headers with 403', async () => {
      await fs.writeFile(path.join(tmpDir, 'page.html'), 'hello');
      const linkRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'page.html' }),
      });
      const { url } = await linkRes.json();

      const evilViewRes = await app.request(url, {
        headers: { Host: 'evil.test' },
      });
      expect(evilViewRes.status).toBe(403);

      const evilLinkRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Host: 'evil.test' },
        body: JSON.stringify({ name: 'page.html' }),
      });
      expect(evilLinkRes.status).toBe(403);
      expect(await evilLinkRes.json()).toEqual({ error: 'Forbidden: invalid Host header.' });
    });

    it('rejects cross-site POST to /view-link with 403', async () => {
      // Sec-Fetch-Site: cross-site
      const crossSiteRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'sec-fetch-site': 'cross-site',
        },
        body: JSON.stringify({ name: 'page.html' }),
      });
      expect(crossSiteRes.status).toBe(403);
      expect(await crossSiteRes.json()).toEqual({ error: 'Forbidden cross-site request.' });

      // Origin: null (from sandboxed frame)
      const nullOriginRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          origin: 'null',
        },
        body: JSON.stringify({ name: 'page.html' }),
      });
      expect(nullOriginRes.status).toBe(403);
      expect(await nullOriginRes.json()).toEqual({ error: 'Forbidden cross-site request.' });

      // Origin: https://evil.example
      const evilOriginRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          origin: 'https://evil.example',
        },
        body: JSON.stringify({ name: 'page.html' }),
      });
      expect(evilOriginRes.status).toBe(403);
      expect(await evilOriginRes.json()).toEqual({ error: 'Forbidden cross-site request.' });
    });

    it('asserts exact security and caching headers on /view responses', async () => {
      await fs.writeFile(path.join(tmpDir, 'page.html'), '<h1>Hello</h1>');
      const linkRes = await app.request('/api/workspace/test-ws/documents/view-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'page.html' }),
      });
      const { url } = await linkRes.json();

      const res = await app.request(url);
      expect(res.status).toBe(200);

      expect(res.headers.get('content-security-policy')).toBe(
        'sandbox allow-scripts allow-forms allow-modals allow-popups'
      );
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
      expect(res.headers.get('accept-ranges')).toBe('bytes');
    });
  });
});
