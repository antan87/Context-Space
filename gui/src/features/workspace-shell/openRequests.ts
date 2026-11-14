import { useSyncExternalStore } from 'react';
import type { CommitOpen } from '../changes/commitsMode.js';

/** A repository file, as the server's reference resolver names it. */
export interface RepoFile {
  repoName: string;
  repoPath: string;
  file: string;
}
export type ReferenceTarget = { origin: { kind: 'workspace'; workspacePath: string } | { kind: 'repository'; repoName: string; repoPath: string }; file: string; viewer: 'reader' | 'code' };
let intent = 0;
export function invalidateReferenceIntent(): number { return ++intent; }
export function referenceIntentIsCurrent(value: number): boolean { return value === intent; }
/** Delivery may wait for React or a workspace mount; recheck at the consumer, too. */
export function referenceRequestIsCurrent(request: { intent?: number }): boolean { return request.intent === undefined || referenceIntentIsCurrent(request.intent); }

/**
 * What the Code section is asked to show. A clicked path is answered at once with `locating`, so the
 * click always visibly does something, and then with what the server found: the file, the files it
 * could mean, or why there is none.
 */
export type CodeRequest = { intent?: number } & (
  | { kind: 'locating'; path: string; line?: number }
  | ({ kind: 'file'; line?: number } & RepoFile)
  | { kind: 'ambiguous'; path: string; line?: number; candidates: ReferenceTarget[]; truncated: boolean; opener: HTMLElement | null }
  | { kind: 'not-found'; path: string; line?: number; reason: 'missing' | 'directory' | 'outside-roots' | 'error'; absolutePath?: string; message?: string });

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
    acknowledge(workspace: string, id: number): void {
      if (latest.get(workspace)?.id !== id) return;
      latest.delete(workspace);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const codeRequests = createRequestStore<CodeRequest>();
export const documentRequests = createRequestStore<{ name: string; repo?: { name: string; path: string }; opener?: HTMLElement | null; intent?: number }>();

/** How to locate an equivalent opener element if the original node was replaced while Code was open. */
export interface OpenerTarget {
  kind: 'reader' | 'node' | 'terminal' | 'testid';
  scope: string;
  inNote?: boolean;
  tag: string;
  href: string | null;
  text: string;
  ariaLabel: string | null;
  occurrence: number;
}

function isFocusableElement(el: Element | null | undefined): el is HTMLElement {
  return Boolean(el && el.isConnected && !el.closest('[inert], [hidden]') && !el.hasAttribute('disabled'));
}

function matchesSignature(el: HTMLElement, tag: string, href: string | null, text: string, ariaLabel: string | null): boolean {
  if (el.tagName.toLowerCase() !== tag) return false;
  if (el.getAttribute('href') !== href) return false;
  if ((el.textContent ?? '').trim() !== text) return false;
  if (ariaLabel !== null && el.getAttribute('aria-label') !== ariaLabel) return false;
  return true;
}

/** Captures a fallback identity while the opening element is still attached to the DOM. */
export function describeOpener(element: HTMLElement | null): OpenerTarget | null {
  if (!element || typeof document === 'undefined' || !element.isConnected) return null;
  const tag = element.tagName.toLowerCase();
  const href = element.getAttribute('href');
  const text = (element.textContent ?? '').trim();
  const ariaLabel = element.getAttribute('aria-label');

  const reader = element.closest<HTMLElement>('[data-board-reader][data-reader-doc]');
  if (reader) {
    const readerDoc = reader.getAttribute('data-reader-doc') ?? '';
    const inNote = Boolean(element.closest('#board-reader-note'));
    const scopeRoot = inNote ? (reader.querySelector<HTMLElement>('#board-reader-note') ?? reader) : reader;
    const candidates = Array.from(scopeRoot.querySelectorAll<HTMLElement>(tag)).filter(
      (el) => Boolean(el.closest('#board-reader-note')) === inNote && matchesSignature(el, tag, href, text, ariaLabel),
    );
    return { kind: 'reader', scope: readerDoc, inNote, tag, href, text, ariaLabel, occurrence: Math.max(0, candidates.indexOf(element)) };
  }

  const node = element.closest<HTMLElement>('.react-flow__node[data-id]');
  if (node) {
    const nodeId = node.getAttribute('data-id') ?? '';
    const candidates = Array.from(node.querySelectorAll<HTMLElement>(tag)).filter(
      (el) => matchesSignature(el, tag, href, text, ariaLabel),
    );
    return { kind: 'node', scope: nodeId, tag, href, text, ariaLabel, occurrence: Math.max(0, candidates.indexOf(element)) };
  }

  if (element.classList.contains('xterm-helper-textarea') && element.closest('[data-testid="terminal-pane"]')) {
    return { kind: 'terminal', scope: 'terminal-pane', tag, href: null, text: '', ariaLabel, occurrence: 0 };
  }

  const testId = element.getAttribute('data-testid');
  if (testId) {
    return { kind: 'testid', scope: testId, tag, href: null, text, ariaLabel, occurrence: 0 };
  }

  return null;
}

/** Finds the live replacement for a captured opener inside the same reader document, board node, or control. */
export function findOpenerTarget(target: OpenerTarget | null | undefined, doc: Pick<Document, 'querySelector' | 'querySelectorAll'> | undefined = typeof document !== 'undefined' ? document : undefined): HTMLElement | null {
  if (!target || !doc) return null;

  if (target.kind === 'reader') {
    const reader = Array.from(doc.querySelectorAll<HTMLElement>('[data-board-reader][data-reader-doc]'))
      .find((el) => el.getAttribute('data-reader-doc') === target.scope && !el.closest('[inert], [hidden]'));
    if (!reader) return null;
    const scopeRoot = target.inNote ? reader.querySelector<HTMLElement>('#board-reader-note') : reader;
    if (!scopeRoot) return null;
    const matches = Array.from(scopeRoot.querySelectorAll<HTMLElement>(target.tag)).filter(
      (el) => Boolean(el.closest('#board-reader-note')) === Boolean(target.inNote)
        && matchesSignature(el, target.tag, target.href, target.text, target.ariaLabel)
        && isFocusableElement(el),
    );
    return matches[target.occurrence] ?? matches[0] ?? null;
  }

  if (target.kind === 'node') {
    const node = Array.from(doc.querySelectorAll<HTMLElement>('.react-flow__node[data-id]'))
      .find((el) => el.getAttribute('data-id') === target.scope && !el.closest('[inert], [hidden]'));
    if (!node) return null;
    const matches = Array.from(node.querySelectorAll<HTMLElement>(target.tag))
      .filter((el) => matchesSignature(el, target.tag, target.href, target.text, target.ariaLabel) && isFocusableElement(el));
    return matches[target.occurrence] ?? matches[0] ?? null;
  }

  if (target.kind === 'terminal') {
    const el = doc.querySelector<HTMLElement>('[data-testid="terminal-pane"] .xterm-helper-textarea');
    return isFocusableElement(el) ? el : null;
  }

  if (target.kind === 'testid') {
    return Array.from(doc.querySelectorAll<HTMLElement>('[data-testid]'))
      .find((el) => el.getAttribute('data-testid') === target.scope && isFocusableElement(el)) ?? null;
  }

  return null;
}

/** Picks where focus returns when Code closes: the opener, its current equivalent in the same context, or a reachable fallback. */
function openerStillMatches(opener: HTMLElement, target: OpenerTarget | null | undefined): boolean {
  if (!target) return true;
  if (target.kind === 'reader') {
    const reader = opener.closest<HTMLElement>('[data-board-reader][data-reader-doc]');
    if (!reader || reader.getAttribute('data-reader-doc') !== target.scope) return false;
    if (Boolean(opener.closest('#board-reader-note')) !== Boolean(target.inNote)) return false;
    return matchesSignature(opener, target.tag, target.href, target.text, target.ariaLabel);
  }
  if (target.kind === 'node') {
    const node = opener.closest<HTMLElement>('.react-flow__node[data-id]');
    if (!node || node.getAttribute('data-id') !== target.scope) return false;
    return matchesSignature(opener, target.tag, target.href, target.text, target.ariaLabel);
  }
  return true;
}

export function resolveCodeWindowOpener(opener: HTMLElement | null, openerTarget?: OpenerTarget | null, doc: Pick<Document, 'querySelector' | 'querySelectorAll'> | undefined = typeof document !== 'undefined' ? document : undefined): HTMLElement | null {
  if (isFocusableElement(opener) && openerStillMatches(opener, openerTarget)) return opener;
  const equivalent = findOpenerTarget(openerTarget, doc);
  if (equivalent) return equivalent;
  if (!doc) return null;
  const codeButton = Array.from(doc.querySelectorAll<HTMLElement>('[data-testid="board-code-button"]'))
    .find((el) => isFocusableElement(el));
  if (codeButton) return codeButton;
  const readerTitle = Array.from(doc.querySelectorAll<HTMLElement>('[data-board-reader] h2'))
    .find((el) => isFocusableElement(el));
  if (readerTitle) return readerTitle;
  return doc.querySelector<HTMLElement>('[data-testid="board-code-button"]');
}

/** Asks for the Code window of a workspace to open. `opener` is where the keyboard returns when it closes. */
export interface WorkspaceFile { workspaceId: string; file: string; line?: number }
export interface CodeWindowRequest { intent?: number; workspaceFile?: WorkspaceFile; /** Opens the window in Commits mode on this commit, with the commits of the row it came from. */ commit?: CommitOpen; /** Area name when opened from inside an Area on the Board. */ area?: string; close?: boolean; opener: HTMLElement | null; openerTarget?: OpenerTarget | null; /** When it was asked, so a window that mounts a moment later (another workspace) still opens for it. */ at: number; /** Made together with a move to this workspace, so the window that mounts there is the one asked for. */ navigated: boolean }
export const codeWindowRequests = createRequestStore<CodeWindowRequest>();

/**
 * Opens the Code window. With a file, it opens on that file (the Code section answers the same request a clicked path makes);
 * without one, on whatever it showed last, or the first change.
 */
export function openCodeWindow(workspace: string, options: { opener?: HTMLElement | null; openerTarget?: OpenerTarget | null; file?: RepoFile & { line?: number }; workspaceFile?: WorkspaceFile; commit?: CommitOpen; area?: string; navigated?: boolean; preserveIntent?: boolean } = {}): number {
  if (!options.preserveIntent) invalidateReferenceIntent();
  if (options.file) codeRequests.open(workspace, { kind: 'file', ...options.file, intent });
  const held = typeof document !== 'undefined' ? document.activeElement : null;
  const opener = options.opener !== undefined ? options.opener : (typeof HTMLElement !== 'undefined' && held instanceof HTMLElement && held !== document.body ? held : null);
  const openerTarget = options.openerTarget !== undefined ? options.openerTarget : describeOpener(opener);
  return codeWindowRequests.open(workspace, { intent, workspaceFile: options.workspaceFile, commit: options.commit, area: options.area ?? options.commit?.sequence?.label, opener, openerTarget, at: Date.now(), navigated: options.navigated === true });
}
export function closeCodeWindow(workspace: string, opener: HTMLElement | null): void {
  codeWindowRequests.open(workspace, { ...codeWindowRequests.get(workspace)?.request, commit: undefined, close: true, opener, intent, at: Date.now(), navigated: false });
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

export function useDocumentRequest(workspace: string): OpenRequest<{ name: string; repo?: { name: string; path: string }; opener?: HTMLElement | null; intent?: number }> | null {
  return useSyncExternalStore(documentRequests.subscribe, () => documentRequests.get(workspace), () => null);
}
