import type { CommitOpen, CommitSequence } from '../changes/commitsMode.js';
import type { BoardArea } from './boardAreas.js';
import type { ReaderTarget } from './boardActions.js';

const prefixMatch = (a: string, b: string) => a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase());

/**
 * What the Code window needs to open a commit card: the commit, and the commits of the row of its Area that holds it, in the order
 * the row shows them. The row is found by the card's own id first, so two repositories with the same short SHA stay apart.
 */
export function commitOpenFor(areas: readonly BoardArea[], target: ReaderTarget): CommitOpen | null {
  const commit = target.commit;
  if (!commit) return null;
  const candidates: { area: BoardArea; index: number }[] = [];
  for (const area of areas) {
    area.repos.forEach((entry, index) => { if (entry.repo.repo === commit.repo) candidates.push({ area, index }); });
  }
  const holds = ({ area, index }: { area: BoardArea; index: number }) => area.repos[index]!.commits.some((entry) => prefixMatch(entry.sha, commit.sha));
  const byCard = target.card ? candidates.find(({ area, index }) => area.repos[index]!.cards.some((card) => card.id === target.card)) : undefined;
  const found = byCard ?? candidates.find(holds);
  const open: CommitOpen = { repo: commit.repo, sha: commit.sha };
  if (!found) return open;
  const entry = found.area.repos[found.index]!;
  const sequence: CommitSequence = {
    label: found.area.data.title,
    commits: entry.commits.map((item) => ({ repo: commit.repo, sha: item.sha, subject: item.subject, author: item.author, at: item.at })),
  };
  return { ...open, sequence };
}
