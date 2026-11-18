/**
 * @module core/workspace-db/testing
 * Helpers for this module's tests: temp workspaces, a transpiled copy of the module for child processes, and a way to
 * run a script in a child. Not imported by any other code. (It ships in `dist` because the build includes every
 * non-test file under `src`; it is small and inert.)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createRequire } from 'node:module';

import { applyBatch as realApplyBatch, type BatchInput, type BatchResult } from './batch.js';
import { undo as realUndo, type UndoResult } from './undo.js';
import { createWorkspaceDb, openWorkspaceDb, type BusyMode, type WorkspaceDb } from './connection.js';
import { importPlanText } from './plan-io.js';
import type { Op } from './ops.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Loaded with require so a test run does not make Vite read TypeScript's own source maps.
const loadTypescript = () => createRequire(import.meta.url)('typescript') as typeof import('typescript');

export const SAMPLE_PLAN = readFileSync(path.join(here, 'fixtures', 'sample-plan.md'), 'utf8');

const made: string[] = [];

/** A fresh temp workspace folder (the only place a test may open a database). */
export function tempWorkspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wsdb-'));
  made.push(dir);
  return dir;
}

export function cleanTemp(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Creates the database when there is none, otherwise opens it (read-only when asked). */
export function openTest(workspace: string, busy: BusyMode = 'cli', extra: { readOnly?: boolean; backups?: boolean } = {}): WorkspaceDb {
  if (extra.readOnly) return openWorkspaceDb(workspace, { busy, backups: extra.backups ?? false, readOnly: true });
  return createWorkspaceDb(workspace, { busy, backups: extra.backups ?? false });
}

export const dbIdOf = (db: WorkspaceDb): string => (db.sqlite.prepare("SELECT value FROM meta WHERE key = 'db_id'").get() as { value: string }).value;

/** `applyBatch`, with the database's own `dbId` filled in when a test did not name one (a batch needs it). */
export function applyBatch(db: WorkspaceDb, batch: Omit<BatchInput, 'dbId'> & { dbId?: string }, options: { by: string }): Promise<BatchResult> {
  return realApplyBatch(db, { ...batch, dbId: 'dbId' in batch ? batch.dbId : dbIdOf(db) } as BatchInput, options);
}

/** A temp workspace with a database holding `plan` (the sample plan by default). */
export async function seeded(plan: string = SAMPLE_PLAN, busy: BusyMode = 'cli'): Promise<{ ws: string; db: WorkspaceDb }> {
  const ws = tempWorkspace();
  const db = openTest(ws, busy);
  await importPlanText(db, plan, { by: 'import' });
  return { ws, db };
}

export const rev = (db: WorkspaceDb): number => Number((db.sqlite.prepare("SELECT value FROM meta WHERE key = 'revision'").get() as { value: string }).value);

/** Applies ops at the current revision as `by`, expecting success. */
export async function apply(db: WorkspaceDb, ops: Op[], by = 'user'): Promise<Extract<BatchResult, { ok: true }>> {
  const result = await realApplyBatch(db, { ifRevision: rev(db), dbId: dbIdOf(db), ops }, { by });
  if (!result.ok) throw new Error(`batch refused: ${result.errors.map((e) => e.message).join(' | ')}`);
  return result;
}

/** Id of the block whose name equals `name` (first match). */
export function idOf(db: WorkspaceDb, name: string): string {
  const row = db.sqlite.prepare('SELECT id FROM blocks WHERE name = ? ORDER BY ord LIMIT 1').get(name) as { id: string } | undefined;
  if (!row) throw new Error(`no block named ${name}`);
  return row.id;
}

// ─── Child processes ────────────────────────────────────────────────────────

let moduleCopy: string | null = null;

/** Transpiles this module (without tests) into a temp folder, so a child process can import plain JavaScript. */
export function moduleForChildren(): string {
  if (moduleCopy) return moduleCopy;
  const ts = loadTypescript();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wsdb-mod-'));
  // shared by every test in this process; removed when the process ends
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  mkdirSync(path.join(dir, 'wsdb'));
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const name of readdirSync(here)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'testing.ts') continue;
    const source = readFileSync(path.join(here, name), 'utf8');
    const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    writeFileSync(path.join(dir, 'wsdb', name.replace(/\.ts$/, '.js')), out.outputText);
  }
  moduleCopy = dir;
  return dir;
}

export interface Child {
  proc: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** Resolves with the exit code and signal. */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Resolves when stdout has printed the marker line. */
  waitFor: (marker: string, timeoutMs?: number) => Promise<void>;
}

/**
 * Runs `script` (ES module source) in a child node process. The script may `import` from the module as
 * `import * as db from '<MODULE>'`; `<MODULE>` is replaced by the file URL of the transpiled index. The child's stdout and
 * stderr go to files in the temp folder, not pipes: a sandbox that drops piped child output (or closes it early) cannot
 * lose what the child said, and a marker is found by reading the file.
 */
export function runChild(script: string, env: Record<string, string> = {}): Child {
  const dir = moduleForChildren();
  const id = Math.random().toString(36).slice(2);
  const file = path.join(dir, `child-${id}.mjs`);
  const outFile = path.join(dir, `child-${id}.out`);
  const errFile = path.join(dir, `child-${id}.err`);
  writeFileSync(file, script.replaceAll('<MODULE>', pathToFileURL(path.join(dir, 'wsdb', 'index.js')).href));
  writeFileSync(outFile, '');
  writeFileSync(errFile, '');
  const outFd = openSync(outFile, 'a');
  const errFd = openSync(errFile, 'a');
  const proc = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', outFd, errFd] });
  closeSync(outFd);
  closeSync(errFd);
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { proc.on('close', (code, signal) => resolve({ code, signal })); });
  return {
    proc, stdout: () => read(outFile), stderr: () => read(errFile), done,
    waitFor: async (marker, timeoutMs = 15_000) => {
      const until = Date.now() + timeoutMs;
      while (!read(outFile).includes(marker)) {
        if (Date.now() > until) throw new Error(`child did not print ${marker}; stdout: ${read(outFile)}; stderr: ${read(errFile)}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

/** `undo`, with the database's own `dbId` filled in when a test did not name one. */
export function undo(db: WorkspaceDb, seq: number, options: { by: string; dbId?: string }): Promise<UndoResult> {
  return realUndo(db, seq, { ...options, dbId: options.dbId ?? dbIdOf(db) });
}
