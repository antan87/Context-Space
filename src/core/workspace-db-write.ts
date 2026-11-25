/** Database writes shared by the app, CLI and MCP. The compiled runtime hands SQLite writes to a worker. */
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { readPlanView } from './plan-db-app.js';
import type { BoardBatchView } from './board-db-app.js';
import { withAppDbWriteLock, writeAppDb } from './workspace-db-app.js';
import { PlanFileError } from './plan-file.js';
import { publishExports } from './workspace-db-exports.js';
import {
  applyBatch, finishCheckRun, getRevision, openWorkspaceDbAsync, readWithRetry, startCheckRun, WorkspaceDbError,
  type BatchResult, type CheckRun, type Op, type WorkspaceDb, type WorkspaceDbErrorCode,
} from './workspace-db/index.js';
import { doDraftAction, type DraftAction, type DraftResults } from './workspace-db-drafts.js';
import type { SeenDbChange } from './whats-new.js';

export interface DbBatchOptions {
  by: string;
  ifRevision?: number;
  dbId?: string;
  requestId?: string;
  strictRevision?: boolean;
  /** The translator read this revision to resolve inputs, so it cannot authorize replacing content. */
  implicitRevision?: boolean;
  requestSource?: string;
}

type BatchWrite = { ops: Op[]; options: DbBatchOptions };
type Write = DraftAction
  | ({ type: 'batch' } & BatchWrite)
  | ({ type: 'board-batch' } & BatchWrite)
  | ({ type: 'plan-batch' } & BatchWrite)
  | { type: 'check-start'; id: string; options: Parameters<typeof startCheckRun>[2] }
  | { type: 'check-finish'; id: number; outcome: Parameters<typeof finishCheckRun>[2] }
  | { type: 'seen'; change: SeenDbChange };

type Results = DraftResults & {
  batch: BatchResult;
  'board-batch': { result: BatchResult; view?: BoardBatchView };
  'plan-batch': { result: BatchResult; plan?: ReturnType<typeof readPlanView> };
  'check-start': CheckRun;
  'check-finish': CheckRun;
  seen: void;
};
type Reply = { result: Results[Write['type']] } | { error: string; name?: string; code?: WorkspaceDbErrorCode; planCode?: PlanFileError['code'] };

async function performWrite(root: string, db: WorkspaceDb, write: Write): Promise<Results[Write['type']]> {
  switch (write.type) {
    case 'draft-refresh':
    case 'draft-capture-git':
    case 'draft-list':
    case 'draft-preview':
    case 'draft-import':
    case 'draft-discard':
      return doDraftAction(root, db, write);
    case 'check-start': return startCheckRun(db, write.id, write.options);
    case 'check-finish': return finishCheckRun(db, write.id, write.outcome);
    case 'seen': {
      const { writeSeenInDb } = await import('./whats-new.js');
      return writeSeenInDb(db, write.change);
    }
    case 'batch':
    case 'board-batch':
    case 'plan-batch': {
      const { ops, options } = write;
      const live = options.ifRevision === undefined || options.dbId === undefined
        ? await readWithRetry(db, () => getRevision(db)) : null;
      if (options.dbId === undefined && (options.ifRevision !== undefined || ops.some((op) => op?.rev !== undefined))) {
        const result: BatchResult = { ok: false, revision: live!.revision, errors: [{
          op: null, code: 'db_changed', dbId: live!.dbId, message: 'Send the dbId from the same read as ifRevision or rev. Read the workspace again.',
        }] };
        return write.type === 'batch' ? result : { result };
      }
      let view: BoardBatchView | undefined;
      let plan: ReturnType<typeof readPlanView> | undefined;
      const readBoardBatch = write.type === 'board-batch' ? (await import('./board-db-app.js')).readBoardBatch : undefined;
      const readPlan = write.type === 'plan-batch' ? (await import('./plan-db-app.js')).readPlanView : undefined;
      const snapshot: WorkspaceDb = { ...db, snapshot: true };
      const result = await applyBatch(db, {
        ops, ifRevision: options.ifRevision ?? live!.revision, dbId: options.dbId ?? live!.dbId, requestId: options.requestId,
      }, {
        by: options.by, strictRevision: options.strictRevision, implicitRevision: options.implicitRevision ?? options.ifRevision === undefined,
        requestSource: options.requestSource,
        capture: (saved) => {
          if (readBoardBatch) view = readBoardBatch(snapshot, saved);
          if (readPlan) plan = readPlan(snapshot);
        },
      });
      if (result.ok) {
        await publishExports(root, db).catch((error: unknown) => {
          process.stderr.write(`PLAN.md and contextspace-data.json were not written: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }
      if (write.type === 'batch') return result;
      return write.type === 'board-batch' ? { result, view } : { result, plan };
    }
  }
}

const pendingWrites = new Set<Promise<unknown>>();
let stopping = false;
const WORKER_TIMEOUT_MS = 15_000;

/** Called on server shutdown. New writes refuse while all previously accepted writes settle. */
export async function drainDbWrites(): Promise<void> {
  stopping = true;
  await Promise.allSettled([...pendingWrites]);
}

export async function runDbWrite<W extends Write>(root: string, write: W): Promise<Results[W['type']]> {
  if (stopping) throw new Error('The workspace server is shutting down. Try again when it is running.');
  const pending = dispatch(root, write);
  pendingWrites.add(pending);
  try { return await pending as Results[W['type']]; }
  finally { pendingWrites.delete(pending); }
}

class WorkerLostError extends Error {}

async function dispatch(root: string, write: Write): Promise<Results[Write['type']]> {
  // Source-level tests exercise the same operation on their held connection, including the SQLite and export seams.
  if (import.meta.url.endsWith('.ts')) {
    return writeAppDb(root, (db) => performWrite(root, db, write), { retry: false });
  }
  return withAppDbWriteLock(root, async () => {
    try { return await workerWrite(root, write); }
    catch (error) {
      if (!(error instanceof WorkerLostError)) throw error;
      const requestId = 'ops' in write ? write.options.requestId : undefined;
      if (requestId) {
        // The reply may have been lost after COMMIT. With the fence still held, replay that exact request.
        try { return await workerWrite(root, write); }
        catch { throw new Error(`Could not confirm the database write. Retry with the same requestId "${requestId}".`); }
      }
      throw new Error('Could not confirm the database write. Read the workspace before retrying.');
    }
  });
}

/** Reconcile fetched Git data while the caller still owns the normal plan write fence. */
export async function runGitDraftWithWriteLockHeld<W extends Extract<DraftAction, { type: 'draft-refresh' | 'draft-capture-git' }>>(root: string, write: W): Promise<Results[W['type']]> {
  if (!import.meta.url.endsWith('.ts')) {
    return await workerWrite(root, write) as Results[W['type']];
  }
  const db = await openWorkspaceDbAsync(root, { busy: 'server' });
  try { return await performWrite(root, db, write) as Results[W['type']]; }
  finally { db.close(); await db.idle(); }
}

function workerWrite(root: string, write: Write): Promise<Results[Write['type']]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { root, write }, execArgv: [] });
    let failure: Error | undefined;
    const deadline = setTimeout(() => {
      failure = new WorkerLostError('Workspace database worker took too long to reply.');
      void worker.terminate().catch(() => undefined);
    }, WORKER_TIMEOUT_MS);
    worker.once('message', (reply: Reply) => {
      if (failure) return;
      clearTimeout(deadline);
      if ('result' in reply) resolve(reply.result);
      else if (reply.planCode) reject(new PlanFileError(reply.error, reply.planCode));
      else if (reply.code) reject(new WorkspaceDbError(reply.code, reply.error));
      else reject(Object.assign(new Error(reply.error), { name: reply.name ?? 'Error' }));
    });
    worker.once('error', (error) => { failure = new WorkerLostError(error instanceof Error ? error.message : String(error)); });
    worker.once('exit', (code) => {
      clearTimeout(deadline);
      reject(failure ?? new WorkerLostError(`Workspace database worker exited without an answer (code ${code}).`));
    });
  });
}

// Loading this module in the app only registers the dispatcher. Each worker owns its database connection.
if (!isMainThread && parentPort && workerData?.write) {
  const port = parentPort;
  const { root, write } = workerData as { root: string; write: Write };
  void (async () => {
    let db: WorkspaceDb | undefined;
    try {
      db = await openWorkspaceDbAsync(root, { busy: 'server' });
      const result = await performWrite(root, db, write);
      db.close();
      port.postMessage({ result } satisfies Reply);
    } catch (error) {
      db?.close();
      port.postMessage({
        error: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
        ...(error instanceof WorkspaceDbError ? { code: error.code } : {}),
        ...(error instanceof PlanFileError ? { planCode: error.code } : {}),
      } satisfies Reply);
    } finally {
      await db?.idle();
    }
  })();
}
