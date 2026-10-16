interface Listed { repoName: string; error?: string; files: Array<{ file: string; type: string }> }

/** The type of the extra row: a file that was opened by name and is not in the listing. */
export const OPENED_UNLISTED = 'ignored';

/**
 * The listing with one more row: the file opened by name when the listing leaves it out. The listing is git's (tracked
 * and untracked files that are not ignored), so a build output or a local config the AI names is a real file that is
 * not in it, and the tree would show nothing selected. Only the open file gets a row, never the ignored files around it.
 */
export function withOpenedFile<T extends Listed>(repos: readonly T[], opened: { repoName: string; file: string } | null | undefined): T[] {
  if (!opened) return [...repos];
  return repos.map((repo) => (
    repo.repoName === opened.repoName && !repo.error && !repo.files.some((entry) => entry.file === opened.file)
      ? { ...repo, files: [...repo.files, { file: opened.file, type: OPENED_UNLISTED }] }
      : repo
  ));
}
