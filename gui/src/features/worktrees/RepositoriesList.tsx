import { GitBranch, Wrench } from 'lucide-react';

import { IconButton } from '../../components/ui/icon-button.js';
import type { RepoWorktreeGroup } from './types.js';
import { isOffBranch } from './branchDrift.js';

export interface RepositoriesListProps {
  groups: readonly RepoWorktreeGroup[];
  /** Offered for a repository that is still your own checkout: make an editable copy for this workspace. */
  onPrepare?: (repoName: string) => void;
}

/**
 * The repositories of a workspace and the branch each is on, one plain line each. A repository
 * that is still your own checkout says so and offers the one thing to do about it. There are no
 * cards, no titles to edit and no tree: the editable copy and your original are the same
 * repository here, so only the one in use is shown.
 */
export function RepositoriesList({ groups, onPrepare }: RepositoriesListProps) {
  if (groups.length === 0) return <p className="px-1 py-1 text-[11px] text-muted-foreground">No repositories.</p>;
  return (
    <ul aria-label="Repositories" className="space-y-0.5">
      {groups.map((group) => {
        const current = group.worktrees[0];
        const changed = current?.dirtyFilesCount ?? null;
        const state = group.isHostRepo ? 'read-only' : changed === null ? '' : changed === 0 ? 'clean' : `${changed} changed`;
        return (
          <li key={group.repoName} className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px]" title={current?.worktreePath}>
            <GitBranch aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-foreground">{group.repoName}</span>
              <span className="block truncate font-mono text-[10px] text-muted-foreground">{current?.branchName ?? 'unknown'}</span>
              {/* Not "on the wrong branch": the person may have switched on purpose. It says what the workspace is for and lets them judge. */}
              {!group.isHostRepo && isOffBranch(current) && (
                <span className="block truncate text-[10px] text-warning" data-testid={`off-branch-${group.repoName}`}>
                  workspace edits on <span className="font-mono">{current?.expectedBranch}</span>
                </span>
              )}
            </span>
            {state && <span className={group.isHostRepo ? 'shrink-0 text-warning' : 'shrink-0 text-muted-foreground'}>{state}</span>}
            {group.isHostRepo && onPrepare && (
              <IconButton label={`Prepare ${group.repoName} for editing`} icon={<Wrench />} onClick={() => onPrepare(group.repoName)} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
