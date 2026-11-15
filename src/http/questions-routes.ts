import type { Hono } from 'hono';

import { readQuestions } from '../core/questions.js';

type WorkspaceResolver = (id: string) => Promise<string | null>;

/**
 * Registers the read-only endpoint for the answers on the Board (`GET /api/workspace/:id/questions`): the workspace's
 * `explain/*.md` files as parts and cards, with each copied code block checked against the real file. It never writes.
 */
export function registerQuestionsRoutes(app: Hono, resolveWorkspace: WorkspaceResolver): void {
  app.get('/api/workspace/:id/questions', async (c) => {
    const workspacePath = await resolveWorkspace(c.req.param('id'));
    if (!workspacePath) return c.json({ error: 'Workspace not found.' }, 404);
    return c.json({ answers: await readQuestions(workspacePath) });
  });
}
