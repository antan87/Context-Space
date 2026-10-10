/**
 * @module plan-generator
 * Writes contextspace-plan.md: the plan summary (core/plan-summary), and for a workspace with
 * several repositories the build order between them, from their package dependencies.
 */

import chalk from 'chalk';
import { BUILD_ORDER_HEADING, writePlanSummary } from '../core/plan-summary.js';
import type {
  WorkspaceContext,
  ProjectAnalysis,
  RepoInfo,
  DependencyNode,
  DependencyGraph,
} from '../types.js';
import { renderFreshnessBanner } from '../core/generation-lock.js';
import { PRIMARY_PLAN_FILE, BRAND_NAME, CLI_NAME } from '../core/constants.js';
import { findInterRepoDependencies } from '../analyzers/detect-deps.js';

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

/**
 * The build order between the workspace's repositories, as the last section of contextspace-plan.md,
 * or an empty string for one repository or none: there is nothing to order. It is supporting
 * technical information, not the delivery plan, which is the plan's milestones.
 */
export function renderBuildOrder(ctx: WorkspaceContext): string {
  const { repos, analysis } = ctx;
  if (repos.length < 2) return '';
  const md: string[] = [BUILD_ORDER_HEADING, ''];
  if (ctx.generation) md.push(renderFreshnessBanner(ctx.generation), '');

  if (!analysis || analysis.size === 0) {
    md.push(`No project analysis was available, so no order is known. Repos: ${repos.map((r) => r.name).sort().join(', ')}.`, '');
    return md.join('\n');
  }

  const graph = buildDependencyGraph(analysis, repos);
  const phases = topologicalSort(graph);
  const hasEdges = [...graph.values()].some((n) => n.dependsOn.length > 0);
  // Restricted to the repos the graph was built from, so the contracts and the phases agree.
  const contracts = findPackageRelations(analysis, repos).filter((rel) => rel.consumers.length > 0);

  if (!hasEdges && contracts.length === 0) {
    md.push(
      `No package dependencies were detected between the ${repos.length} repos in this workspace, so no build order is forced — work in whichever order suits the task.`,
      `If you add a dependency from one of these repos to another, run \`${CLI_NAME} refresh\` and this section will describe the resulting order.`, '');
    return md.join('\n');
  }

  /** Repos in this phase that depend on another repo in the same phase. */
  const cycleMembers = (phase: string[]): string[] => {
    const inPhase = new Set(phase);
    return phase.filter((name) => (graph.get(name)?.dependsOn ?? []).some((dep) => inPhase.has(dep)));
  };
  const hasCycles = phases.some((phase) => cycleMembers(phase).length > 0);

  md.push(`> Worked out by ${BRAND_NAME} from the package dependencies between repos. It is not the delivery plan: that is the milestones above. Runtime and intra-repo contracts are not inferred; see knowledge.`);
  md.push(hasEdges && !hasCycles
    ? '> Follow the phase order to avoid blocking yourself on cross-repo dependencies.'
    : '> No build order could be resolved, so the packages below are listed without one.');
  md.push('');

  if (hasEdges) {
    if (!hasCycles) {
      md.push('### Dependency diagram', '', '```mermaid', 'graph TD');
      const alias = buildAliasMap(graph);
      for (const [name, node] of graph) {
        if (node.dependsOn.length === 0 && node.dependedOnBy.length === 0) md.push(`    ${alias.get(name)}["${name}"]`);
        // Arrow: dependency → dependent (dep is built first)
        for (const dep of node.dependsOn) md.push(`    ${alias.get(dep)}["${dep}"] --> ${alias.get(name)}["${name}"]`);
      }
      md.push('```', '');
      md.push('> Derived from detected package dependencies (`package.json`, `.csproj`, etc.) only. If you changed a package, the producing repo must release or build before consumer repos can merge.', '');

      md.push('### Suggested order', '');
      for (let i = 0; i < phases.length; i++) {
        const phase = phases[i]!;
        md.push(`#### Phase ${i + 1}`, '', `**Repos:** ${phase.join(', ')}`, '');
        if (i === 0) {
          // Only claim downstream consumers for the repos that actually have them.
          const consumed = phase.filter((name) => (graph.get(name)?.dependedOnBy.length ?? 0) > 0);
          md.push(consumed.length > 0
            ? `**Why first:** No dependencies on other workspace repos, and ${consumed.join(', ')} ${consumed.length === 1 ? 'is' : 'are'} depended on by a later phase.`
            : '**Why first:** No dependencies on other workspace repos.');
        } else if (i === phases.length - 1) {
          md.push(`**Why ${ordinalWord(i + 1)}:** Depends on APIs and types from earlier phases.`);
        } else {
          const prevPhases = phases.slice(0, i).flat().join(', ');
          md.push(`**Why ${ordinalWord(i + 1)}:** Depends on Phase ${i === 1 ? '1' : `1–${i}`} repos (${prevPhases}). Build these before the consumers.`);
        }
        md.push('');
      }
    } else {
      md.push('### Release coordination', '',
        'These repositories contain circular package dependencies; that does not require removing valid service relationships.',
        `Record the intended release order in the plan, one milestone per step (\`${CLI_NAME} plan add milestone\`): build the changed producer against compatible published clients, publish its new package, then bump and verify consumers.`,
        'For breaking contracts, introduce a compatible transition or coordinate releases explicitly. Package edges alone cannot determine a safe release order.', '');
    }

    md.push('### Dependency table', '', '| Repo | Depends On | Depended On By |', '|:---|:---|:---|');
    for (const name of phases.flat()) {
      const node = graph.get(name)!;
      md.push(`| ${name} | ${node.dependsOn.join(', ') || '—'} | ${node.dependedOnBy.join(', ') || '—'} |`);
    }
    md.push('');
  }

  // Only packages a sibling repo actually consumes: a package nobody in the workspace uses is not a contract.
  if (contracts.length > 0) {
    const anyContributing = contracts.some((c) => (c.contributing?.length ?? 0) > 0);
    md.push('### Contracts and clients', '');
    md.push(anyContributing
      ? '| Package | Contributing Projects | Producing Repo | Consuming Repos | Type |'
      : '| Package | Producing Repo | Consuming Repos | Type |');
    md.push(anyContributing ? '|:---|:---|:---|:---|:---|' : '|:---|:---|:---|:---|');
    for (const rel of contracts) {
      const cells = [`\`${rel.pkgName}\``];
      if (anyContributing) cells.push(rel.contributing?.length ? rel.contributing.map((c) => `\`${c}\``).join(', ') : '—');
      cells.push(`\`${rel.producer}\``, rel.consumers.map((c) => `\`${c.repoName}\``).join(', '), `\`${rel.type}\``);
      md.push(`| ${cells.join(' | ')} |`);
    }
    md.push('');

    // Only the ecosystems the shared packages use.
    const types = new Set(contracts.map((c) => c.type));
    md.push('### Local package development loop', '', 'When changing a shared package, verify its consumers against a local build before pushing:', '');
    if (types.has('nuget')) {
      md.push('#### .NET / NuGet',
        '1. `dotnet pack -c Release -o ./local-packages` in the producing project.',
        '2. Point a local feed in the consumer\'s `NuGet.config` at `./local-packages`.',
        '3. Reference a local version (e.g. `3.41.0-local`) in the consuming `.csproj`.',
        '4. **Revert the version reference to the official release before merging.**', '');
    }
    if (types.has('npm')) {
      md.push('#### Node.js / npm',
        '1. `npm link` in the producing package, then `npm link <package-name>` in the consumer.',
        '2. **Unlink and reinstall the published version before committing.**', '');
    }
  }
  return md.join('\n');
}

/**
 * Writes contextspace-plan.md: the brief and the plan in the Plan tab's words (core/plan-summary),
 * then the build order between repositories, which needs the analysis only a refresh has.
 *
 * @param ctx            The current workspace context (feature + repos + analysis).
 * @param workspacePath  Absolute path to the workspace root directory.
 */
export async function generateImplementationPlan(
  ctx: WorkspaceContext,
  workspacePath: string,
): Promise<void> {
  try {
    await writePlanSummary(workspacePath, { buildOrder: renderBuildOrder(ctx) });
    console.log(chalk.green('  ✔'), `Generated ${PRIMARY_PLAN_FILE}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red('  ✖'), `Failed to generate implementation plan: ${message}`);
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
