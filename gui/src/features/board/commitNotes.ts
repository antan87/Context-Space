/**
 * The notes an AI left on commits (`ctxspace note`). Each is a board note card with `about: commit:<repo>:<sha>`; they are read from the
 * board data the app already holds, so a note that arrives on the live feed shows wherever a commit is shown. Read only: the app never
 * writes one.
 */

import { createContext, useMemo } from 'react';
import { useBoard, type BoardCard } from './boardData.js';

export interface CommitNoteEntry {
  id: string;
  repo: string;
  sha: string;
  title: string;
  body: string;
  by: string;
  at: string;
}

const ABOUT = /^commit:(.+):([0-9a-f]{7,64})$/i;

/** Every live (not archived) commit note, newest first; notes with the same time keep the later one first. */
export function commitNotesOf(cards: readonly BoardCard[] | undefined): CommitNoteEntry[] {
  const found: Array<{ note: CommitNoteEntry; index: number; ms: number }> = [];
  (cards ?? []).forEach((card, index) => {
    if (card.kind !== 'note' || card.archived || !card.about) return;
    const match = ABOUT.exec(card.about);
    if (!match) return;
    const ms = Date.parse(card.at);
    found.push({ note: { id: card.id, repo: match[1]!, sha: match[2]!.toLowerCase(), title: card.title, body: card.body, by: card.by, at: card.at }, index, ms: Number.isNaN(ms) ? 0 : ms });
  });
  return found.sort((a, b) => b.ms - a.ms || b.index - a.index).map((entry) => entry.note);
}

/** The notes of one commit. Either side may hold a short sha (a card or a list shows seven characters), so they match by prefix. */
export function notesOfCommit(notes: readonly CommitNoteEntry[], repo: string, sha: string): CommitNoteEntry[] {
  const wanted = sha.toLowerCase();
  if (wanted.length < 7) return [];
  return notes.filter((note) => note.repo === repo && (note.sha.startsWith(wanted) || wanted.startsWith(note.sha)));
}

/** "1 note", "2 notes". */
export const noteCountText = (count: number): string => `${count} ${count === 1 ? 'note' : 'notes'}`;

/** Who wrote it as a person reads it: "Claude", "AI". */
export function noteAuthorName(by: string): string {
  if (by === 'ai') return 'AI';
  return by ? `${by.charAt(0).toUpperCase()}${by.slice(1)}` : 'AI';
}

const NO_NOTES: CommitNoteEntry[] = [];

/** The commit notes of the workspace, read from the board (kept fresh by the live feed). */
export function useCommitNotes(workspace: string | null): CommitNoteEntry[] {
  const board = useBoard(workspace, { poll: false });
  const cards = board.data?.cards;
  return useMemo(() => (cards ? commitNotesOf(cards) : NO_NOTES), [cards]);
}

/**
 * Review opened from a note marker or a "Notes" line asks to show the notes: the Notes section of that commit is scrolled into view
 * when it is drawn. One request, for one commit, that is used once and runs out.
 */
let pendingNotesView: { repo: string; sha: string; at: number } | null = null;
const PENDING_MS = 15_000;

export function requestNotesView(repo: string, sha: string): void {
  pendingNotesView = { repo, sha: sha.toLowerCase(), at: Date.now() };
}

/** Takes the request when it is for this commit and still fresh; a request for another commit stays until it runs out. */
export function takeNotesView(repo: string, sha: string): boolean {
  const request = pendingNotesView;
  if (!request) return false;
  if (Date.now() - request.at > PENDING_MS) { pendingNotesView = null; return false; }
  const wanted = sha.toLowerCase();
  if (request.repo !== repo || !(request.sha.startsWith(wanted) || wanted.startsWith(request.sha))) return false;
  pendingNotesView = null;
  return true;
}

export function clearNotesView(): void { pendingNotesView = null; }

/** The commit notes the Board draws on its commit cards (one marker per card). Provided by the Board; empty elsewhere. */
export const CommitNotesContext = createContext<readonly CommitNoteEntry[]>(NO_NOTES);
