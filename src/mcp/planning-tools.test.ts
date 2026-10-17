import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { enabledTools, findTool, type ToolContext } from './tools.js';
import { planningTools } from './planning-tools.js';

vi.mock('../core/refresh.js', () => ({
  refreshWorkspace: vi.fn().mockResolvedValue({ workspacePath: '/tmp/test', analyzedRepos: [], reusedRepos: [], refreshedHandoff: false }),
}));
import { getWorkContext } from '../core/work-guidance.js';

let root: string;
let ctx: ToolContext;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-planning-'));
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'test', branchName: 'test', description: 'Browse reports', repos: [], assistants: [] }));
  ctx = { workspacePath: root, config: { version: '1.0', devDir: root, workspacesDir: root, defaultAssistant: null, scanDepth: 2 } };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function call(name: string, input: Record<string, unknown> = {}) {
  const result = await findTool(name)!.handler(input, ctx);
  expect(result.isError, result.content[0]?.text).not.toBe(true);
  return JSON.parse(result.content[0].text);
}

it('scopes an assignment and a source document, and reads the source back as it was written', async () => {
  let context = await call('get_work_context');
  expect(context.guidance.revision).toBe(0);
  expect(context.guidance.documents).toEqual([]);
  context = await call('update_work_assignment', { revision: context.guidance.revision, workType: 'feature', size: 'small', assignment: {
    stage: 'implement', objective: 'Open agent-created reports', expectedOutput: 'A working report viewer', stopCondition: 'Tests pass',
  } });
  context = await call('add_work_document', { revision: context.guidance.revision, title: 'Report requirements', role: 'requirements', content: '# Keep formatting' });
  const document = context.guidance.documents[0];
  expect(document.status).toBe('draft');
  expect((await call('read_work_document', { documentId: document.id })).content).toBe('# Keep formatting');
  context = await call('update_work_document', { revision: context.guidance.revision, documentId: document.id, title: document.title, role: document.role, status: 'approved', scope: {}, summary: 'Keep report formatting' });
  expect(context.guidance.documents[0].status).toBe('approved');
  expect((await call('read_work_document', { documentId: document.id })).content).toBe('# Keep formatting');
});

it('returns where PLAN.md stands and its text, and no longer offers the old planning tools', async () => {
  expect((await call('get_work_context')).plan).toBeNull();
  await fs.writeFile(path.join(root, 'PLAN.md'), '# Reports\n\nBrowse reports.\n\n## Checkpoints\n\n- [ ] Open root reports\n');
  const { plan } = await call('get_work_context');
  expect(plan).toContain('CHECKPOINTS');
  expect(plan).toContain('Browse reports.');
  expect(plan).toContain('- [ ] Open root reports');
  for (const name of ['get_planning_notes', 'save_planning_notes', 'update_milestone_plan', 'set_milestone']) expect(findTool(name)).toBeUndefined();
  expect(findTool('get_work_context')!.description).toContain('Change the plan by editing PLAN.md');
});

it('rejects stale assignment and document writes without losing newer work', async () => {
  const context = await call('add_work_document', { revision: 0, title: 'Requirements', role: 'reference', url: 'https://example.com/requirements' });
  expect((await findTool('add_work_document')!.handler({ revision: 0, title: 'Stale', role: 'reference', content: 'old' }, ctx)).isError).toBe(true);
  expect((await findTool('update_work_assignment')!.handler({ revision: 0, workType: 'feature', size: 'small', assignment: { stage: 'design' } }, ctx)).isError).toBe(true);
  expect((await findTool('update_work_document')!.handler({ revision: 0, documentId: context.guidance.documents[0].id, title: 'Stale', role: 'reference' }, ctx)).isError).toBe(true);
  expect((await call('get_work_context')).guidance.documents).toHaveLength(1);
});

it('rejects malformed inputs, then permits recovery', async () => {
  for (const [name, input] of [
    ['update_work_assignment', { revision: 0, workType: 'feature', size: 'small', assignment: { stage: 'invented' } }],
    ['add_work_document', { revision: 0, title: 'Unsafe', role: 'reference', url: 'file:///etc/passwd' }],
    ['add_work_document', { revision: 0, title: 'Ambiguous', role: 'reference', content: 'Text', url: 'https://example.com' }],
    ['update_work_document', { revision: 0, documentId: '../escape', title: 'No', role: 'reference' }],
  ] as const) expect((await findTool(name)!.handler(input, ctx)).isError).toBe(true);
  expect((await getWorkContext(root)).guidance.documents).toEqual([]);
  expect((await call('add_work_document', { revision: 0, title: 'Notes', role: 'reference', content: 'Text' })).guidance.documents).toHaveLength(1);
});

it('exposes planning writes only to editing roles and respects explicit tool filters', () => {
  for (const role of ['readonly', 'review', 'ci'] as const) {
    const names = enabledTools(ctx.config, role).map((tool) => tool.name);
    for (const tool of planningTools) expect(names).not.toContain(tool.name);
  }
  for (const role of ['developer', 'interactive', 'full'] as const) {
    const names = enabledTools(ctx.config, role).map((tool) => tool.name);
    for (const tool of planningTools) expect(names).toContain(tool.name);
  }
  expect(enabledTools(ctx.config, 'developer', ['get_work_context']).map((tool) => tool.name)).toEqual(['get_work_context']);
  expect(enabledTools(ctx.config, 'developer', undefined, ['add_work_document']).map((tool) => tool.name)).not.toContain('add_work_document');
});

it('does not initialize state when the target is not a workspace', async () => {
  await fs.unlink(path.join(root, 'contextspace.json'));
  const result = await findTool('add_work_document')!.handler({ revision: 0, title: 'Notes', role: 'reference', content: 'Text' }, ctx);
  expect(result.isError).toBe(true);
  expect(await fs.readdir(root)).toEqual([]);
});
