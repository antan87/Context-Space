import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { setActiveStorageProvider } from '../core/adapters/registry.js';
import { changePlan } from '../core/plan.js';
import { parsePlanFile } from '../core/plan-file.js';
import { readPlanChanges } from '../core/plan-file-store.js';

const PASSED = { overallStatus: 'pass', canProgress: true, repos: [{ headSha: 'abc1234def5678' }] };
const FAILED = { overallStatus: 'fail', canProgress: false, repos: [{ headSha: 'abc1234def5678' }] };
const check = vi.hoisted(() => ({ result: undefined as unknown }));
vi.mock('../core/verify.js', () => ({ verifyWorkspace: async () => check.result }));
import { findByWords, planAdd, planAnswer, planChangeBy, planCheck, planDone, planLog, planShow, registerPlanCommand, type PlanCommandContext } from './plan.js';

let root: string;
let printed: string[];

const PLAN = `# CSV export

Customers export their reports.

## Checkpoints

- [x] Report rows load fast
  - [x] Query the report rows
- [ ] Reports export to CSV
  Check: \`npm test\`
  - [x] Write the CSV writer
  - [ ] Add the Export button
  - [ ] Decide: Should archived reports be exported?
    Suggested: Yes, all of them · Only the last year
    If no answer: only the last year

## Steps

- [ ] Tidy the old export script
`;

function context(over: Partial<PlanCommandContext> = {}): PlanCommandContext {
  return { workspacePath: root, by: 'claude', json: false, print: (text) => printed.push(text), now: new Date('2026-10-10T12:00:00.000Z'), ...over };
}
const output = () => printed.join('\n');
const planNow = async () => parsePlanFile(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'));

beforeEach(async () => {
  check.result = PASSED;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plan-cli-')));
  setActiveStorageProvider(new LocalStorageAdapter());
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'csv', name: 'CSV export', branchName: 'feat/csv', description: 'Add CSV export to reports', repos: [], assistants: [] }));
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN);
  printed = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await fs.rm(root, { recursive: true, force: true });
});

describe('who the log names', () => {
  it('is the AI tool when known, the user at their own terminal, else the AI', () => {
    expect(planChangeBy({}, { CTXSPACE_HARNESS: 'Codex' }, false)).toBe('codex');
    expect(planChangeBy({}, { CLAUDECODE: '1' }, true)).toBe('claude');
    expect(planChangeBy({ harness: 'gemini' }, {}, false)).toBe('gemini');
    expect(planChangeBy({}, {}, true)).toBe('user');
    expect(planChangeBy({}, {}, false)).toBe('ai');
    expect(planChangeBy({ as: 'user' }, { CLAUDECODE: '1' }, true)).toBe('claude');
  });
});

describe('reading the plan', () => {
  it('says where it stands: checkpoints with their steps and proof, the next step, and what waits for the user', async () => {
    await planShow(context());
    expect(output()).toBe([
      'CSV export · PLAN.md',
      '',
      'CHECKPOINTS',
      '  ✓ Report rows load fast',
      '  ◐ Reports export to CSV  1 of 2 steps · not checked yet',
      '      next: Add the Export button',
      '',
      'WAITING FOR THE USER',
      '  Should archived reports be exported?  (holds up: Reports export to CSV)',
      '    Suggested: Yes, all of them · Only the last year',
      '    If no answer: only the last year',
      '',
      'OTHER STEPS  1 open',
      '  ○ Tidy the old export script',
    ].join('\n'));
  });

  it('gives the same in JSON', async () => {
    await planShow(context({ json: true }));
    const json = JSON.parse(output());
    expect(json).toMatchObject({ file: 'PLAN.md', source: 'file', title: 'CSV export', waitingForTheUser: ['Should archived reports be exported?'] });
    expect(json.checkpoints[1]).toMatchObject({ title: 'Reports export to CSV', done: false, check: 'npm test', steps: [{ text: 'Write the CSV writer', done: true }, { text: 'Add the Export button', done: false }] });
  });

  it('shows an older plan as the PLAN.md it will become, and says how to start one without', async () => {
    await fs.rm(path.join(root, 'PLAN.md'));
    await planShow(context());
    expect(output()).toContain('No plan yet. Write PLAN.md');
    printed = [];
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'CSV export endpoint' }, { actor: { by: 'user' } });
    await planShow(context());
    expect(output()).toContain('CSV export · PLAN.md (written from the older plan on the first change)');
    expect(output()).toContain('○ CSV export endpoint');
  });

  it('finds an item by its words, or the start of them, and names the matches when several fit', async () => {
    const plan = await planNow();
    expect(findByWords(plan, 'add the export')).toMatchObject({ text: 'Add the Export button' });
    expect(findByWords(plan, 'Reports export to CSV', 'checkpoint')).toMatchObject({ title: 'Reports export to CSV' });
    expect(() => findByWords(plan, 'Re')).toThrow(/matches 2 items: "Report rows load fast", "Reports export to CSV"/);
    expect(() => findByWords(plan, 'nothing like it')).toThrow(/No item in PLAN.md matches/);
  });
});

describe('changing the plan', () => {
  it('ticks a step, and logs who did', async () => {
    await planDone(context(), 'Add the Export button');
    expect((await planNow()).checkpoints[1]!.steps[1]!.done).toBe(true);
    expect(output()).toBe('Ticked "Add the Export button".\nPlan: 1 of 2 checkpoints done · 1 waiting for the user. Run "ctxspace plan" to see it.');
    expect((await readPlanChanges(root))[0]).toMatchObject({ by: 'claude', action: 'ticked', text: 'Add the Export button' });
  });

  it('runs a checkpoint\'s check before ticking it, and leaves it open when the check fails', async () => {
    check.result = FAILED;
    await expect(planDone(context(), 'Reports export to CSV')).rejects.toThrow('"Reports export to CSV" stays open: its check failed on abc1234 · now. Fix what fails and run it again.');
    expect((await planNow()).checkpoints[1]!.done).toBe(false);
    check.result = PASSED;
    await planDone(context(), 'Reports export to CSV');
    expect((await planNow()).checkpoints[1]!.done).toBe(true);
  });

  it('runs a check without ticking, and fails the command when it fails', async () => {
    check.result = FAILED;
    await planCheck(context());
    expect(output()).toBe('"Reports export to CSV": check failed on abc1234 · now.');
    expect(process.exitCode).toBe(1);
    expect((await planNow()).checkpoints[1]!.done).toBe(false);
  });

  it('answers a decision, and will not tick one as done', async () => {
    await expect(planDone(context(), 'Should archived')).rejects.toThrow(/is a decision: answer it with ctxspace plan answer/);
    await planAnswer(context({ by: 'user' }), 'Should archived', 'Yes, all of them');
    expect((await planNow()).checkpoints[1]!.decisions[0]).toMatchObject({ done: true, answer: 'Yes, all of them' });
    expect(output()).toContain('Answered "Should archived reports be exported?": Yes, all of them');
  });

  it('adds a step or a decision under a checkpoint, or on its own', async () => {
    await planAdd(context(), { step: 'Show a progress bar' }, 'Reports export');
    await planAdd(context(), { decision: { question: 'Which delimiter?', suggested: ['Comma', 'Semicolon'], ifNoAnswer: 'comma' } });
    const plan = await planNow();
    expect(plan.checkpoints[1]!.steps.map((step) => step.text)).toContain('Show a progress bar');
    expect(plan.decisions[0]).toMatchObject({ question: 'Which delimiter?', suggested: ['Comma', 'Semicolon'], ifNoAnswer: 'comma' });
    expect(printed[0]).toContain('Added the step "Show a progress bar" under "Reports export to CSV".');
  });

  it('lists what changed lately and who changed it', async () => {
    await planLog(context());
    expect(output()).toBe('Nothing has changed in the plan yet.');
    await planDone(context(), 'Tidy the old');
    printed = [];
    await planLog(context());
    expect(output()).toMatch(/now\s+Claude\s+ticked step "Tidy the old export script"/);
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

  it('shows the plan when no verb is given, and takes the workspace before or after the verb', async () => {
    expect((await cli('-w', root)).lines.join('\n')).toContain('◐ Reports export to CSV');
    await cli('done', 'Add', 'the', 'Export', 'button', '-w', root, '--harness', 'codex');
    expect((await readPlanChanges(root))[0]).toMatchObject({ by: 'codex', text: 'Add the Export button' });
  });

  it('takes the decision\'s suggestions as repeated options', async () => {
    await cli('-w', root, 'decide', 'Which', 'delimiter?', '--under', 'Reports export', '--suggest', 'Comma', '--suggest', 'Semicolon', '--if-no-answer', 'comma');
    expect((await planNow()).checkpoints[1]!.decisions[1]).toMatchObject({ question: 'Which delimiter?', suggested: ['Comma', 'Semicolon'] });
  });

  it('tells an AI with older instructions that the plan is PLAN.md now', async () => {
    const { failures } = await cli('-w', root, 'start', 'M1');
    expect(failures[0]).toMatch(/"ctxspace plan start" is gone: the plan is PLAN.md now. Edit it directly/);
  });

  it('prints errors as JSON with --json, and fails', async () => {
    const { lines } = await cli('-w', root, '--json', 'done', 'nothing like it');
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, code: 'not_found' });
    expect(process.exitCode).toBe(1);
  });
});
