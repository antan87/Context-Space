import { z } from 'zod';
import {
  addWorkDocument, updateWorkDocument, updateWorkGuidance, getWorkContext,
  documentInputSchema, documentMetadataSchema, guidanceUpdateSchema,
} from '../core/work-guidance.js';
import { loadFeatureConfig } from '../core/workspace.js';
import type { NexusFlowTool } from './tools.js';
import { refreshPlanningContext } from '../core/planning-refresh.js';

/** Publish and validate the same input contract used by the core mutations. */
function planningTool<T extends z.ZodObject>(
  name: string,
  description: string,
  schema: T,
  action: (input: z.output<T>, root: string) => Promise<unknown>,
  destructiveHint = false,
): NexusFlowTool {
  const inputSchema = z.toJSONSchema(schema, { io: 'input' });
  return {
    name, description,
    annotations: { readOnlyHint: false, destructiveHint, idempotentHint: false, openWorldHint: false },
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
        const result = await action(validated, ctx.workspacePath);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  };
}

const revision = z.number().int().nonnegative();
const addDocumentSchema = documentInputSchema.safeExtend({ revision });
const updateDocumentSchema = documentMetadataSchema.extend({ revision, documentId: z.string().uuid() });

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
