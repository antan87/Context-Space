import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { setActiveStorageProvider } from '../core/adapters/registry.js';
import { mutatePlan, readPlan, PlanError, type PlanActor } from '../core/plan.js';
import { saveWorkspaceState } from '../core/workspace-state.js';

const PASSED = { overallStatus: 'pass', canProgress: true, repos: [{ headSha: 'abc1234def5678' }] };
const check = vi.hoisted(() => ({ result: undefined as unknown }));
vi.mock('../core/verify.js', () => ({ verifyWorkspace: async () => check.result }));
import {
  codeList,
  confirmWithin,
  planChange,
  planCheck,
  planLog,
  planShow,
  registerPlanCommand,
  resolvePlanActor,
  type PlanCommandContext,
} from './plan.js';
import { runsInsideAiTool } from '../utils/ai-tool.js';

let root: string;
let printed: string[];
const claude: PlanActor = { by: 'agent', harness: 'claude' };

function context(over: Partial<PlanCommandContext> = {}): PlanCommandContext {
  return {
    workspacePath: root, actor: claude, interactive: false, json: false,
    confirmAsUser: async () => { throw new Error('should not ask'); },
    print: (text) => printed.push(text),
    now: new Date('2026-10-10T12:00:00.000Z'),
    ...over,
  };
}
const output = () => printed.join('\n');
/** A proposal as an AI saved it under the earlier rule, before it could close a milestone itself. */
const seedProposal = (id: string, note: string) => mutatePlan(root, (plan) => {
  plan.items.find((item) => item.id === id)!.proposal = { action: 'done', by: 'claude', note, at: '2026-10-01T00:00:00.000Z' };
});

beforeEach(async () => {
  check.result = PASSED;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-cli-'));
  setActiveStorageProvider(new LocalStorageAdapter());
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'csv', branchName: 'feat/csv', description: 'Add CSV export to reports', repos: [], assistants: [] }));
  printed = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await fs.rm(root, { recursive: true, force: true });
});

describe('who is acting', () => {
  it('is the AI, named after its tool when known', () => {
    expect(resolvePlanActor({}, {}, false)).toEqual({ by: 'agent' });
    expect(resolvePlanActor({ harness: 'Codex' }, {}, false)).toEqual({ by: 'agent', harness: 'codex' });
    expect(resolvePlanActor({}, { CTXSPACE_HARNESS: 'pi' }, false)).toEqual({ by: 'agent', harness: 'pi' });
    expect(resolvePlanActor({}, { CLAUDECODE: '1' }, false)).toEqual({ by: 'agent', harness: 'claude' });
  });

  it('is still the AI in a terminal: some AI tools run commands in one', () => {
    expect(resolvePlanActor({}, {}, true)).toEqual({ by: 'agent' });
    expect(resolvePlanActor({}, { CTXSPACE_HARNESS: 'agy' }, true)).toEqual({ by: 'agent', harness: 'agy' });
  });

  it('is the user only when a person asks for it in their own terminal', () => {
    expect(resolvePlanActor({ as: 'user' }, {}, true)).toEqual({ by: 'user' });
    expect(resolvePlanActor({}, {}, true, { userOnly: true })).toEqual({ by: 'user' });
  });

  it('will not act as the user from an AI tool or without a terminal', () => {
    expect(() => resolvePlanActor({ as: 'user' }, {}, false)).toThrow(/Only the user acts as the user/);
    expect(() => resolvePlanActor({ as: 'user' }, { ANTIGRAVITY_AGENT: '1' }, true)).toThrow(/Only the user acts as the user/);
    expect(resolvePlanActor({}, { CLAUDECODE: '1' }, true, { userOnly: true })).toEqual({ by: 'agent', harness: 'claude' });
    expect(() => resolvePlanActor({ as: 'robot' }, {}, false)).toThrow(/"user" or "agent"/);
  });

  it('knows the variables AI tools set', () => {
    expect(runsInsideAiTool({ CLAUDECODE: '1' })).toBe(true);
    expect(runsInsideAiTool({ AGY_SESSION: 'x' })).toBe(true);
    expect(runsInsideAiTool({ CODEX_SANDBOX: 'seatbelt' })).toBe(true);
    expect(runsInsideAiTool({ HOME: '/home/a', CLAUDECODE: '' })).toBe(false);
  });

  it('stops waiting for an answer nobody gives, and counts it as no', async () => {
    const ask = (_config: unknown, context: { signal: AbortSignal }) => new Promise<boolean>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortPromptError' })));
    });
    await expect(confirmWithin('Do it?', 20, ask)).resolves.toBe(false);
    await expect(confirmWithin('Do it?', 20, async () => true)).resolves.toBe(true);
  });
});

describe('changing the plan from an AI tool', () => {
  it('adds, starts and finishes its own work, and says what happened by label', async () => {
    await planChange(context(), { type: 'add', kind: 'task', title: 'Background job queue' });
    await planChange(context(), { type: 'start', id: 'T1' });
    await planChange(context(), { type: 'done', id: 'T1', resolution: 'Runs in the background' });
    expect(printed[0]).toBe('Added T1 Background job queue.\nPlan: Needs you 0 · In progress 0 · To do 1 · Done 0. Run "ctxspace plan" to see it.');
    expect(printed[2]).toContain('Done: T1 Background job queue.');
    expect((await readPlan(root)).items[0]!.history.map((entry) => entry.by)).toEqual(['claude', 'claude', 'claude']);
  });

  it('finishes a milestone itself, and the history names it', async () => {
    await planChange(context(), { type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    await planChange(context(), { type: 'start', id: 'M1' });
    await planChange(context(), { type: 'done', id: 'M1', resolution: 'Tests pass' });
    expect(printed[2]).toBe('Done: M1 CSV export endpoint.\nPlan: Needs you 0 · In progress 0 · To do 0 · Done 1. Run "ctxspace plan" to see it.');
    const [item] = (await readPlan(root)).items;
    expect(item).toMatchObject({ status: 'done', resolution: 'Tests pass' });
    expect(item!.history.at(-1)).toMatchObject({ by: 'claude', action: 'done' });
  });

  it('runs a milestone\'s check before finishing it, and leaves it open when the check fails', async () => {
    await planChange(context(), { type: 'add', kind: 'milestone', title: 'CSV export endpoint', gate: { required: true, command: 'npm test' } });
    await planChange(context(), { type: 'start', id: 'M1' });
    check.result = { overallStatus: 'fail', canProgress: false, repos: [{ headSha: 'abc1234def5678' }] };
    await expect(planChange(context(), { type: 'done', id: 'M1', resolution: 'Tests pass' })).rejects.toThrow(/did not permit progress/);
    expect((await readPlan(root)).items[0]!.status).toBe('in_progress');

    check.result = PASSED;
    await planChange(context(), { type: 'done', id: 'M1', resolution: 'Tests pass' });
    expect(printed.at(-1)).toContain('Done: M1 CSV export endpoint. Its check passed.');
    const [item] = (await readPlan(root)).items;
    expect(item).toMatchObject({ status: 'done' });
    expect(item!.resolution).toMatch(/^Tests pass\. Passed its check on /);
    expect(item!.history.at(-1)).toMatchObject({ by: 'claude', action: 'done' });
  });

  it('refuses to accept a proposal: that is the user\'s', async () => {
    await planChange(context(), { type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    await seedProposal('M1', 'Tests pass');
    await expect(planChange(context(), { type: 'accept', id: 'M1' })).rejects.toThrow(/Only the user can accept/);
  });

  it('shows how to type it when a reason is missing', async () => {
    await planChange(context(), { type: 'add', kind: 'task', title: 'Work' });
    const error = await planChange(context(), { type: 'done', id: 'T1', resolution: '' }).catch((e) => e);
    expect(error).toBeInstanceOf(PlanError);
    expect(error.message).toBe('Closing needs a reason: say what came out of T1 Work.\nUse: ctxspace plan done <code> --resolution "what came out of it"');
  });

  it('answers in JSON with the item, its label, the outcome and the counts', async () => {
    await planChange(context({ json: true }), { type: 'add', kind: 'question', title: 'Which time zone?', owner: 'user' });
    const result = JSON.parse(printed[0]!);
    expect(result).toMatchObject({ ok: true, outcome: 'applied', revision: 1, item: { id: 'Q1', label: 'Q1 Which time zone?', status: 'todo' }, counts: { needsYou: 1 } });
  });
});

describe('changing the plan from an interactive terminal', () => {
  const user = (answer: boolean) => {
    const asked: string[] = [];
    return { asked, context: context({ actor: { by: 'user' }, interactive: true, confirmAsUser: async (question) => { asked.push(question); return answer; } }) };
  };

  it('asks before deciding a proposal as the user, and does nothing when declined', async () => {
    await planChange(context(), { type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    await seedProposal('M1', 'Shipped');
    const declined = user(false);
    await planChange(declined.context, { type: 'accept', id: 'M1' });
    expect(declined.asked).toEqual(["M1 CSV export endpoint: this is the user's decision. Do it as the user?"]);
    expect(printed.at(-1)).toBe('Nothing changed.');
    expect((await readPlan(root)).items[0]!.status).toBe('todo');
    const accepted = user(true);
    await planChange(accepted.context, { type: 'accept', id: 'M1' });
    expect((await readPlan(root)).items[0]).toMatchObject({ status: 'done', resolution: 'Shipped' });
  });

  it('does not ask for everyday changes, finishing a milestone included', async () => {
    const { asked, context: ctx } = user(false);
    await planChange(ctx, { type: 'add', kind: 'task', title: 'Write docs' });
    await planChange(ctx, { type: 'start', id: 'T1' });
    await planChange(ctx, { type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    await planChange(ctx, { type: 'done', id: 'M1', resolution: 'Shipped' });
    expect(asked).toEqual([]);
    expect((await readPlan(root)).items.map((item) => item.status)).toEqual(['in_progress', 'done']);
  });

  it('lets the user accept or send back a proposal', async () => {
    await planChange(context(), { type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    await seedProposal('M1', 'Tests pass');
    const { context: ctx } = user(true);
    await planChange(ctx, { type: 'reject', id: 'M1', reason: 'Also cap at 50,000 rows' });
    expect(printed.at(-1)).toContain('Sent back to claude: M1 CSV export endpoint. Also cap at 50,000 rows');
    await seedProposal('M1', 'Capped too');
    await planChange(ctx, { type: 'accept', id: 'M1' });
    expect((await readPlan(root)).items[0]).toMatchObject({ status: 'done', resolution: 'Capped too' });
  });
});

describe('reading the plan', () => {
  it('shows the goal and the sections, and the same in JSON', async () => {
    await planChange(context(), { type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    await planShow(context());
    expect(printed.at(-1)).toContain('GOAL        Add CSV export to reports');
    expect(printed.at(-1)).toContain('MILESTONES  in order\n  ○   M1 CSV export endpoint · to do · ready to start');
    await planShow(context({ json: true }));
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({ revision: 1, goal: { objective: 'Add CSV export to reports' }, milestones: [{ label: 'M1 CSV export endpoint' }] });
  });

  it('includes milestones saved by an older release', async () => {
    await saveWorkspaceState({ workspacePath: root, repos: {}, updatedAt: '', lifecycle: {
      workspaceId: 'csv', flowType: 'feature', updatedAt: '', revision: 2,
      steps: [{ id: 'query', title: 'Database query', status: 'in_progress' }],
    } });
    await planShow(context());
    expect(output()).toContain('◐   query Database query · in progress');
  });

  it('shows one item\'s history, or the latest changes', async () => {
    await planChange(context(), { type: 'add', kind: 'task', title: 'Work' });
    await planChange(context(), { type: 'block', id: 'T1', reason: 'No access' });
    printed = [];
    await planLog(context(), 'T1');
    expect(output()).toContain('T1 Work · Task · blocked: No access');
    expect(output()).toContain('Claude       blocked: No access');
    printed = [];
    await planLog(context());
    expect(output().split('\n')[0]).toBe('WHAT CHANGED');
    await expect(planLog(context(), 'T9')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('checks the plan and says when nothing is wrong', async () => {
    await planCheck(context());
    expect(printed.at(-1)).toBe('No problems found.');
    await planChange(context(), { type: 'add', kind: 'task', title: 'Parked' });
    await planChange(context(), { type: 'add', kind: 'milestone', title: 'Needs it', after: ['T1'] });
    await planChange(context(), { type: 'later', id: 'T1', revisitWhen: 'next quarter' });
    await planCheck(context());
    expect(printed.at(-1)).toContain('PROBLEMS\n  M1 Needs it waits for T1 Parked, which is set for later.');
  });
});

describe('the command line', () => {
  async function cli(...args: string[]) {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((text?: unknown) => { lines.push(String(text)); });
    const failures: string[] = [];
    const program = new Command().exitOverride();
    registerPlanCommand(program, (error) => { failures.push(error instanceof Error ? error.message : String(error)); });
    await program.parseAsync(['node', 'ctxspace', 'plan', ...args]);
    vi.mocked(console.log).mockRestore();
    return { lines, failures };
  }

  it('takes the workspace before or after the verb, and joins unquoted words', async () => {
    await cli('-w', root, 'add', 'milestone', 'CSV', 'export', 'endpoint');
    await cli('add', 'task', 'Background job queue', '--before', 'M1', '-w', root, '--harness', 'codex');
    const plan = await readPlan(root);
    expect(plan.items.map((item) => item.title)).toEqual(['CSV export endpoint', 'Background job queue']);
    expect(plan.items[0]!.waitsFor).toEqual(['T1']);
    expect(plan.items[1]!.history[0]!.by).toBe('codex');
  });

  it('takes a reason as words, --reason or -m', async () => {
    await cli('-w', root, 'add', 'task', 'One');
    await cli('-w', root, 'add', 'task', 'Two');
    await cli('-w', root, 'add', 'task', 'Three');
    await cli('-w', root, 'block', 'T1', 'No', 'access');
    await cli('-w', root, 'drop', 'T2', '--reason', 'Not needed');
    await cli('-w', root, 'later', 'T3', '-m', 'Next quarter');
    const items = (await readPlan(root)).items;
    expect(items.map((item) => [item.status, item.blockedReason ?? item.resolution ?? item.revisitWhen])).toEqual([
      ['blocked', 'No access'], ['dropped', 'Not needed'], ['later', 'Next quarter'],
    ]);
  });

  it('shows the plan when no verb is given', async () => {
    await cli('-w', root, 'add', 'milestone', 'CSV export endpoint');
    const { lines } = await cli('-w', root);
    expect(lines.join('\n')).toContain('M1 CSV export endpoint · to do · ready to start');
  });

  it('prints errors as JSON with --json, and fails', async () => {
    const { lines, failures } = await cli('-w', root, 'start', 'M9', '--json');
    expect(failures).toEqual([]);
    expect(JSON.parse(lines[0]!)).toEqual({ ok: false, error: 'There is no item "M9" in the plan. Read the plan to see the codes.', code: 'not_found' });
    expect(process.exitCode).toBe(1);
  });

  it('reports errors the usual way without --json', async () => {
    const { failures } = await cli('-w', root, 'add', 'thing', 'Whatever');
    expect(failures[0]).toMatch(/^"thing" is not a kind of item\. Use one of: milestone, task, question, decision, existing\./);
  });

  it('says where to run it when there is no workspace', async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-cli-none-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(elsewhere);
    const { failures } = await cli('show');
    cwd.mockRestore();
    await fs.rm(elsewhere, { recursive: true, force: true });
    expect(failures[0]).toContain('Run this inside a workspace folder, or pass --workspace <path>.');
  });

  it('lists the rules in its help', () => {
    const program = new Command();
    registerPlanCommand(program, () => undefined);
    const plan = program.commands.find((command) => command.name() === 'plan')!;
    let help = '';
    plan.configureOutput({ writeOut: (text) => { help += text; } });
    plan.outputHelp();
    expect(help).toContain('1. Every close has a reason. Nothing is deleted.');
    expect(help).toContain('Who acts: every change is made as the AI');
    expect(help).toContain('ctxspace plan add task "Rate limit for logins" --before M2   M2 then waits for the new task');
    expect(help).not.toContain('--harness');
    expect(help).not.toMatch(/^\s+--as <who>/m);
    expect(help).toContain('accept');
  });
});

describe('codeList', () => {
  it('splits commas and joins repeats', () => {
    expect(codeList('M1, M2', ['T1'])).toEqual(['T1', 'M1', 'M2']);
  });
});
