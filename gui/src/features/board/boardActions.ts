import { createContext } from 'react';
import { API_BASE } from '../../lib/apiBase.js';

/** What the nodes on the canvas need from the page around it: which workspace they are in, how to open a file, and how to open or fold a group. */
export interface BoardActions {
  workspaceId: string;
  /** Opens a file of the workspace where the app opens its documents. */
  openFile: (path: string) => void;
  /** Opens (`true`) or folds (`false`) a group: a checkpoint frame, the plan's own frame, the documents or a repository's commits. */
  toggleGroup: (id: string, open: boolean) => void;
  /** A button of a group that has just opened or folded, to put the keyboard on when it was on the one that was pressed. */
  keepFocus: (id: string, button: HTMLElement) => void;
}

export const BoardActionsContext = createContext<BoardActions | null>(null);

/** Where the app serves a file of the workspace from, as the documents panel reads it. */
export const documentFileUrl = (workspaceId: string, path: string) =>
  `${API_BASE}/api/workspace/${encodeURIComponent(workspaceId)}/documents/file?name=${encodeURIComponent(path)}`;
