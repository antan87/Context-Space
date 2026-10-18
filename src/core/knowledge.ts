/**
 * @module core/knowledge
 * Single engine for capturing workspace/base knowledge, shared by the CLI
 * `knowledge` command, the dashboard server, and the MCP `add_knowledge` /
 * `promote_knowledge` tools.
 *
 * All file I/O routes through the active storage adapter (`core/storage.ts`) so
 * the GUI, the CLI and the generators always read and write the same file. The
 * previous direct-`fs` knowledge routes bypassed it and could silently write
 * somewhere the generators never looked.
 *
 * The markdown helpers (`insertUnderHeading`, `formatEntry`,
 * `parseKnowledgeEntries`) are pure and section-aware: they insert under the
 * correct heading, tolerate leading YAML frontmatter (written by the removed
 * Obsidian adapter; such files still exist in user vaults) and CRLF, and
 * never destroy existing content.
 */

import * as path from 'node:path';

import { loadFeatureConfig } from './workspace.js';
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  workspaceFileExists,
  resolveWorkspaceFileUrl,
  readBaseFile,
  writeBaseFile,
  baseFileExists,
  resolveBaseFileUrl,
} from './storage.js';
import { buildBaseKnowledgeContent } from '../generators/index.js';
import { slugify } from '../utils/slug.js';
import { commitExactWorkspaceArtifacts } from './workspace-git.js';
import * as fs from 'node:fs/promises';
import { getActiveStorageProvider } from './adapters/registry.js';
import { acquireLock } from './locks.js';
import { runHoldingStoreLock } from './base-knowledge-store.js';
import { PRIMARY_KNOWLEDGE_FILE, LEGACY_KNOWLEDGE_FILE, BRAND_NAME, CLI_NAME, resolveWorkspaceConfigDir } from './constants.js';
import { refreshAgentsLessons } from './agents-lessons.js';
import { debugLog } from '../utils/debug.js';

async function getWorkspaceKnowledgeFilename(workspacePath: string, featureId: string): Promise<string> {
  if (await workspaceFileExists(workspacePath, featureId, PRIMARY_KNOWLEDGE_FILE)) {
    return PRIMARY_KNOWLEDGE_FILE;
  }
  if (await workspaceFileExists(workspacePath, featureId, LEGACY_KNOWLEDGE_FILE)) {
    return LEGACY_KNOWLEDGE_FILE;
  }
  return PRIMARY_KNOWLEDGE_FILE;
}

async function getBaseKnowledgeFilename(workspacePath: string, repoName: string): Promise<string> {
  if (await baseFileExists(workspacePath, repoName, PRIMARY_KNOWLEDGE_FILE)) {
    return PRIMARY_KNOWLEDGE_FILE;
  }
  if (await baseFileExists(workspacePath, repoName, LEGACY_KNOWLEDGE_FILE)) {
    return LEGACY_KNOWLEDGE_FILE;
  }
  return PRIMARY_KNOWLEDGE_FILE;
}

/** Categories of learning that can be captured. */
export type KnowledgeEntryType =
  | 'decision'
  | 'gotcha'
  | 'progress'
  | 'assumption'
  | 'question';

/** A learning to record. */
export interface KnowledgeEntry {
  type: KnowledgeEntryType;
  message: string;
  /** Short title, used for the heading of a `decision` entry. */
  title?: string;
  /** Optional applicability selector: repo:<name>, path:<repo/path>, or seam:<name>. */
  scope?: string;
  /** Optional short evidence pointer such as a commit SHA or repro document. */
  evidence?: string;
  /** ISO timestamp; defaults to now. */
  timestamp?: string;
}

/** Result of writing a knowledge entry. */
export interface KnowledgeWriteResult {
  /** Storage-resolved location (adapter URL) of the file written. */
  location: string;
  /** The heading the entry landed under. */
  section: string;
  /** True when the file did not exist and was created. */
  createdFile: boolean;
  /** True when an idempotent retry found the exact dated entry already present. */
  duplicate?: boolean;
  /** Git persistence result after the storage write succeeded. */
  commit: KnowledgeCommitResult;
}

export interface KnowledgeCommitResult {
  status: 'committed' | 'already-committed' | 'skipped' | 'failed';
  message?: string;
}

/** A parsed existing entry, used when promoting learnings. */
export interface ParsedKnowledgeEntry {
  /** The `## ` section heading the entry was found under. */
  section: string;
  /** The category, or `null` when the section is not a recognized knowledge section. */
  type: KnowledgeEntryType | null;
  /** The raw markdown of the entry (a bullet line or a `### ` decision block). */
  text: string;
}

/** Options for {@link promoteKnowledge}. */
export interface PromoteOptions {
  repoName: string;
  entries: ParsedKnowledgeEntry[];
  /** `copy` (default) keeps the workspace entry; `move` replaces it with a note. */
  mode?: 'copy' | 'move';
}

/** Result of {@link promoteKnowledge}. */
export interface PromoteResult {
  promotedCount: number;
  baseLocation: string;
  commitFailures?: string[];
}

/** Raised when base knowledge is addressed with a repo outside the workspace manifest. */
export class KnowledgeRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeRepositoryError';
  }
}

/**
 * Resolve a base-knowledge key from the manifest, never directly from caller
 * input. Storage adapters commonly map this value to a directory name, so an
 * unchecked slash, absolute path, or `..` would otherwise escape the base
 * knowledge root.
 */
async function requireConfiguredRepoName(workspacePath: string, repoName: string): Promise<string> {
  const candidate = repoName.trim();
  if (!candidate || candidate.includes('/') || candidate.includes('\\') || candidate === '.' || candidate === '..') {
    throw new KnowledgeRepositoryError(`Invalid repository name "${repoName}".`);
  }

  const feature = await loadFeatureConfig(workspacePath);
  if (!feature) {
    throw new KnowledgeRepositoryError(`Workspace configuration not found at ${workspacePath}.`);
  }

  const matches = feature.repos
    .map((repoPath) => path.basename(repoPath))
    .filter((name) => name === candidate);
  if (matches.length === 0) {
    throw new KnowledgeRepositoryError(`Repository "${candidate}" is not in this workspace.`);
  }
  if (matches.length > 1) {
    throw new KnowledgeRepositoryError(`Repository name "${candidate}" is ambiguous in this workspace.`);
  }
  return matches[0]!;
}

/**
 * Heading aliases per entry type for the workspace and base knowledge files.
 * The first alias is the canonical heading used when the section is missing.
 * `base: null` means the type is not promotable to base knowledge.
 */
const SECTION_ALIASES: Record<
  KnowledgeEntryType,
  { workspace: string[]; base: string[] | null }
> = {
  decision: {
    workspace: ['Architecture Decisions'],
    base: ['Architecture Decisions'],
  },
  gotcha: {
    workspace: ['Known Gotchas', 'Discovered Gotchas & Watch-outs', 'Discovered Gotchas'],
    base: ['Discovered Gotchas & Watch-outs', 'Known Gotchas', 'Discovered Gotchas'],
  },
  progress: {
    workspace: ['Implementation Progress'],
    base: null,
  },
  assumption: {
    workspace: ['Project Assumptions (verify with user)', 'Project Assumptions'],
    base: ['Coding Conventions & Invariants'],
  },
  question: {
    workspace: ['Clarifying Questions for the User', 'Clarifying Questions'],
    base: null,
  },
};

// ─── Pure markdown helpers ──────────────────────────────────────────────────

/** True for template placeholder lines that should be replaced by real content. */
function isPlaceholder(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^_\(.*\)_$/.test(t)) return true; // e.g. _(No gotchas recorded yet.)_
  if (/^-\s*None recorded yet\.?$/i.test(t)) return true;
  return false;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export const MAX_TITLE_CHARS = 60;
export const MAX_EVIDENCE_CHARS = 200;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * The title as it is written in the entry's heading: the words as given, on one line, with whitespace collapsed and
 * control characters removed, so "PLAN.md has its own lock" stays that and does not become a slug.
 *
 * @throws When there is no title, it runs over {@link MAX_TITLE_CHARS} (titles are rejected rather than truncated), it
 *   spans lines or starts with `#` (it would not read as one heading), or it has no letter or digit.
 */
export function knowledgeTitle(title: string): string {
  const raw = title ?? '';
  if (/[\r\n\u2028\u2029]/.test(raw.trim())) throw new Error('Knowledge entry title must be one line.');
  const normalized = raw.replace(CONTROL_CHARACTERS, '').replace(/\s+/g, ' ').trim();
  if (!normalized) throw new Error('Knowledge entry title is required.');
  if (normalized.startsWith('#')) throw new Error('Knowledge entry title cannot start with #.');
  if (normalized.length > MAX_TITLE_CHARS) {
    throw new Error(`Knowledge entry title is ${normalized.length} characters; the limit is ${MAX_TITLE_CHARS}. Titles are rejected rather than truncated.`);
  }
  if (!/[\p{L}\p{N}]/u.test(normalized)) throw new Error('Knowledge entry title must contain at least one letter or number.');
  return normalized;
}

/** The title as a slug, for what needs an identifier: a commit message, or telling two spellings of one title apart. */
export function knowledgeTitleSlug(title: string): string {
  return slugify(knowledgeTitle(title)) || 'entry';
}

function normaliseScope(scope?: string): string | undefined {
  if (!scope) return undefined;
  const normalized = scope.replace(/\s+/g, ' ').trim();
  if (!/^(repo|path|seam):[^\s].*$/i.test(normalized)) {
    throw new Error('Knowledge scope must use repo:<name>, path:<repo/path>, or seam:<name>.');
  }
  if (normalized.includes('..') || path.isAbsolute(normalized.slice(normalized.indexOf(':') + 1))) {
    throw new Error('Knowledge scope cannot contain parent traversal or an absolute path.');
  }
  return normalized;
}

function normaliseEvidence(evidence?: string): string | undefined {
  if (!evidence) return undefined;
  const normalized = evidence.replace(/\s+/g, ' ').trim();
  if (normalized.length > MAX_EVIDENCE_CHARS) {
    throw new Error(`Knowledge evidence is ${normalized.length} characters; the limit is ${MAX_EVIDENCE_CHARS}.`);
  }
  return normalized || undefined;
}

/**
 * Formats a {@link KnowledgeEntry} as the markdown snippet to insert.
 *
 * @param entry  - The entry to format.
 * @param _target - Reserved for target-specific formatting (currently identical).
 */
export function formatEntry(entry: KnowledgeEntry, _target: 'workspace' | 'base'): string {
  const date = (entry.timestamp ?? new Date().toISOString()).slice(0, 10);
  const msg = entry.message.trim();
  const title = knowledgeTitle(entry.title ?? '');
  const label = entry.type[0].toUpperCase() + entry.type.slice(1);
  const metadata: string[] = [];
  if (entry.scope) metadata.push(`**Scope:** \`${entry.scope}\``);
  if (entry.evidence) metadata.push(`**Evidence:** ${entry.evidence}`);
  return [`### ${date} — ${title}`, `**${label}:** ${msg}`, ...metadata].join('\n');
}

/**
 * Inserts `entryMarkdown` under the first `## ` heading matching any of
 * `headingAliases` (case-insensitive), stripping placeholder lines. When no
 * matching heading exists, a new section is appended at end-of-file using the
 * first alias. Existing content is never removed. CRLF line endings and a
 * leading YAML frontmatter block are preserved.
 *
 * @returns The updated markdown.
 */
export function insertUnderHeading(
  markdown: string,
  headingAliases: string[],
  entryMarkdown: string,
): string {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const aliasSet = new Set(headingAliases.map((a) => a.trim().toLowerCase()));

  // Find the target section heading.
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.*)$/);
    if (m && aliasSet.has(m[1].trim().toLowerCase())) {
      headingIdx = i;
      break;
    }
  }

  const entryLines = entryMarkdown.split(/\r?\n/);

  if (headingIdx === -1) {
    // Append a fresh section at end-of-file.
    const trimmed = lines.join(eol).replace(/\s+$/, '');
    const prefix = trimmed.length > 0 ? `${trimmed}${eol}${eol}` : '';
    return `${prefix}## ${headingAliases[0]}${eol}${eol}${entryLines.join(eol)}${eol}`;
  }

  // Determine the section body range: until the next h1/h2 or EOF.
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const before = lines.slice(0, headingIdx + 1);
  const after = lines.slice(sectionEnd);

  // Keep comments and real content; drop placeholders and trailing blanks.
  const body = lines.slice(headingIdx + 1, sectionEnd).filter((l) => !isPlaceholder(l));
  while (body.length > 0 && body[body.length - 1].trim() === '') {
    body.pop();
  }

  // One blank line between the heading (or existing content) and the new entry.
  const newSection = [...before, ...body, '', ...entryLines, ''];

  // Preserve a single blank line before the next section, if any.
  const tail = after.length > 0 ? [...after] : [];
  return [...newSection, ...tail].join(eol);
}

/** Reverse lookup: which entry type owns a given `## ` heading, if any. */
function sectionType(heading: string): KnowledgeEntryType | null {
  const h = heading.trim().toLowerCase();
  for (const [type, aliases] of Object.entries(SECTION_ALIASES) as [
    KnowledgeEntryType,
    { workspace: string[]; base: string[] | null },
  ][]) {
    const all = [...aliases.workspace, ...(aliases.base ?? [])];
    if (all.some((a) => a.toLowerCase() === h)) {
      return type;
    }
  }
  return null;
}

/**
 * Parses a knowledge markdown document into individual entries: bullet lines
 * and `### ` decision blocks, each tagged with its section and inferred type.
 * Placeholder and comment lines are ignored.
 */
export function parseKnowledgeEntries(markdown: string): ParsedKnowledgeEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: ParsedKnowledgeEntry[] = [];

  let currentSection = '';
  let currentType: KnowledgeEntryType | null = null;
  let decisionBuffer: string[] | null = null;

  const flushDecision = () => {
    if (decisionBuffer) {
      const text = decisionBuffer.join('\n').trim();
      if (text) entries.push({ section: currentSection, type: currentType, text });
      decisionBuffer = null;
    }
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      flushDecision();
      currentSection = h2[1].trim();
      currentType = sectionType(currentSection);
      continue;
    }
    if (/^#\s+/.test(line)) {
      flushDecision();
      currentSection = '';
      currentType = null;
      continue;
    }

    if (line.startsWith('### ')) {
      flushDecision();
      decisionBuffer = [line];
      continue;
    }
    if (decisionBuffer) {
      decisionBuffer.push(line);
      continue;
    }

    const t = line.trim();
    if (t.startsWith('- ') && !isPlaceholder(line)) {
      entries.push({ section: currentSection, type: currentType, text: t });
    }
  }
  flushDecision();

  return entries;
}

/** The parts of one entry a person reads: its title in words, its date, and the text under the heading. */
export interface KnowledgeEntryParts {
  title: string;
  date: string | null;
  body: string;
}

/** `### <date> — <title>`; the date is optional so a heading written by hand still has a title. */
const ENTRY_HEADING = /^###\s+(?:(\d{4}-\d{2}-\d{2})\s+[—–-]\s+)?(.+?)\s*$/;

/** What `slugify` makes of a title: lower case letters and digits joined by hyphens. */
const SLUG = /^[a-z0-9]+(?:[-_]+[a-z0-9]+)*$/;

/**
 * A title in words. One written as a slug ("plan-md-has-its-own-lock", as older versions stored every title) becomes
 * words ("Plan md has its own lock"); anything else was written as words and is kept exactly as it is, capitals, dots
 * and hyphens included.
 */
export function knowledgeTitleWords(title: string): string {
  const trimmed = title.trim();
  if (!SLUG.test(trimmed)) return trimmed;
  const words = trimmed.replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The id a contract names an entry by: its date and its title as a slug, such as 2026-08-25-bff-error-encoding. It is
 * the same whether the heading is written in words or as the slug, and null for text that is not a dated entry heading.
 */
export function knowledgeEntryId(entryText: string): string | null {
  const heading = (entryText.split(/\r?\n/, 1)[0] ?? '').match(ENTRY_HEADING);
  return heading?.[1] ? `${heading[1]}-${slugify(heading[2]!)}` : null;
}

/** Whether a knowledge file has the entry with this id (see {@link knowledgeEntryId}). */
export function hasKnowledgeEntry(markdown: string, id: string): boolean {
  return markdown.split(/\r?\n/).some((line) => knowledgeEntryId(line) === id);
}

/**
 * Splits a parsed entry into title, date and body. A bullet has no heading, so the section it sits under stands in for
 * its title.
 */
export function describeKnowledgeEntry(entry: ParsedKnowledgeEntry): KnowledgeEntryParts {
  const [first = '', ...rest] = entry.text.split(/\r?\n/);
  const heading = first.match(ENTRY_HEADING);
  if (!heading) return { title: entry.section || 'Note', date: null, body: entry.text.replace(/^-\s+/, '').trim() };
  return { title: knowledgeTitleWords(heading[2]!), date: heading[1] ?? null, body: rest.join('\n').trim() };
}

/** One entry as AGENTS.md lists it: enough to know it exists. Its text is one search away. */
export interface KnowledgeLesson {
  title: string;
  type: KnowledgeEntryType;
  /** The repo whose base knowledge holds the entry; none for the workspace's own. */
  repo?: string;
}

interface DatedLesson {
  lesson: KnowledgeLesson;
  date: string;
  index: number;
}

/** The titled entries of a knowledge file. Bullets, progress notes and entries outside the known sections have no title or are not lessons. */
function datedLessons(markdown: string, repo?: string): DatedLesson[] {
  return parseKnowledgeEntries(markdown)
    .filter((entry) => entry.type !== null && entry.type !== 'progress' && /^###\s/.test(entry.text))
    .map((entry, index) => {
      const { title, date } = describeKnowledgeEntry(entry);
      return { lesson: { title, type: entry.type!, ...(repo ? { repo } : {}) }, date: date ?? '', index };
    });
}

/** Newest first by the date in the heading; of the same day, the one further down the file. */
function newestFirst(entries: DatedLesson[]): KnowledgeLesson[] {
  return [...entries].sort((a, b) => b.date.localeCompare(a.date) || b.index - a.index).map(({ lesson }) => lesson);
}

/** The titled entries of a knowledge file, newest first, each labelled with `repo` when given. */
export function listKnowledgeLessons(markdown: string, repo?: string): KnowledgeLesson[] {
  return newestFirst(datedLessons(markdown, repo));
}

// ─── Adapter-routed I/O ─────────────────────────────────────────────────────

async function resolveFeatureId(workspacePath: string): Promise<string> {
  const feature = await loadFeatureConfig(workspacePath);
  return feature?.id ?? path.basename(workspacePath);
}

/**
 * Longest a single entry may be.
 *
 * The knowledge file is read by an assistant and only grows. One workspace
 * reached 44 KB — about 11,000 tokens, twenty times its own auto-loaded context
 * — across 21 entries averaging 1,200 characters, because each was written as a
 * write-up rather than a rule. 300 characters fits a rule plus the reason it
 * exists; anything longer belongs in a document the entry links to.
 */
export const MAX_ENTRY_CHARS = 300;

/**
 * Validates an entry message and returns the exact string to store.
 *
 * Enforced here rather than in the CLI because every path that writes a *new*
 * entry converges on `addWorkspaceKnowledge`/`addBaseKnowledge`: the CLI, the MCP
 * `add_knowledge` and `promote_knowledge` tools, and the HTTP endpoint. A cap in
 * the command handler bound none of the others — including the MCP tools, which
 * are how an assistant records knowledge and so the callers that produced the
 * 44 KB. `promoteKnowledge` is the one exception, and deliberately so: it copies
 * markdown already on disk, which was capped when it was written.
 *
 * Returns the normalised message so the string that was measured is the string
 * that gets written; validating the trimmed form and storing the raw one let
 * surrounding whitespace and embedded newlines past the limit and broke the
 * one-entry-per-line shape the file's own header promises.
 */
function normaliseMessage(message: string): string {
  const normalised = (message ?? '').replace(/\s+/g, ' ').trim();

  if (!normalised) {
    throw new Error('Knowledge entry message cannot be empty.');
  }
  if (normalised.length > MAX_ENTRY_CHARS) {
    throw new Error(
      `Knowledge entry is ${normalised.length} characters; the limit is ${MAX_ENTRY_CHARS}. ` +
      'An entry has to be a rule, not a write-up: state what to do and why in one or two ' +
      'sentences, split separate findings into separate entries, and put long material in ' +
      'a document the entry points to.',
    );
  }

  return normalised;
}

function validateNewEntry(entry: KnowledgeEntry): KnowledgeEntry {
  if (entry.type === 'progress') {
    throw new Error(`Progress is derived from live git state and cannot be authored as knowledge. Use \`${CLI_NAME} progress\`.`);
  }
  return {
    ...entry,
    message: normaliseMessage(entry.message),
    title: knowledgeTitle(entry.title ?? ''),
    scope: normaliseScope(entry.scope),
    evidence: normaliseEvidence(entry.evidence),
  };
}

/**
 * Whether an entry is already in a knowledge file. The same text is a duplicate. An entry with the same date and title
 * but other text is a conflict. "Same title" ignores how it is spelled, in words or as the slug older versions wrote,
 * so a retry made across an upgrade is still the same entry. Anything that is not a titled entry is compared as text.
 */
function entryState(content: string, entryMarkdown: string): 'new' | 'duplicate' | 'conflict' {
  if (content.includes(entryMarkdown)) return 'duplicate';
  const [heading = '', ...body] = entryMarkdown.split(/\r?\n/);
  const id = knowledgeEntryId(heading);
  if (!id) return 'new';
  const wanted = body.join('\n').trim();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (knowledgeEntryId(lines[i]!) !== id) continue;
    const end = lines.findIndex((line, index) => index > i && /^#{1,3}\s/.test(line));
    const existing = lines.slice(i + 1, end < 0 ? lines.length : end).join('\n').trim();
    return existing === wanted ? 'duplicate' : 'conflict';
  }
  return 'new';
}

function assertNoConflict(state: 'new' | 'duplicate' | 'conflict', entryMarkdown: string): void {
  if (state === 'conflict') {
    const heading = entryMarkdown.split(/\r?\n/, 1)[0] ?? '';
    throw new Error(`Knowledge heading "${heading.slice(4)}" already exists with different content. Choose a distinct title.`);
  }
}

async function commitKnowledgeArtifact(
  workspacePath: string,
  message: string,
  relativePath: string,
): Promise<KnowledgeCommitResult> {
  // A non-local adapter owns its own durability. Do not turn a successful
  // adapter write into an error by trying to commit a different local path.
  if (getActiveStorageProvider().meta.name !== 'local') {
    return { status: 'skipped', message: 'Active storage adapter is not local; Git auto-commit was skipped.' };
  }
  try {
    await fs.access(path.join(workspacePath, '.git'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'skipped', message: 'Workspace artifact repository is not initialized.' };
    }
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  try {
    const result = await commitExactWorkspaceArtifacts(workspacePath, message, [relativePath]);
    return { status: result.committed ? 'committed' : 'already-committed' };
  } catch (error) {
    // The knowledge write is already durable. Returning its precise partial
    // state prevents callers from retrying and appending a duplicate entry.
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

async function withKnowledgeLock<T>(workspacePath: string, operation: () => Promise<T>): Promise<T> {
  const configDir = resolveWorkspaceConfigDir(workspacePath).path;
  const release = await acquireLock(path.join(configDir, 'knowledge.lock'), {
    staleMs: 60_000,
    timeoutMs: 30_000,
    timeoutMessage: `Another ${BRAND_NAME} operation is updating workspace knowledge.`,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

/** Reads the workspace knowledge file, or `null` when it does not exist. */
export async function readWorkspaceKnowledge(workspacePath: string): Promise<string | null> {
  const featureId = await resolveFeatureId(workspacePath);
  const filename = await getWorkspaceKnowledgeFilename(workspacePath, featureId);
  if (!(await workspaceFileExists(workspacePath, featureId, filename))) {
    return null;
  }
  return readWorkspaceFile(workspacePath, featureId, filename);
}

/** Reads a repo's base knowledge file, or `null` when it does not exist. */
export async function readBaseKnowledge(
  workspacePath: string,
  repoName: string,
): Promise<string | null> {
  const configuredRepo = await requireConfiguredRepoName(workspacePath, repoName);
  const filename = await getBaseKnowledgeFilename(workspacePath, configuredRepo);
  if (!(await baseFileExists(workspacePath, configuredRepo, filename))) {
    return null;
  }
  return readBaseFile(workspacePath, configuredRepo, filename);
}

/**
 * The titled entries of the base knowledge of every repo in the workspace, newest first across the repos. A repo whose
 * base knowledge cannot be read is left out: that must not stop a workspace from being generated.
 */
async function readRepoLessons(workspacePath: string): Promise<KnowledgeLesson[]> {
  const feature = await loadFeatureConfig(workspacePath).catch(() => null);
  const entries: DatedLesson[] = [];
  for (const repo of new Set((feature?.repos ?? []).map((repoPath) => path.basename(repoPath)))) {
    const markdown = await readBaseKnowledge(workspacePath, repo).catch(() => null);
    // One running index across the repos, so of the same day the repo further down the list comes first.
    if (markdown) entries.push(...datedLessons(markdown, repo).map((entry) => ({ ...entry, index: entries.length + entry.index })));
  }
  return newestFirst(entries);
}

/**
 * The entries AGENTS.md lists, so a new session starts knowing them: the workspace's own, newest first, then those in
 * the base knowledge of its repos, newest first, labelled with the repo. That is where finishing a workspace promotes
 * what it learned, and so how a lesson reaches the next workspace on the repo. An entry promoted by copy stays in both
 * files and is listed once, as the workspace's own. None when there is no knowledge.
 */
export async function readKnowledgeLessons(workspacePath: string): Promise<KnowledgeLesson[]> {
  const own = listKnowledgeLessons((await readWorkspaceKnowledge(workspacePath)) ?? '');
  const key = (lesson: KnowledgeLesson) => `${lesson.type}:${lesson.title}`;
  const listed = new Set(own.map(key));
  return [...own, ...(await readRepoLessons(workspacePath)).filter((lesson) => !listed.has(key(lesson)))];
}

/**
 * Brings the lessons listed in AGENTS.md up to date after workspace knowledge changed, so a new session sees them
 * without waiting for a refresh. It never fails the write that caused it: a refresh puts the list right later.
 */
async function refreshLessonsQuietly(workspacePath: string): Promise<void> {
  try {
    await refreshAgentsLessons(workspacePath, () => readKnowledgeLessons(workspacePath));
  } catch (error) {
    debugLog('knowledge', 'Could not update the lessons in AGENTS.md; the next refresh will.', error);
  }
}

/** Appends a formatted entry to the workspace knowledge file (creating it if missing). */
export async function addWorkspaceKnowledge(
  workspacePath: string,
  entry: KnowledgeEntry,
): Promise<KnowledgeWriteResult> {
  const result = await withKnowledgeLock(workspacePath, () => addWorkspaceKnowledgeUnlocked(workspacePath, entry));
  // Outside the knowledge lock: the list waits for a refresh in progress, and other entries need not wait with it.
  if (!result.duplicate) await refreshLessonsQuietly(workspacePath);
  return result;
}

async function addWorkspaceKnowledgeUnlocked(
  workspacePath: string,
  entry: KnowledgeEntry,
): Promise<KnowledgeWriteResult> {
  const checked = validateNewEntry(entry);
  const featureId = await resolveFeatureId(workspacePath);
  const filename = await getWorkspaceKnowledgeFilename(workspacePath, featureId);
  const exists = await workspaceFileExists(workspacePath, featureId, filename);
  const content = exists
    ? await readWorkspaceFile(workspacePath, featureId, filename)
    : `# Workspace Knowledge — ${featureId}\n`;

  const aliases = SECTION_ALIASES[checked.type].workspace;
  const entryMarkdown = formatEntry(checked, 'workspace');
  const state = entryState(content, entryMarkdown);
  assertNoConflict(state, entryMarkdown);
  const duplicate = state === 'duplicate';
  if (!duplicate) {
    const updated = insertUnderHeading(content, aliases, entryMarkdown);
    await writeWorkspaceFile(workspacePath, featureId, filename, updated);
  }
  const commit = await commitKnowledgeArtifact(
    workspacePath,
    `docs(knowledge): remember ${knowledgeTitleSlug(checked.title ?? '')}`,
    filename,
  );

  return {
    location: resolveWorkspaceFileUrl(workspacePath, featureId, filename),
    section: aliases[0],
    createdFile: !exists,
    duplicate,
    commit,
  };
}

/**
 * Inserts already-formatted markdown under a repo's base knowledge section for
 * the given type (creating the file if missing).
 */
async function insertIntoBase(
  workspacePath: string,
  repoName: string,
  type: KnowledgeEntryType,
  entryMarkdown: string,
): Promise<KnowledgeWriteResult> {
  const aliases = SECTION_ALIASES[type].base;
  if (!aliases) {
    throw new Error(`'${type}' entries cannot be stored in base (repo) knowledge.`);
  }
  // Resolving the filename also merges older per-workspace copies into the store.
  const filename = await getBaseKnowledgeFilename(workspacePath, repoName);
  return withBaseStoreLock(workspacePath, repoName, filename, () =>
    insertIntoBaseUnlocked(workspacePath, repoName, filename, aliases, entryMarkdown));
}

/**
 * Base knowledge is shared by every workspace that includes the repository,
 * so the workspace knowledge lock is not enough: serialize the read-modify-
 * write on the store file itself. Plugin adapters own their own concurrency.
 */
async function withBaseStoreLock<T>(workspacePath: string, repoName: string, filename: string, operation: () => Promise<T>): Promise<T> {
  const location = resolveBaseFileUrl(workspacePath, repoName, filename);
  if (getActiveStorageProvider().meta.name !== 'local' || !path.isAbsolute(location)) return operation();
  await fs.mkdir(path.dirname(location), { recursive: true });
  const release = await acquireLock(`${location}.lock`, {
    staleMs: 60_000,
    timeoutMs: 30_000,
    timeoutMessage: `Another ${BRAND_NAME} operation is updating the base knowledge of ${repoName}.`,
  });
  try {
    return await runHoldingStoreLock(location, operation);
  } finally {
    await release();
  }
}

async function insertIntoBaseUnlocked(
  workspacePath: string,
  repoName: string,
  filename: string,
  aliases: string[],
  entryMarkdown: string,
): Promise<KnowledgeWriteResult> {
  const exists = await baseFileExists(workspacePath, repoName, filename);
  const content = exists
    ? await readBaseFile(workspacePath, repoName, filename)
    : buildBaseKnowledgeContent(repoName);

  const state = entryState(content, entryMarkdown);
  assertNoConflict(state, entryMarkdown);
  const duplicate = state === 'duplicate';
  if (!duplicate) {
    const updated = insertUnderHeading(content, aliases, entryMarkdown);
    await writeBaseFile(workspacePath, repoName, filename, updated);
  }
  const location = resolveBaseFileUrl(workspacePath, repoName, filename);
  const relative = path.relative(workspacePath, location);
  const commit = relative.startsWith('..') || path.isAbsolute(relative)
    ? { status: 'skipped' as const, message: 'Base knowledge is kept in the user-level store, outside the workspace artifact repository.' }
    : await commitKnowledgeArtifact(workspacePath, `docs(knowledge): remember ${repoName} learning`, relative.split(path.sep).join('/'));

  return {
    location,
    section: aliases[0],
    createdFile: !exists,
    duplicate,
    commit,
  };
}

/** Appends a formatted entry to a repo's base knowledge file (creating it if missing). */
export async function addBaseKnowledge(
  workspacePath: string,
  repoName: string,
  entry: KnowledgeEntry,
): Promise<KnowledgeWriteResult> {
  const configuredRepo = await requireConfiguredRepoName(workspacePath, repoName);
  const result = await withKnowledgeLock(workspacePath, async () => {
    const checked = validateNewEntry(entry);
    return insertIntoBase(workspacePath, configuredRepo, checked.type, formatEntry(checked, 'base'));
  });
  // The repo's lessons are listed in AGENTS.md too.
  if (!result.duplicate) await refreshLessonsQuietly(workspacePath);
  return result;
}

/**
 * Promotes selected workspace learnings into a repo's persistent base
 * knowledge so they survive across features. Entries whose type is not
 * promotable (progress, question) are skipped. In `move` mode the source entry
 * in the workspace file is replaced with an auditable "promoted" note.
 */
export async function promoteKnowledge(
  workspacePath: string,
  options: PromoteOptions,
): Promise<PromoteResult> {
  const repoName = await requireConfiguredRepoName(workspacePath, options.repoName);
  const result = await withKnowledgeLock(workspacePath, () => promoteKnowledgeUnlocked(
    workspacePath,
    { ...options, repoName },
  ));
  // The entries are now in the repo's base knowledge, and moving takes them out of the workspace file.
  if (result.promotedCount > 0) await refreshLessonsQuietly(workspacePath);
  return result;
}

async function promoteKnowledgeUnlocked(
  workspacePath: string,
  options: PromoteOptions,
): Promise<PromoteResult> {
  const { repoName, entries, mode = 'copy' } = options;
  const promotable = entries.filter((e) => e.type && SECTION_ALIASES[e.type].base);

  const baseFilename = await getBaseKnowledgeFilename(workspacePath, repoName);
  let baseLocation = resolveBaseFileUrl(workspacePath, repoName, baseFilename);
  const commitFailures: string[] = [];
  for (const e of promotable) {
    // Preserve the entry's original markdown rather than reformatting it: `text`
    // is a whole bullet line or `### ` block, so running it back through
    // `formatEntry` would nest one entry inside another. Its length is not
    // re-checked either — it was capped when it was written, and re-validating
    // here would make promotion fail for entries that predate the limit, which
    // is a worse outcome than a long line in base knowledge. Callers handing in
    // free text rather than a parsed entry must cap it themselves.
    const res = await insertIntoBase(workspacePath, repoName, e.type!, e.text);
    baseLocation = res.location;
    if (res.commit.status === 'failed') {
      commitFailures.push(res.commit.message ?? 'Base knowledge commit failed.');
    }
  }

  if (mode === 'move' && promotable.length > 0) {
    const featureId = await resolveFeatureId(workspacePath);
    const wsFilename = await getWorkspaceKnowledgeFilename(workspacePath, featureId);
    if (await workspaceFileExists(workspacePath, featureId, wsFilename)) {
      let content = await readWorkspaceFile(workspacePath, featureId, wsFilename);
      const date = todayIso();
      for (const e of promotable) {
        content = content.replace(
          e.text,
          `- Promoted to ${repoName} base knowledge on ${date}.`,
        );
      }
      await writeWorkspaceFile(workspacePath, featureId, wsFilename, content);
      const commit = await commitKnowledgeArtifact(
        workspacePath,
        `docs(knowledge): promote to ${repoName}`,
        wsFilename,
      );
      if (commit.status === 'failed') {
        commitFailures.push(commit.message ?? 'Workspace knowledge commit failed.');
      }
    }
  }

  return {
    promotedCount: promotable.length,
    baseLocation,
    ...(commitFailures.length ? { commitFailures } : {}),
  };
}

export interface KnowledgeSearchResult {
  source: 'workspace' | 'base';
  repo?: string;
  section: string;
  type: KnowledgeEntryType | null;
  text: string;
  score: number;
}

export interface SearchKnowledgeOptions {
  scope?: string;
  type?: KnowledgeEntryType;
  repo?: string;
  limit?: number;
}

/**
 * Searches workspace knowledge and repository base knowledge for relevant entries.
 * Returns concise matching entry snippets sorted by relevance.
 */
export async function searchKnowledge(
  workspacePath: string,
  query: string,
  options: SearchKnowledgeOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const results: KnowledgeSearchResult[] = [];
  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  const queryTerms = (query || '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  // 1. Search workspace knowledge
  const wsContent = await readWorkspaceKnowledge(workspacePath);
  if (wsContent) {
    const entries = parseKnowledgeEntries(wsContent);
    for (const entry of entries) {
      if (options.type && entry.type !== options.type) continue;
      if (options.scope) {
        const needle = `**scope:** \`${options.scope.toLowerCase()}\``;
        if (!entry.text.toLowerCase().includes(needle)) continue;
      }
      const textLower = entry.text.toLowerCase();
      let score = 0;
      if (queryTerms.length > 0) {
        for (const term of queryTerms) {
          if (textLower.includes(term)) score += 1;
        }
        if (score === 0) continue;
      } else {
        score = 1;
      }
      results.push({
        source: 'workspace',
        section: entry.section,
        type: entry.type,
        text: entry.text,
        score,
      });
    }
  }

  // 2. Search base knowledge for configured repos
  const feature = await loadFeatureConfig(workspacePath);
  if (feature?.repos) {
    const targetRepos = options.repo
      ? [options.repo]
      : feature.repos.map((r) => path.basename(r));

    for (const repoName of targetRepos) {
      const baseContent = await readBaseKnowledge(workspacePath, repoName).catch(() => null);
      if (baseContent) {
        const entries = parseKnowledgeEntries(baseContent);
        for (const entry of entries) {
          if (options.type && entry.type !== options.type) continue;
          if (options.scope) {
            const needle = `**scope:** \`${options.scope.toLowerCase()}\``;
            if (!entry.text.toLowerCase().includes(needle)) continue;
          }
          const textLower = entry.text.toLowerCase();
          let score = 0;
          if (queryTerms.length > 0) {
            for (const term of queryTerms) {
              if (textLower.includes(term)) score += 1;
            }
            if (score === 0) continue;
          } else {
            score = 1;
          }
          results.push({
            source: 'base',
            repo: repoName,
            section: entry.section,
            type: entry.type,
            text: entry.text,
            score,
          });
        }
      }
    }
  }

  // Sort by score descending; prioritize workspace entries when scores tie
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.source === 'workspace' && b.source !== 'workspace') return -1;
    if (b.source === 'workspace' && a.source !== 'workspace') return 1;
    return 0;
  });

  return results.slice(0, limit);
}
