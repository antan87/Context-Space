/**
 * The sections of a workspace. Each id is its URL segment (`/workspaces/:id/:section`), so every deep link from before
 * the shell redesign still resolves. A workspace with no section in its URL opens on its plan, with the sessions one
 * click away; `/chat` and `/sessions` still open the sessions directly.
 */
export type WorkspaceSection = 'chat' | 'overview' | 'plan' | 'documents' | 'knowledge' | 'skills' | 'changes' | 'sessions' | 'services';

export const SECTION_LABELS: Record<WorkspaceSection, string> = {
  chat: 'Chat',
  overview: 'Overview',
  plan: 'Plan',
  documents: 'Documents',
  knowledge: 'Knowledge',
  skills: 'Skills',
  changes: 'Code',
  sessions: 'Sessions',
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
 * What can open beside the chat, in the rail's order. Overview, Sessions and Knowledge keep their addresses, so old
 * links still work, but have no place on the rail: the progress strip above the chat says where the work stands, saved
 * conversations open from the chat itself, and knowledge is read in Docs.
 */
export const RAIL_SECTIONS: readonly WorkspaceSection[] = ['plan', 'changes', 'documents', 'skills', 'services'];

/** The rail of an archived workspace is its record, its plan and its documents. */
const ARCHIVED_RAIL: readonly WorkspaceSection[] = ['overview', 'plan', 'documents'];

/**
 * What the rail offers. Knowledge is read in Docs, with the other files ContextSpace keeps, so its own address still
 * opens but it has no item of its own.
 */
export function railSectionsFor(archived: boolean): readonly WorkspaceSection[] {
  return archived ? ARCHIVED_RAIL : RAIL_SECTIONS;
}

/** The section to render: an archived workspace falls back to its overview. */
export function visibleSection(section: WorkspaceSection, archived: boolean): WorkspaceSection {
  return archived && !ARCHIVED_SECTIONS.includes(section) ? 'overview' : section;
}
