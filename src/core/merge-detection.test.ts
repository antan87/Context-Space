import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { pathWith, writeGhNode } from '../test-support/fake-gh.js';

import {
  checkMerged,
  clearBranchPullRequestCache,
  fetchDefaultBranch,
  findMergedPullRequest,
  listBranchPullRequests,
  listBranchPullRequestsState,
  parseBranchPullRequests,
  resetMergeDetectionCache,
  subscribePullRequestsSettled,
} from './merge-detection.js';

const git = async (cwd: string, ...args: string[]) => (await execa('git', args, { cwd })).stdout.trim();

describe('findMergedPullRequest', () => {
  const prs = [
    { url: 'https://github.com/o/r/pull/1', headRefOid: 'old', baseRefName: 'main' },
    { url: 'https://github.com/o/r/pull/2', headRefOid: 'tip', baseRefName: 'release' },
    { url: 'https://github.com/o/r/pull/3', headRefOid: 'tip', baseRefName: 'main' },
  ];

  it('accepts only a PR into the default branch whose head is exactly the tip', () => {
    expect(findMergedPullRequest(prs, 'tip', 'main')?.url).toBe('https://github.com/o/r/pull/3');
  });

  it('a PR merged from an earlier tip proves nothing about later commits', () => {
    expect(findMergedPullRequest(prs.slice(0, 2), 'tip', 'main')).toBeNull();
  });
});

describe('checkMerged (real git)', { timeout: 60_000 }, () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-merge-')));
    const remote = path.join(root, 'r.git');
    await git(root, 'init', '--bare', '-b', 'main', remote);
    repo = path.join(root, 'r');
    await git(root, 'clone', remote, repo);
    await git(repo, 'config', 'user.name', 'Test');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'a');
    await git(repo, 'push', '-u', 'origin', 'main');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('proves fast-forward and merge-commit merges by ancestry, and nothing else', async () => {
    await git(repo, 'checkout', '-b', 'feat');
    await fs.writeFile(path.join(repo, 'b.txt'), 'b\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'b');
    const tip = await git(repo, 'rev-parse', 'HEAD');

    expect(await checkMerged({ repoPath: repo, sha: tip, branch: 'feat', defaultBranch: 'main', usePullRequests: false }))
      .toMatchObject({ merged: false, evidence: 'none' });

    // Merge on the remote from another clone, then fetch only the default branch.
    const other = path.join(root, 'other');
    await git(root, 'clone', path.join(root, 'r.git'), other);
    await git(repo, 'push', 'origin', 'feat');
    await git(other, 'config', 'user.name', 'Test');
    await git(other, 'config', 'user.email', 'test@example.com');
    await git(other, 'fetch', 'origin');
    await git(other, 'merge', '--no-ff', '-m', 'merge', 'origin/feat');
    await git(other, 'push', 'origin', 'main');
    expect(await fetchDefaultBranch(repo, 'main')).toBeNull();

    expect(await checkMerged({ repoPath: repo, sha: tip, branch: 'feat', defaultBranch: 'main', usePullRequests: false }))
      .toMatchObject({ merged: true, evidence: 'ancestor' });
  });

  it('a squash merge is not proven without pull-request evidence', async () => {
    await git(repo, 'checkout', '-b', 'feat');
    await fs.writeFile(path.join(repo, 'b.txt'), 'b\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'b');
    const tip = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'checkout', 'main');
    await git(repo, 'merge', '--squash', 'feat');
    await git(repo, 'commit', '-m', 'squashed');
    await git(repo, 'push', 'origin', 'main');

    // No GitHub remote, so no PR lookup: the branch must be kept.
    expect(await checkMerged({ repoPath: repo, sha: tip, branch: 'feat', defaultBranch: 'main', remoteUrl: path.join(root, 'r.git') }))
      .toMatchObject({ merged: false, evidence: 'none' });
  });

  it('reports a missing default branch instead of throwing, and a failed fetch as an error', async () => {
    const tip = await git(repo, 'rev-parse', 'HEAD');
    expect(await checkMerged({ repoPath: repo, sha: tip, defaultBranch: 'trunk', usePullRequests: false }))
      .toMatchObject({ merged: false, detail: 'default branch "trunk" not found' });
    expect(await fetchDefaultBranch(repo, 'trunk')).toMatch(/.+/);
  });
});

describe('parseBranchPullRequests & listBranchPullRequests', () => {
  const originalPath = process.env.PATH ?? '';
  let tmpBin: string;

  beforeEach(async () => {
    resetMergeDetectionCache();
    tmpBin = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-gh-stub-')));
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    resetMergeDetectionCache();
    await fs.rm(tmpBin, { recursive: true, force: true, maxRetries: 5 });
  });

  /** A fake `gh` written as a Node script, so it runs on Windows too (see test-support/fake-gh.ts). */
  async function installFakeGh(source: string) {
    await writeGhNode(tmpBin, source);
    process.env.PATH = pathWith(tmpBin, originalPath);
  }

  it('parses gh pr list JSON and rejects malformed or unsafe URLs', () => {
    const parsed = parseBranchPullRequests(JSON.stringify([
      {
        number: 482,
        title: 'Board commit notes',
        state: 'MERGED',
        url: 'https://github.com/antan87/Context-Space/pull/482',
        baseRefName: 'main',
        headRefOid: 'd630e498631a27aba978b5b968b01f2c9db15878',
        mergeCommit: { oid: 'fbcf23270e160676394c5176c4f81166679d553e' },
      },
      {
        number: 485,
        title: 'Follow-up UI',
        state: 'open',
        url: 'https://github.com/antan87/Context-Space/pull/485',
        baseRefName: 'main',
        headRefOid: 'abc1234',
        mergeCommit: null,
      },
      {
        number: 999,
        title: 'Unsafe link',
        state: 'OPEN',
        url: 'javascript:alert(1)',
      },
      {
        number: 0,
        title: 'Invalid number',
        state: 'CLOSED',
        url: 'https://github.com/antan87/Context-Space/pull/0',
      },
    ]));
    expect(parsed).toEqual([
      {
        number: 482,
        title: 'Board commit notes',
        state: 'MERGED',
        url: 'https://github.com/antan87/Context-Space/pull/482',
        baseRefName: 'main',
        headRefOid: 'd630e498631a27aba978b5b968b01f2c9db15878',
        mergeCommitOid: 'fbcf23270e160676394c5176c4f81166679d553e',
      },
      {
        number: 485,
        title: 'Follow-up UI',
        state: 'OPEN',
        url: 'https://github.com/antan87/Context-Space/pull/485',
        baseRefName: 'main',
        headRefOid: 'abc1234',
      },
    ]);
    expect(parseBranchPullRequests('{broken')).toEqual([]);
  });

  it('returns [] silently for non-GitHub remotes, detached branch, or unauthenticated gh', async () => {
    const callsFile = path.join(tmpBin, 'calls.log');
    await installFakeGh(`
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, args.join(' ') + '\\n');
if (args[0] === '--version') { console.log('gh version 2.0.0'); process.exit(0); }
process.exit(1);
`);

    expect(await listBranchPullRequests(tmpBin, 'feat/x', 'git@gitlab.com:acme/app.git')).toEqual([]);
    expect(await listBranchPullRequests(tmpBin, null, 'git@github.com:acme/app.git')).toEqual([]);
    // Non-GitHub / detached must not even invoke gh
    await expect(fs.access(callsFile)).rejects.toThrow();

    // Unauthenticated gh -> returns [], never throws
    expect(await listBranchPullRequests(tmpBin, 'feat/x', 'git@github.com:acme/app.git')).toEqual([]);
    const log = await fs.readFile(callsFile, 'utf8');
    expect(log).not.toContain('pr list');
  });

  it('calls gh non-interactively, caches for TTL, and refreshes on refresh=true or cache clear', async () => {
    const callsFile = path.join(tmpBin, 'calls.log');
    const countFile = path.join(tmpBin, 'count.txt');
    await fs.writeFile(countFile, '0');
    await installFakeGh(`
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, 'PROMPT=' + process.env.GH_PROMPT_DISABLED + ':' + process.env.GIT_TERMINAL_PROMPT + ' ARGS=' + args.join(' ') + '\\n');
if (args[0] === '--version') { console.log('gh version 2.0.0'); process.exit(0); }
if (args[0] === 'auth') process.exit(0);
if (args[0] === 'pr' && args[1] === 'list') {
  const n = Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')) + 1;
  fs.writeFileSync(${JSON.stringify(countFile)}, n + '\\n');
  if (n === 1) console.log('[{"number":10,"title":"First PR","state":"OPEN","url":"https://github.com/acme/app/pull/10","baseRefName":"main","headRefOid":"aaaa111","mergeCommit":null}]');
  else console.log('[{"number":10,"title":"First PR","state":"MERGED","url":"https://github.com/acme/app/pull/10","baseRefName":"main","headRefOid":"aaaa111","mergeCommit":{"oid":"bbbb222"}}]');
  process.exit(0);
}
process.exit(1);
`);

    const first = await listBranchPullRequests(tmpBin, 'feat/demo', 'https://github.com/acme/app.git');
    expect(first).toHaveLength(1);
    expect(first[0]?.state).toBe('OPEN');

    // Cached hit: gh pr list should not run a second time
    const cached = await listBranchPullRequests(tmpBin, 'feat/demo', 'https://github.com/acme/app.git');
    expect(cached[0]?.state).toBe('OPEN');
    expect(await fs.readFile(countFile, 'utf8')).toBe('1\n');

    // Explicit refresh busts cache
    const refreshed = await listBranchPullRequests(tmpBin, 'feat/demo', 'https://github.com/acme/app.git', { refresh: true });
    expect(refreshed[0]?.state).toBe('MERGED');
    expect(await fs.readFile(countFile, 'utf8')).toBe('2\n');

    clearBranchPullRequestCache([tmpBin]);
    await listBranchPullRequests(tmpBin, 'feat/demo', 'https://github.com/acme/app.git');
    expect(await fs.readFile(countFile, 'utf8')).toBe('3\n');

    const log = await fs.readFile(callsFile, 'utf8');
    expect(log).toContain('PROMPT=1:0 ARGS=pr list --repo acme/app --head feat/demo --state all --json number,title,state,url,baseRefName,headRefOid,mergeCommit --limit 50');
  });

  it('returns [] silently without throwing when gh is missing (ENOENT)', async () => {
    const emptyBin = path.join(tmpBin, 'empty');
    await fs.mkdir(emptyBin, { recursive: true });
    process.env.PATH = emptyBin;
    resetMergeDetectionCache();

    await expect(
      listBranchPullRequests(tmpBin, 'feat/x', 'git@github.com:acme/app.git', { refresh: true }),
    ).resolves.toEqual([]);
  });

  it('coalesces concurrent ghAvailable(true) probes into a single detectGh invocation', async () => {
    const probeLog = path.join(tmpBin, 'probes.log');
    await installFakeGh(`
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh version 2.40.0'); process.exit(0); }
if (args[0] === 'auth') {
  setTimeout(() => { fs.appendFileSync(${JSON.stringify(probeLog)}, 'auth\\n'); process.exit(0); }, 100);
} else if (args[0] === 'pr' && args[1] === 'list') {
  console.log('[]');
  process.exit(0);
} else {
  process.exit(1);
}
`);

    const [a, b] = await Promise.all([
      listBranchPullRequests(path.join(tmpBin, 'repo-a'), 'feat/a', 'https://github.com/acme/a.git', { refresh: true }),
      listBranchPullRequests(path.join(tmpBin, 'repo-b'), 'feat/b', 'https://github.com/acme/b.git', { refresh: true }),
    ]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    const authCalls = (await fs.readFile(probeLog, 'utf8')).trim().split('\n').filter(Boolean);
    expect(authCalls).toHaveLength(1);
  });

  it('keeps cached PRs for stale-while-revalidate on clearBranchPullRequestCache and avoids duplicate in-flight gh calls', async () => {
    const prCallsLog = path.join(tmpBin, 'pr-calls.log');
    const stateFile = path.join(tmpBin, 'pr-state.txt');
    const delayFile = path.join(tmpBin, 'pr-delay.txt');
    await fs.writeFile(stateFile, 'OPEN');
    await fs.writeFile(delayFile, '350');

    await writeGhNode(tmpBin, `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh version 2.40.0'); process.exit(0); }
if (args[0] === 'auth') { process.exit(0); }
if (args[0] === 'pr' && args[1] === 'list') {
  fs.appendFileSync(${JSON.stringify(prCallsLog)}, args.join(' ') + '\\n');
  const delay = Number(fs.readFileSync(${JSON.stringify(delayFile)}, 'utf8').trim()) || 0;
  const state = fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8').trim();
  setTimeout(() => {
    console.log(JSON.stringify([{
      number: 10,
      title: 'Stale-while-revalidate PR',
      state,
      url: 'https://github.com/acme/app/pull/10',
      baseRefName: 'main',
      headRefOid: 'aaaa111',
      mergeCommit: state === 'MERGED' ? { oid: 'bbbb222' } : null,
    }]));
    process.exit(0);
  }, delay);
} else {
  process.exit(1);
}
`);
    process.env.PATH = pathWith(tmpBin, originalPath);
    resetMergeDetectionCache();

    const settledRepos: string[] = [];
    const unsubscribe = subscribePullRequestsSettled((repoPath) => {
      settledRepos.push(repoPath);
    });
    try {
      // Cold load while gh is slow -> pending: true, hasCached: false, prs: []
      const cold = await listBranchPullRequestsState(tmpBin, 'feat/demo', 'https://github.com/acme/app.git', { waitMs: 50 });
      expect(cold).toMatchObject({ prs: [], pending: true, hasCached: false });

      await expect.poll(() => settledRepos.length, { timeout: 2_000 }).toBe(1);
      const warm = await listBranchPullRequestsState(tmpBin, 'feat/demo', 'https://github.com/acme/app.git', { waitMs: 50 });
      expect(warm).toMatchObject({
        pending: false,
        hasCached: true,
        prs: [expect.objectContaining({ number: 10, state: 'OPEN' })],
      });

      // Clear cache for this repo while next gh response is slow and returns MERGED:
      // must keep OPEN PR for stale-while-revalidate and NOT spawn duplicate gh pr list calls
      await fs.writeFile(stateFile, 'MERGED');
      clearBranchPullRequestCache([tmpBin]);
      const stale = await listBranchPullRequestsState(tmpBin, 'feat/demo', 'https://github.com/acme/app.git', { waitMs: 50 });
      expect(stale).toMatchObject({
        pending: true,
        hasCached: true,
        prs: [expect.objectContaining({ number: 10, state: 'OPEN' })],
      });

      // Calling clearBranchPullRequestCache() + refresh while still in flight must reuse the in-flight call
      clearBranchPullRequestCache();
      const stillInFlight = await listBranchPullRequestsState(tmpBin, 'feat/demo', 'https://github.com/acme/app.git', { refresh: true, waitMs: 50 });
      expect(stillInFlight).toMatchObject({
        pending: true,
        hasCached: true,
        prs: [expect.objectContaining({ number: 10, state: 'OPEN' })],
      });

      await expect.poll(() => settledRepos.length, { timeout: 2_000 }).toBe(2);
      const settled = await listBranchPullRequestsState(tmpBin, 'feat/demo', 'https://github.com/acme/app.git', { waitMs: 50 });
      expect(settled).toMatchObject({
        pending: false,
        hasCached: true,
        prs: [expect.objectContaining({ number: 10, state: 'MERGED' })],
      });

      const prCalls = (await fs.readFile(prCallsLog, 'utf8')).trim().split('\n').filter(Boolean);
      expect(prCalls).toHaveLength(2);

      // No-arg clearBranchPullRequestCache() also preserves cached value for stale-while-revalidate
      await fs.writeFile(stateFile, 'CLOSED');
      clearBranchPullRequestCache();
      const staleAll = await listBranchPullRequestsState(tmpBin, 'feat/demo', 'https://github.com/acme/app.git', { waitMs: 50 });
      expect(staleAll).toMatchObject({
        pending: true,
        hasCached: true,
        prs: [expect.objectContaining({ number: 10, state: 'MERGED' })],
      });
      await expect.poll(() => settledRepos.length, { timeout: 2_000 }).toBe(3);
      const settledClosed = await listBranchPullRequestsState(tmpBin, 'feat/demo', 'https://github.com/acme/app.git', { waitMs: 50 });
      expect(settledClosed.prs[0]?.state).toBe('CLOSED');
    } finally {
      unsubscribe();
    }
  });
});
