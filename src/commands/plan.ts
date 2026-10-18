/**
 * @module commands/plan
 * `ctxspace plan`: where the plan stands, and the few changes worth a command. The plan is PLAN.md, which any AI
 * or person edits directly; the command adds what a file edit cannot do: run a checkpoint's check before it is
 * ticked, and say what changed and who changed it.
 *
 * Who acts: the AI, named after its tool when known, or the user at their own terminal with no AI tool around.
 * This keeps the log true; it is not a security boundary.
 */

import { Command, Option } from 'commander';
import { resolveWorkspaceQuiet } from '../utils/resolve-workspace.js';
import { runsInsideAiTool } from '../utils/ai-tool.js';
import { PlanError, type PlanActor } from '../core/plan.js';
import { PLAN_FILE, PlanFileError, addToPlan, answerDecision, openDecisions, planItems, planKey, setDone, type PlanFile } from '../core/plan-file.js';
import { changePlanFile, readPlanChanges, readPlanChecks, readPlanFile, runPlanCheck } from '../core/plan-file-store.js';
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
  '  ctxspace plan log                                      what changed lately, and who changed it',
  '',
  `Most changes need no command: edit ${PLAN_FILE} directly.`,
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
  const items = planItems(plan).filter((item) => !only || (only === 'decision' ? 'question' in item : 'title' in item));
  const nameOf = (item: (typeof items)[number]) => ('question' in item ? item.question : 'title' in item ? item.title : item.text);
  const wanted = words.trim().toLowerCase();
  const exact = items.filter((item) => item.key === words.trim() || item.key === planKey(words) || nameOf(item).toLowerCase() === wanted);
  const matches = exact.length ? exact : items.filter((item) => nameOf(item).toLowerCase().startsWith(wanted) || planKey(nameOf(item)).startsWith(planKey(words)));
  const what = only ?? 'item';
  if (!wanted || !matches.length) throw new PlanFileError(`No ${what} in ${PLAN_FILE} matches "${words}". Run "ctxspace plan" to see them.`, 'not_found');
  if (matches.length > 1) {
    throw new PlanFileError(`"${words}" matches ${matches.length} items: ${matches.slice(0, 5).map((item) => `"${nameOf(item)}"`).join(', ')}. Use more of the words.`, 'invalid');
  }
  return matches[0]!;
}

/** `ctxspace plan`: where the plan stands. */
export async function planShow(context: PlanCommandContext): Promise<void> {
  const read = await readPlanFile(context.workspacePath);
  const checks = await readPlanChecks(context.workspacePath);
  context.print(context.json ? JSON.stringify(planFileToJson(read, checks), null, 2) : renderPlanStanding(read, checks, context.now));
}

/** `ctxspace plan log`: what changed lately, and who changed it. */
export async function planLog(context: PlanCommandContext): Promise<void> {
  await readPlanFile(context.workspacePath);
  const changes = await readPlanChanges(context.workspacePath, 20);
  context.print(context.json ? JSON.stringify({ changes }, null, 2) : renderPlanChanges(changes, context.now));
}

function report(context: PlanCommandContext, message: string, plan: PlanFile, extra: object = {}): void {
  context.print(context.json ? JSON.stringify({ ok: true, message, ...extra, waitingForTheUser: openDecisions(plan).map((decision) => decision.question) }, null, 2) : `${message}\n${standingLine(plan)}`);
}

/**
 * `ctxspace plan done <words>`: ticks a step or checkpoint. A checkpoint with a check runs it first and is ticked
 * only when it passes; a decision is answered with `answer` instead.
 */
export async function planDone(context: PlanCommandContext, words: string): Promise<void> {
  const { plan } = await readPlanFile(context.workspacePath);
  const item = findByWords(plan, words);
  if ('question' in item) throw new PlanFileError(`"${item.question}" is a decision: answer it with ctxspace plan answer, and only with what the user said.`, 'invalid');
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
  const { plan } = await readPlanFile(context.workspacePath);
  const checkpoint = words ? findByWords(plan, words, 'checkpoint') : plan.checkpoints.find((candidate) => !candidate.done && candidate.check !== undefined);
  if (!checkpoint || !('title' in checkpoint)) throw new PlanFileError(`No open checkpoint in ${PLAN_FILE} has a Check: line.`, 'not_found');
  const evidence = await runPlanCheck(context.workspacePath, checkpoint.key);
  const message = `"${checkpoint.title}": ${proofWords(checkpoint, evidence, context.now)}.`;
  if (context.json) context.print(JSON.stringify({ ok: evidence.canProgress, message, proof: evidence }, null, 2));
  else context.print(message);
  if (!evidence.canProgress) process.exitCode = 1;
}

/** `ctxspace plan answer <decision> <answer>`: ticks the decision and writes the answer under it. */
export async function planAnswer(context: PlanCommandContext, words: string, answer: string): Promise<void> {
  const { plan } = await readPlanFile(context.workspacePath);
  const decision = findByWords(plan, words, 'decision');
  if (!('question' in decision)) throw new PlanFileError(`"${words}" is not a decision.`, 'invalid');
  const after = await changePlanFile(context.workspacePath, (text) => answerDecision(text, decision.key, answer, decision.question), { by: context.by });
  report(context, `Answered "${decision.question}": ${answer.replace(/\s+/g, ' ').trim()}`, after.plan);
}

/** `ctxspace plan add` and `ctxspace plan decide`: a step or a decision, under a checkpoint or on its own. */
export async function planAdd(
  context: PlanCommandContext,
  entry: { step: string } | { decision: { question: string; suggested?: string[]; ifNoAnswer?: string; detail?: string } },
  under?: string,
): Promise<void> {
  const { plan } = await readPlanFile(context.workspacePath);
  const checkpoint = under ? findByWords(plan, under, 'checkpoint') : undefined;
  let key = '';
  const after = await changePlanFile(context.workspacePath, (text) => {
    const added = addToPlan(text, entry, checkpoint ? { checkpoint: checkpoint.key } : {});
    key = added.key;
    return added.text;
  }, { by: context.by });
  const name = 'step' in entry ? entry.step : entry.decision.question;
  const where = checkpoint && 'title' in checkpoint ? ` under "${checkpoint.title}"` : '';
  report(context, `Added ${'step' in entry ? 'the step' : 'the decision'} "${name.trim()}"${where}.`, after.plan, { key });
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
  return { workspacePath, by: planChangeBy(options, process.env, interactive), json: Boolean(options.json), print: (text) => console.log(text) };
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
    .description(`Where the plan (${PLAN_FILE}) stands, and the changes worth a command`)
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

  common(plan.command('show', { isDefault: true }).description('Where the plan stands: checkpoints, their steps and checks, and what waits for the user'))
    .action(action<PlanCommonOptions, []>((context) => planShow(context)));

  common(plan.command('done').description('Tick a step or checkpoint; a checkpoint with a check is ticked only once it passes').argument('<words...>', 'The step or checkpoint, or the start of its words'))
    .action(action<PlanCommonOptions, [string[]]>((context, _options, words) => planDone(context, words.join(' '))));

  common(plan.command('check').description('Run a checkpoint\'s check and keep the result as its proof, without ticking it').argument('[words...]', 'The checkpoint (default: the first open one with a check)'))
    .action(action<PlanCommonOptions, [string[]]>((context, _options, words) => planCheck(context, words.length ? words.join(' ') : undefined)));

  common(plan.command('answer').description('Answer a decision with what the user said').argument('<decision>', 'The decision, or the start of its words').argument('[answer...]')
    .option('-m, --message <text>', 'The answer'))
    .action(action<PlanCommonOptions & { message?: string }, [string, string[]]>((context, options, decision, words) =>
      planAnswer(context, decision, textOf(options.message, words))));

  common(plan.command('add').description('Add a step, under a checkpoint or on its own').argument('<step...>')
    .option('--under <checkpoint>', 'The checkpoint it serves'))
    .action(action<PlanCommonOptions & { under?: string }, [string[]]>((context, options, words) => planAdd(context, { step: words.join(' ') }, options.under)));

  common(plan.command('decide').description('Add a decision only the user can make, under what it holds up').argument('<question...>')
    .option('--under <checkpoint>', 'The checkpoint it holds up')
    .option('--suggest <answer>', 'An answer to suggest (repeat for more)', collect, [])
    .option('--if-no-answer <what>', 'What happens when nobody answers')
    .option('--detail <text>', 'Why it is asked'))
    .action(action<PlanCommonOptions & { under?: string; suggest: string[]; ifNoAnswer?: string; detail?: string }, [string[]]>((context, options, words) =>
      planAdd(context, { decision: { question: words.join(' '), suggested: options.suggest, ifNoAnswer: options.ifNoAnswer, detail: options.detail } }, options.under)));

  common(plan.command('log').description('What changed lately, and who changed it'))
    .action(action<PlanCommonOptions, []>((context) => planLog(context)));

  for (const verb of RETIRED) {
    common(plan.command(verb, { hidden: true }).argument('[words...]').allowUnknownOption())
      .action(action<PlanCommonOptions, [string[]]>(async () => {
        throw new PlanFileError(`"ctxspace plan ${verb}" is gone: the plan is ${PLAN_FILE} now. Edit it directly, for example rewrite or remove the step, or say why under it. Run "ctxspace plan --help" for the few commands left.`, 'invalid');
      }));
  }
}
