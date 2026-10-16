import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildContextContent } from './base.js';
import { renderPlanInstructions } from '../core/plan-text.js';
import { PLAN_RULES, WHO_ACTS } from '../core/plan-words.js';
import type { Feature, ProjectAnalysis, WorkspaceContext } from '../types.js';

/** Minimal ProjectAnalysis with the fields the context builder reads. */
function analysisFor(name: string, repoPath: string, languages: string[]): ProjectAnalysis {
  return {
    name,
    path: repoPath,
    techStack: { languages, frameworks: [], buildTools: [], projectType: 'backend' },
    ports: [],
    existingAIConfigs: [],
    readmeSummary: '',
  } as unknown as ProjectAnalysis;
}

describe('buildContextContent', () => {
  let dir: string;
  let nodeRepo: string;
  let pyRepo: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-base-test-'));
    nodeRepo = path.join(dir, 'my-web');
    await fs.mkdir(nodeRepo, { recursive: true });
    await fs.writeFile(
      path.join(nodeRepo, 'package.json'),
      JSON.stringify({ name: 'my-web', scripts: { dev: 'vite --port 5173' } }),
      'utf-8',
    );
    pyRepo = path.join(dir, 'my-tool');
    await fs.mkdir(pyRepo, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  function ctxFor(feature: Partial<Feature>): WorkspaceContext {
    const base: Feature = {
      id: 'feat',
      branchName: 'feat',
      description: 'add a discount code to checkout',
      repos: [nodeRepo, pyRepo],
      assistants: ['claude'],
      workspacePath: path.join(dir, 'ws'),
      createdAt: '2026-07-17T00:00:00.000Z',
      ...feature,
    };
    return {
      feature: base,
      repos: [
        { name: 'my-web', path: nodeRepo, defaultBranch: 'main' },
        { name: 'my-tool', path: pyRepo, defaultBranch: 'main' },
      ],
      analysis: new Map([
        [nodeRepo, analysisFor('my-web', nodeRepo, ['typescript'])],
        [pyRepo, analysisFor('my-tool', pyRepo, ['python'])],
      ]),
    };
  }

  /** `my-tool` publishes a package `my-web` consumes. */
  function relatedCtx(): WorkspaceContext {
    const ctx = ctxFor({});
    const tool = ctx.analysis!.get(pyRepo)!;
    const web = ctx.analysis!.get(nodeRepo)!;
    (tool as { produces?: unknown }).produces = [{ name: 'shared-lib', type: 'npm' }];
    (web as { dependencies?: unknown }).dependencies = [
      { name: 'shared-lib', type: 'npm' },
      { name: 'react', type: 'npm' },
    ];
    return ctx;
  }

  describe('what it must say', () => {
    it('leads with the task, because that is what the work is', async () => {
      const content = await buildContextContent(ctxFor({}));

      expect(content.startsWith('# feat')).toBe(true);
      expect(content).toContain('add a discount code to checkout');
    });

    it('gives every repo a location and a verify command in one row', async () => {
      const content = await buildContextContent(ctxFor({}));

      expect(content).toContain('| `my-web` | `my-web` | `npm test` |');
      expect(content).toContain('| `my-tool` | `my-tool` | `pytest` |');
    });

    it('formats multiple verify commands with fast gate first for mixed repositories', async () => {
      const mixedRepo = path.join(dir, 'my-mixed');
      const ctx = ctxFor({});
      ctx.repos.push({ name: 'my-mixed', path: mixedRepo, defaultBranch: 'main' });
      ctx.analysis!.set(mixedRepo, analysisFor('my-mixed', mixedRepo, ['csharp', 'typescript']));

      const content = await buildContextContent(ctx);

      expect(content).toContain('| `my-mixed` | `my-mixed` | `npm test`, `dotnet test` |');
    });

    it('states the cross-repo tie in both directions', async () => {
      // The one thing a single-repo view cannot show, and the reason a
      // multi-repo workspace is worth generating at all.
      const content = await buildContextContent(relatedCtx());

      expect(content).toContain('used by `my-web`');
      expect(content).toContain('needs `my-tool`');
    });

    it('does not invent a dependency from a coincidental name fragment', async () => {
      // `findInterRepoDependencies` had a substring fallback. Its only consumer
      // was a graph nobody read; now it feeds the auto-loaded context file, where
      // a repo called `my-tool` beside one declaring `@babel/my-tool-kit` would
      // manufacture `needs`, `used by` and a start order out of nothing.
      const ctx = ctxFor({});
      (ctx.analysis!.get(pyRepo)! as { produces?: unknown }).produces = [
        { name: 'my-tool', type: 'npm' },
      ];
      (ctx.analysis!.get(nodeRepo)! as { dependencies?: unknown }).dependencies = [
        { name: '@babel/my-tool-kit', type: 'npm' },
        { name: 'my-tooling', type: 'npm' },
      ];

      const content = await buildContextContent(ctx);

      expect(content).not.toContain('needs `');
      expect(content).not.toContain('used by `');
      expect(content).not.toContain('Start with');
    });

    it('names where to start, and orders the rows to match', async () => {
      const content = await buildContextContent(relatedCtx());

      expect(content).toContain('Start with `my-tool`');
      expect(content.indexOf('| `my-tool` |')).toBeLessThan(content.indexOf('| `my-web` |'));
    });

    it('does not name a starting repo that nothing builds on', async () => {
      // The old test was "does any repo anywhere have a dependency", so a
      // workspace whose first repo is independent still got "Start with `x` —
      // the others build on it" directly under x's own all-dashes row.
      const ctx = relatedCtx();
      const alpha = path.join(dir, 'alpha');
      ctx.repos = [{ name: 'alpha', path: alpha, defaultBranch: 'main' }, ...ctx.repos];
      ctx.analysis!.set(alpha, analysisFor('alpha', alpha, ['typescript']));

      const content = await buildContextContent(ctx);

      expect(content).not.toContain('Start with `alpha`');
      expect(content).toContain('Start with `my-tool`');
    });

    it('surfaces hand-entered commands, which no manifest states', async () => {
      // The only reader of feature.resumption was deleted as dead code, while
      // the create API still accepted and persisted these.
      const ctx = ctxFor({});
      ctx.feature.resumption = {
        testCommand: 'npm run verify:all',
        mockCommand: 'docker compose up -d',
        startCommand: 'npm run dev:all',
      };

      const content = await buildContextContent(ctx);

      expect(content).toContain('npm run verify:all');
      expect(content).toContain('docker compose up -d');
      expect(content).toContain('npm run dev:all');
    });

    it('says nothing about custom commands when none were entered', async () => {
      const content = await buildContextContent(ctxFor({}));

      expect(content).not.toContain('Commands recorded for this workspace');
    });

    it('keeps the worktree rule, which is not inferable', async () => {
      const content = await buildContextContent(ctxFor({}));

      expect(content).toContain('Do not edit the original repositories elsewhere on disk');
      expect(content).toContain('`feat`');
    });

    it('points at the other files rather than inlining them', async () => {
      const content = await buildContextContent(ctxFor({}));

      expect(content).toContain('contextspace-knowledge.md');
      expect(content).toContain('contextspace-plan.md');
    });

    it('does not send the agent to read derived facts it could grep', async () => {
      // The architecture map restated the repo's package.json, and the branch
      // diff was `git diff --name-only` with absolute file:/// URLs. Both were
      // pointed at ahead of any real work.
      const content = await buildContextContent(ctxFor({}));

      expect(content).not.toContain('nexusflow-map');
      expect(content).not.toContain('.nexusflow/base');
      expect(content).not.toContain('nexusflow-diff-context');
    });

    it('tells the agent to search the knowledge file, not read it whole', async () => {
      // It reached 38 KB on a real workspace — about 9,500 tokens — while the
      // pointer said "skim the headings", which costs the entire file to do.
      const content = await buildContextContent(ctxFor({}));

      expect(content).toContain('`###` heading');
      expect(content).toContain('not the whole file');
    });

    it('documents direct file append fallback when the CLI is not on PATH', async () => {
      const content = await buildContextContent(ctxFor({}));

      expect(content).toContain('append a `### <YYYY-MM-DD> — <Title>` heading directly');
    });

    it('provides file-based fallback when MCP server is not connected', async () => {
      const content = await buildContextContent(ctxFor({}));

      expect(content).toContain('if the MCP server is not connected');
    });

    it('steers knowledge capture toward facts not recoverable from code', async () => {
      const content = await buildContextContent(ctxFor({}));

      expect(content).toContain('cannot be recovered from the code or git history');
      expect(content).toContain('Avoid restating structure the code already shows');
    });

    it('names repos that carry their own instructions, which override these', async () => {
      const ctx = ctxFor({});
      (ctx.analysis!.get(nodeRepo)! as { existingAIConfigs: unknown }).existingAIConfigs = [
        { relativePath: 'CLAUDE.md', assistant: 'claude' },
      ];

      const content = await buildContextContent(ctx);

      expect(content).toContain('take precedence');
      expect(content).toContain('`my-web` (CLAUDE.md)');
    });
  });

  describe('what it must NOT say', () => {
    // Two independent agents evaluating a generated workspace used none of this,
    // and it is where a wrong claim appeared: "Build tools: none detected" for a
    // repo whose package.json has "build": "tsc". Anything a manifest already
    // states is better read from the manifest, where it cannot go stale.
    it('omits per-repo tech-stack metadata, which is derivable and went stale', async () => {
      const content = await buildContextContent(ctxFor({}));

      for (const label of ['**Type**', '**Languages**', '**Frameworks**', '**Build tools**', '**Ports**']) {
        expect(content, label).not.toContain(label);
      }
    });

    it('omits First Steps, which told the agent to stop and ask for approval', async () => {
      const content = await buildContextContent(ctxFor({}));

      expect(content).not.toContain('First Steps');
      expect(content).not.toContain('Obtain Approval');
      expect(content).not.toContain('before writing any code');
    });

    it('omits absolute file:/// links, which were 24% of the old file', async () => {
      const content = await buildContextContent(ctxFor({}));

      expect(content).not.toContain('file:///');
    });

    it('omits the git and npm advice any assistant already follows', async () => {
      const content = await buildContextContent(ctxFor({}));

      expect(content).not.toContain('git status');
      expect(content).not.toContain('npm install');
      expect(content).not.toContain('**Instruction**');
    });

    it('omits cross-harness collaboration stream instructions that cause token waste', async () => {
      const content = await buildContextContent(ctxFor({}));

      expect(content).not.toContain('read_workroom_stream');
      expect(content).not.toContain('post_workroom_handoff');
    });

    it('points agents at request_user_input in one line, with a fallback when MCP is absent', async () => {
      const content = await buildContextContent(ctxFor({}));

      const mentions = content.split('\n').filter((line) => line.includes('request_user_input'));
      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toContain('end your turn');
      expect(mentions[0]).toContain('No MCP');
    });

    it('points agents at the screen tools in one line, saying they only show things, with a fallback when MCP is absent', async () => {
      const content = await buildContextContent(ctxFor({}));

      const mentions = content.split('\n').filter((line) => line.includes('show_in_reader'));
      expect(mentions).toHaveLength(1);
      for (const tool of ['annotate_document', 'suggest_next']) expect(mentions[0]).toContain(tool);
      expect(mentions[0]).toContain('only show things');
      expect(mentions[0]).toContain('No MCP');
    });

    it('tells every AI tool to work with the plan through ctxspace plan, with the routine, the rules and who acts', async () => {
      const content = await buildContextContent(ctxFor({}));

      expect(content).toContain(renderPlanInstructions());
      expect(content.indexOf('## Plan')).toBeLessThan(content.indexOf('## Where to look'));
      expect(content).toContain('1. Start by running `ctxspace plan`.');
      expect(content).toContain('   - stuck: `ctxspace plan block <code> --reason "<what you wait for>"`');
      PLAN_RULES.forEach((rule, index) => expect(content).toContain(`${index + 1}. ${rule}`));
      expect(content).toContain(WHO_ACTS.slice(0, 2).join(' '));
      expect(content).toContain('./.contextspace/bin/ctxspace plan');
      // The plan has no MCP tools: AIs are never sent to the old planning tools.
      for (const tool of ['update_milestone_plan', 'set_milestone', 'get_planning_notes', 'save_planning_notes']) expect(content).not.toContain(tool);
    });

    it('says nothing about relationships or ordering when there are none', async () => {
      // An empty "needs: none" column and a start hint that asserts a
      // non-existent dependency would both be worse than silence.
      const content = await buildContextContent(ctxFor({}));

      expect(content).not.toContain('needs `');
      expect(content).not.toContain('used by `');
      expect(content).not.toContain('Start with');
    });
  });

  describe('size', () => {
    it('stays small enough not to crowd the context window', async () => {
      // The docs advise under 200 lines because longer files reduce adherence,
      // not merely cost tokens. Two repos should be nowhere near that.
      const content = await buildContextContent(relatedCtx());

      // The Plan section is allowed on top of the caps below: in the agy and Haiku test, its work
      // routine cut agy's tool calls from 166 to 58. It has a cap of its own.
      const plan = renderPlanInstructions();
      expect(content.split('\n').length - plan.split('\n').length).toBeLessThan(40);
      // 1600 until the request_user_input pointer was added, then 1800 until the
      // screen-tool pointer. Agents that load MCP tools on demand need a line like
      // each to know the tools exist; these are the two lines allowed past the old cap.
      expect(content.length - plan.length).toBeLessThan(2000);
      expect(plan.split('\n').length).toBeLessThan(25);
      expect(plan.length).toBeLessThan(2600);
    });
  });

  describe('in-place mode', () => {
    it('gives absolute paths and each repo branch, which vary per repo', async () => {
      const ctx = ctxFor({ mode: 'in-place' });
      ctx.feature.repoBranches = { 'my-web': 'existing-feature' };

      const content = await buildContextContent(ctx);

      expect(content).toContain(nodeRepo);
      expect(content).toContain('(on existing-feature)');
      expect(content).toContain('READ-ONLY reference mode');
      expect(content).not.toContain('Do not edit the original repositories');
    });
  });

  describe('robustness', () => {
    it('keeps both repos when two share a basename', async () => {
      // In-place workspaces can hold /org1/api and /org2/api. Ordering keyed by
      // name collapsed them and one row vanished from the table with no error.
      const ctx = ctxFor({ mode: 'in-place' });
      const other = path.join(dir, 'org2', 'my-web');
      ctx.repos = [
        { name: 'my-web', path: nodeRepo, defaultBranch: 'main' },
        { name: 'my-web', path: other, defaultBranch: 'main' },
      ];
      ctx.feature.repos = [nodeRepo, other];

      const content = await buildContextContent(ctx);

      expect(content).toContain(nodeRepo);
      expect(content).toContain(other);
      expect(content.split('\n').filter((l) => l.startsWith('| `my-web`')).length).toBe(2);
    });

    it('survives an analysis with no dependency list rather than throwing', async () => {
      await expect(buildContextContent(ctxFor({}))).resolves.toContain('## Repos');
    });

    it('still lists repos when there is no analysis at all', async () => {
      const ctx = ctxFor({});
      ctx.analysis = undefined;

      const content = await buildContextContent(ctx);

      expect(content).toContain('`my-web`');
      expect(content).toContain('`my-tool`');
    });

    it('says the workspace is empty rather than heading an empty table', async () => {
      // A table header over no rows followed by "Each repo above is a separate
      // git worktree" describes nothing at all.
      const ctx = ctxFor({});
      ctx.repos = [];
      ctx.feature.repos = [];

      const content = await buildContextContent(ctx);

      expect(content).toContain('no repositories yet');
      expect(content).not.toContain('| Repo |');
      expect(content).not.toContain('Each repo above');
    });

    it('names own-instruction repos only from this workspace', async () => {
      // The list walked the analysis map, so an entry for a repo outside this
      // workspace could put its name in the generated file.
      const ctx = ctxFor({});
      const stranger = path.join(dir, 'not-in-this-workspace');
      const strayAnalysis = analysisFor('stranger', stranger, ['typescript']);
      (strayAnalysis as { existingAIConfigs: unknown }).existingAIConfigs = [
        { relativePath: 'CLAUDE.md', assistant: 'claude' },
      ];
      ctx.analysis!.set(stranger, strayAnalysis);

      const content = await buildContextContent(ctx);

      expect(content).not.toContain('stranger');
    });

    it('carries the teamwork strategy when one was chosen', async () => {
      const content = await buildContextContent(
        ctxFor({ teamworkInstructions: '# Plan then implement' }),
      );

      expect(content).toContain('How to work together');
      expect(content).toContain('Plan then implement');
    });
  });

  describe('enterprise conventions & domain rules', () => {
    it('injects organization conventions when organizationId is present', async () => {
      const content = await buildContextContent(
        ctxFor({ organizationId: 'acme' }),
      );

      expect(content).toContain('## Organization Conventions (Acme Corp)');
      expect(content).toContain('Commit Convention');
      expect(content).toContain('feat(ECO-412)');
      expect(content).toContain('All commit messages should follow conventional commits');
    });

    it('injects active domain rules without polluting other domains', async () => {
      const content = await buildContextContent(
        ctxFor({ organizationId: 'acme', domainPacks: ['economy'] }),
      );

      expect(content).toContain('## Organization Conventions (Acme Corp)');
      expect(content).toContain('## Active Domain Rules (Economy & Invoicing)');
      expect(content).toContain('Swedish VAT standard rates');
      expect(content).toContain('Domain Verification');

      // Crucial: no leaking HR or Transport rules
      expect(content).not.toContain('GDPR Compliance: Personal identity numbers');
      expect(content).not.toContain('Vehicle telemetry');
    });
  });
});
