import { toWorkspaceRelative } from '../../components/markdownLinks.js';

/**
 * The workspace-relative name a clicked terminal path would have as a workspace
 * document, or null when it can only be a code reference. This is a naming
 * decision, not an existence check: the caller still asks the server whether it
 * is a document it can open, because a repo-relative `docs/guide.md` has the
 * same shape as a folder under the workspace root.
 *
 * `cwd` is the folder the terminal session runs in, when known.
 * `repoPaths` are the workspace's repositories. Worktrees live under the
 * workspace root, so `NexusFlow/README.md` is inside it too, but belongs in the
 * code panel with its diff and change state, not in the read-only document viewer.
 */
export function workspaceDocumentName(reference: { path: string; line?: number }, workspaceRoot?: string, repoPaths: string[] = [], cwd?: string): string | null {
  // A relative path is relative to the folder the session runs in. Read as relative to the workspace root, a README
  // printed inside a repository named the root's README, and `../../notes.md` from a subfolder named nothing.
  const absolute = /^(?:[a-z]:[\\/]|[\\/])/i.test(reference.path.trim());
  const target = cwd && !absolute ? `${cwd.replace(/[\\/]+$/, '')}/${reference.path}` : reference.path;
  const name = toWorkspaceRelative(target, workspaceRoot);
  // The document viewer cannot jump to a line, so a nested `path:12` stays a code reference.
  if (!name || (reference.line !== undefined && name.includes('/'))) return null;
  // Compared case-insensitively for Windows. On POSIX a folder differing from a repo only by case
  // is treated as the repo, and the code panel says it is not found.
  const lower = name.toLowerCase();
  const isHtml = lower.endsWith('.html') || lower.endsWith('.htm');
  for (const repoPath of repoPaths) {
    const folder = toWorkspaceRelative(repoPath, workspaceRoot)?.toLowerCase();
    if (folder && (lower === folder || lower.startsWith(`${folder}/`))) {
      if (isHtml) return name;
      return null;
    }
  }
  return name;
}

/**
 * True when the server found the document but cannot preview it (too large, not valid UTF-8),
 * so the document viewer should open and show that error instead of
 * the code panel reporting the file as unknown. Any other failure, including a missing file,
 * an unsupported type or a failed request, is not a reason to leave the code panel.
 */
export function isUnreadableDocument(error: unknown): boolean {
  return error instanceof Error && /exceeds the .* limit|grew beyond the size limit|not valid for encoding/i.test(error.message);
}
