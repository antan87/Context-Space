/**
 * @module http/needs-you-routes
 * The Overview's one read: what needs the user in each workspace it names. Cheap by design, like the
 * attention route: it reads the plan, the state file and the end of the chat ledger of the ids it is
 * given, and nothing else.
 */

import type { Hono } from 'hono';
import { workspaceNeeds } from '../core/needs-you.js';

/** Most workspaces read in one call. */
export const NEEDS_YOU_MAX_WORKSPACES = 100;

export function registerNeedsYouRoute(app: Hono, resolveWorkspace: (id: string) => Promise<string | null>) {
  app.get('/api/needs-you', async (c) => {
    const ids = [...new Set((c.req.query('workspaces') ?? '').split(',').map((id) => id.trim()).filter(Boolean))].slice(0, NEEDS_YOU_MAX_WORKSPACES);
    const found = await Promise.all(ids.map(async (id) => {
      try {
        const root = await resolveWorkspace(id);
        return root ? await workspaceNeeds(id, root) : null;
      } catch {
        // An unknown id or an unreadable workspace is left out, not an error for the others.
        return null;
      }
    }));
    return c.json({ workspaces: found.filter((needs) => needs !== null) });
  });
}
