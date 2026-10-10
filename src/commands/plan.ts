/**
 * @module commands/plan
 * `ctxspace plan` — read and change the workspace plan one item at a time. It works in every AI tool
 * without setup: the AI runs these commands in its shell, and the person sees the same plan in the
 * Plan tab.
 *
 * Who is acting: always the AI, so a close that is the user's becomes a proposal they accept in the
 * Plan tab. Some AI tools run commands in a terminal, so a terminal alone does not mean a person is
 * typing. A person acts as the user with `--as user` (and `accept`/`reject`) in their own terminal,
 * after confirming; a prompt that nobody answers gives up instead of waiting. This guides
 * behaviour; it is not a security boundary.
 */

import { Command, Option } from 'commander';
import { confirm } from '@inquirer/prompts';
import { resolveWorkspaceQuiet } from '../utils/resolve-workspace.js';
import { runsInsideAiTool } from '../utils/ai-tool.js';
import { loadFeatureConfig } from '../core/workspace.js';
import { loadWorkGuidance } from '../core/work-guidance.js';
import { ensurePlanStore } from '../core/lifecycle.js';
import { PLAN_KINDS, itemLabel, type PlanKind } from '../core/plan-words.js';
import {
  PlanError,
  agentMayClose,
  changePlan,
  planSections,
  readPlan,
  type PlanActor,
  type PlanChange,
  type PlanDocument,
} from '../core/plan.js';
import {
  checkPlan,
  itemToJson,
  planToJson,
  renderChanges,
  renderHistory,
  renderPlanRules,
  renderPlanText,
  type PlanGoal,
} from '../core/plan-text.js';

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
  actor: PlanActor;
  interactive: boolean;
  json: boolean;
  /** Asks the person at the terminal; only called when `interactive`. */
  confirmAsUser: (question: string) => Promise<boolean>;
  print: (text: string) => void;
  now?: Date;
}

/** Who a change is made as, stated in the help. */
export const WHO_ACTS = [
  'Who acts: every change is made as the AI and recorded with its name. When a close is the user\'s',
  '(a milestone, or an item the user owns), it becomes a proposal: the user accepts it in the Plan tab.',
  'That is the end of the AI\'s part, even when the user told you the answer: say it waits for them.',
  'The user can act as themselves with --as user in their own terminal.',
].join('\n');

/** How each change is typed, shown when it is typed wrongly. */
export const PLAN_USAGE: Record<string, string> = {
  add: 'ctxspace plan add <milestone|task|question|decision|existing> "<name>" [--after M1] [--before M2] [--owner user|agent]',
  start: 'ctxspace plan start <code>',
  done: 'ctxspace plan done <code> --resolution "what came out of it"',
  answer: 'ctxspace plan answer <code> "the answer"',
  drop: 'ctxspace plan drop <code> --reason "why it is not needed"',
  later: 'ctxspace plan later <code> --until "when to look again"',
  block: 'ctxspace plan block <code> --reason "what it is stuck on"',
  reopen: 'ctxspace plan reopen <code> --reason "what is wrong"',
  edit: 'ctxspace plan edit <code> [--title "…"] [--detail "…"] [--owner …] [--after M1] [--not-after M1] [--before M2]',
  accept: 'ctxspace plan accept <code>',
  reject: 'ctxspace plan reject <code> --reason "what still needs doing"',
};

/** How long a question to the person at the terminal waits before giving up. */
export const CONFIRM_TIMEOUT_MS = 30_000;

/**
 * Who makes the change: the AI, named after its tool when known (`--harness`, CTXSPACE_HARNESS, or
 * Claude Code's own CLAUDECODE variable). The user only when they ask for it (`--as user`, or a
 * verb only the user can use) in their own terminal, with no AI tool around.
 */
export function resolvePlanActor(
  options: { as?: string; harness?: string },
  env: NodeJS.ProcessEnv,
  interactive: boolean,
  verb: { userOnly?: boolean } = {},
): PlanActor {
  if (options.as !== undefined && options.as !== 'user' && options.as !== 'agent') {
    throw new PlanError(`--as takes "user" or "agent", not "${options.as}".`, 'invalid');
  }
  const harness = (options.harness ?? env.CTXSPACE_HARNESS ?? (env.CLAUDECODE ? 'claude' : undefined))?.trim().toLowerCase() || undefined;
  const agent: PlanActor = harness ? { by: 'agent', harness } : { by: 'agent' };
  if (options.as === 'agent') return agent;
  const wantsUser = options.as === 'user' || Boolean(verb.userOnly);
  if (wantsUser && interactive && !runsInsideAiTool(env)) return { by: 'user' };
  if (options.as === 'user') {
    throw new PlanError("Only the user acts as the user, from their own terminal or the Plan tab. Make the change as the AI: when the item is the user's, it becomes a proposal they accept.", 'not_allowed');
  }
  return agent;
}

async function planGoal(workspacePath: string): Promise<PlanGoal | undefined> {
  try {
    const guidance = await loadWorkGuidance(workspacePath);
    const objective = guidance.assignment.objective || (await loadFeatureConfig(workspacePath))?.description || '';
    return objective ? { objective, stage: guidance.assignment.stage, stopCondition: guidance.assignment.stopCondition || undefined } : undefined;
  } catch {
    return undefined;
  }
}

function countsLine(plan: PlanDocument): string {
  const { counts } = planSections(plan);
  return `Plan: Needs you ${counts.needsYou} · In progress ${counts.inProgress} · To do ${counts.todo} · Done ${counts.done}. Run "ctxspace plan" to see it.`;
}

/** `ctxspace plan` and `ctxspace plan show`. */
export async function planShow(context: PlanCommandContext, options: { all?: boolean } = {}): Promise<void> {
  const plan = await ensurePlanStore(context.workspacePath);
  const goal = await planGoal(context.workspacePath);
  context.print(context.json
    ? JSON.stringify(planToJson(plan, { goal, all: options.all }), null, 2)
    : renderPlanText(plan, { goal, all: options.all, now: context.now }));
}

/** `ctxspace plan log [code]`: one item's history, or the latest changes across the plan. */
export async function planLog(context: PlanCommandContext, id?: string): Promise<void> {
  const plan = await ensurePlanStore(context.workspacePath);
  if (id) {
    const item = plan.items.find((candidate) => candidate.id === id);
    if (!item) throw new PlanError(`There is no item "${id}" in the plan. Read the plan to see the codes.`, 'not_found');
    context.print(context.json ? JSON.stringify({ item: itemToJson(plan, item), history: item.history }, null, 2) : renderHistory(plan, item, context.now));
    return;
  }
  const { changes } = planSections(plan, { changes: 20 });
  context.print(context.json ? JSON.stringify({ changes }, null, 2) : renderChanges(changes, context.now));
}

/** `ctxspace plan check`: waits that can never clear, proposals waiting, work that sits still. */
export async function planCheck(context: PlanCommandContext): Promise<void> {
  const plan = await ensurePlanStore(context.workspacePath);
  const findings = checkPlan(plan, context.now);
  if (context.json) {
    context.print(JSON.stringify({ findings }, null, 2));
    return;
  }
  if (!findings.length) {
    context.print('No problems found.');
    return;
  }
  const problems = findings.filter((finding) => finding.level === 'problem');
  const notes = findings.filter((finding) => finding.level === 'note');
  const lines: string[] = [];
  if (problems.length) lines.push('PROBLEMS', ...problems.map((finding) => `  ${finding.message}`), '');
  if (notes.length) lines.push('WORTH KNOWING', ...notes.map((finding) => `  ${finding.message}`));
  context.print(lines.join('\n').trimEnd());
}

const CLOSING = new Set<PlanChange['type']>(['done', 'answer', 'drop', 'later', 'reopen']);

/**
 * Applies one change and prints what happened, naming the item by its label. A person at an
 * interactive terminal is asked before making a decision that belongs to the user.
 */
export async function planChange(context: PlanCommandContext, change: PlanChange): Promise<void> {
  await ensurePlanStore(context.workspacePath);
  if (context.interactive && context.actor.by === 'user' && change.type !== 'add') {
    const plan = await readPlan(context.workspacePath);
    const item = plan.items.find((candidate) => candidate.id === change.id);
    const usersCall = change.type === 'accept' || change.type === 'reject'
      || (item !== undefined && CLOSING.has(change.type) && !agentMayClose(item, { by: 'agent' }));
    if (item && usersCall) {
      const ok = await context.confirmAsUser(`${itemLabel(item)}: this is the user's decision. Do it as the user?`);
      if (!ok) {
        context.print('Nothing changed.');
        return;
      }
    }
  }
  try {
    const result = await changePlan(context.workspacePath, change, { actor: context.actor });
    if (context.json) {
      context.print(JSON.stringify({
        ok: true, outcome: result.outcome, message: result.message, item: itemToJson(result.plan, result.item),
        revision: result.plan.revision, counts: planSections(result.plan).counts,
      }, null, 2));
    } else {
      context.print(`${result.message}\n${countsLine(result.plan)}`);
    }
  } catch (error) {
    if (error instanceof PlanError && error.code === 'invalid' && PLAN_USAGE[change.type]) {
      throw new PlanError(`${error.message}\nUse: ${PLAN_USAGE[change.type]}`, 'invalid');
    }
    throw error;
  }
}

/** Codes given as "M1,M2", repeated options, or both. */
export function codeList(value: string, previous: string[] = []): string[] {
  return [...previous, ...value.split(',').map((part) => part.trim()).filter(Boolean)];
}

function textOf(...candidates: Array<string | string[] | undefined>): string {
  for (const candidate of candidates) {
    const text = Array.isArray(candidate) ? candidate.join(' ') : candidate;
    if (text?.trim()) return text;
  }
  return '';
}

/**
 * Asks the person at the terminal, and gives up after `ms` when nobody answers: some AI tools run
 * commands in a terminal, and a question they cannot see must not hold them up.
 */
export async function confirmWithin(
  question: string,
  ms = CONFIRM_TIMEOUT_MS,
  ask: (config: { message: string; default: boolean }, context: { signal: AbortSignal }) => Promise<boolean> = confirm,
): Promise<boolean> {
  try {
    return await ask({ message: `${question} (no answer in ${Math.round(ms / 1000)} s means no)`, default: false }, { signal: AbortSignal.timeout(ms) });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortPromptError') return false;
    throw error;
  }
}

async function contextFor(options: PlanCommonOptions, verb: { userOnly?: boolean } = {}): Promise<PlanCommandContext> {
  const workspacePath = await resolveWorkspaceQuiet(options.workspace);
  if (!workspacePath) {
    throw new PlanError('No workspace here. Run this inside a workspace folder, or pass --workspace <path>.', 'not_found');
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    workspacePath,
    actor: resolvePlanActor(options, process.env, interactive, verb),
    interactive,
    json: Boolean(options.json),
    confirmAsUser: (question) => confirmWithin(question),
    print: (text) => console.log(text),
  };
}

/** Runs a plan command; with --json an error is printed as JSON too, so an AI can read it. */
function run<A extends unknown[]>(action: (...args: A) => Promise<void>, onError: (error: unknown) => Promise<void>) {
  return async (...args: A) => {
    try {
      await action(...args);
    } catch (error) {
      await onError(error);
    }
  };
}

/**
 * Adds `ctxspace plan` and its verbs to the CLI. `fail` reports an error the way every other
 * command does; with --json the error is printed as JSON and the exit code is still 1.
 */
export function registerPlanCommand(program: Command, fail: (error: unknown) => Promise<void> | void): void {
  // --as and --harness stay out of the option list: ContextSpace names the AI tool itself, and an AI
  // reading the help should not go looking for a way to act as the user. WHO_ACTS tells people about --as.
  const common = (command: Command) => command
    .option('-w, --workspace <path>', 'Workspace path or name (defaults to the workspace you are in)')
    .option('--json', 'Print JSON instead of text')
    .addOption(new Option('--as <who>', 'Act as "user" (a person in their own terminal) or "agent"').hideHelp())
    .addOption(new Option('--harness <name>', 'Name of the AI tool making the change, for the history').hideHelp());

  // The shared options work before the verb (`plan --json show`) and after it (`plan show --json`).
  const plan = common(program
    .command('plan')
    .description('Read and change the workspace plan, one item at a time')
    .addHelpText('after', `\n${renderPlanRules()}\n\n${WHO_ACTS}\n`));

  const onError = (json?: boolean) => async (error: unknown) => {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), code: error instanceof PlanError ? error.code : undefined }, null, 2));
      process.exitCode = 1;
      return;
    }
    await fail(error);
  };

  const action = <O extends PlanCommonOptions, A extends unknown[]>(
    handler: (context: PlanCommandContext, options: O, ...args: A) => Promise<void>,
    verb: { userOnly?: boolean } = {},
  ) =>
    async (...args: [...A, O, Command]) => {
      const options = (args[args.length - 1] as Command).optsWithGlobals<O>();
      const positional = args.slice(0, -2) as unknown as A;
      await run(async () => handler(await contextFor(options, verb), options, ...positional), onError(options.json))();
    };

  common(plan.command('show', { isDefault: true }).description('Show the plan: Goal, Needs you, Milestones, Other open work, Done and dropped, What changed')
    .option('--all', 'Also list every done and dropped item'))
    .action(action<PlanCommonOptions & { all?: boolean }, []>((context, options) => planShow(context, options)));

  common(plan.command('add').description('Add a milestone, task, question, decision or existing work')
    .argument('<kind>', `One of: ${PLAN_KINDS.join(', ')}`)
    .argument('<name...>', 'What it is')
    .option('--after <codes>', 'It waits for these (comma-separated)', codeList, [])
    .option('--before <codes>', 'These wait for it (comma-separated)', codeList, [])
    .option('--owner <owner>', 'user, agent, or a name (defaults to whoever adds it)')
    .option('--detail <text>', 'More about it: for a milestone, what it must deliver')
    .option('--id <code>', 'Its code, if not the next one (M3, T2, …)')
    .option('--check <command>', 'For a milestone: the check that must pass before it is done'))
    .action(action<PlanCommonOptions & { after: string[]; before: string[]; owner?: string; detail?: string; id?: string; check?: string }, [string, string[]]>(
      (context, options, kind, name) => {
        if (!PLAN_KINDS.includes(kind as PlanKind)) {
          throw new PlanError(`"${kind}" is not a kind of item. Use one of: ${PLAN_KINDS.join(', ')}.\nUse: ${PLAN_USAGE.add}`, 'invalid');
        }
        return planChange(context, {
          type: 'add', kind: kind as PlanKind, title: name.join(' '), after: options.after, before: options.before,
          ...(options.owner ? { owner: options.owner } : {}), ...(options.detail ? { detail: options.detail } : {}),
          ...(options.id ? { id: options.id } : {}),
          ...(options.check ? { gate: { required: true, command: options.check } } : {}),
        });
      }));

  common(plan.command('start').description('Start an item: everything it waits for must be done').argument('<code>'))
    .action(action<PlanCommonOptions, [string]>((context, _options, id) => planChange(context, { type: 'start', id })));

  common(plan.command('done').description('Close an item with what came out of it (a milestone or the user\'s item becomes a proposal from an AI)')
    .argument('<code>').argument('[resolution...]')
    .option('--resolution <text>', 'What came out of it').option('-m, --message <text>', 'Same as --resolution'))
    .action(action<PlanCommonOptions & { resolution?: string; message?: string }, [string, string[]]>((context, options, id, words) =>
      planChange(context, { type: 'done', id, resolution: textOf(options.resolution, options.message, words) })));

  common(plan.command('answer').description('Answer a question (from an AI, the user\'s question gets a proposed answer they accept)').argument('<code>').argument('[answer...]')
    .option('-m, --message <text>', 'The answer'))
    .action(action<PlanCommonOptions & { message?: string }, [string, string[]]>((context, options, id, words) =>
      planChange(context, { type: 'answer', id, answer: textOf(options.message, words) })));

  common(plan.command('drop').description('Drop an item that is not needed, with why (from an AI, a milestone or the user\'s item becomes a proposal)').argument('<code>').argument('[reason...]')
    .option('--reason <text>', 'Why it is not needed').option('-m, --message <text>', 'Same as --reason'))
    .action(action<PlanCommonOptions & { reason?: string; message?: string }, [string, string[]]>((context, options, id, words) =>
      planChange(context, { type: 'drop', id, reason: textOf(options.reason, options.message, words) })));

  common(plan.command('later').description('Move an item to later, with when to look again (from an AI, a milestone or the user\'s item becomes a proposal)').argument('<code>').argument('[when...]')
    .option('--until <text>', 'When to look at it again').option('-m, --message <text>', 'Same as --until'))
    .action(action<PlanCommonOptions & { until?: string; message?: string }, [string, string[]]>((context, options, id, words) =>
      planChange(context, { type: 'later', id, revisitWhen: textOf(options.until, options.message, words) })));

  common(plan.command('block').description('Mark an item blocked, with what it is stuck on').argument('<code>').argument('[reason...]')
    .option('--reason <text>', 'What it is stuck on').option('-m, --message <text>', 'Same as --reason'))
    .action(action<PlanCommonOptions & { reason?: string; message?: string }, [string, string[]]>((context, options, id, words) =>
      planChange(context, { type: 'block', id, reason: textOf(options.reason, options.message, words) })));

  common(plan.command('reopen').description('Reopen finished, dropped or later work, with what is wrong (from an AI, a milestone or the user\'s item becomes a proposal)').argument('<code>').argument('[reason...]')
    .option('--reason <text>', 'What is wrong').option('-m, --message <text>', 'Same as --reason'))
    .action(action<PlanCommonOptions & { reason?: string; message?: string }, [string, string[]]>((context, options, id, words) =>
      planChange(context, { type: 'reopen', id, reason: textOf(options.reason, options.message, words) })));

  common(plan.command('edit').description('Rename an item or change its detail, owner, or what it waits for').argument('<code>')
    .option('--title <name>', 'New name').option('--detail <text>', 'New detail').option('--owner <owner>', 'New owner')
    .option('--after <codes>', 'Now also waits for these', codeList, [])
    .option('--not-after <codes>', 'No longer waits for these', codeList, [])
    .option('--before <codes>', 'These now wait for it', codeList, []))
    .action(action<PlanCommonOptions & { title?: string; detail?: string; owner?: string; after: string[]; notAfter: string[]; before: string[] }, [string]>(
      (context, options, id) => planChange(context, {
        type: 'edit', id, after: options.after, notAfter: options.notAfter, before: options.before,
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.detail !== undefined ? { detail: options.detail } : {}),
        ...(options.owner !== undefined ? { owner: options.owner } : {}),
      })));

  common(plan.command('accept').description('Accept what an AI proposed (the user only: an AI tells the user it waits for them)').argument('<code>'))
    .action(action<PlanCommonOptions, [string]>((context, _options, id) => planChange(context, { type: 'accept', id }), { userOnly: true }));

  common(plan.command('reject').description('Send a proposal back, with what still needs doing (the user only: an AI tells the user it waits for them)').argument('<code>').argument('[reason...]')
    .option('--reason <text>', 'What still needs doing').option('-m, --message <text>', 'Same as --reason'))
    .action(action<PlanCommonOptions & { reason?: string; message?: string }, [string, string[]]>((context, options, id, words) =>
      planChange(context, { type: 'reject', id, reason: textOf(options.reason, options.message, words) }), { userOnly: true }));

  common(plan.command('log').description('Show the history of one item, or the latest changes').argument('[code]'))
    .action(action<PlanCommonOptions, [string | undefined]>((context, _options, id) => planLog(context, id)));

  common(plan.command('check').description('Find waits that can never clear, proposals waiting, and work that sits still'))
    .action(action<PlanCommonOptions, []>((context) => planCheck(context)));
}
