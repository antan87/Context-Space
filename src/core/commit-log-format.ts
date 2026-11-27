const PLAN_STEP_LINE = /^plan-step:[ \t]*(\S+)$/i;
const PLAN_ID = /^[scd][a-z0-9]{5}$/;
const isPlanStepLine = (line: string): boolean => { const m = PLAN_STEP_LINE.exec(line); return m !== null && PLAN_ID.test(m[1]!); };

function firstNonEmptyLine(body: string): string | undefined {
  const line = body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !isPlanStepLine(entry));
  return line ? line.slice(0, 300) : undefined;
}

/**
 * The plan items a commit names: `Plan-Step: <id>` lines in the last paragraph of its body (Git's trailer block). The key is
 * not case sensitive; the id is a plan item id (lowercase). At most 5, without duplicates. A line in any other paragraph is
 * not a trailer. Linear in the body: lines are scanned from the end and nothing backtracks.
 */
export function parsePlanStepTrailers(body: string): string[] {
  const lines = body.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === '') end--;
  let start = end;
  while (start > 0 && lines[start - 1]!.trim() !== '') start--;
  const ids: string[] = [];
  for (let i = start; i < end && ids.length < 5; i++) {
    const match = PLAN_STEP_LINE.exec(lines[i]!.trim());
    if (match && PLAN_ID.test(match[1]!) && !ids.includes(match[1]!)) ids.push(match[1]!);
  }
  return ids;
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
  /** Ids of the plan items named by `Plan-Step:` trailers (not checked against any plan). */
  steps?: string[];
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
    const steps = parsePlanStepTrailers(body);
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
      ...(steps.length > 0 ? { steps } : {}),
      ...(fileCount !== undefined ? { fileCount } : {}),
    });
  }
  return commits;
}
