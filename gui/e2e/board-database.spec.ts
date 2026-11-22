/**
 * DB3b against a REAL backend: a scratch workspace is moved to its database by the real `ctxspace plan migrate`, the real
 * server serves it, and the page's plan, board and news calls are forwarded to that server (every other call stays mocked
 * by the fixtures). A person ticks a step, answers a question, adds and edits a note and moves it to another area; each
 * change is read back from the server and from PLAN.md.
 *
 * The note-loss proof: while the person edits a note, an AI (another process, through the database) changes it. Saving
 * says so, keeps what the person typed, and only an explicit "Save yours over theirs" writes over the AI's words.
 *
 * It needs the backend built (`npm run build:backend`). Everything it writes is in its own temp folder; the server runs on
 * DB_E2E_BACKEND_PORT (4901 by default) with its own HOME, CONTEXTSPACE_HOME and PM2_HOME, and is stopped by its PID.
 */

import type { Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from './fixtures.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'dist', 'index.js');
const PORT = Number(process.env.DB_E2E_BACKEND_PORT ?? 4901);
const SERVER = `http://127.0.0.1:${PORT}`;

// One real backend on one port per file: keep every test of this file in one worker, in order (the config is fullyParallel,
// and a second worker's backend on the same port would answer for the wrong workspace).
test.describe.configure({ mode: 'default' });

const PLAN = `# Reports CSV export

Customers export their reports.

## Checkpoints

- [x] Report rows load fast
  - [x] Query the report rows
- [ ] Reports export to CSV
  - [x] Write the CSV writer
  - [ ] Background job queue for large exports
  - [ ] Download link in the report page
  - [ ] Decide: Which time zone should export timestamps use?
    Suggested: UTC · Local time (browser)
    If no answer: UTC
- [ ] Docs
  - [ ] Write the help page
`;
const AT = '2026-11-01T10:00:00.000Z';
const BOARD = {
  version: 1, revision: 3,
  cards: [{
    id: '11111111-2222-4000-8000-333333333333', kind: 'note', title: 'Export leaks memory', body: 'Rows are buffered whole.',
    pinned: false, archived: false, by: 'user', at: AT, updatedBy: 'user', updatedAt: AT,
    area: 'checkpoint:reports-export-to-csv', step: 'background-job-queue-for-large-exports',
  }],
  links: [], positions: {},
};

let scratch: string;
let server: ChildProcess | null = null;
let counter = 0;

const env = () => ({
  ...process.env,
  HOME: path.join(scratch, 'home'),
  CONTEXTSPACE_HOME: path.join(scratch, 'cshome'),
  NEXUSFLOW_HOME: '',
  PM2_HOME: '/tmp/db3b-pm',
  NODE_NO_WARNINGS: '1',
});

/** A fresh workspace in the scratch folder, moved to its database by the real command. Returns its id and path. */
function movedWorkspace(): { id: string; root: string } {
  counter += 1;
  const id = `dbws${counter}`;
  const root = path.join(scratch, 'workspaces', id);
  fs.mkdirSync(path.join(root, '.contextspace'), { recursive: true });
  fs.writeFileSync(path.join(root, 'contextspace.json'), JSON.stringify({ id, name: 'Reports CSV export', branchName: id, description: 'Add CSV export', repos: [], assistants: [], workspacePath: root }));
  fs.writeFileSync(path.join(root, 'PLAN.md'), PLAN);
  fs.writeFileSync(path.join(root, 'contextspace-board.json'), JSON.stringify(BOARD, null, 2));
  execFileSync(process.execPath, [CLI, 'plan', 'migrate', '-w', root, '--json'], { env: env(), stdio: 'pipe' });
  return { id, root: fs.realpathSync(root) };
}

/** What an AI does from another process: one batch through the database, as `claude`. */
function aiApplies(root: string, ops: unknown[]): void {
  const script = `
    const { openWorkspaceDb, applyBatch, readRevision, readDbId } = await import(${JSON.stringify(path.join(REPO, 'dist', 'core', 'workspace-db', 'index.js'))});
    const db = openWorkspaceDb(${JSON.stringify(root)}, { busy: 'cli', backups: false });
    const result = await applyBatch(db, { ops: ${JSON.stringify(ops)}, ifRevision: readRevision(db.sqlite), dbId: readDbId(db.sqlite) }, { by: 'claude' });
    db.close();
    if (!result.ok) { console.error(JSON.stringify(result)); process.exit(1); }`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: env(), stdio: 'pipe' });
}

const api = async (id: string, what: 'plan' | 'board') => (await fetch(`${SERVER}/api/workspace/${id}/${what}`)).json() as Promise<any>;

/** The page talks to the mocked API, except for this workspace's plan, board and news, which go to the real server. */
async function forward(page: Page, id: string) {
  await page.route(new RegExp(`/api/workspace/${id}/(plan|board|news|recent-commits)(/|\\?|$)`), async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${SERVER}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}

test.use({ viewport: { width: 1280, height: 800 }, screenshot: 'only-on-failure' });

test.beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'db3b-e2e-'));
  for (const dir of ['home', 'cshome', 'workspaces']) fs.mkdirSync(path.join(scratch, dir), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'cshome', 'config.json'), JSON.stringify({ version: '0.2.7', devDir: scratch, workspacesDir: path.join(scratch, 'workspaces'), defaultAssistant: 'CLAUDE', scanDepth: 1 }));
  server = spawn(process.execPath, [CLI, 'ui', '--port', String(PORT), '--strict-port'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  const started = Date.now();
  for (;;) {
    if (server.exitCode !== null) throw new Error(`the backend stopped (exit ${server.exitCode})`);
    try { if ((await fetch(`${SERVER}/api/config`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() - started > 30_000) throw new Error('the backend did not start');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server!.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

async function openBoard(page: Page, id: string, root: string) {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [{ id, branchName: id, name: 'Reports CSV export', description: 'Add CSV export', repos: [], assistants: [], workspacePath: root, createdAt: AT }] }));
  await forward(page, id);
  await page.goto(`/#/workspaces/${id}/board`);
}

async function stepInto(page: Page, name: RegExp) {
  const area = page.locator('#board-overview button.board-area').filter({ hasText: name });
  await area.click();
  await expect(page.locator('#board-area')).toBeVisible();
}

test.describe('the Board on a workspace moved to its database (real backend)', () => {
  test('ticks a step and answers a question: both land in the database and in PLAN.md', async ({ page }) => {
    const { id, root } = movedWorkspace();
    const before = await api(id, 'plan');
    const cp = before.checkpoints.find((c: any) => c.title === 'Reports export to CSV');
    const step = cp.steps.find((s: any) => s.text === 'Background job queue for large exports');
    await openBoard(page, id, root);
    await stepInto(page, /Reports export to CSV/);

    await page.locator(`[data-testid="step-checkbox-${step.key}"]`).click();
    await expect.poll(async () => (await api(id, 'plan')).checkpoints[1].steps.find((s: any) => s.key === step.key).done).toBe(true);
    await expect.poll(() => fs.readFileSync(path.join(root, 'PLAN.md'), 'utf8')).toContain(`- [x] Background job queue for large exports <!-- ${step.key} -->`);

    const frame = page.locator('#board-area').getByRole('article', { name: 'Waits for you' });
    await frame.getByRole('button', { name: 'UTC', exact: true }).click();
    await expect(page.locator('#board-area').getByRole('article', { name: 'Waits for you' })).toHaveCount(0);
    await expect.poll(async () => (await api(id, 'plan')).checkpoints[1].decisions[0]).toMatchObject({ done: true, answer: 'UTC' });
    expect(fs.readFileSync(path.join(root, 'PLAN.md'), 'utf8')).toContain('Answer: UTC');
  });

  test('adds a note, edits it, and moves it to another area; each change is in the database', async ({ page }) => {
    const { id, root } = movedWorkspace();
    const plan = await api(id, 'plan');
    const docs = plan.checkpoints.find((c: any) => c.title === 'Docs');
    await openBoard(page, id, root);
    await stepInto(page, /Reports export to CSV/);

    await page.locator('#board-area').getByRole('button', { name: 'Add a note' }).locator('visible=true').first().click();
    let dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Note title...').fill('Queue sizing');
    await dialog.getByPlaceholder('Write Markdown, lists, notes, or links...').fill('Start with 4 workers.');
    await dialog.getByRole('button', { name: 'Add note' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await api(id, 'board')).cards.find((c: any) => c.title === 'Queue sizing')?.body).toBe('Start with 4 workers.');

    const card = page.locator('#board-area').getByRole('article', { name: 'Queue sizing' });
    await expect(card).toBeVisible();
    await card.dblclick();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Edit note' })).toBeVisible();
    await dialog.getByPlaceholder('Write Markdown, lists, notes, or links...').fill('Start with 8 workers.');
    // moving it: the area a person picks for the note
    await dialog.getByLabel('Area').selectOption({ label: 'Docs' });
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await api(id, 'board')).cards.find((c: any) => c.title === 'Queue sizing')).toMatchObject({ body: 'Start with 8 workers.', area: `checkpoint:${docs.key}`, rev: 2, updatedBy: 'user' });
    const data = JSON.parse(fs.readFileSync(path.join(root, 'contextspace-data.json'), 'utf8'));
    expect(data.cards.find((c: any) => c.title === 'Queue sizing')).toMatchObject({ body: 'Start with 8 workers.', area: `checkpoint:${docs.key}` });
  });

  test('the note-loss proof: an AI changes the note while it is being edited; saving says so, keeps what was typed, and overwrites only on purpose', async ({ page }) => {
    const { id, root } = movedWorkspace();
    const note = (await api(id, 'board')).cards[0];
    expect(note).toMatchObject({ title: 'Export leaks memory', rev: 1 });
    await openBoard(page, id, root);
    await stepInto(page, /Reports export to CSV/);

    const card = page.locator('#board-area').getByRole('article', { name: 'Export leaks memory' });
    await card.dblclick();
    const dialog = page.getByRole('dialog');
    const body = dialog.getByPlaceholder('Write Markdown, lists, notes, or links...');
    await expect(body).toHaveValue('Rows are buffered whole.');
    await body.fill('My finding: stream the rows.');

    // meanwhile an AI changes the same note, through the database, from another process
    aiApplies(root, [{ op: 'card.update', id: note.id, body: 'AI finding: the buffer grows per row.' }]);

    await dialog.getByRole('button', { name: 'Save changes' }).click();
    const conflict = dialog.getByTestId('note-conflict');
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText('claude changed this note while you were editing it');
    await expect(body).toHaveValue('My finding: stream the rows.'); // what was typed is kept
    await expect(dialog).toBeVisible();
    expect((await api(id, 'board')).cards[0]).toMatchObject({ body: 'AI finding: the buffer grows per row.', updatedBy: 'claude' }); // nothing was written over
    await conflict.getByText('Their version', { exact: true }).click();
    await expect(conflict).toContainText('AI finding: the buffer grows per row.');

    await conflict.getByRole('button', { name: 'Save yours over theirs' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await api(id, 'board')).cards[0]).toMatchObject({ body: 'My finding: stream the rows.', updatedBy: 'user', rev: 3 });
  });

  test('note conflict preserves untouched AI pin/area/step on Save yours over theirs and loads them on Load their version', async ({ page }) => {
    const { id, root } = movedWorkspace();
    const plan = await api(id, 'plan');
    const docs = plan.checkpoints.find((c: any) => c.title === 'Docs');
    const note = (await api(id, 'board')).cards[0];
    await openBoard(page, id, root);
    await stepInto(page, /Reports export to CSV/);

    // Part 1: user edits ONLY body; AI pins note and clears step -> "Save yours over theirs" keeps AI pin & cleared step
    const card = page.locator('#board-area').getByRole('article', { name: 'Export leaks memory' });
    await card.dblclick();
    const dialog = page.getByRole('dialog');
    const body = dialog.getByPlaceholder('Write Markdown, lists, notes, or links...');
    await body.fill('Body edit that keeps AI pin');
    aiApplies(root, [{ op: 'card.update', id: note.id, body: 'AI pinned and detached', pinned: true, step: null }]);

    await dialog.getByRole('button', { name: 'Save changes' }).click();
    const conflict = dialog.getByTestId('note-conflict');
    await expect(conflict).toBeVisible();
    await conflict.getByRole('button', { name: 'Save yours over theirs' }).click();
    await expect(dialog).toHaveCount(0);

    const afterSaveOver = (await api(id, 'board')).cards.find((c: any) => c.id === note.id);
    expect(afterSaveOver).toMatchObject({ body: 'Body edit that keeps AI pin', pinned: true, rev: 3 });
    expect(afterSaveOver.step).toBeUndefined();

    // Part 1b: reverting an edit back to initial text during a 409 and clicking "Save yours over theirs" still saves over AI's rewrite (never silently closes)
    await card.dblclick();
    await expect(dialog).toBeVisible();
    await body.fill('Body edit that keeps AI pin + temp');
    aiApplies(root, [{ op: 'card.update', id: note.id, body: 'AI rewrote everything', pinned: false }]);
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(conflict).toBeVisible();
    await body.fill('Body edit that keeps AI pin');
    await conflict.getByRole('button', { name: 'Save yours over theirs' }).click();
    await expect(dialog).toHaveCount(0);
    const afterRevertSaveOver = (await api(id, 'board')).cards.find((c: any) => c.id === note.id);
    expect(afterRevertSaveOver).toMatchObject({ body: 'Body edit that keeps AI pin', pinned: false, rev: 5 });

    // Part 2: "Load their version" loads AI's pinned/area/step so saving after appending does not revert them
    await card.dblclick();
    await expect(dialog).toBeVisible();
    await body.fill('User draft before load theirs');
    aiApplies(root, [{ op: 'card.update', id: note.id, body: 'AI moved to Docs and unpinned', pinned: false, area: `checkpoint:${docs.key}`, step: null }]);

    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(conflict).toBeVisible();
    await conflict.getByRole('button', { name: 'Load their version' }).click();
    await expect(conflict).toHaveCount(0);
    await expect(body).toHaveValue('AI moved to Docs and unpinned');
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await expect(dialog.getByLabel('Area')).toHaveValue(`checkpoint:${docs.key}`);

    await body.fill('AI moved to Docs and unpinned + user addendum');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toHaveCount(0);
    const afterLoadSave = (await api(id, 'board')).cards.find((c: any) => c.id === note.id);
    expect(afterLoadSave).toMatchObject({
      body: 'AI moved to Docs and unpinned + user addendum',
      pinned: false,
      area: `checkpoint:${docs.key}`,
    });
  });

  test('note save survives a deleted step or checkpoint, and reports a vanished chosen step plainly with typed text kept', async ({ page }) => {
    const { id, root } = movedWorkspace();
    const plan = await api(id, 'plan');
    const cp = plan.checkpoints.find((c: any) => c.title === 'Reports export to CSV');
    const step2 = cp.steps.find((s: any) => s.text === 'Download link in the report page');
    const note = (await api(id, 'board')).cards[0];
    await openBoard(page, id, root);
    await stepInto(page, /Reports export to CSV/);

    // Part 1: AI deletes the note's step while dialog is open -> conflict -> "Save yours over theirs" succeeds (no 400 trap)
    const card = page.locator('#board-area').getByRole('article', { name: 'Export leaks memory' });
    await card.dblclick();
    const dialog = page.getByRole('dialog');
    const body = dialog.getByPlaceholder('Write Markdown, lists, notes, or links...');
    await body.fill('Keep my text even though step was removed');
    aiApplies(root, [{ op: 'remove', id: note.step, rev: 1 }]);

    await dialog.getByRole('button', { name: 'Save changes' }).click();
    const conflict = dialog.getByTestId('note-conflict');
    await expect(conflict).toBeVisible();
    await conflict.getByRole('button', { name: 'Save yours over theirs' }).click();
    await expect(dialog).toHaveCount(0);
    const afterDeletedStep = (await api(id, 'board')).cards.find((c: any) => c.id === note.id);
    expect(afterDeletedStep.body).toBe('Keep my text even though step was removed');
    expect(afterDeletedStep.step).toBeUndefined();

    // Part 2: User explicitly picks a step, AI deletes THAT step before Save -> plain error, dialog stays open with typed text, user can clear step and save
    await card.dblclick();
    await expect(dialog).toBeVisible();
    await body.fill('Text typed while targeting step 2');
    await dialog.getByLabel(/^Step/).selectOption(step2.key);
    aiApplies(root, [{ op: 'remove', id: step2.key, rev: 1 }]);

    await dialog.getByRole('button', { name: 'Save changes' }).click();
    const alert = dialog.locator('[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/step is no longer on the plan/i);
    await expect(body).toHaveValue('Text typed while targeting step 2');
    await dialog.getByLabel(/^Step/).selectOption('');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await api(id, 'board')).cards.find((c: any) => c.id === note.id).body).toBe('Text typed while targeting step 2');
  });

  test('conflict dialog stays open with typed text when AI moved the note to another area (SSE paused)', async ({ page }) => {
    const { id, root } = movedWorkspace();
    const plan = await api(id, 'plan');
    const docs = plan.checkpoints.find((c: any) => c.title === 'Docs');
    const note = (await api(id, 'board')).cards[0];

    await page.route('**/screen-events**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }),
    );
    await openBoard(page, id, root);
    await stepInto(page, /Reports export to CSV/);

    const card = page.locator('#board-area').getByRole('article', { name: 'Export leaks memory' });
    await card.dblclick();
    const dialog = page.getByRole('dialog');
    const body = dialog.getByPlaceholder('Write Markdown, lists, notes, or links...');
    await body.fill('CRITICAL UNSAVED USER TEXT');

    // AI moves the note to Docs while dialog is open
    aiApplies(root, [{ op: 'card.update', id: note.id, area: `checkpoint:${docs.key}`, step: null }]);

    await dialog.getByRole('button', { name: 'Save changes' }).click();
    const conflict = dialog.getByTestId('note-conflict');
    await expect(dialog).toBeVisible();
    await expect(conflict).toBeVisible();
    await expect(body).toHaveValue('CRITICAL UNSAVED USER TEXT');

    await conflict.getByRole('button', { name: 'Save yours over theirs' }).click();
    await expect(dialog).toHaveCount(0);
    const saved = (await api(id, 'board')).cards.find((c: any) => c.id === note.id);
    expect(saved).toMatchObject({ body: 'CRITICAL UNSAVED USER TEXT', area: `checkpoint:${docs.key}` });

    // Part 2: canceling a 409 conflict refreshes the board cache (even with SSE paused) so reopening shows the AI's latest version
    await page.locator('#board-area').getByRole('button', { name: /Board/ }).first().click();
    await stepInto(page, /Docs/);
    const docsCard = page.locator('#board-area').getByRole('article', { name: 'Export leaks memory' });
    await docsCard.dblclick();
    await expect(dialog).toBeVisible();
    await body.fill('ABANDONED DRAFT');
    aiApplies(root, [{ op: 'card.update', id: note.id, body: 'AI latest text seen after cancel' }]);
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(conflict).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(docsCard).toContainText('AI latest text seen after cancel');

    // Part 3: AI deletes the checkpoint the note belongs to (moving it to plan:own) -> conflict stays open, Save yours over theirs succeeds (no 400 trap)
    await docsCard.dblclick();
    await expect(dialog).toBeVisible();
    await expect(body).toHaveValue('AI latest text seen after cancel');
    await body.fill('SAVED AFTER CHECKPOINT DELETED');
    aiApplies(root, [{ op: 'remove', id: docs.key, rev: 1, cascade: true }]);

    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeVisible();
    await expect(conflict).toBeVisible();
    await expect(body).toHaveValue('SAVED AFTER CHECKPOINT DELETED');
    await conflict.getByRole('button', { name: 'Save yours over theirs' }).click();
    await expect(dialog).toHaveCount(0);
    const savedAfterDelCp = (await api(id, 'board')).cards.find((c: any) => c.id === note.id);
    expect(savedAfterDelCp).toMatchObject({ body: 'SAVED AFTER CHECKPOINT DELETED', area: 'plan:own' });
  });

  test('NoteDialog shows Busy, try again (503) and the moved sentence (409), and Pin menu errors do not throw unhandled rejections', async ({ page }) => {
    const { id, root } = movedWorkspace();
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await openBoard(page, id, root);
    await stepInto(page, /Reports export to CSV/);

    const card = page.locator('#board-area').getByRole('article', { name: 'Export leaks memory' });
    await card.dblclick();
    const dialog = page.getByRole('dialog');
    const body = dialog.getByPlaceholder('Write Markdown, lists, notes, or links...');
    await body.fill('Typed during transient busy');

    // Simulate 503 Busy from the server (one request)
    let intercepted = false;
    await page.route(`**/api/workspace/${id}/board/changes`, async (route) => {
      if (!intercepted) {
        intercepted = true;
        await route.fulfill({
          status: 503,
          json: { error: 'Busy, try again in a moment: another process is using the workspace database. Nothing was changed.', code: 'busy' },
        });
        return;
      }
      await route.fallback();
    });

    await dialog.getByRole('button', { name: 'Save changes' }).click();
    const alert = dialog.locator('[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Busy, try again/i);
    await expect(body).toHaveValue('Typed during transient busy');

    // Now switch workspace to restoring (real backend 409 moved)
    const switchPath = path.join(root, '.contextspace', 'workspace-db-switch.json');
    const origSwitch = fs.readFileSync(switchPath, 'utf8');
    fs.writeFileSync(switchPath, JSON.stringify({ ...JSON.parse(origSwitch), state: 'restoring' }));
    try {
      await dialog.getByRole('button', { name: 'Save changes' }).click();
      await expect(alert).toContainText(/being restored/i);
      await expect(body).toHaveValue('Typed during transient busy');

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      // Pin click during restoring must not trigger an unhandled promise rejection
      const actionsBtn = page.locator('#board-area').getByRole('button', { name: 'Actions for Export leaks memory' });
      await actionsBtn.click({ force: true });
      await page.getByRole('menuitem', { name: 'Pin note' }).click();
      await page.waitForTimeout(300);
      expect(pageErrors).toEqual([]);
    } finally {
      fs.writeFileSync(switchPath, origSwitch);
    }
  });

  test('reverting title during a conflict saves the person title and keeps the AI untouched body', async ({ page }) => {
    const { id, root } = movedWorkspace();
    const note = (await api(id, 'board')).cards[0];
    await openBoard(page, id, root);
    await stepInto(page, /Reports export to CSV/);

    const card = page.locator('#board-area').getByRole('article', { name: 'Export leaks memory' });
    await card.dblclick();
    const dialog = page.getByRole('dialog');
    const title = dialog.getByPlaceholder('Note title...');
    await expect(title).toHaveValue('Export leaks memory');
    await title.fill('Temporary title');

    aiApplies(root, [{ op: 'card.update', id: note.id, title: 'AI renamed title', body: 'AI critical body findings.' }]);

    await dialog.getByRole('button', { name: 'Save changes' }).click();
    const conflict = dialog.getByTestId('note-conflict');
    await expect(conflict).toBeVisible();

    // Person reverts title back to the starting value and saves over theirs — body was never touched
    await title.fill('Export leaks memory');
    await conflict.getByRole('button', { name: 'Save yours over theirs' }).click();
    await expect(dialog).toHaveCount(0);

    const after = (await api(id, 'board')).cards.find((c: any) => c.id === note.id);
    expect(after).toMatchObject({
      title: 'Export leaks memory',
      body: 'AI critical body findings.',
      rev: 3,
      updatedBy: 'user',
    });
  });

  test('reverting area during a conflict sends a request, closes after it, and puts the note in the person area', async ({ page }) => {
    const { id, root } = movedWorkspace();
    const plan = await api(id, 'plan');
    const loadFast = plan.checkpoints.find((c: any) => c.title === 'Report rows load fast');
    const csv = plan.checkpoints.find((c: any) => c.title === 'Reports export to CSV');
    const docs = plan.checkpoints.find((c: any) => c.title === 'Docs');
    const note = (await api(id, 'board')).cards[0];
    // Start with no step so reverting area back to csv matches every starting field
    aiApplies(root, [{ op: 'card.update', id: note.id, step: null }]);

    const saveRequests: any[] = [];
    let saveResponses = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes(`/api/workspace/${id}/board/changes`)) {
        try { saveRequests.push(req.postDataJSON()); } catch { /* ignore */ }
      }
    });
    page.on('response', (res) => {
      if (res.request().method() === 'POST' && res.url().includes(`/api/workspace/${id}/board/changes`)) {
        saveResponses += 1;
      }
    });

    await openBoard(page, id, root);
    await stepInto(page, /Reports export to CSV/);

    const card = page.locator('#board-area').getByRole('article', { name: 'Export leaks memory' });
    await card.dblclick();
    const dialog = page.getByRole('dialog');
    const areaSelect = dialog.getByLabel('Area');
    await expect(areaSelect).toHaveValue(`checkpoint:${csv.key}`);
    await areaSelect.selectOption(`checkpoint:${docs.key}`);

    // AI moves the note to another checkpoint while the dialog is open
    aiApplies(root, [{ op: 'card.update', id: note.id, area: `checkpoint:${loadFast.key}`, step: null }]);

    await dialog.getByRole('button', { name: 'Save changes' }).click();
    const conflict = dialog.getByTestId('note-conflict');
    await expect(conflict).toBeVisible();

    // Person switches area back to the starting area and clicks "Save yours over theirs"
    await areaSelect.selectOption(`checkpoint:${csv.key}`);
    const reqsBefore = saveRequests.length;
    const respsBefore = saveResponses;
    await conflict.getByRole('button', { name: 'Save yours over theirs' }).click();
    await expect(dialog).toHaveCount(0);

    expect(saveRequests.length).toBe(reqsBefore + 1);
    expect(saveResponses).toBe(respsBefore + 1);
    expect(saveRequests.at(-1)?.changes?.[0]).toEqual({
      op: 'update_card',
      id: note.id,
      rev: 3,
      area: `checkpoint:${csv.key}`,
    });
    const after = (await api(id, 'board')).cards.find((c: any) => c.id === note.id);
    expect(after).toMatchObject({
      area: `checkpoint:${csv.key}`,
      rev: 4,
      updatedBy: 'user',
    });
  });

  test('editing two fields and reverting one during a conflict saves both of the person values', async ({ page }) => {
    const { id, root } = movedWorkspace();
    const note = (await api(id, 'board')).cards[0];
    await openBoard(page, id, root);
    await stepInto(page, /Reports export to CSV/);

    const card = page.locator('#board-area').getByRole('article', { name: 'Export leaks memory' });
    await card.dblclick();
    const dialog = page.getByRole('dialog');
    const title = dialog.getByPlaceholder('Note title...');
    const body = dialog.getByPlaceholder('Write Markdown, lists, notes, or links...');
    await expect(title).toHaveValue('Export leaks memory');
    await title.fill('Draft title');
    await body.fill('My updated body');

    aiApplies(root, [{ op: 'card.update', id: note.id, title: 'AI renamed title', body: 'AI body text', pinned: true }]);

    await dialog.getByRole('button', { name: 'Save changes' }).click();
    const conflict = dialog.getByTestId('note-conflict');
    await expect(conflict).toBeVisible();

    // Person reverts title back to the starting value, keeps the new body, and saves over theirs
    await title.fill('Export leaks memory');
    await conflict.getByRole('button', { name: 'Save yours over theirs' }).click();
    await expect(dialog).toHaveCount(0);

    const after = (await api(id, 'board')).cards.find((c: any) => c.id === note.id);
    expect(after).toMatchObject({
      title: 'Export leaks memory',
      body: 'My updated body',
      pinned: true,
      rev: 3,
      updatedBy: 'user',
    });
  });

  test('Save yours over theirs when no touched field differs says so in the panel and keeps the dialog open', async ({ page }) => {
    const { id, root } = movedWorkspace();
    const note = (await api(id, 'board')).cards[0];
    const saveRequests: any[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes(`/api/workspace/${id}/board/changes`)) {
        try { saveRequests.push(req.postDataJSON()); } catch { /* ignore */ }
      }
    });

    await openBoard(page, id, root);
    await stepInto(page, /Reports export to CSV/);

    const card = page.locator('#board-area').getByRole('article', { name: 'Export leaks memory' });
    await card.dblclick();
    const dialog = page.getByRole('dialog');
    const body = dialog.getByPlaceholder('Write Markdown, lists, notes, or links...');
    await body.fill('Temp draft');

    // AI changes only pinned (leaving body at the starting value)
    aiApplies(root, [{ op: 'card.update', id: note.id, pinned: true }]);

    await dialog.getByRole('button', { name: 'Save changes' }).click();
    const conflict = dialog.getByTestId('note-conflict');
    await expect(conflict).toBeVisible();

    // Person reverts body back to starting value (same as theirs) and clicks Save yours over theirs
    await body.fill('Rows are buffered whole.');
    const reqsBefore = saveRequests.length;
    await conflict.getByRole('button', { name: 'Save yours over theirs' }).click();

    await expect(dialog).toBeVisible();
    await expect(conflict).toContainText('Your version is the same as theirs');
    expect(saveRequests.length).toBe(reqsBefore);
    const after = (await api(id, 'board')).cards.find((c: any) => c.id === note.id);
    expect(after).toMatchObject({ body: 'Rows are buffered whole.', pinned: true, rev: 2 });

    // Editing body afterwards clears the message and lets Save yours over theirs succeed
    await body.fill('Now genuinely different.');
    await expect(conflict).not.toContainText('Your version is the same as theirs');
    await conflict.getByRole('button', { name: 'Save yours over theirs' }).click();
    await expect(dialog).toHaveCount(0);
    const finalCard = (await api(id, 'board')).cards.find((c: any) => c.id === note.id);
    expect(finalCard).toMatchObject({ body: 'Now genuinely different.', pinned: true, rev: 3 });
  });
});
