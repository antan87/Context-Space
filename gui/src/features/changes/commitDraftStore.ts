import { useCallback, useSyncExternalStore } from 'react';
import type { CommitRepoResult } from '../../types.js';

/**
 * What a person has done in the commit form of one workspace: whether it is open, the message, the files they unticked, the
 * push choice and the last results. Kept per workspace for the session, outside the Code section (which is rebuilt when
 * another workspace is chosen), so leaving a workspace and coming back finds the form as it was left, and nothing of it ever
 * shows up in another workspace.
 */
export interface CommitDraft {
  open: boolean;
  message: string;
  excluded: ReadonlySet<string>;
  push: boolean;
  results: CommitRepoResult[] | null;
}

const FRESH: CommitDraft = { open: false, message: '', excluded: new Set(), push: true, results: null };
const drafts = new Map<string, CommitDraft>();
const listeners = new Set<() => void>();

export const commitDraftOf = (workspace: string): CommitDraft => drafts.get(workspace) ?? FRESH;

export function patchCommitDraft(workspace: string, patch: Partial<CommitDraft>): void {
  drafts.set(workspace, { ...commitDraftOf(workspace), ...patch });
  for (const listener of listeners) listener();
}

export function resetCommitDrafts(): void {
  drafts.clear();
  for (const listener of listeners) listener();
}

export function useCommitDraft(workspace: string): [CommitDraft, (patch: Partial<CommitDraft>) => void] {
  const draft = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => commitDraftOf(workspace),
    () => FRESH,
  );
  const patch = useCallback((next: Partial<CommitDraft>) => patchCommitDraft(workspace, next), [workspace]);
  return [draft, patch];
}
