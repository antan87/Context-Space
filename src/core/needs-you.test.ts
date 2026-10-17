import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import { changePlan, mutatePlan, PLAN_STORE_FILE } from './plan.js';
import { addChatQuestionToPlan } from './plan-questions.js';
import { mutateWorkspaceState } from './workspace-state.js';
import { needsAnything, workspaceNeeds } from './needs-you.js';
import { registerNeedsYouRoute } from '../http/needs-you-routes.js';

const user = { actor: { by: 'user' } } as const;
const claude = { actor: { by: 'agent', harness: 'claude' } } as const;
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'needs-you-'));
  setActiveStorageProvider(new LocalStorageAdapter());
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'reports', branchName: 'reports', repos: [], assistants: [], workspacePath: root }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function askInChat(message: string, at = new Date().toISOString()) {
  await fs.mkdir(path.join(root, '.contextspace'), { recursive: true });
  await fs.appendFile(path.join(root, '.contextspace', 'chat.jsonl'), `${JSON.stringify({ id: message, timestamp: at, harness: 'claude', author: 'agent', kind: 'input_request', message })}\n`);
}

describe('what needs the user in a workspace', () => {
  it('says what a question holds up among the open work only, and sends why it is asked with its suggested answers', async () => {
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'CSV export' }, user);
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'Export button' }, user);
    await changePlan(root, { type: 'add', kind: 'question', title: 'Which time zone?', owner: 'user', before: ['M1', 'M2'],
      detail: 'Timestamps must match the report.\nSuggested answers: UTC · The account time zone' }, claude);
    await changePlan(root, { type: 'drop', id: 'M2', reason: 'Not needed' }, claude);

    const [question] = (await workspaceNeeds('reports', root)).questions;
    expect(question).toMatchObject({ holdsUp: ['CSV export'], detail: 'Timestamps must match the report.\nSuggested answers: UTC · The account time zone' });
  });

  it('lists the questions for the user with what they hold up, what the AI closed, failed checks, and now and next', async () => {
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'Chat docked' }, user);
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'Reader with tabs', after: ['M1'] }, user);
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'Old idea' }, user);
    await changePlan(root, { type: 'start', id: 'M1' }, claude);
    await changePlan(root, { type: 'add', kind: 'question', title: 'Where does Review go?', owner: 'user', before: ['M2'] }, claude);
    await changePlan(root, { type: 'drop', id: 'M3', reason: 'Covered by M1' }, claude);
    await mutateWorkspaceState(root, (state) => { state.planEvidence = { M1: { canProgress: false, lastVerificationStatus: 'fail' } }; });

    const needs = await workspaceNeeds('reports', root);
    expect(needs).toMatchObject({
      workspaceId: 'reports',
      questions: [{ id: 'Q1', title: 'Where does Review go?', holdsUp: ['Reader with tabs'], askedBy: 'claude' }],
      proposals: [],
      failedChecks: [{ id: 'M1', title: 'Chat docked' }],
      closedByAi: [{ id: 'M3', title: 'Old idea', action: 'dropped', by: 'claude', note: 'Covered by M1' }],
      current: { id: 'M1', title: 'Chat docked' },
      next: { id: 'M2', title: 'Reader with tabs', waitsFor: ['Chat docked', 'Where does Review go?'] },
    });
    expect(needs).not.toHaveProperty('chatQuestion');
    expect(needsAnything(needs)).toBe(true);
  });

  it('lists the AI\'s chat question once: from the plan when it is there, from the chat when it is not', async () => {
    await askInChat('Which branch should I target?');
    expect((await workspaceNeeds('reports', root)).chatQuestion).toMatchObject({ message: 'Which branch should I target?', harness: 'claude' });
    await addChatQuestionToPlan(root, { message: 'Which branch should I target?', harness: 'claude' });
    const needs = await workspaceNeeds('reports', root);
    expect(needs.questions.map((question) => question.title)).toEqual(['Which branch should I target?']);
    expect(needs).not.toHaveProperty('chatQuestion');
  });

  it('keeps a proposal saved under the earlier rule, and leaves out what the user closed and what is old', async () => {
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'Done by you' }, user);
    await changePlan(root, { type: 'done', id: 'M1', resolution: 'Shipped' }, user);
    await changePlan(root, { type: 'add', kind: 'task', title: 'Docs' }, user);
    await mutatePlan(root, (plan) => {
      plan.items[1]!.proposal = { action: 'done', by: 'codex', note: 'Written', at: '2026-10-01T00:00:00.000Z' };
    });
    const needs = await workspaceNeeds('reports', root, Date.parse('2026-10-20T00:00:00.000Z'));
    expect(needs.proposals).toEqual([{ id: 'T1', title: 'Docs', action: 'done', by: 'codex', at: '2026-10-01T00:00:00.000Z' }]);
    expect(needs.closedByAi).toEqual([]);
  });

  it('reads nothing into a workspace without a plan, or with one that cannot be read', async () => {
    expect(needsAnything(await workspaceNeeds('reports', root))).toBe(false);
    await fs.writeFile(path.join(root, PLAN_STORE_FILE), '{ broken');
    expect(await workspaceNeeds('reports', root)).toMatchObject({ questions: [], proposals: [], failedChecks: [], closedByAi: [] });
  });
});

describe('GET /api/needs-you', () => {
  it('answers for the named workspaces it can read and leaves the rest out', async () => {
    await changePlan(root, { type: 'add', kind: 'question', title: 'Ship it?', owner: 'user' }, claude);
    const app = new Hono();
    registerNeedsYouRoute(app, async (id) => (id === 'reports' ? root : null));
    const response = await app.request('/api/needs-you?workspaces=reports,ghost,reports');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workspaces.map((needs: { workspaceId: string }) => needs.workspaceId)).toEqual(['reports']);
    expect(body.workspaces[0].questions[0]).toMatchObject({ title: 'Ship it?' });
  });
});
