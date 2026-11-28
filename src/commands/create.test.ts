import { beforeEach, describe, expect, it, vi } from 'vitest';

// The CLI create flow is interactive; every question and every other step is stubbed, so this only checks that the
// note about a workspace that stays on files is printed.
const created = vi.hoisted(() => ({ note: '' }));
vi.mock('@inquirer/prompts', () => ({ confirm: async () => false, input: async () => 'note ws', select: async () => '' }));
vi.mock('../core/config.js', () => ({ loadConfig: async () => ({ devDir: '/dev', workspacesDir: '/ws', scanDepth: 1, defaultAssistant: 'claude' }) }));
vi.mock('../core/projects.js', () => ({ loadProjects: async () => [], slugifyProjectName: (s: string) => s.replace(/\s+/g, '-') }));
vi.mock('../core/scanner.js', () => ({ scanForRepos: async () => [{ name: 'api', path: '/dev/api', defaultBranch: 'main' }] }));
vi.mock('../core/workspace.js', () => ({
  resolveRepoInfos: async () => [],
  createWorkspace: async (_f: unknown, _r: unknown, _p: unknown, options?: { onNote?: (n: string) => void }) => { options?.onNote?.(created.note); return '/ws/note-ws'; },
}));
vi.mock('../utils/prompts.js', () => ({
  promptSelectRepos: async () => [{ name: 'api', path: '/dev/api', defaultBranch: 'main' }],
  promptSelectEditor: async () => null,
  promptBranchName: async () => 'b', promptDescription: async () => 'd', promptSelectAI: async () => [], promptSelectStrategy: async () => 'x',
  promptNewStrategy: async () => ({}), promptNewProjectName: async () => 'p', promptRepoBranches: async () => new Map(), promptSelectSkills: async () => [],
}));
vi.mock('../generators/index.js', () => ({ generateContextFiles: async () => undefined }));
vi.mock('../analyzers/index.js', () => ({ analyzeAllRepos: async () => new Map() }));
vi.mock('../utils/detect-ai.js', () => ({ detectAIAssistants: async () => [] }));
vi.mock('../utils/detect-editors.js', () => ({ detectEditors: async () => [] }));
vi.mock('../utils/repo-freshness.js', () => ({ checkReposFreshness: async () => [], fastForwardRepos: async () => [] }));
vi.mock('../utils/workflows.js', () => ({ getWorkflowTemplates: async () => [], saveWorkflowTemplate: async () => ({}) }));
vi.mock('./backup-offer.js', () => ({ offerBackupRemote: async () => undefined }));
vi.mock('../utils/skills-catalog.js', () => ({ getAllSkills: async () => [], saveWorkspaceSkillsConfig: async () => undefined }));
import { createCommand } from './create.js';

describe('ctxspace create', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('prints the note when the new workspace stays on files', async () => {
    created.note = 'This new workspace stays on files: NOTE-FROM-MOVE. Run `ctxspace plan migrate` to move it later.';
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    await createCommand({ quick: true });
    expect(lines.join('\n')).toContain('NOTE-FROM-MOVE');
  });

  it('prints nothing extra when the workspace started on the database', async () => {
    created.note = '';
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    await createCommand({ quick: true });
    expect(lines.join('\n')).not.toContain('stays on files');
  });
});
