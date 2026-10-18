import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { buildDependencyGraph } from './plan-generator.js';
import type { ProjectAnalysis, RepoInfo } from '../types.js';

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

describe('buildDependencyGraph', () => {
  const dir = '/ws';
  const core = path.join(dir, 'core');
  const web = path.join(dir, 'web');
  const repos: RepoInfo[] = [
    { name: 'core', path: core, defaultBranch: 'main' },
    { name: 'web', path: web, defaultBranch: 'main' },
  ];

  it('says which repo depends on which, from the packages one publishes and another uses', () => {
    const graph = buildDependencyGraph(new Map([
      [core, analysisFor('core', core, { produces: [{ name: '@acme/core', type: 'npm' }] })],
      [web, analysisFor('web', web, { dependencies: [{ name: '@acme/core', type: 'npm', version: '^1.0.0' }] })],
    ]), repos);
    expect(graph.get('web')!.dependsOn).toEqual(['core']);
    expect(graph.get('core')!.dependsOn).toEqual([]);
  });

  it('finds no dependency between repos that share no package', () => {
    const graph = buildDependencyGraph(new Map([[core, analysisFor('core', core)], [web, analysisFor('web', web)]]), repos);
    expect([...graph.values()].every((node) => node.dependsOn.length === 0)).toBe(true);
  });
});
