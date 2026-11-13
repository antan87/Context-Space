/**
 * The Assignment card (slice AS): at the top of the Board overview, under the Now line, the assignment's description and its specs. Pressing it opens a
 * panel to edit the description and to add a spec (pasted text or a Markdown/text file). Everything is mocked with `page.route`; the real write is
 * checked by hand against a scratch workspace. What is typed is never lost: a refetch, closing the panel, a reload and a 409 all leave it.
 */
import fs from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { boardFile } from './planData';
import { board, document, isWithin, minutesAgo, routeBoard, routeCards, stepIntoArea, viewAtRest, workspace } from './boardHelpers';

test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

const PICS = process.env.AS_PICS ?? '';
async function shot(page: Page, name: string) {
  if (PICS) { fs.mkdirSync(PICS, { recursive: true }); await page.screenshot({ path: `${PICS}/${name}.png` }); }
}

const OBJECTIVE = 'Add CSV export to reports, with a download link on the report page.\nKeep it under a second for 50,000 rows.';
const REQUIREMENTS_TEXT = '# Customers export reports\n\nUp to 50,000 rows as CSV.';

interface Mock {
  guidance: { version: 1; revision: number; workType: string; size: string; assignment: Record<string, string>; documents: Array<Record<string, any>> };
  puts: any[];
  posts: any[];
  gets: number;
  contents: Record<string, string>;
  /** A status the next PUT answers with instead of saving. */
  putFails: Array<{ status: number; error: string }>;
  /** Someone else saves the description meanwhile. */
  externalSave: (objective: string) => void;
  /** How long the next PUT and POST wait before they answer, in ms. */
  delay: { put: number; post: number };
  /** The POST is applied at once but its answer is held for `delay.post`. */
  postAppliedFirst: boolean;
  /** Lets a plan event through the live stream: the board refetches the guidance. */
  refetch: () => void;
}

const context = (mock: Mock) => ({ guidance: mock.guidance, lifecycle: null, assignment: '', sharedDocuments: [] });

async function routeAssignment(page: Page, init: { objective?: string; expectedOutput?: string; stopCondition?: string; documents?: Array<Record<string, any>> } = {}): Promise<Mock> {
  const documents = init.documents ?? [document('Export requirements', { role: 'requirements', summary: 'Customers export their reports as CSV.', filename: 'contextspace-document-1.md', createdAt: minutesAgo(180) })];
  const mock: Mock = {
    guidance: {
      version: 1, revision: 1, workType: 'feature', size: 'epic', documents,
      assignment: { stage: 'design', objective: init.objective ?? OBJECTIVE, expectedOutput: init.expectedOutput ?? '', stopCondition: init.stopCondition ?? '', milestoneId: 'm1' },
    },
    puts: [], posts: [], gets: 0, putFails: [], delay: { put: 0, post: 0 }, postAppliedFirst: false,
    contents: { 'export-requirements': REQUIREMENTS_TEXT },
    externalSave: (objective) => { mock.guidance = { ...mock.guidance, revision: mock.guidance.revision + 1, assignment: { ...mock.guidance.assignment, objective } }; },
    refetch: () => {},
  };
  await page.addInitScript(() => { window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed'); });
  await routeBoard(page);
  await routeCards(page, boardFile({}));
  await page.route('**/api/workspace/demo/work', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') { mock.gets += 1; return route.fulfill({ json: context(mock) }); }
    const body = request.postDataJSON();
    mock.puts.push(body);
    if (mock.delay.put) await new Promise((resolve) => setTimeout(resolve, mock.delay.put));
    const fail = mock.putFails.shift();
    if (fail) return route.fulfill({ status: fail.status, json: { error: fail.error } });
    if (body.revision !== mock.guidance.revision) return route.fulfill({ status: 409, json: { error: 'The work guidance changed in another session. Reload before saving.' } });
    mock.guidance = { ...mock.guidance, revision: mock.guidance.revision + 1, workType: body.workType, size: body.size, assignment: body.assignment };
    return route.fulfill({ json: context(mock) });
  });
  await page.route('**/api/workspace/demo/work/documents', async (route) => {
    const body = route.request().postDataJSON();
    mock.posts.push(body);
    const wait = () => (mock.delay.post ? new Promise((resolve) => setTimeout(resolve, mock.delay.post)) : Promise.resolve());
    if (!mock.postAppliedFirst) await wait();
    if (body.revision !== mock.guidance.revision) return route.fulfill({ status: 409, json: { error: 'The work guidance changed in another session. Reload before saving.' } });
    const added = document(body.title, { role: body.role, status: body.status, scope: body.scope, summary: body.summary, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    mock.contents[added.id] = body.content;
    mock.guidance = { ...mock.guidance, revision: mock.guidance.revision + 1, documents: [...mock.guidance.documents, added] };
    const answer = context(mock);
    if (mock.postAppliedFirst) await wait();
    return route.fulfill({ json: answer });
  });
  await page.route('**/api/workspace/demo/work/documents/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const found = mock.guidance.documents.find((doc) => doc.id === id);
    const content = mock.contents[id];
    return found && content !== undefined ? route.fulfill({ json: { document: found, content, location: `/tmp/demo/${found.filename ?? id}` } }) : route.fulfill({ status: 400, json: { error: 'Source document not found.' } });
  });
  // A live stream that stays shut until the spec lets a plan event through, which makes the board read the guidance again
  const gate = new Promise<void>((resolve) => { mock.refetch = resolve; });
  await page.route('**/api/workspace/*/screen-events**', async (route) => {
    await gate;
    const at = new Date().toISOString();
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `retry: 60000\n\nevent: plan\nid: p1\ndata: ${JSON.stringify({ type: 'plan', timestamp: at })}\n\n` });
  });
  return mock;
}

const card = (page: Page) => page.getByTestId('assignment-card');
const main = (page: Page) => page.getByTestId('assignment-card-main');
const panel = (page: Page) => page.getByTestId('assignment-panel');
const chips = (page: Page) => card(page).locator('[data-spec-chip]');
const addSpecButton = (page: Page) => page.getByTestId('assignment-add-spec');
const description = (page: Page) => panel(page).getByRole('textbox', { name: 'Description', exact: true });
const form = (page: Page) => panel(page).getByRole('form', { name: 'Add spec' });
const reader = (page: Page) => board(page).getByRole('region', { name: 'Reader', exact: true });

async function openBoard(page: Page) {
  await page.goto('/#/workspaces/demo/board');
  await expect(card(page)).toBeVisible();
  await viewAtRest(page);
}
async function startEditing(page: Page, text?: string) {
  await main(page).click();
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Edit', exact: true }).click();
  if (text !== undefined) await description(page).fill(text);
}
const focusedIs = (locator: Locator) => expect(locator).toBeFocused();

test.describe('Board, the Assignment card', () => {
  test('sits under the Now line on the overview with the description, the specs and Add spec, and is not inside an Area', async ({ page }) => {
    await routeAssignment(page);
    await openBoard(page);
    await expect(card(page)).toContainText('Assignment');
    await expect(main(page)).toContainText('Add CSV export to reports, with a download link on the report page.');
    await expect(main(page)).not.toContainText('Keep it under a second');
    await expect(chips(page)).toHaveText(['Export requirements']);
    await expect(addSpecButton(page)).toHaveText('Add spec');
    // the chips and the Add spec are buttons beside the card, never inside its button
    await expect(main(page).locator('button')).toHaveCount(0);
    const [now, assignment] = await Promise.all([page.getByTestId('board-now-line').boundingBox(), card(page).boundingBox()]);
    expect(assignment!.y).toBeGreaterThanOrEqual(now!.y + now!.height - 1);
    expect(assignment!.height).toBeLessThanOrEqual(44);
    await shot(page, 'card-compact');
    await stepIntoArea(page, /Reports export to CSV/);
    await expect(card(page)).toBeHidden();
    await board(page).getByRole('button', { name: 'Board ›' }).click();
    await expect(card(page)).toBeVisible();
  });

  test('says No specs yet and No description yet, with Edit, when the assignment is empty', async ({ page }) => {
    await routeAssignment(page, { objective: '', documents: [] });
    await openBoard(page);
    await expect(main(page)).toContainText('No description yet');
    await expect(card(page)).toContainText('No specs yet');
    await expect(card(page).getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await card(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(description(page)).toBeFocused();
  });

  test('opens a panel with the full description, expected output, stop condition and the specs, and Close returns focus to the card', async ({ page }) => {
    await routeAssignment(page, { expectedOutput: 'A download button on the report page.', stopCondition: 'The export is reviewed.' });
    await openBoard(page);
    await main(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toContainText('Keep it under a second for 50,000 rows.');
    await expect(panel(page)).toContainText('Expected output: A download button on the report page.');
    await expect(panel(page)).toContainText('Stop when: The export is reviewed.');
    await expect(panel(page).getByRole('button', { name: /Export requirements/ })).toContainText('Customers export their reports as CSV.');
    await expect(panel(page).getByRole('button', { name: /Export requirements/ })).toContainText('3 h ago');
    // not a dialog over the whole app
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await shot(page, 'panel-open');
    await panel(page).getByRole('button', { name: 'Close the assignment' }).click();
    await expect(panel(page)).toHaveCount(0);
    await focusedIs(main(page));
  });

  test('edit and save sends only the description changed, and shows the new text', async ({ page }) => {
    const mock = await routeAssignment(page, { expectedOutput: 'A download button.' });
    await openBoard(page);
    await startEditing(page, 'Export reports as CSV, quickly.');
    await expect(panel(page).getByTestId('assignment-count')).toHaveText('31 / 4000');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(description(page)).toHaveCount(0);
    await expect(panel(page)).toContainText('Export reports as CSV, quickly.');
    await expect(main(page)).toContainText('Export reports as CSV, quickly.');
    expect(mock.puts).toEqual([{
      revision: 1, workType: 'feature', size: 'epic',
      assignment: { stage: 'design', objective: 'Export reports as CSV, quickly.', expectedOutput: 'A download button.', stopCondition: '', milestoneId: 'm1' },
    }]);
    // a saved description leaves no draft behind
    expect(await page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.includes('brief-draft')))).toEqual([]);
  });

  test('a description over 4000 characters is not sent', async ({ page }) => {
    const mock = await routeAssignment(page);
    await openBoard(page);
    await startEditing(page, 'x'.repeat(4005));
    await expect(panel(page).getByTestId('assignment-count')).toHaveText('4005 / 4000');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toContainText('5 characters over');
    expect(mock.puts).toEqual([]);
  });

  test('a failed save keeps everything typed and says so, and the next save goes through', async ({ page }) => {
    const mock = await routeAssignment(page);
    mock.putFails.push({ status: 500, error: 'The disk is full' });
    await openBoard(page);
    await startEditing(page, 'My typed description');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toContainText('Not saved: The disk is full');
    await expect(description(page)).toHaveValue('My typed description');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(description(page)).toHaveCount(0);
    await expect(panel(page)).toContainText('My typed description');
    expect(mock.puts).toHaveLength(2);
  });

  test('a 409 keeps the typed text and offers both ways; keeping mine puts it on top of the newer version', async ({ page }) => {
    const mock = await routeAssignment(page);
    await openBoard(page);
    await startEditing(page, 'My version of the description');
    mock.externalSave('Their version of the description');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    const notice = panel(page).getByRole('region', { name: /edits conflict/ });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Yours: My version of the description');
    await expect(notice).toContainText('Saved: Their version of the description');
    // nothing was applied silently: the typed text is still there and the saved one was not saved over
    await expect(description(page)).toHaveValue('My version of the description');
    await shot(page, 'conflict');
    await notice.getByRole('button', { name: 'Keep my description edits' }).click();
    await expect(notice).toHaveCount(0);
    await expect(description(page)).toHaveValue('My version of the description');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel(page)).toContainText('My version of the description');
    expect(mock.puts.at(-1).revision).toBe(2);
    expect(mock.guidance.assignment.objective).toBe('My version of the description');
  });

  test('a 409 with "use the saved one" drops the typed text and shows what was saved', async ({ page }) => {
    const mock = await routeAssignment(page);
    await openBoard(page);
    await startEditing(page, 'My version of the description');
    mock.externalSave('Their version of the description');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Use the saved description' }).click();
    await expect(description(page)).toHaveCount(0);
    await expect(panel(page)).toContainText('Their version of the description');
    expect(mock.guidance.assignment.objective).toBe('Their version of the description');
    expect(await page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.includes('brief-draft')))).toEqual([]);
  });

  test('typed text survives a guidance refetch, closing and reopening, stepping into an Area and back, and a reload', async ({ page }) => {
    const mock = await routeAssignment(page);
    await openBoard(page);
    await startEditing(page, 'Half of a new description');
    // the guidance is read again (and has been saved by someone else meanwhile): the textarea is not reset
    const before = mock.gets;
    mock.externalSave('Someone else wrote this');
    mock.refetch();
    await expect.poll(() => mock.gets).toBeGreaterThan(before);
    await expect(description(page)).toHaveValue('Half of a new description');
    // closing and opening the panel
    await description(page).press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(main(page)).toContainText('Unsaved');
    await main(page).click();
    await expect(description(page)).toHaveValue('Half of a new description');
    // into an Area and back
    await panel(page).getByRole('button', { name: 'Close the assignment' }).click();
    await stepIntoArea(page, /Reports export to CSV/);
    await board(page).getByRole('button', { name: 'Board ›' }).click();
    await main(page).click();
    await expect(description(page)).toHaveValue('Half of a new description');
    // a reload, and another screen of the workspace and back, find it in the draft kept on this device
    await page.reload();
    await expect(card(page)).toBeVisible();
    await expect(main(page)).toContainText('Unsaved');
    await main(page).click();
    await expect(description(page)).toHaveValue('Half of a new description');
    await page.goto('/#/workspaces/demo/overview');
    await page.goto('/#/workspaces/demo/board');
    await expect(card(page)).toBeVisible();
    await main(page).click();
    await expect(description(page)).toHaveValue('Half of a new description');
    // and it is a conflict with what the other person saved, not applied on top of it silently
    await expect(panel(page).getByRole('region', { name: /edits conflict/ })).toBeVisible();
  });

  test('Add spec with pasted text sends the right POST and the chip appears', async ({ page }) => {
    const mock = await routeAssignment(page);
    await openBoard(page);
    await addSpecButton(page).click();
    await expect(form(page)).toBeVisible();
    await expect(form(page)).toContainText('The text is copied in. It does not follow later edits to the file.');
    await form(page).getByLabel('Title').fill('Pricing rules');
    await form(page).getByLabel('Spec text').fill('# Pricing\n\nFree under 100 rows.');
    await form(page).getByLabel('Summary (optional)').fill('How exports are priced');
    await shot(page, 'add-spec-form');
    await form(page).getByRole('button', { name: 'Add spec', exact: true }).click();
    await expect(chips(page)).toHaveText(['Export requirements', 'Pricing rules']);
    await expect(form(page)).toHaveCount(0);
    expect(mock.posts).toEqual([{ revision: 1, title: 'Pricing rules', role: 'requirements', status: 'approved', scope: {}, summary: 'How exports are priced', content: '# Pricing\n\nFree under 100 rows.' }]);
    await expect(panel(page).getByRole('button', { name: /Pricing rules/ })).toContainText('just now');
    expect(await page.evaluate(() => Object.keys(window.sessionStorage).filter((key) => key.includes('brief-draft')))).toEqual([]);
  });

  test('uploading a .md fills the title from the file name and the text, then adds it', async ({ page }) => {
    const mock = await routeAssignment(page);
    await openBoard(page);
    await addSpecButton(page).click();
    await form(page).getByTestId('assignment-spec-file').setInputFiles({ name: 'Billing notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Billing\n\nInvoices on the 1st.') });
    await expect(form(page).getByLabel('Title')).toHaveValue('Billing notes');
    await expect(form(page).getByLabel('Spec text')).toHaveValue('# Billing\n\nInvoices on the 1st.');
    await form(page).getByRole('button', { name: 'Add spec', exact: true }).click();
    await expect(chips(page)).toContainText(['Export requirements', 'Billing notes']);
    expect(mock.posts).toHaveLength(1);
    expect(mock.posts[0]).toMatchObject({ title: 'Billing notes', content: '# Billing\n\nInvoices on the 1st.', role: 'requirements', status: 'approved', scope: {} });
  });

  test('a title that was typed is kept when a file is uploaded', async ({ page }) => {
    await routeAssignment(page);
    await openBoard(page);
    await addSpecButton(page).click();
    await form(page).getByLabel('Title').fill('My own title');
    await form(page).getByTestId('assignment-spec-file').setInputFiles({ name: 'other.txt', mimeType: 'text/plain', buffer: Buffer.from('Some text') });
    await expect(form(page).getByLabel('Title')).toHaveValue('My own title');
    await expect(form(page).getByLabel('Spec text')).toHaveValue('Some text');
  });

  test('a .pdf, a binary file and a file over 500,000 characters are refused with a message, and nothing is sent', async ({ page }) => {
    const mock = await routeAssignment(page);
    await openBoard(page);
    await addSpecButton(page).click();
    const file = form(page).getByTestId('assignment-spec-file');
    await file.setInputFiles({ name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 binary') });
    await expect(form(page).getByRole('alert')).toContainText('"plan.pdf" is not a Markdown or text file');
    await expect(form(page).getByLabel('Title')).toHaveValue('');
    await file.setInputFiles({ name: 'binary.txt', mimeType: 'text/plain', buffer: Buffer.from([0x41, 0x00, 0x42]) });
    await expect(form(page).getByRole('alert')).toContainText('not a text file');
    await file.setInputFiles({ name: 'huge.md', mimeType: 'text/markdown', buffer: Buffer.alloc(500_001, 'a') });
    await expect(form(page).getByRole('alert')).toContainText('500,000');
    await expect(form(page).getByLabel('Spec text')).toHaveValue('');
    // pasted text over the limit is refused when it is added
    await form(page).getByLabel('Title').fill('Too long');
    await form(page).getByLabel('Spec text').fill('b'.repeat(500_001));
    await form(page).getByRole('button', { name: 'Add spec', exact: true }).click();
    await expect(form(page).getByRole('alert')).toContainText('500,000');
    expect(mock.posts).toEqual([]);
  });

  test('Add spec needs a title and some text', async ({ page }) => {
    const mock = await routeAssignment(page);
    await openBoard(page);
    await addSpecButton(page).click();
    await form(page).getByRole('button', { name: 'Add spec', exact: true }).click();
    await expect(form(page).getByRole('alert')).toContainText('Give the spec a title.');
    await form(page).getByLabel('Title').fill('Only a title');
    await form(page).getByRole('button', { name: 'Add spec', exact: true }).click();
    await expect(form(page).getByRole('alert')).toContainText('Paste the spec text');
    expect(mock.posts).toEqual([]);
  });

  test('the Add spec form survives closing the panel, stepping into an Area and a reload, and a failed add keeps it', async ({ page }) => {
    const mock = await routeAssignment(page);
    await openBoard(page);
    await addSpecButton(page).click();
    await form(page).getByLabel('Title').fill('Draft spec');
    await form(page).getByLabel('Spec text').fill('Text that must not be lost');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await focusedIs(addSpecButton(page));
    await stepIntoArea(page, /Reports export to CSV/);
    await board(page).getByRole('button', { name: 'Board ›' }).click();
    await addSpecButton(page).click();
    await expect(form(page).getByLabel('Spec text')).toHaveValue('Text that must not be lost');
    // someone saved the description meanwhile: the add is refused with the stale revision, and the text stays
    mock.externalSave('Changed by someone');
    await form(page).getByRole('button', { name: 'Add spec', exact: true }).click();
    await expect(form(page).getByRole('alert')).toContainText('press Add spec again');
    await expect(form(page).getByLabel('Spec text')).toHaveValue('Text that must not be lost');
    await page.reload();
    await expect(card(page)).toBeVisible();
    await addSpecButton(page).click();
    await expect(form(page).getByLabel('Title')).toHaveValue('Draft spec');
    await expect(form(page).getByLabel('Spec text')).toHaveValue('Text that must not be lost');
    await form(page).getByRole('button', { name: 'Add spec', exact: true }).click();
    await expect(chips(page)).toContainText(['Export requirements', 'Draft spec']);
    expect(mock.posts.at(-1).revision).toBe(2);
  });

  test('a spec chip opens the Board reader on that source, and the panel steps aside', async ({ page }) => {
    await routeAssignment(page);
    await openBoard(page);
    await chips(page).first().click();
    await expect(reader(page)).toBeVisible();
    await expect(reader(page).getByRole('heading', { name: 'Export requirements', level: 2 })).toBeVisible();
    await expect(reader(page)).toContainText('Up to 50,000 rows as CSV.');
    await shot(page, 'reader-from-chip');
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await focusedIs(chips(page).first());
  });

  test('a spec line in the panel opens the reader, the panel steps aside, and Escape from the reader returns to the card', async ({ page }) => {
    await routeAssignment(page);
    await openBoard(page);
    await main(page).click();
    await panel(page).getByRole('button', { name: /Export requirements/ }).click();
    await expect(reader(page)).toContainText('Up to 50,000 rows as CSV.');
    await expect(panel(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="assignment-card"]') !== null)).toBe(true);
  });

  test('Escape closes the panel and returns focus to what opened it', async ({ page }) => {
    await routeAssignment(page);
    await openBoard(page);
    await main(page).click();
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await focusedIs(main(page));
    await addSpecButton(page).click();
    await expect(form(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await focusedIs(addSpecButton(page));
    // Escape in the panel closes only the panel: the board stays where it was
    await expect(card(page)).toBeVisible();
  });

  test('Escape closes the panel when the keyboard fell to the page after a form closed', async ({ page }) => {
    await routeAssignment(page);
    await openBoard(page);
    await addSpecButton(page).click();
    await form(page).getByLabel('Title').fill('Short spec');
    await form(page).getByLabel('Spec text').fill('Some text');
    await form(page).getByRole('button', { name: 'Add spec', exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="assignment-card"]') !== null)).toBe(true);
  });

  test('editing, adding a spec in the same panel and saving is one PUT on the new revision, with no conflict', async ({ page }) => {
    const mock = await routeAssignment(page);
    await openBoard(page);
    await startEditing(page, 'My new description');
    await panel(page).getByRole('button', { name: /Add spec/ }).first().click();
    await form(page).getByLabel('Title').fill('Extra spec');
    await form(page).getByLabel('Spec text').fill('Extra text');
    await form(page).getByRole('button', { name: 'Add spec', exact: true }).click();
    await expect(chips(page)).toContainText(['Export requirements', 'Extra spec']);
    await expect(description(page)).toHaveValue('My new description');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(description(page)).toHaveCount(0);
    await expect(panel(page).getByRole('region', { name: /edits conflict/ })).toHaveCount(0);
    expect(mock.puts).toHaveLength(1);
    expect(mock.puts[0].revision).toBe(2);
    expect(mock.guidance.assignment.objective).toBe('My new description');
  });

  test('a save that meets a revision moved by someone else without touching the assignment goes through; a real change still shows the choice', async ({ page }) => {
    const mock = await routeAssignment(page);
    await openBoard(page);
    await startEditing(page, 'Mine');
    // only the revision moved (nothing in the assignment changed)
    mock.guidance = { ...mock.guidance, revision: mock.guidance.revision + 1 };
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(description(page)).toHaveCount(0);
    expect(mock.puts.map((put) => put.revision)).toEqual([1, 2]);
    // a real change by someone else
    await panel(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await description(page).fill('Mine again');
    mock.externalSave('Theirs');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel(page).getByRole('region', { name: /edits conflict/ })).toBeVisible();
    await expect(description(page)).toHaveValue('Mine again');
  });

  test('the description cannot take text while it is being saved, and a 409 keeps the latest text', async ({ page }) => {
    const mock = await routeAssignment(page);
    mock.delay.put = 1200;
    await openBoard(page);
    await startEditing(page, 'First part');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(description(page)).toHaveAttribute('readonly', '');
    await description(page).focus();
    await page.keyboard.type(' typed while saving');
    await expect(description(page)).toHaveValue('First part');
    await expect(panel(page)).toContainText('Description saved.');
    expect(mock.guidance.assignment.objective).toBe('First part');
    // a 409 while saving keeps the text that is in the box
    await panel(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await description(page).fill('Second part');
    mock.externalSave('Theirs');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(description(page)).toHaveAttribute('readonly', '');
    const notice = panel(page).getByRole('region', { name: /edits conflict/ });
    await expect(notice).toContainText('Yours: Second part');
    await expect(description(page)).toHaveValue('Second part');
  });

  test('the Add spec fields cannot change while the spec is being added', async ({ page }) => {
    const mock = await routeAssignment(page);
    mock.delay.post = 1200;
    await openBoard(page);
    await addSpecButton(page).click();
    await form(page).getByLabel('Title').fill('Spec A');
    await form(page).getByLabel('Spec text').fill('Body A');
    await form(page).getByRole('button', { name: 'Add spec', exact: true }).click();
    await expect(form(page).getByLabel('Spec text')).toBeDisabled();
    await expect(form(page).getByLabel('Title')).toBeDisabled();
    await expect(form(page).getByLabel('Summary (optional)')).toBeDisabled();
    await expect(form(page).getByTestId('assignment-spec-file')).toBeDisabled();
    await expect(chips(page)).toContainText(['Export requirements', 'Spec A']);
    expect(mock.posts[0].content).toBe('Body A');
    await expect(form(page)).toHaveCount(0);
  });

  test('focus stays in the panel: Edit goes to the textarea, Cancel and Save to Edit, Add spec to Title, and a closed form to Add spec', async ({ page }) => {
    await routeAssignment(page);
    await openBoard(page);
    await main(page).click();
    const edit = panel(page).getByRole('button', { name: 'Edit', exact: true });
    await edit.click();
    await expect(description(page)).toBeFocused();
    await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(edit).toBeFocused();
    await edit.click();
    await description(page).fill('Saved text');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(edit).toBeFocused();
    const add = panel(page).getByRole('button', { name: /Add spec/ }).first();
    await add.click();
    await expect(form(page).getByLabel('Title')).toBeFocused();
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(add).toBeFocused();
    await add.click();
    await form(page).getByLabel('Title').fill('T');
    await form(page).getByLabel('Spec text').fill('Body');
    await form(page).getByRole('button', { name: 'Add spec', exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    await expect(add).toBeFocused();
  });

  test('a slow save or add does not take the keyboard from where the person went', async ({ page }) => {
    const mock = await routeAssignment(page);
    mock.delay.put = 1200;
    mock.delay.post = 1200;
    await openBoard(page);
    await page.evaluate(() => { const input = document.createElement('input'); input.id = 'outside'; input.setAttribute('aria-label', 'Outside field'); document.body.appendChild(input); });
    const outside = page.locator('#outside');
    await startEditing(page, 'First part');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await outside.focus();
    await page.keyboard.type('typed elsewhere');
    await expect(panel(page)).toContainText('Description saved.');
    await expect(outside).toBeFocused();
    await page.keyboard.type(' and more');
    await expect(outside).toHaveValue('typed elsewhere and more');
    expect(mock.guidance.assignment.objective).toBe('First part');
    expect(await page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.includes('brief-draft')))).toEqual([]);
    // the same after a slow Add spec
    await panel(page).getByRole('button', { name: /Add spec/ }).first().click();
    await form(page).getByLabel('Title').fill('Slow spec');
    await form(page).getByLabel('Spec text').fill('Body');
    await form(page).getByRole('button', { name: 'Add spec', exact: true }).click();
    await outside.focus();
    await page.keyboard.type(' again');
    await expect(chips(page)).toContainText(['Export requirements', 'Slow spec']);
    await expect(outside).toBeFocused();
    await expect(outside).toHaveValue('typed elsewhere and more again');
    // a pending move does not replay when the panel is opened again
    await panel(page).getByRole('button', { name: 'Close the assignment' }).click();
    await main(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toBeFocused();
  });

  test('a late Add spec answer after the description was saved does not reopen an empty edit or put an older revision back', async ({ page }) => {
    const mock = await routeAssignment(page);
    mock.postAppliedFirst = true;
    mock.delay.post = 1500;
    await openBoard(page);
    await startEditing(page, 'My text');
    await panel(page).getByRole('button', { name: /Add spec/ }).first().click();
    await form(page).getByLabel('Title').fill('Late spec');
    await form(page).getByLabel('Spec text').fill('Body');
    await form(page).getByRole('button', { name: 'Add spec', exact: true }).click();
    // the description is saved while the answer is still on its way: the first PUT meets a revision-only 409 and goes again
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel(page)).toContainText('Description saved.');
    // then the late answer arrives and the form closes
    await expect(form(page)).toHaveCount(0, { timeout: 8000 });
    await page.waitForTimeout(400);
    await expect(chips(page)).toContainText(['Export requirements', 'Late spec']);
    await expect(description(page)).toHaveCount(0);
    await expect(main(page)).toContainText('My text');
    expect(mock.puts.map((put) => put.revision)).toEqual([1, 2]);
    expect(await page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.includes('brief-draft')))).toEqual([]);
    await expect(panel(page).getByRole('region', { name: /edits conflict/ })).toHaveCount(0);
  });

  test('the overview stage keeps its size while an Area is open and after stepping back, so a restored view is not cut off', async ({ page }) => {
    await routeAssignment(page);
    await openBoard(page);
    const stage = page.locator('#board-overview .react-flow');
    // the layout height: the plane behind an Area is scaled down, which a bounding box would show
    const height = () => stage.evaluate((el) => (el as HTMLElement).offsetHeight);
    const before = await height();
    await stepIntoArea(page, /Reports export to CSV/);
    expect(await height(), 'the stage behind the Area is as tall as it was').toBe(before);
    await board(page).getByRole('button', { name: 'Board ›' }).click();
    await viewAtRest(page);
    expect(await height()).toBe(before);
  });

  test('[, ] and / typed into the description stay in the textarea', async ({ page }) => {
    await routeAssignment(page);
    await openBoard(page);
    await startEditing(page, '');
    await description(page).focus();
    await page.keyboard.type('a[b]c/d e');
    await page.keyboard.press('ArrowLeft');
    await expect(description(page)).toHaveValue('a[b]c/d e');
    await expect(description(page)).toBeFocused();
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    // the same in the Add spec fields
    await panel(page).getByRole('button', { name: 'Cancel', exact: true }).first().click();
    await panel(page).getByRole('button', { name: 'Add spec' }).first().click();
    await form(page).getByLabel('Spec text').focus();
    await page.keyboard.type('[1]/ ');
    await expect(form(page).getByLabel('Spec text')).toHaveValue('[1]/ ');
    await expect(form(page).getByLabel('Spec text')).toBeFocused();
  });

  test('the panel is gone from the page while it is closed: it takes no keys and holds no focus', async ({ page }) => {
    await routeAssignment(page);
    await openBoard(page);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Description' })).toHaveCount(0);
    await stepIntoArea(page, /Reports export to CSV/);
    await expect(page.getByTestId('assignment-card-wrap')).toBeHidden();
    expect(await page.getByTestId('assignment-card-wrap').evaluate((el) => el.hasAttribute('inert'))).toBe(true);
  });

  test('keeps the overview on one screen at 1100x700: its rows and fold are whole inside the stage, and the card is one line', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await routeAssignment(page);
    await openBoard(page);
    const overview = board(page).locator('#board-overview');
    const flow = overview.locator('.react-flow');
    const shown = overview.locator('button.board-area, button.board-area-fold');
    const count = await shown.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) await expect.poll(() => isWithin(shown.nth(i), flow)).toBe(true);
    expect((await card(page).boundingBox())!.height).toBeLessThanOrEqual(44);
    expect(await isWithin(main(page), card(page))).toBe(true);
    // opening the panel leaves the rows where they were
    const rows = await shown.last().boundingBox();
    await main(page).click();
    expect((await shown.last().boundingBox())!.y).toBe(rows!.y);
    await shot(page, 'panel-1100');
  });

  test('stays one line and inside the pane at 420 px wide', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await routeAssignment(page);
    await openBoard(page);
    const box = (await card(page).boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(44);
    expect(box.width).toBeLessThanOrEqual(420);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.getByTestId('assignment-specs-count')).toHaveText('1 spec');
    await expect(addSpecButton(page)).toBeVisible();
    await shot(page, 'card-420');
    await page.getByTestId('assignment-specs-count').click();
    await expect(panel(page)).toBeVisible();
    await shot(page, 'panel-420');
  });
});

test.describe('Board, the Assignment card, in an archived workspace', () => {
  test.use({ workspacesData: [[{ ...workspace, archivedAt: '2026-09-28T10:00:00.000Z' }], { option: true }] });

  test('shows the text and the specs, with no Edit and no Add spec', async ({ page }) => {
    await routeAssignment(page, { expectedOutput: 'A download button.' });
    await page.goto('/#/workspaces/demo/board');
    await expect(card(page)).toBeVisible();
    await expect(addSpecButton(page)).toHaveCount(0);
    await expect(chips(page)).toHaveText(['Export requirements']);
    await main(page).click();
    await expect(panel(page)).toContainText('Keep it under a second for 50,000 rows.');
    await expect(panel(page)).toContainText('Expected output: A download button.');
    await expect(panel(page).getByRole('button', { name: /Export requirements/ })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: /Add spec/ })).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  });

  test('an empty assignment shows No description yet without Edit', async ({ page }) => {
    await routeAssignment(page, { objective: '', documents: [] });
    await page.goto('/#/workspaces/demo/board');
    await expect(main(page)).toContainText('No description yet');
    await expect(card(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  });
});
