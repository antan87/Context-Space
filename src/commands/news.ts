/**
 * @module commands/news
 * `ctxspace news`: what changed in the workspace since you last looked, and who made each change. An AI session runs
 * it when it starts and after its context was compacted; the developer can run it too. Each reader (the user, or the
 * AI tool by name) has their own record of when they last looked, so reading never hides a change from anyone else.
 */

import { BRAND_NAME } from '../core/constants.js';
import { ago } from '../core/plan-file-text.js';
import { FIRST_LOOK_DAYS, newsReaderName, whatsNew, type NewsPlanChange, type WhatsNew } from '../core/whats-new.js';
import { planChangeBy } from './plan.js';
import { resolveWorkspaceQuiet } from '../utils/resolve-workspace.js';

export interface NewsOptions {
  /** Read as this name (`user` only from a person's own terminal). */
  as?: string;
  /** Look without recording that you have. */
  peek?: boolean;
  /** Reach back to this time instead of your last look. */
  since?: string;
  json?: boolean;
  workspace?: string;
}

/**
 * Who is reading: `--as` with a name, else the same answer `ctxspace plan` gives for who makes a change (the AI tool
 * when it is known, the user at their own terminal, otherwise `ai`). Only a person at their own terminal reads as
 * `user`, so an AI cannot mark the user's changes as seen.
 */
export function newsReader(options: { as?: string }, env: NodeJS.ProcessEnv, interactive: boolean): string {
  const named = options.as?.trim();
  if (named && named.toLowerCase() !== 'user') return newsReaderName(named);
  return planChangeBy({ as: named }, env, interactive);
}

const WHO: Record<string, string> = { user: 'The user', file: 'Someone', ai: 'An AI', contextspace: BRAND_NAME };
const VERB: Record<NewsPlanChange['action'], string> = { added: 'added', removed: 'removed', ticked: 'ticked', unticked: 'reopened', answered: 'answered' };

const who = (by: string) => WHO[by] ?? by.charAt(0).toUpperCase() + by.slice(1);
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
/** "40 min ago", "2 h ago"; "just now" for under a minute. */
function when(at: string, now: Date): string {
  const then = Date.parse(at);
  if (Math.abs(now.getTime() - then) < 60_000) return 'just now';
  return ago(at, now) || at;
}

function planLine(change: NewsPlanChange, now: Date): string {
  const answer = change.action === 'answered' && change.note ? `: ${short(change.note.replace(/\s+/g, ' '), 80)}` : '';
  return `${who(change.by)} ${VERB[change.action]} ${change.kind} "${short(change.text, 80)}"${answer} · ${when(change.at, now)}`;
}

function heading(report: WhatsNew, now: Date): string {
  const text = when(report.from, now);
  if (report.basis === 'first-look') return `First look: the last ${FIRST_LOOK_DAYS} days:`;
  if (report.basis === 'time') return `Since ${text === 'just now' ? 'a moment ago' : text}:`;
  return text === 'just now' ? 'Since you last looked just now:' : `Since you last looked, ${text}:`;
}

function nothingLine(report: WhatsNew, now: Date): string {
  const text = when(report.from, now);
  if (report.basis === 'first-look') return `Nothing changed in the last ${FIRST_LOOK_DAYS} days (first look).`;
  return report.basis === 'time' ? `Nothing changed since ${text === 'just now' ? 'a moment ago' : text}.` : `Nothing changed since you last looked (${text}).`;
}

const more = (count: number, what: string, atLeast = false) => `… and ${count}${atLeast ? '+' : ''} ${what}`;

/** The report as text: a heading line, then a few short lines under each section that has something. */
export function renderNews(report: WhatsNew, now: Date = new Date()): string {
  const problems = [
    ...report.commits.filter((repo) => repo.problem).map((repo) => `${repo.repo}: could not be read (${repo.problem})`),
    ...report.problems,
  ];
  if (report.empty) return [nothingLine(report, now), ...problems].join('\n');

  const lines = [heading(report, now)];
  const section = (title: string, body: string[]) => { if (body.length) lines.push('', title, ...body.map((line) => `  ${line}`)); };

  // The plan lists the newest changes, oldest first, so the ones left out are the earlier ones.
  section('Plan', [
    ...(report.plan.more ? [more(report.plan.more, 'earlier, not shown')] : []),
    ...report.plan.items.map((change) => planLine(change, now)),
  ]);
  section('Documents', [
    ...report.documents.items.map((document) => `${document.name} ${document.change} · ${when(document.at, now)}`),
    ...(report.documents.more ? [more(report.documents.more, 'more')] : []),
  ]);
  section('Knowledge', [
    ...report.knowledge.items.map((entry) => `${entry.type ?? 'note'} "${short(entry.title, 80)}"${entry.date ? ` · ${entry.date}` : ''}`),
    ...(report.knowledge.more ? [more(report.knowledge.more, 'more')] : []),
  ]);
  section('Commits', report.commits.flatMap((repo) => [
    ...repo.commits.map((commit) => `${repo.repo}: ${commit.sha} ${short(commit.subject, 100)} (${commit.author}) · ${when(commit.at, now)}`),
    ...(repo.more ? [more(repo.more, `more in ${repo.repo}`, repo.moreAtLeast)] : []),
  ]));
  if (problems.length) lines.push('', ...problems);
  return lines.join('\n');
}

/**
 * `news` — prints what is new for the reader, and unless `--peek`, records that they have looked.
 *
 * @throws When there is no workspace here, or `--as` or `--since` is not usable. With `--json` the error is printed as
 *   JSON instead and the exit code is 1.
 */
export async function newsCommand(options: NewsOptions): Promise<void> {
  try {
    const workspacePath = await resolveWorkspaceQuiet(options.workspace);
    if (!workspacePath) throw new Error('No workspace here. Run this inside a workspace folder, or pass --workspace <path>.');
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const now = new Date();
    const report = await whatsNew(workspacePath, newsReader(options, process.env, interactive), { now, since: options.since, mark: !options.peek });
    console.log(options.json ? JSON.stringify(report, null, 2) : renderNews(report, now));
  } catch (error) {
    if (!options.json) throw error;
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}
