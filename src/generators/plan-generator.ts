/**
 * @module plan-generator
 * Analyzes inter-repo dependencies within a workspace and generates a
 * `nexusflow-plan.md` implementation plan with build-order phases.
 */

import chalk from 'chalk';
import { loadWorkspaceState } from '../core/workspace-state.js';
import { loadWorkspaceLifecycle, renderLifecyclePlan } from '../core/lifecycle.js';
import { loadWorkGuidance } from '../core/work-guidance.js';
import { planStoreExists } from '../core/plan.js';
import { PLANNING_NOTES_FILE, planningNotesAreAuthored } from '../core/planning-notes.js';
import { writeWorkspaceFile } from '../core/storage.js';
import { findInterRepoDependencies } from '../analyzers/detect-deps.js';
import type {
  WorkspaceContext,
  ProjectAnalysis,
  RepoInfo,
  DependencyNode,
  DependencyGraph,
  WorkspaceLifecycle,
} from '../types.js';
import { GENERATED_SNAPSHOT_HEADER, renderFreshnessBanner } from '../core/generation-lock.js';
import { PRIMARY_PLAN_FILE, PRIMARY_KNOWLEDGE_FILE, PRIMARY_CHAT_LEDGER_FILE, BRAND_NAME, CLI_NAME } from '../core/constants.js';

// ─── Dependency Graph Builder ─────────────────────────────────────────────

/**
 * Build a dependency graph by analysing package dependencies
 * across the workspace repos.
 *
 * @param analysis  Per-repo analysis results, keyed by repo path.
 * @param repos     Metadata for every repo in the workspace.
 * @returns A map of repo name → {@link DependencyNode}.
 */
export function buildDependencyGraph(
  analysis: Map<string, ProjectAnalysis>,
  repos: RepoInfo[],
): DependencyGraph {
  const graph: DependencyGraph = new Map();

  // ── Initialise a node for each repo ──────────────────────────────────
  for (const repo of repos) {
    graph.set(repo.name, {
      repoName: repo.name,
      repoPath: repo.path,
      dependsOn: [],
      dependedOnBy: [],
    });
  }

  // ── Edges, from the one shared inference ─────────────────────────────
  // This used to re-implement the package matching that
  // `findInterRepoDependencies` already does, and the two drifted: the other
  // copy grew a substring fallback, so `AGENTS.md` claimed "Start with `core`"
  // for a workspace whose `nexusflow-plan.md` said no dependencies were
  // detected at all. Two generated files contradicting each other is worse than
  // either being wrong alone, because an assistant has no way to pick. One
  // function now answers the question for both.
  const inScope = new Map<string, ProjectAnalysis>();
  const repoNames = new Map<string, string>();
  for (const repo of repos) {
    const a = analysis.get(repo.path);
    if (a) {
      inScope.set(repo.path, a);
      repoNames.set(repo.path, repo.name);
    }
  }

  for (const [consumer, providers] of findInterRepoDependencies(inScope, repoNames)) {
    for (const provider of providers) {
      addEdge(graph, consumer, provider);
    }
  }

  return graph;
}

// ─── Topological Sort ─────────────────────────────────────────────────────

/**
 * Topologically sort the dependency graph into build phases.
 * Each phase is a group of repos that can be built in parallel
 * because all of their dependencies appear in earlier phases.
 *
 * If a cycle is detected, the remaining nodes are placed in a final phase
 * with a warning logged to the console.
 *
 * @param graph  The workspace dependency graph.
 * @returns An array of phases, where each phase is an array of repo names.
 */
export function topologicalSort(graph: DependencyGraph): string[][] {
  // Calculate in-degrees
  const inDegree = new Map<string, number>();
  for (const [name, node] of graph) {
    inDegree.set(name, node.dependsOn.length);
  }

  const phases: string[][] = [];
  const placed = new Set<string>();

  while (placed.size < graph.size) {
    // Collect nodes whose in-degree is 0 and haven't been placed yet
    const phase: string[] = [];
    for (const [name, degree] of inDegree) {
      if (degree === 0 && !placed.has(name)) {
        phase.push(name);
      }
    }

    // Cycle detection — no zero-in-degree nodes remain
    if (phase.length === 0) {
      const remaining = [...graph.keys()].filter((n) => !placed.has(n));
      console.log(
        chalk.yellow('  ⚠'),
        `Dependency cycle detected among: ${remaining.join(', ')}`,
      );
      phases.push(remaining);
      break;
    }

    phase.sort(); // Deterministic ordering within a phase
    phases.push(phase);

    // "Remove" placed nodes and decrement dependents' in-degrees
    for (const name of phase) {
      placed.add(name);
      const node = graph.get(name)!;
      for (const dependent of node.dependedOnBy) {
        inDegree.set(dependent, (inDegree.get(dependent) ?? 1) - 1);
      }
    }
  }

  return phases;
}

// ─── Plan Generator ───────────────────────────────────────────────────────

/** Stated near the top of every layout, so nobody takes a build order for a delivery plan. */
const PLAN_SCOPE_NOTE =
  `> **Scope:** Any package-dependency order in this file is supporting technical information, not a feature delivery plan. Release order: ${PLANNING_NOTES_FILE}. Runtime and intra-repo contracts are not inferred; see knowledge.`;

/**
 * The "Current work and next action" block: what this workspace is for, where the authoritative
 * assignment lives, and whether a delivery plan exists. Rendered for every repo count, ahead of
 * any package-dependency material, so a reader who opens this file for "the plan" finds the work
 * before the build order.
 *
 * @param authoredNotes  Whether contextspace-milestones.md holds more than its empty template.
 */
function workspaceWorkGuidance(
  ctx: WorkspaceContext,
  lifecycle: WorkspaceLifecycle | undefined,
  guidance: Awaited<ReturnType<typeof loadWorkGuidance>>,
  authoredNotes: boolean,
): string[] {
  const assignment = guidance.assignment;
  const inline = (value: string) => value.replace(/\s+/g, ' ').trim();
  const objective = inline(assignment.objective || ctx.feature.description);
  const current = lifecycle?.steps.find((step) => step.id === lifecycle.currentStepId && step.status !== 'completed')
    ?? lifecycle?.steps.find((step) => step.status === 'in_progress' || step.status === 'verified')
    ?? lifecycle?.steps.find((step) => step.status !== 'completed');
  const lines = ['## Current work and next action', ''];
  lines.push(`- **Assignment (${assignment.stage}):** ${objective || 'Define the current objective in the AI assignment.'}`);
  lines.push(`- **Expected output:** ${inline(assignment.expectedOutput) || 'Define this in the AI assignment before starting work.'}`);
  lines.push(`- **Stop when:** ${inline(assignment.stopCondition) || 'Define this in the AI assignment before starting work.'}`);
  if (!ctx.repos.length) lines.push(`- **Repository:** None attached. Add one with \`${CLI_NAME} add-repo\`, then refresh before implementation.`);
  if (current) {
    const milestoneTitle = inline(current.title);
    lines.push(`- **Milestone:** ${milestoneTitle} (${current.status.replaceAll('_', ' ')}).`);
    const action = current.status === 'blocked'
      ? `Resolve the milestone blocker before continuing: ${inline(current.unblockCondition || '') || 'review the unblock condition in Visual Flow'}.`
      : current.status === 'pending'
        ? `Review ${milestoneTitle}, then start it in Visual Flow or with \`${CLI_NAME} flow --step ${current.id} --action start\`. Starting records progress; it does not run the work.`
        : current.status === 'verified'
          ? `Review the verification evidence, then complete ${milestoneTitle} in Visual Flow or with \`${CLI_NAME} flow --step ${current.id} --action complete\`.`
          : `Work toward ${milestoneTitle}; check the assignment's stop condition, then verify before completing the milestone.`;
    lines.push(`- **Next action:** ${action}`);
  } else if (lifecycle?.steps.length) {
    lines.push('- **Next action:** All saved milestones are complete. Review the assignment and add another outcome only if work remains.');
  } else if (authoredNotes) {
    lines.push(`- **Delivery plan:** No milestones are saved in Visual Flow, but authored planning notes exist in ${PLANNING_NOTES_FILE}. They are proposals until the owner approves them.`);
    lines.push(`- **Next action:** Read ${PLANNING_NOTES_FILE} before planning anything new. To track its outcomes as milestones, use Plan → Add milestones; saving them does not start work or approve anything.`);
  } else {
    const title = objective ? `${objective.slice(0, 100).trimEnd()}${objective.length > 100 ? '…' : ''}` : 'Define the first reviewable outcome';
    lines.push(`- **Delivery plan:** Feature delivery plan not yet defined. No milestones are saved and ${PLANNING_NOTES_FILE} is still empty.`);
    lines.push('- **Next action:** Check the live Visual Flow. If no milestone is saved, review the example below and use Plan → Add milestones to draft one.');
    lines.push('', '### Example first milestone draft', '');
    lines.push(`- **Title:** ${title}`);
    lines.push('- **Outcome and check:** Describe one observable result and how you will verify it.');
    lines.push('- This example is not a saved milestone. Saving your edited draft creates a pending milestone; it does not start work or approve any source document.');
  }
  lines.push('', `Run ${CLI_NAME} flow for live milestone progress. Read contextspace-assignment.md or run ${CLI_NAME} flow --assignment for the full, current brief.`, '');
  return lines;
}

/**
 * Generate a `nexusflow-plan.md` implementation plan for the workspace.
 *
 * The plan includes:
 * - A Mermaid dependency diagram
 * - Phased implementation order derived from topological sort
 * - A dependency cross-reference table
 * - A package relations table
 * - Actionable local dev tips
 *
 * @param ctx            The current workspace context (feature + repos + analysis).
 * @param workspacePath  Absolute path to the workspace root directory.
 */
export async function generateImplementationPlan(
  ctx: WorkspaceContext,
  workspacePath: string,
): Promise<void> {
  try {
    const { feature, repos, analysis } = ctx;
    const state = await loadWorkspaceState(workspacePath);
    // The milestones live in the plan store; an older lifecycle is moved there on first load.
    const lifecycle = state.lifecycle || await planStoreExists(workspacePath)
      ? await loadWorkspaceLifecycle(workspacePath, { includeFleet: false }) : undefined;
    const milestonePlan = lifecycle ? renderLifecyclePlan(lifecycle, false) : '';
    // Every repo count gets the current work. Gating this on a single repo left a multi-repo
    // workspace, which needs its objective at least as much, with only a build order.
    const workGuidance = workspaceWorkGuidance(
      ctx,
      lifecycle,
      await loadWorkGuidance(workspacePath),
      await planningNotesAreAuthored(workspacePath),
    );


    // ── Fallback: no analysis available ─────────────────────────────────
    if (!analysis || analysis.size === 0 || repos.length === 0) {
      const lines = [
        GENERATED_SNAPSHOT_HEADER,
        '',
        `# Implementation Plan — ${feature.id}`,
        '', milestonePlan, '', ...workGuidance,
        ...(ctx.generation ? [renderFreshnessBanner(ctx.generation), ''] : []),
        `> Auto-generated by ${BRAND_NAME}.`,
        '> No project analysis data was available, so repos are listed alphabetically.',
        PLAN_SCOPE_NOTE,
        '',
        '## Repos',
        '',
        ...repos
          .map((r) => r.name)
          .sort()
          .map((n) => `- ${n}`),
        ...(!repos.length ? ['- No repository attached yet.'] : []),
        '',
      ];
      await writeWorkspaceFile(
        workspacePath,
        feature.id,
        PRIMARY_PLAN_FILE,
        lines.join('\n'),
      );
      console.log(chalk.green('  ✔'), `Generated ${PRIMARY_PLAN_FILE}`);
      return;
    }

    // ── Build graph & sort ──────────────────────────────────────────────
    const graph = buildDependencyGraph(analysis, repos);
    const phases = topologicalSort(graph);

    // ── What this plan can actually say ─────────────────────────────────
    // Everything below describes cross-repo structure. With no dependency edges
    // and no shared packages there is nothing to order, and this file used to
    // say so five separate ways: a single-node diagram, a phase whose rationale
    // claimed "other repos depend on them" when none did, an all-dashes table,
    // a contracts table of packages nobody consumed, and a local-package loop
    // for packages with no consumers. One honest sentence replaces all of it.
    const hasEdges = [...graph.values()].some((n) => n.dependsOn.length > 0);
    // Restricted to the repos the graph was built from. Derived from the whole
    // analysis map, a stray entry could produce contracts with no matching edge,
    // so the file promised a phase order it then never printed.
    const contracts = findPackageRelations(analysis, repos).filter((rel) => rel.consumers.length > 0);

    /** Repos in this phase that depend on another repo in the same phase. */
    const cycleMembers = (phase: string[]): string[] => {
      const inPhase = new Set(phase);
      return phase.filter((name) =>
        (graph.get(name)?.dependsOn ?? []).some((dep) => inPhase.has(dep)),
      );
    };

    const md: string[] = [];

    md.push(GENERATED_SNAPSHOT_HEADER);
    md.push('');
    md.push(`# Implementation Plan — ${feature.id}`);
    md.push('', milestonePlan);
    md.push('');
    if (ctx.generation) {
      md.push(renderFreshnessBanner(ctx.generation));
      md.push('');
    }
    md.push(`> **Refresh:** Run \`${CLI_NAME} refresh\`.`);
    md.push(PLAN_SCOPE_NOTE);
    md.push('');

    if (!hasEdges && contracts.length === 0) {
      // Worded per repo count: "between the single repo" and "from one of these
      // repos to another" both read as nonsense for a one-repo workspace.
      md.push(
        repos.length === 1
          ? 'This workspace has one repo. Follow the assignment and milestone below; cross-repo build order does not apply.'
          : `No package dependencies were detected between the ${repos.length} repos in this workspace, so no build order is forced — work in whichever order suits the task.`,
      );
      md.push('');
      md.push(...workGuidance);
      if (repos.length === 1) {
        md.push('## Implementation Guidance');
        md.push('');
        md.push('- **Vertical Slice**: Implement in small, testable increments and verify tests pass after each step.');
        md.push(`- **Non-Linear Iteration**: If unexpected constraints or gotchas emerge, record them with \`${CLI_NAME} knowledge add\` or MCP \`add_knowledge\` (or read/append \`${PRIMARY_KNOWLEDGE_FILE}\` directly if MCP is not connected or CLI is not on PATH).`);
        md.push(`- **Cross-Harness Handoff**: If the MCP server is connected, use \`post_workroom_handoff\` to post milestone updates; otherwise record handoffs in \`${PRIMARY_CHAT_LEDGER_FILE}\` or generate a bundle with \`${CLI_NAME} handoff\`.`);
        md.push('');
      } else {
        md.push(`If you add a dependency from one of these repos to another, run \`${CLI_NAME} refresh\` and this plan will describe the resulting order.`, '');
      }
      await writeWorkspaceFile(workspacePath, feature.id, PRIMARY_PLAN_FILE, md.join('\n'));
      console.log(chalk.green('  ✔'), `Generated ${PRIMARY_PLAN_FILE}`);
      return;
    }

    // The current work comes first; the build order below is the supporting part.
    md.push(...workGuidance);
    md.push('## Package dependency order', '');
    md.push(
      `> Auto-generated by ${BRAND_NAME} based on dependency analysis between repos.`,
    );
    if (hasEdges && !phases.some((phase) => cycleMembers(phase).length > 0)) {
      // Promised only when the phases below actually exist. Gating this on having
      // got past the early return instead meant a workspace with a shared package
      // but no resolvable edge — two repos both claiming to publish it, so the
      // only match is a repo on itself and no edge is added — was told to follow
      // an order the file never printed.
      md.push(
        '> Follow the phase order to avoid blocking yourself on cross-repo dependencies.',
      );
    } else {
      md.push(
        '> No build order could be resolved, so the packages below are listed without one.',
      );
    }
    md.push('');

    if (hasEdges) {
      const hasCycles = phases.some((phase) => cycleMembers(phase).length > 0);
      if (!hasCycles) {
        // ── Mermaid diagram ───────────────────────────────────────────────
        md.push('## Dependency Diagram');
        md.push('');
        md.push('```mermaid');
        md.push('graph TD');

        const alias = buildAliasMap(graph);

        for (const [name, node] of graph) {
          if (node.dependsOn.length === 0 && node.dependedOnBy.length === 0) {
            // Isolated node — still show it
            md.push(`    ${alias.get(name)}["${name}"]`);
          }
          for (const dep of node.dependsOn) {
            // Arrow: dependency → dependent (dep is built first)
            md.push(
              `    ${alias.get(dep)}["${dep}"] --> ${alias.get(name)}["${name}"]`,
            );
          }
        }

        md.push('```');
        md.push('');
        md.push('> ⚠️ This diagram is derived from detected package dependencies (`package.json`, `.csproj`, etc.) only.');
        md.push('> If you changed a package, the producing repo must release/build before consumer repos can merge.');
        md.push('');

        // ── Phase descriptions ────────────────────────────────────────────
        md.push('## Suggested Implementation Order');
        md.push('');

        for (let i = 0; i < phases.length; i++) {
          const phase = phases[i]!;
          const ordinal = ordinalWord(i + 1);

          md.push(`### Phase ${i + 1}`);
          md.push('');
          md.push(`**Repos:** ${phase.join(', ')}`);
          md.push('');

          if (i === 0) {
            // Only claim downstream consumers for the repos that actually have
            // them. The old wording asserted it for every phase-1 repo.
            const consumed = phase.filter((name) => (graph.get(name)?.dependedOnBy.length ?? 0) > 0);
            md.push(
              consumed.length > 0
                ? `**Why first:** No dependencies on other workspace repos, and ${consumed.join(', ')} ${consumed.length === 1 ? 'is' : 'are'} depended on by a later phase.`
                : '**Why first:** No dependencies on other workspace repos.',
            );
          } else if (i === phases.length - 1) {
            md.push(
              `**Why ${ordinal}:** Depends on APIs and types from earlier phases.`,
            );
          } else {
            const prevPhases = phases
              .slice(0, i)
              .flat()
              .join(', ');
            md.push(
              `**Why ${ordinal}:** Depends on Phase ${i === 1 ? '1' : `1–${i}`} repos (${prevPhases}). Build these before the consumers.`,
            );
          }

          md.push('');
        }

      } else {
        md.push('## Release coordination', '',
          'These repositories contain circular package dependencies; that does not require removing valid service relationships.',
          'Record the intended release sequence in `contextspace-milestones.md`: build the changed producer against compatible published clients, publish its new package, then bump and verify consumers.',
          'For breaking contracts, introduce a compatible transition or coordinate releases explicitly. Package edges alone cannot determine a safe release order.', '');
      }

      // ── Dependency table ──────────────────────────────────────────────
      md.push('## Dependency Table');
      md.push('');
      md.push('| Repo | Depends On | Depended On By |');
      md.push('|:---|:---|:---|');

      // Sort repos by phase order for a natural reading experience
      for (const name of phases.flat()) {
        const node = graph.get(name)!;
        const deps = node.dependsOn.length > 0 ? node.dependsOn.join(', ') : '—';
        const rdeps =
          node.dependedOnBy.length > 0 ? node.dependedOnBy.join(', ') : '—';
        md.push(`| ${name} | ${deps} | ${rdeps} |`);
      }

      md.push('');
    }

    // ── Contracts & Clients ─────────────────────────────────────────────
    // Only packages a sibling repo actually consumes. A published package with
    // no workspace consumer is not a cross-repo contract, and rendering it with
    // "_None_" in the consumers column was the largest block of the old file.
    if (contracts.length > 0) {
      const anyContributing = contracts.some((c) => (c.contributing?.length ?? 0) > 0);

      md.push('## 📦 Contracts & Clients');
      md.push('');
      md.push(
        anyContributing
          ? '| Package | Contributing Projects | Producing Repo | Consuming Repos | Type |'
          : '| Package | Producing Repo | Consuming Repos | Type |',
      );
      md.push(anyContributing ? '|:---|:---|:---|:---|:---|' : '|:---|:---|:---|:---|');

      for (const rel of contracts) {
        const cells = [`\`${rel.pkgName}\``];
        if (anyContributing) {
          cells.push(
            rel.contributing && rel.contributing.length > 0
              ? rel.contributing.map((c) => `\`${c}\``).join(', ')
              : '—',
          );
        }
        cells.push(`\`${rel.producer}\``);
        cells.push(rel.consumers.map((c) => `\`${c.repoName}\``).join(', '));
        cells.push(`\`${rel.type}\``);
        md.push(`| ${cells.join(' | ')} |`);
      }
      md.push('');

      // ── Local Package Development Loop ────────────────────────────────
      // Gated on a shared package existing at all, and on the ecosystems those
      // packages actually use. It used to emit both branches whenever the
      // workspace merely contained the language, so a TypeScript-only workspace
      // carried four .NET/NuGet steps — 47% of the plan, none of it applicable.
      const types = new Set(contracts.map((c) => c.type));

      md.push('## 💡 Local Package Development Loop');
      md.push('');
      md.push('When changing a shared package, verify its consumers against a local build before pushing:');
      md.push('');

      if (types.has('nuget')) {
        md.push('### .NET / NuGet');
        md.push('1. `dotnet pack -c Release -o ./local-packages` in the producing project.');
        md.push('2. Point a local feed in the consumer\'s `NuGet.config` at `./local-packages`.');
        md.push('3. Reference a local version (e.g. `3.41.0-local`) in the consuming `.csproj`.');
        md.push('4. **Revert the version reference to the official release before merging.**');
        md.push('');
      }

      if (types.has('npm')) {
        md.push('### Node.js / npm');
        md.push('1. `npm link` in the producing package, then `npm link <package-name>` in the consumer.');
        md.push('2. **Unlink and reinstall the published version before committing.**');
        md.push('');
      }
    }

    // ── Write file ──────────────────────────────────────────────────────
    await writeWorkspaceFile(workspacePath, feature.id, PRIMARY_PLAN_FILE, md.join('\n'));
    console.log(chalk.green('  ✔'), `Generated ${PRIMARY_PLAN_FILE}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      chalk.red('  ✖'),
      `Failed to generate implementation plan: ${message}`,
    );
    throw error;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** A package one repo publishes, with whichever sibling repos consume it. */
interface PackageRelation {
  pkgName: string;
  contributing?: string[];
  producer: string;
  consumers: { repoName: string; version?: string }[];
  type: 'npm' | 'nuget' | 'other';
  feeds?: { name: string; url: string }[];
}

/**
 * Pairs every produced package with the workspace repos that depend on it.
 *
 * Restricted to `repos` so this agrees with {@link buildDependencyGraph}, which
 * also walks only those: derived from the whole analysis map, the two could
 * disagree and the plan would claim a phase order it never printed.
 *
 * Consumers may be empty — the caller decides whether a package with no
 * workspace consumer is worth reporting.
 */
function findPackageRelations(
  analysis: Map<string, ProjectAnalysis>,
  repos: RepoInfo[],
): PackageRelation[] {
  const inScope: [string, ProjectAnalysis][] = [];
  for (const repo of repos) {
    const a = analysis.get(repo.path);
    if (a) inScope.push([repo.path, a]);
  }

  const relations: PackageRelation[] = [];

  for (const [repoPath, a] of inScope) {
    for (const product of a.produces ?? []) {
      const consumers: { repoName: string; version?: string }[] = [];
      for (const [otherPath, otherA] of inScope) {
        if (otherPath === repoPath) continue;
        for (const dep of otherA.dependencies ?? []) {
          if (dep.name.toLowerCase() === product.name.toLowerCase()) {
            consumers.push({ repoName: otherA.name, version: dep.version });
          }
        }
      }
      relations.push({
        pkgName: product.name,
        contributing: product.contributing,
        producer: a.name,
        consumers,
        type: product.type,
        feeds: a.nugetFeeds,
      });
    }
  }

  return relations;
}

/**
 * Add a directed edge: `from` depends on `to`.
 * Idempotent — duplicate edges are ignored.
 */
function addEdge(graph: DependencyGraph, from: string, to: string): void {
  const fromNode = graph.get(from);
  const toNode = graph.get(to);
  if (!fromNode || !toNode) return;

  if (!fromNode.dependsOn.includes(to)) {
    fromNode.dependsOn.push(to);
  }
  if (!toNode.dependedOnBy.includes(from)) {
    toNode.dependedOnBy.push(from);
  }
}

/**
 * Build a short single-letter alias map for Mermaid node IDs.
 * Falls back to sanitised names when there are more than 26 repos.
 */
function buildAliasMap(graph: DependencyGraph): Map<string, string> {
  const map = new Map<string, string>();
  const names = [...graph.keys()].sort();

  if (names.length <= 26) {
    let code = 65; // 'A'
    for (const name of names) {
      map.set(name, String.fromCharCode(code++));
    }
  } else {
    for (const name of names) {
      map.set(name, name.replace(/[^a-zA-Z0-9]/g, '_'));
    }
  }

  return map;
}

/** Return an ordinal word for small numbers, or "nth" for larger ones. */
function ordinalWord(n: number): string {
  const words = ['first', 'second', 'third', 'fourth', 'fifth'];
  if (n >= 1 && n <= words.length) return words[n - 1];
  return `${n}th`;
}
