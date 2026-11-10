import type { Hono, Handler } from 'hono';
import { listWorkspaceFiles, readWorkspaceFile } from '../core/workspace-files.js';

/** Mounted behind the server's local-origin boundary; roots come only from the exact trusted resolver. */
export function registerWorkspaceFileRoutes(app: Hono, resolveWorkspace: (id: string) => Promise<string | null>) {
  const handle = (read: boolean): Handler => async (c) => {
    try {
      const root = await resolveWorkspace(c.req.param('id')!);
      if (!root) return c.json({ error: 'Workspace not found.' }, 404);
      return c.json(read ? await readWorkspaceFile(root, c.req.query('file') ?? '') : await listWorkspaceFiles(root));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  };
  app.get('/api/workspace/:id/files', handle(false));
  app.get('/api/workspace/:id/files/read', handle(true));
}
