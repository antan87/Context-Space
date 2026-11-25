/** Shared contract for the CLI's plan view and batch and their MCP tools. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertWorkspaceActive } from './archive-guard.js';
import { planDbParts } from './plan-db-app.js';
import { PlanFileError } from './plan-file.js';
import { planFileToJson } from './plan-file-text.js';
import { loadFeatureConfig } from './workspace.js';
import { readAppDb, storeOf } from './workspace-db-app.js';
import { pendingDraftInfo } from './workspace-db-drafts.js';
import { runDbWrite } from './workspace-db-write.js';
import { OP_FIELDS, planView, type Op, type PlanViewOptions } from './workspace-db/index.js';

export const planBatchSchema = z.object({
  ops: z.array(z.unknown()).describe(`All or none. Ops: ${Object.keys(OP_FIELDS).join(', ')}. Use ids from read_plan or ctxspace plan.`),
  ifRevision: z.number().int().nonnegative().optional().describe('Refuse if the workspace revision has changed since you read it.'),
  dbId: z.string().min(1).optional().describe('The dbId from your read. Required with ifRevision or any row rev.'),
  requestId: z.string().optional().describe('Use the same id and batch when retrying a request whose result you did not receive.'),
}).strict();

export function requirePlanDatabase(root: string): void {
  if (storeOf(root) === 'files') {
    throw new PlanFileError('This workspace still uses PLAN.md; edit the file or use the individual ctxspace plan commands.', 'invalid');
  }
}

export async function applyPlanBatch(root: string, input: unknown, by: string) {
  requirePlanDatabase(root);
  const feature = await loadFeatureConfig(root);
  assertWorkspaceActive(feature, 'change the plan');
  const { ops, ...options } = planBatchSchema.parse(Array.isArray(input) ? { ops: input } : input);
  const batch = ops as Op[];
  const requestId = options.requestId ?? (batch.some((op) => op?.op === 'card.add' || op?.op === 'add') ? randomUUID() : undefined);
  // Validate each op in the store, together with all the others. Its refusal names every invalid op.
  return runDbWrite(root, { type: 'batch', ops: batch, options: { ...options, by, requestId, strictRevision: options.ifRevision !== undefined } });
}

export function planDbText(root: string, options?: PlanViewOptions): Promise<string> {
  return readAppDb(root, (view) => planView(view, options).trimEnd());
}

export async function planDbJson(root: string) {
  const { read, checks, now } = await planDbParts(root, 0);
  const { pendingDrafts } = await readAppDb(root, pendingDraftInfo);
  return {
    ...planFileToJson({ ...read, source: 'file' }, checks, read.revs),
    store: 'database' as const, revision: read.revision, dbId: read.dbId, now, pendingDrafts,
    ...(pendingDrafts ? { notice: 'Plan drafts are pending. Run ctxspace plan drafts to see them.' } : {}),
  };
}
