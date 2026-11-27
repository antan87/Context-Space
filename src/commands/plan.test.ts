import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { getStorageProvider, setActiveStorageProvider } from '../core/adapters/registry.js';
import { changePlan } from '../core/plan.js';
import { parsePlanFile } from '../core/plan-file.js';
import { readPlanChanges, readPlanNow } from '../core/plan-file-store.js';

const PASSED = { overallStatus: 'pass', canProgress: true, repos: [{ headSha: 'abc1234def5678' }] };
const FAILED = { overallStatus: 'fail', canProgress: false, repos: [{ headSha: 'abc1234def5678' }] };
const check = vi.hoisted(() => ({ result: undefined as unknown }));
vi.mock('../core/verify.js', () => ({ verifyWorkspace: async () => check.result }));
// The move looks for older ContextSpace processes on this machine; a test sees none (the check has its own tests).
vi.mock('../core/older-writers.js', async (original) => ({ ...await original<typeof import('../core/older-writers.js')>(), findOlderWriters: async () => [] }));
import { findByWords, planNow as planNowCommand, planAdd, planAnswer, planChangeBy, planCheck, planDone, planLog, planMigrate, planShow, registerPlanCommand, type PlanCommandContext } from './plan.js';
import { readSwitch } from '../core/workspace-db-switch.js';
import { stripExport } from '../core/workspace-db/index.js';

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
const planFileNow = async () => parsePlanFile(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'));

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
    expect(output()).toContain('◐ CSV export endpoint');
  });

  it('finds an item by its words, or the start of them, and names the matches when several fit', async () => {
    const plan = await planFileNow();
    expect(findByWords(plan, 'add the export')).toMatchObject({ text: 'Add the Export button' });
    expect(findByWords(plan, 'Reports export to CSV', 'checkpoint')).toMatchObject({ title: 'Reports export to CSV' });
    expect(() => findByWords(plan, 'Re')).toThrow(/matches 2 items: "Report rows load fast", "Reports export to CSV"/);
    expect(() => findByWords(plan, 'nothing like it')).toThrow(/No item in PLAN.md matches/);
  });
});

describe('changing the plan', () => {
  it('ticks a step, and logs who did', async () => {
    await planDone(context(), 'Add the Export button');
    expect((await planFileNow()).checkpoints[1]!.steps[1]!.done).toBe(true);
    expect(output()).toBe('Ticked "Add the Export button".\nPlan: 1 of 2 checkpoints done · 1 waiting for the user. Run "ctxspace plan" to see it.');
    expect((await readPlanChanges(root))[0]).toMatchObject({ by: 'claude', action: 'ticked', text: 'Add the Export button' });
  });

  it('runs a checkpoint\'s check before ticking it, and leaves it open when the check fails', async () => {
    check.result = FAILED;
    await expect(planDone(context(), 'Reports export to CSV')).rejects.toThrow('"Reports export to CSV" stays open: its check failed on abc1234 · now. Fix what fails and run it again.');
    expect((await planFileNow()).checkpoints[1]!.done).toBe(false);
    check.result = PASSED;
    await planDone(context(), 'Reports export to CSV');
    expect((await planFileNow()).checkpoints[1]!.done).toBe(true);
  });

  it('runs a check without ticking, and fails the command when it fails', async () => {
    check.result = FAILED;
    await planCheck(context());
    expect(output()).toBe('"Reports export to CSV": check failed on abc1234 · now.');
    expect(process.exitCode).toBe(1);
    expect((await planFileNow()).checkpoints[1]!.done).toBe(false);
  });

  it('answers a decision, and will not tick one as done', async () => {
    await expect(planDone(context(), 'Should archived')).rejects.toThrow(/is a decision: answer it with ctxspace plan answer/);
    await planAnswer(context({ by: 'user' }), 'Should archived', 'Yes, all of them');
    expect((await planFileNow()).checkpoints[1]!.decisions[0]).toMatchObject({ done: true, answer: 'Yes, all of them' });
    expect(output()).toContain('Answered "Should archived reports be exported?": Yes, all of them');
  });

  it('adds a step or a decision under a checkpoint, or on its own', async () => {
    await planAdd(context(), { step: 'Show a progress bar' }, 'Reports export');
    await planAdd(context(), { decision: { question: 'Which delimiter?', suggested: ['Comma', 'Semicolon'], ifNoAnswer: 'comma' } });
    const plan = await planFileNow();
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
    expect((await planFileNow()).checkpoints[1]!.decisions[1]).toMatchObject({ question: 'Which delimiter?', suggested: ['Comma', 'Semicolon'] });
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

describe('ctxspace plan now', () => {
  it('records the step by its words, naming who said it, and leaves PLAN.md alone', async () => {
    await planNowCommand(context(), 'Add the Export');
    expect(output()).toContain('Working on "Add the Export button" now.');
    expect(output()).not.toContain('Plan-Step');
    expect(await readPlanNow(root)).toMatchObject({ key: 'add-the-export-button', by: 'claude' });
    expect(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8')).toBe(PLAN);
  });

  it('names the choices when the words fit several, and says when no step fits', async () => {
    await expect(planNowCommand(context(), 'Re')).rejects.toThrow(/matches 2|No step/);
    await expect(planNowCommand(context(), 'nothing like it')).rejects.toThrow(/No step in PLAN.md matches/);
    await expect(planNowCommand(context(), 'Write the CSV writer')).rejects.toThrow(/already done/);
    await expect(planNowCommand(context(), 'Should archived reports')).rejects.toThrow(/No step/);
    expect(await readPlanNow(root)).toBeNull();
  });

  it('clears it with --clear, and says so in JSON', async () => {
    await planNowCommand(context(), 'Add the Export button');
    printed = [];
    await planNowCommand(context({ json: true }), '', true);
    expect(JSON.parse(output())).toMatchObject({ ok: true });
    expect(await readPlanNow(root)).toBeNull();
    printed = [];
    await planNowCommand(context(), '', true);
    expect(output()).toContain('No step was marked');
  });

  it('is registered with its option', () => {
    const program = new Command();
    registerPlanCommand(program, () => undefined);
    const now = program.commands.find((c) => c.name() === 'plan')!.commands.find((c) => c.name() === 'now')!;
    expect(now.options.map((o) => o.long)).toContain('--clear');
  });
});

describe('ctxspace plan migrate --dry-run', () => {
  let out: string;
  beforeEach(async () => { out = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plan-migrate-out-'))); });
  afterEach(async () => { await fs.rm(out, { recursive: true, force: true }); });

  async function run(...args: string[]) {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((text?: unknown) => { lines.push(String(text)); });
    const failures: string[] = [];
    const program = new Command().exitOverride();
    registerPlanCommand(program, (error) => { failures.push(error instanceof Error ? error.message : String(error)); });
    await program.parseAsync(['node', 'ctxspace', 'plan', 'migrate', '-w', root, ...args]);
    vi.mocked(console.log).mockRestore();
    return { lines, failures };
  }

  it('says in plain words what it found and exits 0 when everything maps and round trips', async () => {
    const { lines, failures } = await run('--dry-run', '--out', path.join(out, 'o'));
    expect(failures).toEqual([]);
    const text = lines.join('\n');
    expect(text).toContain('Rehearsal only: nothing in this workspace was changed.');
    expect(text).toContain('Everything maps');
    expect(text).toContain('PLAN.md round trip: identical');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('exits 3 when it worked but something is listed', async () => {
    await fs.writeFile(path.join(root, 'contextspace-board.json'), JSON.stringify({ version: 1, revision: 1, positions: {}, links: [], cards: [{ id: '00000001-1111-4222-8333-444455556666', kind: 'note', title: 'Lost', body: '', pinned: false, archived: false, by: 'user', at: '2026-11-01T10:00:00.000Z', step: 'no-such-step' }] }));
    const { lines } = await run('--dry-run', '--out', path.join(out, 'o'));
    expect(lines.join('\n')).toContain('no-such-step');
    expect(process.exitCode).toBe(3);
  });

  it('prints only JSON with --json (stdout stays clean) and carries the exit code', async () => {
    const { lines } = await run('--dry-run', '--json', '--out', path.join(out, 'o'));
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]!);
    expect(report).toMatchObject({ result: 'ok', exitCode: 0, plan: { source: 'file' }, roundTrip: { identical: true } });
    expect(report.snapshot.file).toBe(path.join(out, 'o', 'contextspace-data.json'));
  });

  it('reports the resolved output path when --out goes through a link (macOS /var, Windows short names)', async () => {
    const link = path.join(out, 'link');
    await fs.mkdir(path.join(out, 'real'));
    await fs.symlink(path.join(out, 'real'), link, 'junction');
    const { lines } = await run('--dry-run', '--json', '--out', path.join(link, 'o'));
    const report = JSON.parse(lines[0]!);
    expect(report.snapshot.file).toBe(path.join(await fs.realpath(link), 'o', 'contextspace-data.json'));
    expect(report.snapshot.file).not.toBe(path.join(link, 'o', 'contextspace-data.json'));
  });

  it('exits 1 for an out folder inside the workspace, and for --out without --dry-run', async () => {
    const a = await run('--json', '--out', path.join(out, 'o'));
    expect(JSON.parse(a.lines[0]!)).toMatchObject({ ok: false, code: 'invalid' });
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const b = await run('--dry-run', '--json', '--out', path.join(root, '.contextspace'));
    expect(JSON.parse(b.lines[0]!).error).toMatch(/inside the workspace/);
    expect(process.exitCode).toBe(1);
    await expect(fs.access(path.join(root, '.contextspace', 'workspace.db'))).rejects.toThrow();
  });

  it('is registered with its options', () => {
    const program = new Command();
    registerPlanCommand(program, () => undefined);
    const migrate = program.commands.find((c) => c.name() === 'plan')!.commands.find((c) => c.name() === 'migrate')!;
    expect(migrate.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--dry-run', '--out', '--json', '--status', '--from-backup']));
    expect(program.commands.find((c) => c.name() === 'plan')!.commands.find((c) => c.name() === 'restore')).toBeDefined();
  });
});

describe('ctxspace plan migrate, --status and restore', () => {
  beforeEach(() => { setActiveStorageProvider(getStorageProvider('local')); });

  async function run(...args: string[]) {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((text?: unknown) => { lines.push(String(text)); });
    const failures: string[] = [];
    const program = new Command().exitOverride();
    registerPlanCommand(program, (error) => { failures.push(error instanceof Error ? error.message : String(error)); });
    await program.parseAsync(['node', 'ctxspace', 'plan', ...args]);
    vi.mocked(console.log).mockRestore();
    return { lines, failures, text: lines.join('\n') };
  }

  it('moves, shows the status, and restores, each saying which workspace it acted on', async () => {
    const moved = await run('migrate', '-w', root);
    expect(moved.failures).toEqual([]);
    expect(moved.text).toContain('Moved to the workspace database.');
    expect(moved.text).toContain(`Workspace: ${root}`);
    const archive = readSwitch(root)!.archive!;
    expect(moved.text).toContain(`Undo it with \`ctxspace plan restore ${archive}\``);
    expect(stripExport(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'))).toBe(PLAN);

    const status = await run('migrate', '--status', '--json', '-w', root);
    expect(status.lines).toHaveLength(1);
    expect(JSON.parse(status.lines[0]!)).toMatchObject({ workspace: root, moved: 'on', archive, database: 'present' });

    const again = await run('migrate', '--json', '-w', root);
    expect(JSON.parse(again.lines[0]!)).toMatchObject({ ok: false, code: 'conflict', error: expect.stringMatching(/already moved/) });
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    const dry = await run('migrate', '--dry-run', '-w', root);
    expect(dry.failures[0]).toMatch(/moved to the workspace database already/);

    const restored = await run('restore', archive, '-w', root);
    expect(restored.failures).toEqual([]);
    expect(restored.text).toContain('Restored: the workspace is back on its old files');
    expect(restored.text).toContain(`Workspace: ${root}`);
    expect(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8')).toBe(PLAN);
    expect(readSwitch(root)).toBeNull();
  });

  it('plan now on the database also says which trailer to commit with', async () => {
    await run('migrate', '-w', root);
    printed = [];
    await planNowCommand(context(), 'Add the Export');
    expect(output()).toMatch(/Working on "Add the Export button" now\.\nCommit with: Plan-Step: s[a-z0-9]{5}$/);
  });

  it('prints only JSON with --json, and a refusal carries the build report', async () => {
    await fs.writeFile(path.join(root, 'contextspace-board.json'), '{ broken');
    const refused = await run('migrate', '--json', '-w', root);
    expect(refused.lines).toHaveLength(1);
    const body = JSON.parse(refused.lines[0]!);
    expect(body).toMatchObject({ ok: false, code: 'conflict', report: { exitCode: 3 } });
    expect(body.error).toMatch(/Nothing was changed/);
    expect(readSwitch(root)).toBeNull();
    process.exitCode = undefined;
    await fs.rm(path.join(root, 'contextspace-board.json'));
    const ok = await run('migrate', '--json', '-w', root);
    expect(ok.lines).toHaveLength(1);
    expect(JSON.parse(ok.lines[0]!)).toMatchObject({ ok: true, workspace: root, how: 'fresh' });
  });

  it('refuses to act when the workspace found from the current folder is not that folder (a copy pointing at its original)', async () => {
    const copy = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plan-copy-')));
    try {
      const before = await fs.readFile(path.join(root, 'PLAN.md'), 'utf8');
      const here = context({ explicitWorkspace: false, cwd: copy });
      await expect(planMigrate(here, {})).rejects.toThrow(new RegExp(`You are in ${copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, but the workspace found from here is`));
      await expect(planMigrate(here, { status: true })).rejects.toThrow(/--workspace <path>/);
      expect(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8')).toBe(before);
      expect(readSwitch(root)).toBeNull();
      // inside the workspace (a subfolder) it acts
      await fs.mkdir(path.join(root, 'docs'));
      await planMigrate(context({ explicitWorkspace: false, cwd: path.join(root, 'docs') }), { status: true });
      expect(output()).toContain('Not moved');
    } finally {
      await fs.rm(copy, { recursive: true, force: true });
    }
  });
});
