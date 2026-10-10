import { GitBranch } from 'lucide-react';
import { RepositoriesList } from '../features/worktrees/RepositoriesList.js';
import type { RepoWorktreeGroup } from '../features/worktrees/types.js';

interface RepositoriesToggleProps {
  branch: string;
  open: boolean;
  /** One of its repositories is still the developer's own checkout, which has to be prepared before it can be edited. */
  needsPreparing: boolean;
  /** One of its folders is on a different branch than the one this workspace edits on. */
  branchChanged?: boolean;
  onToggle: () => void;
}

function toggleTitle(needsPreparing: boolean, branchChanged: boolean): string {
  if (needsPreparing && branchChanged) return 'Repositories and branches: one is still your own checkout and needs preparing, and another is on a different branch than this workspace edits on';
  if (needsPreparing) return 'Repositories and branches: one is still your own checkout and needs preparing before it can be edited';
  if (branchChanged) return 'Repositories and branches: one is on a different branch than this workspace edits on';
  return 'Repositories and branches';
}

/** The button on a workspace's row that folds its repositories and branches open. */
export function RepositoriesToggle({ branch, open, needsPreparing, branchChanged = false, onToggle }: RepositoriesToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="relative p-1 rounded hover:bg-background text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary cursor-pointer"
      title={toggleTitle(needsPreparing, branchChanged)}
      aria-label={`${open ? 'Hide' : 'Show'} repositories and branches for ${branch}${branchChanged ? ' (a branch has changed)' : ''}`}
    >
      <GitBranch size={12} aria-hidden="true" />
      {(needsPreparing || branchChanged) && <span aria-hidden="true" className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-500" />}
    </button>
  );
}

interface RepositoriesPanelProps {
  groups: readonly RepoWorktreeGroup[];
  /** An archived workspace is a record, so its repositories cannot be prepared for editing. */
  archived: boolean;
  onPrepare: (repoName: string) => void;
}

/** Its repositories and branches, folded out under the row. */
export function RepositoriesPanel({ groups, archived, onPrepare }: RepositoriesPanelProps) {
  return (
    <div className="mt-1 mb-1 ml-2 border-l border-border/60 pl-2">
      <RepositoriesList groups={groups} onPrepare={archived ? undefined : onPrepare} />
    </div>
  );
}
