import type { Hono } from 'hono';
import { listReferenceRepositoryFiles } from '../core/repository-reference-files.js';
import { resolveWorkspaceReference, type WorkspaceReferenceOptions } from '../core/workspace-reference-resolve.js';

/** Mounted behind the local-origin boundary; the resolver must identify an exact trusted workspace. */
export function registerWorkspaceReferenceRoutes(
  app: Hono,
  resolveWorkspace: (id: string) => Promise<string | null>,
  listFiles: WorkspaceReferenceOptions['listFiles'] = listReferenceRepositoryFiles,
) {
  app.get('/api/workspace/:id/files/reference', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const root = await resolveWorkspace(c.req.param('id'));
      if (!root) return c.json({ error: 'Workspace not found.' }, 404);
      const reference = c.req.query('path');
      if (!reference) return c.json({ error: 'Missing path query parameter.' }, 400);
      return c.json(await resolveWorkspaceReference(root, reference, { cwd: c.req.query('cwd'), listFiles }));
    } catch {
      return c.json({ error: 'Workspace reference configuration is unavailable or ambiguous.' }, 400);
    }
  });
}
