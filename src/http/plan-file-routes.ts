/**
 * @module http/plan-file-routes
 * The Plan tab's routes: read PLAN.md as the app shows it, and make one change as the user.
 */

import type { Hono, Context, Handler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { PlanFileError } from '../core/plan-file.js';
import { changePlanFileForApp, planFileForApp } from '../core/plan-file-app.js';

const key = z.string().min(1).max(100);
const words = (max: number) => z.string().trim().min(1).max(max);

/** The changes a person can make in the tab. */
export const planFileChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tick'), key, done: z.boolean(), expected: words(300) }).strict(),
  z.object({ type: z.literal('answer'), key, answer: words(2000), expected: words(300) }).strict(),
  z.object({ type: z.literal('add'), step: words(300), checkpoint: key.optional() }).strict(),
  z.object({
    type: z.literal('decide'), checkpoint: key.optional(),
    decision: z.object({
      question: words(300), suggested: z.array(words(200)).max(6).optional(), ifNoAnswer: words(300).optional(), detail: z.string().max(4000).optional(),
    }).strict(),
  }).strict(),
  z.object({ type: z.literal('check'), key }).strict(),
]);

const STATUS_FOR: Record<PlanFileError['code'], number> = { not_found: 404, invalid: 400, conflict: 409 };

/** Mounted behind the server's existing local-origin boundary. */
export function registerPlanFileRoutes(app: Hono, resolveWorkspace: (id: string) => Promise<string | null>) {
  const handle = (action: (workspacePath: string, c: Context) => Promise<object>): Handler => async (c) => {
    try {
      const root = await resolveWorkspace(z.string().min(1).parse(c.req.param('id')));
      if (!root) return c.json({ error: 'Workspace not found.' }, 404);
      return c.json(await action(root, c));
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: error.issues[0]?.message ?? 'Invalid change.' }, 400);
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof PlanFileError ? STATUS_FOR[error.code] : /busy in another session/.test(message) ? 409 : 400;
      return c.json({ error: message }, status as 400);
    }
  };

  app.get('/api/workspace/:id/plan', handle((root) => planFileForApp(root)));

  app.post('/api/workspace/:id/plan', bodyLimit({ maxSize: 64_000 }), handle(async (root, c) => {
    const { change } = z.object({ change: planFileChangeSchema }).strict().parse(await c.req.json());
    const { message } = await changePlanFileForApp(root, change);
    return { message, plan: await planFileForApp(root) };
  }));
}
