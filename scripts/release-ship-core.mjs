// Pure decisions for `npm run release:ship`. The wrapper (release-ship.mjs) reads
// git and GitHub and performs the one action this module names; nothing here does
// I/O, so every rule is unit-testable.
//
// The release is a state machine over GitHub's own state, not over anything an
// agent remembers. Any agent that runs the command lands on the same next step,
// so several agents converge on one release instead of racing to prepare their own.

import { compareVersions, parseVersion } from './release-guard-core.mjs';

export const RELEASE_BRANCH = 'release/next';

/** Everything `npm version` + sync-version.mjs may touch. A release PR may change nothing else. */
export const VERSION_FILES = [
  'package.json',
  'package-lock.json',
  'desktop/package.json',
  'desktop/package-lock.json',
  'extension/package.json',
  'extension/package-lock.json',
  'gui/package.json',
  'gui/package-lock.json',
];

export const releaseTitle = (version) => `chore: prepare release ${version}`;
const RELEASE_TITLE = /^chore: prepare release \d+\.\d+\.\d+$/;

const BUMP_RANK = { patch: 1, minor: 2, major: 3 };

/**
 * The bump the unreleased commits call for, from conventional commits:
 * `feat` is minor; `fix`, `perf` and `revert` are patch; `!` or a BREAKING CHANGE
 * footer is major. Docs, chores, tests, CI and refactors do not release by themselves.
 * Release-preparation commits are ignored.
 */
export function inferBump(commits) {
  let bump = null;
  for (const { subject = '', body = '' } of commits) {
    if (RELEASE_TITLE.test(subject)) continue;
    const match = /^(\w+)(?:\([^)]*\))?(!)?:\s/.exec(subject);
    let found = null;
    if (/^BREAKING[ -]CHANGE:/m.test(body) || (match && match[2])) found = 'major';
    else if (match?.[1] === 'feat') found = 'minor';
    else if (match && ['fix', 'perf', 'revert'].includes(match[1])) found = 'patch';
    if (found && (bump === null || BUMP_RANK[found] > BUMP_RANK[bump])) bump = found;
  }
  return bump;
}

/** `null` for anything that is not a plain X.Y.Z; ship does not manage prereleases. */
export function nextVersion(current, bump) {
  const parsed = parseVersion(current);
  if (!parsed || parsed.pre.length > 0 || !(bump in BUMP_RANK)) return null;
  const [major, minor, patch] = parsed.core;
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * True when a unified diff changes nothing but `"version"` lines. A release PR that
 * does anything else is not a release bump and must not be merged automatically.
 */
export function isVersionOnlyDiff(patch, expectedVersion) {
  const removed = [];
  const added = [];
  let inHunk = false;
  for (const line of String(patch ?? '').split('\n')) {
    // Inside a hunk every line carries a one-character prefix, so a line that starts with
    // `diff ` or `@@` is always structure, and one that starts with `---` or `+++` is a changed
    // line whose text begins with `--` or `++`. Only before a file's first hunk are those headers.
    if (line.startsWith('diff ')) { inHunk = false; continue; }
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) {
      // Part of a file's header. A version bump has no mode change, rename, copy or binary patch.
      if (/^(old mode|new mode|new file mode|deleted file mode|similarity index|dissimilarity index|rename |copy |Binary files|GIT binary patch)/.test(line)) return false;
      continue;
    }
    // Context lines, the no-newline marker, and a context line a tool stripped to nothing.
    if (line === '' || line[0] === ' ' || line.startsWith('\\ ')) continue;
    // Anything else that is not a changed line is structure this does not understand.
    if (line[0] !== '+' && line[0] !== '-') return false;
    const match = /^([+-])\s*"version": "([^"]+)",?\s*$/.exec(line);
    if (!match) return false;
    (match[1] === '-' ? removed : added).push(match[2]);
  }
  // A bump replaces version lines with version lines: they pair up, and they all say the same new
  // version. Deleting one, adding an extra one, or moving a dependency's version is not a bump.
  if (added.length === 0 || added.length !== removed.length) return false;
  if (!added.every((version) => version === added[0])) return false;
  return expectedVersion === undefined || added[0] === expectedVersion;
}

/**
 * Turn per-check results (from evaluateRequiredChecks) into green, pending or failed.
 * A check that has not appeared yet is pending for a grace period after the commit
 * landed, because GitHub creates check runs a little after the push.
 */
export function classifyChecks(results, { commitAgeMinutes = 0, graceMinutes = 30 } = {}) {
  if (!Array.isArray(results) || results.length === 0) {
    return { state: 'failed', problems: ['No required-check results could be read.'] };
  }
  const problems = [];
  let pending = false;
  for (const { name, ok, reason } of results) {
    if (ok) continue;
    const notYet = /^still /.test(reason) || reason === 'missing' || reason === 'no result for this exact SHA';
    if (notYet && (reason.startsWith('still ') || commitAgeMinutes < graceMinutes)) pending = true;
    else problems.push(`${name}: ${reason}`);
  }
  if (problems.length > 0) return { state: 'failed', problems };
  return { state: pending ? 'pending' : 'green', problems: [] };
}

/**
 * Where a release PR stands, from GitHub's own merge state and its check rollup.
 * Only a clean state merges. Anything unusual stops for a person instead of guessing.
 */
export function classifyPullRequest({ mergeStateStatus, mergeable, rollup = [], ageMinutes = Infinity, graceMinutes = 10 }) {
  if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') return 'conflicting';
  const failing = rollup.some((c) => c.status === 'COMPLETED' && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion));
  if (failing) return 'failing';
  const pending = rollup.some((c) => c.status !== 'COMPLETED');
  if (pending) return 'checks-pending';
  if (mergeStateStatus === 'CLEAN') return 'ready';
  if (mergeStateStatus === 'UNKNOWN') return 'checks-pending';
  // For the first moments after a PR opens, GitHub lists no checks and reports it BLOCKED, and it reports
  // required checks that have not been created yet the same way it reports a missing review. Only call it
  // blocked once the checks have had time to appear.
  if (rollup.length === 0 || ageMinutes < graceMinutes) return 'checks-pending';
  return 'blocked';
}

const stop = (code, message, extra = {}) => ({ action: 'stop', code, message, ...extra });
const wait = (waitFor, message, extra = {}) => ({ action: 'wait', waitFor, message, ...extra });
const done = (code, message) => ({ action: 'done', code, message });

function releasePrProblems(pr, { latestVersion }) {
  const problems = [];
  if (pr.headRef !== RELEASE_BRANCH) problems.push(`it is not on ${RELEASE_BRANCH}`);
  if (!RELEASE_TITLE.test(pr.title ?? '')) problems.push(`its title is not "${releaseTitle('X.Y.Z')}"`);
  const stray = (pr.files ?? []).filter((file) => !VERSION_FILES.includes(file));
  if (stray.length > 0) problems.push(`it changes files other than version files: ${stray.join(', ')}`);
  if (!(pr.files ?? []).includes('package.json')) problems.push('it does not change package.json');
  if (pr.diffVersionOnly === false) problems.push('it changes more than version lines');
  const version = parseVersion(pr.version);
  if (!version) problems.push('its version is not X.Y.Z');
  else if (latestVersion && compareVersions(version, parseVersion(latestVersion)) <= 0) problems.push(`its version ${pr.version} is not above ${latestVersion}`);
  return problems;
}

/**
 * Decide the one next step.
 *
 * facts:
 * - paused: RELEASES_PAUSED is set
 * - inFlightRuns: release.yml runs that hold the release lane
 * - mainVersion, tipSha: package.json version and commit at the tip of main
 * - latestTag: { version, sha } of the highest release tag, or null
 * - releaseExists: a GitHub Release exists for main's version
 * - commits: [{ subject, body }] on main since the latest tag
 * - releasePr: null or { number, headRef, title, version, files, diffVersionOnly, state }
 * - tipChecks: { state: 'green'|'pending'|'failed', problems } for the tip of main
 * - requestedBump: 'patch'|'minor'|'major' when the caller chose it
 *
 * Returns { action: 'stop'|'wait'|'done'|'dispatch'|'create-release-pr'|'merge-release-pr'|'close-release-pr', ... }
 */
export function decideNextStep(facts) {
  const { paused, inFlightRuns = [], mainVersion, tipSha, latestTag, releaseExists, commits = [], releasePr, tipChecks, requestedBump } = facts;

  if (paused) return stop('paused', 'Releases are paused (the RELEASES_PAUSED variable is set). Nothing was changed. Ask the owner to clear it.');
  if (inFlightRuns.length > 0) {
    const run = inFlightRuns[0];
    return wait('release-run', `Release run ${run.databaseId} is ${run.status}; only one release runs at a time.`, { run });
  }

  const main = parseVersion(mainVersion);
  if (!main || main.pre.length > 0) return stop('unmanaged-version', `main carries "${mainVersion ?? '(unreadable)'}", which is not a plain X.Y.Z. release:ship does not manage prereleases.`);

  const comparison = latestTag ? compareVersions(main, parseVersion(latestTag.version)) : 1;
  if (comparison < 0) {
    return stop('version-behind', `main carries ${mainVersion} but v${latestTag.version} is already tagged. Releases move forward only; fix the version on main first.`);
  }

  const dispatchable = (extra = {}) => {
    if (tipChecks?.state === 'pending') return wait('main-checks', `Required checks on ${tipSha.slice(0, 7)} are still running.`);
    if (tipChecks?.state !== 'green') {
      return stop('checks-failed', `Required checks on ${tipSha.slice(0, 7)} are not green:\n  - ${(tipChecks?.problems ?? ['unknown']).join('\n  - ')}`);
    }
    return { action: 'dispatch', version: mainVersion, tipSha, ...extra };
  };

  // A version is prepared on main and not released yet: ship it.
  if (comparison > 0) {
    if (releasePr) return { action: 'close-release-pr', number: releasePr.number, reason: `main already carries ${mainVersion}, so this release PR is stale.` };
    return dispatchable();
  }

  // main's version is the latest tag.
  if (latestTag.sha === tipSha) {
    if (releaseExists) return done('nothing-to-release', `v${mainVersion} is already released from the tip of main.`);
    return dispatchable({ rerun: true });
  }

  // main has moved past the tag: is there anything worth releasing?
  if (releasePr) {
    const problems = releasePrProblems(releasePr, { latestVersion: latestTag.version });
    if (problems.length > 0) return stop('release-pr-unsafe', `Release PR #${releasePr.number} is not a plain version bump (${problems.join('; ')}). It was not merged. A person should look.`, { number: releasePr.number });
    if (releasePr.isStale || (releasePr.baseSha && releasePr.baseSha !== tipSha)) {
      return { action: 'close-release-pr', number: releasePr.number, reason: `main moved since release PR #${releasePr.number} was opened; closing it so a fresh one is made from the tip of main.` };
    }
    if (releasePr.state === 'ready') return { action: 'merge-release-pr', number: releasePr.number, version: releasePr.version };
    if (releasePr.state === 'checks-pending') return wait('release-pr-checks', `Release PR #${releasePr.number} is waiting for its checks.`);
    if (releasePr.state === 'conflicting') return { action: 'close-release-pr', number: releasePr.number, reason: `Release PR #${releasePr.number} conflicts with main; closing it so a fresh one is made.` };
    if (releasePr.state === 'failing') return stop('release-pr-failing', `Checks on release PR #${releasePr.number} failed. Fix main or the checks; do not release.`, { number: releasePr.number });
    return stop('release-pr-blocked', `Release PR #${releasePr.number} cannot merge (a required review or rule is blocking it). A person has to unblock it.`, { number: releasePr.number });
  }

  const bump = requestedBump ?? inferBump(commits);
  if (bump === null) return done('nothing-to-release', `Nothing releasable since v${latestTag.version}: only docs, chores, tests or refactors. Use --bump to release anyway.`);
  if (bump === 'major' && requestedBump !== 'major') {
    return stop('major-needs-confirmation', `A breaking change since v${latestTag.version} calls for a major release. Run with --bump major to confirm it.`);
  }
  return { action: 'create-release-pr', bump, version: nextVersion(mainVersion, bump), baseSha: tipSha };
}
