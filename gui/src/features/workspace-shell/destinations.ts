/**
 * The sections of a workspace. Each id is its URL segment (`/workspaces/:id/:section`), so every deep link from before
 * the shell redesign still resolves, whether or not the section has a place on the rail. A workspace with no section in
 * its URL opens on its plan, with the sessions one click away; `/chat` opens the sessions directly, and `/sessions`
 * opens the session history beside them.
 */
export type WorkspaceSection = 'chat' | 'overview' | 'plan' | 'board' | 'documents' | 'skills' | 'changes' | 'sessions' | 'services';

export const SECTION_LABELS: Record<WorkspaceSection, string> = {
  chat: 'Chat',
  overview: 'Overview',
  plan: 'Plan',
  board: 'Board',
  documents: 'Documents',
  skills: 'Skills',
  changes: 'Code',
  sessions: 'Session history',
  services: 'Services',
};

const ALL_SECTIONS = new Set<string>(Object.keys(SECTION_LABELS));

/**
 * No segment opens the board. The old 'plan', 'changes', 'documents', 'services' and 'knowledge' addresses alias to 'board'
 * (there are no screens of those names any more). An unknown one (an old or mistyped link) falls back to the overview
 * instead of a blank page.
 */
export function parseSection(segment: string | undefined | null): WorkspaceSection {
  if (!segment || segment === 'plan' || segment === 'changes' || segment === 'documents' || segment === 'services' || segment === 'knowledge') return 'board';
  return ALL_SECTIONS.has(segment) ? segment as WorkspaceSection : 'overview';
}

/**
 * The old Knowledge address `/workspaces/:id/knowledge`: the Board opens with Knowledge in its reader, which is where
 * Knowledge is read now. Gives the workspace and the address to replace it with, or null for any other path.
 */
export function knowledgeRedirect(pathname: string): { workspaceId: string; to: string } | null {
  const parts = pathname.split('/').filter(Boolean); // ['workspaces', id, section]
  if (parts[0] !== 'workspaces' || !parts[1] || parts[2] !== 'knowledge') return null;
  return { workspaceId: decodeURIComponent(parts[1]), to: `/workspaces/${parts[1]}/board` };
}

/**
 * An archived workspace shows its record, not the places where work happens:
 * no changes, services, sessions or skills to act on. The board remains available to inspect the canvas.
 */
export const ARCHIVED_SECTIONS: readonly WorkspaceSection[] = ['overview', 'plan', 'board', 'documents'];

/**
 * What can open beside the chat, in the rail's order:
 * Overview (workspace summary and mapped repositories), Board (the plan, documents and commits on a canvas),
 * Sessions (CLI sessions and history), and Skills (workspace assistant instructions).
 * Legacy sections (code changes, documents, services, plan) keep their URLs for deep link compatibility,
 * but the streamlined rail focuses on the workspace board, skills, and sessions.
 */
export const RAIL_SECTIONS: readonly WorkspaceSection[] = [
  'overview',
  'board',
  'sessions',
  'skills',
];

/** The rail of an archived workspace is its record and its board. */
const ARCHIVED_RAIL: readonly WorkspaceSection[] = ['overview', 'board'];

/**
 * What the rail offers for active and archived workspaces.
 */
export function railSectionsFor(archived: boolean): readonly WorkspaceSection[] {
  return archived ? ARCHIVED_RAIL : RAIL_SECTIONS;
}

/** The section to render: an archived workspace falls back to its overview. */
export function visibleSection(section: WorkspaceSection, archived: boolean): WorkspaceSection {
  return archived && !ARCHIVED_SECTIONS.includes(section) ? 'overview' : section;
}
