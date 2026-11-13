import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api/client.js';
import type { CommitDetail, CommitDetailFile } from '../board/commitContext.js';
import { buildCompactedTree, flattenTreeFiles } from './FileTree.js';
import type { CommitRef } from './commitsMode.js';

/** The commit as the server describes it, from the same read-only route the Board's commit cards always used. */
export function useCommitDetail(workspace: string, commit: CommitRef | null) {
  return useQuery({
    queryKey: ['board-commit', workspace, commit?.repo, commit?.sha],
    queryFn: ({ signal }) => apiFetch<CommitDetail>(`/api/workspace/${encodeURIComponent(workspace)}/commits/${encodeURIComponent(commit!.repo)}/${encodeURIComponent(commit!.sha)}`, { signal }),
    enabled: Boolean(commit),
    retry: false,
    // A commit's files and text never change, but whether it is pushed (and its forge link) does, also by a push from the terminal
    // that the app is not told about: read it again each time it is shown. Cached data stays on screen while it is read, so nothing moves.
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

export interface CommitTreeFile { file: string; type: string; additions?: number; deletions?: number; oldPath?: string; binary: boolean }
export const treeFileOf = (file: CommitDetailFile): CommitTreeFile => ({
  file: file.path,
  type: file.status === 'modified' || file.status === 'other' ? 'modified' : file.status,
  additions: file.additions ?? undefined,
  deletions: file.deletions ?? undefined,
  oldPath: file.oldPath && file.oldPath !== file.path ? file.oldPath : undefined,
  binary: file.additions === null && file.deletions === null,
});

/** The commit's changed files in the order the tree shows them, so stepping goes down the tree. */
export function orderedCommitFiles(detail: CommitDetail | undefined): string[] {
  if (!detail) return [];
  return flattenTreeFiles(buildCompactedTree(detail.files.map(treeFileOf))).map((file) => file.file);
}

