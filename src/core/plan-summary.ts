/**
 * @module core/plan-summary
 * contextspace-plan.md: a short summary of the plan in the Plan tab's words, for people reading the
 * workspace's files and for AI tools that cannot run `ctxspace plan`. It holds the brief and the plan
 * as `ctxspace plan` prints it, without the recent changes, so rewriting it changes nothing unless
 * the plan or the brief changed. No HTML comments and no boilerplate.
 *
 * It is rewritten after every plan change and every brief change. The build order between
 * repositories, which only a refresh can work out, is the last section and is kept as it is.
 */

import { PRIMARY_PLAN_FILE, CLI_NAME } from './constants.js';
import { readWorkspaceFile, writeWorkspaceFile } from './storage.js';
import { loadFeatureConfig } from './workspace.js';
import { renderPlanText } from './plan-text.js';
import type { PlanDocument } from './plan.js';

/** Starts the last section, which a refresh writes and every other rewrite keeps. */
export const BUILD_ORDER_HEADING = '## Build order between repositories';

export interface PlanSummaryInput {
  workspaceId: string;
  plan: PlanDocument;
  brief: { objective?: string; stage?: string; expectedOutput?: string; stopCondition?: string };
  /** Used as the goal while the brief has no objective. */
  description?: string;
  repoCount: number;
  /** The build-order section, starting with its heading, or nothing. */
  buildOrder?: string;
}

const oneLine = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

export function renderPlanSummary(input: PlanSummaryInput): string {
  const { brief } = input;
  const goal = oneLine(brief.objective) || oneLine(input.description);
  const facts = [
    `- **Goal:** ${goal || `Not set yet. Set it in the brief, or read it with \`${CLI_NAME} flow --assignment\`.`}`,
    ...(brief.stage ? [`- **Stage:** ${brief.stage.charAt(0).toUpperCase()}${brief.stage.slice(1)}`] : []),
    ...(oneLine(brief.expectedOutput) ? [`- **Expected output:** ${oneLine(brief.expectedOutput)}`] : []),
    ...(oneLine(brief.stopCondition) ? [`- **Stop when:** ${oneLine(brief.stopCondition)}`] : []),
    ...(input.repoCount === 0 ? [`- **Repository:** None yet. Add one with \`${CLI_NAME} add-repo\`.`] : []),
  ];
  const lines = [
    `# Plan — ${input.workspaceId}`,
    '',
    `Generated from contextspace-plan.json; do not edit. Read the plan with \`${CLI_NAME} plan\`, change it with \`${CLI_NAME} plan add|start|done|answer|block|later|drop|reopen\`, and see the full brief with \`${CLI_NAME} flow --assignment\`.`,
    '',
    ...facts,
    '',
    '```text',
    renderPlanText(input.plan, { changes: 0 }),
    '```',
    '',
  ];
  if (input.buildOrder?.trim()) lines.push(input.buildOrder.trim(), '');
  return lines.join('\n');
}

/** The build-order section of a summary already written, to keep when the plan changes. */
export function buildOrderOf(content: string): string | undefined {
  const start = content.indexOf(`\n${BUILD_ORDER_HEADING}`);
  return start >= 0 ? content.slice(start + 1) : undefined;
}

/**
 * The summary as it reads now, from the plan and the brief, without writing anything. A missing
 * build order is taken from the file already there.
 */
export async function buildPlanSummary(workspacePath: string, options: { buildOrder?: string } = {}): Promise<string> {
  const feature = await loadFeatureConfig(workspacePath);
  if (!feature) throw new Error('Workspace not found.');
  // Imported here, not at the top: lifecycle and the brief both lead back to this module.
  const { readPlanReadOnly } = await import('./lifecycle.js');
  const { loadWorkGuidance } = await import('./work-guidance.js');
  let buildOrder = options.buildOrder;
  if (buildOrder === undefined) {
    try { buildOrder = buildOrderOf(await readWorkspaceFile(workspacePath, feature.id, PRIMARY_PLAN_FILE)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return renderPlanSummary({
    workspaceId: feature.id,
    plan: await readPlanReadOnly(workspacePath),
    brief: (await loadWorkGuidance(workspacePath)).assignment,
    description: feature.description,
    repoCount: feature.repos.length,
    buildOrder,
  });
}

/** Rewrites contextspace-plan.md when it would read differently. */
export async function writePlanSummary(workspacePath: string, options: { buildOrder?: string } = {}): Promise<void> {
  const feature = await loadFeatureConfig(workspacePath);
  if (!feature) return;
  const content = await buildPlanSummary(workspacePath, options);
  let current: string | undefined;
  try { current = await readWorkspaceFile(workspacePath, feature.id, PRIMARY_PLAN_FILE); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (current !== content) await writeWorkspaceFile(workspacePath, feature.id, PRIMARY_PLAN_FILE, content);
}
