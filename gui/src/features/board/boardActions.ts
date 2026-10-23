import { createContext } from 'react';
import { API_BASE } from '../../lib/apiBase.js';

/** What the cards on the canvas need from the page around it: which workspace they are in, and how to open a file. */
export interface BoardActions {
  workspaceId: string;
  /** Opens a file of the workspace where the app opens its documents. */
  openFile: (path: string) => void;
}

export const BoardActionsContext = createContext<BoardActions | null>(null);

/** Where the app serves a file of the workspace from, as the documents panel reads it. */
export const documentFileUrl = (workspaceId: string, path: string) =>
  `${API_BASE}/api/workspace/${encodeURIComponent(workspaceId)}/documents/file?name=${encodeURIComponent(path)}`;
