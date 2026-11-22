/**
 * @module http/plan-file-routes
 * The Plan tab's routes: read PLAN.md as the app shows it, and make one change as the user.
 */

import type { Hono, Context, Handler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { PLAN_FILE, PLAN_LINE_MAX, PlanFileError } from '../core/plan-file.js';
import { changePlanFileForApp, planFileForApp, type PlanFileAppChange } from '../core/plan-file-app.js';
import { PlanDbChangeError, changePlanDbForApp, planDbForApp } from '../core/plan-db-app.js';
import { storeOf } from '../core/workspace-db-app.js';
import { WorkspaceMovedError } from '../core/workspace-db-switch.js';
import { WorkspaceDbError } from '../core/workspace-db/index.js';

const key = z.string().min(1).max(100);
const words = (max: number) => z.string().trim().min(1).max(max);
/** `expected` echoes the item's text exactly as the server gave it to the app, so a line of any length must pass: the body limit (64 kB) is the only ceiling. */
const echoed = () => z.string().trim().min(1);
const REOPENED = 'Reopened: ';
/** The item's revision as the app read it, from a workspace moved to its database. */
const rev = z.number().int().positive();

/** What a person is told when a request fails validation: a too-long string says what the plan itself says. */
function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.code === 'too_big' && 'maximum' in issue && (('origin' in issue && issue.origin === 'string') || ('type' in issue && issue.type === 'string'))) {
    return `Keep it to ${issue.maximum} characters or fewer.`;
  }
  return issue?.message ?? 'Invalid change.';
}

/** The changes a person can make in the tab. */
export const planFileChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tick'), key, done: z.boolean(), expected: echoed(), rev: rev.optional() }).strict(),
  z.object({ type: z.literal('answer'), key, answer: words(PLAN_LINE_MAX), expected: echoed(), rev: rev.optional() }).strict(),
  z.object({ type: z.literal('add'), step: words(PLAN_LINE_MAX), checkpoint: key.optional() }).strict(),
  z.object({
    type: z.literal('decide'), checkpoint: key.optional(),
    decision: z.object({
      question: words(PLAN_LINE_MAX), suggested: z.array(words(PLAN_LINE_MAX)).max(6).optional(), ifNoAnswer: words(PLAN_LINE_MAX).optional(), detail: z.string().max(4000).optional(),
    }).strict(),
  }).strict(),
  z.object({ type: z.literal('check'), key }).strict(),
  z.object({ type: z.literal('reopen'), key, reason: words(PLAN_LINE_MAX - REOPENED.length), expected: echoed(), rev: rev.optional() }).strict(),
]);

const STATUS_FOR: Record<PlanFileError['code'], number> = { not_found: 404, invalid: 400, conflict: 409 };

/**
 * The plan as the app shows it, from the store this workspace uses: PLAN.md (the switch is off) or the workspace
 * database (moved). A move or restore in progress refuses with the switch's sentence.
 */
export const planForApp = (root: string) => (storeOf(root) === 'database' ? planDbForApp(root) : planFileForApp(root));

/** One change as the person, in the store this workspace uses. */
export const changePlanForApp = (root: string, change: PlanFileAppChange & { rev?: number }) => (storeOf(root) === 'database' ? changePlanDbForApp(root, change) : changePlanFileForApp(root, change));

/** How a failure is answered: the status, and the JSON (`code` says what kind of conflict, for the app). */
export function planErrorAnswer(error: unknown): { status: number; body: Record<string, unknown> } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PlanDbChangeError) return { status: error.status, body: { error: message, code: error.code, ...(error.detail ? { detail: error.detail } : {}), ...('current' in error ? { current: (error as { current: unknown }).current } : {}) } };
  if (error instanceof WorkspaceDbError) return { status: error.code === 'busy' ? 503 : 409, body: { error: message, code: error.code } };
  if (error instanceof WorkspaceMovedError) return { status: 409, body: { error: message, code: 'moved' } };
  if (error instanceof PlanFileError) return { status: STATUS_FOR[error.code], body: { error: message } };
  return { status: /busy in another session/.test(message) ? 409 : 400, body: { error: message } };
}

/** Mounted behind the server's existing local-origin boundary. */
export function registerPlanFileRoutes(app: Hono, resolveWorkspace: (id: string) => Promise<string | null>) {
  const handle = (action: (workspacePath: string, c: Context) => Promise<object>): Handler => async (c) => {
    try {
      const root = await resolveWorkspace(z.string().min(1).parse(c.req.param('id')));
      if (!root) return c.json({ error: 'Workspace not found.' }, 404);
      return c.json(await action(root, c));
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({ error: validationMessage(error) }, 400);
      const answer = planErrorAnswer(error);
      return c.json(answer.body, answer.status as 400);
    }
  };

  app.get('/api/workspace/:id/plan', handle((root) => planForApp(root)));

  app.post('/api/workspace/:id/plan', bodyLimit({ maxSize: 64_000 }), handle(async (root, c) => {
    const { change } = z.object({ change: planFileChangeSchema }).strict().parse(await c.req.json());
    const { message } = await changePlanForApp(root, change);
    return { message, plan: await planForApp(root) };
  }));

  app.post('/api/workspace/:id/plan/decisions/:key/answer', bodyLimit({ maxSize: 64_000 }), handle(async (root, c) => {
    const decisionKey = key.parse(c.req.param('key'));
    const body = z.object({ answer: words(PLAN_LINE_MAX), expected: echoed().optional(), rev: rev.optional() }).strict().parse(await c.req.json());
    let expected = body.expected;
    if (!expected) {
      const currentPlan = await planForApp(root);
      const found = [...currentPlan.decisions, ...currentPlan.checkpoints.flatMap((cp) => cp.decisions)].find((d) => d.key === decisionKey);
      if (!found) throw new PlanFileError(`Nothing in ${PLAN_FILE} matches "${decisionKey}" any more. Read the plan again.`, 'not_found');
      expected = found.question;
    }
    const { message } = await changePlanForApp(root, { type: 'answer', key: decisionKey, answer: body.answer, expected, ...(body.rev !== undefined ? { rev: body.rev } : {}) });
    return { message, plan: await planForApp(root) };
  }));

  app.post('/api/workspace/:id/plan/steps/:key/tick', bodyLimit({ maxSize: 64_000 }), handle(async (root, c) => {
    const stepKey = key.parse(c.req.param('key'));
    const body = z.object({ done: z.boolean(), expected: echoed().optional(), rev: rev.optional() }).strict().parse(await c.req.json());
    let expected = body.expected;
    if (!expected) {
      const currentPlan = await planForApp(root);
      const found = [...currentPlan.steps, ...currentPlan.checkpoints.flatMap((cp) => cp.steps)].find((s) => s.key === stepKey)
        ?? currentPlan.checkpoints.find((cp) => cp.key === stepKey);
      if (!found) throw new PlanFileError(`Nothing in ${PLAN_FILE} matches "${stepKey}" any more. Read the plan again.`, 'not_found');
      expected = 'text' in found ? found.text : found.title;
    }
    const { message } = await changePlanForApp(root, { type: 'tick', key: stepKey, done: body.done, expected, ...(body.rev !== undefined ? { rev: body.rev } : {}) });
    return { message, plan: await planForApp(root) };
  }));

  // Says which step is being worked on, or (clear) that none is. Local state; PLAN.md is not touched.
  app.post('/api/workspace/:id/plan/now', bodyLimit({ maxSize: 4_000 }), handle(async (root, c) => {
    const body = z.union([z.object({ key }).strict(), z.object({ clear: z.literal(true) }).strict()]).parse(await c.req.json());
    const { message } = await changePlanForApp(root, 'key' in body ? { type: 'now', key: body.key } : { type: 'now-clear' });
    return { message, plan: await planForApp(root) };
  }));

  app.post('/api/workspace/:id/plan/checkpoints/:key/check', handle(async (root, c) => {
    const checkpointKey = key.parse(c.req.param('key'));
    const currentPlan = await planForApp(root);
    if (!currentPlan.checkpoints.some((cp) => cp.key === checkpointKey)) {
      throw new PlanFileError(`Nothing in ${PLAN_FILE} matches "${checkpointKey}" any more. Read the plan again.`, 'not_found');
    }
    const { message } = await changePlanForApp(root, { type: 'check', key: checkpointKey });
    return { message, plan: await planForApp(root) };
  }));
}
