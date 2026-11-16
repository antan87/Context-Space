import type { Hono } from 'hono';

import { BoardFileError, BoardWorkspaceError } from '../core/board.js';
import { CommitNoteInputError, queryCommitNotes } from '../core/commit-notes.js';

type WorkspaceResolver = (id: string) => Promise<string | null>;

/**
 * Registers the read-only HTTP endpoint for AI commit notes (`GET /api/workspace/:id/commit-notes`).
 * Commit notes are written by AI tools via CLI or MCP and only read by the GUI.
 */
export function registerCommitNotesRoutes(app: Hono, resolveWorkspace: WorkspaceResolver): void {
  app.get('/api/workspace/:id/commit-notes', async (c) => {
    const workspacePath = await resolveWorkspace(c.req.param('id'));
    if (!workspacePath) {
      return c.json({ error: 'Workspace not found.' }, 404);
    }

    const repo = c.req.query('repo')?.trim() || undefined;
    const sha = c.req.query('sha')?.trim() || undefined;

    try {
      const notes = await queryCommitNotes(workspacePath, { repo, sha });
      return c.json({ notes });
    } catch (error) {
      if (error instanceof CommitNoteInputError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof BoardWorkspaceError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof BoardFileError) {
        return c.json({ error: error.message }, 500);
      }
      throw error;
    }
  });
}
