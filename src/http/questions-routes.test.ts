import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { registerQuestionsRoutes } from './questions-routes.js';

describe('GET /api/workspace/:id/questions', () => {
  let root: string;
  let app: Hono;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'questions-route-')));
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ repos: [], mode: 'worktree' }));
    app = new Hono();
    registerQuestionsRoutes(app, async (id) => (id === 'demo' ? root : null));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('is 404 for an unknown workspace', async () => {
    expect((await app.request('/api/workspace/nope/questions')).status).toBe(404);
  });

  it('gives no answers without an explain folder', async () => {
    const response = await app.request('/api/workspace/demo/questions');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answers: [] });
  });

  it('gives each answer with its parts and cards', async () => {
    await fs.mkdir(path.join(root, 'explain'));
    await fs.writeFile(path.join(root, 'explain', 'q.md'), '# Why?\n\nBecause.\n\n## Part\n\n```ts nowhere/a.ts:1-2\nx\n```\n');
    const body = await (await app.request('/api/workspace/demo/questions')).json();
    expect(body.answers).toHaveLength(1);
    expect(body.answers[0]).toMatchObject({ path: 'explain/q.md', question: 'Why?', summary: 'Because.' });
    expect(body.answers[0].parts.map((part: { title: string }) => part.title)).toEqual(['In short', 'Part']);
    expect(body.answers[0].parts[1].cards[0]).toMatchObject({ kind: 'code', where: 'nowhere/a.ts', check: { status: 'not-in-workspace' } });
  });

  it('gives the area an answer is about when it is a checkpoint or the plan, and none otherwise', async () => {
    await fs.mkdir(path.join(root, 'explain'));
    const write = (name: string, area?: string) => fs.writeFile(path.join(root, 'explain', name), `${area === undefined ? '' : `---\narea: ${area}\n---\n`}# ${name}\n\nShort.\n`);
    await write('a.md', 'checkpoint:the-board');
    await write('b.md', 'plan:own');
    await write('c.md');
    await write('d.md', 'checkpoint:');
    await write('e.md', 'somewhere else');
    await write('f.md', 'checkpoint:användare-kan-logga-in');
    const body = await (await app.request('/api/workspace/demo/questions')).json();
    const areas = Object.fromEntries(body.answers.map((answer: { path: string; area?: string }) => [answer.path, answer.area ?? null]));
    expect(areas).toEqual({ 'explain/a.md': 'checkpoint:the-board', 'explain/b.md': 'plan:own', 'explain/c.md': null, 'explain/d.md': null, 'explain/e.md': null, 'explain/f.md': 'checkpoint:användare-kan-logga-in' });
  });
});
