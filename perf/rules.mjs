#!/usr/bin/env node
/**
 * Deterministic performance rules (design review v2 §6A).
 *
 * Each rule drives the real backend and production GUI on a seeded fixture and
 * counts *work* — API requests, git processes, full transcript reads — rather
 * than time, so the verdict is the same on any machine. Network timing that a
 * race depends on is made deterministic with Playwright request interception.
 *
 *   node perf/rules.mjs [--tier S] [--only R1,R3a] [--idle-seconds 60] [--enforce]
 *
 * --enforce exits non-zero when a rule listed in perf/rules-enforced.json does
 * not pass. Rules move into that list once they pass, so they cannot regress.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, startBackend } from './lib/backend.mjs';
import { ensureFixture, stopFixtureDaemons } from './lib/fixtures.mjs';
import { pageNow, readMarks, waitForMark } from './lib/marks.mjs';
import { loadPlaywright } from './lib/playwright.mjs';

const WS = ['perf-ws-000', 'perf-ws-001', 'perf-ws-002'];
const sumRequests = (c) => Object.values(c.requests).reduce((n, r) => n + r.count, 0);
const requestsMatching = (c, re) => Object.entries(c.requests).filter(([k]) => re.test(k)).reduce((n, [, r]) => n + r.count, 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openOverview(ctx, page) {
  await page.goto(`${ctx.backend.base}/#/overview`);
  await waitForMark(page, 'cs:overview-status-complete', { timeout: 60_000 });
}

async function openWorkspace(ctx, page, id, tab = '') {
  const since = await pageNow(page);
  await page.evaluate((h) => { location.hash = h; }, `#/workspaces/${id}${tab ? `/${tab}` : ''}`);
  await waitForMark(page, 'cs:ws-header', { match: { id }, since });
  return since;
}

/** Opens `id` with its Code section beside the chat; waits until files are listed. */
async function openCodePanel(ctx, page, id) {
  await openOverview(ctx, page);
  const listed = page.waitForResponse((r) => r.url().includes(`/api/workspace/${id}/changes`) && r.ok(), { timeout: 20_000 });
  await openWorkspace(ctx, page, id, 'changes');
  await listed;
  await page.getByRole('region', { name: 'Code', exact: true }).waitFor({ timeout: 20_000 });
  await sleep(3_000); // first load settles
}

/**
 * Tells the app its window is hidden, as minimising the desktop window does.
 * Headless Chromium never reports a background tab as hidden, so the signal
 * the app listens to (visibilityState + visibilitychange, and blur) is
 * emitted directly. Timers keep running unthrottled, so any polling the app
 * itself does not stop is still counted.
 */
async function hide(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
  });
  return page.evaluate(() => document.visibilityState);
}

// ─── Rules ───────────────────────────────────────────────────────────────────

const RULES = {
  R1: {
    title: 'Nothing polls in the background',
    expected: '0 API requests and 0 git processes while the window is hidden, apart from the check that alerts you when an AI waits for you',
    async run(ctx) {
      const cases = [];
      for (const [label, open] of [
        ['overview', (p) => openOverview(ctx, p)],
        ['workspace overview', async (p) => { await openOverview(ctx, p); await openWorkspace(ctx, p, WS[0]); await sleep(1_500); }],
        ['code panel', (p) => openCodePanel(ctx, p, WS[0])],
      ]) {
        const page = await ctx.context.newPage();
        await open(page);
        const state = await hide(page);
        await sleep(1_000); // let requests already in flight finish
        await ctx.backend.counters(true);
        await sleep(ctx.idleMs);
        const c = await ctx.backend.counters();
        // An open chat keeps asking whether its AI waits for the user even while the window is hidden: being away
        // is when that alert matters (useInputRequests). It runs no git; anything else in the background fails.
        const alerts = requestsMatching(c, /^GET \/api\/attention$/);
        cases.push({ case: label, visibility: state, requests: sumRequests(c) - alerts, alertChecks: alerts, git: c.spawns.git ?? 0, byRoute: c.requests });
        await page.close();
      }
      if (cases.some((c) => c.visibility !== 'hidden')) return { verdict: 'inconclusive', reason: 'The browser did not report the page as hidden.', cases };
      return { verdict: cases.every((c) => c.requests === 0 && c.git === 0) ? 'pass' : 'fail', cases };
    },
  },

  R2a: {
    title: 'Unchanged session history is not re-read',
    expected: '0 full transcript reads on a repeated sessions request',
    async run(ctx) {
      const url = `/api/workspace/${WS[0]}/sessions`;
      await ctx.backend.json(url);
      await ctx.backend.counters(true);
      const again = await ctx.backend.json(url);
      const c = await ctx.backend.counters();
      const full = (c.reads.claude?.readFiles ?? 0) + (c.reads.codex?.readFiles ?? 0);
      const bytes = (c.reads.claude?.bytes ?? 0) + (c.reads.codex?.bytes ?? 0);
      return { verdict: full === 0 ? 'pass' : 'fail', observed: { fullReads: full, historyBytesRead: bytes, sessions: again.sessions.length } };
    },
  },

  R2b: {
    title: 'An open Code panel does not rescan an unchanged repo',
    expected: `at most 1 git process per 10 s tick while visible and idle`,
    async run(ctx) {
      const page = await ctx.context.newPage();
      try {
        await openCodePanel(ctx, page, WS[0]);
      } catch (error) {
        await page.close();
        return { verdict: 'inconclusive', reason: `Could not open the Code panel: ${String(error.message).split('\n')[0]}` };
      }
      await ctx.backend.counters(true);
      await sleep(ctx.idleMs);
      const c = await ctx.backend.counters();
      await page.close();
      // Only processes started by the panel's own requests; overview status
      // polling (≤ 24 workspaces) is a separate cost.
      const git = Object.entries(c.spawnsByRequest)
        .filter(([request]) => /\/changes/.test(request))
        .reduce((n, [, byName]) => n + (byName.git ?? 0), 0);
      const allowed = Math.floor(ctx.idleMs / 10_000);
      return { verdict: git <= allowed ? 'pass' : 'fail', observed: { gitProcesses: git, allowedPer: `${allowed} in ${ctx.idleMs / 1000} s`, allGitProcesses: c.spawns.git ?? 0, changesRequests: requestsMatching(c, /\/changes/), byRoute: Object.fromEntries(Object.entries(c.requests).map(([k, v]) => [k, v.count])) } };
    },
  },

  R3a: {
    title: 'A slow response never shows under another workspace',
    expected: 'no workspace data applied for A or B after switching to C',
    async run(ctx) {
      const page = await ctx.context.newPage();
      try {
        await openOverview(ctx, page);
        // A's changes and sessions arrive 1.5 s late, after the user has moved on.
        await page.route(new RegExp(`/api/workspace/${WS[0]}/(changes|sessions)`), async (route) => {
          const response = await route.fetch();
          await sleep(1_500);
          await route.fulfill({ response }).catch(() => {});
        });
        await openWorkspace(ctx, page, WS[0]);
        await openWorkspace(ctx, page, WS[1]);
        const switchedAt = await openWorkspace(ctx, page, WS[2]);
        await sleep(3_000);
        const stale = (await readMarks(page)).filter((m) =>
          m.name === 'cs:ws-data' && m.at >= switchedAt && m.detail.applied && m.detail.id !== WS[2]);
        return { verdict: stale.length === 0 ? 'pass' : 'fail', observed: { staleApplied: stale.map((m) => `${m.detail.id}:${m.detail.kind}`) } };
      } finally {
        await page.close();
      }
    },
  },

  R3b: {
    title: 'Leaving a workspace cancels its requests',
    expected: 'every held request for A and B is aborted by the app',
    async run(ctx) {
      const page = await ctx.context.newPage();
      const held = [];
      try {
        await openOverview(ctx, page);
        const pattern = new RegExp(`/api/workspace/(${WS[0]}|${WS[1]})/`);
        await page.route(pattern, (route) => { held.push(route); });
        const aborted = new Set();
        page.on('requestfailed', (r) => { if (pattern.test(r.url())) aborted.add(r.url()); });
        await openWorkspace(ctx, page, WS[0]);
        await openWorkspace(ctx, page, WS[1]);
        await openWorkspace(ctx, page, WS[2]);
        await sleep(1_000);
        const urls = held.map((r) => r.request().url().replace(ctx.backend.base, ''));
        const notAborted = urls.filter((u) => !aborted.has(ctx.backend.base + u));
        return {
          verdict: held.length === 0 ? 'inconclusive' : notAborted.length === 0 ? 'pass' : 'fail',
          observed: { held: urls.length, notAborted },
        };
      } finally {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        for (const route of held) await route.continue().catch(() => {});
        await page.close();
      }
    },
  },

  R4: {
    title: 'Startup does not wait for optional work',
    expected: 'overview usable before delayed status, session and detection calls return',
    async run(ctx) {
      const delayMs = 5_000;
      const page = await ctx.context.newPage();
      try {
        const optional = /\/api\/(workspaces\/status|workspace\/[^/]+\/sessions|ai-detect|editor-detect|workspace-launch-targets|update-status)/;
        await page.route(optional, async (route) => { await sleep(delayMs); await route.continue().catch(() => {}); });
        await page.goto(`${ctx.backend.base}/#/overview`);
        const usable = await waitForMark(page, 'cs:overview-usable', { timeout: 30_000 });
        const threshold = delayMs - 1_000;
        return { verdict: usable.at < threshold ? 'pass' : 'fail', observed: { usableAtMs: Math.round(usable.at), delayedByMs: delayMs, thresholdMs: threshold } };
      } finally {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.close();
      }
    },
  },

  R5: {
    title: 'Caches notice nested changes',
    expected: 'new Claude and Codex sessions and a new file appear on the next request',
    async run(ctx) {
      const home = ctx.fixture.home;
      const workspacePath = path.join(home, 'dev', 'workspaces', WS[0]);
      const manifest = JSON.parse(await fs.readFile(path.join(workspacePath, 'contextspace.json'), 'utf8'));
      const worktree = Object.values(manifest.isolatedRepos)[0].worktreePath;
      // Warm every cache first.
      await ctx.backend.json(`/api/workspace/${WS[0]}/sessions`);
      await ctx.backend.json('/api/workspaces/status?offset=0&limit=24');
      await ctx.backend.json(`/api/workspace/${WS[0]}/changes`);

      const created = [];
      const claudeId = randomUUID();
      const codexId = randomUUID();
      const claudeFile = path.join(home, '.claude', 'projects', workspacePath.replace(/[^a-zA-Z0-9]/g, '-'), `${claudeId}.jsonl`);
      const codexDir = path.join(home, '.codex', 'sessions', '2027', '01', '15'); // a day folder that does not exist yet
      const codexFile = path.join(codexDir, `rollout-2027-01-15T10-00-00-${codexId}.jsonl`);
      const newFile = path.join(worktree, 'perf-r5', 'nested', 'added.ts');
      try {
        const now = new Date().toISOString();
        await fs.writeFile(claudeFile, JSON.stringify({ type: 'user', sessionId: claudeId, cwd: workspacePath, timestamp: now, message: { role: 'user', content: 'R5 probe' } }) + '\n');
        created.push(claudeFile);
        await fs.mkdir(codexDir, { recursive: true });
        created.push(path.join(home, '.codex', 'sessions', '2027'));
        await fs.writeFile(codexFile, [
          JSON.stringify({ timestamp: now, type: 'session_meta', payload: { id: codexId, timestamp: now, cwd: workspacePath } }),
          JSON.stringify({ timestamp: now, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'R5 probe' }] } }),
        ].join('\n') + '\n');
        await fs.mkdir(path.dirname(newFile), { recursive: true });
        await fs.writeFile(newFile, 'export const r5 = true;\n');
        created.push(path.join(worktree, 'perf-r5'));

        const sessions = (await ctx.backend.json(`/api/workspace/${WS[0]}/sessions`)).sessions;
        const changes = (await ctx.backend.json(`/api/workspace/${WS[0]}/changes`)).changes;
        const observed = {
          newClaudeSession: sessions.some((s) => s.id === claudeId),
          newCodexSession: sessions.some((s) => s.id === codexId),
          newFileInChanges: changes.some((r) => r.files.some((f) => f.file.includes('perf-r5'))),
        };
        return { verdict: Object.values(observed).every(Boolean) ? 'pass' : 'fail', observed };
      } finally {
        for (const p of created.reverse()) await fs.rm(p, { recursive: true, force: true });
      }
    },
  },

  R6: {
    title: 'Switching workspaces leaves one plan on screen',
    expected: 'one visible plan after switching back and forth, and no plan polled for a workspace the user left',
    async run(ctx) {
      const page = await ctx.context.newPage();
      const workspaceDir = (id) => path.join(ctx.fixture.home, 'dev', 'workspaces', id);
      // What a run writes: the plan, and what ContextSpace keeps about it. Each is put back as it was.
      const files = (id) => ['PLAN.md', '.contextspace/plan-seen.json', '.contextspace/plan-changes.jsonl'].map((file) => path.join(workspaceDir(id), file));
      const saved = new Map();
      try {
        for (const id of [WS[0], WS[1]]) {
          for (const file of files(id)) saved.set(file, await fs.readFile(file, 'utf8').catch(() => null));
          // As an AI writes it: straight into the file.
          await fs.writeFile(files(id)[0], `# ${id}\n\n## Checkpoints\n\n- [ ] R6 plan of ${id}\n`);
        }
        await openOverview(ctx, page);
        const plans = page.getByRole('region', { name: 'The plan', exact: true });
        const seen = [];
        for (const id of [WS[0], WS[1], WS[0], WS[1]]) {
          await openWorkspace(ctx, page, id, 'plan');
          await plans.filter({ hasText: `R6 plan of ${id}` }).first().waitFor({ timeout: 20_000 });
          seen.push({ workspace: id, visiblePlans: await plans.count() });
        }
        await sleep(2_000);
        await ctx.backend.counters(true);
        await sleep(31_000); // one of the plan's 30 s polls
        const c = await ctx.backend.counters();
        const leftBehind = Object.entries(c.requests)
          .filter(([request]) => /\/plan(\?|$)/.test(request) && !request.includes(`/${WS[1]}/`))
          .map(([request, r]) => `${request} ×${r.count}`);
        const pass = seen.every((s) => s.visiblePlans === 1) && leftBehind.length === 0;
        return { verdict: pass ? 'pass' : 'fail', observed: { seen, plansPolledForWorkspacesLeft: leftBehind } };
      } finally {
        await page.close();
        // The fixture is shared between runs: put the files back as they were.
        for (const [file, content] of saved) {
          if (content === null) await fs.rm(file, { force: true });
          else await fs.writeFile(file, content);
        }
      }
    },
  },
};

// ─── Runner ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { tier: 'S', seed: 1, idleSeconds: 60, only: null, enforce: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tier') args.tier = argv[++i];
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--idle-seconds') args.idleSeconds = Number(argv[++i]);
    else if (a === '--only') args.only = argv[++i].split(',');
    else if (a === '--enforce') args.enforce = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

export async function runRules(options = {}) {
  const args = { tier: 'S', seed: 1, idleSeconds: 60, only: null, ...options };
  const fixture = await ensureFixture({ tier: args.tier, seed: args.seed, faults: false, log: console.error });
  const backend = await startBackend({ home: fixture.home });
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const ctx = { backend, context: null, fixture, idleMs: args.idleSeconds * 1000 };
  const results = [];
  try {
    for (const [id, rule] of Object.entries(RULES)) {
      if (args.only && !args.only.includes(id)) continue;
      const started = Date.now();
      let result;
      // A fresh context per rule: the app keeps UI state (open chat, layout) in localStorage.
      ctx.context = await browser.newContext({ viewport: { width: 1450, height: 950 } });
      try {
        result = await rule.run(ctx);
      } catch (error) {
        result = { verdict: 'error', reason: String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ') };
      } finally {
        await ctx.context.close();
      }
      results.push({ id, title: rule.title, expected: rule.expected, ...result, seconds: Math.round((Date.now() - started) / 1000) });
      console.error(`${id.padEnd(4)} ${result.verdict.toUpperCase().padEnd(12)} ${rule.title}`);
    }
  } finally {
    await browser.close();
    await backend.stop();
    await stopFixtureDaemons(fixture.home);
  }
  return { tier: args.tier, seed: args.seed, idleSeconds: args.idleSeconds, fixtureDigest: fixture.treeDigest, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const report = await runRules(args);
  const outDir = path.join(REPO_ROOT, 'perf', 'results');
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `rules-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  console.error(`Report: ${path.relative(REPO_ROOT, file)}`);
  if (args.enforce) {
    const listFile = path.join(REPO_ROOT, 'perf', 'rules-enforced.json');
    const enforced = existsSync(listFile) ? JSON.parse(readFileSync(listFile, 'utf8')).enforced : [];
    const broken = report.results.filter((r) => enforced.includes(r.id) && r.verdict !== 'pass');
    for (const r of broken) console.error(`Enforced rule ${r.id} did not pass: ${r.verdict}`);
    process.exit(broken.length ? 1 : 0);
  }
}
