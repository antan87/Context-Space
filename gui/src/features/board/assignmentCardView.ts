/**
 * The Assignment card on the Board overview: what its compact form shows, the body that saves a changed description,
 * and the checks on a spec (a text added to the assignment) before anything is sent.
 * File: gui/src/features/board/assignmentCard.ts
 */
import type { WorkDocument, WorkGuidance } from '../../types.js';
import type { ReaderTarget } from './boardActions.js';

/** The longest description the backend keeps. */
export const OBJECTIVE_LIMIT = 4000;
/** The longest text the backend stores for one source document, in characters. */
export const SPEC_CHAR_LIMIT = 500_000;
/** The request body limit is 600,000 bytes of JSON. The text is measured as it is sent (quotes, newlines and tabs are escaped), with room left for the other fields. */
export const SPEC_BYTE_LIMIT = 570_000;
/** The whole body, measured as it is sent. */
export const SPEC_BODY_LIMIT = 595_000;
/** How much of the first line the compact card keeps before it cuts it with an ellipsis. */
const FIRST_LINE_MAX = 200;

const TEXT_FILE = /\.(md|markdown|txt)$/i;

export interface AssignmentCardView {
  /** The description's first non-empty line, cut with an ellipsis when long. Empty when there is no description. */
  firstLine: string;
  hasDescription: boolean;
  specs: Array<{ id: string; title: string }>;
}

/** What the compact card shows: the description's opening and one named chip for each spec. */
export function assignmentCardView(guidance: Pick<WorkGuidance, 'assignment' | 'documents'>): AssignmentCardView {
  const objective = guidance.assignment.objective ?? '';
  const line = objective.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? '';
  const firstLine = line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1).trimEnd()}…` : line;
  return {
    firstLine,
    hasDescription: line.length > 0,
    specs: guidance.documents.map((doc) => ({ id: doc.id, title: doc.title.trim() || 'Untitled spec' })),
  };
}

/** The PUT body for a changed description: the saved work type, size, stage and the other fields go back unchanged. */
export function assignmentSaveBody(saved: Pick<WorkGuidance, 'workType' | 'size' | 'assignment'>, revision: number, objective: string) {
  return { revision, workType: saved.workType, size: saved.size, assignment: { ...saved.assignment, objective } };
}

/** A problem with the description, or null when it can be saved. */
export function checkObjective(objective: string): string | null {
  return objective.length > OBJECTIVE_LIMIT ? `The description is ${objective.length - OBJECTIVE_LIMIT} characters over the ${OBJECTIVE_LIMIT.toLocaleString('en')} limit. Shorten it, or put the detail in a spec.` : null;
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** A problem with the spec's text (pasted or read from a file), or null. Nothing is sent while there is one. */
export function checkSpecText(text: string): string | null {
  if (text.includes('\u0000')) return 'This is not a text file. Choose a Markdown or plain text file.';
  if (text.length > SPEC_CHAR_LIMIT) return `This text has ${text.length.toLocaleString('en')} characters; a spec holds up to ${SPEC_CHAR_LIMIT.toLocaleString('en')}. Nothing was added.`;
  if (utf8Bytes(JSON.stringify(text)) > SPEC_BYTE_LIMIT) return 'This text is too large to send in one piece. Shorten it or split it into two specs. Nothing was added.';
  return null;
}

/** A problem with the file chosen, judged by its name, or null. */
export function checkSpecFileName(name: string): string | null {
  return TEXT_FILE.test(name) ? null : `"${name}" is not a Markdown or text file. A spec can be a .md, .markdown or .txt file; PDFs and links come later. Nothing was added.`;
}

/** The title an uploaded file suggests: its name without the extension. */
export function specTitleFromFile(name: string): string {
  return name.replace(TEXT_FILE, '').trim() || name;
}

export interface SpecForm { title: string; content: string; summary: string }

/** What stops "Add spec", or null when it can be sent. */
export function checkSpec(form: SpecForm): string | null {
  if (!form.title.trim()) return 'Give the spec a title.';
  if (form.title.trim().length > 200) return 'The title is longer than 200 characters.';
  if (!form.content.trim()) return 'Paste the spec text, or upload a file.';
  const problem = checkSpecText(form.content);
  if (problem) return problem;
  if (utf8Bytes(JSON.stringify(specSaveBody(0, form))) > SPEC_BODY_LIMIT) return 'This spec is too large to send in one piece. Shorten it or split it into two specs. Nothing was added.';
  return null;
}

/** The POST body for a new spec: approved requirements for the whole project, the text copied in. */
export function specSaveBody(revision: number, form: SpecForm): Pick<WorkDocument, 'title' | 'role' | 'status' | 'scope' | 'summary'> & { revision: number; content: string } {
  return { revision, title: form.title.trim(), role: 'requirements', status: 'approved', scope: {}, summary: form.summary.trim(), content: form.content };
}

/** The target the Board reader opens for a spec: a source document is read by its id through the work route. */
export const specTarget = (doc: Pick<WorkDocument, 'id' | 'title' | 'filename'>): ReaderTarget => ({ path: doc.filename ?? doc.title, title: doc.title, source: doc.id });
