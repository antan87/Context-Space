/**
 * @module plan-generator
 * The order repositories build in, from their package dependencies: which repo depends on which.
 */

import type {
  ProjectAnalysis,
  RepoInfo,
  DependencyNode,
  DependencyGraph,
} from '../types.js';
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
