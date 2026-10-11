// The I/O half of `npm run release:ship`. Every command goes through the injected
// `ctx` (git, gh, npm, sleep, now, log), so tests can assert exactly what would run.
//
// Deliberately absent: anything that approves a deployment, cancels someone else's
// run, force-pushes a shared branch, or edits repository settings.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { compareVersions, evaluateRequiredChecks, parseRemoteTags, parseVersion } from './release-guard-core.mjs';
import { IN_FLIGHT } from './release-preflight-core.mjs';
import {
  RELEASE_BRANCH,
  VERSION_FILES,
  classifyChecks,
  classifyPullRequest,
  decideNextStep,
  isVersionOnlyDiff,
  releaseTitle,
} from './release-ship-core.mjs';

const lines = (text) => String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
const failureText = (error) => String(error?.stderr || error?.message || error).trim();

/** Assets every stable release must carry (see RELEASING.md). */
export function expectedAssets(version) {
  return [
    `ContextSpace-${version}.AppImage`,
    `ContextSpace-${version}.AppImage.sha256`,
    'ContextSpaceSetup.exe',
    'ContextSpaceSetup.exe.sha256',
    'ContextSpace.vsix',
    'latest.yml',
    'latest-linux.yml',
  ];
}

function highestTag(tags) {
  return [...tags].sort((a, b) => compareVersions(parseVersion(b.version), parseVersion(a.version)))[0] ?? null;
}

async function readPaused(ctx) {
  try {
    const value = await ctx.gh(['api', `repos/${ctx.repo}/actions/variables/RELEASES_PAUSED`, '--jq', '.value']);
    // Same reading as the workflow's guard step: case-insensitive, whitespace ignored.
    return /^(1|true|yes|on)$/i.test(value.replace(/\s+/g, ''));
  } catch (error) {
    if (/HTTP 404|Not Found/i.test(failureText(error))) return false;
    // Unreadable is a stop, never a guess: a pause that cannot be read is treated as set.
    throw new Error(`Could not read the RELEASES_PAUSED variable, so nothing was released: ${failureText(error)}`);
  }
}

async function releaseExistsFor(ctx, tag) {
  try {
    await ctx.gh(['release', 'view', tag, '--repo', ctx.repo]);
    return true;
  } catch (error) {
    if (/release not found/i.test(failureText(error))) return false;
    throw error;
  }
}

async function commitsSince(ctx, latestTag) {
  if (!latestTag) return [];
  await ctx.git(['merge-base', '--is-ancestor', latestTag.sha, 'origin/main']);
  const out = await ctx.git(['log', '--no-merges', '--format=%s%x1f%b%x1e', `${latestTag.sha}..origin/main`]);
  return out.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [subject, body = ''] = record.split('\x1f');
    return { subject: subject.trim(), body: body.trim() };
  });
}

// Commit statuses report SUCCESS, FAILURE or ERROR once they have a result, and PENDING or EXPECTED before.
const COMMIT_STATUS_STATES = ['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED'];

function rollupOf(pr) {
  return (pr.statusCheckRollup ?? []).map((check) => {
    // A check run has `status` and `conclusion`.
    if (check.status) return { status: check.status, conclusion: check.conclusion ?? '' };
    // A legacy commit status has only `state`. PENDING, and EXPECTED (a required status that has
    // not reported yet), mean it is still running; only SUCCESS, FAILURE and ERROR are results.
    if (check.state) {
      if (!COMMIT_STATUS_STATES.includes(check.state)) throw new Error(`Unrecognized commit status state ${JSON.stringify(check.state)} on PR #${pr.number}.`);
      const reported = !['PENDING', 'EXPECTED'].includes(check.state);
      return { status: reported ? 'COMPLETED' : 'IN_PROGRESS', conclusion: reported ? check.state : '' };
    }
    // Anything else is unreadable. Guessing would either wait forever or call it a failure.
    throw new Error(`Unrecognized entry in the status checks of PR #${pr.number}: ${JSON.stringify(check)}`);
  });
}

async function readReleasePr(ctx) {
  const prs = JSON.parse(await ctx.gh([
    'pr', 'list', '--repo', ctx.repo, '--head', RELEASE_BRANCH, '--state', 'open',
    '--json', 'number,title,headRefName,headRefOid,isCrossRepository,mergeStateStatus,mergeable,statusCheckRollup,createdAt',
  ]));
  if (prs.length === 0) return null;
  const pr = prs.find((candidate) => !candidate.isCrossRepository) ?? prs[0];
  const sha = pr.headRefOid;
  await ctx.git(['fetch', '--quiet', 'origin', sha]);
  const files = lines(await ctx.git(['diff', '--name-only', `origin/main...${sha}`]));
  const patch = await ctx.git(['diff', `origin/main...${sha}`]);
  const version = JSON.parse(await ctx.git(['show', `${sha}:package.json`])).version;
  return {
    number: pr.number,
    // A branch of the same name in a fork is not ours; make that visible to the safety check.
    headRef: pr.isCrossRepository ? `fork:${pr.headRefName}` : pr.headRefName,
    headSha: sha,
    title: pr.title,
    version,
    files,
    diffVersionOnly: isVersionOnlyDiff(patch, version || undefined),
    state: classifyPullRequest({
      mergeStateStatus: pr.mergeStateStatus,
      mergeable: pr.mergeable,
      rollup: rollupOf(pr),
      ageMinutes: pr.createdAt ? (ctx.now() - Date.parse(pr.createdAt)) / 60000 : Infinity,
    }),
  };
}

async function readTipChecks(ctx, tipSha) {
  const config = JSON.parse(await ctx.git(['show', 'origin/main:.github/release-required-checks.json']));
  const raw = await ctx.gh(['api', '--paginate', `repos/${ctx.repo}/commits/${tipSha}/check-runs?filter=all&per_page=100`, '--jq', '.check_runs[]']);
  const checkRuns = lines(raw).map((line) => JSON.parse(line));
  const { results } = evaluateRequiredChecks({ sha: tipSha, required: config.checks, app: config.app, checkRuns });
  const committedAt = Number(await ctx.git(['show', '-s', '--format=%ct', tipSha])) * 1000;
  return classifyChecks(results, { commitAgeMinutes: (ctx.now() - committedAt) / 60000 });
}

/** Read everything the decision needs. Anything unreadable throws; it is never guessed. */
export async function gatherFacts(ctx, { requestedBump } = {}) {
  await ctx.git(['fetch', '--quiet', '--tags', 'origin', 'main']);
  const tipSha = (await ctx.git(['rev-parse', 'origin/main'])).trim();
  const pkg = JSON.parse(await ctx.git(['show', 'origin/main:package.json']));
  const latestTag = highestTag(parseRemoteTags(await ctx.git(['ls-remote', '--tags', '--refs', 'origin'])));
  const paused = await readPaused(ctx);
  const runs = JSON.parse(await ctx.gh([
    'run', 'list', '--repo', ctx.repo, '--workflow', 'release.yml', '--limit', '20', '--json', 'databaseId,status,headSha,createdAt',
  ]));
  return {
    paused,
    inFlightRuns: runs.filter((run) => IN_FLIGHT.has(run.status)),
    mainVersion: pkg.version,
    packageName: pkg.name,
    tipSha,
    latestTag,
    releaseExists: await releaseExistsFor(ctx, `v${pkg.version}`),
    commits: await commitsSince(ctx, latestTag),
    releasePr: await readReleasePr(ctx),
    tipChecks: await readTipChecks(ctx, tipSha),
    requestedBump,
  };
}

function bumpMessage({ version, bump, from, commits }) {
  const included = commits.filter(({ subject }) => !/^chore: prepare release /.test(subject)).slice(0, 40).map(({ subject }) => `- ${subject}`);
  return [
    releaseTitle(version),
    '',
    `Synchronized version bump from ${from} (npm version ${bump} --no-git-tag-version), made by \`npm run release:ship\`.`,
    'Only version files change; the PR is merged only if that is still true.',
    '',
    'Includes:',
    ...(included.length > 0 ? included : ['- (see the commit list on main)']),
  ].join('\n');
}

/**
 * A release branch whose PR was merged by hand is left behind and would block the next release. When
 * everything on it is already in main, deleting it loses nothing. The delete expects the exact commit
 * it checked, so it cannot remove a branch another agent has just pushed.
 */
async function clearMergedReleaseBranch(ctx) {
  const remote = (await ctx.git(['ls-remote', '--heads', 'origin', `refs/heads/${RELEASE_BRANCH}`])).split(/\s+/)[0];
  if (!remote) return false;
  await ctx.git(['fetch', '--quiet', 'origin', remote]);
  try {
    await ctx.git(['merge-base', '--is-ancestor', remote, 'origin/main']);
  } catch {
    return false;
  }
  await ctx.git(['push', `--force-with-lease=refs/heads/${RELEASE_BRANCH}:${remote}`, 'origin', `:refs/heads/${RELEASE_BRANCH}`]);
  return true;
}

/** Bump, verify the change is only version lines, push `release/next` if nobody has, open the PR. */
export async function createReleasePr(ctx, step, facts) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-ship-'));
  let added = false;
  try {
    await ctx.git(['worktree', 'add', '--detach', dir, step.baseSha]);
    added = true;
    await ctx.npm(['version', step.bump, '--no-git-tag-version'], { cwd: dir });
    const version = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).version;
    if (version !== step.version) throw new Error(`npm version produced ${version}, expected ${step.version}. Nothing was pushed.`);

    // The `version` lifecycle script stages with `git add -A`; check what it staged.
    const files = lines(await ctx.git(['diff', '--cached', '--name-only'], { cwd: dir }));
    const stray = files.filter((file) => !VERSION_FILES.includes(file));
    if (stray.length > 0 || !files.includes('package.json')) {
      throw new Error(`The version bump changed unexpected files (${stray.join(', ') || 'no package.json'}). Nothing was pushed.`);
    }
    if (!isVersionOnlyDiff(await ctx.git(['diff', '--cached'], { cwd: dir }), step.version)) {
      throw new Error('The version bump changed more than version lines. Nothing was pushed.');
    }

    const message = bumpMessage({ version, bump: step.bump, from: facts.mainVersion, commits: facts.commits });
    await ctx.git(['commit', '--quiet', '-m', message], { cwd: dir });
    try {
      // Create-if-absent: a lease that expects the branch not to exist, so two agents cannot both make a release PR.
      await ctx.git(['push', `--force-with-lease=refs/heads/${RELEASE_BRANCH}:`, 'origin', `HEAD:refs/heads/${RELEASE_BRANCH}`], { cwd: dir });
    } catch (error) {
      if (/stale info|rejected|already exists|failed to push/i.test(failureText(error))) {
        if (await clearMergedReleaseBranch(ctx)) {
          ctx.log(`Removed the stale ${RELEASE_BRANCH} branch, which was already merged into main.`);
          return { cleaned: true };
        }
        ctx.log('Another agent started this release first; joining its release PR.');
        return { raced: true };
      }
      throw error;
    }
    const [subject, ...rest] = message.split('\n');
    const url = (await ctx.gh(['pr', 'create', '--repo', ctx.repo, '--base', 'main', '--head', RELEASE_BRANCH, '--title', subject, '--body', rest.join('\n').trim()])).trim();
    ctx.log(`Opened release PR ${url}`);
    return { url };
  } finally {
    if (added) await ctx.git(['worktree', 'remove', '--force', dir]).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Merge only the exact commit that was checked; a changed PR is not merged. */
export async function mergeReleasePr(ctx, step, facts) {
  await ctx.gh(['pr', 'merge', String(step.number), '--repo', ctx.repo, '--merge', '--match-head-commit', facts.releasePr.headSha, '--delete-branch']);
  ctx.log(`Merged release PR #${step.number} (${step.version}).`);
}

export async function closeReleasePr(ctx, step) {
  await ctx.gh(['pr', 'close', String(step.number), '--repo', ctx.repo, '--comment', step.reason, '--delete-branch']);
  ctx.log(`Closed release PR #${step.number}: ${step.reason}`);
}

async function listDispatchedRuns(ctx) {
  return JSON.parse(await ctx.gh([
    'run', 'list', '--repo', ctx.repo, '--workflow', 'release.yml', '--event', 'workflow_dispatch', '--limit', '10', '--json', 'databaseId,status',
  ]));
}

/**
 * The run this command started is the one that was not there before it dispatched. Run ids only
 * grow, so anything above the newest id seen beforehand was created afterwards, even if that
 * listing was short or stale. Comparing GitHub's createdAt with the local clock would miss the
 * run whenever the two clocks differ by more than the allowance, and would take another agent's
 * run that began moments earlier for ours.
 *
 * If several appear at once someone else dispatched too, and the list cannot say whose is whose:
 * it carries no inputs. The workflow queues its runs in one concurrency group, and verifyRelease
 * checks what was actually published, so following the first is safe; it is logged.
 */
async function findDispatchedRun(ctx, newestBefore) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const fresh = (await listDispatchedRuns(ctx))
      .filter((run) => run.databaseId > newestBefore)
      .sort((a, b) => a.databaseId - b.databaseId);
    if (fresh.length > 1) ctx.log(`Several release runs appeared at once (${fresh.map((run) => run.databaseId).join(', ')}); following the first.`);
    if (fresh.length > 0) return fresh[0];
    await ctx.sleep(5000);
  }
  throw new Error('The dispatched release run did not appear. Check the Actions tab; do not dispatch again until you have.');
}

/**
 * Dispatch the verified commit, then follow the run to the end. It never approves
 * a deployment: if the `release` environment still has reviewers, it says so and waits.
 */
export async function dispatchAndWatch(ctx, step, { timeoutMs, pollMs }) {
  const startedAt = ctx.now();
  // Taken before dispatching, so the new run can be told apart from every earlier one.
  const newestBefore = Math.max(0, ...(await listDispatchedRuns(ctx)).map((run) => run.databaseId));
  await ctx.gh(['workflow', 'run', 'release.yml', '--repo', ctx.repo, '-f', `version=${step.version}`, '-f', `expected_sha=${step.tipSha}`]);
  ctx.log(`Dispatched release.yml for v${step.version} pinned to ${step.tipSha.slice(0, 7)}.`);
  const run = await findDispatchedRun(ctx, newestBefore);

  let announcedGate = false;
  for (;;) {
    const view = JSON.parse(await ctx.gh(['run', 'view', String(run.databaseId), '--repo', ctx.repo, '--json', 'status,conclusion,jobs']));
    if (view.status === 'completed') {
      if (view.conclusion === 'success') return { runId: run.databaseId };
      const failed = (view.jobs ?? []).filter((job) => job.conclusion && job.conclusion !== 'success').map((job) => `${job.name}: ${job.conclusion}`);
      throw new Error(`Release run ${run.databaseId} ${view.conclusion}${failed.length > 0 ? ` (${failed.join('; ')})` : ''}.`);
    }
    if (view.status === 'waiting' && !announcedGate) {
      announcedGate = true;
      ctx.log(`Run ${run.databaseId} is waiting for approval of the \`release\` environment. This command does not approve deployments. Remove the required reviewer on that environment, or ask the owner to approve it.`);
    }
    if (ctx.now() - startedAt > timeoutMs) throw Object.assign(new Error(`Release run ${run.databaseId} is still ${view.status}. Run the command again to resume watching.`), { timedOut: true });
    await ctx.sleep(pollMs);
  }
}

/** Confirm what was actually published agrees: tag and GitHub Release assets. */
export async function verifyRelease(ctx, { version, tipSha, packageName, checkNpm = false }) {
  const problems = [];
  const tagSha = (await ctx.git(['ls-remote', '--refs', 'origin', `refs/tags/v${version}`])).split(/\s+/)[0];
  if (tagSha !== tipSha) problems.push(`tag v${version} is at ${tagSha || '(missing)'}, not ${tipSha}`);

  try {
    const release = JSON.parse(await ctx.gh(['release', 'view', `v${version}`, '--repo', ctx.repo, '--json', 'isDraft,isPrerelease,assets']));
    if (release.isDraft) problems.push('the GitHub Release is still a draft');
    if (release.isPrerelease) problems.push('the GitHub Release is marked as a prerelease');
    const names = new Set((release.assets ?? []).map((asset) => asset.name));
    const missing = expectedAssets(version).filter((name) => !names.has(name));
    if (missing.length > 0) problems.push(`the GitHub Release is missing: ${missing.join(', ')}`);
  } catch (error) {
    problems.push(`the GitHub Release could not be read: ${failureText(error)}`);
  }

  if (checkNpm && packageName) {
    let published = '';
    for (let attempt = 0; attempt < 6 && published !== version; attempt += 1) {
      if (attempt > 0) await ctx.sleep(10_000);
      published = await ctx.npm(['view', `${packageName}@${version}`, 'version']).then((out) => out.trim()).catch(() => '');
    }
    if (published !== version) problems.push(`npm does not show ${packageName}@${version}`);
    else {
      const latest = (await ctx.npm(['view', packageName, 'dist-tags.latest']).catch(() => '')).trim();
      if (latest !== version) problems.push(`npm "latest" is ${latest || '(unreadable)'}, not ${version}`);
    }
  }

  return { ok: problems.length === 0, problems };
}

export function describeStep(step) {
  switch (step.action) {
    case 'stop': return step.message;
    case 'done': return step.message;
    case 'wait': return `Waiting: ${step.message}`;
    case 'create-release-pr': return `Next: open a release PR for v${step.version} (${step.bump} bump).`;
    case 'merge-release-pr': return `Next: merge release PR #${step.number} (v${step.version}).`;
    case 'close-release-pr': return `Next: close release PR #${step.number}. ${step.reason}`;
    case 'dispatch': return `Next: dispatch v${step.version} pinned to ${step.tipSha.slice(0, 7)}${step.rerun ? ' (finishing a release that was tagged but not published)' : ''}.`;
    default: return JSON.stringify(step);
  }
}

/**
 * Run the state machine until the release is published, there is nothing to do, or
 * something needs a person. Safe to re-run: it resumes from whatever GitHub shows.
 *
 * Exit codes: 0 released or nothing to release, 1 failed or needs a person,
 * 2 paused, 3 timed out while waiting (run it again to resume).
 */
export async function ship(ctx, { requestedBump, dryRun = false, timeoutMs = 120 * 60_000, pollMs = 30_000, checkNpm = false } = {}) {
  const deadline = ctx.now() + timeoutMs;
  let actions = 0;
  let lastWait = '';
  let lastFailure = null;
  let raced = 0;
  for (;;) {
    let facts;
    try {
      facts = await gatherFacts(ctx, { requestedBump });
    } catch (error) {
      return { code: 1, message: `Could not read the release state, so nothing was changed: ${failureText(error)}` };
    }
    const step = decideNextStep(facts);

    if (step.action === 'done') return { code: 0, message: step.message };
    if (step.action === 'stop') return { code: step.code === 'paused' ? 2 : 1, message: step.message };
    if (dryRun) return { code: 0, message: describeStep(step), step };

    if (step.action === 'wait') {
      if (ctx.now() > deadline) return { code: 3, message: `Timed out. ${describeStep(step)} Run the command again to resume.` };
      const text = describeStep(step);
      if (text !== lastWait) ctx.log(text);
      lastWait = text;
      await ctx.sleep(pollMs);
      continue;
    }

    lastWait = '';
    if ((actions += 1) > 12) {
      return { code: 1, message: `Stopped after too many steps without finishing; something is changing the release state under this command. Look at the open release PR and recent runs.${lastFailure ? ` Last error: ${lastFailure.error}` : ''}` };
    }
    ctx.log(describeStep(step));
    try {
      if (step.action === 'create-release-pr') {
        const created = await createReleasePr(ctx, step, facts);
        if (created?.raced) {
          // Another agent has pushed the release branch but may not have opened its PR yet. Give it time
          // instead of retrying at once, and stop if the branch is orphaned (its agent died).
          if ((raced += 1) > 3) return { code: 1, message: `The branch ${RELEASE_BRANCH} exists but has no open PR after waiting. Open a PR from it or delete it, then run the command again.` };
          await ctx.sleep(pollMs);
        } else raced = 0;
      } else if (step.action === 'merge-release-pr') await mergeReleasePr(ctx, step, facts);
      else if (step.action === 'close-release-pr') await closeReleasePr(ctx, step);
      else if (step.action === 'dispatch') {
        const { runId } = await dispatchAndWatch(ctx, step, { timeoutMs: Math.max(deadline - ctx.now(), pollMs), pollMs });
        const verified = await verifyRelease(ctx, { version: step.version, tipSha: step.tipSha, packageName: facts.packageName, checkNpm });
        if (!verified.ok) return { code: 1, message: `Run ${runId} succeeded but the published result does not agree:\n  - ${verified.problems.join('\n  - ')}` };
        return { code: 0, message: `Released v${step.version} from ${step.tipSha.slice(0, 7)} (run ${runId}); tag and GitHub Release assets agree.` };
      }
    } catch (error) {
      if (error.timedOut) return { code: 3, message: error.message };
      const text = failureText(error);
      if (step.action === 'dispatch') return { code: 1, message: text };
      // Another agent may have just done this step, so re-read once. The same step
      // failing twice in a row is a real problem, not a race.
      if (lastFailure?.action === step.action) return { code: 1, message: `${describeStep(step)} failed twice: ${text}` };
      lastFailure = { action: step.action, error: text };
      ctx.log(`Step failed (${text}); re-reading the release state.`);
      await ctx.sleep(2000);
    }
  }
}
