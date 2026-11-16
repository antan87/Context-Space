/** What the change listing says in numbers: pure, so the Board's button and card and the Code tree's total line all agree. */

export interface ChangeFile { file: string; type: string; additions?: number; deletions?: number }
export interface ChangeRepo { repoName: string; repoPath: string; files: ChangeFile[]; error?: string }

export interface RepoChangeSummary {
  repoName: string;
  repoPath: string;
  files: number;
  /** Absent when the listing carries no counts. */
  additions?: number;
  deletions?: number;
  /** The first file names, as they are shown (the last path segment). */
  names: string[];
  firstFile: string;
}

export interface ChangeSummary { files: number; additions?: number; deletions?: number; repos: RepoChangeSummary[] }

const hasCounts = (files: ChangeFile[]) => files.some((file) => typeof file.additions === 'number' || typeof file.deletions === 'number');
const baseName = (path: string) => path.split('/').at(-1) ?? path;

export function summarizeChanges(repos: readonly ChangeRepo[] | undefined): ChangeSummary {
  const summaries: RepoChangeSummary[] = [];
  let additions = 0;
  let deletions = 0;
  let counted = false;
  for (const repo of repos ?? []) {
    const files = (repo.files ?? []).filter((file) => file.type !== 'unchanged');
    if (files.length === 0) continue;
    const counts = hasCounts(files);
    const add = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
    const del = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
    if (counts) { counted = true; additions += add; deletions += del; }
    summaries.push({
      repoName: repo.repoName, repoPath: repo.repoPath, files: files.length,
      ...(counts ? { additions: add, deletions: del } : {}),
      names: files.slice(0, 3).map((file) => baseName(file.file)),
      firstFile: files[0]!.file,
    });
  }
  return { files: summaries.reduce((sum, repo) => sum + repo.files, 0), ...(counted ? { additions, deletions } : {}), repos: summaries };
}

export const filesChangedText = (count: number) => `${count} ${count === 1 ? 'file' : 'files'} changed`;

/** "+120 −40", or an empty string when the listing has no counts or they are zero (a count of nothing is not shown). */
export const plusMinusText = (additions?: number, deletions?: number) =>
  !additions && !deletions ? '' : `+${additions ?? 0} −${deletions ?? 0}`;

/** The line at the top of the Code tree: "13 changed files · +420 −96". Without counts, only the files. */
export function totalLine(files: number, additions?: number, deletions?: number): string {
  const head = `${files} changed ${files === 1 ? 'file' : 'files'}`;
  const numbers = plusMinusText(additions, deletions);
  return numbers ? `${head} · ${numbers}` : head;
}
