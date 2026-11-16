import { useCallback, useSyncExternalStore } from 'react';

/**
 * What a person has typed or chosen in the Finish form of one workspace: the message, the pull request choice and the reason for
 * finishing anyway. Kept per workspace for the session, outside the form, so switching the Code window to Commits (or opening a
 * file) and back finds it as it was left, and nothing of it shows in another workspace.
 */
export interface FinishDraft {
  message: string;
  createPrs: boolean;
  overriding: boolean;
  reason: string;
}

const FRESH: FinishDraft = { message: '', createPrs: true, overriding: false, reason: '' };
const drafts = new Map<string, FinishDraft>();
const listeners = new Set<() => void>();

export const finishDraftOf = (workspace: string): FinishDraft => drafts.get(workspace) ?? FRESH;

export function patchFinishDraft(workspace: string, patch: Partial<FinishDraft>): void {
  drafts.set(workspace, { ...finishDraftOf(workspace), ...patch });
  for (const listener of listeners) listener();
}

export function resetFinishDrafts(): void {
  drafts.clear();
  for (const listener of listeners) listener();
}

export function useFinishDraft(workspace: string): [FinishDraft, (patch: Partial<FinishDraft>) => void] {
  const draft = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => finishDraftOf(workspace),
    () => FRESH,
  );
  const patch = useCallback((next: Partial<FinishDraft>) => patchFinishDraft(workspace, next), [workspace]);
  return [draft, patch];
}
