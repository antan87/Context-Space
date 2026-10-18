import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync } from 'node:fs';
import { isLegacyWorkspace, migrateWorkspace, migrateGlobalConfig } from './migrate.js';
import { loadWorkspaceState, saveWorkspaceState } from './workspace-state.js';
import { loadAnalysisCache, saveAnalysisCache } from './analysis-cache.js';
import { loadSchedules } from './scheduler.js';
import { getSkillCategories, getAllSkills } from '../utils/skills-catalog.js';
import { getDaemonState } from '../commands/ui.js';
import { reconcileWorkspaceResources } from '../resources/materializer.js';
import { addWorkspaceKnowledge } from './knowledge.js';
import { commitWorkspaceArtifacts } from './workspace-git.js';
import { execa } from 'execa';
import type { SkillItem, CodexAgentItem, WorkspaceState } from '../types.js';
import type { AnalysisCache } from './analysis-cache.js';

const testSkill: SkillItem = {
  id: 'test-portable-skill',
  name: 'test-portable-skill',
  title: 'Test Portable Skill',
  category: 'general',
  description: 'Use when testing portable skill materialization.',
  content: '# Portable skill\n\nFollow test instructions.',
  custom: false,
};

const testAgent: CodexAgentItem = {
  id: 'test_code_reviewer',
  name: 'test_code_reviewer',
  category: 'general',
  description: 'Use when testing reviewer agent materialization.',
  developerInstructions: 'Review correctness and security.',
  sandboxMode: 'read-only',
  custom: true,
};

describe('core/migrate', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-migrate-test-'));
    originalEnv = { ...process.env };
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('workspace migration basics', () => {
    it('detects legacy workspace when nexusflow.json is present', async () => {
      await fs.writeFile(path.join(tempDir, 'nexusflow.json'), JSON.stringify({ id: 'test-feat' }));
      expect(await isLegacyWorkspace(tempDir)).toBe(true);
    });

    it('returns false when only contextspace.json is present', async () => {
      await fs.writeFile(path.join(tempDir, 'contextspace.json'), JSON.stringify({ id: 'test-feat' }));
      expect(await isLegacyWorkspace(tempDir)).toBe(false);
    });

    it('migrates legacy files to ContextSpace names in dry-run mode without disk modification', async () => {
      await fs.writeFile(path.join(tempDir, 'nexusflow.json'), JSON.stringify({ id: 'test-feat' }));
      await fs.writeFile(path.join(tempDir, 'nexusflow-knowledge.md'), '# Knowledge\n');

      const report = await migrateWorkspace(tempDir, { dryRun: true, refresh: false });
      expect(report.isLegacy).toBe(true);
      expect(report.dryRun).toBe(true);
      expect(report.renamedFiles.length).toBeGreaterThan(0);

      // Files on disk should NOT be changed in dry run
      expect(await fs.access(path.join(tempDir, 'nexusflow.json')).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.access(path.join(tempDir, 'contextspace.json')).then(() => true).catch(() => false)).toBe(false);
    });

    it('is idempotent when run multiple times', async () => {
      await fs.writeFile(path.join(tempDir, 'nexusflow.json'), JSON.stringify({ id: 'feat' }));
      await migrateWorkspace(tempDir, { dryRun: false, refresh: false });

      // Second run
      const secondReport = await migrateWorkspace(tempDir, { dryRun: false, refresh: false });
      expect(secondReport.isLegacy).toBe(false);
      expect(secondReport.renamedFiles.length).toBe(0);
    });
  });

  describe('Blocker 1: Global migration and durable state fallback', () => {
    it('migrates all global durable state and provides fallback before migration', async () => {
      const legacyHome = path.join(tempDir, 'home', '.nexusflow');
      const primaryHome = path.join(tempDir, 'home', '.contextspace');
      await fs.mkdir(legacyHome, { recursive: true });

      // 1. Seed legacy configuration and durable state
      await fs.writeFile(path.join(legacyHome, 'config.json'), JSON.stringify({ devDir: '/legacy/dev' }));
      await fs.writeFile(path.join(legacyHome, 'projects.json'), JSON.stringify({ version: 1, projects: [] }));
      await fs.writeFile(
        path.join(legacyHome, 'schedules.json'),
        JSON.stringify({
          version: 1,
          jobs: [
            {
              id: 'job-1',
              workspacePath: '/mock/ws',
              task: 'sync',
              intervalMinutes: 60,
              enabled: true,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      );
      await fs.writeFile(
        path.join(legacyHome, 'categories.json'),
        JSON.stringify([
          {
            id: 'custom-cat',
            name: 'Custom Category',
            description: 'A user defined category',
            custom: true,
          },
        ]),
      );
      await fs.writeFile(
        path.join(legacyHome, 'daemon.json'),
        JSON.stringify({ pid: 4242, port: 3001, startedAt: '2026-09-01T00:00:00.000Z' }),
      );

      // Workflows
      await fs.mkdir(path.join(legacyHome, 'workflows'), { recursive: true });
      await fs.writeFile(path.join(legacyHome, 'workflows', 'ci.json'), JSON.stringify({ name: 'CI Workflow' }));

      // Custom Skills
      const skillDir = path.join(legacyHome, 'skills', 'custom-helper');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: custom-helper\ndescription: Custom user skill\n---\n# Helper');

      // Vault
      const vaultDir = path.join(legacyHome, 'vault', 'legacy-feature');
      await fs.mkdir(vaultDir, { recursive: true });
      await fs.writeFile(path.join(vaultDir, 'contextspace.json'), JSON.stringify({ id: 'legacy-feature' }));

      // Route env to test directories
      process.env.CONTEXTSPACE_HOME = primaryHome;
      process.env.NEXUSFLOW_HOME = legacyHome;

      // 2. Test pre-migration fallback: runtime consumers read legacy durable state
      const preSchedules = await loadSchedules();
      expect(preSchedules.jobs).toHaveLength(1);
      expect(preSchedules.jobs[0].id).toBe('job-1');

      const preCategories = await getSkillCategories();
      expect(preCategories.some((c) => c.id === 'custom-cat')).toBe(true);

      const preSkills = await getAllSkills();
      expect(preSkills.some((s) => s.id === 'custom-helper')).toBe(true);

      const preDaemon = await getDaemonState();
      expect(preDaemon?.port).toBe(3001);

      // 3. Run global migration
      const report = await migrateGlobalConfig({
        sourceDir: legacyHome,
        targetDir: primaryHome,
      });

      expect(report.migratedConfig).toBe(true);
      expect(report.migratedProjects).toBe(true);
      expect(report.migratedSchedules).toBe(true);
      expect(report.migratedCategories).toBe(true);
      expect(report.migratedWorkflows).toBe(1);
      expect(report.migratedSkills).toBe(1);
      expect(report.migratedVaults).toBe(1);

      // Primary directory should now contain all durable state
      expect(existsSync(path.join(primaryHome, 'config.json'))).toBe(true);
      expect(existsSync(path.join(primaryHome, 'projects.json'))).toBe(true);
      expect(existsSync(path.join(primaryHome, 'schedules.json'))).toBe(true);
      expect(existsSync(path.join(primaryHome, 'categories.json'))).toBe(true);
      expect(existsSync(path.join(primaryHome, 'daemon.json'))).toBe(true);
      expect(existsSync(path.join(primaryHome, 'workflows', 'ci.json'))).toBe(true);
      expect(existsSync(path.join(primaryHome, 'skills', 'custom-helper', 'SKILL.md'))).toBe(true);
      expect(existsSync(path.join(primaryHome, 'vault', 'legacy-feature', 'contextspace.json'))).toBe(true);

      // 4. Test post-migration: state remains fully accessible
      const postSchedules = await loadSchedules();
      expect(postSchedules.jobs).toHaveLength(1);
      expect(postSchedules.jobs[0].task).toBe('sync');

      const postCategories = await getSkillCategories();
      expect(postCategories.some((c) => c.id === 'custom-cat')).toBe(true);

      const postSkills = await getAllSkills();
      expect(postSkills.some((s) => s.id === 'custom-helper')).toBe(true);

      const postDaemon = await getDaemonState();
      expect(postDaemon?.port).toBe(3001);
    });
  });

  describe('Blocker 2: Workspace migration and runtime path routing', () => {
    it('migrates a populated workspace and verifies .nexusflow is never recreated on subsequent operations', async () => {
      const wsDir = path.join(tempDir, 'workspace');
      await fs.mkdir(wsDir, { recursive: true });

      // Seed legacy workspace files
      await fs.writeFile(
        path.join(wsDir, 'nexusflow.json'),
        JSON.stringify({ id: 'my-feature', branchName: 'my-feature', description: 'feature desc' }),
      );
      const initialLegacyState: WorkspaceState = {
        workspacePath: wsDir,
        updatedAt: new Date().toISOString(),
        repos: {
          'repo-one': {
            repoName: 'repo-one',
            lastSyncStatus: 'up-to-date',
            pendingValidation: false,
          },
        },
      };
      await fs.writeFile(path.join(wsDir, '.nexusflow-state.json'), JSON.stringify(initialLegacyState, null, 2));

      const mockAnalysis: any = {
        name: 'repo-one',
        path: path.join(wsDir, 'repo-one'),
        techStack: { languages: ['typescript'], frameworks: [], buildTools: [], projectType: 'library' },
        dependencies: [],
        ports: [],
        readmeSummary: null,
        existingAIConfigs: [],
      };
      const initialLegacyCache: AnalysisCache = {
        version: 1,
        repos: {
          'repo-one': {
            repoName: 'repo-one',
            fingerprint: 'legacy-fingerprint-123',
            analyzedAt: new Date().toISOString(),
            analysis: mockAnalysis,
          },
        },
      };
      await fs.writeFile(path.join(wsDir, '.nexusflow-analysis-cache.json'), JSON.stringify(initialLegacyCache, null, 2));

      await fs.mkdir(path.join(wsDir, '.nexusflow'), { recursive: true });
      await fs.writeFile(path.join(wsDir, '.nexusflow', 'resources.lock.json'), JSON.stringify({ schemaVersion: 1, outputs: [] }));
      await fs.writeFile(path.join(wsDir, 'nexusflow-knowledge.md'), '# Knowledge\n');
      await fs.writeFile(path.join(wsDir, 'nexusflow-plan.md'), '# Plan\n');

      // 1. Run migration without refresh
      const migrationReport = await migrateWorkspace(wsDir, { dryRun: false, refresh: false });
      expect(migrationReport.isLegacy).toBe(true);

      // Legacy files should have been renamed to primary files
      expect(existsSync(path.join(wsDir, 'nexusflow.json'))).toBe(false);
      expect(existsSync(path.join(wsDir, 'contextspace.json'))).toBe(true);

      expect(existsSync(path.join(wsDir, '.nexusflow-state.json'))).toBe(false);
      expect(existsSync(path.join(wsDir, '.contextspace-state.json'))).toBe(true);

      expect(existsSync(path.join(wsDir, '.nexusflow-analysis-cache.json'))).toBe(false);
      expect(existsSync(path.join(wsDir, '.contextspace-analysis-cache.json'))).toBe(true);

      expect(existsSync(path.join(wsDir, '.nexusflow'))).toBe(false);
      expect(existsSync(path.join(wsDir, '.contextspace'))).toBe(true);

      expect(existsSync(path.join(wsDir, 'nexusflow-knowledge.md'))).toBe(false);
      expect(existsSync(path.join(wsDir, 'contextspace-knowledge.md'))).toBe(true);

      // 2. Load workspace state from migrated workspace
      const loadedState = await loadWorkspaceState(wsDir);
      expect(loadedState.repos['repo-one']).toBeDefined();
      expect(loadedState.repos['repo-one'].repoName).toBe('repo-one');

      // Update and save workspace state
      loadedState.repos['repo-two'] = {
        repoName: 'repo-two',
        lastSyncStatus: 'up-to-date',
        pendingValidation: false,
      };
      await saveWorkspaceState(loadedState);

      // Verify that .nexusflow-state.json was NOT recreated and .contextspace-state.json was updated
      expect(existsSync(path.join(wsDir, '.nexusflow-state.json'))).toBe(false);
      const reloadedState = await loadWorkspaceState(wsDir);
      expect(reloadedState.repos['repo-two']).toBeDefined();
      expect(reloadedState.repos['repo-two'].repoName).toBe('repo-two');

      // 3. Load analysis cache from migrated workspace
      const loadedCache = await loadAnalysisCache(wsDir);
      expect(loadedCache.repos['repo-one']).toBeDefined();
      expect(loadedCache.repos['repo-one'].fingerprint).toBe('legacy-fingerprint-123');

      // Update and save analysis cache
      loadedCache.repos['repo-two'] = {
        repoName: 'repo-two',
        fingerprint: 'new-fingerprint-456',
        analyzedAt: new Date().toISOString(),
        analysis: {
          ...mockAnalysis,
          name: 'repo-two',
          path: path.join(wsDir, 'repo-two'),
        },
      };
      await saveAnalysisCache(wsDir, loadedCache);

      // Verify that .nexusflow-analysis-cache.json was NOT recreated
      expect(existsSync(path.join(wsDir, '.nexusflow-analysis-cache.json'))).toBe(false);
      const reloadedCache = await loadAnalysisCache(wsDir);
      expect(reloadedCache.repos['repo-two']?.fingerprint).toBe('new-fingerprint-456');

      // 4. Reconcile workspace resources in the migrated workspace
      await reconcileWorkspaceResources(wsDir, ['codex'], [testSkill], [testAgent]);

      // Verify that .contextspace/resources.lock.json exists and .nexusflow/ was NEVER recreated
      expect(existsSync(path.join(wsDir, '.contextspace', 'resources.lock.json'))).toBe(true);
      expect(existsSync(path.join(wsDir, '.nexusflow'))).toBe(false);
    });
  });

  describe('Blocker 3: Durable prose preservation in markdown files', () => {
    it('updates only freshness comment blocks and provenance headers while strictly preserving prose, code snippets, and commands', async () => {
      const wsDir = path.join(tempDir, 'prose-workspace');
      await fs.mkdir(wsDir, { recursive: true });

      await fs.writeFile(
        path.join(wsDir, 'nexusflow.json'),
        JSON.stringify({ id: 'prose-feat', branchName: 'prose-feat' }),
      );

      const knowledgeContent = [
        '<!-- AUTO-GENERATED by NexusFlow from workspace state — do not edit -->',
        '',
        '<!-- NEXUSFLOW:FRESHNESS:START -->',
        '> **⚠ STALE NEXUSFLOW CONTEXT — GENERATED FACTS MAY BE WRONG.**',
        '> Generated at NexusFlow@c16d0aba50de; repo now at 167b4581e70e.',
        '> Run `nexusflow refresh` before relying on generated facts.',
        '<!-- NEXUSFLOW:FRESHNESS:END -->',
        '',
        '# Decisions and Architecture',
        '',
        '### Decision: Maintain internal nexusflow service communication',
        'We decided to keep the nexusflow service endpoint at https://nexusflow.internal/api/v1.',
        'Renaming this endpoint would break legacy clients that communicate with nexusflow.',
        '',
        '```typescript',
        "import { nexusflow } from '@internal/nexusflow-client';",
        'const client = new nexusflow({ cluster: "prod" });',
        '```',
        '',
        '### Gotcha: NexusFlow database locks',
        'Running `nexusflow migrate` acquires an exclusive lock on the database.',
        'See commit 167b4581e70e for details on nexusflow lock acquisition.',
      ].join('\n');

      await fs.writeFile(path.join(wsDir, 'nexusflow-knowledge.md'), knowledgeContent);

      // Run migration
      const report = await migrateWorkspace(wsDir, { dryRun: false, refresh: false });
      expect(report.isLegacy).toBe(true);

      const migratedContent = await fs.readFile(path.join(wsDir, 'contextspace-knowledge.md'), 'utf-8');

      // 1. Provenance header should be updated
      expect(migratedContent).toContain('<!-- AUTO-GENERATED by ContextSpace from workspace state — do not edit -->');
      expect(migratedContent).not.toContain('<!-- AUTO-GENERATED by NexusFlow');

      // 2. Freshness sentinels and banner lines inside sentinel block should be updated
      expect(migratedContent).toContain('<!-- CONTEXTSPACE:FRESHNESS:START -->');
      expect(migratedContent).toContain('<!-- CONTEXTSPACE:FRESHNESS:END -->');
      expect(migratedContent).toContain('> **⚠ STALE CONTEXTSPACE CONTEXT — GENERATED FACTS MAY BE WRONG.**');
      expect(migratedContent).toContain('> Run `ctxspace refresh` before relying on generated facts.');

      // 3. Prose, headings, code blocks, URLs, and git hashes outside sentinels MUST BE FULLY PRESERVED
      expect(migratedContent).toContain('### Decision: Maintain internal nexusflow service communication');
      expect(migratedContent).toContain('We decided to keep the nexusflow service endpoint at https://nexusflow.internal/api/v1.');
      expect(migratedContent).toContain('Renaming this endpoint would break legacy clients that communicate with nexusflow.');
      expect(migratedContent).toContain("import { nexusflow } from '@internal/nexusflow-client';");
      expect(migratedContent).toContain('const client = new nexusflow({ cluster: "prod" });');
      expect(migratedContent).toContain('### Gotcha: NexusFlow database locks');
      expect(migratedContent).toContain('Running `nexusflow migrate` acquires an exclusive lock on the database.');
      expect(migratedContent).toContain('See commit 167b4581e70e for details on nexusflow lock acquisition.');
    });
  });

  describe('P1: Overlapping legacy directory contents migration', () => {
    it('recursively merges overlapping subdirectories with distinct nested files without data loss', async () => {
      const wsDir = path.join(tempDir, 'overlap-ws');
      await fs.mkdir(path.join(wsDir, '.nexusflow/base/repo'), { recursive: true });
      await fs.mkdir(path.join(wsDir, '.contextspace/base/repo'), { recursive: true });

      const legacyFile = path.join(wsDir, '.nexusflow/base/repo/nexusflow-knowledge.md');
      const primaryFile = path.join(wsDir, '.contextspace/base/repo/contextspace-knowledge.md');
      const uniqueLegacyContent = 'Unique legacy user knowledge in nested workroom base';
      const uniquePrimaryContent = 'Different existing primary knowledge';

      await fs.writeFile(legacyFile, uniqueLegacyContent, 'utf-8');
      await fs.writeFile(primaryFile, uniquePrimaryContent, 'utf-8');

      const report = await migrateWorkspace(wsDir, { dryRun: false, refresh: false });
      expect(report.isLegacy).toBe(true);

      // Verify that neither file was deleted and both exist in the merged destination
      const transferredDest = path.join(wsDir, '.contextspace/base/repo/nexusflow-knowledge.md');
      expect(existsSync(transferredDest)).toBe(true);
      expect(await fs.readFile(transferredDest, 'utf-8')).toBe(uniqueLegacyContent);

      expect(existsSync(primaryFile)).toBe(true);
      expect(await fs.readFile(primaryFile, 'utf-8')).toBe(uniquePrimaryContent);

      // Verify source directory was completely cleaned up since all entries transferred
      expect(existsSync(path.join(wsDir, '.nexusflow'))).toBe(false);

      // Report should record clean rename with no warnings
      expect(report.warnings.length).toBe(0);
      expect(report.renamedFiles).toContainEqual({
        from: '.nexusflow',
        to: '.contextspace',
        status: 'renamed',
      });
    });

    it('preserves conflicting legacy files in place without overwriting destination files and reports warnings', async () => {
      const wsDir = path.join(tempDir, 'conflict-ws');
      await fs.mkdir(path.join(wsDir, '.nexusflow/base/repo'), { recursive: true });
      await fs.mkdir(path.join(wsDir, '.contextspace/base/repo'), { recursive: true });

      const legacyConflict = path.join(wsDir, '.nexusflow/base/repo/conflict.txt');
      const primaryConflict = path.join(wsDir, '.contextspace/base/repo/conflict.txt');
      const legacyDistinct = path.join(wsDir, '.nexusflow/base/repo/distinct.txt');

      await fs.writeFile(legacyConflict, 'legacy version of conflict', 'utf-8');
      await fs.writeFile(primaryConflict, 'primary version of conflict', 'utf-8');
      await fs.writeFile(legacyDistinct, 'legacy distinct file', 'utf-8');

      const report = await migrateWorkspace(wsDir, { dryRun: false, refresh: false });
      expect(report.isLegacy).toBe(true);

      // Primary file must NOT be overwritten
      expect(await fs.readFile(primaryConflict, 'utf-8')).toBe('primary version of conflict');

      // Conflicting legacy file must be PRESERVED in legacy source directory
      expect(existsSync(legacyConflict)).toBe(true);
      expect(await fs.readFile(legacyConflict, 'utf-8')).toBe('legacy version of conflict');

      // Distinct non-conflicting file must be transferred to destination
      const transferredDistinct = path.join(wsDir, '.contextspace/base/repo/distinct.txt');
      expect(existsSync(transferredDistinct)).toBe(true);
      expect(await fs.readFile(transferredDistinct, 'utf-8')).toBe('legacy distinct file');

      // Legacy directory must NOT be deleted because it still holds the conflicting file
      expect(existsSync(path.join(wsDir, '.nexusflow'))).toBe(true);
      expect(existsSync(path.join(wsDir, '.nexusflow/base/repo'))).toBe(true);

      // Report must include warning and skipped entry
      expect(report.warnings.length).toBeGreaterThan(0);
      expect(report.warnings[0]).toContain('Conflicting legacy file preserved');
      expect(report.renamedFiles).toContainEqual(
        expect.objectContaining({
          status: 'skipped',
          error: expect.stringContaining('conflicting files preserved'),
        }),
      );
    });
  });

  describe('P1: Durable migrated artifacts trackable in workspace Git', () => {
    it('migrates a Git-backed workspace, ensures durable files are not ignored, and commits knowledge', async () => {
      const wsDir = path.join(tempDir, 'git-backed-ws');
      await fs.mkdir(wsDir, { recursive: true });

      // Initialize git repository
      await execa('git', ['init'], { cwd: wsDir });
      await execa('git', ['config', '--local', 'user.name', 'ContextSpace Test'], { cwd: wsDir });
      await execa('git', ['config', '--local', 'user.email', 'test@contextspace.local'], { cwd: wsDir });

      // Seed initial legacy workspace with .gitignore (including legacy ephemeral rules and erroneous durable ignores)
      const initialGitignore = [
        '/.nexusflow-analysis-cache.json',
        'contextspace.json',
        'contextspace.lock',
        'contextspace-*.md',
        '.contextspace',
        '.contextspace*',
      ].join('\n') + '\n';
      await fs.writeFile(path.join(wsDir, '.gitignore'), initialGitignore, 'utf-8');
      await fs.writeFile(
        path.join(wsDir, 'nexusflow.json'),
        JSON.stringify({ id: 'git-feature', branchName: 'git-feature' }, null, 2),
      );
      await fs.writeFile(path.join(wsDir, 'nexusflow-knowledge.md'), '# Workspace Knowledge\n\nInitial knowledge.\n');

      // Stage and commit the initial state
      await execa('git', ['add', '--', '.gitignore', 'nexusflow.json', 'nexusflow-knowledge.md'], { cwd: wsDir });
      await execa('git', ['commit', '-m', 'chore: initial legacy workspace'], { cwd: wsDir });

      // 1. Run migration without refresh
      const report = await migrateWorkspace(wsDir, { dryRun: false, refresh: false });
      expect(report.isLegacy).toBe(true);

      // 2. Verify git add of renamed durable artifacts succeeds with exit code 0 (NOT ignored!)
      const addResult = await execa(
        'git',
        ['add', '--', '.gitignore', 'contextspace.json', 'contextspace-knowledge.md'],
        { cwd: wsDir, reject: false },
      );
      expect(addResult.exitCode).toBe(0);

      // Verify that ephemeral files ARE ignored
      const checkEphemeral = await execa(
        'git',
        ['check-ignore', '.contextspace-analysis-cache.json', '.contextspace/workspace-state.json'],
        { cwd: wsDir, reject: false },
      );
      expect(checkEphemeral.exitCode).toBe(0);

      // Verify that durable files are NOT ignored
      const checkDurable = await execa(
        'git',
        ['check-ignore', 'contextspace.json', 'contextspace-knowledge.md'],
        { cwd: wsDir, reject: false },
      );
      expect(checkDurable.exitCode).toBe(1);

      // 3. Commit workspace artifacts using commitWorkspaceArtifacts
      const commitRes = await commitWorkspaceArtifacts(wsDir, 'chore(migration): adopt ContextSpace artifacts');
      expect(commitRes.committed).toBe(true);
      expect(commitRes.sha).toBeDefined();

      // Verify git log records the rename
      const log = await execa('git', ['log', '-n', '1', '--name-status'], { cwd: wsDir });
      expect(log.stdout).toContain('contextspace.json');
      expect(log.stdout).toContain('contextspace-knowledge.md');

      // 4. Add workspace knowledge and verify it auto-commits successfully
      const knowledgeResult = await addWorkspaceKnowledge(wsDir, {
        type: 'decision',
        title: 'Post-Migration Durability',
        message: 'Durable knowledge files remain fully trackable in Git after migration.',
      });

      expect(knowledgeResult.commit.status).toBe('committed');
      const { stdout: headSha } = await execa('git', ['rev-parse', 'HEAD'], { cwd: wsDir });
      expect(headSha.trim()).toBeTruthy();

      // Verify the knowledge entry was appended to contextspace-knowledge.md
      const updatedKnowledge = await fs.readFile(path.join(wsDir, 'contextspace-knowledge.md'), 'utf-8');
      expect(updatedKnowledge).toContain('Post-Migration Durability');
      expect(updatedKnowledge).toContain('Durable knowledge files remain fully trackable in Git after migration.');

      // Verify git working directory is clean
      const status = await execa('git', ['status', '--porcelain'], { cwd: wsDir });
      expect(status.stdout.trim()).toBe('');
    });
  });
});
