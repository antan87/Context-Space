/**
 * @module analyzers/index
 * Orchestrates all project analyzers and produces a full ProjectAnalysis
 * for each repository.
 */

import chalk from 'chalk';
import ora from 'ora';

import type { ProjectAnalysis, RepoInfo } from '../types.js';
import {
  loadAnalysisCache,
  saveAnalysisCache,
  getRepoFingerprint,
} from '../core/analysis-cache.js';
import { detectTechStack } from './tech-stack.js';
import { detectDependencies, detectProducedPackages, detectNuGetFeeds } from './detect-deps.js';
import { detectPorts } from './detect-ports.js';
import { detectExistingAIConfigs } from './detect-existing.js';
import { extractReadmeSummary } from './readme-summarizer.js';
import { analyzeRunConfig } from './run-analyzer.js';

/**
 * Runs all analyzers against a single repository and returns
 * a complete {@link ProjectAnalysis}.
 *
 * @param repo - The repo metadata.
 * @returns Full analysis result.
 */
export async function analyzeRepo(repo: RepoInfo): Promise<ProjectAnalysis> {
  // No endpoint or messaging scanning: those two analyzers matched any
  // `.get('literal')` and any `.add('literal')`, so they reported header reads
  // and Set insertions as HTTP routes and queue publishers — including their own
  // doc comments. An assistant reading the repo establishes both accurately, and
  // 65% of the generated map was that noise.
  const [techStack, dependencies, produces, nugetFeeds, ports, existingAIConfigs, readmeSummary, runConfig] =
    await Promise.all([
      detectTechStack(repo.path),
      detectDependencies(repo.path),
      detectProducedPackages(repo.path),
      detectNuGetFeeds(repo.path),
      detectPorts(repo.path),
      detectExistingAIConfigs(repo.path),
      extractReadmeSummary(repo.path),
      analyzeRunConfig(repo.path),
    ]);

  return {
    name: repo.name,
    path: repo.path,
    techStack,
    dependencies,
    produces,
    nugetFeeds,
    ports,
    existingAIConfigs,
    readmeSummary,
    runConfig,
  };
}

/**
 * Analyzes all repos in a list and returns a Map of path → analysis.
 * Shows a progress spinner while running.
 *
 * @param repos - Array of repos to analyze.
 * @returns Map of repo path to {@link ProjectAnalysis}.
 */
export async function analyzeAllRepos(
  repos: RepoInfo[],
): Promise<Map<string, ProjectAnalysis>> {
  const spinner = ora('Analyzing projects...').start();
  const results = new Map<string, ProjectAnalysis>();

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i]!;
    spinner.text = `Analyzing ${chalk.bold(repo.name)} (${i + 1}/${repos.length})...`;

    try {
      const analysis = await analyzeRepo(repo);
      results.set(repo.path, analysis);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      spinner.warn(`Failed to analyze ${repo.name}: ${msg}`);
      spinner.start();
    }
  }

  spinner.succeed(`Analyzed ${chalk.bold(results.size)} projects`);
  return results;
}

/** Result of a cache-aware analysis run. */
export interface CachedAnalysisResult {
  /** Analysis per repo, keyed by repo path (same shape as analyzeAllRepos). */
  analysis: Map<string, ProjectAnalysis>;
  /** Names of repos that were re-analyzed because their content changed. */
  analyzed: string[];
  /** Names of repos whose cached analysis was reused. */
  reused: string[];
}

/**
 * Cache-aware variant of {@link analyzeAllRepos}: reuses the analysis stored
 * in the workspace's `.nexusflow-analysis-cache.json` for every repo whose
 * git fingerprint (HEAD + dirty files) is unchanged, and only re-runs the
 * analyzers for repos that actually changed.
 *
 * @param repos         - Array of repos to analyze.
 * @param workspacePath - Absolute path to the workspace root (cache location).
 * @param options       - Set `force` to ignore the cache and re-analyze everything.
 * @returns The combined analysis map plus which repos were analyzed vs reused.
 */
export async function analyzeAllReposCached(
  repos: RepoInfo[],
  workspacePath: string,
  options: { force?: boolean; saveCache?: boolean } = {},
): Promise<CachedAnalysisResult> {
  const cache = await loadAnalysisCache(workspacePath);
  const results = new Map<string, ProjectAnalysis>();
  const analyzed: string[] = [];
  const reused: string[] = [];

  const spinner = ora('Analyzing projects...').start();

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i]!;
    const fingerprint = await getRepoFingerprint(repo.path);
    const cached = cache.repos[repo.name];

    if (!options.force && fingerprint && cached && cached.fingerprint === fingerprint) {
      results.set(repo.path, { ...cached.analysis, name: repo.name, path: repo.path });
      reused.push(repo.name);
      continue;
    }

    spinner.text = `Analyzing ${chalk.bold(repo.name)} (${i + 1}/${repos.length})...`;
    try {
      const analysis = await analyzeRepo(repo);
      results.set(repo.path, analysis);
      analyzed.push(repo.name);
      if (fingerprint) {
        cache.repos[repo.name] = {
          repoName: repo.name,
          fingerprint,
          analyzedAt: new Date().toISOString(),
          analysis,
        };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      spinner.warn(`Failed to analyze ${repo.name}: ${msg}`);
      spinner.start();
    }
  }

  try {
    if (options.saveCache !== false) await saveAnalysisCache(workspacePath, cache, repos.map((r) => r.name));
  } catch {
    // Cache persistence is best-effort; analysis results are still valid.
  }

  if (reused.length > 0) {
    spinner.succeed(
      `Analyzed ${chalk.bold(analyzed.length)} project${analyzed.length === 1 ? '' : 's'}, ` +
      `reused cached analysis for ${chalk.bold(reused.length)} unchanged`,
    );
  } else {
    spinner.succeed(`Analyzed ${chalk.bold(results.size)} projects`);
  }

  return { analysis: results, analyzed, reused };
}

// Re-export individual analyzers
export { detectTechStack } from './tech-stack.js';
export { detectDependencies, findInterRepoDependencies, detectNuGetFeeds } from './detect-deps.js';
export { detectPorts } from './detect-ports.js';
export { detectExistingAIConfigs } from './detect-existing.js';
export { extractReadmeSummary } from './readme-summarizer.js';
export { analyzeRunConfig } from './run-analyzer.js';
