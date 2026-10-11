import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { generateImplementationPlan } from './plan-generator.js';
import { loadWorkspaceState, saveWorkspaceState } from '../core/workspace-state.js';
import { updateWorkGuidance } from '../core/work-guidance.js';
import { PLANNING_NOTES_FILE } from '../core/planning-notes.js';
import { BUILD_ORDER_HEADING } from '../core/plan-summary.js';
import { changePlan } from '../core/plan.js';
import type { Feature, ProjectAnalysis, RepoInfo, WorkspaceContext } from '../types.js';

import { PRIMARY_PLAN_FILE, BRAND_NAME, CLI_NAME } from '../core/constants.js';

type Produced = NonNullable<ProjectAnalysis['produces']>[number];
type Consumed = ProjectAnalysis['dependencies'][number];

function analysisFor(
  name: string,
  repoPath: string,
  opts: { produces?: Produced[]; dependencies?: Consumed[]; languages?: string[] } = {},
): ProjectAnalysis {
  return {
    name,
    path: repoPath,
    techStack: {
      languages: opts.languages ?? ['typescript'],
      frameworks: [],
      buildTools: [],
      projectType: 'backend',
    },
    ports: [],
    existingAIConfigs: [],
    readmeSummary: '',
    produces: opts.produces,
    dependencies: opts.dependencies ?? [],
  } as unknown as ProjectAnalysis;
}

describe('generateImplementationPlan', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextspace-plan-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  /** Builds a context over the given repos and returns the written plan. */
  async function planFor(
    repos: RepoInfo[],
    analysis: Map<string, ProjectAnalysis>,
  ): Promise<string> {
    const feature: Feature = {
      id: 'feat',
      branchName: 'feat',
      description: 'add a discount code to checkout',
      repos: repos.map((r) => r.path),
      assistants: ['claude'],
      workspacePath: dir,
      createdAt: '2026-07-30T00:00:00.000Z',
    };
    const ctx: WorkspaceContext = { feature, repos, analysis };
    await fs.writeFile(path.join(dir, 'contextspace.json'), JSON.stringify(feature));

    await generateImplementationPlan(ctx, dir);
    return fs.readFile(path.join(dir, PRIMARY_PLAN_FILE), 'utf-8');
  }

  /** Two repos with no package relationship between them. */
  function unrelated(): [RepoInfo[], Map<string, ProjectAnalysis>] {
    const a = path.join(dir, 'web');
    const b = path.join(dir, 'tool');
    return [
      [
        { name: 'web', path: a, defaultBranch: 'main' },
        { name: 'tool', path: b, defaultBranch: 'main' },
      ],
      new Map([
        [a, analysisFor('web', a)],
        [b, analysisFor('tool', b)],
      ]),
    ];
  }

  /** `core` publishes a package `web` depends on. */
  function related(): [RepoInfo[], Map<string, ProjectAnalysis>] {
    const core = path.join(dir, 'core');
    const web = path.join(dir, 'web');
    return [
      [
        { name: 'core', path: core, defaultBranch: 'main' },
        { name: 'web', path: web, defaultBranch: 'main' },
      ],
      new Map([
        [core, analysisFor('core', core, { produces: [{ name: '@acme/core', type: 'npm' }] })],
        [web, analysisFor('web', web, { dependencies: [{ name: '@acme/core', type: 'npm', version: '^1.0.0' }] })],
      ]),
    ];
  }

  describe('the plan summary', () => {
    it('writes the brief and the plan in the Plan tab\'s words, with no HTML comments', async () => {
      await saveWorkspaceState({ workspacePath: dir, repos: {}, updatedAt: '', lifecycle: {
        workspaceId: 'feat', flowType: 'epic', fleet: [], updatedAt: '',
        steps: [{ id: 'measure', title: 'Measure latency', status: 'in_progress', branch: 'performance/baseline' },
          { id: 'improve', title: 'Improve lookup', status: 'pending', dependsOn: ['measure'] }],
      } });
      const content = await planFor(...unrelated());
      expect(content.startsWith('# Plan — feat\n')).toBe(true);
      expect(content).toContain('- **Goal:** add a discount code to checkout');
      expect(content).toContain('```text\n');
      expect(content).toContain('MILESTONES  in order');
      expect(content).toContain('measure Measure latency · in progress');
      expect(content).toContain('waits for: measure Measure latency (in progress)');
      expect(content).toContain(`${CLI_NAME} plan`);
      expect(content).not.toContain('<!--');
      // Recent changes carry times like "3 min ago", which would change the file on every rewrite.
      expect(content).not.toContain('WHAT CHANGED');
    });

    it('takes the brief from the saved assignment', async () => {
      const repo = path.join(dir, 'app');
      await fs.writeFile(path.join(dir, 'contextspace.json'), JSON.stringify({ id: 'feat', branchName: 'feat', description: 'Improve checkout', repos: [repo], assistants: [] }));
      await updateWorkGuidance(dir, { revision: 0, workType: 'feature', size: 'standard', assignment: {
        stage: 'investigate', objective: 'Find the slow checkout step', expectedOutput: 'A measured profile', stopCondition: 'Before changing code',
      } });
      const content = await planFor([{ name: 'app', path: repo, defaultBranch: 'main' }], new Map([[repo, analysisFor('app', repo)]]));
      expect(content).toContain('- **Goal:** Find the slow checkout step');
      expect(content).toContain('- **Stage:** Investigate');
      expect(content).toContain('- **Expected output:** A measured profile');
      expect(content).toContain('- **Stop when:** Before changing code');
      expect((await loadWorkspaceState(dir)).lifecycle).toBeUndefined();
    });

    it('says when the plan is empty, and how to add to it', async () => {
      const content = await planFor(...unrelated());
      expect(content).toContain('The plan has no items yet. Add one: ctxspace plan add milestone');
    });

    it('shows a blocked milestone with what it waits on', async () => {
      const repo = path.join(dir, 'app');
      await saveWorkspaceState({ workspacePath: dir, repos: {}, updatedAt: '', lifecycle: {
        workspaceId: 'feat', flowType: 'feature', updatedAt: '',
        steps: [{ id: 'access', title: 'Get test access', status: 'blocked', unblockCondition: 'the test account is available' }],
      } });
      const content = await planFor([{ name: 'app', path: repo, defaultBranch: 'main' }], new Map([[repo, analysisFor('app', repo)]]));
      expect(content).toContain('access Get test access · blocked');
      expect(content).toContain('the test account is available');
    });

    it('explains how to attach a repo to an empty workspace', async () => {
      const content = await planFor([], new Map());
      expect(content).toContain('- **Repository:** None yet.');
      expect(content).toContain(`${CLI_NAME} add-repo`);
      expect(content).not.toContain(BUILD_ORDER_HEADING);
    });

    it('reads the same when nothing changed, so a refresh makes no git change', async () => {
      const first = await planFor(...related());
      const second = await planFor(...related());
      expect(second).toBe(first);
    });

    it('leaves the old planning notes exactly as they were: moving them is the refresh\'s job', async () => {
      const authoredNotes = '# Delivery plan and open questions\n\n| Milestone ID | Outcome |\n| --- | --- |\n| m1 | Ship the discount code |\n';
      await fs.writeFile(path.join(dir, PLANNING_NOTES_FILE), authoredNotes);
      await planFor(...related());
      expect(await fs.readFile(path.join(dir, PLANNING_NOTES_FILE), 'utf-8')).toBe(authoredNotes);
    });
  });

  describe('when no repo depends on another', () => {
    it('says so once instead of five times', async () => {
      const content = await planFor(...unrelated());

      expect(content).toContain(BUILD_ORDER_HEADING);
      expect(content).toContain('No package dependencies were detected');
      // Every section below existed only to describe cross-repo structure.
      expect(content).not.toContain('```mermaid');
      expect(content).not.toContain('Suggested order');
      expect(content).not.toContain('Dependency table');
      expect(content).not.toContain('Contracts and clients');
      expect(content).not.toContain('Local package development loop');
    });

    it('never claims other repos depend on them, because none do', async () => {
      const content = await planFor(...unrelated());

      expect(content).not.toContain('Other repos depend on them');
      expect(content).not.toContain('depended on by');
    });

    it('words itself for the repo count, and says nothing about order for one repo', async () => {
      const [repos, analysis] = unrelated();
      const several = await planFor(repos, analysis);
      expect(several).toContain('between the 2 repos');
      expect(several).toContain('add a dependency from one of these repos');

      const [single] = repos;
      const one = await planFor([single!], new Map([[single!.path, analysis.get(single!.path)!]]));
      expect(one).not.toContain(BUILD_ORDER_HEADING);
      expect(one).not.toContain(`${CLI_NAME} add-repo`);
      expect(one).not.toContain('the single repo');
      expect(one).not.toContain('one of these repos to another');
    });

    it('stays short: the build order is one sentence', async () => {
      const content = await planFor(...unrelated());

      expect(content.length).toBeLessThan(1600);
      expect(content.split('No package dependencies were detected').length - 1).toBe(1);
    });

    it('says how to get a real build order', async () => {
      const content = await planFor(...unrelated());

      expect(content).toContain(`${CLI_NAME} refresh`);
    });
  });

  describe('when one repo depends on another', () => {
    it('emits the order, the diagram and the table', async () => {
      const content = await planFor(...related());

      expect(content).toContain('```mermaid');
      expect(content).toContain('### Suggested order');
      expect(content).toContain('### Dependency table');
      expect(content.indexOf('**Repos:** core')).toBeLessThan(content.indexOf('**Repos:** web'));
    });

    it('names the actual downstream consumer rather than asserting one exists', async () => {
      const content = await planFor(...related());

      expect(content).toContain('core is depended on by a later phase');
    });

    it('lists the shared package with its real consumer', async () => {
      const content = await planFor(...related());

      expect(content).toContain('### Contracts and clients');
      expect(content).toContain('| `@acme/core` | `core` | `web` | `npm` |');
      expect(content).not.toContain('^1.0.0');
      expect(content).not.toContain('_None_');
    });

    it('gives the npm dev loop and not the NuGet one', async () => {
      const content = await planFor(...related());

      expect(content).toContain('### Local package development loop');
      expect(content).toContain('npm link');
      expect(content).not.toContain('dotnet pack');
    });

    it('omits the Contributing Projects column when nothing has one', async () => {
      // It is a .csproj-only concept; an npm workspace rendered it as a dash.
      const content = await planFor(...related());

      expect(content).not.toContain('Contributing Projects');
    });

    it('puts the plan first and labels the build order as supporting information', async () => {
      const content = await planFor(...related());

      expect(content.indexOf('```text')).toBeLessThan(content.indexOf(BUILD_ORDER_HEADING));
      expect(content).toContain(`Worked out by ${BRAND_NAME} from the package dependencies between repos. It is not the delivery plan`);
      expect(content.trimEnd().endsWith('**Unlink and reinstall the published version before committing.**')).toBe(true);
    });

    it('keeps the build order when the plan changes between refreshes', async () => {
      await planFor(...related());
      await changePlan(dir, { type: 'add', kind: 'milestone', title: 'Add the discount field' }, { actor: { by: 'user' } });

      const content = await fs.readFile(path.join(dir, PRIMARY_PLAN_FILE), 'utf-8');
      expect(content).toContain('M1 Add the discount field');
      expect(content).toContain('```mermaid');
      expect(content.split(BUILD_ORDER_HEADING).length - 1).toBe(1);
    });
  });

  describe('a published package nobody in the workspace consumes', () => {
    it('is not reported as a cross-repo contract', async () => {
      // This is the single-repo case that produced a three-row table of
      // packages with "_None_" consumers and a dev loop that could not apply.
      const repo = path.join(dir, 'lib');
      const content = await planFor(
        [{ name: 'lib', path: repo, defaultBranch: 'main' }],
        new Map([[
          repo,
          analysisFor('lib', repo, {
            produces: [
              { name: '@acme/lib', type: 'npm' },
              { name: '@acme/lib-cli', type: 'npm' },
            ],
          }),
        ]]),
      );

      expect(content).not.toContain('@acme/lib');
      expect(content).not.toContain('Local package development loop');
      expect(content).not.toContain(BUILD_ORDER_HEADING);
    });
  });

  describe('a dependency cycle', () => {
    /** `a` and `b` each publish a package the other consumes. */
    function cyclic(): [RepoInfo[], Map<string, ProjectAnalysis>] {
      const a = path.join(dir, 'a');
      const b = path.join(dir, 'b');
      return [
        [
          { name: 'a', path: a, defaultBranch: 'main' },
          { name: 'b', path: b, defaultBranch: 'main' },
        ],
        new Map([
          [a, analysisFor('a', a, {
            produces: [{ name: '@acme/a', type: 'npm' }],
            dependencies: [{ name: '@acme/b', type: 'npm', version: '^1.0.0' }],
          })],
          [b, analysisFor('b', b, {
            produces: [{ name: '@acme/b', type: 'npm' }],
            dependencies: [{ name: '@acme/a', type: 'npm', version: '^1.0.0' }],
          })],
        ]),
      ];
    }

    it('never claims a cycle member has no dependencies', async () => {
      // topologicalSort falls back to emitting every unresolved repo as one
      // phase, which the phase-1 wording then described as dependency-free.
      const content = await planFor(...cyclic());

      expect(content).not.toContain('No dependencies on other workspace repos');
    });

    it('keeps circular package topology separate from the release order, which goes in the plan', async () => {
      const content = await planFor(...cyclic());

      expect(content).toContain('circular package dependencies');
      expect(content).toContain('publish its new package, then bump and verify consumers');
      expect(content).toContain(`${CLI_NAME} plan add milestone`);
      expect(content).not.toContain('contextspace-milestones.md');
      expect(content).not.toContain('break the cycle');
      expect(content).not.toContain('```mermaid');
      expect(content).not.toContain('Suggested order');
    });
  });

  describe('robustness', () => {
    it('lists the repos in alphabetical order when there is no analysis', async () => {
      const [repos] = unrelated();
      const content = await planFor(repos, new Map());

      expect(content).toContain('No project analysis was available, so no order is known. Repos: tool, web.');
    });

    it('still writes the plan for one repo when analysis is unavailable', async () => {
      const repo = path.join(dir, 'solo');
      const content = await planFor([{ name: 'solo', path: repo, defaultBranch: 'main' }], new Map());
      expect(content).toContain('```text');
      expect(content).not.toContain(BUILD_ORDER_HEADING);
    });

    it('survives an analysis carrying no dependency array', async () => {
      const repo = path.join(dir, 'solo');
      const analysis = analysisFor('solo', repo);
      delete (analysis as { dependencies?: unknown }).dependencies;

      const content = await planFor(
        [{ name: 'solo', path: repo, defaultBranch: 'main' }],
        new Map([[repo, analysis]]),
      );

      expect(content).toContain('# Plan — feat');
    });
  });
});
