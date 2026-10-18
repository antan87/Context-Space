import { test, expect } from './fixtures';

const feature = { id: 'feature-x', branchName: 'feature-x', description: 'CLI usage', repos: [], assistants: ['codex'], workspacePath: 'C:/ws/feature-x', createdAt: '2026-09-20T00:00:00Z' };
const sessionId = '0199a213-81c0-7800-8aa1-bbab2a035a50';
const terminal = { id: '0199a213-81c0-7800-8aa1-bbab2a035a51', workspace: feature.id, target: 'codex', label: 'Codex', cwd: feature.workspacePath, startedAt: '2026-09-21T10:00:00Z', state: 'running' };
const saved = { id: sessionId, assistant: 'codex', title: 'Saved Codex conversation', workspacePath: feature.workspacePath, createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-21T00:00:00Z', messageCount: 5, usage: { inputTokens: 1000, outputTokens: 240, cachedInputTokens: 300 }, quota: { requests: { unit: 'requests', remaining: 7 }, contextWindow: { usedTokens: 12_000, maxTokens: 100_000, utilizationPercent: 12 } } };
const unknown = { ...saved, id: '0199a213-81c0-7800-8aa1-bbab2a035a52', title: 'Conversation without usage', usage: undefined, quota: undefined };

test.use({ workspacesData: [feature], viewport: { width: 1365, height: 960 } });

test.beforeEach(async ({ page }) => {
  await page.route('**/api/terminals/bootstrap', route => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/ai-detect', route => route.fulfill({ json: [{ name: 'codex', displayName: 'Codex', detected: true }] }));
});

test('first-run history makes reported and missing usage distinct', async ({ page }) => {
  await page.route('**/api/terminals/feature-x/status', route => route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'codex', name: 'Codex', available: true, reason: null }] } }));
  await page.route('**/api/workspace/feature-x/sessions*', route => route.fulfill({ json: { sessions: [saved, unknown] } }));
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const history = page.getByRole('region', { name: 'Continue a conversation' });
  await expect(history.getByTestId('resume-session-row').filter({ hasText: saved.title })).toContainText('Input 1,000 · Output 240 · Cached input 300 tokens');
  await expect(history.getByTestId('resume-session-row').filter({ hasText: unknown.title })).toContainText('Token usage unavailable');
  await expect(history.getByTestId('resume-session-row').filter({ hasText: unknown.title })).toContainText('Remaining quota unavailable');
  await page.screenshot({ path: 'test-results/cli-usage-first-run.png' });
});

test('CLI chat shows exact saved-session usage and quota without a passive launch', async ({ page }) => {
  let remaining = 7;
  const launches: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/terminals/feature-x/create')) launches.push(request.url()); });
  await page.route('**/api/terminals/feature-x/status', route => route.fulfill({ json: { available: true, sessions: [{ ...terminal, sessionId }], targets: [{ id: 'codex', name: 'Codex', available: true, reason: null }] } }));
  await page.route('**/api/workspace/feature-x/sessions*', route => route.fulfill({ json: { sessions: [
    { ...saved, assistant: 'claude', title: 'Different harness with same ID', usage: { inputTokens: 99_999, outputTokens: 9_999 } },
    { ...saved, quota: { ...saved.quota, requests: { unit: 'requests', remaining } } }, unknown,
  ] } }));
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  const openPaneOptions = () => chat.getByRole('button', { name: 'Pane options' }).click();
  // The overflow popup is portalled to the document body, so it is not a
  // descendant of the chat region and must be queried from the page.
  const usage = page.getByRole('region', { name: 'CLI session usage' });
  await openPaneOptions();
  await expect(usage).toContainText('Input 1,000 · Output 240 · Cached input 300 tokens');
  await expect(usage).toContainText('7 requests remaining');
  await expect(usage).toContainText('Context window 12.0% used');
  await expect(usage).not.toContainText('99,999');
  await expect(usage).not.toContainText('1,540');
  await page.screenshot({ path: 'test-results/cli-usage-active.png' });
  expect(launches).toHaveLength(0);
  remaining = 6;
  await page.getByRole('menuitem', { name: 'Refresh usage' }).click();
  await openPaneOptions();
  await expect(usage).toContainText('6 requests remaining');
  await page.keyboard.press('Escape');
  // Saved conversations open in a tab of their own, beside the session that runs.
  await chat.getByRole('button', { name: 'Start another CLI' }).click();
  await page.getByRole('menuitem', { name: 'Continue a saved conversation…' }).click();
  const history = chat.getByRole('region', { name: 'Continue a conversation' });
  await expect(history.getByTestId('resume-session-row').filter({ hasText: saved.title })).toContainText('Input 1,000 · Output 240 · Cached input 300 tokens');
  await expect(history.getByTestId('resume-session-row').filter({ hasText: unknown.title })).toContainText('Token usage unavailable');
  await page.screenshot({ path: 'test-results/cli-usage-history.png' });
  expect(launches).toHaveLength(0);
});

test('a new terminal does not borrow another conversation’s usage', async ({ page }) => {
  await page.route('**/api/terminals/feature-x/status', route => route.fulfill({ json: { available: true, sessions: [terminal], targets: [{ id: 'codex', name: 'Codex', available: true, reason: null }] } }));
  await page.route('**/api/workspace/feature-x/sessions*', route => route.fulfill({ json: { sessions: [saved] } }));
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  const usage = page.getByRole('region', { name: 'CLI session usage' });
  await chat.getByRole('button', { name: 'Pane options' }).click();
  await expect(usage).toContainText('No matching saved usage is available');
  await expect(usage).not.toContainText('Input 1,000');
});

test('a new terminal finds usage after its harness saves one matching conversation', async ({ page }) => {
  let sessions: object[] = [saved];
  await page.route('**/api/terminals/feature-x/status', route => route.fulfill({ json: { available: true, sessions: [terminal], targets: [{ id: 'codex', name: 'Codex', available: true, reason: null }] } }));
  await page.route('**/api/workspace/feature-x/sessions*', route => route.fulfill({ json: { sessions } }));
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  const openPaneOptions = () => chat.getByRole('button', { name: 'Pane options' }).click();
  const usage = page.getByRole('region', { name: 'CLI session usage' });
  await openPaneOptions();
  await expect(usage).toContainText('No matching saved usage is available');

  sessions = [{ ...saved, id: '0199a213-81c0-7800-8aa1-bbab2a035a53', recordedCwd: feature.workspacePath, createdAt: '2026-09-21T10:01:00Z' }, saved];
  await page.getByRole('menuitem', { name: 'Refresh usage' }).click();
  await openPaneOptions();
  await expect(usage).toContainText('Input 1,000 · Output 240 · Cached input 300 tokens');
});

test('parallel fresh terminals do not claim the same saved usage', async ({ page }) => {
  const otherTerminal = { ...terminal, id: '0199a213-81c0-7800-8aa1-bbab2a035a55', startedAt: '2026-09-21T10:00:30Z' };
  const matchingSession = { ...saved, recordedCwd: feature.workspacePath, createdAt: '2026-09-21T10:01:00Z' };
  await page.route('**/api/terminals/feature-x/status', route => route.fulfill({ json: { available: true, sessions: [terminal, otherTerminal], targets: [{ id: 'codex', name: 'Codex', available: true, reason: null }] } }));
  await page.route('**/api/workspace/feature-x/sessions*', route => route.fulfill({ json: { sessions: [matchingSession] } }));
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  const usage = page.getByRole('region', { name: 'CLI session usage' });
  await chat.getByRole('button', { name: 'Pane options' }).click();
  await expect(usage).toContainText('No matching saved usage is available');
  await expect(usage).not.toContainText('Input 1,000');
});

for (const target of ['claude', 'antigravity', 'copilot'] as const) {
  test(`${target} terminal shows usage from its matching saved conversation`, async ({ page }) => {
    const matchingTerminal = { ...terminal, target };
    const matchingSession = { ...saved, assistant: target, recordedCwd: feature.workspacePath, createdAt: '2026-09-21T10:01:00Z' };
    await page.route('**/api/terminals/feature-x/status', route => route.fulfill({ json: { available: true, sessions: [matchingTerminal], targets: [{ id: target, name: target, available: true, reason: null }] } }));
    await page.route('**/api/workspace/feature-x/sessions*', route => route.fulfill({ json: { sessions: [matchingSession, { ...matchingSession, assistant: 'codex', id: '0199a213-81c0-7800-8aa1-bbab2a035a54', usage: { inputTokens: 99_999, outputTokens: 9_999 } }] } }));
    await page.goto('/#/workspaces/feature-x/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    const usage = page.getByRole('region', { name: 'CLI session usage' });
    await page.getByRole('region', { name: 'CLI Chat', exact: true }).getByRole('button', { name: 'Pane options' }).click();
    await expect(usage).toContainText('Input 1,000 · Output 240 · Cached input 300 tokens');
    await expect(usage).not.toContainText('99,999');
  });
}
