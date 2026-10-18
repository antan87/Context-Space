/**
 * The short name a workspace goes by on the Overview. A workspace without a name used to show its whole description,
 * a paragraph longer than what it introduced; a description of a line or less still reads as a name.
 */
import type { Feature } from '../../types.js';

/** Longest description that still reads as a name. */
const NAME_LIKE = 60;

export function workspaceTitle(workspace: Pick<Feature, 'name' | 'description' | 'branchName'>, customTitle?: string): string {
  const custom = customTitle?.trim();
  if (custom) return custom;
  const name = workspace.name?.trim();
  if (name) return name;
  const firstLine = workspace.description?.trim().split('\n')[0]?.trim() ?? '';
  if (firstLine && firstLine.length <= NAME_LIKE) return firstLine;
  const words = workspace.branchName.replace(/^(feat|fix|chore)\//, '').replace(/[-_/]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : workspace.branchName;
}
