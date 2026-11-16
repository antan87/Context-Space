function firstNonEmptyLine(body: string): string | undefined {
  const line = body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ? line.slice(0, 300) : undefined;
}

/** Git `--format` string expected by {@link parseDetailedCommitLog}. */
export const DETAILED_COMMIT_FORMAT = '--format=%x00%H%x1f%h%x1f%P%x1f%an%x1f%cI%x1f%s%x1f%b%x00S:';

export interface ParsedDetailedCommit {
  fullSha: string;
  sha: string;
  author: string;
  at: string;
  subject: string;
  firstBodyLine?: string;
  fileCount?: number;
}

/** Parses `git log --shortstat` output formatted with {@link DETAILED_COMMIT_FORMAT}. */
export function parseDetailedCommitLog(stdout: string): ParsedDetailedCommit[] {
  const parts = stdout.split('\x00');
  const commits: ParsedDetailedCommit[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const header = parts[i] ?? '';
    const stats = parts[i + 1] ?? '';
    const [fullSha = '', sha = '', parents = '', author = '', date = '', subject = '', ...bodyParts] = header.split('\x1f');
    if (!sha) continue;
    const time = new Date(date);
    const body = bodyParts.join('\x1f');
    const firstBodyLine = firstNonEmptyLine(body);
    const match = stats.match(/(\d+)\s+files?\s+changed/);
    const isMerge = parents.trim().includes(' ');
    const fileCount = match ? Number(match[1]) : isMerge ? undefined : 0;
    commits.push({
      fullSha: fullSha.trim(),
      sha,
      author,
      at: Number.isNaN(time.getTime()) ? date : time.toISOString(),
      subject,
      ...(firstBodyLine !== undefined ? { firstBodyLine } : {}),
      ...(fileCount !== undefined ? { fileCount } : {}),
    });
  }
  return commits;
}
