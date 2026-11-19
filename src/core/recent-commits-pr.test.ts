import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';

import { incomingCommits, resetIncomingCommitsState } from './incoming-commits.js';
import { resetMergeDetectionCache, subscribePullRequestsSettled } from './merge-detection.js';
import { recentCommits, whatsNew } from './whats-new.js';

const git = async (cwd: string, args: string[], env?: Record<string, string>) =>
  (await execa('git', args, { cwd, env: { ...process.env, ...env } })).stdout.trim();

describe('recentCommits branch, base, remoteRepo, and PR commit-range matching (real git)', { timeout: 60_000 }, () => {
  const originalPath = process.env.PATH ?? '';
  let root: string;
  let ws: string;
  let repoDir: string;
  let bare: string;
  let tmpBin: string;

  const commitEnv = (hoursAgo: number, author = 'Alex') => {
    const iso = new Date(Date.now() - hoursAgo * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return {
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@example.com`,
      GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: `${author.toLowerCase()}@example.com`,
      GIT_COMMITTER_DATE: iso,
    };
  };

  async function installFakeGh(prsJsonExpr: string) {
    resetMergeDetectionCache();
    const ghPath = path.join(tmpBin, 'gh');
    await fs.writeFile(
      ghPath,
      `#!/usr/bin/env bash
set -e
if [ "$1" = "--version" ]; then echo "gh version 2.40.0"; exit 0; fi
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
${prsJsonExpr}
exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tmpBin}:${originalPath}`;
  }

  beforeEach(async () => {
    resetMergeDetectionCache();
    resetIncomingCommitsState();
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-recent-pr-')));
    ws = path.join(root, 'ws');
    tmpBin = path.join(root, 'bin');
    bare = path.join(root, 'remote.git');
    repoDir = path.join(ws, 'NexusFlow');
    await fs.mkdir(ws, { recursive: true });
    await fs.mkdir(tmpBin, { recursive: true });
    await installFakeGh('echo "[]"');

    await git(root, ['init', '--bare', '-b', 'main', bare]);
    await git(ws, ['clone', bare, 'NexusFlow']);
    await git(repoDir, ['config', 'user.name', 'Alex']);
    await git(repoDir, ['config', 'user.email', 'alex@example.com']);
    await fs.writeFile(path.join(repoDir, 'README.md'), '# NexusFlow\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'Initial main commit'], commitEnv(10));
    await git(repoDir, ['push', '-u', 'origin', 'main']);

    await fs.writeFile(
      path.join(ws, 'contextspace.json'),
      JSON.stringify({
        id: 'ws-pr',
        name: 'WS PR',
        branchName: 'feat/demo',
        mode: 'in-place',
        repos: [repoDir],
        isolatedRepos: {
          NexusFlow: {
            worktreePath: repoDir,
            branchName: 'feat/demo',
            baseBranch: 'main',
          },
        },
        assistants: [],
        workspacePath: ws,
      }),
    );
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    resetMergeDetectionCache();
    resetIncomingCommitsState();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('groups PR commits using mergeCommit^1..headRefOid, leaves later commits ungrouped, and marks main commits onBase', async () => {
    // Switch local origin URL via insteadOf so git fetches locally from bare while remote URL looks like GitHub
    const githubUrl = 'git@github.com:antan87/Context-Space.git';
    await git(repoDir, ['config', `url.${bare}.insteadOf`, githubUrl]);
    await git(repoDir, ['remote', 'set-url', 'origin', githubUrl]);

    await git(repoDir, ['checkout', '-b', 'feat/demo']);
    await fs.writeFile(path.join(repoDir, 'f1.ts'), 'export const a = 1;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'PR commit one'], commitEnv(5));

    await fs.writeFile(path.join(repoDir, 'f2.ts'), 'export const b = 2;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'PR commit two'], commitEnv(4));
    const prHeadSha = await git(repoDir, ['rev-parse', 'HEAD']);
    await git(repoDir, ['push', '-u', 'origin', 'feat/demo']);

    // Simulate another PR (#480) landing on main and PR #482 merging into main from another clone
    const merger = path.join(root, 'merger');
    await git(root, ['clone', bare, merger]);
    await git(merger, ['config', 'user.name', 'Maintainer']);
    await git(merger, ['config', 'user.email', 'm@example.com']);
    await fs.writeFile(path.join(merger, 'other.ts'), 'export const other = true;\n');
    await git(merger, ['add', '.']);
    await git(merger, ['commit', '-m', 'Other PR commit on main'], commitEnv(3.5, 'Maintainer'));
    await git(merger, ['merge', '--no-ff', 'origin/feat/demo', '-m', 'Merge pull request #482 from antan87/feat/demo'], commitEnv(3, 'Maintainer'));
    const mergeCommitSha = await git(merger, ['rev-parse', 'HEAD']);
    await git(merger, ['push', 'origin', 'main']);

    // Pull updated origin/main and merge it into feat/demo, then add two post-PR commits on feat/demo
    await git(repoDir, ['fetch', 'origin', 'main']);
    await git(repoDir, ['merge', '--no-ff', 'origin/main', '-m', 'Sync main into feat/demo'], commitEnv(2.5));

    await fs.writeFile(path.join(repoDir, 'f3.ts'), 'export const c = 3;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'Post-PR work 1'], commitEnv(2));

    await fs.writeFile(path.join(repoDir, 'f4.ts'), 'export const d = 4;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'Post-PR work 2'], commitEnv(1));

    const prsPayload = JSON.stringify([
      {
        number: 482,
        title: 'Commit list grouping',
        state: 'MERGED',
        url: 'https://github.com/antan87/Context-Space/pull/482',
        baseRefName: 'main',
        headRefOid: prHeadSha,
        mergeCommit: { oid: mergeCommitSha },
      },
    ]);
    await installFakeGh(`cat <<'JSON'\n${prsPayload}\nJSON`);

    const recent = await recentCommits(ws);
    expect(recent.commits).toHaveLength(1);
    const repo = recent.commits[0]!;
    expect(repo.repo).toBe('NexusFlow');
    expect(repo.remoteRepo).toBe('antan87/Context-Space');
    expect(repo.branch).toBe('feat/demo');
    expect(repo.base).toBe('main');
    expect(repo.pullRequests).toEqual([
      {
        number: 482,
        title: 'Commit list grouping',
        state: 'MERGED',
        url: 'https://github.com/antan87/Context-Space/pull/482',
      },
    ]);

    const bySubject = new Map(repo.commits.map((c) => [c.subject, c]));
    // Later commits on branch must NOT match #482
    expect(bySubject.get('Post-PR work 2')?.prNumber).toBeUndefined();
    expect(bySubject.get('Post-PR work 2')?.onBase).toBeUndefined();
    expect(bySubject.get('Post-PR work 1')?.prNumber).toBeUndefined();
    expect(bySubject.get('Post-PR work 1')?.onBase).toBeUndefined();

    // Commits inside #482 must match 482 despite origin/main already containing them
    expect(bySubject.get('PR commit two')?.prNumber).toBe(482);
    expect(bySubject.get('PR commit one')?.prNumber).toBe(482);
    expect(bySubject.get('PR commit one')?.onBase).toBeUndefined();

    // Commits brought in from origin/main (other PR + merge commit) are marked onBase, not "Not in a PR yet"
    expect(bySubject.get('Other PR commit on main')?.prNumber).toBeUndefined();
    expect(bySubject.get('Other PR commit on main')?.onBase).toBe(true);
    // GitHub names this merge commit as #482's result (mergeCommitOid), so it belongs to #482 and is not "Already on main"
    expect(bySubject.get('Merge pull request #482 from antan87/feat/demo')?.prNumber).toBe(482);
    expect(bySubject.get('Merge pull request #482 from antan87/feat/demo')?.onBase).toBeUndefined();

    // whatsNew MUST stay completely untouched for existing consumers
    const news = await whatsNew(ws, 'user');
    expect(news.commits[0]).not.toHaveProperty('branch');
    expect(news.commits[0]).not.toHaveProperty('base');
    expect(news.commits[0]).not.toHaveProperty('remoteRepo');
    expect(news.commits[0]).not.toHaveProperty('pullRequests');
    expect(news.commits[0]?.commits[0]).not.toHaveProperty('prNumber');
    expect(news.commits[0]?.commits[0]).not.toHaveProperty('onBase');
  });

  it('handles squash-merged PRs, sorts OPEN -> MERGED -> CLOSED, handles detached HEAD and base===branch, and refreshes via incoming refresh=true', async () => {
    const githubUrl = 'https://github.com/antan87/Context-Space.git';
    await git(repoDir, ['config', `url.${bare}.insteadOf`, githubUrl]);
    await git(repoDir, ['remote', 'set-url', 'origin', githubUrl]);

    // On main itself: base must be null
    const onMain = await recentCommits(ws);
    expect(onMain.commits[0]).toMatchObject({
      repo: 'NexusFlow',
      remoteRepo: 'antan87/Context-Space',
      branch: 'main',
      base: null,
    });

    await git(repoDir, ['checkout', '-b', 'feat/demo']);
    await fs.writeFile(path.join(repoDir, 's1.ts'), 'export const s1 = 1;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'Squash PR commit'], commitEnv(4));
    const squashPrHead = await git(repoDir, ['rev-parse', 'HEAD']);

    // Simulate squash merge onto bare origin/main from another clone
    const squasher = path.join(root, 'squasher');
    await git(root, ['clone', bare, squasher]);
    await git(squasher, ['config', 'user.name', 'Maintainer']);
    await git(squasher, ['config', 'user.email', 'm@example.com']);
    await fs.writeFile(path.join(squasher, 's1.ts'), 'export const s1 = 1;\n');
    await git(squasher, ['add', '.']);
    await git(squasher, ['commit', '-m', 'Squashed #10'], commitEnv(3.5, 'Maintainer'));
    const squashMergeSha = await git(squasher, ['rev-parse', 'HEAD']);
    await git(squasher, ['push', 'origin', 'main']);
    await git(repoDir, ['fetch', 'origin', 'main']);

    // New commit for an OPEN PR #11 on the same branch
    await fs.writeFile(path.join(repoDir, 's2.ts'), 'export const s2 = 2;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'Open PR commit'], commitEnv(2));
    const openPrHead = await git(repoDir, ['rev-parse', 'HEAD']);
    await git(repoDir, ['push', '-u', 'origin', 'feat/demo']);

    const flagFile = path.join(root, 'show-open-pr');
    await installFakeGh(`
if [ -f ${JSON.stringify(flagFile)} ]; then
  echo '[{"number":10,"title":"Merged squash PR","state":"MERGED","url":"https://github.com/antan87/Context-Space/pull/10","baseRefName":"main","headRefOid":"${squashPrHead}","mergeCommit":{"oid":"${squashMergeSha}"}},{"number":11,"title":"Active open PR","state":"OPEN","url":"https://github.com/antan87/Context-Space/pull/11","baseRefName":"main","headRefOid":"${openPrHead}","mergeCommit":null},{"number":8,"title":"Abandoned PR","state":"CLOSED","url":"https://github.com/antan87/Context-Space/pull/8","baseRefName":"main","headRefOid":"${squashPrHead}","mergeCommit":null}]'
else
  echo '[{"number":10,"title":"Merged squash PR","state":"MERGED","url":"https://github.com/antan87/Context-Space/pull/10","baseRefName":"main","headRefOid":"${squashPrHead}","mergeCommit":{"oid":"${squashMergeSha}"}}]'
fi
`);

    const first = await recentCommits(ws);
    expect(first.commits[0]?.pullRequests?.map((p) => p.number)).toEqual([10]);
    const firstBySubject = new Map(first.commits[0]!.commits.map((c) => [c.subject, c]));
    expect(firstBySubject.get('Squash PR commit')?.prNumber).toBe(10);
    expect(firstBySubject.get('Open PR commit')?.prNumber).toBeUndefined();

    // Now PR #11 is opened; cached recentCommits keeps #10 until incoming refresh=true ("Check now") busts cache
    await fs.writeFile(flagFile, '1');
    const cached = await recentCommits(ws);
    expect(cached.commits[0]?.pullRequests?.map((p) => p.number)).toEqual([10]);

    const inc = await incomingCommits(ws, { refresh: true });
    expect(inc.repos[0]).toMatchObject({
      repo: 'NexusFlow',
      ref: 'origin/feat/demo',
      remoteRepo: 'antan87/Context-Space',
    });

    const refreshed = await recentCommits(ws);
    expect(refreshed.commits[0]?.pullRequests?.map((p) => [p.number, p.state])).toEqual([
      [11, 'OPEN'],
      [10, 'MERGED'],
      [8, 'CLOSED'],
    ]);
    const refreshedBySubject = new Map(refreshed.commits[0]!.commits.map((c) => [c.subject, c]));
    expect(refreshedBySubject.get('Squash PR commit')?.prNumber).toBe(10);
    expect(refreshedBySubject.get('Open PR commit')?.prNumber).toBe(11);

    // Detached HEAD must report branch: null, base: null, no pullRequests
    await git(repoDir, ['checkout', '--detach', 'HEAD']);
    const detached = await recentCommits(ws);
    expect(detached.commits[0]).toMatchObject({
      repo: 'NexusFlow',
      remoteRepo: 'antan87/Context-Space',
      branch: null,
      base: null,
    });
    expect(detached.commits[0]?.pullRequests).toBeUndefined();
  });

  it('partitions a squash-merged PR, merged main squash commit (onBase), follow-up OPEN PR, and unassigned commit on the same branch', async () => {
    const githubUrl = 'https://github.com/antan87/Context-Space.git';
    await git(repoDir, ['config', `url.${bare}.insteadOf`, githubUrl]);
    await git(repoDir, ['remote', 'set-url', 'origin', githubUrl]);

    await git(repoDir, ['checkout', '-b', 'feat/demo']);
    await fs.writeFile(path.join(repoDir, 'p1.ts'), 'export const p1 = 1;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'PR10 commit'], commitEnv(6));
    const pr10Head = await git(repoDir, ['rev-parse', 'HEAD']);

    // Squash-merge PR #10 onto origin/main from another clone
    const merger = path.join(root, 'squasher2');
    await git(root, ['clone', bare, merger]);
    await git(merger, ['config', 'user.name', 'Maintainer']);
    await git(merger, ['config', 'user.email', 'm@example.com']);
    await fs.writeFile(path.join(merger, 'p1.ts'), 'export const p1 = 1;\n');
    await git(merger, ['add', '.']);
    await git(merger, ['commit', '-m', 'PR10 squashed (#10)'], commitEnv(5, 'Maintainer'));
    const pr10SquashSha = await git(merger, ['rev-parse', 'HEAD']);
    await git(merger, ['push', 'origin', 'main']);

    // Pull origin/main into feat/demo, then commit OPEN PR #11 and post-PR work
    await git(repoDir, ['fetch', 'origin', 'main']);
    await git(repoDir, ['merge', '--no-ff', 'origin/main', '-m', 'Sync main after #10'], commitEnv(4));
    await fs.writeFile(path.join(repoDir, 'p2.ts'), 'export const p2 = 2;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'PR11 open commit'], commitEnv(3));
    const pr11Head = await git(repoDir, ['rev-parse', 'HEAD']);

    await fs.writeFile(path.join(repoDir, 'p3.ts'), 'export const p3 = 3;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'After PR11 local commit'], commitEnv(1));

    const payload = JSON.stringify([
      {
        number: 10,
        title: 'Squashed first PR',
        state: 'MERGED',
        url: 'https://github.com/antan87/Context-Space/pull/10',
        baseRefName: 'main',
        headRefOid: pr10Head,
        mergeCommit: { oid: pr10SquashSha },
      },
      {
        number: 11,
        title: 'Follow-up open PR',
        state: 'OPEN',
        url: 'https://github.com/antan87/Context-Space/pull/11',
        baseRefName: 'main',
        headRefOid: pr11Head,
        mergeCommit: null,
      },
    ]);
    await installFakeGh(`cat <<'JSON'\n${payload}\nJSON`);

    const recent = await recentCommits(ws);
    const bySubject = new Map(recent.commits[0]!.commits.map((c) => [c.subject, c]));
    expect(bySubject.get('PR10 commit')?.prNumber).toBe(10);
    // The squash result is PR #10's mergeCommitOid, so it belongs to #10
    expect(bySubject.get('PR10 squashed (#10)')?.prNumber).toBe(10);
    expect(bySubject.get('PR10 squashed (#10)')?.onBase).toBeUndefined();
    expect(bySubject.get('PR11 open commit')?.prNumber).toBe(11);
    expect(bySubject.get('After PR11 local commit')?.prNumber).toBeUndefined();
    expect(bySubject.get('After PR11 local commit')?.onBase).toBeUndefined();
  });

  it('keeps a squash-merged PR and a later merge-commit PR on the same branch separated accurately', async () => {
    const githubUrl = 'https://github.com/antan87/Context-Space.git';
    await git(repoDir, ['config', `url.${bare}.insteadOf`, githubUrl]);
    await git(repoDir, ['remote', 'set-url', 'origin', githubUrl]);

    await git(repoDir, ['checkout', '-b', 'feat/demo']);
    await fs.writeFile(path.join(repoDir, 'sq1.ts'), 'export const sq1 = 1;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'PR10 squash source commit'], commitEnv(8));
    const pr10Head = await git(repoDir, ['rev-parse', 'HEAD']);
    await git(repoDir, ['push', '-u', 'origin', 'feat/demo']);

    // Clone 1: squash-merge PR #10 onto origin/main (1-parent commit S10)
    const merger = path.join(root, 'squash-then-merge');
    await git(root, ['clone', bare, merger]);
    await git(merger, ['config', 'user.name', 'Maintainer']);
    await git(merger, ['config', 'user.email', 'm@example.com']);
    await git(merger, ['merge', '--squash', 'origin/feat/demo']);
    await git(merger, ['commit', '-m', 'Squash PR #10'], commitEnv(7, 'Maintainer'));
    const s10Sha = await git(merger, ['rev-parse', 'HEAD']);
    await git(merger, ['push', 'origin', 'main']);

    // Continue on feat/demo with C2, push, and merge PR #11 via --no-ff merge commit M11
    await fs.writeFile(path.join(repoDir, 'sq2.ts'), 'export const sq2 = 2;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'PR11 merge-commit source'], commitEnv(5));
    const pr11Head = await git(repoDir, ['rev-parse', 'HEAD']);
    await git(repoDir, ['push', 'origin', 'feat/demo']);

    await git(merger, ['fetch', 'origin']);
    await git(merger, ['merge', '--no-ff', 'origin/feat/demo', '-m', 'Merge pull request #11 from antan87/feat/demo'], commitEnv(4, 'Maintainer'));
    const m11Sha = await git(merger, ['rev-parse', 'HEAD']);
    await git(merger, ['push', 'origin', 'main']);

    // Fetch updated origin/main and merge it back into feat/demo + add post-PR work
    await git(repoDir, ['fetch', 'origin', 'main']);
    await git(repoDir, ['merge', '--no-ff', 'origin/main', '-m', 'Sync main after #11'], commitEnv(3));
    await fs.writeFile(path.join(repoDir, 'sq3.ts'), 'export const sq3 = 3;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'Post-#11 local commit'], commitEnv(1));

    const payload = JSON.stringify([
      {
        number: 10,
        title: 'First squash PR',
        state: 'MERGED',
        url: 'https://github.com/antan87/Context-Space/pull/10',
        baseRefName: 'main',
        headRefOid: pr10Head,
        mergeCommit: { oid: s10Sha },
      },
      {
        number: 11,
        title: 'Follow-up merge commit PR',
        state: 'MERGED',
        url: 'https://github.com/antan87/Context-Space/pull/11',
        baseRefName: 'main',
        headRefOid: pr11Head,
        mergeCommit: { oid: m11Sha },
      },
    ]);
    await installFakeGh(`cat <<'JSON'\n${payload}\nJSON`);

    const recent = await recentCommits(ws);
    const bySubject = new Map(recent.commits[0]!.commits.map((c) => [c.subject, c]));
    expect(bySubject.get('PR10 squash source commit')?.prNumber).toBe(10);
    expect(bySubject.get('PR11 merge-commit source')?.prNumber).toBe(11);
    expect(bySubject.get('Squash PR #10')?.prNumber).toBe(10);
    expect(bySubject.get('Squash PR #10')?.onBase).toBeUndefined();
    expect(bySubject.get('Merge pull request #11 from antan87/feat/demo')?.prNumber).toBe(11);
    expect(bySubject.get('Merge pull request #11 from antan87/feat/demo')?.onBase).toBeUndefined();
    expect(bySubject.get('Post-#11 local commit')?.prNumber).toBeUndefined();
    expect(bySubject.get('Post-#11 local commit')?.onBase).toBeUndefined();
  });

  it('keeps a rebase-merged PR and a later merge-commit PR on the same branch separated, and ties a fast-forward merge to its PR', async () => {
    const githubUrl = 'https://github.com/antan87/Context-Space.git';
    await git(repoDir, ['config', `url.${bare}.insteadOf`, githubUrl]);
    await git(repoDir, ['remote', 'set-url', 'origin', githubUrl]);

    await git(repoDir, ['checkout', '-b', 'feat/demo']);
    await fs.writeFile(path.join(repoDir, 'rb1.ts'), 'export const rb1 = 1;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'PR30 rebase commit 1'], commitEnv(10));

    await fs.writeFile(path.join(repoDir, 'rb2.ts'), 'export const rb2 = 2;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'PR30 rebase commit 2'], commitEnv(9));
    const pr30Head = await git(repoDir, ['rev-parse', 'HEAD']);
    await git(repoDir, ['push', '-u', 'origin', 'feat/demo']);

    // Clone 1: another commit lands on main, then PR #30's two commits are rebase-merged onto main (new SHAs R1', R2')
    const merger = path.join(root, 'rebase-then-merge');
    await git(root, ['clone', bare, merger]);
    await git(merger, ['config', 'user.name', 'Maintainer']);
    await git(merger, ['config', 'user.email', 'm@example.com']);
    await fs.writeFile(path.join(merger, 'main-other.ts'), 'export const mo = 1;\n');
    await git(merger, ['add', '.']);
    await git(merger, ['commit', '-m', 'Main unrelated commit'], commitEnv(8.5, 'Maintainer'));
    await git(merger, ['checkout', '-b', 'tmp-rebase', 'origin/feat/demo']);
    await git(merger, ['rebase', 'main'], commitEnv(8, 'Maintainer'));
    const rebasedTip = await git(merger, ['rev-parse', 'HEAD']);
    await git(merger, ['checkout', 'main']);
    await git(merger, ['merge', '--ff-only', 'tmp-rebase']);
    await git(merger, ['push', 'origin', 'main']);

    // Continue on feat/demo with R3, push, and merge PR #31 via --no-ff merge commit M31
    await fs.writeFile(path.join(repoDir, 'rb3.ts'), 'export const rb3 = 3;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'PR31 merge commit source'], commitEnv(6));
    const pr31Head = await git(repoDir, ['rev-parse', 'HEAD']);
    await git(repoDir, ['push', 'origin', 'feat/demo']);

    await git(merger, ['fetch', 'origin']);
    await git(merger, ['merge', '--no-ff', 'origin/feat/demo', '-m', 'Merge pull request #31 from antan87/feat/demo'], commitEnv(5, 'Maintainer'));
    const m31Sha = await git(merger, ['rev-parse', 'HEAD']);
    await git(merger, ['push', 'origin', 'main']);

    // Merge origin/main into feat/demo and fast-forward PR #32 onto main (mergeCommitOid === headRefOid)
    await git(repoDir, ['fetch', 'origin', 'main']);
    await git(repoDir, ['merge', '--no-ff', 'origin/main', '-m', 'Sync main after #31'], commitEnv(4));
    await fs.writeFile(path.join(repoDir, 'ff1.ts'), 'export const ff1 = 1;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'PR32 fast-forward commit'], commitEnv(3));
    const pr32Head = await git(repoDir, ['rev-parse', 'HEAD']);
    await git(repoDir, ['push', 'origin', 'feat/demo']);

    await git(merger, ['fetch', 'origin']);
    await git(merger, ['merge', '--ff-only', 'origin/feat/demo']);
    const ffMergeSha = await git(merger, ['rev-parse', 'HEAD']);
    expect(ffMergeSha).toBe(pr32Head);
    await git(merger, ['push', 'origin', 'main']);
    await git(repoDir, ['fetch', 'origin', 'main']);

    await fs.writeFile(path.join(repoDir, 'post.ts'), 'export const post = 1;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'Post-FF unassigned commit'], commitEnv(1));

    const payload = JSON.stringify([
      {
        number: 30,
        title: 'Rebased PR',
        state: 'MERGED',
        url: 'https://github.com/antan87/Context-Space/pull/30',
        baseRefName: 'main',
        headRefOid: pr30Head,
        mergeCommit: { oid: rebasedTip },
      },
      {
        number: 31,
        title: 'Follow-up merge commit PR',
        state: 'MERGED',
        url: 'https://github.com/antan87/Context-Space/pull/31',
        baseRefName: 'main',
        headRefOid: pr31Head,
        mergeCommit: { oid: m31Sha },
      },
      {
        number: 32,
        title: 'Fast-forward PR',
        state: 'MERGED',
        url: 'https://github.com/antan87/Context-Space/pull/32',
        baseRefName: 'main',
        headRefOid: pr32Head,
        mergeCommit: { oid: ffMergeSha },
      },
    ]);
    await installFakeGh(`cat <<'JSON'\n${payload}\nJSON`);

    const recent = await recentCommits(ws);
    const bySubject = new Map(recent.commits[0]!.commits.map((c) => [c.subject, c]));
    // Rebased PR #30 commits keep prNumber 30 despite M31 bringing them onto origin/main
    expect(bySubject.get('PR30 rebase commit 1')?.prNumber).toBe(30);
    expect(bySubject.get('PR30 rebase commit 2')?.prNumber).toBe(30);
    // Merge-commit PR #31 claims only its own commit
    expect(bySubject.get('PR31 merge commit source')?.prNumber).toBe(31);
    // Fast-forward merge: the head is also the mergeCommitOid, so GitHub's own evidence ties it to #32
    expect(bySubject.get('PR32 fast-forward commit')?.prNumber).toBe(32);
    expect(bySubject.get('PR32 fast-forward commit')?.onBase).toBeUndefined();
    // Post-FF local commit stays unassigned
    expect(bySubject.get('Post-FF unassigned commit')?.prNumber).toBeUndefined();
    expect(bySubject.get('Post-FF unassigned commit')?.onBase).toBeUndefined();
  });

  it('omits onBase on cold pending gh loads, keeps cached PRs and onBase during incoming refresh, and preserves onBase during refresh on a 0-PR branch', async () => {
    const githubUrl = 'https://github.com/antan87/Context-Space.git';
    await git(repoDir, ['config', `url.${bare}.insteadOf`, githubUrl]);
    await git(repoDir, ['remote', 'set-url', 'origin', githubUrl]);

    await git(repoDir, ['checkout', '-b', 'feat/demo']);
    await fs.writeFile(path.join(repoDir, 'cold1.ts'), 'export const c1 = 1;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'Merged PR commit'], commitEnv(6));
    const prHead = await git(repoDir, ['rev-parse', 'HEAD']);
    await git(repoDir, ['push', '-u', 'origin', 'feat/demo']);

    const merger = path.join(root, 'cold-merger');
    await git(root, ['clone', bare, merger]);
    await git(merger, ['config', 'user.name', 'Maintainer']);
    await git(merger, ['config', 'user.email', 'm@example.com']);
    await fs.writeFile(path.join(merger, 'main-other.ts'), 'export const mo = 1;\n');
    await git(merger, ['add', '.']);
    await git(merger, ['commit', '-m', 'Main unrelated commit'], commitEnv(5, 'Maintainer'));
    await git(merger, ['merge', '--no-ff', 'origin/feat/demo', '-m', 'Merge pull request #482 from antan87/feat/demo'], commitEnv(4, 'Maintainer'));
    const mergeSha = await git(merger, ['rev-parse', 'HEAD']);
    await git(merger, ['push', 'origin', 'main']);

    await git(repoDir, ['fetch', 'origin', 'main']);
    await git(repoDir, ['merge', '--no-ff', 'origin/main', '-m', 'Sync main'], commitEnv(3));
    await fs.writeFile(path.join(repoDir, 'cold2.ts'), 'export const c2 = 2;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'Unassigned local work'], commitEnv(1));

    const payloadFile = path.join(root, 'slow-prs.json');
    await fs.writeFile(
      payloadFile,
      JSON.stringify([
        {
          number: 482,
          title: 'Merged board PR',
          state: 'MERGED',
          url: 'https://github.com/antan87/Context-Space/pull/482',
          baseRefName: 'main',
          headRefOid: prHead,
          mergeCommit: { oid: mergeSha },
        },
      ]),
    );
    await fs.writeFile(
      path.join(tmpBin, 'gh'),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh version 2.40.0'); process.exit(0); }
if (args[0] === 'auth') { process.exit(0); }
if (args[0] === 'pr' && args[1] === 'list') {
  setTimeout(() => {
    process.stdout.write(fs.readFileSync(${JSON.stringify(payloadFile)}, 'utf8'));
    process.exit(0);
  }, 350);
} else {
  process.exit(1);
}
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tmpBin}:${originalPath}`;
    resetMergeDetectionCache();

    let settledCount = 0;
    const unsubscribe = subscribePullRequestsSettled(() => {
      settledCount += 1;
    });
    try {
      // 1. Cold load while gh is pending (!hasCached): must NOT file merged-PR or base commits under Already on main
      const cold = await recentCommits(ws, { prWaitMs: 50 });
      const coldRepo = cold.commits[0]!;
      expect(coldRepo.prsPending).toBe(true);
      expect(coldRepo.pullRequests).toBeUndefined();
      for (const commit of coldRepo.commits) {
        expect(commit.onBase).toBeUndefined();
        expect(commit.prNumber).toBeUndefined();
      }

      // Wait for cold gh fetch to settle -> PR #482 and onBase populate
      await expect.poll(() => settledCount, { timeout: 3_000 }).toBe(1);
      const settled = await recentCommits(ws, { prWaitMs: 50 });
      const settledRepo = settled.commits[0]!;
      expect(settledRepo.prsPending).toBeUndefined();
      expect(settledRepo.pullRequests?.map((p) => p.number)).toEqual([482]);
      const settledBySubject = new Map(settledRepo.commits.map((c) => [c.subject, c]));
      expect(settledBySubject.get('Merged PR commit')?.prNumber).toBe(482);
      expect(settledBySubject.get('Main unrelated commit')?.onBase).toBe(true);
      expect(settledBySubject.get('Unassigned local work')?.onBase).toBeUndefined();

      // 2. "Check now" (incomingCommits refresh=true) while gh is slow keeps cached PR #482 and onBase
      await incomingCommits(ws, { refresh: true });
      const refreshing = await recentCommits(ws, { prWaitMs: 50 });
      const refreshingRepo = refreshing.commits[0]!;
      expect(refreshingRepo.prsPending).toBe(true);
      expect(refreshingRepo.pullRequests?.map((p) => p.number)).toEqual([482]);
      const refreshingBySubject = new Map(refreshingRepo.commits.map((c) => [c.subject, c]));
      expect(refreshingBySubject.get('Merged PR commit')?.prNumber).toBe(482);
      expect(refreshingBySubject.get('Main unrelated commit')?.onBase).toBe(true);

      await expect.poll(() => settledCount, { timeout: 3_000 }).toBe(2);

      // 3. On a 0-PR branch (cached []), refreshing while gh is slow preserves Already on main (hasCached: true)
      await fs.writeFile(payloadFile, '[]');
      resetIncomingCommitsState();
      await incomingCommits(ws, { refresh: true });
      await recentCommits(ws, { prWaitMs: 50 });
      await expect.poll(() => settledCount, { timeout: 3_000 }).toBe(3);

      const zeroPrWarm = await recentCommits(ws, { prWaitMs: 50 });
      expect(zeroPrWarm.commits[0]?.pullRequests).toBeUndefined();
      expect(zeroPrWarm.commits[0]?.commits.find((c) => c.subject === 'Main unrelated commit')?.onBase).toBe(true);

      resetIncomingCommitsState();
      await incomingCommits(ws, { refresh: true });
      const zeroPrRefreshing = await recentCommits(ws, { prWaitMs: 50 });
      expect(zeroPrRefreshing.commits[0]?.prsPending).toBe(true);
      expect(zeroPrRefreshing.commits[0]?.commits.find((c) => c.subject === 'Main unrelated commit')?.onBase).toBe(true);
      await expect.poll(() => settledCount, { timeout: 3_000 }).toBe(4);
    } finally {
      unsubscribe();
    }
  });

  it('does not let a fast-forward merge of a 2-parent sync-merge tip claim origin/main commits', async () => {
    const githubUrl = 'https://github.com/antan87/Context-Space.git';
    await git(repoDir, ['config', `url.${bare}.insteadOf`, githubUrl]);
    await git(repoDir, ['remote', 'set-url', 'origin', githubUrl]);

    await git(repoDir, ['checkout', '-b', 'feat/demo']);
    await fs.writeFile(path.join(repoDir, 'ff-sync-1.ts'), 'export const f1 = 1;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'Feature commit before sync'], commitEnv(6));

    // Another commit lands on origin/main
    const other = path.join(root, 'other-main');
    await git(root, ['clone', bare, other]);
    await git(other, ['config', 'user.name', 'Maintainer']);
    await git(other, ['config', 'user.email', 'm@example.com']);
    await fs.writeFile(path.join(other, 'unrelated.ts'), 'export const unrelated = 1;\n');
    await git(other, ['add', '.']);
    await git(other, ['commit', '-m', 'Unrelated main commit before FF'], commitEnv(5, 'Maintainer'));
    await git(other, ['push', 'origin', 'main']);

    // Feature branch merges origin/main -> 2-parent sync-merge tip S
    await git(repoDir, ['fetch', 'origin', 'main']);
    await git(repoDir, ['merge', '--no-ff', 'origin/main', '-m', 'Sync main into feat/demo before FF'], commitEnv(4));
    const syncTipSha = await git(repoDir, ['rev-parse', 'HEAD']);
    await git(repoDir, ['push', '-u', 'origin', 'feat/demo']);

    // PR is fast-forward merged onto main -> mergeCommitOid === headRefOid === S (which has 2 parents!)
    await git(other, ['fetch', 'origin']);
    await git(other, ['merge', '--ff-only', 'origin/feat/demo']);
    const ffMergeSha = await git(other, ['rev-parse', 'HEAD']);
    expect(ffMergeSha).toBe(syncTipSha);
    await git(other, ['push', 'origin', 'main']);
    await git(repoDir, ['fetch', 'origin', 'main']);

    await fs.writeFile(path.join(repoDir, 'ff-sync-post.ts'), 'export const f2 = 2;\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'Local commit after sync FF'], commitEnv(1));

    const payload = JSON.stringify([
      {
        number: 33,
        title: 'Fast-forward sync tip PR',
        state: 'MERGED',
        url: 'https://github.com/antan87/Context-Space/pull/33',
        baseRefName: 'main',
        headRefOid: syncTipSha,
        mergeCommit: { oid: ffMergeSha },
      },
    ]);
    await installFakeGh(`cat <<'JSON'\n${payload}\nJSON`);

    const recent = await recentCommits(ws);
    const bySubject = new Map(recent.commits[0]!.commits.map((c) => [c.subject, c]));
    expect(bySubject.get('Unrelated main commit before FF')?.prNumber).toBeUndefined();
    expect(bySubject.get('Unrelated main commit before FF')?.onBase).toBe(true);
    expect(bySubject.get('Feature commit before sync')?.prNumber).toBeUndefined();
    expect(bySubject.get('Feature commit before sync')?.onBase).toBe(true);
    // The tip itself is both the PR head and the merge result GitHub names, so it belongs to #33; nothing below it does.
    expect(bySubject.get('Sync main into feat/demo before FF')?.prNumber).toBe(33);
    expect(bySubject.get('Sync main into feat/demo before FF')?.onBase).toBeUndefined();
    expect(bySubject.get('Local commit after sync FF')?.prNumber).toBeUndefined();
    expect(bySubject.get('Local commit after sync FF')?.onBase).toBeUndefined();
  });
});
