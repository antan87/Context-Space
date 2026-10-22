/**
 * @module generators/skills-generator
 * Generates harness-specific agent skills/rules (e.g. for Claude, Antigravity, Cursor, Copilot, Codex)
 * dynamically based on workspace analysis and workspace skills configuration.
 */

import type { AIAssistant, WorkspaceContext, ProjectAnalysis, SkillItem } from '../types.js';
import { getAllSkills, getWorkspaceSkillsConfig } from '../utils/skills-catalog.js';
import { getAllAgents } from '../resources/agents-catalog.js';
import { reconcileWorkspaceResources } from '../resources/materializer.js';
import { isDefaultSkillsConfig, resolveWorkspaceSkills, workspaceOnlySkillIds } from '../resources/selection.js';
import { resolveActiveDomainRules } from '../core/domain-packs.js';

/**
 * Checks if the workspace has cross-repo package dependencies.
 */
function hasCrossRepoDependencies(analysis: Map<string, ProjectAnalysis>): boolean {
  const produced = new Set<string>();
  for (const [, a] of analysis) {
    if (a.produces && Array.isArray(a.produces)) {
      for (const p of a.produces) {
        if (p && p.name) {
          produced.add(p.name.toLowerCase());
        }
      }
    }
  }

  for (const [, a] of analysis) {
    if (Array.isArray(a.dependencies)) {
      for (const dep of a.dependencies) {
        if (dep && dep.name && produced.has(dep.name.toLowerCase())) {
          return true;
        }
      }
    } else if (a.dependencies && typeof a.dependencies === 'object') {
      for (const depName of Object.keys(a.dependencies)) {
        if (produced.has(depName.toLowerCase())) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Checks if any workspace project produces packages that have consumer repos.
 */
function hasProducedPackagesWithConsumers(analysis: Map<string, ProjectAnalysis>): boolean {
  return hasCrossRepoDependencies(analysis);
}

/**
 * Generates local package loop skill instructions.
 */
function getLocalPackageLoopSkill(analysis: Map<string, ProjectAnalysis>): string {
  let pkgManagerInfo = '';
  const hasNuget = Array.from(analysis.values()).some((a) =>
    a.techStack?.languages?.includes('csharp'),
  );
  const hasNpm = Array.from(analysis.values()).some(
    (a) =>
      a.techStack?.languages?.includes('typescript') || a.techStack?.languages?.includes('javascript'),
  );

  if (hasNuget) {
    pkgManagerInfo += `### NuGet / C# local loop:
1. **Pack locally**: Run \`dotnet pack -c Release -o ./local-packages\` inside the producing project folder.
2. **Add local feed**: Ensure the consumer project's directory has a local NuGet feed configured pointing to the \`local-packages\` directory at the workspace root.
3. **Reference local version**: Update the consumer's package reference in its \`.csproj\` to point to the local version (e.g., \`1.0.0-local\`).
4. **Revert**: Ensure you revert the package reference to the official release version before submitting code.
`;
  }
  if (hasNpm) {
    pkgManagerInfo += `### npm / JS/TS local loop:
1. **Pack locally**: Run \`npm pack\` inside the producing package directory.
2. **Copy / Reference**: Copy the generated \`.tgz\` file to a \`local-packages/\` directory.
3. **Reference local version**: Run \`npm install ../local-packages/my-package-1.0.0.tgz\` or reference it in \`package.json\`.
4. **Revert**: Revert the local reference to the official registry package before submitting code.
`;
  }

  return `# Local Package Development Loop

This skill guides the AI assistant through local package testing across repositories in this workspace.

## Workflow

When modifying a shared package in one repository, you must test its effect on downstream consumer repositories before pushing.

${pkgManagerInfo}
## Guidelines
- **Leave a TODO comment**: Always write a \`// TODO: Revert local package loop reference\` comment in the consumer code so you don't commit temporary local reference modifications.
- **Do not commit local-packages**: The \`local-packages/\` folder is workspace-local and must not be committed to Git.
`;
}

/**
 * Generates release ordering skill instructions.
 */
function getReleaseOrderingSkill(ctx: WorkspaceContext): string {
  const { analysis } = ctx;
  const lines: string[] = [];

  lines.push('# Release and Merge Ordering Guidelines');
  lines.push('');
  lines.push(
    'This guideline answers what repositories must be merged and released in what order when cross-repo dependencies are modified.',
  );
  lines.push('');
  lines.push('## Dependency Chains');

  if (analysis) {
    for (const [pathKey, a] of analysis) {
      if (a.produces && a.produces.length > 0) {
        for (const p of a.produces) {
          const consumers: string[] = [];
          for (const [otherPath, otherA] of analysis) {
            if (otherPath === pathKey) continue;
            for (const dep of otherA.dependencies) {
              if (dep.name.toLowerCase() === p.name.toLowerCase()) {
                consumers.push(otherA.name);
              }
            }
          }
          if (consumers.length > 0) {
            lines.push(`- **Product**: \`${p.name}\``);
            lines.push(`  - **Producer**: \`${a.name}\` (Must build and release first)`);
            lines.push(
              `  - **Consumers**: ${consumers.map((c) => `\`${c}\``).join(', ')} (Must be bumped and released after the producer)`,
            );
          }
        }
      }
    }
  }

  lines.push('');
  lines.push('## Reversion Check');
  lines.push(
    '- Before merging a consumer branch, verify that all local package loop references are replaced by official versions.',
  );

  return lines.join('\n');
}

/**
 * Generates local runtime verifier instructions.
 */
function getVerifierSkill(ctx: WorkspaceContext): string {
  const { analysis } = ctx;
  const lines: string[] = [];

  lines.push('# Workspace Local Runtime Verifier');
  lines.push('');
  lines.push('Guidelines to safely launch, mock, and verify services locally in this workspace.');
  lines.push('');

  let hasInfraWarnings = false;

  if (analysis) {
    for (const [, a] of analysis) {
      if (a.runConfig && a.runConfig.sharedInfraWarnings.length > 0) {
        if (!hasInfraWarnings) {
          lines.push('## ⚠️ Shared Infrastructure Warnings');
          hasInfraWarnings = true;
        }
        for (const warning of a.runConfig.sharedInfraWarnings) {
          lines.push(`- **${a.name}**: ${warning.warning}`);
        }
      }
    }
  }

  lines.push('');
  lines.push('## Verification Recipe');
  lines.push('1. **Check local ports**: Ensure target ports do not conflict.');
  lines.push('2. **Run mocks**: Spin up local databases/caches before starting services.');
  lines.push(
    '3. **Watch out for shared staging environment**: Never publish messages or write data to staging infrastructure while testing locally unless explicitly requested.',
  );

  return lines.join('\n');
}

/**
 * Generates custom skills/rules for each selected AI assistant.
 *
 * @param ctx           - The workspace context.
 * @param assistants    - The active AI assistant harnesses. Skills go to both skill folders whichever they are;
 *                        the assistants only decide the Codex agent files.
 * @param workspacePath - The workspace root directory.
 */
export async function generateSkills(
  ctx: WorkspaceContext,
  assistants: AIAssistant[],
  workspacePath: string,
): Promise<void> {
  const { analysis } = ctx;

  // 1. Get enabled skills config and catalog
  const wsConfig = await getWorkspaceSkillsConfig(workspacePath);
  const [catalogSkills, catalogAgents] = await Promise.all([
    getAllSkills(workspacePath),
    getAllAgents(),
  ]);

  // 2. Build dynamic skills from codebase analysis
  const dynamicSkills: SkillItem[] = [];
  if (analysis) {
    const hasDeps = hasCrossRepoDependencies(analysis);
    const hasProds = hasProducedPackagesWithConsumers(analysis);
    const hasRunConfig = Array.from(analysis.values()).some(
      (a) => a.runConfig && a.runConfig.entryPoints.length > 0,
    );

    if (hasDeps) {
      dynamicSkills.push({
        id: 'nexusflow-local-package-loop',
        name: 'nexusflow-local-package-loop',
        title: 'Local Package Development Loop',
        category: 'cross-repo-release',
        description: 'Guides testing cross-repo package dependencies locally without publishing.',
        content: getLocalPackageLoopSkill(analysis),
        custom: false,
      });
    }

    if (hasProds) {
      dynamicSkills.push({
        id: 'nexusflow-release-ordering',
        name: 'nexusflow-release-ordering',
        title: 'Release and Merge Ordering Guidelines',
        category: 'cross-repo-release',
        description: 'Answers what repositories must be merged and released in what order.',
        content: getReleaseOrderingSkill(ctx),
        custom: false,
      });
    }

    if (hasRunConfig) {
      dynamicSkills.push({
        id: 'verifier-workspace',
        name: 'verifier-workspace',
        title: 'Local Runtime Verifier',
        category: 'testing-qa',
        description: 'Guidelines to safely launch, mock, and verify services locally.',
        content: getVerifierSkill(ctx),
        custom: false,
      });
    }
  }

  const domainSkillIds: string[] = [];
  if (ctx.feature?.domainPacks && ctx.feature.domainPacks.length > 0) {
    const { domainPacks } = resolveActiveDomainRules(ctx.feature.organizationId, ctx.feature.domainPacks);
    for (const pack of domainPacks) domainSkillIds.push(...(pack.skills ?? []));
  }

  // 3. Determine which skills to deploy (see resolveWorkspaceSkills):
  // - In fresh workspaces (revision === 0, not opted out), automatically recommend dynamic skills and
  //   the skills written inside the workspace.
  // - Once a user has saved an explicit configuration (revision > 0) or marked skills as disabled,
  //   respect their persisted choice and do not force-deploy deselected skills.
  const autoSkillIds = isDefaultSkillsConfig(wsConfig) ? dynamicSkills.map((skill) => skill.id) : [];
  const { skills: skillsToDeploy, missing: missingSkills } = resolveWorkspaceSkills(wsConfig, catalogSkills, {
    generated: dynamicSkills,
    ids: [...autoSkillIds, ...workspaceOnlySkillIds(wsConfig, catalogSkills), ...domainSkillIds],
  });
  if (missingSkills.length) {
    throw new Error(`Selected skills are no longer available: ${missingSkills.join(', ')}`);
  }

  const agentMap = new Map(catalogAgents.map((agent) => [agent.id, agent]));
  const enabledAgentIds = new Set(wsConfig.enabledAgents ?? []);
  const missingAgents = [...enabledAgentIds].filter((id) => !agentMap.has(id));
  if (missingAgents.length) {
    throw new Error(`Selected agents are no longer available: ${missingAgents.join(', ')}`);
  }
  const agentsToDeploy = [...enabledAgentIds].map((id) => agentMap.get(id)!);

  await reconcileWorkspaceResources(workspacePath, assistants, skillsToDeploy, agentsToDeploy);
}
