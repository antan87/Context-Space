import type { Page, WebSocketRoute } from '@playwright/test';
import { test, expect } from './fixtures';
import { planItem, planView } from './planData';

/**
 * The Where Are We strip above the CLI chat: what it shows from checkable facts, the Reopen
 * action, and the rule that a button may type into the chat prompt but never press Enter.
 */
const workspace = { id: 'feature-x', branchName: 'feature-x', description: 'Speed up invoices', repos: ['C:/repo'], assistants: ['codex'], workspacePath: 'C:/ws/feature-x', createdAt: '2026-09-20T00:00:00Z' };
const terminal = { id: '0199a213-81c0-7800-8aa1-bbab2a035a50', workspace: 'feature-x', target: 'shell', label: 'bash', cwd: workspace.workspacePath, state: 'running' };

test.use({ workspacesData: [workspace], viewport: { width: 1450, height: 950 } });

type State = 'done' | 'in_progress' | 'reopened' | 'blocked' | 'upcoming';
const milestone = (id: string, title: string, state: State, extra: Record<string, unknown> = {}) =>
  ({ id, title, state, verified: false, reopenCount: 0, waitingOn: [], ...extra });

function factsBody(options: { reopened?: boolean; question?: boolean } = {}) {
  const milestones = [
    options.reopened
      ? milestone('a', 'Cache invoice lookups', 'reopened', { reopen: { at: '2026-10-02T11:50:00.000Z', reason: 'Misses the expiry case', by: 'user' }, reopenCount: 1 })
      : milestone('a', 'Cache invoice lookups', 'done', { verified: true, completedAt: '2026-10-02T09:00:00.000Z' }),
    milestone('b', 'Add cache tests', 'in_progress'),
    milestone('c', 'Document the cache', 'upcoming', { waitingOn: ['b'] }),
  ];
  const count = (state: State) => milestones.filter((m) => m.state === state).length;
  return { facts: {
    workspaceId: 'feature-x', generatedAt: '2026-10-02T12:00:00.000Z', milestones, currentMilestoneId: 'b',
    counts: { total: 3, done: count('done'), inProgress: count('in_progress'), reopened: count('reopened'), blocked: 0, upcoming: count('upcoming') },
    openQuestions: options.question ? [{ id: 'q1', timestamp: '2026-10-02T11:00:00.000Z', harness: 'claude', message: 'Which cache backend should we use?', options: ['Redis', 'In memory'] }] : [],
    changes: { repos: [{ repoName: 'repo', files: 2, additions: 12, deletions: 3 }], files: 2, additions: 12, deletions: 3 },
    verification: { status: 'pass', freshness: 'fresh', verifiedAt: '2026-10-02T11:00:00.000Z' }, unavailable: [],
  } };
}

/** One SSE frame, in the form the backend streams. The JSON keeps any control character escaped, so a frame is always one line. */
const frame = (type: string, body: Record<string, unknown>, id: string) => `event: ${type}\nid: ${id}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const nextFrame = (title: string, extra: Record<string, unknown> = {}) =>
  frame('screen', { event: { id: 'n1', timestamp: '2026-10-02T11:30:00.000Z', harness: 'claude', event: 'next', payload: { title, reason: 'The cache has no tests yet', ...extra } } }, '2026-10-02T11:30:00.000Z');

interface Chat { typed: string[]; messages: unknown[] }

/** Opens the CLI chat on a workspace whose terminal is connected, recording everything the page types into it. */
async function openChat(page: Page, options: { facts?: ReturnType<typeof factsBody> | (() => ReturnType<typeof factsBody>); events?: string; target?: 'shell' | 'claude' | 'codex' } = {}): Promise<Chat> {
  const chat: Chat = { typed: [], messages: [] };
  const session = { ...terminal, target: options.target ?? 'shell', label: { shell: 'bash', claude: 'Claude Code', codex: 'Codex' }[options.target ?? 'shell'] };
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({ json: { available: true, sessions: [session], targets: [{ id: session.target, name: session.label, available: true, reason: null }] } }));
  await page.route('**/api/workspace/feature-x/progress-facts', (route) => route.fulfill({ json: typeof options.facts === 'function' ? options.facts() : options.facts ?? factsBody() }));
  if (options.events) await page.route('**/api/workspace/feature-x/screen-events**', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: options.events }));
  await page.routeWebSocket('**/ws/terminal', (socket: WebSocketRoute) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      chat.messages.push(parsed);
      if (parsed.type === 'input') chat.typed.push(parsed.data);
      if (parsed.type !== 'attach') return;
      socket.send(JSON.stringify({ type: 'ready', terminal: session, truncated: false }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  await expect(page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-state')).toHaveText('Running');
  return chat;
}

const strip = (page: Page) => page.getByRole('region', { name: 'Where are we', exact: true });

test('shows where the work stands above the chat, from facts', async ({ page }) => {
  await openChat(page, { facts: factsBody({ question: true }) });
  const bar = strip(page);
  await expect(bar).toContainText('Needs you');
  await expect(bar).toContainText('1 of 3 done');
  await expect(bar).toContainText('1 question');
  await expect(bar).toContainText('2 files changed');
  await expect(bar).toContainText('checks passed');
  // The chat is still right below it.
  await expect(page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-pane')).toBeVisible();
});

test('opens a panel with the goal, every milestone, what waits on the developer and the touched files', async ({ page }) => {
  await page.route('**/api/workspace/feature-x/changes', (route) => route.fulfill({ json: { changes: [{ repoName: 'repo', repoPath: 'C:/repo', files: [{ file: 'src/cache.ts', type: 'modified', additions: 10, deletions: 2 }, { file: 'src/cache.test.ts', type: 'added', additions: 2, deletions: 1 }] }] } }));
  await openChat(page, { facts: factsBody({ question: true }) });
  const toggle = strip(page).getByRole('button', { expanded: false });
  await toggle.click();
  const detail = page.getByRole('region', { name: 'Progress details' });
  await expect(detail.getByText('Cache invoice lookups', { exact: true })).toBeVisible();
  await expect(detail.getByText('Add cache tests', { exact: true })).toBeVisible();
  await expect(detail.getByText('Waiting on "Add cache tests"')).toBeVisible();
  await expect(detail.getByText('Which cache backend should we use?')).toBeVisible();
  await expect(detail.getByRole('button', { name: /src\/cache\.ts/ })).toBeVisible();
  // Only the finished milestone can be reopened.
  await expect(detail.getByRole('button', { name: /^Reopen "/ })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
});

test('closes the panel with Escape from inside it, and gives focus back to the strip', async ({ page }) => {
  await openChat(page);
  const toggle = strip(page).getByRole('button', { expanded: false });
  await toggle.click();
  const detail = page.getByRole('region', { name: 'Progress details' });
  await detail.getByRole('button', { name: /^Reopen "/ }).focus();
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(toggle).toBeFocused();
});

test('reopens a finished milestone with a reason, as the developer\'s own action', async ({ page }) => {
  let reopened = false;
  let body: unknown;
  await page.route('**/api/workspace/feature-x/lifecycle/reopen', async (route) => {
    body = route.request().postDataJSON();
    reopened = true;
    await route.fulfill({ json: { lifecycle: {} } });
  });
  const chat = await openChat(page, { facts: factsBody() });
  await page.route('**/api/workspace/feature-x/progress-facts', (route) => route.fulfill({ json: factsBody({ reopened }) }));
  await strip(page).getByRole('button', { expanded: false }).click();
  const detail = page.getByRole('region', { name: 'Progress details' });
  await detail.getByRole('button', { name: 'Reopen "Cache invoice lookups"' }).click();
  const submit = detail.getByRole('button', { name: 'Reopen milestone' });
  await expect(submit).toBeDisabled();
  await detail.getByLabel(/need rework/).fill('Misses the expiry case');
  await submit.click();
  await expect(detail.getByRole('status')).toContainText('is reopened');
  expect(body).toEqual({ stepId: 'a', reason: 'Misses the expiry case' });
  // The strip catches up from fresh facts, and says who reopened it and why.
  await expect(strip(page)).toContainText('Reopened');
  await expect(detail.getByText('Reopened by you')).toBeVisible();
  // Telling the AI only types into the prompt.
  await detail.getByRole('button', { name: 'Tell the AI' }).click();
  await expect.poll(() => chat.typed.at(-1)).toBe('Milestone "Cache invoice lookups" was reopened: Misses the expiry case. Please redo it.');
});

test('says why a reopen was refused and keeps what was typed', async ({ page }) => {
  await page.route('**/api/workspace/feature-x/lifecycle/reopen', (route) => route.fulfill({ status: 409, json: { error: 'That milestone is not finished.', code: 'not_completed' } }));
  await openChat(page);
  await strip(page).getByRole('button', { expanded: false }).click();
  const detail = page.getByRole('region', { name: 'Progress details' });
  await detail.getByRole('button', { name: /^Reopen "/ }).click();
  await detail.getByLabel(/need rework/).fill('Because');
  await detail.getByRole('button', { name: 'Reopen milestone' }).click();
  await expect(detail.getByRole('alert')).toContainText('That milestone is not finished.');
  await expect(detail.getByLabel(/need rework/)).toHaveValue('Because');
});

test('types the AI\'s suggestion into the prompt but never presses Enter', async ({ page }) => {
  // The suggestion arrives with a carriage return inside it, as hostile text would.
  const chat = await openChat(page, { events: nextFrame('Cover the cache\rEnter\nrm -rf') });
  const next = strip(page).getByRole('button', { name: /^Next: / });
  await expect(next).toBeVisible();
  await next.click();
  await expect.poll(() => chat.typed.length).toBe(1);
  expect(chat.typed[0]).toBe('Go ahead: Cover the cache Enter rm -rf');
  // Nothing typed may carry Enter, a line break or an escape.
  for (const typed of chat.typed) for (const key of ['\r', '\n', '\u001b']) expect(typed.includes(key)).toBe(false);
  await expect(strip(page)).toContainText('Press Enter to send it.');
});

/** The server's resolver: `repo/<path>` names a file in the repository `repo`. */
const resolveCache = (page: import('@playwright/test').Page) => page.route('**/api/workspace/feature-x/files/resolve?*', (route) => {
  const path = new URL(route.request().url()).searchParams.get('path') ?? '';
  const file = path.replace(/^repo\//, '');
  return route.fulfill({ json: { status: 'found', repoName: 'repo', repoPath: 'C:/repo', file } });
});

test('opens the file a suggestion points at', async ({ page }) => {
  const listing = { changes: [{ repoName: 'repo', repoPath: 'C:/repo', files: [{ file: 'src/cache.ts', type: 'modified', additions: 1, deletions: 0 }] }] };
  await page.route('**/api/workspace/feature-x/changes?include=all', (route) => route.fulfill({ json: listing }));
  await page.route('**/api/workspace/feature-x/changes', (route) => route.fulfill({ json: listing }));
  await page.route('**/api/workspace/feature-x/changes/diff?*', (route) => route.fulfill({ json: { diff: '', fileContent: 'export const cache = 1;\n', originalContent: '' } }));
  await resolveCache(page);
  const chat = await openChat(page, { events: nextFrame('Cover the cache', { path: 'src/cache.ts', repo: 'repo', line: 1 }) });
  await strip(page).getByRole('button', { name: /^Next: Cover the cache/ }).click();
  // The file opens in Code beside the chat, not in a second panel inside it.
  await expect(page.getByRole('region', { name: 'Workspace code' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'CLI Chat', exact: true }).getByRole('region', { name: 'Workspace code' })).toHaveCount(0);
  await expect.poll(() => chat.typed).toEqual(['Go ahead: Cover the cache']);
});

test('opens what the AI shows as it arrives, but not what it showed before the chat was opened', async ({ page }) => {
  const listing = { changes: [{ repoName: 'repo', repoPath: 'C:/repo', files: [{ file: 'src/cache.ts', type: 'modified', additions: 1, deletions: 0 }] }] };
  await page.route('**/api/workspace/feature-x/changes?include=all', (route) => route.fulfill({ json: listing }));
  await page.route('**/api/workspace/feature-x/changes', (route) => route.fulfill({ json: listing }));
  const opened: string[] = [];
  await page.route('**/api/workspace/feature-x/changes/diff?*', (route) => {
    opened.push(new URL(route.request().url()).searchParams.get('file') ?? '');
    return route.fulfill({ json: { diff: '', fileContent: 'export const cache = 1;\n', originalContent: '' } });
  });
  await resolveCache(page);
  const show = (id: string, timestamp: string, file: string) =>
    frame('screen', { event: { id, timestamp, harness: 'claude', event: 'show', payload: { view: 'file', path: file, repo: 'repo', line: 1 } } }, timestamp);
  const fresh = new Date(Date.now() + 60_000).toISOString();
  await openChat(page, { events: show('old', '2026-10-02T11:30:00.000Z', 'src/old.ts') + show('new', fresh, 'src/cache.ts') });
  await expect(page.getByRole('region', { name: 'Workspace code' })).toBeVisible();
  await expect.poll(() => opened).toContain('src/cache.ts');
  expect(opened).not.toContain('src/old.ts');
});

test('puts the answer to a question into the prompt when its option is chosen', async ({ page }) => {
  const chat = await openChat(page, { facts: factsBody({ question: true }) });
  // The question comes first, ahead of anything the AI suggested.
  await expect(strip(page).getByRole('button', { name: /^Next: Answer the question/ })).toBeVisible();
  await strip(page).getByRole('button', { name: /^Next: Answer the question/ }).click();
  const detail = page.getByRole('region', { name: 'Progress details' });
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: 'Redis' }).click();
  await expect.poll(() => chat.typed).toEqual(['Redis']);
});

test('records that the questions were answered, from the panel', async ({ page }) => {
  let acknowledged = false;
  await page.route('**/api/workspace/feature-x/input-requests/acknowledge', async (route) => { acknowledged = true; await route.fulfill({ json: { acknowledged: 1 } }); });
  await openChat(page, { facts: factsBody({ question: true }) });
  await strip(page).getByRole('button', { expanded: false }).click();
  await page.getByRole('region', { name: 'Progress details' }).getByRole('button', { name: 'I answered in the chat' }).click();
  await expect.poll(() => acknowledged).toBe(true);
});

test.describe('when the AI waits for an answer', () => {
  const answerBar = (page: Page) => page.getByRole('group', { name: 'The AI is waiting for your answer' });

  test('shows the question above the chat, with its suggested answers one click away', async ({ page }) => {
    const chat = await openChat(page, { facts: factsBody({ question: true }), target: 'claude' });
    await expect(answerBar(page)).toContainText('Which cache backend should we use?');
    await expect(answerBar(page)).toContainText('Pick one and press Enter, or type your own answer in the chat.');
    await answerBar(page).getByRole('group', { name: 'Suggested answers' }).getByRole('button', { name: 'Redis' }).click();
    // Typed, not sent: the developer presses Enter.
    await expect.poll(() => chat.typed).toEqual(['Redis']);
    await expect(strip(page)).toContainText('Press Enter to send it.');
  });

  test('the line the developer sends to the assistant answers it, and the question goes away', async ({ page }) => {
    let acknowledged = 0;
    await page.route('**/api/workspace/feature-x/input-requests/acknowledge', async (route) => { acknowledged++; await route.fulfill({ json: { acknowledged: 1 } }); });
    const chat = await openChat(page, { facts: () => factsBody({ question: acknowledged === 0 }), target: 'claude' });
    await expect(answerBar(page)).toBeVisible();
    await page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-pane').click();
    await page.keyboard.type('Redis');
    await page.keyboard.press('Enter');
    await expect.poll(() => acknowledged).toBe(1);
    await expect(answerBar(page)).toHaveCount(0);
    await expect(strip(page)).toContainText('Your reply answered the question.');
    expect(chat.typed.join('')).toBe('Redis\r');
    // Another line with no question open records nothing more.
    await page.keyboard.type('thanks');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    expect(acknowledged).toBe(1);
  });

  test('a line typed into a plain shell is not taken as the answer', async ({ page }) => {
    let acknowledged = 0;
    await page.route('**/api/workspace/feature-x/input-requests/acknowledge', async (route) => { acknowledged++; await route.fulfill({ json: { acknowledged: 1 } }); });
    await openChat(page, { facts: factsBody({ question: true }), target: 'shell' });
    await expect(answerBar(page)).toBeVisible();
    await page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-pane').click();
    await page.keyboard.type('ls');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    expect(acknowledged).toBe(0);
    await expect(answerBar(page)).toBeVisible();
  });

  test('a line sent to another assistant leaves the question for the one that asked', async ({ page }) => {
    let acknowledged = 0;
    await page.route('**/api/workspace/feature-x/input-requests/acknowledge', async (route) => { acknowledged++; await route.fulfill({ json: { acknowledged: 1 } }); });
    await openChat(page, { facts: factsBody({ question: true }), target: 'codex' });
    await expect(answerBar(page)).toBeVisible();
    await page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-pane').click();
    await page.keyboard.type('status?');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    expect(acknowledged).toBe(0);
    await expect(answerBar(page)).toBeVisible();
  });

  test('when the answer cannot be recorded, the next line tries again', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/workspace/feature-x/input-requests/acknowledge', async (route) => {
      calls++;
      // The failure comes back slowly, as on a busy machine: a reply sent before it is back is not a retry.
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 600));
      await (calls === 1 ? route.fulfill({ status: 500, json: { error: 'disk full' } }) : route.fulfill({ json: { acknowledged: 1 } }));
    });
    await openChat(page, { facts: () => factsBody({ question: calls < 2 }), target: 'claude' });
    await page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-pane').click();
    await page.keyboard.type('Redis');
    await page.keyboard.press('Enter');
    await expect.poll(() => calls).toBe(1);
    // Says so once the failure is back, and only then is the question open to the next reply.
    await expect(strip(page)).toContainText('Your reply could not be recorded as the answer. Your next reply tries again.');
    await expect(answerBar(page)).toBeVisible();
    await page.keyboard.type('Redis, please');
    await page.keyboard.press('Enter');
    await expect.poll(() => calls).toBe(2);
    await expect(answerBar(page)).toHaveCount(0);
  });

  test('the check marks it answered when the answer was given some other way', async ({ page }) => {
    let acknowledged = 0;
    await page.route('**/api/workspace/feature-x/input-requests/acknowledge', async (route) => { acknowledged++; await route.fulfill({ json: { acknowledged: 1 } }); });
    await openChat(page, { facts: () => factsBody({ question: acknowledged === 0 }) });
    await answerBar(page).getByRole('button', { name: 'I answered in the chat' }).click();
    await expect.poll(() => acknowledged).toBe(1);
    await expect(answerBar(page)).toHaveCount(0);
  });
});

test('says so when the facts cannot be loaded, and offers another try', async ({ page }) => {
  let fail = true;
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({ json: { available: true, sessions: [terminal], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }));
  await page.route('**/api/workspace/feature-x/progress-facts', (route) => (fail ? route.fulfill({ status: 500, json: { error: 'backend down' } }) : route.fulfill({ json: factsBody() })));
  await page.routeWebSocket('**/ws/terminal', () => undefined);
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  await expect(strip(page)).toContainText('Progress is unavailable');
  fail = false;
  await strip(page).getByRole('button', { name: 'Try again' }).click();
  await expect(strip(page)).toContainText('1 of 3 done');
});

test.describe('the plan in the chat', () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  /** The plan as the strip reads it, recording each change the chat sends. */
  async function routePlan(page: Page, plan: ReturnType<typeof planView>) {
    const changes: unknown[] = [];
    await page.route('**/api/workspace/feature-x/plan/items', (route) => {
      if (route.request().method() === 'POST') {
        changes.push(route.request().postDataJSON());
        return route.fulfill({ json: { message: 'Saved.', plan } });
      }
      return route.fulfill({ json: plan });
    });
    return changes;
  }

  test('keeps where the work stands in the session toolbar, so the chat has two bars above it', async ({ page }) => {
    await openChat(page);
    const pane = page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-pane');
    await expect(pane.getByRole('region', { name: 'Where are we', exact: true })).toContainText('Now · Add cache tests');
    await expect(pane.getByRole('tablist', { name: 'CLI sessions' })).toBeVisible();
  });

  test('asks a question from the plan above the chat, with who asked and what it holds up, and records the answer in the plan', async ({ page }) => {
    const changes = await routePlan(page, planView([
      planItem({ id: 'b', title: 'Add cache tests', status: 'in_progress' }),
      planItem({ id: 'Q1', kind: 'question', title: 'Should the cache expire at midnight?', owner: 'user', holdsUp: ['b Add cache tests'], history: [{ at: minutesAgo(3), by: 'codex', action: 'added' }] }),
    ]));
    await openChat(page);
    const question = page.getByRole('group', { name: 'A question in the plan waits for your answer' });
    await expect(question).toContainText('Codex asked 3 min ago · holds up Add cache tests');
    await expect(question).toContainText('Should the cache expire at midnight?');
    await expect(strip(page)).toContainText('Needs you');
    await question.getByLabel('Your answer to Should the cache expire at midnight?').fill('No, after an hour');
    await question.getByRole('button', { name: 'Answer' }).click();
    await expect.poll(() => changes).toEqual([{ change: { type: 'answer', id: 'Q1', answer: 'No, after an hour' }, ifRevision: 3 }]);
  });

  test('says what the AI closed while you were in the chat, and reopens it from there', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.removeItem('contextspace.strip.seen-closes.feature-x'));
    const changes = await routePlan(page, planView([planItem({ id: 'a', title: 'Cache invoice lookups', status: 'done' })], {
      changes: [{ at: minutesAgo(4), by: 'claude', action: 'done', itemId: 'a', label: 'a Cache invoice lookups', note: 'Lookups hit the cache' }],
    }));
    await openChat(page);
    const closed = page.getByRole('group', { name: 'What the AI closed' });
    await expect(closed).toContainText('Claude finished “Cache invoice lookups”: Lookups hit the cache · 4 min ago');
    await closed.getByRole('button', { name: 'Reopen "Cache invoice lookups"' }).click();
    await closed.getByLabel('Why does “Cache invoice lookups” need rework?').fill('Misses the expiry case');
    await closed.getByRole('button', { name: 'Reopen milestone' }).click();
    await expect.poll(() => changes).toEqual([{ change: { type: 'reopen', id: 'a', reason: 'Misses the expiry case' }, ifRevision: 3 }]);
    // Seen once, it stays out of the way.
    await closed.getByRole('button', { name: 'Got it' }).click();
    await expect(closed).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-pane')).toBeVisible();
    await expect(page.getByRole('group', { name: 'What the AI closed' })).toHaveCount(0);
  });
});
