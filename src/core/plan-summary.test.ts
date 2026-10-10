import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BUILD_ORDER_HEADING, buildOrderOf, buildPlanSummary, renderPlanSummary, writePlanSummary } from './plan-summary.js';
import { applyPlanChange, changePlan, emptyPlan } from './plan.js';
import { renderPlanText } from './plan-text.js';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';

const user = { by: 'user' } as const;

describe('renderPlanSummary', () => {
  const plan = emptyPlan();
  applyPlanChange(plan, { type: 'add', kind: 'milestone', title: 'CSV export endpoint' }, user, '2026-10-10T10:00:00.000Z');
  applyPlanChange(plan, { type: 'add', kind: 'question', title: 'Which time zone?', owner: 'user', before: ['M1'] }, user, '2026-10-10T10:01:00.000Z');

  it('holds the brief, then the plan exactly as `ctxspace plan` prints it without the recent changes', () => {
    const text = renderPlanSummary({
      workspaceId: 'reports', plan, repoCount: 1,
      brief: { objective: 'Add CSV export', stage: 'implement', expectedOutput: 'The endpoint, tested', stopCondition: 'Tests pass' },
    });
    expect(text).toBe([
      '# Plan — reports',
      '',
      'Generated from contextspace-plan.json; do not edit. Read the plan with `ctxspace plan`, change it with `ctxspace plan add|start|done|answer|block|later|drop|reopen`, and see the full brief with `ctxspace flow --assignment`.',
      '',
      '- **Goal:** Add CSV export',
      '- **Stage:** Implement',
      '- **Expected output:** The endpoint, tested',
      '- **Stop when:** Tests pass',
      '',
      '```text',
      renderPlanText(plan, { changes: 0 }),
      '```',
      '',
    ].join('\n'));
    expect(text).toContain('NEEDS YOU');
    expect(text).not.toContain('WHAT CHANGED');
    expect(text).not.toContain('<!--');
  });

  it('takes the goal from the description until the brief has one, and says when no repo is attached', () => {
    const text = renderPlanSummary({ workspaceId: 'reports', plan: emptyPlan(), repoCount: 0, brief: {}, description: 'Reports  can be\nexported' });
    expect(text).toContain('- **Goal:** Reports can be exported');
    expect(text).toContain('- **Repository:** None yet. Add one with `ctxspace add-repo`.');
    expect(text).not.toContain('Stage');
  });

  it('ends with the build order, which a later rewrite can find and keep', () => {
    const buildOrder = `${BUILD_ORDER_HEADING}\n\nBuild core first.\n\n### Dependency table\n\n| Repo |\n|:---|\n| core |`;
    const text = renderPlanSummary({ workspaceId: 'reports', plan, repoCount: 2, brief: {}, buildOrder });
    expect(text.endsWith(`${buildOrder}\n`)).toBe(true);
    expect(buildOrderOf(text)).toBe(`${buildOrder}\n`);
    expect(buildOrderOf(renderPlanSummary({ workspaceId: 'reports', plan, repoCount: 1, brief: {} }))).toBeUndefined();
  });
});

describe('writePlanSummary', () => {
  let root: string;
  const summary = () => fs.readFile(path.join(root, 'contextspace-plan.md'), 'utf8');

  beforeEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-summary-'));
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'reports', branchName: 'reports', description: 'Reports', repos: [], assistants: [], workspacePath: root }));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('follows every plan change and keeps the build order a refresh wrote', async () => {
    await writePlanSummary(root, { buildOrder: `${BUILD_ORDER_HEADING}\n\nBuild core first.` });
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'CSV export endpoint' }, { actor: user });
    const content = await summary();
    expect(content).toContain('M1 CSV export endpoint');
    expect(content.trimEnd().endsWith('Build core first.')).toBe(true);
  });

  it('leaves the file alone when it would read the same', async () => {
    await writePlanSummary(root);
    const before = (await fs.stat(path.join(root, 'contextspace-plan.md'))).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writePlanSummary(root);
    expect((await fs.stat(path.join(root, 'contextspace-plan.md'))).mtimeMs).toBe(before);
  });

  it('reads the live plan without writing, for the plan route', async () => {
    await changePlan(root, { type: 'add', kind: 'task', title: 'Rate limit' }, { actor: user });
    await fs.rm(path.join(root, 'contextspace-plan.md'));
    expect(await buildPlanSummary(root)).toContain('T1 Rate limit');
    await expect(fs.stat(path.join(root, 'contextspace-plan.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes nothing outside a workspace', async () => {
    await fs.rm(path.join(root, 'contextspace.json'));
    await writePlanSummary(root);
    await expect(fs.stat(path.join(root, 'contextspace-plan.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
