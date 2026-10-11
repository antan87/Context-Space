#!/usr/bin/env node
// One command from "this is merged and good" to "it is published and verified".
//
//   npm run release:ship                      # release whatever is unreleased on main
//   npm run release:ship -- --dry-run         # say what the next step would be; change nothing
//   npm run release:ship -- --bump minor      # choose the bump instead of inferring it
//
// It reads GitHub's state, takes the one next step, and repeats, so any agent that
// runs it joins the same release instead of racing to prepare its own. It never
// approves a deployment, cancels a run, or edits settings. Set the repository variable
// RELEASES_PAUSED=true to stop every release at once. Exit codes: 0 released or nothing
// to release, 1 failed or needs a person, 2 paused, 3 timed out (run again to resume).

import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

import { ship } from './release-ship-actions.mjs';

const { values: args } = parseArgs({
  options: {
    bump: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    timeout: { type: 'string', default: '120' },
    poll: { type: 'string', default: '30' },
    repo: { type: 'string' },
    'check-npm': { type: 'boolean', default: false },
  },
});

if (args.bump && !['patch', 'minor', 'major'].includes(args.bump)) {
  console.error('--bump must be patch, minor or major.');
  process.exit(1);
}
const minutes = Number(args.timeout);
const seconds = Number(args.poll);
if (!(minutes > 0) || !(seconds > 0)) {
  console.error('--timeout (minutes) and --poll (seconds) must be positive numbers.');
  process.exit(1);
}

function run(file, fileArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, fileArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status === 0) resolve(stdout);
      else reject(Object.assign(new Error(`${file} ${fileArgs.join(' ')} exited with ${status}`), { stderr: stderr.trim() || stdout.trim(), status }));
    });
  });
}

const stamp = () => new Date().toISOString().slice(11, 19);
const ctx = {
  git: (a, options) => run('git', a, options),
  gh: (a) => run('gh', a),
  npm: (a, options) => run(process.platform === 'win32' ? 'npm.cmd' : 'npm', a, { shell: process.platform === 'win32', ...options }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (message) => console.log(`[${stamp()}] ${message}`),
  repo: args.repo,
};

try {
  ctx.repo ??= (await ctx.gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])).trim();
} catch (error) {
  console.error(`Could not tell which repository this is: ${error.stderr || error.message}`);
  process.exit(1);
}

const result = await ship(ctx, {
  requestedBump: args.bump,
  dryRun: args['dry-run'],
  timeoutMs: minutes * 60_000,
  pollMs: seconds * 1000,
  checkNpm: args['check-npm'],
});
console.log(result.code === 0 ? `\nOK: ${result.message}` : `\nSTOPPED (${result.code}): ${result.message}`);
process.exit(result.code);
