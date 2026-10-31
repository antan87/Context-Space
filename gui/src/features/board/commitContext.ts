import type { PlanFileStep, PlanFileView } from '../plan/planFile.js';
import { parseCommitNodeId } from './boardActions.js';
import { cleanCardPath, type BoardCard, type BoardView } from './boardData.js';
import { fileTitle } from './boardDock.js';
import { fileTypeOf } from './boardLayout.js';

export type ForgeKind = 'github' | 'gitlab' | 'azure' | 'bitbucket' | 'unknown';
export type CommitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'other';

export interface CommitDetailFile {
  path: string;
  oldPath?: string;
  status: CommitFileStatus;
  additions: number | null;
  deletions: number | null;
}

export interface CommitDetail {
  repo: string;
  sha: string;
  shortSha: string;
  author: string;
  at: string;
  subject: string;
  body: string;
  parents: string[];
  files: CommitDetailFile[];
  moreFiles: number;
  additions: number;
  deletions: number;
  pushed: boolean;
  forge: ForgeKind | null;
  webUrl: string | null;
}

export interface CommitStepLink {
  key: string;
  text: string;
  done: boolean;
  checkpointTitle?: string;
  planPath?: string;
}

export interface CommitPictureLink {
  path: string;
  title: string;
}

/** Formats a known forge kind into its display name, or null for unknown/null. */
export function forgeDisplayName(forge: ForgeKind | null | undefined): string | null {
  switch (forge) {
    case 'github':
      return 'GitHub';
    case 'gitlab':
      return 'GitLab';
    case 'azure':
      return 'Azure DevOps';
    case 'bitbucket':
      return 'Bitbucket';
    default:
      return null;
  }
}

/** Validates that a forge web URL has a safe http or https protocol. */
export function safeForgeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

const HEX_TOKEN_REGEX = /(?<![0-9a-z])([0-9a-f]{7,64})(?![0-9a-z])/gi;
const BACKTICK_REGEX = /`([^`]+)`/g;

/**
 * Resolves the plan steps and picture attachments associated with a commit,
 * by checking board card links, commit SHAs mentioned in step text, and
 * pictures linked by step or backtick image references.
 */
export function resolveCommitContext(input: {
  repo: string;
  sha: string;
  plan?: PlanFileView;
  board?: BoardView;
}): { steps: CommitStepLink[]; pictures: CommitPictureLink[] } {
  const fullOrShortSha = input.sha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(fullOrShortSha)) {
    return { steps: [], pictures: [] };
  }

  const cardsById = new Map<string, BoardCard>();
  for (const card of input.board?.cards ?? []) {
    cardsById.set(card.id, card);
  }

  const commitMatches = (nodeId: string): boolean => {
    const parsed = parseCommitNodeId(nodeId);
    if (!parsed) return false;
    if (parsed.repo.toLowerCase() !== input.repo.toLowerCase()) return false;
    return fullOrShortSha.startsWith(parsed.sha) || parsed.sha.startsWith(fullOrShortSha);
  };

  const linkedCards: BoardCard[] = [];
  const seenLinkedCardIds = new Set<string>();

  for (const link of input.board?.links ?? []) {
    let otherEnd: string | null = null;
    if (commitMatches(link.from)) {
      otherEnd = link.to;
    } else if (commitMatches(link.to)) {
      otherEnd = link.from;
    }
    if (otherEnd && !seenLinkedCardIds.has(otherEnd)) {
      const card = cardsById.get(otherEnd);
      if (card && !card.archived) {
        seenLinkedCardIds.add(card.id);
        linkedCards.push(card);
      }
    }
  }

  const linkedCardStepKeys = new Set(
    linkedCards.map((c) => c.step).filter((s): s is string => Boolean(s)),
  );

  const stepMatchesSha = (text: string): boolean => {
    const matches = text.match(HEX_TOKEN_REGEX);
    if (!matches) return false;
    for (const token of matches) {
      const t = token.toLowerCase();
      if (fullOrShortSha.startsWith(t) || t.startsWith(fullOrShortSha)) {
        return true;
      }
    }
    return false;
  };

  const plan = input.plan;
  const planPath = plan?.source === 'file' && plan.file ? (cleanCardPath(plan.file) ?? undefined) : undefined;

  const steps: CommitStepLink[] = [];
  const seenStepKeys = new Set<string>();

  const addStep = (s: PlanFileStep, checkpointTitle?: string) => {
    if (seenStepKeys.has(s.key)) return;
    if (stepMatchesSha(s.text) || linkedCardStepKeys.has(s.key)) {
      seenStepKeys.add(s.key);
      steps.push({
        key: s.key,
        text: s.text,
        done: s.done,
        checkpointTitle,
        planPath,
      });
    }
  };

  for (const s of plan?.steps ?? []) {
    addStep(s, undefined);
  }

  for (const cp of plan?.checkpoints ?? []) {
    for (const s of cp.steps ?? []) {
      addStep(s, cp.title);
    }
  }

  const cardsByPath = new Map<string, BoardCard>();
  for (const card of input.board?.cards ?? []) {
    if (!card.archived && card.kind === 'file' && card.path) {
      if (!cardsByPath.has(card.path)) {
        cardsByPath.set(card.path, card);
      }
    }
  }

  const pictures: CommitPictureLink[] = [];
  const seenPicturePaths = new Set<string>();

  const addPicture = (path: string, explicitTitle?: string) => {
    const cleaned = cleanCardPath(path);
    if (!cleaned || seenPicturePaths.has(cleaned)) return;
    seenPicturePaths.add(cleaned);
    const cardTitle = cardsByPath.get(cleaned)?.title;
    pictures.push({
      path: cleaned,
      title: explicitTitle ?? cardTitle ?? fileTitle(cleaned),
    });
  };

  // (a) Every card in linkedCards with card.kind === 'file' && fileTypeOf(card.path) === 'image'
  for (const card of linkedCards) {
    if (card.kind === 'file' && card.path && fileTypeOf(card.path) === 'image') {
      addPicture(card.path, card.title);
    }
  }

  // (b) Every non-archived card in board.cards with card.kind === 'file' && fileTypeOf(card.path) === 'image' whose card.step is in matched step keys
  for (const card of input.board?.cards ?? []) {
    if (!card.archived && card.kind === 'file' && card.path && fileTypeOf(card.path) === 'image') {
      if (card.step && seenStepKeys.has(card.step)) {
        addPicture(card.path, card.title);
      }
    }
  }

  // (c) Backticked image paths inside matched step.text
  for (const step of steps) {
    let lastDir = '';
    let match: RegExpExecArray | null;
    BACKTICK_REGEX.lastIndex = 0;
    while ((match = BACKTICK_REGEX.exec(step.text)) !== null) {
      const span = match[1].trim();
      if (/[\s:*?<>|"'${}]/.test(span)) continue;
      const cleaned = cleanCardPath(span);
      if (!cleaned) continue;
      if (fileTypeOf(cleaned) === 'image') {
        if (cleaned.includes('/')) {
          lastDir = cleaned.slice(0, cleaned.lastIndexOf('/') + 1);
          addPicture(cleaned);
        } else if (lastDir) {
          const resolved = cleanCardPath(lastDir + cleaned);
          if (resolved && fileTypeOf(resolved) === 'image') {
            addPicture(resolved);
          }
        }
      }
    }
  }

  return { steps, pictures };
}
