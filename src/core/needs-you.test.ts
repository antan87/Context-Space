import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import { addToPlan } from './plan-file.js';
import { changePlanFile, readPlanFile } from './plan-file-store.js';
import { addChatQuestionToPlan } from './plan-questions.js';
import { mutateWorkspaceState } from './workspace-state.js';
import { needsAnything, workspaceNeeds } from './needs-you.js';
import { registerNeedsYouRoute } from '../http/needs-you-routes.js';

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'needs-you-')));
  setActiveStorageProvider(new LocalStorageAdapter());
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'reports', branchName: 'reports', repos: [], assistants: [], workspacePath: root }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function askInChat(message: string, at = new Date().toISOString()) {
  await fs.mkdir(path.join(root, '.contextspace'), { recursive: true });
  await fs.appendFile(path.join(root, '.contextspace', 'chat.jsonl'), `${JSON.stringify({ id: message, timestamp: at, harness: 'claude', author: 'agent', kind: 'input_request', message })}\n`);
}

const writePlan = (text: string) => fs.writeFile(path.join(root, 'PLAN.md'), text);
const PLAN = `# Reports

## Checkpoints

- [ ] Chat docked
  Check: \`npm test\`
  - [x] Dock the chat
- [ ] Reader with tabs
  - [ ] Decide: Where does Review go?
    Review used to sit in the sidebar.
    Suggested: The rail · The sidebar
    If no answer: the rail
- [x] Old idea
  - [ ] Decide: Keep the old reader?

## Decisions

- [ ] Decide: Ship it?
`;

describe('what needs the user in a workspace', () => {
  it('lists the decisions that wait, with what they hold up and why, failed checks, and now and next', async () => {
    await writePlan(PLAN);
    await mutateWorkspaceState(root, (state) => { state.planChecks = { 'chat-docked': { canProgress: false, lastVerificationStatus: 'fail', at: '2026-10-16T10:00:00.000Z' } }; });

    const needs = await workspaceNeeds('reports', root);
    expect(needs).toMatchObject({
      workspaceId: 'reports',
      questions: [
        { id: 'where-does-review-go', title: 'Where does Review go?', holdsUp: ['Reader with tabs'],
          detail: "Review used to sit in the sidebar.\n\nIf you don't answer: the rail\n\nSuggested answers: The rail · The sidebar" },
        { id: 'ship-it', title: 'Ship it?', holdsUp: [] },
      ],
      proposals: [],
      failedChecks: [{ id: 'chat-docked', title: 'Chat docked' }],
      closedByAi: [],
      current: { id: 'chat-docked', title: 'Chat docked' },
      next: { id: 'reader-with-tabs', title: 'Reader with tabs' },
    });
    expect(needs).not.toHaveProperty('chatQuestion');
    expect(needsAnything(needs)).toBe(true);
  });

  it('lists the checkpoints an AI ticked lately, and who asked a decision, from what changed', async () => {
    await writePlan(PLAN);
    await readPlanFile(root);
    await writePlan(PLAN.replace('- [ ] Chat docked', '- [x] Chat docked'));
    await changePlanFile(root, (text) => addToPlan(text, { decision: { question: 'Which theme?' } }).text, { by: 'codex' });
    const needs = await workspaceNeeds('reports', root);
    expect(needs.closedByAi).toMatchObject([{ id: 'chat-docked', title: 'Chat docked', action: 'done', by: 'agent' }]);
    expect(needs.questions.find((question) => question.title === 'Which theme?')).toMatchObject({ askedBy: 'codex' });
  });

  it('lists the AI\'s chat question once: from the plan when it is there, from the chat when it is not', async () => {
    await askInChat('Which branch should I target?');
    expect((await workspaceNeeds('reports', root)).chatQuestion).toMatchObject({ message: 'Which branch should I target?', harness: 'claude' });
    await addChatQuestionToPlan(root, { message: 'Which branch should I target?', harness: 'claude' });
    const needs = await workspaceNeeds('reports', root);
    expect(needs.questions).toMatchObject([{ title: 'Which branch should I target?', holdsUp: [], waiting: true, askedBy: 'claude' }]);
    expect(needs).not.toHaveProperty('chatQuestion');
  });

  it('reads nothing into a workspace without a plan', async () => {
    expect(needsAnything(await workspaceNeeds('reports', root))).toBe(false);
    expect(await workspaceNeeds('reports', root)).toMatchObject({ questions: [], proposals: [], failedChecks: [], closedByAi: [] });
  });
});

describe('GET /api/needs-you', () => {
  it('answers for the named workspaces it can read and leaves the rest out', async () => {
    await writePlan(PLAN);
    const app = new Hono();
    registerNeedsYouRoute(app, async (id) => (id === 'reports' ? root : null));
    const response = await app.request('/api/needs-you?workspaces=reports,ghost,reports');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workspaces.map((needs: { workspaceId: string }) => needs.workspaceId)).toEqual(['reports']);
    expect(body.workspaces[0].questions[1]).toMatchObject({ title: 'Ship it?' });
  });
});
