import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  compareVersions,
  evaluateDispatchRef,
  evaluateExpectedSha,
  evaluateRequiredChecks,
  evaluateVersionOrder,
  expectedCheckNames,
  parseRemoteTags,
  parseVersion,
} from './release-guard-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts', 'release-guard.mjs');
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function readYaml(relPath: string): any {
  return load(readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function run(name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name,
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    app: { slug: 'github-actions' },
    ...overrides,
  };
}

function evaluate(checkRuns: unknown[], required = ['build', 'audit']) {
  return evaluateRequiredChecks({ sha: SHA, required, app: 'github-actions', checkRuns });
}

describe('evaluateDispatchRef', () => {
  it('accepts the default branch', () => {
    expect(evaluateDispatchRef({ ref: 'refs/heads/main', defaultBranch: 'main' }).ok).toBe(true);
  });

  it.each([
    ['a feature branch', 'refs/heads/feature/x'],
    ['a tag', 'refs/tags/v1.0.0'],
    ['a branch that only starts with the default name', 'refs/heads/main-old'],
    ['an empty ref', ''],
  ])('rejects %s', (_label, ref) => {
    const result = evaluateDispatchRef({ ref, defaultBranch: 'main' });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('only refs/heads/main may release');
  });

  it('fails closed when the default branch is unknown', () => {
    expect(evaluateDispatchRef({ ref: 'refs/heads/main', defaultBranch: '' }).ok).toBe(false);
  });
});

describe('evaluateRequiredChecks', () => {
  it('passes when every required check succeeded on the exact SHA', () => {
    const result = evaluate([run('build'), run('audit'), run('unrelated', { conclusion: 'failure' })]);
    expect(result).toMatchObject({ ok: true, problems: [] });
  });

  it.each(['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'action_required', 'stale', null])(
    'fails closed on conclusion %s',
    (conclusion) => {
      const result = evaluate([run('build'), run('audit', { conclusion })]);
      expect(result.ok).toBe(false);
      expect(result.problems).toEqual([`audit: ${conclusion ?? 'no conclusion'}`]);
    },
  );

  it.each(['queued', 'in_progress', 'waiting'])('fails closed while a check is %s', (status) => {
    const result = evaluate([run('build'), run('audit', { status, conclusion: null })]);
    expect(result.problems).toEqual([`audit: still ${status}`]);
  });

  it('fails closed when a required check never ran', () => {
    expect(evaluate([run('build')]).problems).toEqual(['audit: missing']);
  });

  it('rejects evidence recorded for a different SHA', () => {
    const result = evaluate([run('build'), run('audit', { head_sha: OTHER_SHA })]);
    expect(result.problems).toEqual(['audit: no result for this exact SHA']);
  });

  it('rejects a same-named check reported by another app', () => {
    const result = evaluate([run('build'), run('audit', { app: { slug: 'some-other-app' } })]);
    expect(result.problems).toEqual(['audit: not reported by github-actions']);
  });

  it('lets a successful re-run supersede an earlier failure', () => {
    const result = evaluate([
      run('build'),
      run('audit', { id: 10, conclusion: 'failure' }),
      run('audit', { id: 11 }),
    ]);
    expect(result.ok).toBe(true);
  });

  it('lets a failed re-run supersede an earlier success', () => {
    const result = evaluate([
      run('build'),
      run('audit', { id: 11, conclusion: 'failure' }),
      run('audit', { id: 10 }),
    ]);
    expect(result.problems).toEqual(['audit: failure']);
  });

  it('reports every failing check, not only the first', () => {
    const result = evaluate([]);
    expect(result.problems).toEqual(['build: missing', 'audit: missing']);
  });

  it('refuses an empty required list', () => {
    const result = evaluate([run('build')], []);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('required check list is empty');
  });

  it('refuses unreadable evidence', () => {
    const result = evaluateRequiredChecks({ sha: SHA, required: ['build'], app: 'github-actions', checkRuns: undefined });
    expect(result.ok).toBe(false);
  });
});

describe('version ordering', () => {
  const order = (a: string, b: string) => Math.sign(compareVersions(parseVersion(a), parseVersion(b)));

  it.each([
    ['2.29.1', '2.29.0', 1],
    ['2.30.0', '2.29.9', 1],
    ['3.0.0', '2.99.99', 1],
    ['2.29.1', '2.29.1', 0],
    ['2.30.0', '2.30.0-rc.1', 1],
    ['2.30.0-rc.1', '2.29.1', 1],
    ['2.30.0-rc.2', '2.30.0-rc.1', 1],
    ['2.30.0-rc.10', '2.30.0-rc.9', 1],
    ['2.30.0-rc.1', '2.30.0-rc.1.1', -1],
    ['2.30.0-1', '2.30.0-rc', -1],
    ['2.30.0-alpha', '2.30.0-beta', -1],
  ])('orders %s against %s as %i', (a, b, expected) => {
    expect(order(a, b)).toBe(expected);
    expect(order(b, a)).toBe(expected === 0 ? 0 : -expected);
  });

  it.each(['', '2.29', 'v2.29.1', '2.29.1-', '2.29.1+build', 'latest', '2.29.x'])('does not parse %j', (text) => {
    expect(parseVersion(text)).toBeNull();
  });

  const tags = [
    { sha: SHA, version: '2.29.0' },
    { sha: SHA, version: '2.29.1' },
    { sha: SHA, version: '2.30.0-rc.1' },
  ];

  it('allows a version above every release tag', () => {
    expect(evaluateVersionOrder({ version: '2.30.0', tags }).ok).toBe(true);
    expect(evaluateVersionOrder({ version: '2.30.0-rc.2', tags }).ok).toBe(true);
  });

  it('allows re-running the newest version so a partial release can finish', () => {
    expect(evaluateVersionOrder({ version: '2.30.0-rc.1', tags }).ok).toBe(true);
  });

  it('allows the first release when no tag exists yet', () => {
    expect(evaluateVersionOrder({ version: '0.1.0', tags: [] }).ok).toBe(true);
  });

  it('refuses a stale version and names the newest tag it would undo', () => {
    const result = evaluateVersionOrder({ version: '2.29.1', tags });
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('v2.30.0-rc.1 is already tagged and is newer than 2.29.1');
  });

  it('treats a prerelease as older than its own release', () => {
    const result = evaluateVersionOrder({ version: '2.30.0-rc.1', tags: [{ sha: SHA, version: '2.30.0' }] });
    expect(result.ok).toBe(false);
  });

  it.each(['', 'latest', 'v2.30.0', '2.30'])('refuses %j as a version', (version) => {
    expect(evaluateVersionOrder({ version, tags }).ok).toBe(false);
  });
});

describe('parseRemoteTags', () => {
  it('reads release tags and ignores anything that is not vX.Y.Z[-pre]', () => {
    const output = [
      `${SHA}\trefs/tags/v2.29.0`,
      `${OTHER_SHA}\trefs/tags/v2.30.0-rc.1`,
      `${SHA}\trefs/tags/v.18.0`,
      `${SHA}\trefs/tags/nightly`,
      `${SHA}\trefs/tags/v2.29`,
      '',
    ].join('\n');
    expect(parseRemoteTags(output)).toEqual([
      { sha: SHA, version: '2.29.0' },
      { sha: OTHER_SHA, version: '2.30.0-rc.1' },
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseRemoteTags('')).toEqual([]);
    expect(parseRemoteTags(undefined)).toEqual([]);
  });
});

describe('evaluateExpectedSha', () => {
  it('does not require a pin', () => {
    expect(evaluateExpectedSha({ expected: '', actual: SHA }).ok).toBe(true);
    expect(evaluateExpectedSha({ expected: undefined, actual: SHA }).ok).toBe(true);
  });

  it('accepts the pinned commit, ignoring case', () => {
    expect(evaluateExpectedSha({ expected: SHA.toUpperCase(), actual: SHA }).ok).toBe(true);
  });

  it('refuses when the default branch moved past the pinned commit', () => {
    const result = evaluateExpectedSha({ expected: SHA, actual: OTHER_SHA });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain(`pinned to ${SHA}`);
    expect(result.problems[0]).toContain(OTHER_SHA);
  });

  it.each(['abc1234', 'main', `${SHA}0`])('refuses %j, which is not a full SHA', (expected) => {
    const result = evaluateExpectedSha({ expected, actual: SHA });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('full 40-character');
  });
});

describe('expectedCheckNames', () => {
  const derive = (jobs: Record<string, unknown>) => expectedCheckNames([{ path: 'wf.yml', workflow: { jobs } }]);

  it('names plain, named, axis-matrix and include-matrix jobs like GitHub Actions', () => {
    expect(derive({
      plain: { 'runs-on': 'x' },
      scan: { name: 'Scan', strategy: { matrix: { language: ['js'] } } },
      test: { strategy: { matrix: { os: ['linux', 'mac'], node: ['22.13.0', 24] } } },
      pkg: { strategy: { matrix: { include: [{ os: 'win', platform: 'windows' }] } } },
    })).toEqual([
      'plain',
      'Scan (js)',
      'test (linux, 22.13.0)',
      'test (linux, 24)',
      'test (mac, 22.13.0)',
      'test (mac, 24)',
      'pkg (win, windows)',
    ]);
  });

  it('rejects conditional jobs, which would leave a required check skipped', () => {
    expect(() => derive({ job: { if: "github.event_name == 'push'" } })).toThrow(/conditional/);
  });

  it.each([
    ['an expression in a name', { job: { name: '${{ matrix.os }}' } }],
    ['matrix exclude', { job: { strategy: { matrix: { os: ['a'], exclude: [{ os: 'a' }] } } } }],
    ['axes combined with include', { job: { strategy: { matrix: { os: ['a'], include: [{ os: 'b' }] } } } }],
    ['a dynamic matrix', { job: { strategy: { matrix: '${{ fromJSON(needs.x.outputs.m) }}' } } }],
  ])('rejects %s', (_label, jobs) => {
    expect(() => derive(jobs)).toThrow();
  });
});

describe('release required-check list', () => {
  const config = JSON.parse(readFileSync(path.join(ROOT, '.github/release-required-checks.json'), 'utf8'));

  it('matches every job in the gating workflows exactly', () => {
    const derived = expectedCheckNames(
      config.workflows.map((wf: string) => ({ path: wf, workflow: readYaml(wf) })),
    );
    expect([...config.checks].sort()).toEqual([...derived].sort());
  });

  it('has unique names and trusts only GitHub Actions', () => {
    expect(new Set(config.checks).size).toBe(config.checks.length);
    expect(config.app).toBe('github-actions');
  });
});

describe('release workflow wiring', () => {
  const workflow = readYaml('.github/workflows/release.yml');
  const jobs = workflow.jobs;
  const publishJobs = ['npm', 'vscode', 'desktop', 'github-release'];
  const credentialJobs = ['npm', 'vscode', 'github-release'];
  const guardRuns: string[] = jobs.guard.steps.map((step: any) => step.run ?? '');
  const indexOfRun = (needle: string) => guardRuns.findIndex((body) => body.includes(needle));

  it('only starts from explicit dispatches', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['repository_dispatch', 'workflow_dispatch']);
  });

  it('verifies the ref and exact-SHA checks before creating the tag', () => {
    const refCheck = indexOfRun('release-guard.mjs ref');
    const checksCheck = indexOfRun('release-guard.mjs checks');
    const tag = indexOfRun('git push origin "refs/tags/');
    expect(refCheck).toBeGreaterThanOrEqual(0);
    expect(checksCheck).toBeGreaterThan(refCheck);
    expect(tag).toBeGreaterThan(checksCheck);
    expect(jobs.guard.permissions).toMatchObject({ checks: 'read' });
  });

  it('pins the source and orders the version before checks and the tag', () => {
    const pin = indexOfRun('release-guard.mjs pin');
    const version = indexOfRun('release-guard.mjs version');
    const checksCheck = indexOfRun('release-guard.mjs checks');
    const tag = indexOfRun('git push origin "refs/tags/');
    expect(pin).toBeGreaterThanOrEqual(0);
    expect(version).toBeGreaterThanOrEqual(0);
    expect(pin).toBeLessThan(checksCheck);
    expect(version).toBeLessThan(checksCheck);
    expect(version).toBeLessThan(tag);
  });

  it('keeps expected_sha optional so existing dispatch commands still work', () => {
    const input = workflow.on.workflow_dispatch.inputs.expected_sha;
    expect(input.required).toBe(false);
    const pinStep = jobs.guard.steps.find((step: any) => String(step.run ?? '').includes('release-guard.mjs pin'));
    expect(pinStep.env.EXPECTED_SHA).toContain('client_payload.expected_sha');
    expect(pinStep.env.EXPECTED_SHA).toContain('inputs.expected_sha');
  });

  it.each(publishJobs)('%s depends on the guard and builds the guard-approved SHA', (name) => {
    const job = jobs[name];
    expect([job.needs].flat()).toContain('guard');
    const checkouts = job.steps.filter((step: any) => String(step.uses ?? '').startsWith('actions/checkout@'));
    for (const checkout of checkouts) {
      expect(checkout.with?.ref).toBe('${{ needs.guard.outputs.sha }}');
    }
  });

  it.each(credentialJobs)('%s runs in the protected release environment', (name) => {
    expect(jobs[name].environment).toBe('release');
  });

  it('keeps publishing when the Marketplace fails but reports it as a failed channel', () => {
    const vscode = jobs.vscode;
    const publish = vscode.steps.find((step: any) => step.id === 'marketplace-publish');
    expect(publish['continue-on-error']).toBe(true);
    expect(vscode.outputs.marketplace).toBe('${{ steps.marketplace-status.outputs.status }}');
    const report = jobs['github-release'].steps.find((step: any) => step.id === 'channel-status');
    expect(report.run).toContain('exit 1');
  });

  it('publishes GitHub Releases regardless of whether npm runs, is skipped, or fails', () => {
    const ghRelease = jobs['github-release'];
    expect(ghRelease.if).not.toContain("needs.npm.result == 'success'");
    const npm = jobs.npm;
    expect(npm.if).toContain("vars.NPM_PUBLISHING_ENABLED == 'true'");
    const npmPublish = npm.steps.find((step: any) => step.id === 'npm-publish');
    expect(npmPublish['continue-on-error']).toBe(true);
    expect(npm.outputs.status).toBe('${{ steps.npm-status.outputs.status }}');
    const channelStatus = ghRelease.steps.find((step: any) => step.id === 'channel-status');
    expect(channelStatus.run).toContain('npm_status="disabled"');
    expect(channelStatus.run).toContain('npm_status="failed"');
    expect(channelStatus.run).toContain('npm_status="cancelled"');
  });
});

describe('nightly-release workflow wiring', () => {
  const nightly = readYaml('.github/workflows/nightly-release.yml');
  const release = readYaml('.github/workflows/release.yml');

  it('uses a dedicated concurrency group that does not clash with release.yml', () => {
    expect(nightly.concurrency.group).not.toBe(release.concurrency.group);
    expect(nightly.concurrency.group).toBe('nightly-release');
  });

  it('configures git committer identity so release-ship can commit version bumps', () => {
    const steps: any[] = nightly.jobs.ship.steps;
    const configStep = steps.find((s) => String(s.run ?? '').includes('user.name') && String(s.run ?? '').includes('user.email'));
    expect(configStep).toBeDefined();
    expect(configStep.run).toContain('git config --global user.name');
    expect(configStep.run).toContain('git config --global user.email');
  });

  it('uses a non-zero minute schedule to avoid top-of-the-hour queue latency', () => {
    const cron = nightly.on.schedule[0].cron;
    const [minute] = cron.split(' ');
    expect(Number(minute)).toBeGreaterThan(0);
  });
});

describe('release-guard CLI', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function serve(handler: (url: URL) => { status: number; body?: unknown }): Promise<string> {
    server = createServer((req, res) => {
      const { status, body } = handler(new URL(req.url ?? '/', 'http://localhost'));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? {}));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  function guard(args: string[], env: Record<string, string> = {}) {
    return new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [GUARD, ...args], {
        cwd: ROOT,
        env: { PATH: process.env.PATH ?? '', GH_TOKEN: 'test-token', ...env },
      });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      child.on('close', (code) => resolve({ code, out }));
    });
  }

  const config = JSON.parse(readFileSync(path.join(ROOT, '.github/release-required-checks.json'), 'utf8'));
  const allGreen = config.checks.map((name: string, i: number) => run(name, { id: i + 1 }));

  it('rejects a non-default ref with a non-zero exit', async () => {
    const result = await guard(['ref', '--ref', 'refs/heads/topic', '--default-branch', 'main']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('::error::');
  });

  it('passes when every required check is green, following pagination', async () => {
    const api = await serve((url) => {
      const page = Number(url.searchParams.get('page'));
      const slice = page === 1 ? allGreen.slice(0, 5) : page === 2 ? allGreen.slice(5) : [];
      return { status: 200, body: { total_count: allGreen.length, check_runs: slice } };
    });
    const result = await guard(['checks', '--sha', SHA, '--repo', 'o/r'], { GITHUB_API_URL: api });
    expect(result.out).toContain('verified');
    expect(result.code).toBe(0);
  });

  it('fails closed when the API errors', async () => {
    const api = await serve(() => ({ status: 502 }));
    const result = await guard(['checks', '--sha', SHA, '--repo', 'o/r'], { GITHUB_API_URL: api });
    expect(result.code).toBe(1);
    expect(result.out).toContain('GitHub API returned 502');
  });

  it('fails closed when pagination ends before total_count', async () => {
    const api = await serve((url) => ({
      status: 200,
      body: { total_count: allGreen.length, check_runs: url.searchParams.get('page') === '1' ? allGreen.slice(0, 3) : [] },
    }));
    const result = await guard(['checks', '--sha', SHA, '--repo', 'o/r'], { GITHUB_API_URL: api });
    expect(result.code).toBe(1);
    expect(result.out).toContain('pagination ended early');
  });

  it('fails closed without a token', async () => {
    const result = await guard(['checks', '--sha', SHA, '--repo', 'o/r'], { GH_TOKEN: '' });
    expect(result.code).toBe(1);
  });

  describe('version and pin commands', () => {
    function tagsFile(lines: string[]): { file: string; cleanup: () => void } {
      const dir = mkdtempSync(path.join(tmpdir(), 'release-guard-'));
      const file = path.join(dir, 'tags.txt');
      writeFileSync(file, lines.join('\n'));
      return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }

    it('refuses a stale version with a non-zero exit', async () => {
      const { file, cleanup } = tagsFile([`${SHA}\trefs/tags/v2.29.1`, `${SHA}\trefs/tags/v2.30.0`]);
      try {
        const result = await guard(['version', '--version', '2.29.2', '--tags-file', file]);
        expect(result.code).toBe(1);
        expect(result.out).toContain('v2.30.0 is already tagged and is newer than 2.29.2');
      } finally {
        cleanup();
      }
    });

    it('accepts the next version', async () => {
      const { file, cleanup } = tagsFile([`${SHA}\trefs/tags/v2.29.1`]);
      try {
        const result = await guard(['version', '--version', '2.30.0', '--tags-file', file]);
        expect(result.code).toBe(0);
        expect(result.out).toContain('verified');
      } finally {
        cleanup();
      }
    });

    it('fails closed when the tag list cannot be read', async () => {
      const result = await guard(['version', '--version', '2.30.0', '--tags-file', path.join(tmpdir(), 'missing-release-tags.txt')]);
      expect(result.code).toBe(1);
      expect(result.out).toContain('Release guard could not complete');
    });

    it('fails closed without a tags file', async () => {
      expect((await guard(['version', '--version', '2.30.0'])).code).toBe(1);
    });

    it('passes the pin check when no commit was pinned, as the workflow sends an empty value', async () => {
      const result = await guard(['pin', '--expected', '', '--actual', SHA]);
      expect(result.code).toBe(0);
    });

    it('rejects a release when the default branch moved past the pinned commit', async () => {
      const result = await guard(['pin', '--expected', SHA, '--actual', OTHER_SHA]);
      expect(result.code).toBe(1);
      expect(result.out).toContain('Verify the new head');
    });
  });
});
