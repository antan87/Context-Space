import { useSyncExternalStore } from 'react';

/** A repository file, as the server's reference resolver names it. */
export interface RepoFile {
  repoName: string;
  repoPath: string;
  file: string;
}

/**
 * What the Code section is asked to show. A clicked path is answered at once with `locating`, so the
 * click always visibly does something, and then with what the server found: the file, the files it
 * could mean, or why there is none.
 */
export type CodeRequest =
  | { kind: 'locating'; path: string; line?: number }
  | ({ kind: 'file'; line?: number } & RepoFile)
  | { kind: 'ambiguous'; path: string; line?: number; candidates: RepoFile[] }
  | { kind: 'not-found'; path: string; line?: number; reason: 'missing' | 'directory' | 'outside-repositories' | 'error'; absolutePath?: string; message?: string };

export interface OpenRequest<T> {
  /** Grows with every request, so asking for the same file twice still counts as a new request. */
  id: number;
  request: T;
}

/**
 * Requests to open something in a workspace's side panel. The terminal and the progress strip live
 * in the chat dock, above the router, while the Code and Docs sections live in the page; this is
 * how one hands the other a path. The latest request per workspace is kept, so a section that
 * mounts after the click still sees it.
 */
function createRequestStore<T>() {
  const latest = new Map<string, OpenRequest<T>>();
  const listeners = new Set<() => void>();
  let counter = 0;
  return {
    open(workspace: string, request: T): number {
      counter += 1;
      latest.set(workspace, { id: counter, request });
      for (const listener of listeners) listener();
      return counter;
    },
    get(workspace: string): OpenRequest<T> | null {
      return latest.get(workspace) ?? null;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const codeRequests = createRequestStore<CodeRequest>();
export const documentRequests = createRequestStore<{ name: string }>();

/** Asks for the Code window of a workspace to open. `opener` is where the keyboard returns when it closes. */
export interface CodeWindowRequest { opener: HTMLElement | null; /** When it was asked, so a window that mounts a moment later (another workspace) still opens for it. */ at: number; /** Made together with a move to this workspace, so the window that mounts there is the one asked for. */ navigated: boolean }
export const codeWindowRequests = createRequestStore<CodeWindowRequest>();

/**
 * Opens the Code window. With a file, it opens on that file (the Code section answers the same request a clicked path makes);
 * without one, on whatever it showed last, or the first change.
 */
export function openCodeWindow(workspace: string, options: { opener?: HTMLElement | null; file?: RepoFile & { line?: number }; navigated?: boolean } = {}): number {
  if (options.file) codeRequests.open(workspace, { kind: 'file', ...options.file });
  const held = typeof document !== 'undefined' ? document.activeElement : null;
  return codeWindowRequests.open(workspace, { opener: options.opener ?? (held instanceof HTMLElement && held !== document.body ? held : null), at: Date.now(), navigated: options.navigated === true });
}

const openWindows = new Set<string>();
const openListeners = new Set<() => void>();
/** The Code window says whether it is open, so the Board can rest its own polling of the same listing meanwhile. */
export function setCodeWindowOpen(workspace: string, open: boolean): void {
  if (open === openWindows.has(workspace)) return;
  if (open) openWindows.add(workspace); else openWindows.delete(workspace);
  for (const listener of openListeners) listener();
}
export function useCodeWindowOpen(workspace: string): boolean {
  return useSyncExternalStore((listener) => { openListeners.add(listener); return () => { openListeners.delete(listener); }; }, () => openWindows.has(workspace), () => false);
}

export function useCodeWindowRequest(workspace: string): OpenRequest<CodeWindowRequest> | null {
  return useSyncExternalStore(codeWindowRequests.subscribe, () => codeWindowRequests.get(workspace), () => null);
}

export function useCodeRequest(workspace: string): OpenRequest<CodeRequest> | null {
  return useSyncExternalStore(codeRequests.subscribe, () => codeRequests.get(workspace), () => null);
}

export function useDocumentRequest(workspace: string): OpenRequest<{ name: string }> | null {
  return useSyncExternalStore(documentRequests.subscribe, () => documentRequests.get(workspace), () => null);
}
