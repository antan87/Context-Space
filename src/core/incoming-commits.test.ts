import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import {
  classifyGitFetchError,
  incomingCommits,
  resetIncomingCommitsState,
  resolveHostInfo,
  waitForIncomingFetches,
  withBatchModeSsh,
} from './incoming-commits.js';
import { readCommit } from './commit-detail.js';
import { recentCommits, whatsNew } from './whats-new.js';

const git = async (cwd: string, ...args: string[]) => {
  const { stdout } = await execa('git', args, { cwd });
  return stdout;
};

const sha256 = async (filePath: string) => {
  const buf = await fs.readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
};

async function createWorkspaceWithBareRemote(
  root: string,
  options: { repoName?: string; branch?: string; useWorktree?: boolean; trackUpstream?: boolean } = {},
) {
  const repoName = options.repoName ?? 'api';
  const branch = options.branch ?? 'feat/incoming';
  const trackUpstream = options.trackUpstream ?? true;
  const bare = path.join(root, `${repoName}-remote.git`);
  const seed = path.join(root, `${repoName}-seed`);
  const ws = path.join(root, 'workspace');
  const maria = path.join(root, `${repoName}-maria`);

  await fs.mkdir(ws, { recursive: true });
  await execa('git', ['init', '--bare', '-b', 'main', bare]);
  await execa('git', ['clone', bare, seed]);
  await git(seed, 'config', 'user.name', 'Seed');
  await git(seed, 'config', 'user.email', 'seed@example.com');
  await fs.writeFile(path.join(seed, 'README.md'), '# Repo\n');
  await git(seed, 'add', 'README.md');
  await git(seed, 'commit', '-m', 'Initial commit');
  await git(seed, 'push', '-u', 'origin', 'main');
  await git(seed, 'checkout', '-b', branch);
  await fs.writeFile(path.join(seed, 'base.ts'), 'export const base = 1;\n');
  await git(seed, 'add', 'base.ts');
  await git(seed, 'commit', '-m', 'Start feature branch');
  await git(seed, 'push', '-u', 'origin', branch);

  let workspaceRepoPath: string;
  let baseClonePath: string | null = null;
  if (options.useWorktree) {
    baseClonePath = path.join(root, `${repoName}-base`);
    await execa('git', ['clone', bare, baseClonePath]);
    workspaceRepoPath = path.join(ws, repoName);
    await git(
      baseClonePath,
      'worktree',
      'add',
      ...(trackUpstream ? ['--track'] : ['--no-track']),
      '-b',
      branch,
      workspaceRepoPath,
      `origin/${branch}`,
    );
  } else {
    workspaceRepoPath = path.join(ws, repoName);
    await execa('git', ['clone', '-b', branch, bare, workspaceRepoPath]);
    if (!trackUpstream) {
      await git(workspaceRepoPath, 'branch', '--unset-upstream');
    }
  }
  await git(workspaceRepoPath, 'config', 'user.name', 'Developer');
  await git(workspaceRepoPath, 'config', 'user.email', 'dev@example.com');

  await execa('git', ['clone', '-b', branch, bare, maria]);
  await git(maria, 'config', 'user.name', 'Maria');
  await git(maria, 'config', 'user.email', 'maria@example.com');

  await fs.writeFile(
    path.join(ws, 'contextspace.json'),
    JSON.stringify({
      id: 'ws-test',
      name: 'WS Test',
      branchName: branch,
      repos: [workspaceRepoPath],
      assistants: [],
      workspacePath: ws,
    }),
  );

  return { ws, bare, repo: workspaceRepoPath, baseClonePath, maria, branch, repoName };
}

async function commitAsMaria(
  maria: string,
  subject: string,
  files: Record<string, string>,
  options: { body?: string; date?: string } = {},
) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(maria, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  await git(maria, 'add', '.');
  const args = ['commit', '-m', subject];
  if (options.body) args.push('-m', options.body);
  const env = options.date
    ? {
        ...process.env,
        GIT_AUTHOR_NAME: 'Maria',
        GIT_AUTHOR_EMAIL: 'maria@example.com',
        GIT_AUTHOR_DATE: options.date,
        GIT_COMMITTER_NAME: 'Maria',
        GIT_COMMITTER_EMAIL: 'maria@example.com',
        GIT_COMMITTER_DATE: options.date,
      }
    : undefined;
  await execa('git', args, { cwd: maria, env });
  const sha = (await git(maria, 'rev-parse', 'HEAD')).trim();
  await git(maria, 'push', 'origin', 'HEAD');
  return sha;
}

async function getClosedLocalhostPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe('classifyGitFetchError (pure)', () => {
  it('classifies vendor HTTPS sign-in messages as sign-in', () => {
    const cases = [
      // GitHub HTTPS
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      'fatal: terminal prompts disabled',
      "fatal: Authentication failed for 'https://github.com/org/repo.git/'",
      'fatal: unable to get password from user',
      // Azure DevOps
      "fatal: Authentication failed for 'https://dev.azure.com/myorg/myproj/_git/myrepo/'",
      "fatal: unable to access 'https://myorg.visualstudio.com/myproj/_git/myrepo/': The requested URL returned error: 401",
      "fatal: unable to access 'https://myorg.visualstudio.com/myproj/_git/myrepo/': The requested URL returned error: 403",
      // GitLab
      "remote: HTTP Basic: Access denied. If a password was provided for Git authentication, the password was incorrect or you're required to use a token instead of a password.\nfatal: Authentication failed for 'https://gitlab.com/group/repo.git/'",
      'remote: HTTP Basic: Access denied',
      // Bitbucket
      "remote: Invalid credentials\nfatal: Authentication failed for 'https://bitbucket.org/team/repo.git/'",
      "fatal: unable to access 'https://bitbucket.org/team/repo.git/': The requested URL returned error: 403",
      // SSH
      'git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.',
      'Host key verification failed.\r\nfatal: Could not read from remote repository.',
    ];
    for (const stderr of cases) {
      expect(classifyGitFetchError(stderr).state, stderr).toBe('sign-in');
    }
  });

  it('classifies offline / network failures as offline', () => {
    const cases = [
      "fatal: unable to access 'https://github.com/org/repo.git/': Could not resolve host: github.com",
      'ssh: Could not resolve host dev.azure.com: Temporary failure in name resolution\nfatal: Could not read from remote repository.',
      'ssh: connect to host github.com port 22: Connection refused\nfatal: Could not read from remote repository.',
      "fatal: unable to access 'https://github.com/org/repo.git/': Failed to connect to github.com port 443 after 30001 ms: Connection timed out",
      "fatal: unable to access 'http://127.0.0.1:43210/org/repo.git/': Failed to connect to 127.0.0.1 port 43210 after 0 ms: Could not connect to server",
    ];
    for (const stderr of cases) {
      expect(classifyGitFetchError(stderr).state, stderr).toBe('offline');
    }
  });

  it('classifies lock-lost errors as busy (not error) and redacts credentials from stderr details', () => {
    const lockCases = [
      "error: cannot lock ref 'refs/remotes/origin/main': Unable to create '/tmp/repo/.git/refs/remotes/origin/main.lock': File exists.",
      "fatal: Unable to create '/tmp/repo/.git/index.lock': File exists.",
      "error: cannot lock ref 'refs/remotes/origin/feat': ref is locked",
      "fatal: Unable to create '/tmp/repo/.git/packed-refs.lock': File exists.",
      'error: failed to update packed-refs.lock',
    ];
    for (const stderr of lockCases) {
      expect(classifyGitFetchError(stderr).state, stderr).toBe('busy');
    }

    const withCreds = classifyGitFetchError(
      "fatal: remote error from 'https://alice:ghp_SuperSecretToken@github.com/org/repo.git/': bad gateway\nsecond line",
    );
    expect(withCreds.state).toBe('error');
    expect(withCreds.detail).not.toContain('alice');
    expect(withCreds.detail).not.toContain('ghp_SuperSecretToken');
    expect(withCreds.detail).toContain('github.com');

    const withBearer = classifyGitFetchError(
      "fatal: proxy error via https://onlytoken@dev.azure.com/org/proj/_git/repo and user:pass123@proxy.local:8080",
    );
    expect(withBearer.detail).not.toContain('onlytoken');
    expect(withBearer.detail).not.toContain('pass123');
    expect(withBearer.detail).toContain('dev.azure.com');
  });

  it('classifies anything else as error with the first line of git stderr', () => {
    const res = classifyGitFetchError('\n  fatal: remote error: internal server error  \nsecond line\n');
    expect(res).toEqual({
      state: 'error',
      detail: 'fatal: remote error: internal server error',
    });
  });
});

describe('resolveHostInfo', () => {
  it('recognizes GitHub, Azure DevOps, GitLab, Bitbucket, and unknown hosts', () => {
    expect(resolveHostInfo('https://github.com/org/repo.git').host).toEqual({ kind: 'github', name: 'GitHub' });
    expect(resolveHostInfo('git@github.com:org/repo.git').host).toEqual({ kind: 'github', name: 'GitHub' });
    expect(resolveHostInfo('https://dev.azure.com/org/project/_git/repo').host).toEqual({ kind: 'azure', name: 'Azure DevOps' });
    expect(resolveHostInfo('git@ssh.dev.azure.com:v3/org/project/repo').host).toEqual({ kind: 'azure', name: 'Azure DevOps' });
    expect(resolveHostInfo('https://myorg.visualstudio.com/project/_git/repo').host).toEqual({ kind: 'azure', name: 'Azure DevOps' });
    expect(resolveHostInfo('https://gitlab.com/group/sub/repo.git').host).toEqual({ kind: 'gitlab', name: 'GitLab' });
    expect(resolveHostInfo('git@bitbucket.org:team/repo.git').host).toEqual({ kind: 'bitbucket', name: 'Bitbucket' });
    expect(resolveHostInfo('https://git.internal.corp/team/repo.git').host).toEqual({ kind: 'unknown', name: 'git.internal.corp' });
    expect(resolveHostInfo('https://gitea.local/repo.git').host).toEqual({ kind: 'unknown', name: 'gitea.local' });
  });
});

describe('incomingCommits (real git)', { timeout: 60_000 }, () => {
  let root: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    resetIncomingCommitsState();
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'incoming-commits-')));
    const testHome = path.join(root, 'home');
    await fs.mkdir(testHome);
    savedEnv = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
      GIT_SSH: process.env.GIT_SSH,
      GIT_ASKPASS: process.env.GIT_ASKPASS,
      SSH_ASKPASS: process.env.SSH_ASKPASS,
      DISPLAY: process.env.DISPLAY,
    };
    process.env.HOME = testHome;
    process.env.GIT_CONFIG_GLOBAL = path.join(testHome, '.gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH;
    delete process.env.GIT_ASKPASS;
    delete process.env.SSH_ASKPASS;
    delete process.env.DISPLAY;
  });

  afterEach(async () => {
    await waitForIncomingFetches();
    resetIncomingCommitsState();
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it('changes only objects and the one remote-tracking ref (never HEAD, index, working tree, FETCH_HEAD, tags, other refs, or config)', async () => {
    const { ws, bare, repo, maria, branch } = await createWorkspaceWithBareRemote(root);

    // Second repo in the same workspace: checked out on an alias tracking origin/<branch>,
    // with a local branch of the remote branch's name sitting at an older commit and a mirror refspec.
    const aliasRepo = path.join(ws, 'alias-app');
    await execa('git', ['clone', '-b', branch, bare, aliasRepo]);
    await git(aliasRepo, 'checkout', '-b', 'my-alias', '--track', `origin/${branch}`);
    await git(aliasRepo, 'branch', '-f', branch, 'origin/main');
    const localBranchBefore = (await git(aliasRepo, 'rev-parse', `refs/heads/${branch}`)).trim();
    await git(aliasRepo, 'config', '--replace-all', 'remote.origin.fetch', '+refs/*:refs/*');

    await git(repo, 'config', '--replace-all', 'remote.origin.fetch', '+refs/*:refs/*');

    await fs.writeFile(
      path.join(ws, 'contextspace.json'),
      JSON.stringify({
        id: 'ws-test',
        name: 'WS Test',
        branchName: branch,
        repos: [repo, aliasRepo],
        assistants: [],
        workspacePath: ws,
      }),
    );

    // Dirty the working tree, stage a file in the index, add a local branch & tag, and keep an existing FETCH_HEAD.
    await fs.writeFile(path.join(repo, 'staged.txt'), 'staged content\n');
    await git(repo, 'add', 'staged.txt');
    await fs.writeFile(path.join(repo, 'dirty.txt'), 'untracked\n');
    await fs.writeFile(path.join(repo, 'base.ts'), 'export const base = 999;\n');
    await git(repo, 'branch', 'other-local', 'origin/main');
    await git(repo, 'tag', 'v1.0-local');
    const fetchHeadPath = path.join(repo, '.git', 'FETCH_HEAD');
    await fs.writeFile(fetchHeadPath, 'preserved fetch head\n');

    // Also push a tag and a commit on `main` from Maria that must NOT be fetched.
    await git(maria, 'checkout', 'main');
    await fs.writeFile(path.join(maria, 'main-only.txt'), 'main\n');
    await git(maria, 'add', 'main-only.txt');
    await git(maria, 'commit', '-m', 'Main branch commit');
    await git(maria, 'tag', 'v2.0-remote');
    await git(maria, 'push', 'origin', 'main', 'v2.0-remote');

    // Now Maria pushes to the workspace branch.
    await git(maria, 'checkout', branch);
    const mariaSha = await commitAsMaria(maria, 'Maria feature commit', { 'maria.ts': 'export const m = 1;\n' });

    const beforeRefs = await git(repo, 'for-each-ref');
    const beforeHead = await git(repo, 'rev-parse', 'HEAD');
    const beforeHeadSym = await git(repo, 'symbolic-ref', 'HEAD');
    const beforeIndexStage = await git(repo, 'ls-files', '--stage');
    const beforeIndexHash = await sha256(path.join(repo, '.git', 'index'));
    const beforeStatus = await git(repo, 'status', '--porcelain=v1', '-uall');
    const beforeFetchHeadHash = await sha256(fetchHeadPath);
    const beforeConfig = await git(repo, 'config', '--list', '--local');
    const beforeAliasRefs = await git(aliasRepo, 'for-each-ref');

    const report = await incomingCommits(ws, { refresh: true });
    expect(report.repos[0]?.state).toBe('ok');
    expect(report.repos[0]?.behind).toBe(1);
    expect(report.repos[1]?.state).toBe('ok');
    expect(report.repos[1]?.behind).toBe(1);

    const afterRefs = await git(repo, 'for-each-ref');
    const parseRefs = (raw: string) =>
      raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, type, ref] = line.split(/\s+/);
          return { sha, type, ref };
        });

    const beforeMap = new Map(parseRefs(beforeRefs).map((r) => [r.ref, r.sha]));
    const afterMap = new Map(parseRefs(afterRefs).map((r) => [r.ref, r.sha]));

    const targetRef = `refs/remotes/origin/${branch}`;
    expect(afterMap.get(targetRef)).toBe(mariaSha);
    // Every other ref (including main, tags, other-local) is untouched.
    for (const [ref, sha] of beforeMap) {
      if (ref !== targetRef) expect(afterMap.get(ref)).toBe(sha);
    }
    for (const ref of afterMap.keys()) {
      if (ref !== targetRef) expect(beforeMap.has(ref)).toBe(true);
    }

    const afterAliasMap = new Map(parseRefs(await git(aliasRepo, 'for-each-ref')).map((r) => [r.ref, r.sha]));
    const beforeAliasMap = new Map(parseRefs(beforeAliasRefs).map((r) => [r.ref, r.sha]));
    expect(afterAliasMap.get(targetRef)).toBe(mariaSha);
    expect(afterAliasMap.get(`refs/heads/${branch}`)).toBe(localBranchBefore);
    for (const [ref, sha] of beforeAliasMap) {
      if (ref !== targetRef) expect(afterAliasMap.get(ref)).toBe(sha);
    }

    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(beforeHead);
    expect(await git(repo, 'symbolic-ref', 'HEAD')).toBe(beforeHeadSym);
    expect(await git(repo, 'ls-files', '--stage')).toBe(beforeIndexStage);
    expect(await sha256(path.join(repo, '.git', 'index'))).toBe(beforeIndexHash);
    expect(await git(repo, 'status', '--porcelain=v1', '-uall')).toBe(beforeStatus);
    expect(await sha256(fetchHeadPath)).toBe(beforeFetchHeadHash);
    expect(await git(repo, 'config', '--list', '--local')).toBe(beforeConfig);
    expect(bare).toBeTruthy();
  });

  it('never leaves FETCH_HEAD behind when it did not exist before fetch', async () => {
    const { ws, repo, maria } = await createWorkspaceWithBareRemote(root);
    const fetchHeadPath = path.join(repo, '.git', 'FETCH_HEAD');
    await fs.rm(fetchHeadPath, { force: true });
    await commitAsMaria(maria, 'Remote push', { 'x.txt': '1\n' });

    const res = await incomingCommits(ws, { refresh: true });
    expect(res.repos[0]?.behind).toBe(1);
    await expect(fs.access(fetchHeadPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns incoming commits newest first with recentCommits shape + incoming: true, and empties after pull or merge', async () => {
    const { ws, repo, maria } = await createWorkspaceWithBareRemote(root);

    const sha1 = await commitAsMaria(
      maria,
      'First remote change',
      { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' },
      { body: '\nFirst paragraph explaining why.\nSecond line.', date: '2026-11-14T10:00:00Z' },
    );
    const sha2 = await commitAsMaria(
      maria,
      'Second remote change',
      { 'c.ts': 'export const c = 3;\n' },
      { date: '2026-11-14T11:00:00Z' },
    );

    const before = await incomingCommits(ws, { refresh: true });
    expect(before.repos).toHaveLength(1);
    const r = before.repos[0]!;
    expect(r).toMatchObject({
      repo: 'api',
      remote: 'origin',
      branch: 'feat/incoming',
      host: { kind: 'unknown', name: 'local' },
      fetching: false,
      state: 'ok',
      message: null,
      behind: 2,
      more: 0,
    });
    expect(r.lastFetchAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.commits).toEqual([
      {
        sha: sha2.slice(0, 7),
        author: 'Maria',
        subject: 'Second remote change',
        at: '2026-11-14T11:00:00.000Z',
        fileCount: 1,
        incoming: true,
      },
      {
        sha: sha1.slice(0, 7),
        author: 'Maria',
        subject: 'First remote change',
        at: '2026-11-14T10:00:00.000Z',
        firstBodyLine: 'First paragraph explaining why.',
        fileCount: 2,
        incoming: true,
      },
    ]);

    // Remote-only commits can already be read by readCommit before pulling.
    const detail = await readCommit(ws, 'api', r.commits[0]!.sha);
    expect(detail.sha).toBe(sha2);
    expect(detail.author).toBe('Maria');

    // recentCommits and whatsNew remain local-only and unchanged.
    const recentBeforePull = await recentCommits(ws, { now: new Date('2026-11-14T12:00:00Z') });
    expect(recentBeforePull.commits[0]!.commits.map((c) => c.subject)).not.toContain('Second remote change');
    const newsBeforePull = await whatsNew(ws, 'user', { now: new Date('2026-11-14T12:00:00Z') });
    expect(newsBeforePull.commits[0]!.commits.map((c) => c.subject)).not.toContain('Second remote change');

    // When the AI pulls or merges, commits drop out of incoming immediately (even without another fetch).
    await git(repo, 'merge', '--ff-only', 'origin/feat/incoming');
    const afterPull = await incomingCommits(ws);
    expect(afterPull.repos[0]).toMatchObject({
      state: 'ok',
      behind: 0,
      commits: [],
      more: 0,
    });
  });

  it('caps incoming commits at 50 and reports behind + more when more than 50 commits are pushed', async () => {
    const { ws, maria } = await createWorkspaceWithBareRemote(root);
    for (let i = 1; i <= 53; i += 1) {
      await fs.writeFile(path.join(maria, 'seq.txt'), `${i}\n`);
      await git(maria, 'add', 'seq.txt');
      await git(maria, 'commit', '-m', `Commit ${i}`);
    }
    await git(maria, 'push', 'origin', 'HEAD');

    const res = await incomingCommits(ws, { refresh: true });
    expect(res.repos[0]?.behind).toBe(53);
    expect(res.repos[0]?.commits).toHaveLength(50);
    expect(res.repos[0]?.more).toBe(3);
    expect(res.repos[0]?.commits[0]?.subject).toBe('Commit 53');
  });

  it('discovers <remote>/<branch> when @{u} is not set and local remote-tracking ref does not exist yet', async () => {
    const { ws, repo, maria, branch } = await createWorkspaceWithBareRemote(root, { trackUpstream: false });
    await git(repo, 'update-ref', '-d', `refs/remotes/origin/${branch}`);
    await commitAsMaria(maria, 'Untracked branch commit', { 'u.ts': '1\n' });

    const res = await incomingCommits(ws, { refresh: true });
    expect(res.repos[0]?.state).toBe('ok');
    expect(res.repos[0]?.behind).toBe(1);
    expect(res.repos[0]?.commits[0]?.subject).toBe('Untracked branch commit');
  });

  it('sets webUrl and host name for Azure DevOps, GitHub, GitLab, Bitbucket, and omits webUrl for unknown hosts', async () => {
    const { ws, repo, maria, branch } = await createWorkspaceWithBareRemote(root);
    const sha = await commitAsMaria(maria, 'Forge URL commit', { 'f.ts': '1\n' });

    // Point remote config to Azure DevOps while fetching objects from local bare repo via insteadOf?
    // Even simpler: fetch first, then update remote URL on origin to test host + webUrl per forge!
    await incomingCommits(ws, { refresh: true });

    const cases: Array<{ url: string; host: { kind: string; name: string }; expectedWebUrl?: string }> = [
      {
        url: 'https://dev.azure.com/myorg/myproj/_git/myrepo',
        host: { kind: 'azure', name: 'Azure DevOps' },
        expectedWebUrl: `https://dev.azure.com/myorg/myproj/_git/myrepo/commit/${sha}`,
      },
      {
        url: 'https://org.visualstudio.com/proj/_git/repo',
        host: { kind: 'azure', name: 'Azure DevOps' },
        expectedWebUrl: `https://dev.azure.com/org/proj/_git/repo/commit/${sha}`,
      },
      {
        url: 'https://org.visualstudio.com/DefaultCollection/proj/_git/repo',
        host: { kind: 'azure', name: 'Azure DevOps' },
        expectedWebUrl: `https://dev.azure.com/org/proj/_git/repo/commit/${sha}`,
      },
      {
        url: 'git@ssh.dev.azure.com:v3/myorg/myproj/myrepo',
        host: { kind: 'azure', name: 'Azure DevOps' },
        expectedWebUrl: `https://dev.azure.com/myorg/myproj/_git/myrepo/commit/${sha}`,
      },
      {
        url: 'https://github.com/org/repo.git',
        host: { kind: 'github', name: 'GitHub' },
        expectedWebUrl: `https://github.com/org/repo/commit/${sha}`,
      },
      {
        url: 'https://gitlab.com/group/sub/repo.git',
        host: { kind: 'gitlab', name: 'GitLab' },
        expectedWebUrl: `https://gitlab.com/group/sub/repo/-/commit/${sha}`,
      },
      {
        url: 'git@bitbucket.org:team/repo.git',
        host: { kind: 'bitbucket', name: 'Bitbucket' },
        expectedWebUrl: `https://bitbucket.org/team/repo/commits/${sha}`,
      },
      {
        url: 'https://git.internal.corp/team/repo.git',
        host: { kind: 'unknown', name: 'git.internal.corp' },
      },
    ];

    for (const entry of cases) {
      await git(repo, 'remote', 'set-url', 'origin', entry.url);
      await git(repo, 'config', `url.${path.join(root, 'api-remote.git')}.insteadOf`, entry.url);
      const res = await incomingCommits(ws, { refresh: true });
      await git(repo, 'config', '--unset', `url.${path.join(root, 'api-remote.git')}.insteadOf`);
      const repoRes = res.repos[0]!;
      expect(repoRes.remote).toBe('origin');
      expect(repoRes.branch).toBe(branch);
      expect(repoRes.host).toEqual(entry.host);
      expect(repoRes.commits[0]?.webUrl).toBe(entry.expectedWebUrl);
    }
  });

  it('never prompts or hangs: fails fast with sign-in for a blocking credential helper and an interactive SSH command (preserving core.sshCommand)', async () => {
    const { ws, repo } = await createWorkspaceWithBareRemote(root);

    // 1. Local HTTP 401 server + credential helper + askpass scripts that would record/block if prompt suppression failed
    const server = http.createServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Basic realm="Git"');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const askpassLog = path.join(root, 'askpass-called.log');
    const askpassScript = path.join(root, 'recording-askpass.sh');
    await fs.writeFile(
      askpassScript,
      `#!/bin/sh
printf 'called:%s\n' "$*" >> "${askpassLog}"
exit 1
`,
      { mode: 0o755 },
    );
    await git(repo, 'config', 'core.askPass', askpassScript);
    process.env.GIT_ASKPASS = askpassScript;
    process.env.SSH_ASKPASS = askpassScript;
    process.env.DISPLAY = ':0';

    const blockingHelper = path.join(root, 'blocking-helper.sh');
    await fs.writeFile(
      blockingHelper,
      `#!/bin/sh
if [ "$GIT_TERMINAL_PROMPT" != "0" ] || [ "$GCM_INTERACTIVE" != "never" ]; then
  sleep 30
fi
exit 1
`,
      { mode: 0o755 },
    );
    await git(repo, 'remote', 'set-url', 'origin', `http://127.0.0.1:${port}/org/repo.git`);
    await git(repo, 'config', 'credential.helper', blockingHelper);

    const startHttp = Date.now();
    const httpRes = await incomingCommits(ws, { refresh: true });
    expect(Date.now() - startHttp).toBeLessThan(3_000);
    expect(httpRes.repos[0]?.state).toBe('sign-in');
    expect(httpRes.repos[0]?.message).toContain('Sign in');
    await expect(fs.access(askpassLog)).rejects.toMatchObject({ code: 'ENOENT' });

    // 1b. Simulate Git < 2.46 where `-c credential.interactive=never` is not available/stripped:
    // GIT_ASKPASS='' must still block GIT_ASKPASS, core.askPass, and SSH_ASKPASS.
    const realGit = (await execa('which', ['git'])).stdout.trim();
    const fakeBin = path.join(root, 'fake-old-git-bin');
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.writeFile(
      path.join(fakeBin, 'git'),
      `#!/bin/sh
n=$#
i=1
skip_next=0
while [ "$i" -le "$n" ]; do
  arg=$1
  shift
  if [ "$skip_next" -eq 1 ]; then
    skip_next=0
    i=$((i + 1))
    continue
  fi
  if [ "$arg" = "-c" ] && [ "$#" -ge 1 ] && [ "$1" = "credential.interactive=never" ]; then
    skip_next=1
    i=$((i + 1))
    continue
  fi
  set -- "$@" "$arg"
  i=$((i + 1))
done
exec "${realGit}" "$@"
`,
      { mode: 0o755 },
    );
    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeBin}:${origPath}`;
    try {
      const fakeOldWithEnv = await incomingCommits(ws, { refresh: true, now: () => Date.now() + 60_000 });
      expect(fakeOldWithEnv.repos[0]?.state).toBe('sign-in');
      await expect(fs.access(askpassLog)).rejects.toMatchObject({ code: 'ENOENT' });

      delete process.env.GIT_ASKPASS;
      const fakeOldWithoutEnv = await incomingCommits(ws, { refresh: true, now: () => Date.now() + 120_000 });
      expect(fakeOldWithoutEnv.repos[0]?.state).toBe('sign-in');
      await expect(fs.access(askpassLog)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      process.env.PATH = origPath;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // 2. SSH command configured via user's core.sshCommand that would hang unless -o BatchMode=yes is passed
    const sshMarker = path.join(root, 'ssh-invoked.txt');
    const sshScript = path.join(root, 'custom-ssh.sh');
    await fs.writeFile(
      sshScript,
      `#!/bin/sh
printf '%s\n' "$*" > "${sshMarker}"
case "$*" in
  *BatchMode=yes*)
    echo "git@git.example.invalid: Permission denied (publickey)." >&2
    exit 255
    ;;
  *)
    sleep 30
    exit 1
    ;;
esac
`,
      { mode: 0o755 },
    );
    await git(repo, 'remote', 'set-url', 'origin', 'git@git.example.invalid:org/repo.git');
    await git(repo, 'config', 'core.sshCommand', sshScript);

    const startSsh = Date.now();
    const sshRes = await incomingCommits(ws, { refresh: true, now: () => Date.now() + 180_000 });
    expect(Date.now() - startSsh).toBeLessThan(3_000);
    expect(sshRes.repos[0]?.state).toBe('sign-in');
    expect(sshRes.repos[0]?.message).toBe('Sign in to git.example.invalid to see new commits');
    const invokedArgs = await fs.readFile(sshMarker, 'utf8');
    expect(invokedArgs).toContain('-o BatchMode=yes');
    await expect(fs.access(askpassLog)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kills a stalled fetch process on timeout and marks offline without hanging', async () => {
    const { ws, repo } = await createWorkspaceWithBareRemote(root);
    const stalledSsh = path.join(root, 'stalled-ssh.sh');
    await fs.writeFile(stalledSsh, '#!/bin/sh\nsleep 15 &\nwait\n', { mode: 0o755 });
    await git(repo, 'remote', 'set-url', 'origin', 'git@git.example.invalid:org/repo.git');
    await git(repo, 'config', 'core.sshCommand', stalledSsh);

    const start = Date.now();
    const res = await incomingCommits(ws, { refresh: true, fetchTimeoutMs: 250 });
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(res.repos[0]?.state).toBe('offline');
    expect(res.repos[0]?.message).toBe('Offline — could not reach git.example.invalid');
  });

  it('enforces a hard deadline after kill when a descendant keeps pipes open and ignores SIGTERM, clearing inFlight', async () => {
    const { ws, bare, repo, maria } = await createWorkspaceWithBareRemote(root);
    const childPidFile = path.join(root, 'setsid-child.pid');
    const openPipeSsh = path.join(root, 'open-pipe-ssh.sh');
    await fs.writeFile(
      openPipeSsh,
      `#!/bin/sh
case " $* " in
  *" -G "*) exit 1 ;;
esac
setsid sh -c 'echo $$ > "${childPidFile}"; trap "" TERM; exec sleep 8' </dev/null &
wait
`,
      { mode: 0o755 },
    );
    await git(repo, 'remote', 'set-url', 'origin', 'git@git.example.invalid:org/repo.git');
    await git(repo, 'config', 'core.sshCommand', openPipeSsh);

    try {
      const start = Date.now();
      const [r1, r2] = await Promise.all([
        incomingCommits(ws, { refresh: true, fetchTimeoutMs: 150 }),
        incomingCommits(ws, { refresh: true, fetchTimeoutMs: 150 }),
      ]);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5_000);
      expect(r1.repos[0]?.state).toBe('offline');
      expect(r1.repos[0]?.fetching).toBe(false);
      expect(r1.repos[0]?.message).toBe('Offline — could not reach git.example.invalid');
      expect(r2.repos[0]?.state).toBe('offline');
      expect(r2.repos[0]?.fetching).toBe(false);

      // inFlight must be cleared so a subsequent refresh recovers normally.
      await git(repo, 'config', '--unset', 'core.sshCommand');
      await git(repo, 'remote', 'set-url', 'origin', bare);
      const sha = await commitAsMaria(maria, 'After deadline recovery', { 'recovered.ts': '1\n' });
      const recovered = await incomingCommits(ws, { refresh: true, now: () => Date.now() + 60_000 });
      expect(recovered.repos[0]?.state).toBe('ok');
      expect(recovered.repos[0]?.behind).toBe(1);
      expect(recovered.repos[0]?.commits[0]?.sha).toBe(sha.slice(0, 7));
    } finally {
      try {
        const pidStr = (await fs.readFile(childPidFile, 'utf8')).trim();
        const pid = Number(pidStr);
        if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
      } catch {
        // child already exited
      }
    }
  });

  it('reports busy and skips fetching when index.lock, HEAD.lock, or tracking ref lock exists (in normal repo and worktree)', async () => {
    // 1. Normal repo
    const normal = await createWorkspaceWithBareRemote(root, { repoName: 'norm' });
    await commitAsMaria(normal.maria, 'While locked', { 'lock.txt': '1\n' });
    const indexLock = path.join(normal.repo, '.git', 'index.lock');
    await fs.writeFile(indexLock, '');

    const busyRes = await incomingCommits(normal.ws, { refresh: true });
    expect(busyRes.repos[0]?.state).toBe('busy');
    expect(busyRes.repos[0]?.fetching).toBe(false);
    expect(busyRes.repos[0]?.behind).toBe(0);

    await fs.rm(indexLock);
    const afterUnlock = await incomingCommits(normal.ws, { refresh: true });
    expect(afterUnlock.repos[0]?.state).toBe('ok');
    expect(afterUnlock.repos[0]?.behind).toBe(1);

    // 2. Linked worktree (`git worktree add`): locks live in worktree gitDir & shared commonDir
    const wtRoot = path.join(root, 'wt-case');
    await fs.mkdir(wtRoot);
    const wt = await createWorkspaceWithBareRemote(wtRoot, { repoName: 'wt', useWorktree: true });
    await commitAsMaria(wt.maria, 'Worktree push', { 'wt.txt': '1\n' });

    const gitDir = path.resolve(wt.repo, (await git(wt.repo, 'rev-parse', '--git-dir')).trim());
    const commonDir = path.resolve(wt.repo, (await git(wt.repo, 'rev-parse', '--git-common-dir')).trim());
    expect(gitDir).not.toBe(commonDir);

    const wtIndexLock = path.join(gitDir, 'index.lock');
    await fs.writeFile(wtIndexLock, '');
    expect((await incomingCommits(wt.ws, { refresh: true })).repos[0]?.state).toBe('busy');
    await fs.rm(wtIndexLock);

    const wtHeadLock = path.join(gitDir, 'HEAD.lock');
    await fs.writeFile(wtHeadLock, '');
    expect((await incomingCommits(wt.ws, { refresh: true })).repos[0]?.state).toBe('busy');
    await fs.rm(wtHeadLock);

    const wtRefLock = path.join(commonDir, 'refs', 'remotes', 'origin', ...wt.branch.split('/')) + '.lock';
    await fs.mkdir(path.dirname(wtRefLock), { recursive: true });
    await fs.writeFile(wtRefLock, '');
    expect((await incomingCommits(wt.ws, { refresh: true })).repos[0]?.state).toBe('busy');
    await fs.rm(wtRefLock);

    const wtOk = await incomingCommits(wt.ws, { refresh: true });
    expect(wtOk.repos[0]?.state).toBe('ok');
    expect(wtOk.repos[0]?.behind).toBe(1);
    expect(wtOk.repos[0]?.commits[0]?.subject).toBe('Worktree push');
  });

  it('uses single-flight so concurrent reads start only one fetch', async () => {
    const { ws, repo, bare, maria } = await createWorkspaceWithBareRemote(root);
    await commitAsMaria(maria, 'Concurrent push', { 'c.txt': '1\n' });

    const countFile = path.join(root, 'fetch-count.txt');
    const wrapper = path.join(root, 'upload-pack-counter.sh');
    await fs.writeFile(
      wrapper,
      `#!/bin/sh
printf '1\n' >> "${countFile}"
sleep 0.15
exec git-upload-pack "$@"
`,
      { mode: 0o755 },
    );
    await git(repo, 'config', 'remote.origin.uploadpack', wrapper);
    expect(bare).toBeTruthy();

    const [first, second] = await Promise.all([
      incomingCommits(ws),
      incomingCommits(ws),
    ]);
    expect(first.repos[0]?.fetching).toBe(true);
    expect(second.repos[0]?.fetching).toBe(true);

    await waitForIncomingFetches();
    const lines = (await fs.readFile(countFile, 'utf8')).trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    // Concurrent refresh=1 calls also share a single flight
    resetIncomingCommitsState();
    await fs.rm(countFile);
    await commitAsMaria(maria, 'Concurrent refresh push', { 'c2.txt': '2\n' });
    const [r1, r2] = await Promise.all([
      incomingCommits(ws, { refresh: true }),
      incomingCommits(ws, { refresh: true }),
    ]);
    expect(r1.repos[0]?.behind).toBe(2);
    expect(r2.repos[0]?.behind).toBe(2);
    const refreshLines = (await fs.readFile(countFile, 'utf8')).trim().split('\n').filter(Boolean);
    expect(refreshLines).toHaveLength(1);
  });

  it('enforces the 5-minute stale rule and 30-second refresh throttle using an injectable clock', async () => {
    const { ws, repo, maria } = await createWorkspaceWithBareRemote(root);
    const countFile = path.join(root, 'clock-fetch-count.txt');
    const wrapper = path.join(root, 'upload-pack-clock.sh');
    await fs.writeFile(
      wrapper,
      `#!/bin/sh
printf '1\n' >> "${countFile}"
exec git-upload-pack "$@"
`,
      { mode: 0o755 },
    );
    await git(repo, 'config', 'remote.origin.uploadpack', wrapper);

    let fakeNow = Date.parse('2026-11-14T10:00:00.000Z');
    const now = () => fakeNow;
    const countFetches = async () =>
      (await fs.readFile(countFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;

    // Nothing fetches before anyone reads.
    expect(await countFetches()).toBe(0);

    // First normal read starts background fetch immediately.
    const first = await incomingCommits(ws, { now });
    expect(first.repos[0]?.fetching).toBe(true);
    await waitForIncomingFetches();
    expect(await countFetches()).toBe(1);

    // Push a commit, advance 4m59s: normal read must NOT fetch.
    await commitAsMaria(maria, 'At 4m59s', { 't1.txt': '1\n' });
    fakeNow += 4 * 60_000 + 59_000;
    const at4m59 = await incomingCommits(ws, { now });
    expect(at4m59.repos[0]?.fetching).toBe(false);
    expect(at4m59.repos[0]?.behind).toBe(0);
    await waitForIncomingFetches();
    expect(await countFetches()).toBe(1);

    // Advance 1s more (total 5m00s): normal read starts background fetch.
    fakeNow += 1_000;
    const at5m00 = await incomingCommits(ws, { now });
    expect(at5m00.repos[0]?.fetching).toBe(true);
    await waitForIncomingFetches();
    expect(await countFetches()).toBe(2);
    const after5m00 = await incomingCommits(ws, { now });
    expect(after5m00.repos[0]?.behind).toBe(1);

    // Advance 20s and ask for ?refresh=1: throttled (< 30s).
    await commitAsMaria(maria, 'At +20s', { 't2.txt': '2\n' });
    fakeNow += 20_000;
    const throttled = await incomingCommits(ws, { refresh: true, now });
    expect(throttled.repos[0]?.behind).toBe(1);
    expect(await countFetches()).toBe(2);

    // Advance 10s more (total 30s): ?refresh=1 fetches immediately.
    fakeNow += 10_000;
    const refreshed = await incomingCommits(ws, { refresh: true, now });
    expect(refreshed.repos[0]?.behind).toBe(2);
    expect(await countFetches()).toBe(3);
  });

  it('reports no-remote, no-upstream, and offline cleanly without throwing', async () => {
    const ws = path.join(root, 'states-ws');
    await fs.mkdir(ws);

    const noRemoteRepo = path.join(ws, 'local-only');
    await fs.mkdir(noRemoteRepo);
    await execa('git', ['init', '-b', 'main', noRemoteRepo]);
    await git(noRemoteRepo, 'config', 'user.name', 'Dev');
    await git(noRemoteRepo, 'config', 'user.email', 'dev@example.com');
    await git(noRemoteRepo, 'commit', '--allow-empty', '-m', 'init');

    const base = await createWorkspaceWithBareRemote(path.join(root, 'sub'), { repoName: 'sub' });
    const noUpstreamRepo = path.join(ws, 'unpushed');
    await execa('git', ['clone', base.bare, noUpstreamRepo]);
    await git(noUpstreamRepo, 'checkout', '-b', 'brand-new-local-branch');

    const offlineRepo = path.join(ws, 'offline');
    await execa('git', ['clone', base.bare, offlineRepo]);
    const closedPort = await getClosedLocalhostPort();
    await git(offlineRepo, 'remote', 'set-url', 'origin', `http://127.0.0.1:${closedPort}/org/repo.git`);

    await fs.writeFile(
      path.join(ws, 'contextspace.json'),
      JSON.stringify({
        id: 'states',
        name: 'States',
        branchName: 'main',
        repos: [noRemoteRepo, noUpstreamRepo, offlineRepo],
        assistants: [],
        workspacePath: ws,
      }),
    );

    const res = await incomingCommits(ws, { refresh: true });
    expect(res.repos.map((r) => [r.repo, r.state])).toEqual([
      ['local-only', 'no-remote'],
      ['unpushed', 'no-upstream'],
      ['offline', 'offline'],
    ]);
    expect(res.repos[2]?.message).toBe(`Offline — could not reach 127.0.0.1`);
  });

  it('shows rewritten commits after a remote force-push', async () => {
    const { ws, maria } = await createWorkspaceWithBareRemote(root);
    await commitAsMaria(maria, 'Old pushed commit', { 'f.txt': 'v1\n' });
    expect((await incomingCommits(ws, { refresh: true })).repos[0]?.commits.map((c) => c.subject)).toEqual([
      'Old pushed commit',
    ]);

    await git(maria, 'reset', '--hard', 'HEAD~1');
    await fs.writeFile(path.join(maria, 'f.txt'), 'v2\n');
    await git(maria, 'add', 'f.txt');
    await git(maria, 'commit', '-m', 'Rewritten commit');
    await git(maria, 'push', '--force', 'origin', 'HEAD');

    // Reset state or advance clock 30s to refresh
    const afterForce = await incomingCommits(ws, {
      refresh: true,
      now: () => Date.now() + 31_000,
    });
    expect(afterForce.repos[0]?.behind).toBe(1);
    expect(afterForce.repos[0]?.commits.map((c) => c.subject)).toEqual(['Rewritten commit']);
  });

  it('appends -o BatchMode=yes to an existing GIT_SSH_COMMAND in env without overriding flags', async () => {
    expect(withBatchModeSsh('')).toBe('ssh -o BatchMode=yes');
    expect(withBatchModeSsh('ssh -i ~/.ssh/work')).toBe('ssh -i ~/.ssh/work -o BatchMode=yes');
    expect(withBatchModeSsh('ssh -o BatchMode=no -i ~/.ssh/work')).toBe('ssh -o BatchMode=yes -i ~/.ssh/work');
    expect(withBatchModeSsh('ssh -o BatchMode=yes')).toBe('ssh -o BatchMode=yes');

    const { ws, repo } = await createWorkspaceWithBareRemote(root);
    const marker = path.join(root, 'env-ssh-args.txt');
    const envSsh = path.join(root, 'env-ssh.sh');
    await fs.writeFile(
      envSsh,
      `#!/bin/sh
printf '%s\n' "$*" > "${marker}"
echo "git@gitlab.example.invalid: Permission denied (publickey)." >&2
exit 255
`,
      { mode: 0o755 },
    );
    await git(repo, 'remote', 'set-url', 'origin', 'git@gitlab.example.invalid:group/repo.git');

    const prevEnv = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = `${envSsh} -p 2222`;
    try {
      const res = await incomingCommits(ws, { refresh: true });
      expect(res.repos[0]?.state).toBe('sign-in');
      expect(res.repos[0]?.message).toBe('Sign in to gitlab.example.invalid to see new commits');
      const args = await fs.readFile(marker, 'utf8');
      expect(args).toContain('-p 2222');
      expect(args).toContain('-o BatchMode=yes');
    } finally {
      if (prevEnv === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = prevEnv;
    }
  });

  it('handles detached HEAD, missing file:// remote, diverged local commits, empty/merge commits, and multi-repo isolation', async () => {
    const base = await createWorkspaceWithBareRemote(root, { repoName: 'api' });
    const ws = base.ws;

    // Local unpushed commit in workspace repo (diverged from remote) + Maria pushes an empty commit and a merge commit
    await fs.writeFile(path.join(base.repo, 'local-only.txt'), 'mine\n');
    await git(base.repo, 'add', 'local-only.txt');
    await git(base.repo, 'commit', '-m', 'Local unpushed commit');

    const atTime = (iso: string) => ({
      ...process.env,
      GIT_AUTHOR_NAME: 'Maria',
      GIT_AUTHOR_EMAIL: 'maria@example.com',
      GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_NAME: 'Maria',
      GIT_COMMITTER_EMAIL: 'maria@example.com',
      GIT_COMMITTER_DATE: iso,
    });
    await execa('git', ['commit', '--allow-empty', '-m', 'Empty remote commit'], { cwd: base.maria, env: atTime('2026-11-14T10:00:00Z') });
    await git(base.maria, 'checkout', '-b', 'side');
    await fs.writeFile(path.join(base.maria, 'side.txt'), 'side\n');
    await git(base.maria, 'add', 'side.txt');
    await execa('git', ['commit', '-m', 'Side work'], { cwd: base.maria, env: atTime('2026-11-14T10:01:00Z') });
    await git(base.maria, 'checkout', base.branch);
    await execa('git', ['merge', '--no-ff', '-m', 'Merge side into feature', 'side'], { cwd: base.maria, env: atTime('2026-11-14T10:02:00Z') });
    await git(base.maria, 'push', 'origin', 'HEAD');

    // Detached HEAD repo
    const detachedRepo = path.join(ws, 'detached');
    await execa('git', ['clone', base.bare, detachedRepo]);
    await git(detachedRepo, 'checkout', '--detach', 'HEAD');

    // Missing file:// remote repo
    const missingFileRepo = path.join(ws, 'missing-file');
    await execa('git', ['clone', base.bare, missingFileRepo]);
    await git(missingFileRepo, 'remote', 'set-url', 'origin', `file://${path.join(root, 'gone.git')}`);

    // Explicitly tracked upstream with a different remote branch name
    const trackedOtherRepo = path.join(ws, 'tracked-other');
    await execa('git', ['clone', '-b', 'main', base.bare, trackedOtherRepo]);
    await git(trackedOtherRepo, 'checkout', '-b', 'local-alias');
    await git(trackedOtherRepo, 'branch', `--set-upstream-to=origin/${base.branch}`);

    await fs.writeFile(
      path.join(ws, 'contextspace.json'),
      JSON.stringify({
        id: 'multi-ws',
        name: 'Multi',
        branchName: base.branch,
        repos: [base.repo, detachedRepo, missingFileRepo, trackedOtherRepo],
        assistants: [],
        workspacePath: ws,
      }),
    );

    const res = await incomingCommits(ws, { refresh: true });
    expect(res.repos.map((r) => [r.repo, r.state])).toEqual([
      ['api', 'ok'],
      ['detached', 'no-upstream'],
      ['missing-file', 'offline'],
      ['tracked-other', 'ok'],
    ]);

    // Local unpushed commit is NOT in incoming; Maria's 3 commits ARE in incoming (merge commit omits fileCount, empty commit has fileCount 0)
    const apiCommits = res.repos[0]!.commits;
    expect(apiCommits.map((c) => c.subject)).toEqual([
      'Merge side into feature',
      'Side work',
      'Empty remote commit',
    ]);
    expect(apiCommits[0]).not.toHaveProperty('fileCount');
    expect(apiCommits[1]?.fileCount).toBe(1);
    expect(apiCommits[2]?.fileCount).toBe(0);

    // tracked-other fetched origin/<base.branch> (the configured @{u}) even though local branch is named local-alias
    expect(res.repos[3]!.behind).toBeGreaterThanOrEqual(3);
  });

  it('only ever fetches a branch: rejects non-branch or wildcard branch.<name>.merge values as no-upstream without fetching', async () => {
    const { ws, repo, maria, branch } = await createWorkspaceWithBareRemote(root);
    await commitAsMaria(maria, 'Ignored while invalid merge', { 'm.txt': '1\n' });
    await git(maria, 'tag', 'v1');
    await git(maria, 'push', 'origin', 'v1');

    const countFile = path.join(root, 'invalid-merge-fetch-count.txt');
    const wrapper = path.join(root, 'invalid-merge-upload-pack.sh');
    await fs.writeFile(
      wrapper,
      `#!/bin/sh
printf '1\\n' >> "${countFile}"
exec git-upload-pack "$@"
`,
      { mode: 0o755 },
    );
    await git(repo, 'config', 'remote.origin.uploadpack', wrapper);

    for (const badMerge of ['refs/tags/v1', 'refs/heads/*', 'refs/heads/a:refs/heads/b']) {
      await git(repo, 'config', `branch.${branch}.merge`, badMerge);
      const res = await incomingCommits(ws, { refresh: true });
      expect(res.repos[0]?.state, badMerge).toBe('no-upstream');
      expect(res.repos[0]?.fetching, badMerge).toBe(false);
      expect(res.repos[0]?.message, badMerge).toBeTruthy();
      expect(res.repos[0]?.behind, badMerge).toBe(0);
    }

    await expect(fs.access(countFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const refs = await git(repo, 'for-each-ref', '--format=%(refname)');
    expect(refs).not.toContain('refs/remotes/origin/refs/tags/v1');
  });

  it('passes --no-auto-maintenance so our fetch never starts git maintenance run', async () => {
    const { ws, repo, maria } = await createWorkspaceWithBareRemote(root);
    await git(repo, 'config', 'maintenance.auto', 'true');
    await commitAsMaria(maria, 'Maintenance check commit', { 'maint.txt': '1\n' });

    const traceFile = path.join(root, 'git-trace.log');
    const prevTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = traceFile;
    try {
      const res = await incomingCommits(ws, { refresh: true });
      expect(res.repos[0]?.state).toBe('ok');
      expect(res.repos[0]?.behind).toBe(1);
    } finally {
      if (prevTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = prevTrace;
    }

    const trace = await fs.readFile(traceFile, 'utf8');
    expect(trace).toContain('--no-auto-maintenance');
    expect(trace).not.toMatch(/maintenance\s+run/);
  });

  it('treats a lock lost during fetch as busy (not error) and retries after 30s instead of 5m', async () => {
    const { ws, repo, maria, branch } = await createWorkspaceWithBareRemote(root);
    await commitAsMaria(maria, 'Commit during lock race', { 'race.txt': '1\n' });

    const trackingLock = path.join(repo, '.git', 'refs', 'remotes', 'origin', ...branch.split('/')) + '.lock';
    const racedMarker = path.join(root, 'raced-once');
    const wrapper = path.join(root, 'race-lock-upload-pack.sh');
    await fs.writeFile(
      wrapper,
      `#!/bin/sh
if [ ! -f "${racedMarker}" ]; then
  mkdir -p "$(dirname "${trackingLock}")"
  : > "${trackingLock}"
  : > "${racedMarker}"
fi
exec git-upload-pack "$@"
`,
      { mode: 0o755 },
    );
    await git(repo, 'config', 'remote.origin.uploadpack', wrapper);

    let fakeNow = Date.parse('2026-11-14T11:00:00.000Z');
    const now = () => fakeNow;

    const first = await incomingCommits(ws, { refresh: true, now });
    expect(first.repos[0]?.state).toBe('busy');
    expect(first.repos[0]?.lastFetchAt).toBeNull();

    // Another Git process finished and removed the lock right after winning the race.
    await fs.rm(trackingLock, { force: true });

    // Within 30s, normal read does not hammer Git.
    fakeNow += 15_000;
    const tooSoon = await incomingCommits(ws, { now });
    expect(tooSoon.repos[0]?.state).toBe('busy');
    expect(tooSoon.repos[0]?.fetching).toBe(false);

    // At 30s (well before the 5-minute failure cooldown), normal read tries again and succeeds.
    fakeNow += 15_000;
    const retry = await incomingCommits(ws, { now });
    expect(retry.repos[0]?.fetching).toBe(true);
    await waitForIncomingFetches();

    const after = await incomingCommits(ws, { now });
    expect(after.repos[0]?.state).toBe('ok');
    expect(after.repos[0]?.behind).toBe(1);
    expect(after.repos[0]?.commits[0]?.subject).toBe('Commit during lock race');

    // Also when a fetch fails with a lock-lost stderr and no lock file stays behind, state is busy (not error).
    resetIncomingCommitsState();
    const lockStderrScript = path.join(root, 'lock-stderr-ssh.sh');
    await fs.writeFile(
      lockStderrScript,
      `#!/bin/sh
echo "fatal: Unable to create '/tmp/fake/.git/packed-refs.lock': File exists." >&2
exit 128
`,
      { mode: 0o755 },
    );
    await git(repo, 'remote', 'set-url', 'origin', 'git@git.example.invalid:org/repo.git');
    await git(repo, 'config', 'core.sshCommand', lockStderrScript);
    const lockMsgRes = await incomingCommits(ws, { refresh: true, now });
    expect(lockMsgRes.repos[0]?.state).toBe('busy');
  });

  it('runs at most one fetch at a time per shared repository across linked worktrees', async () => {
    const bare = path.join(root, 'shared-remote.git');
    const seed = path.join(root, 'shared-seed');
    const base = path.join(root, 'shared-base');
    const maria = path.join(root, 'shared-maria');
    await execa('git', ['init', '--bare', '-b', 'main', bare]);
    await execa('git', ['clone', bare, seed]);
    await git(seed, 'config', 'user.name', 'Seed');
    await git(seed, 'config', 'user.email', 'seed@example.com');
    await fs.writeFile(path.join(seed, 'README.md'), '# Shared\n');
    await git(seed, 'add', 'README.md');
    await git(seed, 'commit', '-m', 'Init');
    await git(seed, 'push', '-u', 'origin', 'main');
    for (const br of ['feat/one', 'feat/two']) {
      await git(seed, 'checkout', '-b', br, 'main');
      await fs.writeFile(path.join(seed, `${br.replace('/', '-')}.txt`), `${br}\n`);
      await git(seed, 'add', '.');
      await git(seed, 'commit', '-m', `Start ${br}`);
      await git(seed, 'push', '-u', 'origin', br);
    }

    await execa('git', ['clone', bare, base]);
    await execa('git', ['clone', '-b', 'main', bare, maria]);
    await git(maria, 'config', 'user.name', 'Maria');
    await git(maria, 'config', 'user.email', 'maria@example.com');

    const makeWorktreeWorkspace = async (name: string, branch: string, remoteTarget = branch) => {
      const ws = path.join(root, `ws-${name}`);
      const wt = path.join(ws, 'app');
      await fs.mkdir(ws, { recursive: true });
      await git(base, 'worktree', 'add', '--track', '-b', branch, wt, `origin/${remoteTarget}`);
      await fs.writeFile(
        path.join(ws, 'contextspace.json'),
        JSON.stringify({ id: name, name, branchName: branch, repos: [wt], assistants: [], workspacePath: ws }),
      );
      return { ws, wt };
    };

    const ws1 = await makeWorktreeWorkspace('one', 'feat/one');
    const ws2 = await makeWorktreeWorkspace('two', 'feat/two');
    const wsMain1 = await makeWorktreeWorkspace('main1', 'alias-one', 'main');
    const wsMain2 = await makeWorktreeWorkspace('main2', 'alias-two', 'main');

    await git(maria, 'checkout', 'feat/one');
    await commitAsMaria(maria, 'Push to one', { 'p1.txt': '1\n' });
    await git(maria, 'checkout', 'feat/two');
    await commitAsMaria(maria, 'Push to two', { 'p2.txt': '2\n' });

    const activeDir = path.join(root, 'active-upload-pack');
    const collisionFile = path.join(root, 'concurrent-fetch.txt');
    const countFile = path.join(root, 'shared-fetch-count.txt');
    const wrapper = path.join(root, 'shared-upload-pack.sh');
    await fs.writeFile(
      wrapper,
      `#!/bin/sh
if ! mkdir "${activeDir}" 2>/dev/null; then
  printf 'CONCURRENT\\n' >> "${collisionFile}"
fi
printf '1\\n' >> "${countFile}"
sleep 0.15
rmdir "${activeDir}" 2>/dev/null || true
exec git-upload-pack "$@"
`,
      { mode: 0o755 },
    );
    await git(base, 'config', 'remote.origin.uploadpack', wrapper);

    // 1. Two worktrees on different branches sharing commonDir must never fetch into .git at once.
    const [r1, r2] = await Promise.all([
      incomingCommits(ws1.ws, { refresh: true }),
      incomingCommits(ws2.ws, { refresh: true }),
    ]);
    expect(r1.repos[0]?.state).toBe('ok');
    expect(r1.repos[0]?.behind).toBe(1);
    expect(r2.repos[0]?.state).toBe('ok');
    expect(r2.repos[0]?.behind).toBe(1);
    await expect(fs.access(collisionFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readFile(countFile, 'utf8')).trim().split('\n').filter(Boolean)).toHaveLength(2);

    // 2. Two worktrees sharing commonDir AND trackingRef share one single-flight fetch.
    await fs.rm(countFile, { force: true });
    await git(maria, 'checkout', 'main');
    await commitAsMaria(maria, 'Push to shared main', { 'pm.txt': 'm\n' });
    const [m1, m2] = await Promise.all([
      incomingCommits(wsMain1.ws, { refresh: true }),
      incomingCommits(wsMain2.ws, { refresh: true }),
    ]);
    expect(m1.repos[0]?.state).toBe('ok');
    expect(m1.repos[0]?.behind).toBe(1);
    expect(m2.repos[0]?.state).toBe('ok');
    expect(m2.repos[0]?.behind).toBe(1);
    await expect(fs.access(collisionFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readFile(countFile, 'utf8')).trim().split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('reports checking (not no-upstream) while the first fetch runs and no tracking ref exists yet', async () => {
    const { ws, bare, repo, maria, branch } = await createWorkspaceWithBareRemote(root, { trackUpstream: false });
    await git(repo, 'update-ref', '-d', `refs/remotes/origin/${branch}`);
    await commitAsMaria(maria, 'Waiting for first check', { 'check.txt': '1\n' });

    await git(repo, 'remote', 'set-url', 'origin', 'https://git.example.invalid/org/repo.git');
    await git(repo, 'config', `url.${bare}.insteadOf`, 'https://git.example.invalid/org/repo.git');

    const slowWrapper = path.join(root, 'slow-first-fetch.sh');
    await fs.writeFile(
      slowWrapper,
      `#!/bin/sh
sleep 0.2
exec git-upload-pack "$@"
`,
      { mode: 0o755 },
    );
    await git(repo, 'config', 'remote.origin.uploadpack', slowWrapper);

    const first = await incomingCommits(ws);
    expect(first.repos[0]?.fetching).toBe(true);
    expect(first.repos[0]?.state).toBe('checking');
    expect(first.repos[0]?.message).toBe('Checking git.example.invalid…');

    await waitForIncomingFetches();
    const after = await incomingCommits(ws);
    expect(after.repos[0]?.fetching).toBe(false);
    expect(after.repos[0]?.state).toBe('ok');
    expect(after.repos[0]?.behind).toBe(1);
  });

  it('redacts user:token@ in any message taken from stderr', async () => {
    const { ws, repo } = await createWorkspaceWithBareRemote(root);
    const secretScript = path.join(root, 'secret-stderr.sh');
    await fs.writeFile(
      secretScript,
      `#!/bin/sh
echo "fatal: unable to access 'https://alice:tok_verySecret99@git.internal.corp/team/repo.git/': server exploded" >&2
exit 128
`,
      { mode: 0o755 },
    );
    await git(repo, 'remote', 'set-url', 'origin', 'git@git.internal.corp:team/repo.git');
    await git(repo, 'config', 'core.sshCommand', secretScript);

    const errRes = await incomingCommits(ws, { refresh: true });
    expect(errRes.repos[0]?.state).toBe('error');
    expect(errRes.repos[0]?.message).not.toContain('alice');
    expect(errRes.repos[0]?.message).not.toContain('tok_verySecret99');
    expect(errRes.repos[0]?.message).toContain('git.internal.corp');
  });

  it('resolves relative local and file:// remote paths against the repository', async () => {
    const { ws, repo } = await createWorkspaceWithBareRemote(root);
    // Relative path `./src` exists in process.cwd() (NexusFlow/src) but NOT inside this temp repo.
    await git(repo, 'remote', 'set-url', 'origin', './src');
    const relMissing = await incomingCommits(ws, { refresh: true });
    expect(relMissing.repos[0]?.state).toBe('offline');

    // Relative file:// URL pointing inside the temp repo also resolves against the repo as offline when missing.
    resetIncomingCommitsState();
    await git(repo, 'remote', 'set-url', 'origin', 'file://./missing-remote.git');
    const relFileUrl = await incomingCommits(ws, { refresh: true });
    expect(relFileUrl.repos[0]?.state).toBe('offline');
  });

  it('drops in-memory per-repository state unread for 24h', async () => {
    const { ws: wsTtlA, repo: repoTtlA } = await createWorkspaceWithBareRemote(path.join(root, 'ttl-a'), { repoName: 'ttl-a' });
    const { ws: wsTtlB, repo: repoTtlB } = await createWorkspaceWithBareRemote(path.join(root, 'ttl-b'), { repoName: 'ttl-b' });

    let fakeNow = Date.parse('2026-11-14T08:00:00.000Z');
    const now = () => fakeNow;

    const resA = await incomingCommits(wsTtlA, { refresh: true, now });
    expect(resA.repos[0]?.lastFetchAt).toBe('2026-11-14T08:00:00.000Z');
    const resB = await incomingCommits(wsTtlB, { refresh: true, now });
    expect(resB.repos[0]?.lastFetchAt).toBe('2026-11-14T08:00:00.000Z');

    // Keep subsequent background fetches slower than the immediate read path under heavy CI load.
    const slowUploadPack = path.join(root, 'ttl-slow-upload-pack.sh');
    await fs.writeFile(slowUploadPack, '#!/bin/sh\nsleep 0.2\nexec git-upload-pack "$@"\n', { mode: 0o755 });
    await git(repoTtlA, 'config', 'remote.origin.uploadpack', slowUploadPack);
    await git(repoTtlB, 'config', 'remote.origin.uploadpack', slowUploadPack);

    // At 23h59m, entry B is still present with its prior lastFetchAt before background refresh finishes.
    fakeNow += 24 * 60 * 60_000 - 60_000;
    const beforeExpiryB = await incomingCommits(wsTtlB, { now });
    expect(beforeExpiryB.repos[0]?.lastFetchAt).toBe('2026-11-14T08:00:00.000Z');
    await waitForIncomingFetches();

    // Advance 2 minutes (24h01m since A was read): A was dropped and restarts cleanly with lastFetchAt = null.
    fakeNow += 2 * 60_000;
    const afterExpiryA = await incomingCommits(wsTtlA, { now });
    expect(afterExpiryA.repos[0]?.lastFetchAt).toBeNull();
  });

  it('caps in-memory per-repository state at maxRepoStates entries (evicting least-recently-read)', async () => {
    const bare = path.join(root, 'cap-remote.git');
    const seed = path.join(root, 'cap-seed');
    const template = path.join(root, 'cap-template');
    await execa('git', ['init', '--bare', '-b', 'main', bare]);
    await execa('git', ['clone', bare, seed]);
    await git(seed, 'config', 'user.name', 'Seed');
    await git(seed, 'config', 'user.email', 'seed@example.com');
    await fs.writeFile(path.join(seed, 'a.txt'), 'a\n');
    await git(seed, 'add', 'a.txt');
    await git(seed, 'commit', '-m', 'Init');
    await git(seed, 'push', '-u', 'origin', 'main');
    await execa('git', ['clone', '-b', 'main', bare, template]);

    const fakeNow = Date.parse('2026-11-14T08:00:00.000Z');
    const now = () => fakeNow;
    const cap = 4;

    const workspaces: string[] = [];
    for (let i = 0; i <= cap; i += 1) {
      const ws = path.join(root, `cap-ws-${i}`);
      const repoPath = path.join(ws, 'app');
      await fs.mkdir(ws, { recursive: true });
      await fs.cp(template, repoPath, { recursive: true });
      await fs.writeFile(
        path.join(ws, 'contextspace.json'),
        JSON.stringify({ id: `r-${i}`, name: `r-${i}`, branchName: 'main', repos: [repoPath], assistants: [], workspacePath: ws }),
      );
      workspaces.push(ws);
    }

    for (let i = 0; i < cap; i += 1) {
      const seeded = await incomingCommits(workspaces[i]!, { refresh: true, now, maxRepoStates: cap });
      expect(seeded.repos[0]?.state).toBe('ok');
    }

    const slowUploadPack = path.join(root, 'cap-slow-upload-pack.sh');
    await fs.writeFile(slowUploadPack, '#!/bin/sh\nsleep 0.2\nexec git-upload-pack "$@"\n', { mode: 0o755 });
    await git(path.join(workspaces[1]!, 'app'), 'config', 'remote.origin.uploadpack', slowUploadPack);

    // Touch r-0 so r-1 becomes the least-recently-read entry.
    const r0Warm = await incomingCommits(workspaces[0]!, { now, maxRepoStates: cap });
    expect(r0Warm.repos[0]?.lastFetchAt).not.toBeNull();
    expect(r0Warm.repos[0]?.fetching).toBe(false);

    // Adding entry #(cap + 1) evicts r-1 (oldest unread), keeping r-0 and r-cap.
    const rCap = await incomingCommits(workspaces[cap]!, { refresh: true, now, maxRepoStates: cap });
    expect(rCap.repos[0]?.lastFetchAt).not.toBeNull();

    const r1AfterEvict = await incomingCommits(workspaces[1]!, { now, maxRepoStates: cap });
    expect(r1AfterEvict.repos[0]?.lastFetchAt).toBeNull();
    expect(r1AfterEvict.repos[0]?.fetching).toBe(true);
    await waitForIncomingFetches();

    const r0StillWarm = await incomingCommits(workspaces[0]!, { now, maxRepoStates: cap });
    expect(r0StillWarm.repos[0]?.lastFetchAt).not.toBeNull();
    expect(r0StillWarm.repos[0]?.fetching).toBe(false);
  });

  it('does not count or list AIs own rebased or amended commits as incoming', async () => {
    const { ws, bare, repo, maria, branch } = await createWorkspaceWithBareRemote(root);

    // AI commits on the feature branch and pushes.
    await fs.writeFile(path.join(repo, 'ai.ts'), 'export const ai = 1;\n');
    await git(repo, 'add', 'ai.ts');
    await git(repo, 'commit', '-m', 'AI work 1');
    await git(repo, 'push', 'origin', branch);
    await git(maria, 'pull', '--ff-only', 'origin', branch);

    // Another collaborator advances main; AI rebases local feature branch onto origin/main
    // (without force-pushing yet) and amends the top commit message without changing its diff.
    const helper = path.join(root, 'main-pusher');
    await execa('git', ['clone', '-b', 'main', bare, helper]);
    await git(helper, 'config', 'user.name', 'Helper');
    await git(helper, 'config', 'user.email', 'helper@example.com');
    await fs.writeFile(path.join(helper, 'main-advance.txt'), 'main\n');
    await git(helper, 'add', 'main-advance.txt');
    await git(helper, 'commit', '-m', 'Main advance');
    await git(helper, 'push', 'origin', 'main');

    await git(repo, 'fetch', 'origin', 'main');
    await git(repo, 'rebase', 'origin/main');
    await git(repo, 'commit', '--amend', '-m', 'AI work 1 (rebased)');

    const afterRebase = await incomingCommits(ws, { refresh: true });
    expect(afterRebase.repos[0]?.state).toBe('ok');
    expect(afterRebase.repos[0]?.behind).toBe(0);
    expect(afterRebase.repos[0]?.commits).toEqual([]);

    // Maria now pushes a genuinely new commit onto the pre-rebase remote branch.
    const mariaSha = await commitAsMaria(maria, 'Maria real incoming', { 'maria-real.ts': 'export const real = 1;\n' });
    const afterMariaPush = await incomingCommits(ws, { refresh: true, now: () => Date.now() + 60_000 });
    expect(afterMariaPush.repos[0]?.state).toBe('ok');
    expect(afterMariaPush.repos[0]?.behind).toBe(1);
    expect(afterMariaPush.repos[0]?.commits).toHaveLength(1);
    expect(afterMariaPush.repos[0]?.commits[0]?.sha).toBe(mariaSha.slice(0, 7));
    expect(afterMariaPush.repos[0]?.commits[0]?.subject).toBe('Maria real incoming');
  });

  it('passes http.lowSpeedLimit=1000 and http.lowSpeedTime=20 to git fetch', async () => {
    const { ws } = await createWorkspaceWithBareRemote(root);
    const realGit = (await execa('which', ['git'])).stdout.trim();
    const fetchArgsLog = path.join(root, 'fetch-args.log');
    const binDir = path.join(root, 'logged-git-bin');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      path.join(binDir, 'git'),
      `#!/bin/sh
case " $* " in
  *" fetch "*) printf '%s\n' "$*" >> "${fetchArgsLog}" ;;
esac
exec "${realGit}" "$@"
`,
      { mode: 0o755 },
    );

    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const res = await incomingCommits(ws, { refresh: true });
      expect(res.repos[0]?.state).toBe('ok');
    } finally {
      process.env.PATH = origPath;
    }

    const logged = await fs.readFile(fetchArgsLog, 'utf8');
    expect(logged).toContain('-c http.lowSpeedLimit=1000');
    expect(logged).toContain('-c http.lowSpeedTime=20');
  });

  it('reports no-upstream with an honest message when the remote branch is deleted while a stale tracking ref exists', async () => {
    const { ws, bare, repo, branch } = await createWorkspaceWithBareRemote(root);
    await git(repo, 'remote', 'set-url', 'origin', 'https://git.example.invalid/org/repo.git');
    await git(repo, 'config', `url.${bare}.insteadOf`, 'https://git.example.invalid/org/repo.git');

    const initial = await incomingCommits(ws, { refresh: true });
    expect(initial.repos[0]?.state).toBe('ok');
    const staleRef = `refs/remotes/origin/${branch}`;
    await expect(git(repo, 'rev-parse', '--verify', staleRef)).resolves.toMatch(/^[0-9a-f]{40}\s*$/);

    // Remote branch is deleted on the server while local refs/remotes/origin/<branch> still remains.
    await git(bare, 'branch', '-D', branch);

    const afterDelete = await incomingCommits(ws, { refresh: true, now: () => Date.now() + 60_000 });
    await expect(git(repo, 'rev-parse', '--verify', staleRef)).resolves.toMatch(/^[0-9a-f]{40}\s*$/);
    expect(afterDelete.repos[0]?.state).toBe('no-upstream');
    expect(afterDelete.repos[0]?.message).toBe(`${branch} is no longer on git.example.invalid`);
  });

  it('recovers from no-upstream to ok immediately when the AI pushes with -u and creates the tracking ref', async () => {
    const { ws, bare, repo, maria } = await createWorkspaceWithBareRemote(root);
    const newBranch = 'feat/new-branch';
    await git(repo, 'checkout', '-b', newBranch);
    await fs.writeFile(path.join(repo, 'new.ts'), 'export const n = 1;\n');
    await git(repo, 'add', 'new.ts');
    await git(repo, 'commit', '-m', 'AI initial commit on new branch');

    let fakeNow = Date.parse('2026-11-14T12:00:00.000Z');
    const now = () => fakeNow;

    // 1. Read before pushing: no-upstream ("not on origin yet").
    const beforePush = await incomingCommits(ws, { refresh: true, now });
    expect(beforePush.repos[0]?.state).toBe('no-upstream');
    expect(beforePush.repos[0]?.message).toBe(`Branch "${newBranch}" is not on origin yet`);
    expect(beforePush.repos[0]?.behind).toBe(0);

    // 2. AI pushes with -u, creating refs/remotes/origin/feat/new-branch.
    await git(repo, 'push', '-u', 'origin', newBranch);

    // 3. Read again immediately (without waiting for cooldown): reports ok and starts a fetch at once.
    const slowWrapper = path.join(root, 'n1-slow-upload-pack.sh');
    await fs.writeFile(slowWrapper, '#!/bin/sh\nsleep 0.1\nexec git-upload-pack "$@"\n', { mode: 0o755 });
    await git(repo, 'config', 'remote.origin.uploadpack', slowWrapper);

    const afterPush = await incomingCommits(ws, { now });
    expect(afterPush.repos[0]?.state).toBe('ok');
    expect(afterPush.repos[0]?.message).toBeNull();
    expect(afterPush.repos[0]?.behind).toBe(0);
    expect(afterPush.repos[0]?.fetching).toBe(true);
    await waitForIncomingFetches();
    await git(repo, 'config', '--unset', 'remote.origin.uploadpack');

    // 4. After Maria pushes, a ?refresh=1-style read sees Maria's commit.
    await git(maria, 'fetch', 'origin', newBranch);
    await git(maria, 'checkout', '-b', newBranch, `origin/${newBranch}`);
    const mariaSha = await commitAsMaria(maria, 'Maria on new branch', { 'maria-new.ts': 'export const mn = 1;\n' });
    fakeNow += 30_000;
    const afterMaria = await incomingCommits(ws, { refresh: true, now });
    expect(afterMaria.repos[0]?.state).toBe('ok');
    expect(afterMaria.repos[0]?.behind).toBe(1);
    expect(afterMaria.repos[0]?.commits.map((c) => c.sha)).toEqual([mariaSha.slice(0, 7)]);

    // Also verify commits already on the created ref are read right away without waiting for fetch.
    resetIncomingCommitsState();
    const branch2 = 'feat/new-immediate';
    await git(repo, 'checkout', '--no-track', '-b', branch2, 'origin/main');
    await fs.writeFile(path.join(repo, 'new2.ts'), 'export const n2 = 1;\n');
    await git(repo, 'add', 'new2.ts');
    await git(repo, 'commit', '-m', 'AI commit on branch2');

    const first2 = await incomingCommits(ws, { refresh: true, now });
    expect(first2.repos[0]?.state).toBe('no-upstream');
    expect(first2.repos[0]?.message).toBe(`Branch "${branch2}" is not on origin yet`);

    await git(repo, 'push', '-u', 'origin', branch2);
    await git(repo, 'reset', '--hard', 'HEAD~1');
    await git(repo, 'config', 'remote.origin.uploadpack', slowWrapper);
    const plainAhead = await incomingCommits(ws, { now });
    expect(plainAhead.repos[0]?.state).toBe('ok');
    expect(plainAhead.repos[0]?.behind).toBe(1);
    expect(plainAhead.repos[0]?.commits[0]?.subject).toBe('AI commit on branch2');
    expect(plainAhead.repos[0]?.fetching).toBe(true);
    await waitForIncomingFetches();
    await git(repo, 'config', '--unset', 'remote.origin.uploadpack');

    // And within <30s of no-upstream, ?refresh=1 fetches Maria's commit immediately instead of waiting for cooldown.
    resetIncomingCommitsState();
    const branch3 = 'feat/new-fast-refresh';
    await git(repo, 'checkout', '--no-track', '-b', branch3, 'origin/main');
    await fs.writeFile(path.join(repo, 'new3.ts'), 'export const n3 = 1;\n');
    await git(repo, 'add', 'new3.ts');
    await git(repo, 'commit', '-m', 'AI commit on branch3');

    const first3 = await incomingCommits(ws, { refresh: true, now });
    expect(first3.repos[0]?.state).toBe('no-upstream');
    await git(repo, 'push', '-u', 'origin', branch3);
    await git(maria, 'fetch', 'origin', branch3);
    await git(maria, 'checkout', '-b', branch3, `origin/${branch3}`);
    const mariaSha3 = await commitAsMaria(maria, 'Maria fast push', { 'mf3.ts': '1\n' });
    fakeNow += 1_000;
    const fastRefresh = await incomingCommits(ws, { refresh: true, now });
    expect(fastRefresh.repos[0]?.state).toBe('ok');
    expect(fastRefresh.repos[0]?.behind).toBe(1);
    expect(fastRefresh.repos[0]?.commits[0]?.sha).toBe(mariaSha3.slice(0, 7));
    expect(bare).toBeTruthy();
  });

  it('never starts a lazy network fetch from the read path in a --filter=blob:none clone and omits fileCount when shortstat needs missing blobs', async () => {
    const { ws, bare, repo, maria, branch } = await createWorkspaceWithBareRemote(root);
    await git(bare, 'config', 'uploadpack.allowFilter', 'true');

    await fs.rm(repo, { recursive: true, force: true });
    await execa('git', ['clone', '--filter=blob:none', '-b', branch, `file://${bare}`, repo]);
    await git(repo, 'config', 'user.name', 'Developer');
    await git(repo, 'config', 'user.email', 'dev@example.com');

    const uploadCountFile = path.join(root, 'blobless-upload-pack-count.txt');
    const uploadWrapper = path.join(root, 'blobless-upload-pack.sh');
    await fs.writeFile(
      uploadWrapper,
      `#!/bin/sh
printf '1\\n' >> "${uploadCountFile}"
exec git-upload-pack "$@"
`,
      { mode: 0o755 },
    );
    await git(repo, 'config', 'remote.origin.uploadpack', uploadWrapper);

    const mariaSha1 = await commitAsMaria(maria, 'Blobless Maria add', { 'maria-blob.ts': 'export const mb = 1;\n' });
    const mariaSha2 = await commitAsMaria(maria, 'Blobless Maria edit', { 'base.ts': 'export const base = 2;\n' });

    const traceFile = path.join(root, 'blobless-git-trace.log');
    const prevTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = traceFile;
    let fakeNow = Date.parse('2026-11-14T13:00:00.000Z');
    const now = () => fakeNow;
    try {
      const res = await incomingCommits(ws, { refresh: true, now });
      expect(res.repos[0]?.state).toBe('ok');
      expect(res.repos[0]?.behind).toBe(2);
      expect(res.repos[0]?.commits).toHaveLength(2);
      expect(res.repos[0]?.commits[0]?.sha).toBe(mariaSha2.slice(0, 7));
      expect(res.repos[0]?.commits[0]?.subject).toBe('Blobless Maria edit');
      expect(res.repos[0]?.commits[0]).not.toHaveProperty('fileCount');
      expect(res.repos[0]?.commits[1]?.sha).toBe(mariaSha1.slice(0, 7));
      expect(res.repos[0]?.commits[1]).not.toHaveProperty('fileCount');

      const uploadCalls = (await fs.readFile(uploadCountFile, 'utf8')).trim().split('\n').filter(Boolean);
      expect(uploadCalls).toHaveLength(1);

      await fs.writeFile(path.join(repo, 'base.ts'), 'export const base = 99;\n');
      await git(repo, 'add', 'base.ts');
      await git(repo, 'commit', '-m', 'Local edit to base.ts');

      await fs.rm(uploadCountFile, { force: true });
      fakeNow += 10_000;
      const readOnly = await incomingCommits(ws, { now });
      expect(readOnly.repos[0]?.state).toBe('ok');
      expect(readOnly.repos[0]?.behind).toBe(2);
      expect(readOnly.repos[0]?.commits).toHaveLength(2);
      expect(readOnly.repos[0]?.commits[0]).not.toHaveProperty('fileCount');
      await expect(fs.access(uploadCountFile)).rejects.toMatchObject({ code: 'ENOENT' });

      const trace = await fs.readFile(traceFile, 'utf8');
      expect(trace).not.toContain('fetch.negotiationAlgorithm=noop');
    } finally {
      if (prevTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = prevTrace;
    }
  });
});
