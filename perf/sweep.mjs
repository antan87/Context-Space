#!/usr/bin/env node
/**
 * Work sweep: what the app costs through a session of ordinary use, phase by phase.
 *
 * Drives the real backend and production GUI on a seeded fixture through startup, opening a workspace, a minute
 * idle on the chat, the plan and the code, twenty switches across up to five workspaces, and a minute idle after them.
 * Each phase reports requests by route, git processes by route, history read and backend CPU (Linux), and the
 * slowest routes over the whole run. The idle minute after the switches should cost what the one before them did:
 * more means something the user left keeps working. Page elements and listeners before and after the switches
 * show what stays behind.
 *
 *   node perf/sweep.mjs [--tier L] [--idle-seconds 60]
 *
 * Numbers are counts, not times, apart from CPU and the route latencies, so they compare across runs of one tier.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { REPO_ROOT, startBackend } from './lib/backend.mjs';
import { ensureFixture, stopFixtureDaemons } from './lib/fixtures.mjs';
import { pageNow, waitForMark } from './lib/marks.mjs';
import { loadPlaywright } from './lib/playwright.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byWorkspace = (key) => key.replace(/perf-ws-\d+/g, ':ws');

/** Backend CPU seconds, its reaped children (git) included. Linux only; null elsewhere. */
function cpuSeconds(pid) {
  const file = `/proc/${pid}/stat`;
  if (!existsSync(file)) return null;
  const fields = readFileSync(file, 'utf8').split(') ')[1].split(' ');
  return (Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14])) / 100;
}

function parseArgs(argv) {
  const args = { tier: 'L', seed: 1, idleSeconds: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--tier') args.tier = argv[++i];
    else if (argv[i] === '--seed') args.seed = Number(argv[++i]);
    else if (argv[i] === '--idle-seconds') args.idleSeconds = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const idleMs = args.idleSeconds * 1000;
const fixture = await ensureFixture({ tier: args.tier, seed: args.seed, faults: false, log: console.error });
const backend = await startBackend({ home: fixture.home });
const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const report = { tier: args.tier, seed: args.seed, idleSeconds: args.idleSeconds, fixtureDigest: fixture.treeDigest, phases: {}, latency: {} };
const timings = [];
try {
  // The fixture's workspaces, up to five: tier S has three.
  const ids = (await backend.json('/api/workspaces')).map((w) => w.branchName).filter((id) => id.startsWith('perf-ws-')).sort().slice(0, 5);
  const ws = (n) => ids.at(n % ids.length);
  const context = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  const page = await context.newPage();
  page.on('requestfinished', (request) => {
    if (!request.url().includes('/api/')) return;
    const t = request.timing();
    if (t.responseStart > 0) timings.push({ route: `${request.method()} ${byWorkspace(new URL(request.url()).pathname)}`, ms: t.responseStart - t.requestStart });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const pageMetrics = async () => {
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    const { metrics } = await cdp.send('Performance.getMetrics');
    const get = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
    return { heapMB: +(get('JSHeapUsedSize') / 1e6).toFixed(1), elements: get('Nodes'), listeners: get('JSEventListeners') };
  };

  const phase = async (name, action) => {
    await backend.counters(true);
    const cpu = cpuSeconds(backend.pid);
    const started = Date.now();
    await action();
    const c = await backend.counters();
    const sum = (entries) => Object.fromEntries(Object.entries(entries.reduce((all, [key, n]) => ({ ...all, [byWorkspace(key)]: (all[byWorkspace(key)] ?? 0) + n }), {}))
      .sort((a, b) => b[1] - a[1]));
    const requests = sum(Object.entries(c.requests).map(([key, r]) => [key, r.count]));
    report.phases[name] = {
      seconds: Math.round((Date.now() - started) / 1000),
      backendCpuSeconds: cpu === null ? null : +(cpuSeconds(backend.pid) - cpu).toFixed(2),
      requests: Object.values(requests).reduce((a, b) => a + b, 0),
      git: c.spawns.git ?? 0,
      processes: c.spawns,
      requestsByRoute: requests,
      gitByRoute: sum(Object.entries(c.spawnsByRequest ?? {}).map(([key, byName]) => [key, byName.git ?? 0]).filter(([, n]) => n > 0)),
      historyRead: Object.fromEntries(Object.entries(c.reads).filter(([bucket]) => bucket === 'claude' || bucket === 'codex')
        .map(([bucket, r]) => [bucket, { files: r.readFiles, MB: +(r.bytes / 1e6).toFixed(1) }])),
    };
    const p = report.phases[name];
    console.error(`${name.padEnd(36)} ${String(p.requests).padStart(4)} requests ${String(p.git).padStart(5)} git ${p.backendCpuSeconds ?? '-'} s CPU`);
  };

  let current = null;
  const open = async (id, tab) => {
    const since = await pageNow(page);
    await page.evaluate((hash) => { location.hash = hash; }, `#/workspaces/${id}/${tab}`);
    // The header mark is recorded when the workspace changes, not when only the tab does.
    if (id === current) { await sleep(2_000); return; }
    await waitForMark(page, 'cs:ws-header', { match: { id }, since, timeout: 60_000 });
    current = id;
  };

  await phase('startup to a usable overview', async () => {
    await page.goto(`${backend.base}/#/overview`);
    await waitForMark(page, 'cs:overview-usable', { timeout: 120_000 });
    await sleep(10_000);
  });
  await phase('overview idle', () => sleep(idleMs));
  await phase('open a workspace on the chat', async () => { await open(ws(0), 'chat'); await sleep(10_000); });
  await phase('chat idle', () => sleep(idleMs));
  await phase('plan idle', async () => { await open(ws(0), 'plan'); await sleep(idleMs); });
  await phase('code idle', async () => { await open(ws(0), 'changes'); await sleep(idleMs); });
  await open(ws(0), 'chat');
  await sleep(3_000);
  const before = await pageMetrics();
  await phase(`20 switches across ${ids.length} workspaces`, async () => {
    const tabs = ['chat', 'plan', 'chat', 'changes'];
    for (let i = 0; i < 20; i += 1) { await open(ws(i), tabs.at(i % tabs.length)); await sleep(1_500); }
  });
  await open(ws(0), 'chat');
  await sleep(3_000);
  report.page = { beforeSwitches: before, afterSwitches: await pageMetrics() };
  await phase('chat idle after the switches', () => sleep(idleMs));
} finally {
  await browser.close();
  await backend.stop();
  await stopFixtureDaemons(fixture.home);
}

const byRoute = {};
for (const t of timings) (byRoute[t.route] ??= []).push(t.ms);
report.latency = Object.fromEntries(Object.entries(byRoute).map(([route, list]) => {
  list.sort((a, b) => a - b);
  const at = (q) => Math.round(list[Math.min(list.length - 1, Math.floor(q * list.length))]);
  return [route, { requests: list.length, p50: at(0.5), p95: at(0.95), max: Math.round(list.at(-1)) }];
}).sort((a, b) => b[1].p95 - a[1].p95).slice(0, 20));

const outDir = path.join(REPO_ROOT, 'perf', 'results');
await fs.mkdir(outDir, { recursive: true });
const file = path.join(outDir, `sweep-${args.tier}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(file, JSON.stringify(report, null, 2));
console.error(`Page before → after the switches: ${JSON.stringify(report.page.beforeSwitches)} → ${JSON.stringify(report.page.afterSwitches)}`);
console.error(`Report: ${path.relative(REPO_ROOT, file)}`);
