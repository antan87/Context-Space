/**
 * @module http/plan-routes
 * The Plan tab's routes: read the plan, and change one item as the user. A milestone counts as done
 * only when its check passes, so closing one runs the check first, as the Visual Flow does.
 */

import type { Hono, Context, Handler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { planForApp } from '../core/plan-app.js';
import { preparePlan } from '../core/plan-import.js';
import { advanceLifecycleStep } from '../core/lifecycle.js';
import { PlanError, changePlan, type PlanChange } from '../core/plan.js';
import { PLAN_KINDS, itemLabel } from '../core/plan-words.js';

const code = z.string().min(1).max(100);
const codes = z.array(code).max(100);
const text = (max: number) => z.string().trim().min(1).max(max);
const links = z.object({ repo: z.string().max(200).optional(), branch: z.string().max(200).optional(), workItem: z.string().max(2000).optional() }).strict();
const gate = z.object({ required: z.boolean(), command: z.string().max(2000).optional(), timeoutSeconds: z.number().int().positive().max(7200).optional() }).strict();

/** The changes a person can make in the tab, each as `ctxspace plan` makes it. */
export const planChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add'), kind: z.enum(PLAN_KINDS), title: text(200), detail: z.string().max(4000).optional(),
    owner: z.string().max(200).optional(), after: codes.optional(), before: codes.optional(), links: links.optional(), gate: gate.optional(),
  }).strict(),
  z.object({ type: z.literal('start'), id: code }).strict(),
  z.object({ type: z.literal('done'), id: code, resolution: text(2000) }).strict(),
  z.object({ type: z.literal('answer'), id: code, answer: text(2000) }).strict(),
  z.object({ type: z.literal('drop'), id: code, reason: text(2000) }).strict(),
  z.object({ type: z.literal('later'), id: code, revisitWhen: text(2000) }).strict(),
  z.object({ type: z.literal('block'), id: code, reason: text(2000) }).strict(),
  z.object({ type: z.literal('reopen'), id: code, reason: text(2000) }).strict(),
  z.object({
    type: z.literal('edit'), id: code, title: text(200).optional(), detail: z.string().max(4000).nullable().optional(),
    owner: z.string().max(200).nullable().optional(), after: codes.optional(), notAfter: codes.optional(), before: codes.optional(),
    links: links.optional(), gate: gate.nullable().optional(),
  }).strict(),
  z.object({ type: z.literal('accept'), id: code }).strict(),
  z.object({ type: z.literal('reject'), id: code, reason: text(2000) }).strict(),
]);
const changeBody = z.object({ change: planChangeSchema, ifRevision: z.number().int().nonnegative().optional() }).strict();

const STATUS_FOR: Record<PlanError['code'], number> = { not_found: 404, invalid: 400, conflict: 409, corrupt: 409, not_allowed: 403, waiting: 409 };

/** Mounted behind the server's existing local-origin boundary. */
export function registerPlanRoutes(app: Hono, resolveWorkspace: (id: string) => Promise<string | null>) {
  const handle = (action: (workspacePath: string, c: Context) => Promise<object>): Handler => async (c) => {
    try {
      const root = await resolveWorkspace(z.string().min(1).parse(c.req.param('id')));
      if (!root) return c.json({ error: 'Workspace not found.' }, 404);
      return c.json(await action(root, c));
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: error.issues[0]?.message ?? 'Invalid change.' }, 400);
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof PlanError ? STATUS_FOR[error.code] : /changed.*session|Reload/.test(message) ? 409 : 400;
      return c.json({ error: message }, status as 400);
    }
  };

  app.get('/api/workspace/:id/plan/items', handle((root) => planForApp(root)));

  app.post('/api/workspace/:id/plan/items', bodyLimit({ maxSize: 64_000 }), handle(async (root, c) => {
    const { change, ifRevision } = changeBody.parse(await c.req.json());
    const user = { by: 'user' } as const;
    const plan = await preparePlan(root);
    if (ifRevision !== undefined && plan.revision !== ifRevision) {
      throw new PlanError('The plan changed in another session. Reload it, then try again.', 'conflict');
    }
    const item = 'id' in change ? plan.items.find((candidate) => candidate.id === change.id) : undefined;
    const closesMilestone = item?.kind === 'milestone'
      && (change.type === 'done' || (change.type === 'accept' && item.proposal?.action === 'done'));
    let message: string;
    if (closesMilestone) {
      // Runs the milestone's check when it has one; done only when the check passes.
      const resolution = change.type === 'done' ? change.resolution : item.proposal!.note;
      await advanceLifecycleStep(root, item.id, 'complete', user, { resolution });
      message = `Done: ${itemLabel(item)}.`;
    } else {
      message = (await changePlan(root, change as PlanChange, { actor: user, ifRevision })).message;
    }
    return { message, plan: await planForApp(root) };
  }));
}
