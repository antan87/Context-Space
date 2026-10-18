/**
 * @module commands/knowledge
 * `nexusflow knowledge` — capture and manage workspace learnings so they
 * actually accumulate instead of leaving the knowledge files empty.
 */

import chalk from 'chalk';
import { checkbox, select } from '@inquirer/prompts';

import { getWorkspaceRepos } from '../utils/multi-git.js';
import { resolveWorkspaceInteractive, resolveWorkspaceQuiet } from '../utils/resolve-workspace.js';
import { loadFeatureConfig } from '../core/workspace.js';
import {
  addWorkspaceKnowledge,
  addBaseKnowledge,
  readWorkspaceKnowledge,
  readBaseKnowledge,
  parseKnowledgeEntries,
  promoteKnowledge,
  searchKnowledge,
  describeKnowledgeEntry,
  knowledgeEntryId,
  MAX_ENTRY_CHARS,
  type KnowledgeEntryType,
  type KnowledgeSearchResult,
  type ParsedKnowledgeEntry,
} from '../core/knowledge.js';
import { BRAND_NAME } from '../core/constants.js';

const VALID_TYPES: KnowledgeEntryType[] = ['decision', 'gotcha', 'assumption', 'question'];
/** Types that exist in the per-repo base knowledge file. */
const PROMOTABLE_TYPES: KnowledgeEntryType[] = ['decision', 'gotcha', 'assumption'];

interface AddOptions {
  type: string;
  message: string;
  title?: string;
  scope?: string;
  evidence?: string;
  repo?: string;
}

export interface KnowledgeSearchOptions {
  type?: string;
  scope?: string;
  repo?: string;
  limit?: string;
  workspace?: string;
  json?: boolean;
}

interface ShowOptions {
  section?: string;
  repo?: string;
  scope?: string;
}

interface PromoteOptions {
  repo?: string;
  type?: string;
  message?: string;
  title?: string;
  move?: boolean;
  all?: boolean;
}

export function contractMatchesScope(
  contract: { from: string; to: string; kind: string },
  scope: string,
): boolean {
  const separator = scope.indexOf(':');
  if (separator < 1) return false;
  const scopeKind = scope.slice(0, separator).toLowerCase();
  const requested = scope.slice(separator + 1).toLowerCase();
  const from = contract.from.toLowerCase();
  const to = contract.to.toLowerCase();
  if (scopeKind === 'seam' && contract.kind.toLowerCase() === requested) return true;
  return from === requested || to === requested ||
    from.startsWith(`${requested}/`) || to.startsWith(`${requested}/`) ||
    requested.startsWith(`${from}/`) || requested.startsWith(`${to}/`);
}

function reportKnowledgeDurability(result: { duplicate?: boolean; commit?: { status: string; message?: string } }): void {
  if (result.duplicate) console.log(chalk.dim('  Existing identical entry reused; no duplicate was appended.'));
  if (result.commit?.status === 'failed') {
    console.warn(chalk.yellow(`  ⚠ Entry was recorded but Git auto-commit failed: ${result.commit.message ?? 'unknown error'}`));
  } else if (result.commit?.status === 'skipped' && result.commit.message) {
    console.log(chalk.dim(`  ${result.commit.message}`));
  }
}

function invalidType(type: string): string {
  return `Invalid --type "${type}". Use one of: ${VALID_TYPES.join(', ')}`;
}

/** Validates a `--type` value, returning it typed or `null` (after printing an error). */
function parseType(type: string): KnowledgeEntryType | null {
  if (!VALID_TYPES.includes(type as KnowledgeEntryType)) {
    console.error(chalk.red(`✖ ${invalidType(type)}`));
    return null;
  }
  return type as KnowledgeEntryType;
}

/**
 * Rejects an over-long entry, explaining how to shorten it.
 *
 * The rule itself lives in `core/knowledge.ts` so every write path shares it;
 * this only front-runs it to fail before the workspace prompt and to print the
 * advice across several dim lines instead of one long error.
 *
 * @returns True when the message is within {@link MAX_ENTRY_CHARS}.
 */
export function checkEntryLength(message: string): boolean {
  const length = (message ?? '').replace(/\s+/g, ' ').trim().length;
  if (length <= MAX_ENTRY_CHARS) return true;

  console.error(
    chalk.red(`✖ Entry is ${length} characters; the limit is ${MAX_ENTRY_CHARS}.`),
  );
  console.log(chalk.dim('  This file is read by an assistant and only grows, so an entry has to be a'));
  console.log(chalk.dim('  rule, not a write-up. State what to do and why in one or two sentences.'));
  console.log(chalk.dim('  Prefer facts that cannot be recovered from code or git history: environment quirks,'));
  console.log(chalk.dim('  contradictions in a spec, decisions and reasons, things that cost you time to discover.'));
  console.log(chalk.dim('  Avoid restating structure the code already shows.'));
  console.log(chalk.dim('  Split genuinely separate findings into separate entries, and put long'));
  console.log(chalk.dim('  material in a document the entry points to.'));
  return false;
}

/** Most entries one search prints; the core search stops at the same number. */
const MAX_SEARCH_LIMIT = 20;

/** Validates a `--limit` value. @throws When it is not a whole number from 1 to {@link MAX_SEARCH_LIMIT}. */
function parseLimit(limit: string): number {
  const count = /^\d+$/.test(limit.trim()) ? Number(limit) : NaN;
  if (!Number.isInteger(count) || count < 1 || count > MAX_SEARCH_LIMIT) {
    throw new Error(`Invalid --limit "${limit}". Use a whole number from 1 to ${MAX_SEARCH_LIMIT}.`);
  }
  return count;
}

/** One search result as a person or an AI reads it: the title, what it is and when, then the whole entry. */
function describeResult(result: KnowledgeSearchResult) {
  const { title, date, body } = describeKnowledgeEntry(result);
  return { title, type: result.type, date, source: result.source, ...(result.repo ? { repo: result.repo } : {}), section: result.section, body, score: result.score };
}

function renderResult(result: KnowledgeSearchResult): string {
  const { title, type, date, repo, body } = describeResult(result);
  const facts = [type ?? 'note', date, repo ? `${repo} base knowledge` : null].filter(Boolean).join(' · ');
  return [chalk.bold(title), chalk.dim(facts), body].filter(Boolean).join('\n');
}

/** Collapses an entry's markdown to a single line for list display. */
function oneLine(text: string, max = 72): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max).trimEnd()}…`;
}

/** Extracts a single `## ` section's text from a markdown document. */
function sliceSection(content: string, name: string): string | null {
  const lines = content.split(/\r?\n/);
  const target = name.trim().toLowerCase();
  const start = lines.findIndex((l) => {
    const m = l.match(/^##\s+(.*)$/);
    return m ? m[1].trim().toLowerCase().includes(target) : false;
  });
  if (start === -1) return null;

  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

/**
 * `knowledge add` — append a timestamped learning to the workspace knowledge
 * file, or (with `--repo`) to a repo's persistent base knowledge.
 */
export async function knowledgeAddCommand(workspaceArg: string | undefined, options: AddOptions): Promise<void> {
  console.log(chalk.bold.cyan(`\n🧠 ${BRAND_NAME} — Add Knowledge\n`));

  const type = parseType(options.type);
  if (!type) return;

  if (!options.message || !options.message.trim()) {
    console.error(chalk.red('✖ A message is required (-m "...").'));
    return;
  }
  if (!options.title || !options.title.trim()) {
    console.error(chalk.red('✖ A short title is required (--title "...").'));
    return;
  }

  // Checked before the workspace prompt, so an over-long entry fails immediately
  // rather than after picking a workspace.
  if (!checkEntryLength(options.message)) return;

  const workspacePath = await resolveWorkspaceInteractive(workspaceArg, 'Select a workspace:');
  if (!workspacePath) return;

  if (options.repo) {
    if (!PROMOTABLE_TYPES.includes(type)) {
      console.error(chalk.red(`✖ '${type}' entries cannot be stored in base knowledge (use decision, gotcha, or assumption).`));
      return;
    }
    const repos = await getWorkspaceRepos(workspacePath);
    if (!repos.some((r) => r.name === options.repo)) {
      console.error(chalk.red(`✖ Repository "${options.repo}" is not in this workspace.`));
      console.log(chalk.dim(`  Available: ${repos.map((r) => r.name).join(', ')}`));
      return;
    }
    const res = await addBaseKnowledge(workspacePath, options.repo, {
      type,
      message: options.message,
      title: options.title,
      scope: options.scope,
      evidence: options.evidence,
    });
    console.log(chalk.green(`  ✔ Added to ${chalk.bold(options.repo)} base knowledge under "${res.section}"`));
    console.log(chalk.dim(`  ${res.location}`));
    reportKnowledgeDurability(res);
    return;
  }

  const res = await addWorkspaceKnowledge(workspacePath, {
    type,
    message: options.message,
    title: options.title,
    scope: options.scope,
    evidence: options.evidence,
  });
  console.log(
    chalk.green(`  ✔ Recorded under "${res.section}"${res.createdFile ? ' (created knowledge file)' : ''}`),
  );
  console.log(chalk.dim(`  ${res.location}`));
  reportKnowledgeDurability(res);
}

/**
 * `knowledge search` — find entries by words and print each in full, so an AI reads the whole entry instead of a
 * snippet or the whole file. The same search the MCP `search_knowledge` tool runs.
 *
 * It never asks a question: an AI runs it, and a prompt would hang it. Whatever it cannot search it says so by
 * throwing, which ends the command with a non-zero exit code, as `ctxspace ask` does.
 *
 * @throws When the type or limit is invalid, no workspace is found, or the repo is not in the workspace.
 */
export async function knowledgeSearchCommand(words: string[], options: KnowledgeSearchOptions): Promise<void> {
  if (options.type !== undefined && !VALID_TYPES.includes(options.type as KnowledgeEntryType)) throw new Error(invalidType(options.type));
  const type = options.type as KnowledgeEntryType | undefined;
  const limit = options.limit === undefined ? undefined : parseLimit(options.limit);

  const workspacePath = await resolveWorkspaceQuiet(options.workspace);
  if (!workspacePath) throw new Error('No workspace here. Run this inside a workspace folder, or pass --workspace <path>.');

  if (options.repo) {
    const repos = await getWorkspaceRepos(workspacePath);
    if (!repos.some((r) => r.name === options.repo)) {
      throw new Error(`Repository "${options.repo}" is not in this workspace. Available: ${repos.map((r) => r.name).join(', ')}.`);
    }
  }

  const query = words.join(' ').trim();
  const results = await searchKnowledge(workspacePath, query, { type, scope: options.scope, repo: options.repo, limit });

  if (options.json) {
    console.log(JSON.stringify(results.map(describeResult), null, 2));
  } else if (results.length === 0) {
    console.log(chalk.yellow(`Nothing in the knowledge matches "${query}". Try fewer or different words.`));
  } else {
    console.log(results.map(renderResult).join('\n\n'));
  }
}

/** `knowledge show` — print the workspace knowledge file (or a repo's base file). */
export async function knowledgeShowCommand(workspaceArg: string | undefined, options: ShowOptions): Promise<void> {
  const workspacePath = await resolveWorkspaceInteractive(workspaceArg, 'Select a workspace:');
  if (!workspacePath) return;

  const content = options.repo
    ? await readBaseKnowledge(workspacePath, options.repo)
    : await readWorkspaceKnowledge(workspacePath);

  if (!content) {
    console.log(
      chalk.yellow(
        options.repo
          ? `No base knowledge recorded for ${options.repo} yet.`
          : 'No workspace knowledge recorded yet.',
      ),
    );
    return;
  }

  if (options.scope) {
    const needle = `**scope:** \`${options.scope.toLowerCase()}\``;
    const feature = await loadFeatureConfig(workspacePath);
    const contractEntries = new Set(
      (feature?.contracts ?? [])
        .filter((contract) => contractMatchesScope(contract, options.scope!))
        .map((contract) => contract.entry),
    );
    const entries = parseKnowledgeEntries(content).filter((entry) => {
      const id = knowledgeEntryId(entry.text);
      return entry.text.toLowerCase().includes(needle) || (id !== null && contractEntries.has(id));
    });
    if (entries.length === 0) {
      console.log(chalk.yellow(`No knowledge entries match scope "${options.scope}".`));
      return;
    }
    console.log(entries.map((entry) => entry.text).join('\n\n'));
    return;
  }

  if (options.section) {
    const section = sliceSection(content, options.section);
    if (!section) {
      console.log(chalk.yellow(`Section matching "${options.section}" not found.`));
      return;
    }
    console.log(`\n${section}\n`);
    return;
  }

  console.log(`\n${content}\n`);
}

/**
 * `knowledge promote` — copy (or move) workspace learnings into a repo's
 * persistent base knowledge so they survive across features.
 */
export async function knowledgePromoteCommand(
  workspaceArg: string | undefined,
  options: PromoteOptions,
): Promise<void> {
  console.log(chalk.bold.cyan(`\n🧠 ${BRAND_NAME} — Promote Knowledge to Base\n`));

  const workspacePath = await resolveWorkspaceInteractive(workspaceArg, 'Select a workspace:');
  if (!workspacePath) return;

  const repos = await getWorkspaceRepos(workspacePath);
  if (repos.length === 0) {
    console.log(chalk.yellow('No repositories in this workspace.\n'));
    return;
  }

  // Direct, non-interactive promotion of a supplied message.
  if (options.message) {
    if (!options.repo) {
      console.error(chalk.red('✖ --repo is required when promoting a message with -m.'));
      return;
    }
    if (!repos.some((r) => r.name === options.repo)) {
      console.error(chalk.red(`✖ Repository "${options.repo}" is not in this workspace.`));
      return;
    }
    const type = parseType(options.type ?? 'decision');
    if (!type) return;
    if (!PROMOTABLE_TYPES.includes(type)) {
      console.error(chalk.red(`✖ '${type}' entries cannot be promoted to base knowledge.`));
      return;
    }
    if (!checkEntryLength(options.message)) return;
    if (!options.title?.trim()) {
      console.error(chalk.red('✖ --title is required when promoting a new message directly.'));
      return;
    }
    const res = await addBaseKnowledge(workspacePath, options.repo, { type, message: options.message, title: options.title });
    console.log(chalk.green(`  ✔ Promoted to ${chalk.bold(options.repo)} base knowledge under "${res.section}"`));
    console.log(chalk.dim(`  ${res.location}`));
    reportKnowledgeDurability(res);
    return;
  }

  // Otherwise, promote existing workspace entries.
  const content = await readWorkspaceKnowledge(workspacePath);
  if (!content) {
    console.log(chalk.yellow('No workspace knowledge to promote yet.\n'));
    return;
  }

  const promotable = parseKnowledgeEntries(content).filter(
    (e) => e.type && PROMOTABLE_TYPES.includes(e.type),
  );
  if (promotable.length === 0) {
    console.log(chalk.yellow('No promotable entries (decisions, gotchas, assumptions) found.\n'));
    return;
  }

  const repoName =
    options.repo && repos.some((r) => r.name === options.repo)
      ? options.repo
      : await select({
          message: "Promote into which repository's base knowledge?",
          choices: repos.map((r) => ({ name: r.name, value: r.name })),
        });

  let selected: ParsedKnowledgeEntry[] = promotable;
  if (!options.all) {
    const indices = await checkbox({
      message: 'Select learnings to promote:',
      choices: promotable.map((e, i) => ({ name: `[${e.type}] ${oneLine(e.text)}`, value: i })),
    });
    selected = indices.map((i) => promotable[i]);
  }

  if (selected.length === 0) {
    console.log(chalk.yellow('Nothing selected.\n'));
    return;
  }

  const mode: 'copy' | 'move' = options.move ? 'move' : 'copy';
  const res = await promoteKnowledge(workspacePath, { repoName, entries: selected, mode });
  console.log(
    chalk.green(
      `  ✔ Promoted ${res.promotedCount} learning${res.promotedCount === 1 ? '' : 's'} to ${chalk.bold(repoName)} (${mode})`,
    ),
  );
  console.log(chalk.dim(`  ${res.baseLocation}`));
  for (const failure of res.commitFailures ?? []) {
    console.warn(chalk.yellow(`  ⚠ Knowledge was promoted but Git auto-commit failed: ${failure}`));
  }
}
