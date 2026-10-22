/**
 * The sections of a workspace. Each id is its URL segment (`/workspaces/:id/:section`), so every deep link from before
 * the shell redesign still resolves, whether or not the section has a place on the rail. A workspace with no section in
 * its URL opens on its plan, with the sessions one click away; `/chat` opens the sessions directly, and `/sessions`
 * opens the session history beside them.
 */
export type WorkspaceSection = 'chat' | 'overview' | 'plan' | 'board' | 'documents' | 'knowledge' | 'skills' | 'changes' | 'sessions' | 'services';

export const SECTION_LABELS: Record<WorkspaceSection, string> = {
  chat: 'Chat',
  overview: 'Overview',
  plan: 'Plan',
  board: 'Board',
  documents: 'Documents',
  knowledge: 'Knowledge',
  skills: 'Skills',
  changes: 'Code',
  sessions: 'Session history',
  services: 'Services',
};

const ALL_SECTIONS = new Set<string>(Object.keys(SECTION_LABELS));

/**
 * No segment opens the plan. An unknown one (an old or mistyped link) falls back
 * to the overview instead of a blank page.
 */
export function parseSection(segment: string | undefined | null): WorkspaceSection {
  if (!segment) return 'plan';
  return ALL_SECTIONS.has(segment) ? segment as WorkspaceSection : 'overview';
}

/**
 * An archived workspace shows its record, not the places where work happens:
 * no changes, services, sessions or skills to act on.
 */
export const ARCHIVED_SECTIONS: readonly WorkspaceSection[] = ['overview', 'plan', 'documents', 'knowledge'];

/**
 * What can open beside the chat, in the rail's order:
 * Overview (workspace summary and mapped repositories), Plan, Board (the plan, documents and commits on a canvas),
 * Sessions (CLI sessions and history), Code (changes), Docs, Skills, and Services.
 * Knowledge keeps its address and is read in Docs or directly via URL, but has no place on the rail.
 */
export const RAIL_SECTIONS: readonly WorkspaceSection[] = [
  'overview',
  'plan',
  'board',
  'sessions',
  'changes',
  'documents',
  'skills',
  'services',
];

/** The rail of an archived workspace is its record, its plan and its documents. */
const ARCHIVED_RAIL: readonly WorkspaceSection[] = ['overview', 'plan', 'documents'];

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
