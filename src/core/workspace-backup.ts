/**
 * @module core/workspace-backup
 * Whether the things a person wrote in a workspace would survive losing this computer.
 *
 * ContextSpace regenerates most workspace files, but not the knowledge entries and planning notes
 * people write by hand. Those live only in the workspace's own git repository, so without a remote
 * (see `ctxspace remote add`) one wiped disk loses them. This is a read-only summary: it never
 * adds a remote or pushes, which stay explicit actions by the user.
 */

import { parseKnowledgeEntries, readWorkspaceKnowledge } from './knowledge.js';
import { planningNotesAreAuthored } from './planning-notes.js';
import { getWorkspaceRemote, type WorkspaceRemote } from './workspace-git.js';
import { CLI_NAME } from './constants.js';

export interface WorkspaceBackupStatus {
  remote: WorkspaceRemote;
  /** What has been written by hand, and so cannot be regenerated. */
  handWritten: { knowledgeEntries: number; planningNotes: boolean };
  /** Hand-written content exists and there is no remote: it exists on this computer only. */
  atRisk: boolean;
  /** What is at risk, in one plain sentence, or null when nothing is. */
  summary: string | null;
  /** The summary plus the commands that fix it, for places that print text. Null when nothing is at risk. */
  message: string | null;
}

function describeContent(knowledgeEntries: number, planningNotes: boolean): string {
  const parts = [
    knowledgeEntries > 0 ? `${knowledgeEntries} knowledge ${knowledgeEntries === 1 ? 'entry' : 'entries'}` : '',
    planningNotes ? 'the planning notes' : '',
  ].filter(Boolean);
  const text = parts.join(' and ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Never throws: a workspace that cannot be inspected is reported as having nothing at risk. */
export async function describeWorkspaceBackup(workspacePath: string): Promise<WorkspaceBackupStatus> {
  const remote = await getWorkspaceRemote(workspacePath).catch((): WorkspaceRemote => ({ state: 'none' }));
  let knowledgeEntries = 0;
  try {
    knowledgeEntries = parseKnowledgeEntries((await readWorkspaceKnowledge(workspacePath)) ?? '').length;
  } catch {
    // Unreadable knowledge is reported by other checks; it must not hide the remote status.
  }
  const planningNotes = await planningNotesAreAuthored(workspacePath);
  const atRisk = remote.state === 'none' && (knowledgeEntries > 0 || planningNotes);
  // One lone entry is singular ("exists"); anything else, including "1 entry and the planning notes", is plural.
  const verb = knowledgeEntries === 1 && !planningNotes ? 'exists' : 'exist';
  const summary = atRisk
    ? `${describeContent(knowledgeEntries, planningNotes)} in this workspace ${verb} only on this computer, because it has no git remote.`
    : null;
  return {
    remote,
    handWritten: { knowledgeEntries, planningNotes },
    atRisk,
    summary,
    message: summary ? `${summary} Back them up: \`${CLI_NAME} remote add <git-url>\`, then \`${CLI_NAME} remote push\`.` : null,
  };
}
