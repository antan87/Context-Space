import { describe, it, expect } from 'vitest';
import { parseRemoteUrl, buildCompareUrl, buildCommitUrl } from './pr.js';

describe('parseRemoteUrl', () => {
  const cases: Array<[string, { host: string; owner: string; repo: string; kind: string; project?: string }]> = [
    ['https://github.com/owner/repo.git', { host: 'github.com', owner: 'owner', repo: 'repo', kind: 'github' }],
    ['https://github.com/owner/repo', { host: 'github.com', owner: 'owner', repo: 'repo', kind: 'github' }],
    ['git@github.com:owner/repo.git', { host: 'github.com', owner: 'owner', repo: 'repo', kind: 'github' }],
    ['ssh://git@github.com/owner/repo.git', { host: 'github.com', owner: 'owner', repo: 'repo', kind: 'github' }],
    ['https://gitlab.com/group/subgroup/repo.git', { host: 'gitlab.com', owner: 'group/subgroup', repo: 'repo', kind: 'gitlab' }],
    ['git@bitbucket.org:team/repo.git', { host: 'bitbucket.org', owner: 'team', repo: 'repo', kind: 'bitbucket' }],
    ['https://dev.azure.com/myorg/myproject/_git/myrepo', { host: 'dev.azure.com', owner: 'myorg', project: 'myproject', repo: 'myrepo', kind: 'azure' }],
    ['git@ssh.dev.azure.com:v3/myorg/myproject/myrepo', { host: 'dev.azure.com', owner: 'myorg', project: 'myproject', repo: 'myrepo', kind: 'azure' }],
  ];

  it.each(cases)('parses %s', (url, expected) => {
    expect(parseRemoteUrl(url)).toMatchObject(expected);
  });

  it('returns null for junk', () => {
    expect(parseRemoteUrl('not a url')).toBeNull();
    expect(parseRemoteUrl('')).toBeNull();
  });

  it('classifies an unknown self-hosted host', () => {
    const r = parseRemoteUrl('https://git.internal.corp/team/repo.git');
    expect(r).toMatchObject({ host: 'git.internal.corp', owner: 'team', repo: 'repo', kind: 'unknown' });
  });
});

describe('buildCompareUrl', () => {
  it('builds a GitHub compare URL preserving slashes in branch names', () => {
    const r = parseRemoteUrl('https://github.com/owner/repo.git')!;
    expect(buildCompareUrl(r, 'main', 'feature/x')).toBe(
      'https://github.com/owner/repo/compare/main...feature/x?expand=1',
    );
  });

  it('builds a GitLab MR URL with encoded branch params', () => {
    const r = parseRemoteUrl('https://gitlab.com/group/sub/repo.git')!;
    const url = buildCompareUrl(r, 'main', 'feature/x')!;
    expect(url).toContain('/group/sub/repo/-/merge_requests/new');
    expect(url).toContain('source_branch%5D=feature%2Fx');
    expect(url).toContain('target_branch%5D=main');
  });

  it('builds an Azure DevOps PR-create URL', () => {
    const r = parseRemoteUrl('https://dev.azure.com/myorg/myproject/_git/myrepo')!;
    expect(buildCompareUrl(r, 'main', 'feature/x')).toBe(
      'https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequestcreate?sourceRef=feature%2Fx&targetRef=main',
    );
  });

  it('returns null for an unknown forge', () => {
    const r = parseRemoteUrl('https://git.internal.corp/team/repo.git')!;
    expect(buildCompareUrl(r, 'main', 'feature/x')).toBeNull();
  });
});

describe('buildCommitUrl', () => {
  it('builds a GitHub commit URL', () => {
    const r = parseRemoteUrl('https://github.com/owner/repo.git')!;
    expect(buildCommitUrl(r, 'a1b2c3d4e5f6')).toBe(
      'https://github.com/owner/repo/commit/a1b2c3d4e5f6',
    );
  });

  it('builds a GitLab commit URL', () => {
    const r = parseRemoteUrl('https://gitlab.com/group/subgroup/repo.git')!;
    expect(buildCommitUrl(r, 'a1b2c3d4e5f6')).toBe(
      'https://gitlab.com/group/subgroup/repo/-/commit/a1b2c3d4e5f6',
    );
  });

  it('builds an Azure DevOps commit URL', () => {
    const r = parseRemoteUrl('https://dev.azure.com/myorg/myproject/_git/myrepo')!;
    expect(buildCommitUrl(r, 'a1b2c3d4e5f6')).toBe(
      'https://dev.azure.com/myorg/myproject/_git/myrepo/commit/a1b2c3d4e5f6',
    );
  });

  it('builds a Bitbucket commit URL', () => {
    const r = parseRemoteUrl('git@bitbucket.org:team/repo.git')!;
    expect(buildCommitUrl(r, 'a1b2c3d4e5f6')).toBe(
      'https://bitbucket.org/team/repo/commits/a1b2c3d4e5f6',
    );
  });

  it('returns null for an unknown forge', () => {
    const r = parseRemoteUrl('https://git.internal.corp/team/repo.git')!;
    expect(buildCommitUrl(r, 'a1b2c3d4e5f6')).toBeNull();
  });

  it('encodes special characters in path segments safely', () => {
    const r = parseRemoteUrl('https://github.com/my%20org/my%20repo.git')!;
    expect(buildCommitUrl(r, 'sha#123')).toBe(
      'https://github.com/my%20org/my%20repo/commit/sha%23123',
    );
  });
});
