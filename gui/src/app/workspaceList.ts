import type { Feature } from '../types.js';
import { chatHomeTarget } from '../features/chat/chatHomeTarget.js';

/** Whether a workspace belongs to the archived list. */
export const isArchivedWorkspace = (workspace: Pick<Feature, 'archivedAt'> | null | undefined): boolean => Boolean(workspace?.archivedAt);

type Listed = Pick<Feature, 'archivedAt' | 'name' | 'branchName' | 'description' | 'repos'>;

/**
 * The workspaces in the Jump-to list: the active ones first, then the archived records, each marked, so a search
 * never opens a read-only record by mistake and typing "archived" finds them all.
 */
export function jumpTargets(workspaces: readonly Listed[]): Array<{ title: string; detail: string; route: string }> {
  const ordered = [...workspaces.filter((workspace) => !isArchivedWorkspace(workspace)), ...workspaces.filter(isArchivedWorkspace)];
  return ordered.map((workspace) => ({
    title: workspace.name || workspace.branchName,
    detail: `${isArchivedWorkspace(workspace) ? 'Archived · ' : ''}${workspace.repos.length} repositories · ${workspace.name ? workspace.branchName : workspace.description || 'Open workspace'}`,
    route: `/workspaces/${encodeURIComponent(workspace.branchName)}`,
  }));
}

/**
 * The workspaces the sidebar lists. Without a search it is the active list or the archived list. A search looks
 * through both: someone who types a name wants that workspace, and should not have to know which list holds it.
 */
export function workspacesForList<T extends Listed>(workspaces: readonly T[], showArchived: boolean, search: string): T[] {
  const query = search.trim().toLowerCase();
  if (!query) return workspaces.filter((workspace) => isArchivedWorkspace(workspace) === showArchived);
  return workspaces.filter((workspace) => {
    const repos = workspace.repos?.join(' ') ?? '';
    return `${workspace.name ?? ''} ${workspace.branchName} ${workspace.description ?? ''} ${repos}`.toLowerCase().includes(query);
  });
}

/**
 * Where the bare /workspaces address goes: the workspace being read while it still exists, else the chat the person
 * was last in, else the first active workspace. Only active workspaces count, so a deleted workspace's address is not
 * returned to and an archived record is never the default. Null when there is none, which sends the person to start one.
 */
export function defaultWorkspaceTarget(
  activeIds: readonly string[],
  current: string | null,
  lastChat: string | null,
  openTabs: readonly string[],
): string | null {
  if (current && activeIds.includes(current)) return current;
  return chatHomeTarget(lastChat, openTabs, activeIds) ?? activeIds[0] ?? null;
}

/** The open session tabs that belong to an archived workspace: a record has no session, so none of them should stay. */
export function archivedTabs(openTabs: readonly string[], workspaces: readonly Pick<Feature, 'archivedAt' | 'branchName' | 'id'>[]): string[] {
  const archived = new Set(workspaces.filter(isArchivedWorkspace).flatMap((workspace) => [workspace.branchName, workspace.id]));
  return openTabs.filter((tab) => archived.has(tab));
}
