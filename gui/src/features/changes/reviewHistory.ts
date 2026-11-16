export interface ReviewHistoryMarker {
  workspace: string;
  token: string;
}

const RETIRED_STORAGE_KEY = 'contextspace.review.retired-tokens.v1';
const MAX_RETIRED = 100;

const liveTokens = new Set<string>();
const retiredTokens = new Set<string>();
let activeSession: { workspace: string; token: string; locationKey: string } | null = null;
let tokenCounter = 0;

function readRetiredStorage(): string[] {
  if (typeof sessionStorage === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(RETIRED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeRetiredStorage(tokens: Iterable<string>): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    const list = Array.from(tokens).slice(-MAX_RETIRED);
    sessionStorage.setItem(RETIRED_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Ignore storage errors (private mode, quota, SSR).
  }
}

function syncRetiredFromStorage(): void {
  for (const token of readRetiredStorage()) retiredTokens.add(token);
}

/** Extracts the Review history marker from a React Router location state object, if valid. */
export function readReviewMarker(state: unknown): ReviewHistoryMarker | null {
  if (!state || typeof state !== 'object') return null;
  const candidate = (state as Record<string, unknown>).__review;
  if (!candidate || typeof candidate !== 'object') return null;
  const { workspace, token } = candidate as Record<string, unknown>;
  if (typeof workspace !== 'string' || !workspace || typeof token !== 'string' || !token) return null;
  return { workspace, token };
}

/** Builds a history state carrying the Review marker while omitting ephemeral dock navigation marks. */
export function buildReviewHistoryState(currentState: unknown, marker: ReviewHistoryMarker): Record<string, unknown> {
  const base = currentState && typeof currentState === 'object' ? { ...(currentState as Record<string, unknown>) } : {};
  delete base.chatDock;
  return { ...base, __review: marker };
}

/** Removes the Review marker (and any stale dock navigation mark) from a location state object. */
export function stripReviewHistoryState(currentState: unknown): Record<string, unknown> | null {
  if (!currentState || typeof currentState !== 'object') return null;
  const next = { ...(currentState as Record<string, unknown>) };
  delete next.__review;
  delete next.chatDock;
  return Object.keys(next).length > 0 ? next : null;
}

/** Allocates a fresh session-scoped Review history token for the given workspace. */
export function createReviewToken(workspace: string): string {
  tokenCounter += 1;
  const token = `rv-${workspace}-${tokenCounter}-${Math.random().toString(36).slice(2, 8)}`;
  liveTokens.add(token);
  return token;
}

/** Permanently retires a Review history token so navigating back to its history entry never reopens Review. */
export function retireReviewToken(token: string): void {
  if (!token) return;
  liveTokens.delete(token);
  retiredTokens.add(token);
  writeRetiredStorage(retiredTokens);
  if (activeSession?.token === token) activeSession = null;
}

/** Records or clears which workspace's Review history entry is currently open. */
export function setActiveReviewSession(session: { workspace: string; token: string; locationKey: string } | null): void {
  activeSession = session;
}

/** Returns the currently active Review session, if any. */
export function getActiveReviewSession(): { workspace: string; token: string; locationKey: string } | null {
  return activeSession;
}

/** Retires the active Review session if navigation moved to a different workspace (or outside workspaces). */
export function retireReviewIfWorkspaceChanged(currentWorkspace: string | null | undefined): string | null {
  if (!activeSession || activeSession.workspace === currentWorkspace) return null;
  const previousWorkspace = activeSession.workspace;
  retireReviewToken(activeSession.token);
  activeSession = null;
  return previousWorkspace;
}

/** Checks whether a location state represents an active, non-retired Review history entry for `workspace`. */
export function isActiveReviewEntry(
  state: unknown,
  workspace: string,
  live: ReadonlySet<string> = liveTokens,
  retired: ReadonlySet<string> = retiredTokens,
): boolean {
  const marker = readReviewMarker(state);
  if (!marker || marker.workspace !== workspace) return false;
  syncRetiredFromStorage();
  return live.has(marker.token) && !retired.has(marker.token);
}

/** Test-only reset for isolated unit tests. */
export function resetReviewHistoryForTests(): void {
  liveTokens.clear();
  retiredTokens.clear();
  activeSession = null;
  tokenCounter = 0;
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.removeItem(RETIRED_STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
  }
}
