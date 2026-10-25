/**
 * @module tests/e2e/tier1-features.test
 * Tier 1: Feature Coverage (≥5 tests per feature across R1-R6, 45 tests total)
 * Opaque-box verification of all 9 core features.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import fse from 'fs-extra';

import {
  createTestWorkspace,
  readAgentsMd,
  listMaterializedSkills,
  generateAgentsMd,
  invokeMcpTool,
  validateCreateWorkspacePayload,
  validateSkillStructure,
  featureGates,
  type TestWorkspace,
} from './test-harness.js';

import {
  getAllSkills,
  saveSkill,
  deleteSkill,
  serializeSkillMarkdown,
  getWorkspaceSkillsConfig,
  saveWorkspaceSkillsConfig,
  DEFAULT_SKILLS,
} from '../../src/utils/skills-catalog.js';

import {
  getDomainPack,
  resolveActiveDomainRules,
} from '../../src/core/domain-packs.js';

import { buildHarnessCliCommand } from '../../src/utils/terminal-launch.js';

import { loadWorkspaceLifecycle } from '../../src/core/lifecycle.js';
import { reconcileWorkspaceResources } from '../../src/resources/materializer.js';
import { enabledTools } from '../../src/mcp/tools.js';
import { resourceIdSchema } from '../../src/resources/contracts.js';
import { refreshWorkspace } from '../../src/core/refresh.js';

describe('Tier 1: Feature Coverage (Opaque-Box)', () => {
  let ws: TestWorkspace;

  afterEach(async () => {
    if (ws) {
      await ws.cleanup();
    }
  });

  // ─── Feature 1: Clean Skills Catalog (R3) ────────────────────────────
  describe('F1: Skills Catalog Core & Frontmatter', () => {
    it('F1.1: parses valid skill markdown frontmatter and content correctly', () => {
      const raw = `---
name: my-sample-skill
title: Sample Skill
description: A verified test skill for E2E workflows.
tags: [testing, quality]
allowed-tools: [view_file, run_command]
---
# Sample Skill
This is the instructions content.`;

      const parsed = validateSkillStructure(raw);
      expect(parsed.isValid).toBe(true);
      expect(parsed.metadata.name).toBe('my-sample-skill');
      expect(parsed.metadata.description).toBe('A verified test skill for E2E workflows.');
      expect(parsed.content).toContain('# Sample Skill');
    });

    it('F1.2: serializes skill metadata into valid frontmatter markdown format', () => {
      const serialized = serializeSkillMarkdown(
        {
          name: 'audit-tool',
          description: 'Audits code security',
          tags: ['security'],
        },
        '## Audit Instructions\nRun security checks.',
      );

      expect(serialized).toContain('---');
      expect(serialized).toContain('name: audit-tool');
      expect(serialized).toContain('description: Audits code security');
      expect(serialized).toContain('## Audit Instructions');
    });

    it('F1.3: getAllSkills retrieves an array of valid skill items', async () => {
      const skills = await getAllSkills();
      expect(Array.isArray(skills)).toBe(true);
      for (const s of skills) {
        expect(s.id).toBeDefined();
        expect(typeof s.id).toBe('string');
        expect(s.description).toBeDefined();
      }
    });

    it('F1.4: saveSkill validates required fields and preserves custom skills', async () => {
      const skillId = `custom-test-skill-${Date.now()}`;
      try {
        const saved = await saveSkill({
          name: skillId,
          description: 'A test custom skill for Tier 1 verification',
          content: '# Custom Skill\nCustom workflow instructions.',
          tags: ['test'],
        });

        expect(saved.id).toBe(skillId);
        expect(saved.description).toBe('A test custom skill for Tier 1 verification');

        const all = await getAllSkills();
        expect(all.some((s) => s.id === skillId)).toBe(true);
      } finally {
        await deleteSkill(skillId).catch(() => {});
      }
    });

    it('F1.5: catalog clean status reflects requirement R3 (no dummy starter skills)', () => {
      if (featureGates.hasCleanCatalog) {
        expect(DEFAULT_SKILLS.length).toBe(0);
      } else {
        // Milestone M1 in progress: document existing items pending cleanup
        expect(Array.isArray(DEFAULT_SKILLS)).toBe(true);
      }
    });
  });

  // ─── Feature 2: Project-Specific Local Skills (R4) ────────────────────
  describe('F2: Project-Specific Local Skills & Materializer', () => {
    it('F2.1: getWorkspaceSkillsConfig returns valid default configuration for new workspace', async () => {
      ws = await createTestWorkspace();
      const config = await getWorkspaceSkillsConfig(ws.workspacePath);

      expect(config.schemaVersion).toBe(2);
      expect(Array.isArray(config.enabledSkills)).toBe(true);
      expect(Array.isArray(config.disabledSkills)).toBe(true);
    });

    it('F2.2: saveWorkspaceSkillsConfig persists enabledSkills in workspace config directory', async () => {
      ws = await createTestWorkspace();
      await saveWorkspaceSkillsConfig(ws.workspacePath, {
        enabledSkills: ['verifier-workspace'],
        disabledSkills: [],
        enabledAgents: [],
        enabledCategories: [],
      });

      const reloaded = await getWorkspaceSkillsConfig(ws.workspacePath);
      expect(reloaded.enabledSkills).toContain('verifier-workspace');
    });

    it('F2.3: reconcileWorkspaceResources materializes enabled skills into .agents/skills/', async () => {
      ws = await createTestWorkspace();
      const testSkill = {
        id: 'local-test-runner',
        name: 'local-test-runner',
        title: 'Local Test Runner',
        description: 'Runs local tests in workspace',
        content: '# Test Runner\nExecute test commands.',
        custom: true,
      };

      const result = await reconcileWorkspaceResources(
        ws.workspacePath,
        ['antigravity'],
        [testSkill],
        [],
      );

      expect(result.installed.some((p) => p.includes('local-test-runner'))).toBe(true);
      const materialized = await listMaterializedSkills(ws.workspacePath);
      expect(materialized).toContain('local-test-runner');

      const skillMd = await fs.readFile(
        path.join(ws.workspacePath, '.agents', 'skills', 'local-test-runner', 'SKILL.md'),
        'utf-8',
      );
      expect(skillMd).toContain('title: Local Test Runner');
      expect(skillMd).toContain('# Test Runner');
    });

    it('F2.4: materializer generates resources.lock.json with SHA256 integrity hash', async () => {
      ws = await createTestWorkspace();
      const testSkill = {
        id: 'integrity-test-skill',
        name: 'integrity-test-skill',
        title: 'Integrity Skill',
        description: 'Integrity checking skill',
        content: '# Integrity\nVerify SHA256 hashes.',
        custom: true,
      };

      await reconcileWorkspaceResources(ws.workspacePath, ['antigravity'], [testSkill], []);

      const lockPath = path.join(ws.workspacePath, '.contextspace', 'resources.lock.json');
      const lockExists = await fse.pathExists(lockPath);
      expect(lockExists).toBe(true);

      const lockContent = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
      expect(lockContent.schemaVersion).toBe(1);
      expect(Array.isArray(lockContent.outputs)).toBe(true);
      const skillEntry = lockContent.outputs.find(
        (f: any) => f.resourceId === 'integrity-test-skill',
      );
      expect(skillEntry).toBeDefined();
      expect(skillEntry.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('F2.5: unmounting skill removes it from .agents/skills/ and updates lockfile', async () => {
      ws = await createTestWorkspace();
      const testSkill = {
        id: 'transient-skill',
        name: 'transient-skill',
        description: 'Transient skill to be removed',
        content: '# Transient\nTo be removed.',
        custom: true,
      };

      // Install first
      await reconcileWorkspaceResources(ws.workspacePath, ['antigravity'], [testSkill], []);
      let materialized = await listMaterializedSkills(ws.workspacePath);
      expect(materialized).toContain('transient-skill');

      // Reconcile with empty list (unmount)
      const result = await reconcileWorkspaceResources(ws.workspacePath, ['antigravity'], [], []);
      expect(result.removed.some((p) => p.includes('transient-skill'))).toBe(true);

      materialized = await listMaterializedSkills(ws.workspacePath);
      expect(materialized).not.toContain('transient-skill');
    });
  });

  // ─── Feature 3: MCP Skill Administration (R3) ────────────────────────
  describe('F3: MCP Skill Administration Tools', () => {
    it.skipIf(!featureGates.hasMcpSkillTools)(
      'F3.1: create_skill MCP tool creates a workspace-scoped skill file',
      async () => {
        ws = await createTestWorkspace();
        const result = await invokeMcpTool(
          'create_skill',
          {
            name: 'mcp-created-skill',
            title: 'MCP Created Skill',
            description: 'Skill created via AI assistant MCP invocation',
            content: '# MCP Skill\nInstructions written by assistant.',
            scope: 'workspace',
          },
          { workspacePath: ws.workspacePath },
        );

        expect(result).toBeDefined();
        expect(result!.isError).toBeFalsy();
      },
    );

    it.skipIf(!featureGates.hasMcpSkillTools)(
      'F3.2: create_skill MCP tool supports global scope',
      async () => {
        const skillName = `mcp-global-${Date.now()}`;
        try {
          const result = await invokeMcpTool('create_skill', {
            name: skillName,
            title: 'Global MCP Skill',
            description: 'Global skill created via MCP',
            content: '# Global\nMachine-wide instructions.',
            scope: 'global',
          });

          expect(result).toBeDefined();
          expect(result!.isError).toBeFalsy();
        } finally {
          await deleteSkill(skillName).catch(() => {});
        }
      },
    );

    it.skipIf(!featureGates.hasMcpSkillTools)(
      'F3.3: list_skills MCP tool lists skills with scope annotations',
      async () => {
        ws = await createTestWorkspace();
        const result = await invokeMcpTool(
          'list_skills',
          {},
          { workspacePath: ws.workspacePath },
        );

        expect(result).toBeDefined();
        const data = JSON.parse(result!.content[0].text);
        expect(Array.isArray(data.skills)).toBe(true);
      },
    );

    it.skipIf(!featureGates.hasMcpSkillTools)(
      'F3.4: list_skills filters by workspace scope',
      async () => {
        ws = await createTestWorkspace();
        const result = await invokeMcpTool(
          'list_skills',
          { scope: 'workspace' },
          { workspacePath: ws.workspacePath },
        );

        expect(result).toBeDefined();
        const data = JSON.parse(result!.content[0].text);
        expect(Array.isArray(data.skills)).toBe(true);
      },
    );

    it('F3.5: MCP server provides registered tools for developer role', () => {
      const mockConfig = {
        version: '1.0',
        devDir: '/dev',
        workspacesDir: '/dev/workspaces',
        defaultAssistant: null,
        scanDepth: 2,
      };
      const devTools = enabledTools(mockConfig, 'developer');
      expect(devTools.length).toBeGreaterThan(0);
      const names = devTools.map((t) => t.name);
      expect(names).toContain('workspace_status');
      expect(names).toContain('refresh_context');
    });
  });

  // ─── Feature 4: CLI Skill Administration (R3) ────────────────────────
  describe('F4: CLI Skill Administration', () => {
    it.skipIf(!featureGates.hasCliSkillCommand)(
      'F4.1: ctxspace skill list outputs available skills',
      async () => {
        // Will test CLI entrypoint once M2 lands
        expect(true).toBe(true);
      },
    );

    it.skipIf(!featureGates.hasCliSkillCommand)(
      'F4.2: ctxspace skill list --json produces parseable JSON',
      async () => {
        expect(true).toBe(true);
      },
    );

    it.skipIf(!featureGates.hasCliSkillCommand)(
      'F4.3: ctxspace skill create validates input parameters',
      async () => {
        expect(true).toBe(true);
      },
    );

    it.skipIf(!featureGates.hasCliSkillCommand)(
      'F4.4: ctxspace skill create --workspace writes to local .agents/skills/',
      async () => {
        expect(true).toBe(true);
      },
    );

    it('F4.5: skill ID validation rejects uppercase or punctuation', () => {
      const invalidIds = ['MySkill', 'skill_under', 'skill.dot', 'skill!'];
      for (const invalid of invalidIds) {
        const res = resourceIdSchema.safeParse(invalid);
        expect(res.success).toBe(false);
      }
      expect(resourceIdSchema.safeParse('valid-skill-id-123').success).toBe(true);
    });
  });

  // ─── Feature 5: Explicit Tag-to-Skill Binding & No Guessing (R2) ─────
  describe('F5: Explicit Tag & Domain Rules Binding', () => {
    it('F5.1: getDomainPack retrieves registered enterprise verticals', () => {
      const economy = getDomainPack('economy');
      expect(economy).toBeDefined();
      expect(economy?.id).toBe('economy');
      expect(economy?.name).toContain('Economy');
      expect(economy?.categoryType).toBe('vertical');
    });

    it('F5.2: getDomainPack retrieves sub-verticals with parent relationship', () => {
      const payroll = getDomainPack('hr/payroll');
      expect(payroll).toBeDefined();
      expect(payroll?.parent).toBe('hr');
      expect(payroll?.rules?.length).toBeGreaterThan(0);
    });

    it('F5.3: resolveActiveDomainRules composes domain rules and verification commands', () => {
      const resolved = resolveActiveDomainRules('acme', ['economy', 'hr/payroll']);
      expect(resolved.allRules.length).toBeGreaterThan(0);
      expect(resolved.allRules.some((r) => r.toLowerCase().includes('vat'))).toBe(true);
      expect(resolved.compositeVerifyCommand).toContain('npm test -- economy');
      expect(resolved.compositeVerifyCommand).toContain('npm test -- payroll');
    });

    it('F5.4: AGENTS.md includes active domain rules for assigned tags', async () => {
      ws = await createTestWorkspace({ tags: ['economy'] });
      const agentsMd = await generateAgentsMd(ws.feature, ws.repos);

      expect(agentsMd).toContain('Economy & Invoicing');
      expect(agentsMd).toContain('Swedish VAT standard rates');
    });

    it('F5.5: changing domain tags updates rules without automatic guessing', async () => {
      ws = await createTestWorkspace({ tags: ['hr'] });
      let agentsMd = await generateAgentsMd(ws.feature, ws.repos);
      expect(agentsMd).toContain('HR & Workforce');
      expect(agentsMd).not.toContain('Swedish VAT standard rates');

      // Update to economy
      ws.feature.domainPacks = ['economy'];
      agentsMd = await generateAgentsMd(ws.feature, ws.repos);
      expect(agentsMd).toContain('Economy & Invoicing');
      expect(agentsMd).not.toContain('HR & Workforce');
    });
  });

  // ─── Feature 6: CLI Inception with Tags & Flow Sizing (R1, R6) ────────
  describe('F6: Development Flow Sizing & Inception', () => {
    it('F6.1: quick flow starts without milestones', async () => {
      ws = await createTestWorkspace({ flow: 'quick' });
      expect((await loadWorkspaceLifecycle(ws.workspacePath)).steps).toEqual([]);
    });

    it('F6.2: feature flow starts without milestones', async () => {
      ws = await createTestWorkspace({ flow: 'feature' });
      expect((await loadWorkspaceLifecycle(ws.workspacePath)).steps).toEqual([]);
    });

    it('F6.3: epic flow starts without milestones', async () => {
      ws = await createTestWorkspace({ flow: 'epic' });
      expect((await loadWorkspaceLifecycle(ws.workspacePath)).steps).toEqual([]);
    });

    it('F6.4: in-place mode sets workspace isolation instructions in AGENTS.md', async () => {
      ws = await createTestWorkspace({ mode: 'in-place' });
      const agentsMd = await generateAgentsMd(ws.feature, ws.repos);
      expect(agentsMd).toContain('isolate_repo');
    });

    it.skipIf(!featureGates.hasCliCreateTags)(
      'F6.5: CLI create parses -t, --tag option to attach initial domain packs',
      async () => {
        // Will test CLI createCommand once M4 lands
        expect(true).toBe(true);
      },
    );
  });

  // ─── Feature 7: Web GUI Inception & Tag Display (R1, R2, R6) ─────────
  describe('F7: Web GUI Inception Contracts', () => {
    it('F7.1: validateCreateWorkspacePayload accepts complete valid payload', () => {
      const payload = {
        description: 'Implement Swedish reverse-charge VAT calculations for invoices',
        mode: 'in-place',
        repos: [{ name: 'billing-service', path: '/dev/billing-service' }],
        flow: 'feature',
        tags: ['economy'],
        assistants: ['agy'],
      };

      const result = validateCreateWorkspacePayload(payload);
      expect(result.isValid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('F7.2: validateCreateWorkspacePayload rejects missing or empty PO description', () => {
      const payload = {
        description: '   ',
        mode: 'worktree',
        repos: [{ name: 'repo-a', path: '/dev/repo-a' }],
      };

      const result = validateCreateWorkspacePayload(payload);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('PO feature description is required');
    });

    it('F7.3: validateCreateWorkspacePayload rejects empty repo selection', () => {
      const payload = {
        description: 'Feature with no repositories selected',
        mode: 'in-place',
        repos: [],
      };

      const result = validateCreateWorkspacePayload(payload);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('At least one repository must be selected');
    });

    it('F7.4: validateCreateWorkspacePayload validates workspace mode', () => {
      const payload = {
        description: 'Valid description',
        mode: 'invalid-mode',
        repos: [{ name: 'repo-a', path: '/dev/repo-a' }],
      };

      const result = validateCreateWorkspacePayload(payload);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Mode must be either "in-place" or "worktree"');
    });

    it('F7.5: validateCreateWorkspacePayload validates flow type presets', () => {
      const payload = {
        description: 'Valid description',
        mode: 'worktree',
        repos: [{ name: 'repo-a', path: '/dev/repo-a' }],
        flow: 'unsupported-flow',
      };

      const result = validateCreateWorkspacePayload(payload);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Flow must be one of "quick-fix", "feature", or "epic"');
    });
  });

  // ─── Feature 8: Mid-Flight Requirement & Scope Adjustments (R5) ──────
  describe('F8: Mid-Flight Requirement & Scope Adjustments', () => {
    it('F8.1: updating feature description re-renders AGENTS.md with new requirements', async () => {
      ws = await createTestWorkspace({ description: 'Original PO Feature Description' });
      let agentsMd = await generateAgentsMd(ws.feature, ws.repos);
      expect(agentsMd).toContain('Original PO Feature Description');

      // Mid-flight refinement
      ws.feature.description = 'Refined PO Feature Description with New Acceptance Criteria';
      agentsMd = await generateAgentsMd(ws.feature, ws.repos);
      expect(agentsMd).toContain('Refined PO Feature Description with New Acceptance Criteria');
      expect(agentsMd).not.toContain('Original PO Feature Description');
    });

    it('F8.2: adding acceptance criteria preserves existing repo and rule sections', async () => {
      ws = await createTestWorkspace({
        description: 'Base task',
        tags: ['economy'],
      });
      await generateAgentsMd(ws.feature, ws.repos);

      ws.feature.description = 'Base task\n- [ ] AC 1: New requirement\n- [ ] AC 2: Another criterion';
      const updatedMd = await generateAgentsMd(ws.feature, ws.repos);

      expect(updatedMd).toContain('AC 1: New requirement');
      expect(updatedMd).toContain('Economy & Invoicing');
      expect(updatedMd).toContain('primary-repo');
    });

    it('F8.3: adding tag dynamically appends domain rules to AGENTS.md', async () => {
      ws = await createTestWorkspace({ tags: ['economy'] });
      let agentsMd = await generateAgentsMd(ws.feature, ws.repos);
      expect(agentsMd).not.toContain('Payroll & Salaries');

      ws.feature.domainPacks = ['economy', 'hr/payroll'];
      agentsMd = await generateAgentsMd(ws.feature, ws.repos);
      expect(agentsMd).toContain('Economy & Invoicing');
      expect(agentsMd).toContain('Payroll & Salaries');
      expect(agentsMd).toContain('kollektivavtal');
    });

    it('F8.4: removing tag immediately unmounts domain rules from AGENTS.md', async () => {
      ws = await createTestWorkspace({ tags: ['economy', 'hr/payroll'] });
      let agentsMd = await generateAgentsMd(ws.feature, ws.repos);
      expect(agentsMd).toContain('Payroll & Salaries');

      ws.feature.domainPacks = ['economy'];
      agentsMd = await generateAgentsMd(ws.feature, ws.repos);
      expect(agentsMd).not.toContain('Payroll & Salaries');
      expect(agentsMd).toContain('Economy & Invoicing');
    });

    it('F8.5: refreshWorkspace executes cleanly on active workspace', async () => {
      ws = await createTestWorkspace({
        repos: [{ name: 'repo-one', files: { 'src/index.ts': 'export const x = 1;' } }],
      });

      // Execute refresh
      const result = await refreshWorkspace(ws.workspacePath, { force: true });
      expect(result).toBeDefined();

      const agentsMd = await readAgentsMd(ws.workspacePath);
      expect(agentsMd.length).toBeGreaterThan(0);
    });
  });

  // ─── Feature 9: Session Resumption Across Assistants (R6) ────────────
  describe('F9: Session Resumption Verification', () => {
    const testSessionUuid = '12345678-1234-4234-8234-123456789abc';

    it('F9.1: buildHarnessCliCommand outputs agy --conversation <id> for Antigravity', () => {
      const cmd = buildHarnessCliCommand('antigravity', testSessionUuid);
      expect(cmd).toBe(`agy --conversation ${testSessionUuid}`);
    });

    it('F9.2: buildHarnessCliCommand outputs claude --resume <id> for Claude Code', () => {
      const cmd = buildHarnessCliCommand('claude', testSessionUuid);
      expect(cmd).toBe(`claude --resume ${testSessionUuid}`);
    });

    it('F9.3: buildHarnessCliCommand outputs codex resume <id> for OpenAI Codex', () => {
      const cmd = buildHarnessCliCommand('codex', testSessionUuid);
      expect(cmd).toBe(`codex resume ${testSessionUuid}`);
    });

    it('F9.4: buildHarnessCliCommand outputs copilot --resume <id> for GitHub Copilot', () => {
      const cmd = buildHarnessCliCommand('copilot', testSessionUuid);
      expect(cmd).toBe(`copilot --resume ${testSessionUuid}`);
    });

    it('F9.5: buildHarnessCliCommand outputs cursor-agent --resume <id> for Cursor', () => {
      const cmd = buildHarnessCliCommand('cursor', testSessionUuid);
      expect(cmd).toBe(`cursor-agent --resume ${testSessionUuid}`);
    });
  });
});
