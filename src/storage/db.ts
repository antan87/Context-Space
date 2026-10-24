/**
 * @module storage/db
 * Server-side SQLite persistence using Node's built-in `node:sqlite` DatabaseSync.
 * Gracefully falls back to a durable in-process store when running on Node < 22.5.
 * Stores chat threads, turns, and approval records durably in ~/.nexusflow/nexusflow.db.
 */

import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { getConfigDir } from '../core/config.js';
import { getErrorCode } from '../utils/errors.js';

export interface IDatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: any[]): any;
    get(...args: any[]): any;
    all(...args: any[]): any[];
  };
  close(): void;
}

export interface StoredChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts?: number;
  kind?: 'error' | 'note';
  executionProfile?: string;
  images?: string[];
  filesChanged?: string[];
}

export interface StoredChatThread {
  workspaceId: string;
  providerId: string | null;
  sessions: Record<string, { id: string; started: boolean; model?: string; effort?: string }>;
  profilesByProvider: Record<string, string>;
  modelsByProvider: Record<string, string>;
  effortsByProvider: Record<string, string>;
  messages: StoredChatMessage[];
  updatedAt: number;
}

export interface StoredApproval {
  id: string;
  workspaceId: string;
  tool: string;
  input: Record<string, unknown>;
  description?: string;
  decision: 'pending' | 'allow' | 'deny';
  createdAt: number;
  resolvedAt?: number;
}

let NodeDatabaseSyncClass: typeof DatabaseSync | null = null;
try {
  const req = createRequire(import.meta.url);
  const sqlite = req('node:sqlite');
  if (sqlite && typeof sqlite.DatabaseSync === 'function') {
    NodeDatabaseSyncClass = sqlite.DatabaseSync;
  }
} catch {
  NodeDatabaseSyncClass = null;
}

/**
 * Lightweight in-memory/JSON database fallback used when node:sqlite is not
 * present in the runtime (e.g. Node 20 or earlier).
 */
export class FallbackDatabase implements IDatabaseSync {
  private targetPath: string;
  private threads = new Map<string, any>();
  private turns = new Map<string, any[]>();
  private approvals = new Map<string, any>();

  private inTransaction = false;
  private stagingThreads = new Map<string, any>();
  private stagingTurns = new Map<string, any[]>();
  private stagingApprovals = new Map<string, any>();

  constructor(targetPath: string) {
    this.targetPath = targetPath;
    this.loadFromDisk();
  }

  private getJsonPaths(): { jsonPath: string; bakPath: string } {
    const jsonPath = this.targetPath.endsWith('.db')
      ? this.targetPath.replace(/\.db$/, '.json')
      : this.targetPath + '.json';
    const bakPath = `${jsonPath}.bak`;
    return { jsonPath, bakPath };
  }

  private getActiveThreads(): Map<string, any> {
    return this.inTransaction ? this.stagingThreads : this.threads;
  }

  private getActiveTurns(): Map<string, any[]> {
    return this.inTransaction ? this.stagingTurns : this.turns;
  }

  private getActiveApprovals(): Map<string, any> {
    return this.inTransaction ? this.stagingApprovals : this.approvals;
  }

  private onMutation(): void {
    if (!this.inTransaction) {
      this.saveToDisk();
    }
  }

  private loadFromDisk(): void {
    if (this.targetPath === ':memory:') return;
    const { jsonPath, bakPath } = this.getJsonPaths();

    let parsedData: any = null;

    try {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      parsedData = JSON.parse(raw);
    } catch (err) {
      if (getErrorCode(err) !== 'ENOENT') {
        console.warn(`[FallbackDatabase] Failed to read or parse ${jsonPath}, attempting backup recovery:`, err);
      }
      parsedData = null;
    }

    if (!parsedData) {
      try {
        const raw = fs.readFileSync(bakPath, 'utf8');
        parsedData = JSON.parse(raw);
      } catch (bakErr) {
        if (getErrorCode(bakErr) !== 'ENOENT') {
          console.warn(`[FallbackDatabase] Failed to read or parse backup ${bakPath}:`, bakErr);
        }
        parsedData = null;
      }
    }

    if (parsedData) {
      if (parsedData.threads) {
        for (const [k, v] of Object.entries(parsedData.threads)) {
          this.threads.set(k, v);
        }
      }
      if (parsedData.turns) {
        for (const [k, v] of Object.entries(parsedData.turns)) {
          this.turns.set(k, v as any[]);
        }
      }
      if (parsedData.approvals) {
        for (const [k, v] of Object.entries(parsedData.approvals)) {
          this.approvals.set(k, v);
        }
      }
    }
  }

  private saveToDisk(
    threadsMap: Map<string, any> = this.threads,
    turnsMap: Map<string, any[]> = this.turns,
    approvalsMap: Map<string, any> = this.approvals,
  ): void {
    if (this.targetPath === ':memory:') return;
    const { jsonPath, bakPath } = this.getJsonPaths();
    const dir = path.dirname(jsonPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }

    const data = {
      threads: Object.fromEntries(threadsMap),
      turns: Object.fromEntries(turnsMap),
      approvals: Object.fromEntries(approvalsMap),
    };
    const content = JSON.stringify(data, null, 2);
    const tempPath = `${jsonPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;

    try {
      fs.writeFileSync(tempPath, content, 'utf8');
      try {
        fs.copyFileSync(jsonPath, bakPath);
      } catch {
        // Ignore backup copy failure, proceed with atomic rename
      }
      fs.renameSync(tempPath, jsonPath);
    } catch (err) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore unlink error
      }
      throw err;
    }
  }

  exec(sql: string): void {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('BEGIN')) {
      this.inTransaction = true;
      this.stagingThreads = new Map(
        Array.from(this.threads.entries()).map(([k, v]) => [k, { ...v }]),
      );
      this.stagingTurns = new Map(
        Array.from(this.turns.entries()).map(([k, v]) => [k, v.map((item) => ({ ...item }))]),
      );
      this.stagingApprovals = new Map(
        Array.from(this.approvals.entries()).map(([k, v]) => [k, { ...v }]),
      );
      return;
    }

    if (trimmed.startsWith('COMMIT')) {
      if (this.inTransaction) {
        // Persist staging maps to disk first; if persistence fails,
        // active maps remain untouched and caller can issue ROLLBACK.
        this.saveToDisk(this.stagingThreads, this.stagingTurns, this.stagingApprovals);
        this.threads = this.stagingThreads;
        this.turns = this.stagingTurns;
        this.approvals = this.stagingApprovals;
        this.inTransaction = false;
        this.stagingThreads = new Map();
        this.stagingTurns = new Map();
        this.stagingApprovals = new Map();
      }
      return;
    }

    if (trimmed.startsWith('ROLLBACK')) {
      if (this.inTransaction) {
        this.inTransaction = false;
        this.stagingThreads = new Map();
        this.stagingTurns = new Map();
        this.stagingApprovals = new Map();
      }
      return;
    }
  }

  prepare(sql: string): {
    run(...args: any[]): any;
    get(...args: any[]): any;
    all(...args: any[]): any[];
  } {
    const normalized = sql.trim().replace(/\s+/g, ' ');
    const self = this;

    if (normalized.startsWith('INSERT INTO chat_threads')) {
      return {
        run(
          workspace_id: string,
          provider_id: string | null,
          sessions_json: string,
          profiles_json: string,
          models_json: string,
          efforts_json: string,
          updated_at: number,
        ) {
          self.getActiveThreads().set(workspace_id, {
            workspace_id,
            provider_id,
            sessions_json,
            profiles_json,
            models_json,
            efforts_json,
            updated_at,
          });
          self.onMutation();
          return { changes: 1 };
        },
        get() { return undefined; },
        all() { return []; },
      };
    }

    if (normalized.startsWith('DELETE FROM chat_turns WHERE workspace_id = ?')) {
      return {
        run(workspace_id: string) {
          self.getActiveTurns().delete(workspace_id);
          self.onMutation();
          return { changes: 1 };
        },
        get() { return undefined; },
        all() { return []; },
      };
    }

    if (normalized.startsWith('INSERT INTO chat_turns')) {
      return {
        run(
          id: string,
          workspace_id: string,
          turn_index: number,
          role: string,
          content: string,
          kind: string | null,
          execution_profile: string | null,
          images_json: string | null,
          files_changed_json: string | null,
          created_at: number,
        ) {
          const map = self.getActiveTurns();
          let list = map.get(workspace_id);
          if (!list) {
            list = [];
            map.set(workspace_id, list);
          }
          list.push({
            id,
            workspace_id,
            turn_index,
            role,
            content,
            kind,
            execution_profile,
            images_json,
            files_changed_json,
            created_at,
          });
          self.onMutation();
          return { changes: 1 };
        },
        get() { return undefined; },
        all() { return []; },
      };
    }

    if (normalized.startsWith('SELECT * FROM chat_threads WHERE workspace_id = ?')) {
      return {
        run() { return {}; },
        get(workspace_id: string) {
          return self.getActiveThreads().get(workspace_id);
        },
        all(workspace_id: string) {
          const item = self.getActiveThreads().get(workspace_id);
          return item ? [item] : [];
        },
      };
    }

    if (normalized.startsWith('SELECT * FROM chat_turns WHERE workspace_id = ?')) {
      return {
        run() { return {}; },
        get(workspace_id: string) {
          const list = self.getActiveTurns().get(workspace_id) || [];
          return list[0];
        },
        all(workspace_id: string) {
          const list = self.getActiveTurns().get(workspace_id) || [];
          return [...list].sort((a, b) => a.turn_index - b.turn_index);
        },
      };
    }

    if (normalized.startsWith('DELETE FROM chat_threads WHERE workspace_id = ?')) {
      return {
        run(workspace_id: string) {
          self.getActiveThreads().delete(workspace_id);
          self.getActiveTurns().delete(workspace_id);
          self.onMutation();
          return { changes: 1 };
        },
        get() { return undefined; },
        all() { return []; },
      };
    }

    if (normalized.startsWith('INSERT INTO tool_approvals')) {
      return {
        run(
          id: string,
          workspace_id: string,
          tool: string,
          input_json: string,
          description: string | null,
          created_at: number,
        ) {
          const map = self.getActiveApprovals();
          const existing = map.get(id);
          map.set(id, {
            id,
            workspace_id,
            tool,
            input_json,
            description,
            decision: existing ? existing.decision : 'pending',
            created_at,
            resolved_at: existing?.resolved_at ?? null,
          });
          self.onMutation();
          return { changes: 1 };
        },
        get() { return undefined; },
        all() { return []; },
      };
    }

    if (normalized.startsWith('UPDATE tool_approvals SET decision = ?, resolved_at = ? WHERE id = ?')) {
      return {
        run(decision: string, resolved_at: number, id: string) {
          const map = self.getActiveApprovals();
          const existing = map.get(id);
          if (existing) {
            existing.decision = decision;
            existing.resolved_at = resolved_at;
            self.onMutation();
          }
          return { changes: 1 };
        },
        get() { return undefined; },
        all() { return []; },
      };
    }

    if (normalized.startsWith('SELECT * FROM tool_approvals WHERE workspace_id = ?')) {
      return {
        run() { return {}; },
        get(workspace_id: string) {
          const list = Array.from(self.getActiveApprovals().values()).filter(
            (a) => a.workspace_id === workspace_id && a.decision === 'pending',
          );
          return list[0];
        },
        all(workspace_id: string) {
          const list = Array.from(self.getActiveApprovals().values()).filter(
            (a) => a.workspace_id === workspace_id && a.decision === 'pending',
          );
          return list.sort((a, b) => a.created_at - b.created_at);
        },
      };
    }

    return {
      run() { return { changes: 0 }; },
      get() { return undefined; },
      all() { return []; },
    };
  }

  close(): void {
    this.saveToDisk();
  }
}

let activeDb: IDatabaseSync | null = null;
let activeDbPath: string | null = null;

export function getDefaultDbPath(): string {
  try {
    const configDir = getConfigDir();
    if (typeof configDir === 'string' && configDir && !configDir.startsWith('/mock/')) {
      return path.join(configDir, 'nexusflow.db');
    }
  } catch {
    // ignore
  }
  return path.join(os.homedir(), '.nexusflow', 'nexusflow.db');
}

export function initDatabase(dbPath?: string): IDatabaseSync {
  if (!dbPath && activeDb) {
    return activeDb;
  }

  let targetPath = dbPath || getDefaultDbPath();
  if (activeDb && activeDbPath === targetPath) {
    return activeDb;
  }

  if (activeDb) {
    try {
      activeDb.close();
    } catch {
      // Ignore closure error on reconnect
    }
  }

  // If native node:sqlite is available (Node 22.5+), use it
  if (NodeDatabaseSyncClass) {
    if (targetPath !== ':memory:') {
      try {
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      } catch {
        targetPath = ':memory:';
      }
    }

    let db: IDatabaseSync;
    try {
      db = new NodeDatabaseSyncClass(targetPath);
    } catch {
      targetPath = ':memory:';
      db = new NodeDatabaseSyncClass(targetPath);
    }

    activeDb = db;
    activeDbPath = targetPath;

    // Optimize SQLite performance & concurrency with WAL mode
    if (dbPath !== ':memory:') {
      try { db.exec('PRAGMA journal_mode = WAL;'); } catch { /* ignore */ }
    }
    db.exec('PRAGMA foreign_keys = ON;');

    // Schema creation
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_threads (
        workspace_id TEXT PRIMARY KEY,
        provider_id TEXT,
        sessions_json TEXT NOT NULL DEFAULT '{}',
        profiles_json TEXT NOT NULL DEFAULT '{}',
        models_json TEXT NOT NULL DEFAULT '{}',
        efforts_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_turns (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        kind TEXT,
        execution_profile TEXT,
        images_json TEXT,
        files_changed_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES chat_threads(workspace_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chat_turns_workspace ON chat_turns(workspace_id, turn_index);

      CREATE TABLE IF NOT EXISTS tool_approvals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        input_json TEXT NOT NULL,
        description TEXT,
        decision TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_tool_approvals_pending ON tool_approvals(workspace_id, decision);
    `);

    try {
      db.exec('ALTER TABLE chat_turns ADD COLUMN files_changed_json TEXT;');
    } catch {
      // Column already exists
    }

    return db;
  }

  // Graceful fallback when node:sqlite is not available (Node < 22.5)
  const db = new FallbackDatabase(targetPath);
  activeDb = db;
  activeDbPath = targetPath;
  return db;
}

export function closeDatabase(): void {
  if (activeDb) {
    try {
      activeDb.close();
    } catch {
      // Ignore
    }
    activeDb = null;
    activeDbPath = null;
  }
}

export function saveChatThread(
  thread: Omit<StoredChatThread, 'updatedAt'>,
  db = initDatabase(),
): void {
  const updatedAt = Date.now();

  db.exec('BEGIN TRANSACTION;');
  try {
    const insertThreadStmt = db.prepare(`
      INSERT INTO chat_threads (workspace_id, provider_id, sessions_json, profiles_json, models_json, efforts_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        provider_id = excluded.provider_id,
        sessions_json = excluded.sessions_json,
        profiles_json = excluded.profiles_json,
        models_json = excluded.models_json,
        efforts_json = excluded.efforts_json,
        updated_at = excluded.updated_at
    `);

    insertThreadStmt.run(
      thread.workspaceId,
      thread.providerId ?? null,
      JSON.stringify(thread.sessions || {}),
      JSON.stringify(thread.profilesByProvider || {}),
      JSON.stringify(thread.modelsByProvider || {}),
      JSON.stringify(thread.effortsByProvider || {}),
      updatedAt,
    );

    const deleteTurnsStmt = db.prepare('DELETE FROM chat_turns WHERE workspace_id = ?');
    deleteTurnsStmt.run(thread.workspaceId);

    const insertTurnStmt = db.prepare(`
      INSERT INTO chat_turns (id, workspace_id, turn_index, role, content, kind, execution_profile, images_json, files_changed_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < thread.messages.length; i++) {
      const msg = thread.messages[i];
      const id = `${thread.workspaceId}_turn_${i}_${msg.ts ?? Date.now()}`;
      insertTurnStmt.run(
        id,
        thread.workspaceId,
        i,
        msg.role,
        msg.content,
        msg.kind ?? null,
        msg.executionProfile ?? null,
        msg.images && msg.images.length > 0 ? JSON.stringify(msg.images) : null,
        msg.filesChanged && msg.filesChanged.length > 0 ? JSON.stringify(msg.filesChanged) : null,
        msg.ts ?? Date.now(),
      );
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

export function loadChatThread(
  workspaceId: string,
  db = initDatabase(),
): StoredChatThread | null {
  const threadStmt = db.prepare('SELECT * FROM chat_threads WHERE workspace_id = ?');
  const threadRow = threadStmt.get(workspaceId) as any;
  if (!threadRow) return null;

  const turnsStmt = db.prepare('SELECT * FROM chat_turns WHERE workspace_id = ? ORDER BY turn_index ASC');
  const turnRows = turnsStmt.all(workspaceId) as any[];

  const messages: StoredChatMessage[] = turnRows.map((row) => {
    let images: string[] | undefined;
    if (row.images_json) {
      try {
        images = JSON.parse(row.images_json);
      } catch {
        // Ignore
      }
    }
    let filesChanged: string[] | undefined;
    if (row.files_changed_json) {
      try {
        filesChanged = JSON.parse(row.files_changed_json);
      } catch {
        // Ignore
      }
    }
    return {
      role: row.role as 'user' | 'assistant' | 'system',
      content: row.content,
      ts: Number(row.created_at),
      kind: row.kind ? (row.kind as 'error' | 'note') : undefined,
      executionProfile: row.execution_profile || undefined,
      images,
      filesChanged,
    };
  });

  let sessions = {};
  let profilesByProvider = {};
  let modelsByProvider = {};
  let effortsByProvider = {};

  try { sessions = JSON.parse(threadRow.sessions_json || '{}'); } catch { /* ignore */ }
  try { profilesByProvider = JSON.parse(threadRow.profiles_json || '{}'); } catch { /* ignore */ }
  try { modelsByProvider = JSON.parse(threadRow.models_json || '{}'); } catch { /* ignore */ }
  try { effortsByProvider = JSON.parse(threadRow.efforts_json || '{}'); } catch { /* ignore */ }

  return {
    workspaceId: threadRow.workspace_id,
    providerId: threadRow.provider_id ?? null,
    sessions,
    profilesByProvider,
    modelsByProvider,
    effortsByProvider,
    messages,
    updatedAt: Number(threadRow.updated_at),
  };
}

export function clearChatThread(
  workspaceId: string,
  db = initDatabase(),
): void {
  const deleteTurns = db.prepare('DELETE FROM chat_turns WHERE workspace_id = ?');
  deleteTurns.run(workspaceId);
  const deleteThread = db.prepare('DELETE FROM chat_threads WHERE workspace_id = ?');
  deleteThread.run(workspaceId);
}

export function recordApproval(
  approval: { id: string; workspaceId: string; tool: string; input: Record<string, unknown>; description?: string },
  db = initDatabase(),
): void {
  const stmt = db.prepare(`
    INSERT INTO tool_approvals (id, workspace_id, tool, input_json, description, decision, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(id) DO UPDATE SET
      tool = excluded.tool,
      input_json = excluded.input_json,
      description = excluded.description
  `);
  stmt.run(
    approval.id,
    approval.workspaceId,
    approval.tool,
    JSON.stringify(approval.input || {}),
    approval.description ?? null,
    Date.now(),
  );
}

export function resolveApproval(
  id: string,
  decision: 'allow' | 'deny',
  db = initDatabase(),
): void {
  const stmt = db.prepare(`
    UPDATE tool_approvals
    SET decision = ?, resolved_at = ?
    WHERE id = ?
  `);
  stmt.run(decision, Date.now(), id);
}

export function getPendingApprovals(
  workspaceId: string,
  db = initDatabase(),
): StoredApproval[] {
  const stmt = db.prepare(`
    SELECT * FROM tool_approvals
    WHERE workspace_id = ? AND decision = 'pending'
    ORDER BY created_at ASC
  `);
  const rows = stmt.all(workspaceId) as any[];
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    tool: row.tool,
    input: JSON.parse(row.input_json || '{}'),
    description: row.description || undefined,
    decision: row.decision as 'pending' | 'allow' | 'deny',
    createdAt: Number(row.created_at),
    resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined,
  }));
}
