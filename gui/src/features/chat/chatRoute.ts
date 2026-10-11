import type { NavigateFunction } from 'react-router-dom';

/** Where a workspace's chat is. The address is the source of truth for which chat is on screen. */
export const chatPath = (branchName: string) => `/workspaces/${encodeURIComponent(branchName)}/chat`;

/** Where a workspace opens: its plan, with the sessions one click away. */
export const WORKSPACE_HOME = 'plan';

/** The workspace and section an address names. No section means the workspace's home, the plan. Null for any other address. */
export function parseWorkspacePath(pathname: string): { workspace: string; section: string } | null {
  const match = /^\/workspaces\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return { workspace: decodeURIComponent(match[1]!), section: match[2] ?? WORKSPACE_HOME };
  } catch {
    return null;
  }
}

/**
 * Whether the address already shows this workspace's chat: its chat section. Going there again would only change the
 * address under the user for nothing.
 */
export function showsChatOf(pathname: string, branchName: string): boolean {
  const here = parseWorkspacePath(pathname);
  return here !== null && here.workspace === branchName && here.section === 'chat';
}

/**
 * Whether this workspace's chat is on screen at this address: its own chat section, or another part of the
 * same workspace opened beside the chat, when the chat is showing there.
 */
export function showsChatFor(pathname: string, branchName: string, chatOnScreen: boolean): boolean {
  const here = parseWorkspacePath(pathname);
  return here !== null && here.workspace === branchName && (here.section === 'chat' || chatOnScreen);
}

/**
 * The dock moves the address to a chat when the user chooses one, and the address
 * then tells the page which chat that is. The two do not happen at the same moment:
 * the browser's address changes at once, but the app applies its own copy of the
 * location a little later when the page is busy. The user can act in between, say by
 * opening two chats and closing the second, and what they did last has to win.
 *
 * So every navigation the dock makes is numbered, and when one lands the page asks
 * which kind it is: one the user made some other way (a typed address, a link,
 * Back), one the dock made that a newer one has since replaced, or the newest one
 * the dock made. Only the newest acts. An older one is out of date, and one for a
 * chat the user has since closed is corrected rather than obeyed.
 */
let issued = Date.now();
// Numbers left in history by an earlier visit are older than this, so they never count as new.
let handled = issued;

export interface DockNavigationState { chatDock: number }

/** The number for the next navigation the dock makes. */
export function dockNavigationState(): DockNavigationState {
  issued += 1;
  return { chatDock: issued };
}

export type DockLanding = 'external' | 'stale' | 'current';

/**
 * What a landing is. Each numbered landing is judged once: after it, the same number,
 * or any older one arriving late, counts as external because it is no longer news.
 */
export function judgeDockLanding(state: unknown): DockLanding {
  const mark = (state as Partial<DockNavigationState> | null | undefined)?.chatDock;
  if (typeof mark !== 'number' || !Number.isFinite(mark) || mark <= handled) return 'external';
  handled = mark;
  return mark < issued ? 'stale' : 'current';
}

/** What the chat slot does with a landing: nothing, move on to the chat the user is on, or open the chat the address names. */
export type DockLandingAction = 'ignore' | 'redirect' | 'reveal';

/**
 * The one rule for turning an address into an open chat. A stale landing is ignored. The dock's newest landing on a chat
 * that is not open is for one the user has closed since, so it is moved on to the chat they are on (or left alone when
 * there is none) instead of reopening it. Anything else, a typed address, a link or Back, opens the chat it names.
 */
export function dockLandingAction(
  landing: DockLanding,
  workspaceId: string,
  openTabs: readonly string[],
  activeTab: string | null,
): DockLandingAction {
  if (landing === 'stale') return 'ignore';
  if (landing === 'current' && !openTabs.includes(workspaceId)) {
    return activeTab && activeTab !== workspaceId ? 'redirect' : 'ignore';
  }
  return 'reveal';
}

/**
 * The address the browser is at now. Unlike the router's own copy, it changes the moment a
 * navigation is made, so it says where the user is going, not where the page last rendered.
 */
export function browserPath(hash: string = typeof window === 'undefined' ? '' : window.location.hash): string {
  return hash.replace(/^#/, '').split(/[?#]/)[0] ?? '';
}

/** Where a part of a workspace is. The chat has its own address; every other part is named after it. */
export function workspacePath(branchName: string, section = 'chat'): string {
  return section === 'chat' ? chatPath(branchName) : `/workspaces/${encodeURIComponent(branchName)}/${encodeURIComponent(section)}`;
}

/**
 * Where choosing a workspace from the sidebar goes: the same part of that workspace as the one being read, or its home,
 * the plan, from any other page. The session shortcuts use the same rule, so a click and a key land in the same place.
 */
export function pathForSwitchingTo(branchName: string, currentPathname: string): string {
  return workspacePath(branchName, parseWorkspacePath(currentPathname)?.section ?? WORKSPACE_HOME);
}

/** Goes to a part of a workspace as the dock: marked, so its landing can be told from the user's own. */
export function goToWorkspace(navigate: NavigateFunction, branchName: string, section = 'chat', options: { replace?: boolean } = {}): void {
  navigate(workspacePath(branchName, section), { replace: options.replace ?? false, state: dockNavigationState() });
}

/** Goes to a workspace's chat as the dock. */
export function goToChat(navigate: NavigateFunction, branchName: string, options: { replace?: boolean } = {}): void {
  goToWorkspace(navigate, branchName, 'chat', options);
}
