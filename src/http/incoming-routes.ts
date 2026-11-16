/**
 * @module http/incoming-routes
 * Read-only route returning commits pushed by others to each workspace
 * repository's remote branch (`GET /api/workspace/:id/incoming`).
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import {
  incomingCommits,
  type IncomingClock,
  type IncomingCommitsReport,
  type IncomingRepo,
  type IncomingState,
} from '../core/incoming-commits.js';

export type { IncomingCommitsReport, IncomingRepo, IncomingState };

export interface IncomingRoutesOptions {
  /** Injectable time source for tests. */
  now?: IncomingClock;
  /** Fetch timeout override for tests. */
  fetchTimeoutMs?: number;
}

/** Mounted behind the server's existing local-origin boundary. */
export function registerIncomingRoutes(
  app: Hono,
  resolveWorkspace: (id: string) => Promise<string | null>,
  options: IncomingRoutesOptions = {},
) {
  app.get('/api/workspace/:id/incoming', async (c) => {
    try {
      const id = z.string().trim().min(1).parse(c.req.param('id'));
      const root = await resolveWorkspace(id);
      if (!root) return c.json({ error: 'Workspace not found.' }, 404);
      const refreshParam = c.req.query('refresh');
      const refresh = refreshParam === '1' || refreshParam === 'true';
      const report: IncomingCommitsReport = await incomingCommits(root, {
        refresh,
        now: options.now,
        fetchTimeoutMs: options.fetchTimeoutMs,
      });
      return c.json(report);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: error.issues[0]?.message ?? 'Invalid request.' }, 400);
      }
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }
  });
}
