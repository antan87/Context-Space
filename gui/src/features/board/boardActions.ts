import { createContext } from 'react';
import type { MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { API_BASE } from '../../lib/apiBase.js';
import { agoText } from '../plan/whatsNew.js';
import { fileTitle } from './boardDock.js';
import { authorName } from './boardLayout.js';

/** A file of the workspace for the reader beside the board, and what to call it. `card` is the board card it is the content of. */
export interface ReaderTarget {
  /** The file, for a source document the name it is kept under, or for a commit a short label (`repo · sha`). */
  path: string;
  title: string;
  card?: string;
  /** The id of a source document: it is read by the work route, through the storage port, and not from the workspace folder by `path`. */
  source?: string;
  /** The text of the card the file belongs to, and its whole byline: the reader shows them under the file, where the card shows only the start of the text. */
  text?: string;
  byline?: string;
  /** When set, opens this repository commit in the quiet reader via GET /api/workspace/:id/commits/:repo/:sha. */
  commit?: { repo: string; sha: string };
}

/** "by claude · 5 min ago", and who changed it since when someone did. */
export function bylineText(data: { by: string; at: string; updatedBy: string; updatedAt: string }): string {
  const made = agoText(data.at);
  const edited = Date.parse(data.updatedAt) - Date.parse(data.at) > 1000
    ? ` · edited${data.updatedBy === data.by ? '' : ` by ${authorName(data.updatedBy)}`} ${agoText(data.updatedAt)}`.trimEnd()
    : '';
  return `by ${authorName(data.by)}${made ? ` · ${made}` : ''}${edited}`;
}

/** What the nodes on the canvas need from the page around it: which workspace they are in, how to open a file, and how to open or fold a group. */
export interface BoardActions {
  workspaceId: string;
  /** The workspace folder, so a link to a file can name it by its full path. */
  workspacePath?: string;
  /** Shows a file of the workspace in the reader beside the board. `opener` is what the keyboard goes back to when the reader closes; without one, the link that was just pressed. */
  openInReader: (target: ReaderTarget, opener: HTMLElement | null) => void;
  /** Opens (`true`) or folds (`false`) a group: a checkpoint frame, the plan's own frame, the documents or a repository's commits. */
  toggleGroup: (id: string, open: boolean) => void;
  /** A button of a group that has just opened or folded, to put the keyboard on when it was on the one that was pressed. */
  keepFocus: (id: string, button: HTMLElement) => void;
  /** Opens the row of an Area that was pressed, or closes it when it is open already. */
  toggleRow?: (rowId: string) => void;
  /** Shows another page of the row that is open. */
  setRowPage?: (rowId: string, page: number) => void;
  /** Steps into an area from Level 0 (Overview) into Level 1 (Area). */
  openArea?: (id: string, button: HTMLElement) => void;
}

export const BoardActionsContext = createContext<BoardActions | null>(null);

/** The id of the card the reader shows, so that card is marked. Apart from the actions, so the actions (and the text of every card) stay as they are while the reader comes and goes. */
export const BoardReadingContext = createContext<string | null>(null);

/** Where the app serves a file of the workspace from, as the documents panel reads it. */
export const documentFileUrl = (workspaceId: string, path: string) =>
  `${API_BASE}/api/workspace/${encodeURIComponent(workspaceId)}/documents/file?name=${encodeURIComponent(path)}`;

/**
 * What the links in the text of a card may open: a file of the workspace opens in the reader, by its path from the workspace
 * folder (a card is not a file, so there is no folder to read a relative path from). `opener` is what the keyboard goes back
 * to when the reader closes; without one it is the link that was pressed. `onOpen` runs as a file is opened, for what has to
 * give way (a dialog).
 */
export const cardLinks = (actions: BoardActions, opener: HTMLElement | null = null, onOpen?: () => void): MarkdownDocumentLinks => ({
  workspaceRoot: actions.workspacePath,
  fileUrl: (path) => documentFileUrl(actions.workspaceId, path),
  onOpenFile: (path) => { onOpen?.(); actions.openInReader({ path, title: fileTitle(path) }, opener); },
});

const usable = (element: HTMLElement) =>
  element.getAttribute('tabindex') !== '-1' && !element.hasAttribute('disabled') && element.getClientRects().length > 0 && !element.closest('[hidden], [aria-hidden="true"]');

/**
 * The control of a card that does its main action: its title, which is a button (or a link) named "Open <title>" or "Read <title>" and
 * marked `data-card-main`. A card with no such control has its first control that the keyboard can reach and the eye can see (a link inside
 * clamped text is neither), or none.
 */
export function firstControl(card: HTMLElement, selector = 'button, a[href]'): HTMLElement | null {
  const main = card.querySelector<HTMLElement>('[data-card-main]');
  if (main && usable(main)) return main;
  for (const element of card.querySelectorAll<HTMLElement>(selector)) {
    if (usable(element)) return element;
  }
  return null;
}

const hasControlChar = (text: string) => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) return true;
  }
  return false;
};

/**
 * Parses a commit node ID (`commit:<repo>:<sha>[#<index>]`) into its repository and SHA.
 * Returns null if the format does not match, or if repo contains slashes, backslashes,
 * control characters, or is empty.
 */
export function parseCommitNodeId(id: string): { repo: string; sha: string } | null {
  const match = /^commit:(.+):([0-9a-f]{7,64})(?:#[0-9]{1,3})?$/i.exec(id);
  if (!match) return null;
  const repo = match[1];
  if (!repo || repo.length > 200 || repo === '.' || repo === '..' || repo.includes('/') || repo.includes('\\') || hasControlChar(repo)) {
    return null;
  }
  return { repo, sha: match[2].toLowerCase() };
}

