import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';

import { checkMerged, listBranchPullRequestsState, resetMergeDetectionCache } from './merge-detection.js';
import { recentCommits } from './whats-new.js';

const git = async (cwd: string, args: string[], env?: Record<string, string>) =>
  (await execa('git', args, { cwd, env: { ...process.env, ...env } })).stdout.trim();

describe('CL1 fix round 3: backend PR evidence (real git, fake gh)', { timeout: 60_000 }, () => {
  const originalPath = process.env.PATH ?? '';
  let root: string;
  let ws: string;
  let repo: string;
  let bin: string;

  const commitEnv = (hoursAgo: number, author = 'Alex') => {
    const iso = new Date(Date.now() - hoursAgo * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return {
      GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@example.com`, GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: `${author.toLowerCase()}@example.com`, GIT_COMMITTER_DATE: iso,
    };
  };
  const writeGh = async (script: string) => {
    resetMergeDetectionCache();
    await fs.writeFile(path.join(bin, 'gh'), script, { mode: 0o755 });
    process.env.PATH = `${bin}:${originalPath}`;
  };
  /** A fake `gh` whose `pr list` is the shell snippet `body`; `$ARGS` holds all its arguments. */
  const bashGh = (body: string) => `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "gh version 2.40.0"; exit 0; fi
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
ARGS="$*"
${body}
fi
exit 1
`;

  beforeEach(async () => {
    resetMergeDetectionCache();
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-fix3-')));
    ws = path.join(root, 'ws');
    bin = path.join(root, 'bin');
    repo = path.join(ws, 'app');
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.name', 'Alex']);
    await git(repo, ['config', 'user.email', 'alex@example.com']);
    await git(repo, ['remote', 'add', 'origin', 'git@github.com:me/app.git']);
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'Base'], commitEnv(10));
    // The remote's base ref, as a fetched checkout has it (the PR range is computed against the PR's own remote).
    await git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await git(repo, ['checkout', '-b', 'feat/x']);
    await fs.writeFile(path.join(repo, 'b.txt'), 'b\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'Branch work'], commitEnv(5));
    await fs.writeFile(
      path.join(ws, 'contextspace.json'),
      JSON.stringify({ id: 'ws-f3', name: 'WS', branchName: 'feat/x', repos: [repo], assistants: [], workspacePath: ws }),
    );
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    resetMergeDetectionCache();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('asks gh for the remote repository and never reuses a PR cache entry across remotes (a fork and its upstream share branch and SHAs)', async () => {
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const pr = (number: number, title: string, slug: string) =>
      `echo '[{"number":${number},"title":"${title}","state":"OPEN","url":"https://github.com/${slug}/pull/${number}","baseRefName":"main","headRefOid":"${head}","mergeCommit":null}]'`;
    // Without --repo gh would use its own default repository, here a wrong one (#999).
    await writeGh(bashGh(`
case "$ARGS" in
  *"--repo me/app"*) ${pr(1, 'Fork PR', 'me/app')}; exit 0;;
  *"--repo org/app"*) ${pr(2, 'Upstream PR', 'org/app')}; exit 0;;
  *) ${pr(999, 'Default repo PR', 'someone/else')}; exit 0;;
esac`));

    const fork = await recentCommits(ws);
    expect(fork.commits[0]?.remoteRepo).toBe('me/app');
    expect(fork.commits[0]?.pullRequests?.map((p) => p.number)).toEqual([1]);
    expect(fork.commits[0]?.commits.find((c) => c.subject === 'Branch work')?.prNumber).toBe(1);

    // Same checkout, same branch, same SHAs: only the remote changes. No refresh, no reset.
    await git(repo, ['remote', 'set-url', 'origin', 'git@github.com:org/app.git']);
    const upstream = await recentCommits(ws);
    expect(upstream.commits[0]?.remoteRepo).toBe('org/app');
    expect(upstream.commits[0]?.pullRequests?.map((p) => p.number)).toEqual([2]);
  });

  it('ties an incoming commit in an open PR range to that PR once it is fetched', async () => {
    const bare = path.join(root, 'remote.git');
    await git(root, ['init', '--bare', '-b', 'main', bare]);
    await git(repo, ['config', `url.${bare}.insteadOf`, 'git@github.com:me/app.git']);
    await git(repo, ['push', 'origin', 'main', 'feat/x']);
    await git(repo, ['branch', '--set-upstream-to=origin/feat/x']);

    const mate = path.join(root, 'mate');
    await git(root, ['clone', '-b', 'feat/x', bare, mate]);
    await git(mate, ['config', 'user.name', 'Sam']);
    await git(mate, ['config', 'user.email', 'sam@example.com']);
    await fs.writeFile(path.join(mate, 'c.txt'), 'c\n');
    await git(mate, ['add', '.']);
    await git(mate, ['commit', '-m', 'Colleague push 1'], commitEnv(3, 'Sam'));
    await fs.writeFile(path.join(mate, 'd.txt'), 'd\n');
    await git(mate, ['add', '.']);
    await git(mate, ['commit', '-m', 'Colleague push 2'], commitEnv(2, 'Sam'));
    const mateHead = await git(mate, ['rev-parse', 'HEAD']);
    const mateFirst = await git(mate, ['rev-parse', 'HEAD~1']);
    await git(mate, ['push', 'origin', 'feat/x']);
    await git(repo, ['fetch', 'origin']);

    await writeGh(bashGh(`echo '[{"number":7,"title":"Shared PR","state":"OPEN","url":"https://github.com/me/app/pull/7","baseRefName":"main","headRefOid":"${mateHead}","mergeCommit":null}]'; exit 0`));
    const recent = await recentCommits(ws);
    const incoming = recent.commits[0]?.incomingPrs;
    expect(incoming).toEqual({ [mateHead]: 7, [mateFirst]: 7 });
    // Nothing the local branch already has is reported as incoming.
    expect(Object.keys(incoming ?? {})).not.toContain(await git(repo, ['rev-parse', 'HEAD']));
  });

  it('keeps the last good PRs, marked stale, when a later gh pr list fails', async () => {
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const flag = path.join(root, 'fail');
    await writeGh(bashGh(`
if [ -f ${JSON.stringify(flag)} ]; then exit 4; fi
echo '[{"number":3,"title":"Known PR","state":"OPEN","url":"https://github.com/me/app/pull/3","baseRefName":"main","headRefOid":"${head}","mergeCommit":null}]'; exit 0`));

    const good = await recentCommits(ws);
    expect(good.commits[0]?.pullRequests?.map((p) => p.number)).toEqual([3]);
    expect(good.commits[0]?.prsStale).toBeUndefined();

    await fs.writeFile(flag, '1');
    const failed = await recentCommits(ws, { refresh: true });
    expect(failed.commits[0]?.pullRequests?.map((p) => p.number)).toEqual([3]);
    expect(failed.commits[0]?.commits.find((c) => c.subject === 'Branch work')?.prNumber).toBe(3);
    expect(failed.commits[0]?.prsStale).toBe(true);

    await fs.rm(flag);
    const recovered = await recentCommits(ws, { refresh: true });
    expect(recovered.commits[0]?.pullRequests?.map((p) => p.number)).toEqual([3]);
    expect(recovered.commits[0]?.prsStale).toBeUndefined();
  });

  it('runs at most 2 background gh pr list processes at once across repositories', async () => {
    const log = path.join(root, 'gh-log');
    await writeGh(`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh version 2.40.0'); process.exit(0); }
if (args[0] === 'auth') process.exit(0);
if (args[0] === 'pr') {
  fs.appendFileSync(${JSON.stringify(log)}, 'start\\n');
  setTimeout(() => { fs.appendFileSync(${JSON.stringify(log)}, 'end\\n'); console.log('[]'); process.exit(0); }, 300);
} else process.exit(1);
`);
    const dirs: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const dir = path.join(root, `repo-${i}`);
      await fs.mkdir(dir);
      dirs.push(dir);
    }
    const results = await Promise.all(
      dirs.map((dir, i) => listBranchPullRequestsState(dir, 'feat/x', `git@github.com:me/app${i}.git`)),
    );
    expect(results.every((r) => !r.pending)).toBe(true);
    let running = 0;
    let peak = 0;
    let starts = 0;
    for (const line of (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean)) {
      if (line === 'start') { running += 1; starts += 1; peak = Math.max(peak, running); } else running -= 1;
    }
    expect(starts).toBe(5);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('keeps the last good PRs, marked stale, when the gh auth probe fails during a refresh (round 4)', async () => {
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const flag = path.join(root, 'auth-fails');
    await writeGh(`#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "gh version 2.40.0"; exit 0; fi
if [ "$1" = "auth" ]; then [ -f ${JSON.stringify(flag)} ] && exit 1; exit 0; fi
if [ "$1" = "pr" ]; then
echo '[{"number":3,"title":"Known PR","state":"OPEN","url":"https://github.com/me/app/pull/3","baseRefName":"main","headRefOid":"${head}","mergeCommit":null}]'; exit 0
fi
exit 1
`);
    const good = await recentCommits(ws);
    expect(good.commits[0]?.pullRequests?.map((p) => p.number)).toEqual([3]);

    await fs.writeFile(flag, '1');
    const failed = await recentCommits(ws, { refresh: true });
    expect(failed.commits[0]?.pullRequests?.map((p) => p.number)).toEqual([3]);
    expect(failed.commits[0]?.commits.find((c) => c.subject === 'Branch work')?.prNumber).toBe(3);
    expect(failed.commits[0]?.prsStale).toBe(true);
    // A plain read soon after keeps them too, still marked stale.
    const again = await recentCommits(ws);
    expect(again.commits[0]?.pullRequests?.map((p) => p.number)).toEqual([3]);
    expect(again.commits[0]?.prsStale).toBe(true);
  });

  it('takes the PR range base from the same remote as the PR lookup, and assigns nothing when that remote has no base ref (round 4)', async () => {
    // Fork base work exists on the fork's main; origin/main is older. The checkout tracks fork/feat/x.
    await git(repo, ['checkout', 'main']);
    const baseSha = await git(repo, ['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(repo, 'forkbase.txt'), 'x\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'Fork base work'], commitEnv(8));
    const forkBaseSha = await git(repo, ['rev-parse', 'HEAD']);
    await git(repo, ['checkout', '-B', 'feat/x']);
    await fs.writeFile(path.join(repo, 'w2.txt'), 'y\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'Branch work 2'], commitEnv(4));
    const head = await git(repo, ['rev-parse', 'HEAD']);
    await git(repo, ['remote', 'add', 'fork', 'git@github.com:fork/app.git']);
    await git(repo, ['config', 'branch.feat/x.remote', 'fork']);
    await git(repo, ['update-ref', 'refs/remotes/fork/feat/x', head]);
    await git(repo, ['update-ref', 'refs/remotes/origin/main', baseSha]);
    await writeGh(bashGh(`echo '[{"number":9,"title":"Fork PR","state":"OPEN","url":"https://github.com/fork/app/pull/9","baseRefName":"main","headRefOid":"${head}","mergeCommit":null}]'; exit 0`));

    // fork/main is missing: never fall back to origin/main's (older) base. Nothing is claimed by the PR.
    const missing = await recentCommits(ws);
    const bySubject = (r: Awaited<ReturnType<typeof recentCommits>>) => new Map(r.commits[0]!.commits.map((c) => [c.subject, c]));
    expect(missing.commits[0]?.pullRequests?.map((p) => p.number)).toEqual([9]);
    expect(bySubject(missing).get('Fork base work')?.prNumber).toBeUndefined();
    expect(bySubject(missing).get('Branch work 2')?.prNumber).toBeUndefined();

    // With fork/main present the range is fork/main..head: only the branch's own work.
    await git(repo, ['update-ref', 'refs/remotes/fork/main', forkBaseSha]);
    resetMergeDetectionCache();
    const present = await recentCommits(ws);
    expect(bySubject(present).get('Branch work 2')?.prNumber).toBe(9);
    expect(bySubject(present).get('Fork base work')?.prNumber).toBeUndefined();
  });

  it('asks gh for the remote repository when Archive checks a merged PR (round 4)', async () => {
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const calls = path.join(root, 'calls');
    await writeGh(bashGh(`echo "$ARGS" >> ${JSON.stringify(calls)}; echo '[{"url":"https://github.com/me/app/pull/4","headRefOid":"${head}","baseRefName":"main"}]'; exit 0`));
    const result = await checkMerged({ repoPath: repo, sha: head, branch: 'feat/x', defaultBranch: 'main', remoteUrl: 'git@github.com:me/app.git' });
    expect(result.evidence).toBe('pull-request');
    expect(await fs.readFile(calls, 'utf8')).toContain('--repo me/app');
  });
});
