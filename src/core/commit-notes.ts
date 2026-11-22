import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { storeOf } from './workspace-db-app.js';
import { execa } from 'execa';

import {
  BOARD_LIMITS,
  BoardWorkspaceError,
  boardActorName,
  changeBoard,
  parseCommitAbout,
  readBoard,
  type BoardNote,
} from './board.js';
import { assertWorkspaceActive } from './archive-guard.js';
import { cleanRepoName, cleanScreenBlock, cleanScreenText } from './screen-clean.js';
import { loadFeatureConfig } from './workspace.js';
import { getWorkspaceRepoPaths } from '../utils/multi-git.js';

const MAX_COMMIT_SPEC_LENGTH = 256;
const MIN_HEX_LENGTH = 7;
const MAX_HEX_LENGTH = 64;
const HEX_ONLY = /^[0-9a-fA-F]+$/;
const SAFE_COMMIT_SPEC = /^[A-Za-z0-9._/~^-]+$/;
const GIT_TIMEOUT_MS = 10_000;

export class CommitNoteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitNoteInputError';
  }
}

export class CommitNoteNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitNoteNotFoundError';
  }
}

export class CommitNoteAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitNoteAmbiguousError';
  }
}

export interface CommitNote {
  id: string;
  repo: string;
  sha: string;
  shortSha: string;
  title: string;
  body: string;
  by: string;
  at: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ResolvedCommitTarget {
  repo: string;
  repoPath: string;
  sha: string;
}

export interface AddCommitNoteInput {
  commit: string;
  text: string;
  repo?: string;
  title?: string;
  by?: string;
  cwd?: string;
}

export interface AddCommitNoteResult {
  note: CommitNote;
  revision: number;
  commitNodeId: string;
}

export interface ListCommitNotesOptions {
  commit?: string;
  repo?: string;
  cwd?: string;
}

function readOnlyGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    GIT_NO_LAZY_FETCH: '1',
  };
}

function validateCommitSpec(raw: string): string {
  const spec = raw.trim();
  if (!spec) throw new CommitNoteInputError('Commit hash or reference is required.');
  if (spec.length > MAX_COMMIT_SPEC_LENGTH) throw new CommitNoteInputError('Commit reference is too long.');
  if (spec.startsWith('-')) throw new CommitNoteInputError('Commit reference cannot start with "-".');
  if (spec.includes('..') || spec.includes('//') || !SAFE_COMMIT_SPEC.test(spec)) {
    throw new CommitNoteInputError(`Invalid commit reference: "${spec}".`);
  }
  if (HEX_ONLY.test(spec)) {
    if (spec.length < MIN_HEX_LENGTH) {
      throw new CommitNoteInputError(`Commit hash "${spec}" is too short; use at least ${MIN_HEX_LENGTH} hex characters or a ref such as HEAD.`);
    }
    if (spec.length > MAX_HEX_LENGTH) {
      throw new CommitNoteInputError(`Commit hash "${spec}" is too long.`);
    }
  }
  return spec;
}

function normalizeRepoFilter(raw: string): string {
  const cleaned = cleanRepoName(raw);
  if (!cleaned) throw new CommitNoteInputError('Invalid repository name.');
  return cleaned;
}

async function isGitRepoDir(repoPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

type RepoResolveResult =
  | { status: 'found'; sha: string }
  | { status: 'ambiguous' }
  | { status: 'not-found' };

async function resolveCommitInRepo(repoPath: string, spec: string): Promise<RepoResolveResult> {
  if (!(await isGitRepoDir(repoPath))) return { status: 'not-found' };
  const result = await execa('git', ['--no-optional-locks', 'rev-parse', '--verify', `${spec}^{commit}`], {
    cwd: repoPath,
    env: readOnlyGitEnv(),
    timeout: GIT_TIMEOUT_MS,
    reject: false,
  });
  if (result.exitCode !== 0) {
    if (HEX_ONLY.test(spec) && /ambiguous/i.test(result.stderr)) {
      return { status: 'ambiguous' };
    }
    return { status: 'not-found' };
  }
  const sha = result.stdout.trim().toLowerCase();
  return HEX_ONLY.test(sha) && sha.length >= MIN_HEX_LENGTH
    ? { status: 'found', sha }
    : { status: 'not-found' };
}

function pathKey(target: string): string {
  return process.platform === 'win32' ? target.toLowerCase() : target;
}

function isPathWithin(parent: string, target: string): boolean {
  const rel = path.relative(pathKey(parent), pathKey(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function realpathOrResolve(target: string): Promise<string> {
  return fs.realpath(target).catch(() => path.resolve(target));
}

async function findContainingRepo<T extends { name: string; path: string }>(
  repos: T[],
  cwd: string | undefined,
): Promise<T | undefined> {
  if (!cwd) return undefined;
  const realCwd = await realpathOrResolve(cwd);
  const containing: Array<{ repo: T; realPath: string }> = [];
  for (const repo of repos) {
    const realRepo = await realpathOrResolve(repo.path);
    if (isPathWithin(realRepo, realCwd)) {
      containing.push({ repo, realPath: realRepo });
    }
  }
  if (containing.length === 0) return undefined;
  if (containing.length === 1) return containing[0]!.repo;
  containing.sort((a, b) => b.realPath.length - a.realPath.length);
  if (pathKey(containing[0]!.realPath) === pathKey(containing[1]!.realPath)) return undefined;
  return containing[0]!.repo;
}

function selectCandidateRepos<T extends { name: string }>(repos: T[], requestedRepo?: string): T[] {
  if (requestedRepo === undefined) return repos;
  const target = normalizeRepoFilter(requestedRepo);
  const exact = repos.filter((repo) => repo.name === target);
  if (exact.length === 1) return exact;
  if (exact.length > 1) return exact;

  const lower = target.toLowerCase();
  const ci = repos.filter((repo) => repo.name.toLowerCase() === lower);
  if (ci.length === 1) return ci;
  if (ci.length > 1) {
    throw new CommitNoteAmbiguousError(`Repository name "${target}" matches multiple workspace repositories (${ci.map((r) => r.name).join(', ')}).`);
  }
  const available = repos.length > 0 ? ` Available: ${repos.map((r) => r.name).join(', ')}.` : ' Workspace has no repositories.';
  throw new CommitNoteInputError(`Repository "${target}" was not found in this workspace.${available}`);
}

/**
 * Resolves a commit hash (>=7 hex chars) or revision (`HEAD`, `HEAD~1`, `origin/branch`, etc.)
 * across the workspace's repositories, including remote-tracking refs.
 *
 * When `repoName` is omitted and `cwd` lies inside one of the workspace's repositories,
 * prefers that repository first so `HEAD` and shared refs resolve unambiguously there.
 */
export async function resolveCommitForNote(
  workspacePath: string,
  commitRef: string,
  repoName?: string,
  cwd: string | undefined = process.cwd(),
): Promise<ResolvedCommitTarget> {
  const root = path.resolve(workspacePath);
  const feature = await loadFeatureConfig(root);
  if (!feature) throw new BoardWorkspaceError();

  const spec = validateCommitSpec(commitRef);
  const repos = await getWorkspaceRepoPaths(root);
  if (repos.length === 0) {
    throw new CommitNoteNotFoundError(`Workspace has no repositories to resolve commit "${spec}".`);
  }

  const candidates = selectCandidateRepos(repos, repoName);
  const preferred = repoName === undefined ? await findContainingRepo(candidates, cwd) : undefined;

  if (preferred) {
    const localResult = await resolveCommitInRepo(preferred.path, spec);
    if (localResult.status === 'found') {
      return { repo: preferred.name, repoPath: preferred.path, sha: localResult.sha };
    }
    if (localResult.status === 'ambiguous') {
      throw new CommitNoteAmbiguousError(
        `Commit "${spec}" in repository "${preferred.name}" is ambiguous, give more characters.`,
      );
    }
  }

  const remaining = preferred ? candidates.filter((repo) => repo !== preferred) : candidates;
  const matches: ResolvedCommitTarget[] = [];
  const ambiguousRepos: string[] = [];
  for (const repo of remaining) {
    const resolved = await resolveCommitInRepo(repo.path, spec);
    if (resolved.status === 'found') {
      matches.push({ repo: repo.name, repoPath: repo.path, sha: resolved.sha });
    } else if (resolved.status === 'ambiguous') {
      ambiguousRepos.push(repo.name);
    }
  }

  if (matches.length === 1 && ambiguousRepos.length === 0) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new CommitNoteAmbiguousError(
      `Commit "${spec}" resolved in multiple repositories (${matches.map((m) => m.repo).join(', ')}). Pass --repo <name> to select one.`,
    );
  }
  if (ambiguousRepos.length > 0 && matches.length === 0) {
    throw new CommitNoteAmbiguousError(
      `Commit "${spec}" in repository "${ambiguousRepos[0]!}" is ambiguous, give more characters.`,
    );
  }
  if (ambiguousRepos.length > 0) {
    const names = [...matches.map((m) => m.repo), ...ambiguousRepos].join(', ');
    throw new CommitNoteAmbiguousError(
      `Commit "${spec}" resolved in multiple repositories (${names}). Pass --repo <name> to select one.`,
    );
  }

  if (repoName) {
    throw new CommitNoteNotFoundError(`Commit "${spec}" was not found in repository "${candidates[0]!.name}".`);
  }
  throw new CommitNoteNotFoundError(`Commit "${spec}" was not found in any workspace repository.`);
}

function normalizeNoteActor(rawBy?: string): string {
  const name = boardActorName(rawBy);
  return !name || name === 'user' ? 'ai' : name;
}

function deriveNoteTitle(text: string, explicitTitle?: string): string {
  if (explicitTitle !== undefined) {
    const cleaned = cleanScreenText(explicitTitle, BOARD_LIMITS.title);
    if (!cleaned) throw new CommitNoteInputError('Note title cannot be empty.');
    return cleaned;
  }
  const firstLine = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const cleaned = cleanScreenText(firstLine, BOARD_LIMITS.title);
  if (!cleaned) throw new CommitNoteInputError('Note text cannot be empty.');
  return cleaned;
}

function noteFromCard(card: BoardNote): CommitNote | null {
  if (card.archived) return null;
  const parsed = parseCommitAbout(card.about);
  if (!parsed) return null;
  return {
    id: card.id,
    repo: parsed.repo,
    sha: parsed.sha,
    shortSha: parsed.sha.slice(0, MIN_HEX_LENGTH),
    title: card.title,
    body: card.body,
    by: card.by,
    at: card.at,
    updatedBy: card.updatedBy,
    updatedAt: card.updatedAt,
  };
}

function sortNewestFirst(notes: CommitNote[]): CommitNote[] {
  return [...notes].map((note, index) => ({ note, index, ms: Date.parse(note.at) })).sort((a, b) => {
    const aMs = Number.isNaN(a.ms) ? 0 : a.ms;
    const bMs = Number.isNaN(b.ms) ? 0 : b.ms;
    if (bMs !== aMs) return bMs - aMs;
    // Later array entries were appended more recently when timestamps match.
    return b.index - a.index;
  }).map((entry) => entry.note);
}

/**
 * Adds a note card attached to a commit (`about: commit:<repo>:<fullSha>`) and its board link
 * (`{ from: cardId, to: commit:<repo>:<fullSha>, label: 'note' }`) in one atomic board change.
 */
export async function addCommitNote(workspacePath: string, input: AddCommitNoteInput): Promise<AddCommitNoteResult> {
  const root = path.resolve(workspacePath);
  const feature = await loadFeatureConfig(root);
  if (!feature) throw new BoardWorkspaceError();
  assertWorkspaceActive(feature, 'add a commit note');

  if (typeof input.text !== 'string' || !cleanScreenBlock(input.text, BOARD_LIMITS.body)?.trim()) {
    throw new CommitNoteInputError('Note text cannot be empty.');
  }

  const title = deriveNoteTitle(input.text, input.title);
  const resolved = await resolveCommitForNote(root, input.commit, input.repo, input.cwd);
  const by = normalizeNoteActor(input.by);
  const cardId = randomUUID();
  const commitNodeId = `commit:${resolved.repo}:${resolved.sha}`;

  const { board } = await changeBoard(
    root,
    [
      { op: 'add_card', id: cardId, kind: 'note', title, body: input.text, about: commitNodeId },
      { op: 'link', from: cardId, to: commitNodeId, label: 'note' },
    ],
    { by, allowCommitAbout: true },
  );

  const added = board.cards.find((card): card is BoardNote => card.id === cardId && card.kind === 'note');
  if (!added) throw new Error('Added commit note missing from saved board.');
  const note = noteFromCard(added);
  if (!note) throw new Error('Saved commit note failed validation.');

  return { note, revision: board.revision, commitNodeId };
}

function readAllStoredCommitNotes(cards: readonly { kind: string }[]): CommitNote[] {
  const notes: CommitNote[] = [];
  for (const card of cards) {
    if (card.kind !== 'note') continue;
    const note = noteFromCard(card as BoardNote);
    if (note) notes.push(note);
  }
  return sortNewestFirst(notes);
}

function matchesShaPrefix(storedSha: string, queryHexLower: string): boolean {
  return storedSha === queryHexLower || storedSha.startsWith(queryHexLower) || queryHexLower.startsWith(storedSha);
}

/**
 * Lists commit notes newest first without requiring commits to still exist in git (notes on
 * rebased-away commits remain readable).
 *
 * When `options.commit` is provided (hash or ref like `HEAD~1`), tries git resolution first so refs
 * work and ambiguous hashes across multiple repos still prompt for `--repo`; if the commit has since
 * been rebased away from git and `commit` is a >=7-char hex hash matching stored notes, returns those notes.
 */
export async function listCommitNotes(workspacePath: string, options: ListCommitNotesOptions = {}): Promise<CommitNote[]> {
  const root = path.resolve(workspacePath);
  const board = await readBoard(root);
  const allNotes = readAllStoredCommitNotes(board.cards);

  let repoFilter: string | undefined;
  if (options.repo !== undefined && options.repo.trim() !== '') {
    const requested = normalizeRepoFilter(options.repo);
    const repos = await getWorkspaceRepoPaths(root).catch(() => []);
    const matched = repos.length > 0 ? selectCandidateRepos(repos, requested)[0]?.name : undefined;
    repoFilter = matched ?? requested;
  }

  const commitArg = options.commit?.trim();
  if (!commitArg) {
    return repoFilter ? allNotes.filter((note) => note.repo === repoFilter) : allNotes;
  }

  try {
    const resolved = await resolveCommitForNote(root, commitArg, repoFilter, options.cwd);
    return allNotes.filter((note) => note.repo === resolved.repo && note.sha === resolved.sha);
  } catch (error) {
    if (error instanceof CommitNoteNotFoundError) {
      const spec = commitArg.toLowerCase();
      if (HEX_ONLY.test(spec) && spec.length >= MIN_HEX_LENGTH && spec.length <= MAX_HEX_LENGTH) {
        const rebasedMatches = allNotes.filter(
          (note) => (!repoFilter || note.repo === repoFilter) && matchesShaPrefix(note.sha, spec),
        );
        if (rebasedMatches.length > 0) return rebasedMatches;
      }
    }
    throw error;
  }
}

/**
 * Queries stored commit notes by optional `repo` and `sha` prefix without running git or failing
 * when the commit has no notes or was rebased away (intended for the GUI read route).
 */
export async function queryCommitNotes(workspacePath: string, options: { repo?: string; sha?: string } = {}): Promise<CommitNote[]> {
  const root = path.resolve(workspacePath);
  // Only the app reads this: a workspace moved to its database is read there (the command line moves in DB3c).
  const board = storeOf(root) === 'database'
    ? await import('./board-db-app.js').then(({ boardDbForApp }) => boardDbForApp(root)) as unknown as { cards: Array<{ kind: string }> }
    : await readBoard(root);
  let notes = readAllStoredCommitNotes(board.cards);

  if (options.repo !== undefined && options.repo !== '') {
    const cleanRepo = normalizeRepoFilter(options.repo);
    const repos = await getWorkspaceRepoPaths(root).catch(() => []);
    const matched = repos.find((r) => r.name === cleanRepo)
      ?? repos.find((r) => r.name.toLowerCase() === cleanRepo.toLowerCase());
    const targetRepo = matched?.name ?? cleanRepo;
    notes = notes.filter((note) => note.repo === targetRepo);
  }

  if (options.sha !== undefined && options.sha !== '') {
    const spec = options.sha.trim().toLowerCase();
    if (!HEX_ONLY.test(spec) || spec.length < MIN_HEX_LENGTH || spec.length > MAX_HEX_LENGTH) {
      throw new CommitNoteInputError(`Invalid commit hash "${options.sha}". Expected ${MIN_HEX_LENGTH}-${MAX_HEX_LENGTH} hex characters.`);
    }
    notes = notes.filter((note) => matchesShaPrefix(note.sha, spec));
  }

  return notes;
}
