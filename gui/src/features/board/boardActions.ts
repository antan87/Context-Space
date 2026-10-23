import { createContext } from 'react';
import type { MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { API_BASE } from '../../lib/apiBase.js';
import { fileTitle } from './boardDock.js';

/** A file of the workspace for the reader beside the board, and what to call it. `card` is the board card it is the content of. */
export interface ReaderTarget {
  /** The file, or for a source document the name it is kept under. */
  path: string;
  title: string;
  card?: string;
  /** The id of a source document: it is read by the work route, through the storage port, and not from the workspace folder by `path`. */
  source?: string;
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
