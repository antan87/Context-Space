import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { registerPlanFileRoutes } from './plan-file-routes.js';
import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { setActiveStorageProvider } from '../core/adapters/registry.js';
import { parsePlanFile } from '../core/plan-file.js';

const check = vi.hoisted(() => ({ result: { overallStatus: 'pass', canProgress: true, repos: [{ headSha: 'abc1234def' }] } as unknown }));
vi.mock('../core/verify.js', () => ({ verifyWorkspace: vi.fn(async () => check.result) }));

const PLAN = `# Reports

Customers export their reports.

## Checkpoints

- [ ] Reports export to CSV
  Check: \`npm test\`
  - [ ] Write the CSV writer
  - [ ] Decide: Export archived reports?
    Suggested: Yes · No

## Notes

Keep it small.
`;

describe('plan routes', () => {
  let root: string;
  let app: Hono;
  const get = async () => (await app.request('/api/workspace/reports/plan')).json();
  const post = async (change: unknown) => {
    const response = await app.request('/api/workspace/reports/plan', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ change }),
    });
    return { status: response.status, body: await response.json() };
  };
  const file = async () => parsePlanFile(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'));

  beforeEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plan-file-routes-')));
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'reports', name: 'Reports', branchName: 'reports', repos: [], assistants: [], workspacePath: root }));
    await fs.writeFile(path.join(root, 'PLAN.md'), PLAN);
    app = new Hono();
    registerPlanFileRoutes(app, async (id) => (id === 'reports' ? root : null));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('reads the plan as the tab shows it: free text as written, checkpoints, decisions and what waits', async () => {
    const plan = await get();
    expect(plan).toMatchObject({
      file: 'PLAN.md', source: 'file', title: 'Reports', intro: 'Customers export their reports.',
      sections: [{ heading: 'Notes', body: 'Keep it small.' }],
      waiting: ['export-archived-reports'],
    });
    expect(plan.checkpoints[0]).toMatchObject({
      key: 'reports-export-to-csv', check: 'npm test', steps: [{ key: 'write-the-csv-writer', text: 'Write the CSV writer', done: false }],
      decisions: [{ key: 'export-archived-reports', question: 'Export archived reports?', suggested: ['Yes', 'No'], checkpoint: 'reports-export-to-csv' }],
    });
    expect((await app.request('/api/workspace/other/plan')).status).toBe(404);
  });

  it('ticks a step and answers a decision as the user, and says what changed', async () => {
    const ticked = await post({ type: 'tick', key: 'write-the-csv-writer', done: true, expected: 'Write the CSV writer' });
    expect(ticked).toMatchObject({ status: 200, body: { message: 'Ticked "Write the CSV writer".' } });
    expect(ticked.body.plan.checkpoints[0].steps[0].done).toBe(true);
    await post({ type: 'answer', key: 'export-archived-reports', answer: 'Yes', expected: 'Export archived reports?' });
    const plan = await get();
    expect(plan.waiting).toEqual([]);
    expect(plan.changes.map((change: { by: string; action: string; text: string }) => `${change.by} ${change.action} ${change.text}`)).toEqual([
      'user answered Export archived reports?', 'user ticked Write the CSV writer',
    ]);
  });

  it('ticks a checkpoint with a check only once the check passes, and keeps its proof', async () => {
    check.result = { overallStatus: 'fail', canProgress: false, repos: [{ headSha: 'abc1234def' }] };
    const failed = await post({ type: 'tick', key: 'reports-export-to-csv', done: true, expected: 'Reports export to CSV' });
    expect(failed).toMatchObject({ status: 400, body: { error: expect.stringContaining('stays open: its check failed') } });
    expect((await file()).checkpoints[0]!.done).toBe(false);
    expect((await get()).checkpoints[0].proof).toMatchObject({ canProgress: false, lastVerificationSha: 'abc1234def' });
    check.result = { overallStatus: 'pass', canProgress: true, repos: [{ headSha: 'abc1234def' }] };
    expect((await post({ type: 'tick', key: 'reports-export-to-csv', done: true, expected: 'Reports export to CSV' })).status).toBe(200);
    expect((await file()).checkpoints[0]!.done).toBe(true);
  });

  it('reopens a checkpoint with what is wrong as a step under it', async () => {
    await fs.writeFile(path.join(root, 'PLAN.md'), PLAN.replace('- [ ] Reports export to CSV', '- [x] Reports export to CSV'));
    const reopened = await post({ type: 'reopen', key: 'reports-export-to-csv', reason: 'The file has no header row', expected: 'Reports export to CSV' });
    expect(reopened).toMatchObject({ status: 200, body: { message: 'Reopened "Reports export to CSV".' } });
    const checkpoint = (await file()).checkpoints[0]!;
    expect(checkpoint.done).toBe(false);
    expect(checkpoint.steps.map((step) => step.text)).toEqual(['Write the CSV writer', 'Reopened: The file has no header row']);
  });

  it('refuses a change to a line that changed since the tab read it', async () => {
    await fs.writeFile(path.join(root, 'PLAN.md'), PLAN.replace('Write the CSV writer', 'Write the CSV writer and reader'));
    const stale = await post({ type: 'tick', key: 'write-the-csv-writer', done: true, expected: 'Write the CSV writer' });
    expect(stale.status).toBe(404);
    expect(stale.body.error).toMatch(/Read the plan again/);
  });

  it('adds a step and a decision under a checkpoint', async () => {
    await post({ type: 'add', step: 'Add the button', checkpoint: 'reports-export-to-csv' });
    await post({ type: 'decide', decision: { question: 'Which delimiter?', suggested: ['Comma'] }, checkpoint: 'reports-export-to-csv' });
    const checkpoint = (await file()).checkpoints[0]!;
    expect(checkpoint.steps.map((step) => step.text)).toEqual(['Write the CSV writer', 'Add the button']);
    expect(checkpoint.decisions.map((decision) => decision.question)).toEqual(['Export archived reports?', 'Which delimiter?']);
    expect((await post({ type: 'add', step: '' })).status).toBe(400);
  });

  it('answers a decision directly via POST /api/workspace/:id/plan/decisions/:key/answer and updates PLAN.md on disk', async () => {
    const res = await app.request('/api/workspace/reports/plan/decisions/export-archived-reports/answer', {
      method: 'POST',
      body: JSON.stringify({ answer: 'Yes, include archived' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('Answered "Export archived reports?".');
    expect(body.plan.waiting).toEqual([]);
    const updatedPlan = await file();
    const dec = updatedPlan.checkpoints[0]?.decisions[0];
    expect(dec?.done).toBe(true);
    expect(dec?.answer).toBe('Yes, include archived');

    // 404 when decision key is not found
    const missing = await app.request('/api/workspace/reports/plan/decisions/non-existent-key/answer', {
      method: 'POST',
      body: JSON.stringify({ answer: 'Some answer' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(missing.status).toBe(404);

    // 409 when expected does not match current plan question
    const conflict = await app.request('/api/workspace/reports/plan/decisions/export-archived-reports/answer', {
      method: 'POST',
      body: JSON.stringify({ answer: 'No', expected: 'Stale question from yesterday?' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(conflict.status).toBe(409);

    // 400 when answer is blank
    const blank = await app.request('/api/workspace/reports/plan/decisions/export-archived-reports/answer', {
      method: 'POST',
      body: JSON.stringify({ answer: '   ' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(blank.status).toBe(400);
  });

  it('ticks and unticks a step directly via POST /api/workspace/:id/plan/steps/:key/tick', async () => {
    // Tick with auto-resolved expected
    const res = await app.request('/api/workspace/reports/plan/steps/write-the-csv-writer/tick', {
      method: 'POST',
      body: JSON.stringify({ done: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('Ticked "Write the CSV writer".');
    expect(body.plan.checkpoints[0]?.steps[0]?.done).toBe(true);

    const onDisk = await file();
    expect(onDisk.checkpoints[0]?.steps[0]?.done).toBe(true);

    // Untick with explicit expected
    const untick = await app.request('/api/workspace/reports/plan/steps/write-the-csv-writer/tick', {
      method: 'POST',
      body: JSON.stringify({ done: false, expected: 'Write the CSV writer' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(untick.status).toBe(200);
    const untickBody = await untick.json();
    expect(untickBody.message).toBe('Unticked "Write the CSV writer".');
    expect(untickBody.plan.checkpoints[0]?.steps[0]?.done).toBe(false);

    // 404 when step key does not exist
    const missing = await app.request('/api/workspace/reports/plan/steps/non-existent-step/tick', {
      method: 'POST',
      body: JSON.stringify({ done: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(missing.status).toBe(404);

    // 409 when expected does not match
    const conflict = await app.request('/api/workspace/reports/plan/steps/write-the-csv-writer/tick', {
      method: 'POST',
      body: JSON.stringify({ done: true, expected: 'Outdated step wording' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(conflict.status).toBe(409);
  });

  it('runs a checkpoint check via POST /api/workspace/:id/plan/checkpoints/:key/check', async () => {
    check.result = { overallStatus: 'pass', canProgress: true, repos: [{ headSha: 'abc1234def' }] };
    const res = await app.request('/api/workspace/reports/plan/checkpoints/reports-export-to-csv/check', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('The check passed.');
    expect(body.plan.checkpoints[0]?.proof).toMatchObject({ canProgress: true });

    // 404 when checkpoint key does not exist
    const missing = await app.request('/api/workspace/reports/plan/checkpoints/non-existent-checkpoint/check', {
      method: 'POST',
    });
    expect(missing.status).toBe(404);
  });

  it('says which step is worked on now, sends it with the plan, and clears it when the step is ticked', async () => {
    const postNow = (body: unknown) => app.request('/api/workspace/reports/plan/now', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await get()).now).toBeNull();
    const set = await postNow({ key: 'write-the-csv-writer' });
    expect(set.status).toBe(200);
    const body = await set.json();
    expect(body.message).toBe('Working on "Write the CSV writer" now.');
    expect(body.plan.now).toMatchObject({ key: 'write-the-csv-writer', by: 'user' });
    expect(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8')).toBe(PLAN);

    expect((await postNow({ key: 'export-archived-reports' })).status).toBe(400);
    expect((await postNow({ key: 'reports-export-to-csv' })).status).toBe(400);
    expect((await postNow({ key: 'nothing-like-it' })).status).toBe(404);
    expect((await postNow({ nonsense: true })).status).toBe(400);

    await post({ type: 'tick', key: 'write-the-csv-writer', done: true, expected: 'Write the CSV writer' });
    expect((await get()).now).toBeNull();

    await postNow({ key: 'write-the-csv-writer' });
    const cleared = await (await postNow({ clear: true })).json();
    expect(cleared.plan.now).toBeNull();
  });
});
