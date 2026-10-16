# Performance checks

Two kinds of check, both run against seeded, generated data and never against
your real workspaces or assistant history.

| Check | Command | Measures | Where it runs |
|---|---|---|---|
| Rules | `npm run perf:rules` | Work, not time: requests, git processes, full history reads, cancelled requests | Any machine; deterministic |
| Timing | `npm run perf` | What the user waits for in the desktop app, against budgets | The reference machine |

Both need a production build first: `npm run build`. Timing also needs the
packaged desktop app: `npm install --prefix desktop && npm run setup --prefix desktop && npm run pack --prefix desktop`.

## Fixtures

`npm run perf:fixture -- --tier S|M|L --out <dir> [--seed N]` writes a
self-contained home directory with a ContextSpace config, Git repositories,
in-place workspaces with isolated worktrees, and Claude/Codex history.

| Tier | Workspaces | Repositories | History |
|---|---|---|---|
| S | 3 | 1 × 1k files | 10 Codex rollouts, 5 Claude transcripts |
| M | 31 | 20k / 5k / 1k files | 75 Codex (257 MB, max 29 MB), 5 Claude (15 MB) — the reference laptop on 2026-09-28 |
| L | 50 × 3 repos | 100k / 20k / 20k / 5k / 1k files | 500 Codex (1.2 GB, five ≥ 50 MB), 200 Claude (200 MB) |

M and L also include a workspace whose repository path does not exist and a
worktree the app cannot read. The same tier and seed always produce the same
tree and commits.

The harness keeps fixtures in `~/.cache/contextspace-perf` (override with
`CONTEXTSPACE_PERF_DIR`) and regenerates one when the generator changes. It
deliberately avoids `/tmp`, which is often RAM-backed and would hide disk costs.
It refuses to start the app on any home directory that is not a generated
fixture, and clears variables such as `CLAUDE_CONFIG_DIR` and `CODEX_HOME` so
nothing real leaks in.

## Rules

`node perf/rules.mjs [--only R1,R3a] [--idle-seconds 60] [--enforce]` drives the
real backend and production GUI in headless Chromium on tier S:

| Rule | Passes when |
|---|---|
| R1 | A hidden window makes no API requests and starts no git processes |
| R2a | A repeated sessions request re-reads no transcript in full |
| R2b | An idle, visible Code panel starts at most one git process per 10 s |
| R3a | A slow response for a workspace the user left is never shown |
| R3b | Leaving a workspace aborts its in-flight requests |
| R4 | The overview is usable while optional calls are delayed 5 s |
| R5 | New sessions in nested folders and new files appear on the next request |
| R6 | Switching workspaces leaves one plan on screen, and no plan is polled for a workspace the user left |

`--enforce` fails when a rule listed in `perf/rules-enforced.json` does not
pass. Add a rule there in the change that makes it pass.

## Timing

`node perf/timing.mjs --tier M [--runs 20] [--warmup 2] [--idle-minutes 5] [--budgets perf/budgets.json --check]`

Each run launches the packaged app with a fresh profile and times, from the
GUI's `cs:` marks:

- **S1 cold start:** backend ready, shell, cards usable, git status complete, long tasks, memory
- **S2** first workspace open · **S3** cached switch (5 per run) · **S4** diff open · **S5** saved sessions
- **S6 idle:** requests, git runs, backend CPU and memory drift, on the overview and on a workspace

"Cold" means a new app process with a warm OS file cache. Percentiles are
nearest-rank; p95 is shown only with at least 20 samples. With `--check`, a
metric fails when it exceeds its budget by more than the file's tolerance (10%).

Windows open on screen during a run; leave the machine idle and on AC power.
Reports go to `perf/results/` (ignored by Git). Baselines are copied to
`docs/performance/`.

## Endpoint profile

`node perf/profile-api.mjs --tier L [--samples 5] [--cpu-prof]` starts a fresh
backend per sample and times each endpoint the GUI calls at startup, with the
processes, git runs and history reads of each request. Each request is capped at
120 s. `--cpu-prof` also writes a V8 CPU profile of one startup sequence.

## Instrumentation in the product

- **GUI:** `gui/src/lib/perfMarks.ts` records `cs:` User Timing marks and the
  first long tasks. They are inert.
- **Backend:** `src/core/perf-counters.ts` counts child processes, file reads and
  requests only when `CONTEXTSPACE_PERF_COUNTERS=1`, and exposes them at
  `GET /api/perf/counters`. Nothing is patched or registered without the flag.
