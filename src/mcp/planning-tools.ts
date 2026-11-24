import { z } from 'zod';
import {
  addWorkDocument, updateWorkDocument, updateWorkGuidance, getWorkContext,
  documentInputSchema, documentMetadataSchema, guidanceUpdateSchema,
} from '../core/work-guidance.js';
import { findWorkspaceRoot, loadFeatureConfig } from '../core/workspace.js';
import type { NexusFlowTool } from './tools.js';
import { applyPlanBatch, planBatchSchema, planDbJson } from '../core/plan-db-command.js';
import { storeOf } from '../core/workspace-db-app.js';
import { readPlanTextReadOnly } from '../core/plan-file-store.js';
import { boardActorName } from '../core/board.js';
import { refreshPlanningContext } from '../core/planning-refresh.js';

/** Publish and validate the same input contract used by the core mutations. */
function planningTool<T extends z.ZodObject>(
  name: string,
  description: string,
  schema: T,
  action: (input: z.output<T>, root: string) => Promise<unknown>,
  hints: { readOnly?: boolean; destructive?: boolean } = {},
): NexusFlowTool {
  const inputSchema = z.toJSONSchema(schema, { io: 'input' });
  return {
    name, description,
    annotations: { readOnlyHint: hints.readOnly ?? false, destructiveHint: hints.destructive ?? false, idempotentHint: hints.readOnly ?? false, openWorldHint: false },
    inputSchema: { ...inputSchema, additionalProperties: false, properties: {
      ...inputSchema.properties,
      workspaceId: { type: 'string', description: 'Optional ID/branchName of the workspace. Defaults to the workspace this server is bound to (or the current directory). Interactive and full sessions may name another workspace; other roles get an error for a different workspace.' },
    } },
    handler: async (args, ctx) => {
      try {
        const { workspaceId: _workspaceId, ...input } = args;
        z.string().optional().parse(_workspaceId);
        const validated = schema.strict().parse(input) as z.output<T>;
        if (!await loadFeatureConfig(ctx.workspacePath)) throw new Error('Workspace not found.');
        const root = (await findWorkspaceRoot(ctx.workspacePath)) ?? ctx.workspacePath;
        storeOf(root); // Refuse transitional workspaces before a tool can change anything.
        const result = await action(validated, root);
        return { ...(result && typeof result === 'object' && 'ok' in result && result.ok === false ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  };
}

const revision = z.number().int().nonnegative();
const addDocumentSchema = documentInputSchema.safeExtend({ revision });
const updateDocumentSchema = documentMetadataSchema.extend({ revision, documentId: z.string().uuid() });

export const planTools: NexusFlowTool[] = [
  planningTool('read_plan',
    'Read the plan. In a moved workspace it returns revision, dbId and stable item ids and revs, and reports pending plan drafts. Use ids and revisions with change_plan.',
    z.object({}), async (_input, root) => {
      return storeOf(root) === 'database' ? planDbJson(root) : readPlanTextReadOnly(root);
    }, { readOnly: true }),
  planningTool('change_plan',
    'Apply an atomic batch of plan and Board ops on a moved workspace. Send the ids, revision and dbId from read_plan, and item or card revs for edits. A refused batch reports the current revision and every refused op. Pass a unique requestId and resend it with the same batch to retry safely. Adds return the requestId used. Removing a card requires ifRevision and dbId.',
    planBatchSchema.extend({ harness: z.string().max(40).optional() }),
    async ({ harness, ...input }, root) => {
      const by = boardActorName(harness);
      return applyPlanBatch(root, input, by && by !== 'user' ? by : 'ai');
    }, { destructive: true }),
];

export const planningTools: NexusFlowTool[] = [
  planningTool('update_work_assignment',
    'Update work type, size, and the current AI assignment, including stage, objective, expected output, stopping point, and optional milestone scope. Read get_work_context first and use guidance.revision. Supply the complete assignment; omit milestoneId for workspace scope. Follow the user-authorized scope; changing a saved stage does not itself grant permission to proceed. Returns the updated context and revision.',
    guidanceUpdateSchema,
    async (input, root) => { await updateWorkGuidance(root, input); return { ...(await getWorkContext(root)), ...(await refreshPlanningContext(root)) }; }),
  planningTool('add_work_document',
    'Attach original Markdown/text or an HTTP(S) document link to the workspace, a milestone, or its project. Read get_work_context for guidance.revision. Provide exactly one of content or url. Documents default to draft; mark approved only when the user has approved the requirements. Links are stored, not fetched. Returns document IDs and the updated guidance revision.',
    addDocumentSchema,
    async ({ revision, ...input }, root) => { await addWorkDocument(root, revision, input); return { ...(await getWorkContext(root)), ...(await refreshPlanningContext(root)) }; }),
  planningTool('update_work_document',
    'Edit an attached source document’s title, role, status, scope, and summary without changing its original content or URL. Read get_work_context for guidance.revision and documentId. Supply the complete metadata; use scope:{} for workspace scope. Use superseded for historical sources. Approval status must reflect the user’s decision. Shared project sources must be edited in their owning workspace.',
    updateDocumentSchema,
    async ({ revision, documentId, ...input }, root) => { await updateWorkDocument(root, documentId, revision, input); return { ...(await getWorkContext(root)), ...(await refreshPlanningContext(root)) }; }),
];
