/**
 * @module commands/plan
 * `ctxspace plan`: read and change a workspace's plan, run checks and see the change history.
 *
 * Who acts: the AI, named after its tool when known, or the user at their own terminal with no AI tool around.
 * This keeps the log true; it is not a security boundary.
 */

import { Command, Option } from 'commander';
import { readFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { assertWorkspaceWriteLocation, resolveWorkspaceQuiet } from '../utils/resolve-workspace.js';
import { runsInsideAiTool } from '../utils/ai-tool.js';
import { PlanError, type PlanActor } from '../core/plan.js';
import { PLAN_FILE, PlanFileError, addToPlan, answerDecision, findPlanItem, openDecisions, planItems, setDone, type PlanFile } from '../core/plan-file.js';
import { changePlanFile, clearPlanNow, readPlanChanges, readPlanChecks, readPlanFile, runPlanCheck, setPlanNow } from '../core/plan-file-store.js';
import { rehearseMigration, renderRehearsal } from '../core/plan-migrate-rehearsal.js';
import {
  MoveRefusedError, migrateStatus, migrateWorkspace, recoverDatabase, renderMigrateResult, renderMigrateStatus, renderRecover, renderRestoreResult, restoreWorkspace,
  type MigrateOptions,
} from '../core/plan-migrate.js';
import { changePlanDbForApp, PlanDbChangeError, planDbParts, replayPlanAdd } from '../core/plan-db-app.js';
import { applyPlanBatch, planDbJson, planDbText, requirePlanDatabase } from '../core/plan-db-command.js';
import { requireDraftDatabase, type DraftPreview } from '../core/workspace-db-drafts.js';
import { runDbWrite } from '../core/workspace-db-write.js';
import { storeOf } from '../core/workspace-db-app.js';
import { readSwitch } from '../core/workspace-db-switch.js';
import { dbFilePath, runQuery, schemaText } from '../core/workspace-db/index.js';
import { planFileToJson, proofWords, renderPlanChanges, renderPlanStanding, standingLine } from '../core/plan-file-text.js';

/** Options every `ctxspace plan` command takes. */
export interface PlanCommonOptions {
  workspace?: string;
  json?: boolean;
  as?: string;
  harness?: string;
}

/** What a plan command needs from its surroundings; tests supply their own. */
export interface PlanCommandContext {
  workspacePath: string;
  /** Who the log names: `user`, or the AI tool's name (`ai` when unknown). */
  by: string;
  json: boolean;
  print: (text: string) => void;
  now?: Date;
  /** Set by the command line: whether `--workspace` named the workspace. When false, the workspace came from the current folder. */
  explicitWorkspace?: boolean;
  /** The folder the command runs in (the command line sets it). */
  cwd?: string;
}

/** Examples in the help, so nobody has to search for how a change is typed. */
export const PLAN_EXAMPLES = [
  'Examples:',
  '  ctxspace plan                                          where the plan stands',
  '  ctxspace plan done "Write the CSV writer"              tick a step',
  '  ctxspace plan done "Reports export to CSV"             run the checkpoint\'s check, and tick it once it passes',
  '  ctxspace plan check "Reports export to CSV"            run the check without ticking',
  '  ctxspace plan add "Add the Export button" --under "Reports export to CSV"',
  '  ctxspace plan decide "Export archived reports?" --under "Reports export to CSV" --suggest "Yes" --suggest "No" --if-no-answer "No"',
  '  ctxspace plan answer "Export archived reports?" "Yes, all of them"',
  '  ctxspace plan now "Write the CSV writer"              say which step you are working on, so the board shows it',
  '  ctxspace plan now --clear                              say nobody is working on a particular step',
  '  ctxspace plan log                                      what changed lately, and who changed it',
  '  ctxspace plan migrate --dry-run                        rehearse the move to the workspace database; changes nothing',
  '  ctxspace plan migrate                                  move this workspace to its database (the old files go to an archive)',
  '  ctxspace plan migrate --status                         moved or not, when, the archive, and anything that needs doing',
  '  ctxspace plan restore .contextspace/archive/pre-db-…   undo the move: the old files come back byte for byte',
  '',
  '  ctxspace plan apply --file ops.json                   apply an atomic JSON batch on a moved workspace',
  '  ctxspace plan drafts                                  list pending edits to the exported plan',
  '  ctxspace plan import [digest]                         preview an edit before importing it',
  '  ctxspace plan discard <digest>                        discard an edit and keep its original bytes',
  '',
  `A moved workspace uses ids and ctxspace plan apply. A file-based workspace uses ${PLAN_FILE}.`,
].join('\n');

/**
 * Who makes a change in the plan's older lifecycle commands: the AI, named after its tool when known (`--harness`,
 * CTXSPACE_HARNESS, or Claude Code's CLAUDECODE variable), or the user when they ask for it in their own terminal.
 */
export function resolvePlanActor(options: { as?: string; harness?: string }, env: NodeJS.ProcessEnv, interactive: boolean): PlanActor {
  if (options.as !== undefined && options.as !== 'user' && options.as !== 'agent') {
    throw new PlanError(`--as takes "user" or "agent", not "${options.as}".`, 'invalid');
  }
  const harness = (options.harness ?? env.CTXSPACE_HARNESS ?? (env.CLAUDECODE ? 'claude' : undefined))?.trim().toLowerCase() || undefined;
  const agent: PlanActor = harness ? { by: 'agent', harness } : { by: 'agent' };
  if (options.as === 'agent') return agent;
  if (options.as === 'user' && interactive && !runsInsideAiTool(env)) return { by: 'user' };
  if (options.as === 'user') throw new PlanError('Only the user acts as the user, from their own terminal or the app.', 'not_allowed');
  return agent;
}

/**
 * Who the plan's log names for a change from the command line: the AI tool when it is known, else the user at their
 * own terminal with no AI tool around, else the AI.
 */
export function planChangeBy(options: { as?: string; harness?: string }, env: NodeJS.ProcessEnv, interactive: boolean): string {
  const person = interactive && !runsInsideAiTool(env);
  if (options.as === 'user' && person) return 'user';
  const harness = (options.harness ?? env.CTXSPACE_HARNESS ?? (env.CLAUDECODE ? 'claude' : undefined))?.trim().toLowerCase();
  return harness || (person ? 'user' : 'ai');
}

/**
 * The item the words name: its key, or the words of one item, whole or as the start of exactly one. Several matches
 * are named, so the caller can say which.
 */
export function findByWords(plan: PlanFile, words: string, only?: 'checkpoint' | 'decision'): ReturnType<typeof planItems>[number] {
  return findPlanItem(plan, words, only);
}

/** `ctxspace plan`: where the plan stands. */
export async function planShow(context: PlanCommandContext, options: { id?: string; all?: boolean } = {}): Promise<void> {
  if (storeOf(context.workspacePath) === 'database') {
    context.print(context.json && !options.id ? JSON.stringify(await planDbJson(context.workspacePath), null, 2) : await planDbText(context.workspacePath, options));
    return;
  }
  if (options.id || options.all) requirePlanDatabase(context.workspacePath);
  const read = await readPlanFile(context.workspacePath);
  const checks = await readPlanChecks(context.workspacePath);
  context.print(context.json ? JSON.stringify(planFileToJson(read, checks), null, 2) : renderPlanStanding(read, checks, context.now));
}

/** `ctxspace plan log`: what changed lately, and who changed it. */
export async function planLog(context: PlanCommandContext): Promise<void> {
  const root = context.workspacePath;
  const database = storeOf(root) === 'database';
  if (!database) await readPlanFile(root);
  const changes = database ? (await planDbParts(root, 20)).changes : await readPlanChanges(root, 20);
  context.print(context.json ? JSON.stringify({ changes }, null, 2) : renderPlanChanges(changes, context.now));
}

async function readPlanForCommand(root: string) {
  if (storeOf(root) === 'files') return { plan: (await readPlanFile(root)).plan };
  const { read } = await planDbParts(root, 0);
  return { plan: read.plan, read };
}

async function reportDb(context: PlanCommandContext, message: string, fallback: PlanFile, extra?: object): Promise<void> {
  // A committed write still succeeds if a different writer prevents a fresh count.
  const after = await planDbParts(context.workspacePath, 0).then(({ read }) => read.plan, () => fallback);
  report(context, message, after, extra);
}

function report(context: PlanCommandContext, message: string, plan: PlanFile, extra: object = {}): void {
  context.print(context.json ? JSON.stringify({ ok: true, message, ...extra, waitingForTheUser: openDecisions(plan).map((decision) => decision.question) }, null, 2) : `${message}\n${standingLine(plan)}`);
}

/**
 * `ctxspace plan done <words>`: ticks a step or checkpoint. A checkpoint with a check runs it first and is ticked
 * only when it passes; a decision is answered with `answer` instead.
 */
export async function planDone(context: PlanCommandContext, words: string): Promise<void> {
  await assertActsHere(context);
  const { plan, read } = await readPlanForCommand(context.workspacePath);
  const item = findByWords(plan, words);
  if ('question' in item) throw new PlanFileError(`"${item.question}" is a decision: answer it with ctxspace plan answer, and only with what the user said.`, 'invalid');
  if (read) {
    const { message } = await changePlanDbForApp(context.workspacePath, { type: 'tick', key: item.key, done: true, expected: 'title' in item ? item.title : item.text }, { by: context.by, read, rerunCheck: true });
    await reportDb(context, message, plan);
    return;
  }
  if ('title' in item && item.check !== undefined) {
    const evidence = await runPlanCheck(context.workspacePath, item.key);
    if (!evidence.canProgress) {
      throw new PlanFileError(`"${item.title}" stays open: its ${proofWords(item, evidence, context.now)}. Fix what fails and run it again.`, 'invalid');
    }
  }
  const name = 'title' in item ? item.title : item.text;
  const after = await changePlanFile(context.workspacePath, (text) => setDone(text, item.key, true, name), { by: context.by });
  report(context, `Ticked "${name}".`, after.plan);
}

/** `ctxspace plan check [words]`: runs a checkpoint's check (the first open one by default) without ticking it. */
export async function planCheck(context: PlanCommandContext, words?: string): Promise<void> {
  await assertActsHere(context);
  const { plan, read } = await readPlanForCommand(context.workspacePath);
  const checkpoint = words ? findByWords(plan, words, 'checkpoint') : plan.checkpoints.find((candidate) => !candidate.done && candidate.check !== undefined);
  if (!checkpoint || !('title' in checkpoint)) throw new PlanFileError(`No open checkpoint in ${PLAN_FILE} has a Check: line.`, 'not_found');
  const evidence = read
    ? (await changePlanDbForApp(context.workspacePath, { type: 'check', key: checkpoint.key }, { by: context.by, read, defaultCheck: true })).evidence!
    : await runPlanCheck(context.workspacePath, checkpoint.key);
  const message = `"${checkpoint.title}": ${proofWords(checkpoint, evidence, context.now)}.`;
  if (context.json) context.print(JSON.stringify({ ok: evidence.canProgress, message, proof: evidence }, null, 2));
  else context.print(message);
  if (!evidence.canProgress) process.exitCode = 1;
}

/**
 * `ctxspace plan now <words>`: says which step is being worked on, so the board and the header show it as Now. It is
 * kept beside the plan, not in it, and ticking or removing the step clears it. `--clear` says none.
 */
export async function planNow(context: PlanCommandContext, words: string, clear = false): Promise<void> {
  await assertActsHere(context);
  if (clear) {
    const root = context.workspacePath;
    let had: boolean;
    if (storeOf(root) === 'database') {
      const { read, now } = await planDbParts(root, 0);
      await changePlanDbForApp(root, { type: 'now-clear' }, { read, by: context.by });
      had = now !== null;
    } else had = await clearPlanNow(root);
    const message = had ? 'No step is marked as being worked on now.' : 'No step was marked as being worked on.';
    context.print(context.json ? JSON.stringify({ ok: true, message }, null, 2) : message);
    return;
  }
  const { plan, read } = await readPlanForCommand(context.workspacePath);
  const step = findPlanItem(plan, words, 'step');
  const message = read
    ? (await changePlanDbForApp(context.workspacePath, { type: 'now', key: step.key }, { by: context.by, read })).message
    : `Working on "${(await setPlanNow(context.workspacePath, step.key, context.by, context.now)).text}" now.`;
  context.print(context.json ? JSON.stringify({ ok: true, message, key: step.key, by: context.by }, null, 2) : message);
}

/** `ctxspace plan answer <decision> <answer>`: ticks the decision and writes the answer under it. */
export async function planAnswer(context: PlanCommandContext, words: string, answer: string): Promise<void> {
  await assertActsHere(context);
  const { plan, read } = await readPlanForCommand(context.workspacePath);
  const decision = findByWords(plan, words, 'decision');
  if (!('question' in decision)) throw new PlanFileError(`"${words}" is not a decision.`, 'invalid');
  const wordsOfAnswer = answer.replace(/\s+/g, ' ').trim();
  const message = `Answered "${decision.question}": ${wordsOfAnswer}`;
  if (read) {
    if (decision.answer !== undefined) {
      if (decision.answer === wordsOfAnswer) {
        report(context, message, plan);
        return;
      }
      const current = read.revs.get(decision.key);
      throw new PlanDbChangeError(`"${decision.question}" already has an answer at rev ${current}: "${decision.answer}". Read \`ctxspace plan ${decision.key}\` and use \`ctxspace plan apply\` with the observed rev and dbId to change the answer.`, 409, 'rev_conflict');
    }
    await changePlanDbForApp(context.workspacePath, { type: 'answer', key: decision.key, answer, expected: decision.question }, { by: context.by, read });
    await reportDb(context, message, plan);
    return;
  }
  const after = await changePlanFile(context.workspacePath, (text) => answerDecision(text, decision.key, answer, decision.question), { by: context.by });
  report(context, message, after.plan);
}

/** `ctxspace plan add` and `ctxspace plan decide`: a step or a decision, under a checkpoint or on its own. */
export async function planAdd(
  context: PlanCommandContext,
  entry: { step: string } | { decision: { question: string; suggested?: string[]; ifNoAnswer?: string; detail?: string } },
  under?: string,
  requestId?: string,
): Promise<void> {
  await assertActsHere(context);
  const { plan, read } = await readPlanForCommand(context.workspacePath);
  const name = 'step' in entry ? entry.step : entry.decision.question;
  const added = `Added ${'step' in entry ? 'the step' : 'the decision'} "${name.trim()}"`;
  const requestSource = read && requestId ? JSON.stringify({ shortcut: entry, under, by: context.by }) : undefined;
  if (requestId && requestSource !== undefined) {
    const replay = await replayPlanAdd(context.workspacePath, requestId, requestSource);
    if (replay) {
      const message = `${added}${under ? ` under "${under}"` : ''}.`;
      report(context, context.json ? message : `${message}\nRequest ID: ${requestId}`, plan, { key: replay.key, requestId });
      return;
    }
  }
  const checkpoint = under ? findByWords(plan, under, 'checkpoint') : undefined;
  const where = checkpoint && 'title' in checkpoint ? ` under "${checkpoint.title}"` : '';
  const message = `${added}${where}.`;
  if (read) {
    const change = 'step' in entry ? { type: 'add' as const, ...entry } : { type: 'decide' as const, ...entry };
    const saved = await changePlanDbForApp(context.workspacePath, { ...change, checkpoint: checkpoint?.key }, { by: context.by, read, requestId, requestSource });
    await reportDb(context, context.json ? message : `${message}\nRequest ID: ${saved.requestId}`, plan, { key: saved.key, requestId: saved.requestId });
    return;
  }
  if (requestId !== undefined) requirePlanDatabase(context.workspacePath);
  let key = '';
  const after = await changePlanFile(context.workspacePath, (text) => {
    const added = addToPlan(text, entry, checkpoint ? { checkpoint: checkpoint.key } : {});
    key = added.key;
    return added.text;
  }, { by: context.by });
  report(context, message, after.plan, { key });
}

async function planApply(context: PlanCommandContext, arg?: string, file?: string): Promise<void> {
  await assertActsHere(context);
  requirePlanDatabase(context.workspacePath);
  if (Number(arg !== undefined) + Number(file !== undefined) !== 1) {
    throw new PlanFileError('Give one JSON argument, --file <path>, or - to read stdin.', 'invalid');
  }
  let source = arg;
  if (file === '-' || arg === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    source = Buffer.concat(chunks).toString('utf8');
  } else if (file !== undefined) source = await readFile(file, 'utf8');
  let input: unknown;
  try { input = JSON.parse(source!); }
  catch (error) { throw new PlanFileError(`The batch is not valid JSON: ${(error as Error).message}`, 'invalid'); }
  const result = await applyPlanBatch(context.workspacePath, input, context.by);
  if (context.json) context.print(JSON.stringify(result, null, 2));
  else if (result.ok) context.print([`Revision ${result.revision}${result.replayed ? ' (already applied)' : ''}`, ...result.changed, ...(result.requestId ? [`Request ID: ${result.requestId}`] : [])].join('\n'));
  else context.print([`Revision ${result.revision}. No changes applied.`, ...result.errors.map((issue) => issue.message)].join('\n'));
  if (!result.ok) process.exitCode = 1;
}

async function withDrafts(context: PlanCommandContext): Promise<string> {
  await assertActsHere(context);
  requireDraftDatabase(context.workspacePath);
  return context.workspacePath;
}

function draftPreviewWords(preview: DraftPreview): string {
  const lines = [`Draft ${preview.digest} against database revision ${preview.revision}`];
  if (!preview.baseKnown) lines.push('The original export could not be found. Every change needs confirmation.');
  for (const match of preview.matched) lines.push(`Matched by words: ${match}`);
  for (const change of preview.changes) {
    const before = change.before?.split('\n').map((line) => `  - ${line}`) ?? [];
    const after = change.after?.split('\n').map((line) => `  + ${line}`) ?? [];
    lines.push(`${change.conflict ? 'Conflict · ' : ''}${change.kind}${change.confirm ? ' (confirm)' : ''}`, ...before, ...after);
  }
  if (!preview.changes.length) lines.push('The draft has no changes to apply.');
  lines.push(`To confirm, run: ctxspace plan import ${preview.digest} --yes --preview ${preview.token}`);
  return lines.join('\n');
}

async function planImport(context: PlanCommandContext, digest: string | undefined, options: { yes?: boolean; preview?: string; by?: string }) {
  const root = await withDrafts(context);
  if (!digest) {
    const { drafts } = await runDbWrite(root, { type: 'draft-list' });
    if (drafts.length !== 1) throw new PlanFileError(drafts.length ? 'More than one draft is pending. Use its digest from ctxspace plan drafts.' : 'There are no pending drafts.', 'invalid');
    digest = drafts[0]!.digest;
  }
  if (!options.yes || !options.preview) {
    const preview = await runDbWrite(root, { type: 'draft-preview', digest });
    context.print(context.json ? JSON.stringify(preview, null, 2) : draftPreviewWords(preview));
    if (options.yes) process.exitCode = 1;
    return;
  }
  const result = await runDbWrite(root, { type: 'draft-import', digest, token: options.preview, by: options.by ?? 'user' });
  context.print(context.json ? JSON.stringify(result, null, 2) : result.ok ? `Draft imported at revision ${result.revision}.`
    : [result.error, ...(result.preview ? [draftPreviewWords(result.preview)] : [])].join('\n'));
  if (!result.ok) process.exitCode = 1;
}

/** The older verbs, kept so an AI with older instructions learns what to do instead. */
const RETIRED = ['start', 'drop', 'later', 'block', 'reopen', 'edit', 'accept', 'reject'] as const;

function textOf(...candidates: Array<string | string[] | undefined>): string {
  for (const candidate of candidates) {
    const text = Array.isArray(candidate) ? candidate.join(' ') : candidate;
    if (text?.trim()) return text;
  }
  return '';
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

async function contextFor(options: PlanCommonOptions): Promise<PlanCommandContext> {
  const workspacePath = await resolveWorkspaceQuiet(options.workspace);
  if (!workspacePath) throw new PlanFileError('No workspace here. Run this inside a workspace folder, or pass --workspace <path>.', 'not_found');
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return { workspacePath, by: planChangeBy(options, process.env, interactive), json: Boolean(options.json), print: (text) => console.log(text), explicitWorkspace: Boolean(options.workspace), cwd: process.cwd() };
}

const real = (p: string) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };

async function assertActsHere(context: PlanCommandContext): Promise<void> {
  if (context.explicitWorkspace === false) await assertWorkspaceWriteLocation(context.workspacePath, context.cwd);
}

/**
 * `ctxspace plan migrate --dry-run`: builds a database from today's files in a folder of its own and says what it found.
 * Exit code 0 when everything maps and the plan round-trips, 3 when it worked but something is listed, 1 when it failed.
 */
export async function planMigrate(
  context: PlanCommandContext,
  options: { dryRun?: boolean; out?: string; status?: boolean; fromBackup?: string },
  seams: Pick<MigrateOptions, 'afterStep' | 'findOlderWriters' | 'backup'> = {},
): Promise<void> {
  await assertActsHere(context);
  const modes = [options.dryRun, options.status, options.fromBackup !== undefined].filter(Boolean).length;
  if (modes > 1) throw new PlanFileError('Use one of --dry-run, --status and --from-backup at a time.', 'invalid');
  if (options.status) {
    const status = await migrateStatus(context.workspacePath);
    context.print(context.json ? JSON.stringify(status, null, 2) : renderMigrateStatus(status));
    return;
  }
  const root = real(context.workspacePath);
  if (options.dryRun) {
    if (readSwitch(root)) throw new PlanFileError(`This workspace was moved to the workspace database already (or a move or restore is under way), so there is nothing to rehearse. See \`ctxspace plan migrate --status\`.`, 'conflict');
    const report = await rehearseMigration(context.workspacePath, { out: options.out });
    context.print(context.json ? JSON.stringify(report, null, 2) : renderRehearsal(report));
    if (report.exitCode !== 0) process.exitCode = report.exitCode;
    return;
  }
  if (options.out) throw new PlanFileError('--out is for the rehearsal (--dry-run): the move itself writes only inside the workspace.', 'invalid');
  try {
    // A moved workspace whose database went missing: bring it back (never start an empty one), or say how.
    if (options.fromBackup !== undefined || (readSwitch(root)?.state === 'on' && !existsSync(dbFilePath(root)))) {
      const recovered = await recoverDatabase(context.workspacePath, { fromBackup: options.fromBackup, by: context.by });
      context.print(context.json ? JSON.stringify({ ok: true, ...recovered }, null, 2) : renderRecover(recovered));
      return;
    }
    const result = await migrateWorkspace(context.workspacePath, { by: context.by, now: context.now, ...seams });
    const instructionsProblem = await regeneratePlanInstructions(result.workspace);
    if (instructionsProblem) result.instructionsProblem = instructionsProblem;
    context.print(context.json ? JSON.stringify({ ok: true, ...result }, null, 2) : renderMigrateResult(result));
  } catch (error) {
    if (!(error instanceof MoveRefusedError) || !context.json) throw error;
    context.print(JSON.stringify({ ok: false, error: error.message, code: error.code, ...(error.report ? { report: error.report } : {}), ...(error.olderWriters ? { olderWriters: error.olderWriters } : {}) }, null, 2));
    process.exitCode = 1;
  }
}

/** `ctxspace plan restore <archive>`: undoes the move to the workspace database; the old files come back byte for byte. */
export async function planRestore(context: PlanCommandContext, archive: string): Promise<void> {
  await assertActsHere(context);
  const result = await restoreWorkspace(context.workspacePath, archive, { by: context.by }, context.cwd ?? process.cwd());
  const instructionsProblem = await regeneratePlanInstructions(result.workspace);
  if (instructionsProblem) result.notes.push(instructionsProblem);
  context.print(context.json ? JSON.stringify({ ok: true, ...result }, null, 2) : renderRestoreResult(result));
}

async function regeneratePlanInstructions(root: string): Promise<string | undefined> {
  try {
    const { refreshWorkspace } = await import('../core/refresh.js');
    await refreshWorkspace(root, { planCutover: true });
  } catch (error) {
    return `Could not refresh the assistant instructions and skills (${error instanceof Error ? error.message : String(error)}). Run \`ctxspace refresh\`.`;
  }
}

/**
 * Adds `ctxspace plan` and its verbs to the CLI. `fail` reports an error the way every other command does; with
 * --json the error is printed as JSON and the exit code is still 1.
 */
export function registerPlanCommand(program: Command, fail: (error: unknown) => Promise<void> | void): void {
  const common = (command: Command) => command
    .option('-w, --workspace <path>', 'Workspace path or name (defaults to the workspace you are in)')
    .option('--json', 'Print JSON instead of text')
    .addOption(new Option('--as <who>', 'Act as "user" (a person in their own terminal)').hideHelp())
    .addOption(new Option('--harness <name>', 'Name of the AI tool making the change, for the log').hideHelp());

  const plan = common(program
    .command('plan')
    .description('Read and change the workspace plan')
    .addHelpText('after', `\n${PLAN_EXAMPLES}\n`));

  const action = <O extends PlanCommonOptions, A extends unknown[]>(handler: (context: PlanCommandContext, options: O, ...args: A) => Promise<void>) =>
    async (...args: [...A, O, Command]) => {
      const options = (args[args.length - 1] as Command).optsWithGlobals<O>();
      const positional = args.slice(0, -2) as unknown as A;
      try {
        await handler(await contextFor(options), options, ...positional);
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code }, null, 2));
          process.exitCode = 1;
          return;
        }
        await fail(error);
      }
    };

  common(plan.command('show', { isDefault: true }).description('Show checkpoints, steps, checks and decisions').argument('[id]')
    .option('--all', 'Show the full plan on a moved workspace'))
    .action(action<PlanCommonOptions & { all?: boolean }, [string | undefined]>((context, options, id) => planShow(context, { id, all: options.all })));

  common(plan.command('apply').description('Apply a JSON batch on a moved workspace. Pass a requestId and resend it with the same batch to retry safely.').argument('[json]')
    .option('--file <path>', 'Read the batch from a file or use - for stdin'))
    .action(action<PlanCommonOptions & { file?: string }, [string | undefined]>((context, options, arg) => planApply(context, arg, options.file)));

  common(plan.command('drafts').description('List pending plan drafts'))
    .action(action<PlanCommonOptions, []>(async (context) => {
      const { drafts } = await runDbWrite(await withDrafts(context), { type: 'draft-list' });
      context.print(context.json ? JSON.stringify({ drafts }, null, 2) : drafts.length
        ? drafts.map((draft) => `${draft.digest}  ${draft.at}  ${draft.file}  +${draft.added} −${draft.removed} lines (${draft.bytes} bytes)`).join('\n')
        : 'There are no pending drafts.');
    }));

  common(plan.command('import').description('Preview a pending plan draft and apply a confirmed preview').argument('[digest]')
    .option('--yes', 'Confirm the changes in the preview')
    .option('--preview <token>', 'Bind confirmation to the token printed by the preview')
    .option('--by <who>', 'Name the person or assistant importing the draft', 'user'))
    .action(action<PlanCommonOptions & { yes?: boolean; preview?: string; by?: string }, [string | undefined]>((context, options, digest) => planImport(context, digest, options)));

  common(plan.command('discard').description('Discard a pending draft and keep its saved file').argument('<digest>'))
    .action(action<PlanCommonOptions, [string]>(async (context, _options, digest) => {
      const result = await runDbWrite(await withDrafts(context), { type: 'draft-discard', digest });
      context.print(context.json ? JSON.stringify(result, null, 2) : 'Draft discarded. Its saved file is kept.');
    }));

  common(plan.command('schema').description('Show the workspace database schema'))
    .action(action<PlanCommonOptions, []>(async (context) => { requirePlanDatabase(context.workspacePath); context.print(schemaText()); }));

  common(plan.command('query').description('Run a read-only query on the workspace database').argument('<sql>'))
    .action(action<PlanCommonOptions, [string]>(async (context, _options, sql) => {
      requirePlanDatabase(context.workspacePath);
      const result = await runQuery(context.workspacePath, sql);
      context.print(context.json ? JSON.stringify(result, null, 2) : [result.columns.join('  '), ...result.rows.map((row) => result.columns.map((column) => String(row[column] ?? '')).join('  '))].join('\n'));
    }));

  common(plan.command('done').description('Tick a step or checkpoint; a checkpoint with a check is ticked only once it passes').argument('<words...>', 'The step or checkpoint, or the start of its words'))
    .action(action<PlanCommonOptions, [string[]]>((context, _options, words) => planDone(context, words.join(' '))));

  common(plan.command('check').description('Run a checkpoint\'s check and keep the result as its proof, without ticking it').argument('[words...]', 'The checkpoint (default: the first open one with a check)'))
    .action(action<PlanCommonOptions, [string[]]>((context, _options, words) => planCheck(context, words.length ? words.join(' ') : undefined)));

  common(plan.command('answer').description('Answer a decision with what the user said').argument('<decision>', 'The decision, or the start of its words').argument('[answer...]')
    .option('-m, --message <text>', 'The answer'))
    .action(action<PlanCommonOptions & { message?: string }, [string, string[]]>((context, options, decision, words) =>
      planAnswer(context, decision, textOf(options.message, words))));

  common(plan.command('add').description('Add a step, under a checkpoint or on its own').argument('<step...>')
    .option('--under <checkpoint>', 'The checkpoint it serves')
    .option('--request-id <id>', 'On a moved workspace, reuse this ID and the same input to retry'))
    .action(action<PlanCommonOptions & { under?: string; requestId?: string }, [string[]]>((context, options, words) => planAdd(context, { step: words.join(' ') }, options.under, options.requestId)));

  common(plan.command('decide').description('Add a decision only the user can make, under what it holds up').argument('<question...>')
    .option('--under <checkpoint>', 'The checkpoint it holds up')
    .option('--suggest <answer>', 'An answer to suggest (repeat for more)', collect, [])
    .option('--if-no-answer <what>', 'What happens when nobody answers')
    .option('--detail <text>', 'Why it is asked')
    .option('--request-id <id>', 'On a moved workspace, reuse this ID and the same input to retry'))
    .action(action<PlanCommonOptions & { under?: string; suggest: string[]; ifNoAnswer?: string; detail?: string; requestId?: string }, [string[]]>((context, options, words) =>
      planAdd(context, { decision: { question: words.join(' '), suggested: options.suggest, ifNoAnswer: options.ifNoAnswer, detail: options.detail } }, options.under, options.requestId)));

  common(plan.command('now').description('Say which step you are working on now, so the board shows it as Now').argument('[words...]', 'The step, or the start of its words')
    .option('--clear', 'Say that no step is being worked on'))
    .action(action<PlanCommonOptions & { clear?: boolean }, [string[]]>((context, options, words) => {
      if (!options.clear && words.length === 0) throw new PlanFileError('Name the step you are working on, or use --clear.', 'invalid');
      return planNow(context, words.join(' '), Boolean(options.clear));
    }));

  common(plan.command('migrate').description('Move this workspace to its workspace database (the old files go to an archive, and `plan restore` brings them back); --dry-run rehearses and changes nothing')
    .option('--dry-run', 'Rehearse only: build a database in a temp folder, say what it found, change nothing')
    .option('--out <dir>', 'With --dry-run: keep the rehearsal database and files in this folder (never inside the workspace)')
    .option('--status', 'Moved or not, when, the archive, and anything that needs doing')
    .option('--from-backup <name>', 'A moved workspace whose database is missing: bring back this backup from .contextspace/backups/'))
    .action(action<PlanCommonOptions & { dryRun?: boolean; out?: string; status?: boolean; fromBackup?: string }, []>((context, options) => planMigrate(context, options)));

  common(plan.command('restore').description('Undo the move to the workspace database: the old files come back byte for byte, and the database is moved aside, never deleted').argument('<archive>', 'The move\'s archive folder, as `plan migrate --status` names it'))
    .action(action<PlanCommonOptions, [string]>((context, _options, archive) => planRestore(context, archive)));

  common(plan.command('log').description('What changed lately, and who changed it'))
    .action(action<PlanCommonOptions, []>((context) => planLog(context)));

  for (const verb of RETIRED) {
    common(plan.command(verb, { hidden: true }).argument('[words...]').allowUnknownOption())
      .action(action<PlanCommonOptions, [string[]]>(async (context) => {
        if (storeOf(context.workspacePath) === 'database') {
          throw new PlanFileError(`"ctxspace plan ${verb}" is gone. Read the plan with "ctxspace plan" and change it by id with "ctxspace plan apply".`, 'invalid');
        }
        throw new PlanFileError(`"ctxspace plan ${verb}" is gone: the plan is ${PLAN_FILE} now. Edit it directly, for example rewrite or remove the step, or say why under it. Run "ctxspace plan --help" for the few commands left.`, 'invalid');
      }));
  }
}
