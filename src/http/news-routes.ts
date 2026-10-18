/**
 * @module http/news-routes
 * What changed in a workspace since a reader last looked, for the app (which reads as `user`). The report does not mark
 * anything, but it keeps what it saw as the reader's pending record. The call that follows, once the reader has seen it,
 * makes exactly that their last look, so what landed between the two is shown next time. An archived workspace is a
 * record to read: nothing is kept in it, so there the report is read-only and nothing can be marked.
 */

import type { Hono, Context, Handler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { isArchived } from '../core/archive-guard.js';
import { NewsChangedError, markSeen, whatsNew } from '../core/whats-new.js';
import { loadFeatureConfig } from '../core/workspace.js';

const reader = z.string().trim().min(1).max(40);
const time = z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), 'Use a date and time such as 2026-10-17T09:00:00Z.');

const ARCHIVED_MESSAGE = 'This workspace is archived, so nothing in it can be marked as seen.';

const isArchivedWorkspace = async (root: string) => isArchived(await loadFeatureConfig(root).catch(() => null));

/** Mounted behind the server's existing local-origin boundary. */
export function registerNewsRoutes(app: Hono, resolveWorkspace: (id: string) => Promise<string | null>) {
  const handle = (action: (workspacePath: string, c: Context) => Promise<object>): Handler => async (c) => {
    try {
      const root = await resolveWorkspace(z.string().min(1).parse(c.req.param('id')));
      if (!root) return c.json({ error: 'Workspace not found.' }, 404);
      return c.json(await action(root, c));
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: error.issues[0]?.message ?? 'Invalid request.' }, 400);
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, error instanceof NewsChangedError || message === ARCHIVED_MESSAGE || /saving what it has seen/.test(message) ? 409 : 400);
    }
  };

  app.get('/api/workspace/:id/news', handle(async (root, c) =>
    whatsNew(root, reader.default('user').parse(c.req.query('reader')), { since: time.optional().parse(c.req.query('since')), pending: !(await isArchivedWorkspace(root)) })));

  app.post('/api/workspace/:id/news/seen', bodyLimit({ maxSize: 4_000 }), handle(async (root, c) => {
    const body = z.object({ reader, at: time }).strict().parse(await c.req.json());
    if (await isArchivedWorkspace(root)) throw new Error(ARCHIVED_MESSAGE);
    await markSeen(root, body.reader, body.at);
    return { ok: true };
  }));
}
