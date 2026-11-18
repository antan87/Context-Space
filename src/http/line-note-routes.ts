import type { Hono } from 'hono';
import { readLineNotes, finishLineNote } from '../core/line-notes.js';
import { ArchivedWorkspaceError } from '../core/archive-guard.js';

/** Uses the same workspace resolver and local-origin boundary as the other workspace routes. */
export function registerLineNoteRoutes(app: Hono, resolveWorkspace: (id: string) => Promise<string | null>) {
  app.get('/api/workspace/:id/line-notes', async c => {
    try {
      const root = await resolveWorkspace(c.req.param('id'));
      if (!root) return c.json({ error: 'Workspace not found.' }, 404);
      return c.json({ notes: (await readLineNotes(root)).filter(n => !n.doneAt) });
    } catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400); }
  });
  app.post('/api/workspace/:id/line-notes/:noteId/done', async c => {
    try {
      const root = await resolveWorkspace(c.req.param('id'));
      if (!root) return c.json({ error: 'Workspace not found.' }, 404);
      return c.json({ note: await finishLineNote(root, c.req.param('noteId')) });
    } catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, e instanceof ArchivedWorkspaceError ? 409 : 400); }
  });
}
