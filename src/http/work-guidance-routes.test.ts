import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerWorkGuidanceRoutes } from './work-guidance-routes.js';
import * as fsSafety from '../resources/fs-safety.js';

vi.mock('../core/refresh.js', () => ({
  refreshWorkspace: vi.fn().mockResolvedValue({ workspacePath: '/tmp/test', analyzedRepos: [], reusedRepos: [], refreshedHandoff: false }),
}));
vi.mock('../core/lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/lifecycle.js')>();
  return { ...actual, loadWorkspaceLifecycle: vi.fn(actual.loadWorkspaceLifecycle) };
});
import { loadWorkspaceLifecycle } from '../core/lifecycle.js';
let root: string;
let app: Hono;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'guidance-api-'));
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'test', branchName: 'test', description: 'Test', repos: [], assistants: [] }));
  app = new Hono();
  registerWorkGuidanceRoutes(app, async (id) => id === 'test' ? root : null);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('serves source labels, original text, and an updated scoped assignment', async () => {
  expect((await app.request('/api/workspace/test/work')).status).toBe(200);
  const saved = await app.request('/api/workspace/test/work/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 0, title: 'Requirements', role: 'requirements', status: 'approved', content: 'Original requirements' }) });
  expect(saved.status).toBe(200);
  const result = await saved.json();
  expect(result.assignment).toContain('requirements, approved');
  expect(result.contextRefreshed).toBe(true);
  const read = await app.request(`/api/workspace/test/work/documents/${result.guidance.documents[0].id}`);
  expect((await read.json()).content).toBe('Original requirements');
});

it('reports a saved plan conflict and refresh result without hiding the mutation', async () => {
  const first = await app.request('/api/workspace/test/work', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: 0, workType: 'feature', size: 'small', assignment: { stage: 'design', objective: 'Shape the change', expectedOutput: 'A proposal', stopCondition: 'Before implementation' } }),
  });
  expect(first.status).toBe(200);
  expect((await first.json()).contextRefreshed).toBe(true);
  const stale = await app.request('/api/workspace/test/work', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: 0, workType: 'feature', size: 'small', assignment: { stage: 'design', objective: 'Stale', expectedOutput: 'A proposal', stopCondition: 'Before implementation' } }),
  });
  expect(stale.status).toBe(409);
  expect((await stale.json()).error).toContain('another session');
});
it('rejects absent workspaces, malformed metadata, oversized input, and stale writes', async () => {
  expect((await app.request('/api/workspace/missing/work')).status).toBe(404);
  const request = (body: unknown) => app.request('/api/workspace/test/work/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect((await request({ revision: 0, title: '', content: 'x' })).status).toBe(400);
  expect((await request({ revision: 0, title: 'Large', role: 'reference', content: 'x'.repeat(600_001) })).status).toBe(413);
  expect((await request({ revision: 0, title: 'First', role: 'reference', content: 'hello' })).status).toBe(200);
  expect((await request({ revision: 0, title: 'Stale', role: 'reference', content: 'world' })).status).toBe(409);
});
it('serves authored planning notes and returns a conflict without replacing newer content', async () => {
  const initial = await (await app.request('/api/workspace/test/planning-notes')).json();
  const save = (content: string) => app.request('/api/workspace/test/planning-notes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: initial.revision, content }) });
  expect((await save('# Agreed sequence')).status).toBe(200);
  expect((await save('# Stale overwrite')).status).toBe(409);
  expect((await (await app.request('/api/workspace/test/planning-notes')).json()).content).toBe('# Agreed sequence');
  expect((await app.request('/api/workspace/missing/planning-notes')).status).toBe(404);
});

it('lists and previews root documents without registering sources, and serves safe downloads', async () => {
  await fs.writeFile(path.join(root, 'agent report.md'), '# Agent report');
  await fs.writeFile(path.join(root, 'brief.pdf'), '%PDF-1.7\nfixture');
  const list = await (await app.request('/api/workspace/test/documents')).json();
  expect(list.documents.map((doc: { name: string }) => doc.name)).toEqual(['agent report.md', 'brief.pdf']);
  const preview = await (await app.request('/api/workspace/test/documents/preview?name=agent%20report.md')).json();
  expect(preview).toMatchObject({ name: 'agent report.md', kind: 'markdown', content: '# Agent report' });
  expect(preview).not.toHaveProperty('bytes');
  const file = await app.request('/api/workspace/test/documents/file?name=brief.pdf');
  expect(file.headers.get('content-type')).toBe('application/pdf');
  expect(file.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await file.text()).toBe('%PDF-1.7\nfixture');
  const download = await app.request('/api/workspace/test/documents/file?name=agent%20report.md&download=1');
  expect(download.headers.get('content-disposition')).toContain('attachment;');
  expect((await app.request('/api/workspace/test/documents/preview?name=..%2Fescape.md')).status).toBe(400);
  expect((await app.request('/api/workspace/missing/documents')).status).toBe(404);

  await fs.mkdir(path.join(root, 'sub'));
  await fs.writeFile(path.join(root, 'sub', 'nested.md'), '# Nested');
  const subList = await (await app.request('/api/workspace/test/documents?folder=sub')).json();
  expect(subList.documents.map((doc: { name: string }) => doc.name)).toEqual(['sub/nested.md']);

  const subListTrailing = await (await app.request('/api/workspace/test/documents?folder=sub/')).json();
  expect(subListTrailing.documents.map((doc: { name: string }) => doc.name)).toEqual(['sub/nested.md']);
});

it('keeps HTML locked down unless it is explicitly opened in a browser', async () => {
  await fs.writeFile(path.join(root, 'page.html'), '<h1>Report</h1>');

  // Default delivery: never renders in a browser, never executes.
  const defaultHtml = await app.request('/api/workspace/test/documents/file?name=page.html');
  expect(defaultHtml.headers.get('content-disposition')).toContain('attachment;');
  expect(defaultHtml.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");

  // The open variant renders, and the sandbox directive is what keeps it away from this app.
  const opened = await app.request('/api/workspace/test/documents/file?name=page.html&open=1');
  const openedCsp = opened.headers.get('content-security-policy') ?? '';
  expect(opened.headers.get('content-disposition')).toContain('inline;');
  expect(opened.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(opened.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await opened.text()).toBe('<h1>Report</h1>');
  // Scripts and remote subresources work, which is the entire point of opening it.
  expect(openedCsp).toContain('allow-scripts');
  expect(openedCsp).toMatch(/default-src \* /);
  // Opaque origin, so it cannot read this app's cookies or storage.
  expect(openedCsp).toContain('sandbox');
  expect(openedCsp).not.toContain('allow-same-origin');
  // A new tab must not escape the sandbox entirely.
  expect(openedCsp).not.toContain('allow-popups-to-escape-sandbox');

  // Opening one does not loosen delivery of anything else.
  const other = await app.request('/api/workspace/test/documents/file?name=page.html&download=1');
  expect(other.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
  expect(other.headers.get('content-disposition')).toContain('attachment;');
  const afterOpen = await app.request('/api/workspace/test/documents/file?name=page.html');
  expect(afterOpen.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
});

it('lists data files outside the workspace repositories, opens them by name, and still lists when the manifest cannot be read', async () => {
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'test', branchName: 'test', description: 'Test', repos: ['/somewhere/else/api'], assistants: [], mode: 'worktree' }));
  await fs.mkdir(path.join(root, 'api'));
  await fs.writeFile(path.join(root, 'api', 'package.json'), '{"name":"api"}');
  await fs.writeFile(path.join(root, 'api', 'README.md'), '# api');
  await fs.writeFile(path.join(root, 'spec.json'), '{"openapi":"3.1.0"}');
  const names = async () => ((await (await app.request('/api/workspace/test/documents?recursive=1')).json()).documents as { name: string }[]).map((doc) => doc.name);

  // The repository's checkout is `api` inside the workspace: its package.json is not a document, the workspace's spec.json is,
  // and contextspace.json (ContextSpace's own manifest) is neither.
  expect(await names()).toEqual(['api/README.md', 'spec.json']);
  const preview = await (await app.request('/api/workspace/test/documents/preview?name=spec.json')).json();
  expect(preview).toMatchObject({ name: 'spec.json', kind: 'text', content: '{"openapi":"3.1.0"}' });
  expect((await app.request('/api/workspace/test/documents/preview?name=api%2Fpackage.json')).status).toBe(200);

  // An unreadable manifest must not take the listing down: every data file is listed instead.
  await fs.writeFile(path.join(root, 'contextspace.json'), '{ not json');
  expect(await names()).toEqual(['api/package.json', 'api/README.md', 'spec.json']);
});

it('reads the brief without the branch fleet, which runs git in every repository', async () => {
  expect((await app.request('/api/workspace/test/work')).status).toBe(200);
  expect(vi.mocked(loadWorkspaceLifecycle)).toHaveBeenLastCalledWith(root, { includeFleet: false });
});

it('saves documents, creates document folders, and moves documents via endpoints', async () => {
  // Save new document
  const saveRes = await app.request('/api/workspace/test/documents', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'guide.md', content: '# Guide content' }),
  });
  expect(saveRes.status).toBe(200);
  const savedDoc = await saveRes.json();
  expect(savedDoc).toMatchObject({ name: 'guide.md', kind: 'markdown', content: '# Guide content' });
  expect(await fs.readFile(path.join(root, 'guide.md'), 'utf-8')).toBe('# Guide content');

  // Create folder
  const folderRes = await app.request('/api/workspace/test/documents/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: 'archive/2026' }),
  });
  expect(folderRes.status).toBe(200);
  expect(await folderRes.json()).toEqual({ folder: 'archive/2026' });
  expect((await fs.stat(path.join(root, 'archive', '2026'))).isDirectory()).toBe(true);

  // Move document
  const moveRes = await app.request('/api/workspace/test/documents/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'guide.md', to: 'archive/2026/guide.md' }),
  });
  expect(moveRes.status).toBe(200);
  expect(await moveRes.json()).toEqual({ from: 'guide.md', to: 'archive/2026/guide.md' });
  expect(await fs.readFile(path.join(root, 'archive', '2026', 'guide.md'), 'utf-8')).toBe('# Guide content');
  await expect(fs.access(path.join(root, 'guide.md'))).rejects.toThrow();

  // Rejects invalid input
  const badRes = await app.request('/api/workspace/test/documents', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'bad.exe', content: 'x' }),
  });
  expect(badRes.status).toBe(400);
});

it('previews binary and metaOnly documents without reading file bytes, and streams files directly', async () => {
  // Create a 30 MB PDF
  const pdfPath = path.join(root, 'large.pdf');
  const fh = await fs.open(pdfPath, 'w');
  await fh.truncate(30 * 1024 * 1024);
  await fh.close();

  const readSpy = vi.spyOn(fsSafety, 'readFileHandleAtMost');

  // Binary preview returns metadata with zero bytes read
  const previewRes = await app.request('/api/workspace/test/documents/preview?name=large.pdf');
  expect(previewRes.status).toBe(200);
  const preview = await previewRes.json();
  expect(preview).toMatchObject({
    name: 'large.pdf',
    kind: 'pdf',
    mime: 'application/pdf',
    size: 30 * 1024 * 1024,
  });
  expect(preview.content).toBeUndefined();
  expect(readSpy).not.toHaveBeenCalled();

  // Text preview with ?meta=1 returns metadata with zero bytes read
  await fs.writeFile(path.join(root, 'sample.html'), '<h1>Sample</h1>');
  const metaRes = await app.request('/api/workspace/test/documents/preview?name=sample.html&meta=1');
  expect(metaRes.status).toBe(200);
  const metaJson = await metaRes.json();
  expect(metaJson).toMatchObject({
    name: 'sample.html',
    kind: 'html',
    size: 15,
  });
  expect(metaJson.content).toBeUndefined();
  expect(readSpy).not.toHaveBeenCalled();

  // /documents/file streams the PDF with correct headers
  const fileRes = await app.request('/api/workspace/test/documents/file?name=large.pdf');
  expect(fileRes.status).toBe(200);
  expect(fileRes.headers.get('content-type')).toBe('application/pdf');
  expect(fileRes.headers.get('content-length')).toBe(String(30 * 1024 * 1024));
  expect(fileRes.headers.get('cache-control')).toBe('no-store');

  readSpy.mockRestore();
});

