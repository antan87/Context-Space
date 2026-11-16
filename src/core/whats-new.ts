/**
 * @module core/whats-new
 * What changed in a workspace since someone last looked, and who made each change. Several AI tools and the
 * developer work in one workspace in no fixed order, so each reader (the user, `claude`, `codex`, ...) keeps a short
 * record of when they last looked, and this reads the four places changes show up against it: the plan, the
 * documents and images left in the workspace, the knowledge, and the commits in each repository.
 *
 * The record lives in `.contextspace/seen.json`. It is kept per reader, so one reader looking never hides a change
 * from another. It holds the time, each repository's HEAD then, and the knowledge entries and document names then,
 * which is what tells a new entry from an old one and an added document from a changed one.
 *
 * A screen cannot mark the list in the same breath as it reads it. So a report asked for with `pending` also keeps
 * what it saw as the reader's pending record, and {@link markSeen} makes exactly that record the reader's own, for
 * the report whose time it is given. Whatever lands between the two is shown next time, never lost.
 *
 * Reading is cheap on purpose: the plan's change log, one folder walk that leaves repositories out, the knowledge
 * file, and two bounded git calls per repository.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa } from 'execa';
import { acquireLock } from './locks.js';
import { PLAN_FILE } from './plan-file.js';
import { CHANGES_KEPT, readPlanChanges, readPlanFile, type PlanFileChange } from './plan-file-store.js';
import { describeKnowledgeEntry, knowledgeEntryId, parseKnowledgeEntries, readWorkspaceKnowledge, type KnowledgeEntryType } from './knowledge.js';
import { listRootDocuments } from './root-documents.js';
import { assertNoLinkedPathComponents, atomicWriteFile } from '../resources/fs-safety.js';
import { isGitRepo } from '../utils/git.js';
import { getWorkspaceRepoPaths } from '../utils/multi-git.js';
import { DETAILED_COMMIT_FORMAT, parseDetailedCommitLog, type ParsedDetailedCommit } from './commit-log-format.js';
import { readLocalIncomingForRepo, type IncomingCommit, type IncomingHost } from './incoming-commits.js';
import { BoardWorkspaceError } from './board.js';
import { listCommitNotes } from './commit-notes.js';
import { readQuestions, type QuestionAnswer } from './questions.js';

export { DETAILED_COMMIT_FORMAT, parseDetailedCommitLog, type ParsedDetailedCommit };

/** How many items each section lists (per repository for commits); the rest are counted. */
export const NEWS_LIMIT = 10;
/** How far back a first look reaches. */
export const FIRST_LOOK_DAYS = 3;

const SEEN_FILE = '.contextspace/seen.json';
const SEEN_LOCK = '.contextspace/seen.lock';
/** What one record keeps. A longer list is cut to the newest, and the cut is remembered by the length. */
const KEPT_KNOWLEDGE = 500;
const KEPT_DOCUMENTS = 1000;
const KEPT_NOTES = 500;
/** The readers kept in the file; the least recent ones are dropped. */
const KEPT_READERS = 20;
/** The most commits one repository counts, so a long history is never walked. */
const COMMITS_COUNTED = 100;
const GIT_TIMEOUT_MS = 15_000;
const SHA = /^[0-9a-f]{7,64}$/;
const READER = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** What a reader had seen when they last looked. */
export interface SeenRecord {
  at: string;
  /** Each repository's HEAD, by the repository's name. */
  repos: Record<string, string>;
  /** Each repository's last-seen remote-tracking commit, by the repository's name. */
  incoming?: Record<string, string>;
  /** The ids (date and title as a slug) of the knowledge entries. */
  knowledge: string[];
  /** The names of the documents, newest first. */
  documents: string[];
  /** The ids of commit notes seen then. */
  notes?: string[];
  answers?: Array<{ path: string; broken: string[]; at?: string }>;
}

/** `readers`: when each reader last looked. `pending`: what the report a screen showed them saw, until they say so. */
interface SeenFile { version: 1; readers: Record<string, SeenRecord>; pending: Record<string, SeenRecord> }

/** The list a reader marked as seen is not the one they were shown last: read it again. */
export class NewsChangedError extends Error {
  constructor() {
    super('The list changed; read it again.');
    this.name = 'NewsChangedError';
  }
}

export type NewsPlanChange = PlanFileChange;

export interface NewsDocument {
  name: string;
  kind: 'html' | 'markdown' | 'text' | 'pdf' | 'image' | 'download';
  /** `added` when the reader's record does not list it; `changed` when it does or when that cannot be told. */
  change: 'added' | 'changed';
  at: string;
}

export interface NewsKnowledge {
  id: string;
  title: string;
  date: string | null;
  type: KnowledgeEntryType | null;
}

export interface NewsCommit {
  sha: string;
  author: string;
  subject: string;
  at: string;
  firstBodyLine?: string;
  fileCount?: number;
  pushed?: boolean;
}

/** One repository's commits, or why they could not be read. */
export interface NewsRepo {
  repo: string;
  /** Newest first. */
  commits: NewsCommit[];
  /** How many more there are than listed; with `moreAtLeast`, at least that many. */
  more: number;
  moreAtLeast?: true;
  /** One line saying why the repository could not be read. */
  problem?: string;
}

export interface NewsSection<T> {
  items: T[];
  /** How many more there are than listed. */
  more: number;
}

export interface NewsIncomingGroup {
  author: string;
  count: number;
  newestSha: string;
  newestAt: string;
  subject: string;
}

export interface NewsIncomingRepo {
  repo: string;
  host: IncomingHost | null;
  groups: NewsIncomingGroup[];
}

export interface NewsCommitNote {
  id: string;
  repo: string;
  sha: string;
  shortSha: string;
  title: string;
  body: string;
  by: string;
  at: string;
}

export interface NewsAnswer { path: string; question: string; change: 'added' | 'changed' | 'out-of-date'; copies: number; at: string }

export function formatAnswerNewsLine(answer: NewsAnswer): string {
  if (answer.change === 'out-of-date') return `Answer out of date: ${answer.question} (${answer.copies} ${answer.copies === 1 ? 'copy' : 'copies'})`;
  return `${answer.change === 'added' ? 'New answer' : 'Answer updated'}: ${answer.question}`;
}

export interface WhatsNew {
  reader: string;
  /** When this report was made; hand it to {@link markSeen} to say the reader has looked. */
  at: string;
  /** How far back the report reaches. */
  from: string;
  /** `last-look`: since the reader's record. `first-look`: they have none, so the last few days. `time`: a time they asked for. */
  basis: 'last-look' | 'first-look' | 'time';
  /** The plan's changes, oldest first. The ones listed are the newest, so `more` counts older ones. */
  plan: NewsSection<NewsPlanChange>;
  /** Newest first. */
  documents: NewsSection<NewsDocument>;
  /** Newest first. */
  knowledge: NewsSection<NewsKnowledge>;
  /** Newest first. */
  notes?: NewsSection<NewsCommitNote>;
  answers?: NewsSection<NewsAnswer>;
  commits: NewsRepo[];
  /** Unseen commits sitting on local remote-tracking refs (never fetched during news). */
  incoming?: NewsIncomingRepo[];
  /** Things that could not be read, one line each. A repository that could not be read is in `commits` instead. */
  problems: string[];
  /** Nothing changed in any section. */
  empty: boolean;
}

export interface WhatsNewOptions {
  now?: Date;
  /** Reach back to this time instead of the reader's record. */
  since?: string;
  limit?: number;
  /** Also record that the reader has looked, with what this report saw. */
  mark?: boolean;
  /** Keep what this report saw as the reader's pending record, for {@link markSeen} to make theirs. */
  pending?: boolean;
}

/** The reader's name as the record keeps it: lower case, no spaces. */
export function newsReaderName(name: string): string {
  const reader = name.trim().toLowerCase().replace(/\s+/g, '-');
  if (!READER.test(reader)) throw new Error(`"${name}" is not a name to read as. Use a short name such as "user", "claude" or "codex".`);
  return reader;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function recordFrom(value: unknown): SeenRecord | null {
  if (!isObject(value) || typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) return null;
  const strings = (list: unknown, max: number) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string').slice(0, max) : []);
  const repos = Object.entries(isObject(value.repos) ? value.repos : {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && SHA.test(entry[1]));
  const incoming = Object.entries(isObject(value.incoming) ? value.incoming : {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && SHA.test(entry[1]));
  const notes = Array.isArray(value.notes) ? strings(value.notes, KEPT_NOTES) : undefined;
  return {
    at: value.at,
    repos: Object.fromEntries(repos),
    ...(incoming.length > 0 ? { incoming: Object.fromEntries(incoming) } : {}),
    knowledge: strings(value.knowledge, KEPT_KNOWLEDGE),
    documents: strings(value.documents, KEPT_DOCUMENTS),
    ...(notes !== undefined ? { notes } : {}),
    ...(Array.isArray(value.answers) ? { answers: value.answers.slice(0, KEPT_NOTES).flatMap((entry) => isObject(entry) && typeof entry.path === 'string' ? [{ path: entry.path, broken: strings(entry.broken, 20000), ...(typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at)) ? { at: entry.at } : {}) }] : []) } : {}),
  };
}

const EMPTY_SEEN: SeenFile = { version: 1, readers: {}, pending: {} };

/** The records of a file's `readers` or `pending`, leaving out a name or a record that cannot be used. */
function recordsFrom(value: unknown): Record<string, SeenRecord> {
  const kept = Object.entries(isObject(value) ? value : {}).flatMap(([reader, record]) => {
    const usable = READER.test(reader) ? recordFrom(record) : null;
    return usable ? [[reader, usable] as const] : [];
  });
  return Object.fromEntries(kept);
}

/** A reader's own entry. Not `records[reader]`: a reader may be named `constructor`. */
const entryOf = (records: Record<string, SeenRecord>, reader: string): SeenRecord | null => (Object.hasOwn(records, reader) ? records[reader]! : null);

/** The file as it is; a missing or damaged one reads as empty, so every reader simply has a first look again. */
async function readSeenFile(root: string): Promise<SeenFile> {
  const file = path.join(root, SEEN_FILE);
  await assertNoLinkedPathComponents(root, file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return EMPTY_SEEN;
  }
  return isObject(parsed) ? { version: 1, readers: recordsFrom(parsed.readers), pending: recordsFrom(parsed.pending) } : EMPTY_SEEN;
}

/** The newest records, and always `keep`'s. */
function newest(records: Record<string, SeenRecord>, keep: string): Record<string, SeenRecord> {
  const others = Object.entries(records).filter(([name]) => name !== keep)
    .sort(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at)).slice(0, KEPT_READERS - 1);
  const own = entryOf(records, keep);
  return Object.fromEntries([...others, ...(own ? [[keep, own] as const] : [])]);
}

/** Changes the file under its lock: `change` gets what is there, and says which reader's record it touched. */
async function updateSeenFile(root: string, change: (seen: SeenFile) => string): Promise<void> {
  const file = path.join(root, SEEN_FILE);
  await assertNoLinkedPathComponents(root, file);
  const release = await acquireLock(path.join(root, SEEN_LOCK), {
    staleMs: 30_000, timeoutMs: 10_000, timeoutMessage: 'Another session is saving what it has seen. Retry.',
  });
  try {
    const seen = await readSeenFile(root);
    const readers = { ...seen.readers };
    const pending = { ...seen.pending };
    const reader = change({ version: 1, readers, pending });
    await atomicWriteFile(file, `${JSON.stringify({ version: 1, readers: newest(readers, reader), pending: newest(pending, reader) })}\n`);
  } finally {
    await release();
  }
}

/** The reader has looked: this is what they saw. Whatever a screen held for them is out of date now. */
const saveRecord = (root: string, reader: string, record: SeenRecord) => updateSeenFile(root, (seen) => {
  seen.readers[reader] = record;
  delete seen.pending[reader];
  return reader;
});

/** The reader's pending record becomes theirs, when it is the one made at `at`. */
const promotePending = (root: string, reader: string, at: number) => updateSeenFile(root, (seen) => {
  const held = entryOf(seen.pending, reader);
  if (!held || Date.parse(held.at) !== at) throw new NewsChangedError();
  seen.readers[reader] = held;
  delete seen.pending[reader];
  return reader;
});

// ─── Reading the workspace ─────────────────────────────────────────────────────

interface RepoHead { name: string; path: string; head?: string; problem?: string }
interface DocumentFile { name: string; kind: NewsDocument['kind']; modifiedAt: string }

/** What the workspace looked like when it was read: the one thing a report and the record are both made from. */
interface Snapshot {
  heads: RepoHead[];
  documents: DocumentFile[];
  knowledge: NewsKnowledge[];
  notes: NewsCommitNote[];
  answers: QuestionAnswer[];
  problems: string[];
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 160);

/** Runs git in a repository. Never throws: a failure comes back with the one line that says why. */
async function git(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; code?: number; quiet: boolean; reason: string }> {
  try {
    const result = await execa('git', ['--no-optional-locks', ...args], { cwd, reject: false, timeout: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } });
    if (result.exitCode === 0) return { ok: true, stdout: result.stdout };
    if (result.timedOut) return { ok: false, quiet: false, reason: 'git took too long' };
    const line = (result.stderr || result.shortMessage || 'git failed').split('\n')[0]!.replace(/^fatal:\s*/i, '').trim();
    return { ok: false, code: result.exitCode, quiet: !result.stderr, reason: line.slice(0, 160) };
  } catch (error) {
    return { ok: false, quiet: false, reason: reasonOf(error) };
  }
}

async function repoHead(repo: { name: string; path: string }): Promise<RepoHead> {
  // A folder that is not a repository would otherwise answer with the repository around it.
  if (!(await isGitRepo(repo.path))) return { ...repo, problem: (await fs.stat(repo.path).catch(() => null)) ? 'This is not a git repository.' : 'The folder is missing.' };
  const found = await git(repo.path, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (found.ok) return { ...repo, head: found.stdout.trim() };
  // `-q` makes a repository without commits exit 1 and say nothing: it has no news yet, which is not a problem.
  return found.code === 1 && found.quiet ? repo : { ...repo, problem: found.reason };
}

/** Generated for the AI tools or kept by ContextSpace itself: the plan, the knowledge and the commits cover what matters. (workspace.md: an older version's index, until a refresh removes it.) */
function isOwnFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (!lower.includes('/')) return ['agents.md', 'claude.md', 'workspace.md', PLAN_FILE.toLowerCase()].includes(lower) || /^(contextspace|nexusflow)[-.]/.test(lower);
  return /^\.(claude|agents)\/(skills|agents)\//.test(lower) || lower === '.github/copilot-instructions.md';
}

/** The folders of the repositories that sit inside the workspace, relative to it. */
function repoFolders(root: string, repos: Array<{ path: string }>): string[] {
  return repos.flatMap((repo) => {
    const relative = path.relative(root, repo.path);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? [relative.split(path.sep).join('/')] : [];
  });
}

async function readDocuments(root: string, repos: Array<{ path: string }>): Promise<DocumentFile[]> {
  const folders = repoFolders(root, repos);
  const { documents } = await listRootDocuments(root, '', true, { repoFolders: folders, leaveOut: folders });
  return documents.filter((document) => !isOwnFile(document.name)).map(({ name, kind, modifiedAt }) => ({ name, kind, modifiedAt }))
    .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
}

async function readKnowledge(workspacePath: string): Promise<NewsKnowledge[]> {
  const markdown = await readWorkspaceKnowledge(workspacePath);
  if (!markdown) return [];
  return parseKnowledgeEntries(markdown).flatMap((entry) => {
    const id = knowledgeEntryId(entry.text);
    if (!id) return [];
    const { title, date } = describeKnowledgeEntry(entry);
    return [{ id, title, date, type: entry.type }];
  }).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

async function takeSnapshot(root: string): Promise<Snapshot> {
  const problems: string[] = [];
  const unreadable = <T>(what: string, fallback: T) => (error: unknown): T => {
    problems.push(`${what} could not be read: ${reasonOf(error)}`);
    return fallback;
  };
  const repos = await getWorkspaceRepoPaths(root).catch(unreadable('The list of repositories', []));
  const readNotes = unreadable('Commit notes', [] as NewsCommitNote[]);
  const [heads, documents, knowledge, notes, answers] = await Promise.all([
    Promise.all(repos.map(repoHead)),
    readDocuments(root, repos).catch(unreadable('The documents', [])),
    readKnowledge(root).catch(unreadable('The knowledge', [])),
    listCommitNotes(root).then((items): NewsCommitNote[] =>
      items.map(({ id, repo, sha, shortSha, title, body, by, at }) => ({ id, repo, sha, shortSha, title, body, by, at })),
    ).catch((error) => (error instanceof BoardWorkspaceError ? [] : readNotes(error))),
    readQuestions(root).catch(unreadable('Answers', [] as QuestionAnswer[])),
  ]);
  return { heads, documents, knowledge, notes, answers, problems };
}

function recordOf(snapshot: Snapshot, at: string, incomingRefs: Record<string, string> = {}, previous: SeenRecord | null = null, unavailable: Set<string> = new Set()): SeenRecord {
  const incomingEntries = Object.entries(incomingRefs).filter(([, sha]) => SHA.test(sha));
  return {
    at,
    repos: Object.fromEntries(snapshot.heads.flatMap((repo) => (repo.head ? [[repo.name, repo.head] as const] : []))),
    ...(incomingEntries.length > 0 ? { incoming: Object.fromEntries(incomingEntries) } : {}),
    knowledge: snapshot.knowledge.slice(0, KEPT_KNOWLEDGE).map((entry) => entry.id),
    documents: snapshot.documents.slice(0, KEPT_DOCUMENTS).map((document) => document.name),
    notes: snapshot.notes.slice(0, KEPT_NOTES).map((note) => note.id),
    answers: [...snapshot.answers.map((answer) => ({ path: answer.path, broken: brokenCopies(answer, previous?.answers?.find((entry) => entry.path === answer.path)?.broken) })), ...[...unavailable].map((name) => { const old = previous?.answers?.find((entry) => entry.path === name); return { path: name, broken: old?.broken ?? [], at: old?.at ?? previous?.at ?? new Date(0).toISOString() }; })].slice(0, KEPT_NOTES),
  };
}

// ─── The sections ──────────────────────────────────────────────────────────────

const afterTime = (at: string, from: number) => Date.parse(at) > from;

/** The first `limit` of the items, and how many were left out. */
function capped<T>(items: T[], limit: number): NewsSection<T> {
  return { items: items.slice(0, limit), more: Math.max(0, items.length - limit) };
}

/** The plan notices an edit to PLAN.md when it is read, whoever made it; reading it here puts the edit in the log. */
async function noticePlanEdits(root: string): Promise<void> {
  if (await fs.access(path.join(root, PLAN_FILE)).then(() => true, () => false)) await readPlanFile(root);
}

/**
 * The plan's changes from `from` up to `until`, oldest first. A reader's own changes are left out; `ai` names no one,
 * so changes by `ai` stay.
 */
async function planNews(root: string, reader: string, from: number, until: number, limit: number): Promise<NewsSection<NewsPlanChange>> {
  const changes = (await readPlanChanges(root, CHANGES_KEPT))
    .filter((change) => afterTime(change.at, from) && Date.parse(change.at) <= until && (reader === 'ai' || change.by !== reader));
  const section = capped(changes, limit);
  return { items: section.items.reverse(), more: section.more };
}

function documentNews(files: DocumentFile[], record: SeenRecord | null, from: number, limit: number): NewsSection<NewsDocument> {
  const known = new Set(record?.documents);
  // A record cut to its newest names cannot say a document is new.
  const complete = record !== null && record.documents.length < KEPT_DOCUMENTS;
  return capped(files.filter((file) => afterTime(file.modifiedAt, from)).map((file) => ({
    name: file.name, kind: file.kind, at: file.modifiedAt, change: complete && !known.has(file.name) ? 'added' as const : 'changed' as const,
  })), limit);
}

function brokenCopies(answer: QuestionAnswer, previous: string[] = []): string[] {
  return answer.parts.flatMap((part, partIndex) => part.cards.flatMap((card, cardIndex) => {
    if (card.kind !== 'code') return [];
    const id = `${partIndex}:${cardIndex}:${card.where ?? ''}:${card.start ?? ''}:${card.end ?? ''}`;
    const unknown = card.check.status === 'unreadable' || card.check.status === 'not-in-workspace';
    return card.check.status === 'changed' || card.check.status === 'gone' || (unknown && previous.includes(id)) ? [id] : [];
  }));
}

function answerNews(answers: QuestionAnswer[], record: SeenRecord | null, from: number, limit: number, at: string): NewsSection<NewsAnswer> {
  const previous = new Map(record?.answers?.map((entry) => [entry.path, entry]) ?? []);
  return capped(answers.flatMap((answer): NewsAnswer[] => {
    const broken = brokenCopies(answer);
    const old = previous.get(answer.path);
    const changed = afterTime(answer.modifiedAt, old?.at ? Date.parse(old.at) : from);
    const isNew = changed && (!record || !record.documents.includes(answer.path));
    const change = isNew ? 'added' : changed ? 'changed' : !(record && record.answers === undefined && !afterTime(answer.modifiedAt, Date.parse(record.at))) && broken.some((copy) => !old?.broken.includes(copy)) ? 'out-of-date' : null;
    return change ? [{ path: answer.path, question: answer.question, change, copies: broken.length, at: change === 'out-of-date' ? at : answer.modifiedAt }] : [];
  }), limit);
}

/** Entries the record does not list; without a record, the entries dated since `from`. */
function knowledgeNews(entries: NewsKnowledge[], record: SeenRecord | null, from: number, limit: number): NewsSection<NewsKnowledge> {
  if (!record) {
    const day = new Date(from).toISOString().slice(0, 10);
    return capped(entries.filter((entry) => entry.date !== null && entry.date >= day), limit);
  }
  const known = new Set(record.knowledge);
  // A record cut to its newest entries says nothing about the entries older than its oldest.
  const oldest = record.knowledge.length >= KEPT_KNOWLEDGE ? entries.find((entry) => entry.id === record.knowledge.at(-1))?.date ?? null : null;
  return capped(entries.filter((entry) => !known.has(entry.id) && (oldest === null || (entry.date ?? '') >= oldest)), limit);
}

/** Notes the record does not list; without a record, or after an upgrade without `notes`, only notes made since `from` or `record.at`. */
function commitNoteNews(notes: NewsCommitNote[], record: SeenRecord | null, from: number, limit: number): NewsSection<NewsCommitNote> {
  if (!record) return capped(notes.filter((note) => afterTime(note.at, from)), limit);
  if (record.notes === undefined) return capped(notes.filter((note) => afterTime(note.at, Date.parse(record.at))), limit);
  const known = new Set(record.notes);
  const oldest = record.notes.length >= KEPT_NOTES ? notes.find((note) => note.id === record.notes!.at(-1))?.at ?? null : null;
  return capped(notes.filter((note) => !known.has(note.id) && (oldest === null || note.at >= oldest)), limit);
}

export function formatCommitNoteNewsLine(note: Pick<NewsCommitNote, 'by' | 'shortSha' | 'repo' | 'title'>): string {
  const actor = note.by === 'ai'
    ? 'AI'
    : `${note.by.charAt(0).toUpperCase()}${note.by.slice(1)}`;
  return `${actor} note on ${note.shortSha} (${note.repo}): ${note.title}`;
}

const RECENT_COMMITS_LIMIT = 50;

function parseCommits(stdout: string): NewsCommit[] {
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [sha = '', author = '', date = '', ...subject] = line.split('\x1f');
    const time = new Date(date);
    return { sha, author, at: Number.isNaN(time.getTime()) ? date : time.toISOString(), subject: subject.join('\x1f') };
  });
}

function groupIncomingByAuthor(commits: IncomingCommit[]): NewsIncomingGroup[] {
  const byAuthor = new Map<string, NewsIncomingGroup>();
  for (const commit of commits) {
    const author = commit.author || 'Unknown';
    const existing = byAuthor.get(author);
    if (existing) {
      existing.count += 1;
    } else {
      byAuthor.set(author, {
        author,
        count: 1,
        newestSha: commit.sha,
        newestAt: commit.at,
        subject: commit.subject,
      });
    }
  }
  return [...byAuthor.values()];
}

export function formatIncomingNewsLine(
  repo: string,
  count: number,
  author: string,
  host: { name: string } | null | undefined,
): string {
  const noun = count === 1 ? 'commit' : 'commits';
  const summary = host?.name
    ? `${count} new ${noun} from ${author} on ${host.name}`
    : `${count} new ${noun} from ${author}`;
  return `${repo}: ${summary}`;
}

function parseDetailedCommits(stdout: string, unpushed: Set<string> | null): NewsCommit[] {
  return parseDetailedCommitLog(stdout).map(({ fullSha, ...commit }) => ({
    ...commit,
    ...(unpushed !== null ? { pushed: !unpushed.has(fullSha) } : {}),
  }));
}

/** Commits since the recorded HEAD; when that is unknown or gone (a rebase), the commits since `from`. */
async function repoNews(
  repo: RepoHead,
  recorded: string | undefined,
  from: string,
  limit: number,
  options: { detailed?: boolean; seenIncomingOid?: string } = {},
): Promise<NewsRepo> {
  const none: NewsRepo = { repo: repo.name, commits: [], more: 0 };
  if (repo.problem) return { ...none, problem: repo.problem };
  if (!repo.head || repo.head === recorded) return none;
  const detailed = options.detailed === true;
  const format = detailed
    ? DETAILED_COMMIT_FORMAT
    : '--format=%h%x1f%an%x1f%cI%x1f%s';
  const extra = detailed ? ['--shortstat'] : [];
  const sinceArg = `--since=${new Date(from).toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
  let seenIncoming: string | undefined;
  if (options.seenIncomingOid && SHA.test(options.seenIncomingOid)) {
    const exists = await git(repo.path, ['rev-parse', '--verify', '-q', `${options.seenIncomingOid}^{commit}`]);
    if (exists.ok) seenIncoming = options.seenIncomingOid;
  }
  const notArgs = seenIncoming ? ['--not', seenIncoming] : [];
  const log = (...range: string[]) => git(repo.path, ['log', `--max-count=${COMMITS_COUNTED}`, ...extra, format, ...range, ...notArgs, '--']);
  const revRange = recorded ? [`${recorded}..${repo.head}`] : [sinceArg, repo.head];
  const unpushedExclude = seenIncoming ? [`^${seenIncoming}`] : [];
  let unpushedPromise: ReturnType<typeof git> | Promise<null> = detailed
    ? git(repo.path, ['rev-list', '--max-count=500', ...revRange, ...unpushedExclude, '--not', '--remotes', '--'])
    : Promise.resolve(null);
  let result = recorded ? await log(`${recorded}..${repo.head}`) : null;
  if (!result?.ok) {
    if (recorded && detailed) {
      unpushedPromise = git(repo.path, ['rev-list', '--max-count=500', sinceArg, repo.head, ...unpushedExclude, '--not', '--remotes', '--']);
    }
    result = await log(sinceArg, repo.head);
  }
  if (!result.ok) return { ...none, problem: result.reason };
  let unpushed: Set<string> | null = null;
  if (detailed) {
    const revResult = await unpushedPromise;
    if (revResult?.ok) {
      unpushed = new Set(revResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    }
  }
  const commits = detailed ? parseDetailedCommits(result.stdout, unpushed) : parseCommits(result.stdout);
  const section = capped(commits, limit);
  return { ...none, commits: section.items, more: section.more, ...(commits.length >= COMMITS_COUNTED ? { moreAtLeast: true as const } : {}) };
}

// ─── The report ────────────────────────────────────────────────────────────────

function fromTime(options: WhatsNewOptions, record: SeenRecord | null, now: Date): { from: string; basis: WhatsNew['basis'] } {
  if (options.since !== undefined) {
    const since = Date.parse(options.since);
    if (Number.isNaN(since)) throw new Error(`"${options.since}" is not a date and time. Use a form such as 2026-10-17T09:00:00Z.`);
    return { from: new Date(since).toISOString(), basis: 'time' };
  }
  if (record) return { from: record.at, basis: 'last-look' };
  return { from: new Date(now.getTime() - FIRST_LOOK_DAYS * 24 * 60 * 60 * 1000).toISOString(), basis: 'first-look' };
}

/**
 * What changed since `reader` last looked. With `mark`, also records that they have looked, with exactly what this
 * report saw, so a commit that lands while it is being made is shown next time and never lost. With `pending`, it
 * keeps what it saw for {@link markSeen}, which a screen calls once the reader has seen the report.
 */
export async function whatsNew(workspacePath: string, reader: string, options: WhatsNewOptions = {}): Promise<WhatsNew> {
  const root = await fs.realpath(workspacePath);
  const name = newsReaderName(reader);
  const problems: string[] = [];
  // Before the time is taken, so an edit noticed now is in this report and not in the next one as well.
  await noticePlanEdits(root).catch((error) => { problems.push(`The plan could not be read: ${reasonOf(error)}`); });
  const now = options.now ?? new Date();
  const limit = options.limit ?? NEWS_LIMIT;
  const record = entryOf((await readSeenFile(root)).readers, name);
  const { from, basis } = fromTime(options, record, now);
  const fromMs = Date.parse(from);
  // A time asked for stands on its own: the record says what was seen then, not at that time.
  const kept = basis === 'last-look' ? record : null;

  const snapshot = await takeSnapshot(root);
  problems.push(...snapshot.problems);
  const [plan, commits, localIncoming] = await Promise.all([
    planNews(root, name, fromMs, now.getTime(), limit).catch((error): NewsSection<NewsPlanChange> => {
      problems.push(`The plan could not be read: ${reasonOf(error)}`);
      return { items: [], more: 0 };
    }),
    Promise.all(snapshot.heads.map((repo) => repoNews(repo, kept?.repos[repo.name], from, limit, { seenIncomingOid: kept?.incoming?.[repo.name] }))),
    Promise.all(snapshot.heads.map(async (repo) => {
      if (repo.problem) return { repo: repo.name, host: null, trackingRefOid: null, commits: [] as IncomingCommit[] };
      const seenTrackingOid = kept?.incoming?.[repo.name];
      const res = await readLocalIncomingForRepo(repo.path, {
        seenTrackingOid,
        headOid: repo.head ?? null,
      });
      const filtered = !seenTrackingOid ? res.commits.filter((commit) => afterTime(commit.at, fromMs)) : res.commits;
      return { repo: repo.name, host: res.host, trackingRefOid: res.trackingRefOid, commits: filtered };
    })),
  ]);
  const documents = documentNews(snapshot.documents.filter((document) => !/^explain\/[^/]+\.md$/i.test(document.name)), kept, fromMs, limit);
  const answers = answerNews(snapshot.answers, kept, fromMs, limit, now.toISOString());
  const knowledge = knowledgeNews(snapshot.knowledge, kept, fromMs, limit);
  const notes = commitNoteNews(snapshot.notes, kept, fromMs, limit);
  const incomingRefs = Object.fromEntries(
    localIncoming.flatMap((entry) => (entry.trackingRefOid ? [[entry.repo, entry.trackingRefOid] as const] : [])),
  );
  const incoming: NewsIncomingRepo[] = localIncoming.flatMap((entry) => {
    const groups = groupIncomingByAuthor(entry.commits);
    return groups.length > 0 ? [{ repo: entry.repo, host: entry.host, groups }] : [];
  });

  // Keep omitted files that still exist (or cannot be statted); only a confirmed deletion drops them.
  const present = new Set(snapshot.answers.map((answer) => answer.path));
  const candidates = new Set([...(record?.answers?.map((answer) => answer.path) ?? []), ...snapshot.documents.map((document) => document.name).filter((name) => /^explain\/[^/]+\.md$/i.test(name))]);
  const unavailable = new Set<string>();
  for (const candidate of candidates) {
    if (present.has(candidate) || !/^explain\/[^/]+\.md$/i.test(candidate)) continue;
    try { await fs.lstat(path.join(root, candidate)); unavailable.add(candidate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable.add(candidate); }
  }
  const nextRecord = recordOf(snapshot, now.toISOString(), incomingRefs, record, unavailable);
  if (options.mark) await saveRecord(root, name, nextRecord);
  else if (options.pending) {
    // Only remove repaired identities, under the lock and only if the reader has not changed since our snapshot.
    await updateSeenFile(root, (seen) => {
      const current = entryOf(seen.readers, name);
      if (current && record && JSON.stringify(current) === JSON.stringify(record)) {
        if (current.answers === undefined) {
          current.answers = nextRecord.answers?.filter((entry) => {
            const answer = snapshot.answers.find((item) => item.path === entry.path);
            return !answer || !afterTime(answer.modifiedAt, Date.parse(current.at));
          });
        }
        const observed = new Map(snapshot.answers.map((answer) => [answer.path, answer]));
        current.answers = current.answers?.map((entry) => {
          const answer = observed.get(entry.path);
          return answer ? { ...entry, broken: entry.broken.filter((id) => brokenCopies(answer, entry.broken).includes(id)) } : entry;
        });
      }
      seen.pending[name] = nextRecord;
      return name;
    });
  }
  const empty = [plan, documents, knowledge, notes, answers].every((section) => section.items.length === 0)
    && commits.every((repo) => repo.commits.length === 0)
    && incoming.length === 0;
  return { reader: name, at: now.toISOString(), from, basis, plan, documents, knowledge, notes, answers, commits, incoming, problems, empty };
}

/**
 * Records that `reader` has looked at the report made at `at` (the `at` of a report asked for with `pending`), with
 * what that report saw and nothing that came after.
 *
 * @throws {NewsChangedError} When no pending report was made at `at`: a newer one was made since, or it was marked
 *   already, or the reader has looked another way meanwhile. The reader should read the list again.
 */
export async function markSeen(workspacePath: string, reader: string, at: string | Date): Promise<void> {
  const root = await fs.realpath(workspacePath);
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) throw new Error('"at" is not a date and time.');
  await promotePending(root, newsReaderName(reader), when.getTime());
}

/**
 * The commits of the last few days, whatever a reader has seen: what the Board draws, so that marking the news as seen never takes
 * work off the board. It reads and records nothing. The shape is the news report's commits, newest first per repository.
 */
export async function recentCommits(workspacePath: string, options: { now?: Date; days?: number; limit?: number } = {}): Promise<{ at: string; from: string; commits: NewsRepo[] }> {
  const root = await fs.realpath(workspacePath);
  const now = options.now ?? new Date();
  const from = new Date(now.getTime() - (options.days ?? FIRST_LOOK_DAYS) * 24 * 60 * 60 * 1000).toISOString();
  const repos = await getWorkspaceRepoPaths(root).catch(() => []);
  const heads = await Promise.all(repos.map(repoHead));
  const commits = await Promise.all(heads.map((repo) => repoNews(repo, undefined, from, options.limit ?? RECENT_COMMITS_LIMIT, { detailed: true })));
  return { at: now.toISOString(), from, commits };
}
