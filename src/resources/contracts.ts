import { z } from 'zod';

export const RESOURCE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const resourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(RESOURCE_ID_PATTERN, 'Use lowercase letters, numbers, and single hyphens only.');

export const CODEX_AGENT_NAME_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export const codexAgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(CODEX_AGENT_NAME_PATTERN, 'Use lowercase letters, numbers, hyphens, and underscores only.');

const nonEmptyString = z.string().trim().min(1);

export const skillFrontmatterSchema = z
  .object({
    name: resourceIdSchema,
    description: nonEmptyString.max(1024),
    license: z.string().trim().max(1024).optional(),
    compatibility: z.string().trim().max(500).optional(),
    title: z.string().trim().max(120).optional(),
    category: resourceIdSchema.optional(),
    tags: z.array(nonEmptyString.max(64)).max(32).optional(),
    'allowed-tools': z.union([z.array(nonEmptyString.max(128)).max(32), nonEmptyString]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const skillCategorySchema = z
  .object({
    id: resourceIdSchema,
    name: nonEmptyString.max(120),
    description: z.string().trim().max(1024).default(''),
    icon: z.string().trim().max(120).optional(),
    color: z.string().trim().max(64).optional(),
    custom: z.boolean().optional(),
    isTemplate: z.boolean().optional(),
    skills: z.array(resourceIdSchema).max(1000).optional(),
  })
  .strict();

export const codexAgentInputSchema = z
  .object({
    id: codexAgentNameSchema.optional(),
    name: codexAgentNameSchema,
    category: resourceIdSchema.default('general'),
    description: nonEmptyString.max(1024),
    developerInstructions: nonEmptyString.max(100_000),
    model: nonEmptyString.max(120).optional(),
    modelReasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
    sandboxMode: z.enum(['read-only', 'workspace-write']).optional(),
  })
  .strict();

export const codexAgentTomlSchema = z
  .object({
    name: codexAgentNameSchema,
    description: nonEmptyString.max(1024),
    developer_instructions: nonEmptyString.max(100_000),
    model: nonEmptyString.max(120).optional(),
    model_reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
    sandbox_mode: z.enum(['read-only', 'workspace-write']).optional(),
  })
  .strict();

/**
 * Version 2 is the first whose `enabledCategories` the app means: the categories a workspace subscribes to.
 * Version 1 files hold every category the old app registered, so a reader must ignore them.
 */
export const workspaceResourcesConfigSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]).default(1),
    revision: z.number().int().nonnegative().default(0),
    enabledSkills: z.array(resourceIdSchema).max(1000).default([]),
    disabledSkills: z.array(resourceIdSchema).max(1000).default([]),
    enabledAgents: z.array(codexAgentNameSchema).max(1000).default([]),
    enabledCategories: z.array(resourceIdSchema).max(1000).default([]),
  })
  .strict();

const managedHashAndPath = {
  path: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.number().int().min(0).max(0o777).optional(),
};

export const managedOutputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('skill'),
    resourceId: resourceIdSchema,
    adapter: z.enum([
      'agent-skill-v1',
      'claude-skill-v1',
      // Legacy adapters retained for backward compatibility and clean lock pruning
      'codex-skill-v1',
      'copilot-skill-v1',
      'cursor-skill-v1',
    ]),
    ...managedHashAndPath,
  }),
  z.object({
    kind: z.literal('codex-agent'),
    resourceId: codexAgentNameSchema,
    adapter: z.literal('codex-agent-v1'),
    ...managedHashAndPath,
  }),
]);

export const resourceLockSchema = z
  .object({
    schemaVersion: z.literal(1),
    outputs: z.array(managedOutputSchema),
  })
  .strict();

export type CodexAgentInput = z.infer<typeof codexAgentInputSchema>;
export type WorkspaceResourcesConfigData = z.infer<typeof workspaceResourcesConfigSchema>;
export type ManagedOutput = z.infer<typeof managedOutputSchema>;
export type ResourceLock = z.infer<typeof resourceLockSchema>;

export function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`)
    .join('; ');
}
