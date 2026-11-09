import * as path from 'node:path';
import { loadFeatureConfig } from './workspace.js';
import { resolveFeatureRepoPath } from '../utils/feature.js';

/** An explicit repository selector could not identify one configured repository. */
export class DocumentScopeInputError extends Error {}

/** Select a read root by configured repository identity; omitted selectors retain workspace behavior. */
export async function resolveDocumentRoot(workspaceRoot: string, repo?: string): Promise<string> {
  if (repo === undefined) return workspaceRoot;
  if (!repo || repo.trim() !== repo || repo === '.' || repo === '..' || /[\\/:\x00-\x1f\x7f]/.test(repo)) {
    throw new DocumentScopeInputError('Invalid repository selector.');
  }
  const feature = await loadFeatureConfig(workspaceRoot);
  if (!feature || !Array.isArray(feature.repos)) {
    throw new DocumentScopeInputError('Repository configuration is unavailable.');
  }
  const matches = feature.repos.filter((entry) => typeof entry === 'string' && path.basename(entry) === repo);
  if (matches.length !== 1) {
    throw new DocumentScopeInputError(matches.length ? 'Ambiguous repository selector.' : 'Unknown repository selector.');
  }
  return resolveFeatureRepoPath(feature, workspaceRoot, matches[0]!);
}
