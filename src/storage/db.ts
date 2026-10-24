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

export interface IPreparedStatement<Row = Record<string, unknown>> {
  run(...args: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
  get(...args: unknown[]): Row | undefined;
  all(...args: unknown[]): Row[];
}

export interface IDatabaseSync {
  exec(sql: string): void;
  prepare<Row = Record<string, unknown>>(sql: string): IPreparedStatement<Row>;
  close(): void;
}

export interface ChatThreadRow {
  workspace_id: string;
  provider_id: string | null;
  sessions_json: string;
  profiles_json: string;
  models_json: string;
  efforts_json: string;
  updated_at: number;
}

export interface ChatTurnRow {
  id: string;
  workspace_id: string;
  turn_index: number;
  role: string;
  content: string;
  kind: string | null;
  execution_profile: string | null;
  images_json: string | null;
  files_changed_json?: string | null;
  created_at: number;
}

export interface ToolApprovalRow {
  id: string;
  workspace_id: string;
  tool: string;
  input_json: string;
  description: string | null;
  decision: string;
  created_at: number;
  resolved_at: number | null;
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
  private threads = new Map<string, ChatThreadRow>();
  private turns = new Map<string, ChatTurnRow[]>();
  private approvals = new Map<string, ToolApprovalRow>();

  private inTransaction = false;
  private stagingThreads = new Map<string, ChatThreadRow>();
  private stagingTurns = new Map<string, ChatTurnRow[]>();
  private stagingApprovals = new Map<string, ToolApprovalRow>();

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

  private getActiveThreads(): Map<string, ChatThreadRow> {
    return this.inTransaction ? this.stagingThreads : this.threads;
  }

  private getActiveTurns(): Map<string, ChatTurnRow[]> {
    return this.inTransaction ? this.stagingTurns : this.turns;
  }

  private getActiveApprovals(): Map<string, ToolApprovalRow> {
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

    let parsedData: {
      threads?: Record<string, ChatThreadRow>;
      turns?: Record<string, ChatTurnRow[]>;
      approvals?: Record<string, ToolApprovalRow>;
    } | null = null;

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
          this.turns.set(k, v);
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
    threadsMap: Map<string, ChatThreadRow> = this.threads,
    turnsMap: Map<string, ChatTurnRow[]> = this.turns,
    approvalsMap: Map<string, ToolApprovalRow> = this.approvals,
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

  prepare<Row = Record<string, unknown>>(sql: string): IPreparedStatement<Row> {
    const normalized = sql.trim().replace(/\s+/g, ' ');
    const self = this;

    if (normalized.startsWith('INSERT INTO chat_threads')) {
      const colMatch = normalized.match(/INSERT INTO chat_threads\s*\(([^)]+)\)/i);
      const cols = colMatch ? colMatch[1].split(',').map((c) => c.trim().toLowerCase()) : null;

      return {
        run(...args: unknown[]) {
          const row: ChatThreadRow = {
            workspace_id: '',
            provider_id: null,
            sessions_json: '{}',
            profiles_json: '{}',
            models_json: '{}',
            efforts_json: '{}',
            updated_at: Date.now(),
          };

          if (cols) {
            for (let i = 0; i < cols.length; i++) {
              const col = cols[i];
              const val = args[i];
              if (col === 'workspace_id') row.workspace_id = String(val ?? '');
              else if (col === 'provider_id') row.provider_id = val !== null && val !== undefined ? String(val) : null;
              else if (col === 'sessions_json') row.sessions_json = String(val ?? '{}');
              else if (col === 'profiles_json') row.profiles_json = String(val ?? '{}');
              else if (col === 'models_json') row.models_json = String(val ?? '{}');
              else if (col === 'efforts_json') row.efforts_json = String(val ?? '{}');
              else if (col === 'updated_at') row.updated_at = Number(val ?? Date.now());
            }
          } else {
            row.workspace_id = String(args[0] ?? '');
            row.provider_id = args[1] !== null && args[1] !== undefined ? String(args[1]) : null;
            row.sessions_json = String(args[2] ?? '{}');
            row.profiles_json = String(args[3] ?? '{}');
            row.models_json = String(args[4] ?? '{}');
            row.efforts_json = String(args[5] ?? '{}');
            row.updated_at = Number(args[6] ?? Date.now());
          }

          self.getActiveThreads().set(row.workspace_id, row);
          self.onMutation();
          return { changes: 1 };
        },
        get() { return undefined; },
        all() { return []; },
      };
    }

    if (normalized.startsWith('DELETE FROM chat_turns WHERE workspace_id = ?')) {
      return {
        run(workspace_id: unknown) {
          const existed = self.getActiveTurns().delete(String(workspace_id));
          if (existed) {
            self.onMutation();
          }
          return { changes: existed ? 1 : 0 };
        },
        get() { return undefined; },
        all() { return []; },
      };
    }

    if (normalized.startsWith('INSERT INTO chat_turns')) {
      const colMatch = normalized.match(/INSERT INTO chat_turns\s*\(([^)]+)\)/i);
      const cols = colMatch ? colMatch[1].split(',').map((c) => c.trim().toLowerCase()) : null;

      return {
        run(...args: unknown[]) {
          const row: ChatTurnRow = {
            id: '',
            workspace_id: '',
            turn_index: 0,
            role: 'user',
            content: '',
            kind: null,
            execution_profile: null,
            images_json: null,
            files_changed_json: null,
            created_at: Date.now(),
          };

          if (cols) {
            for (let i = 0; i < cols.length; i++) {
              const col = cols[i];
              const val = args[i];
              if (col === 'id') row.id = String(val ?? '');
              else if (col === 'workspace_id') row.workspace_id = String(val ?? '');
              else if (col === 'turn_index') row.turn_index = Number(val ?? 0);
              else if (col === 'role') row.role = String(val ?? '');
              else if (col === 'content') row.content = String(val ?? '');
              else if (col === 'kind') row.kind = val !== null && val !== undefined ? String(val) : null;
              else if (col === 'execution_profile') row.execution_profile = val !== null && val !== undefined ? String(val) : null;
              else if (col === 'images_json') row.images_json = val !== null && val !== undefined ? String(val) : null;
              else if (col === 'files_changed_json') row.files_changed_json = val !== null && val !== undefined ? String(val) : null;
              else if (col === 'created_at') row.created_at = Number(val ?? Date.now());
            }
          } else {
            row.id = String(args[0] ?? '');
            row.workspace_id = String(args[1] ?? '');
            row.turn_index = Number(args[2] ?? 0);
            row.role = String(args[3] ?? '');
            row.content = String(args[4] ?? '');
            row.kind = args[5] !== null && args[5] !== undefined ? String(args[5]) : null;
            row.execution_profile = args[6] !== null && args[6] !== undefined ? String(args[6]) : null;
            row.images_json = args[7] !== null && args[7] !== undefined ? String(args[7]) : null;
            row.files_changed_json = args[8] !== null && args[8] !== undefined ? String(args[8]) : null;
            row.created_at = Number(args[9] ?? Date.now());
          }

          const wsId = row.workspace_id;
          const map = self.getActiveTurns();
          let list = map.get(wsId);
          if (!list) {
            list = [];
            map.set(wsId, list);
          }
          list.push(row);
          self.onMutation();
          return { changes: 1 };
        },
        get() { return undefined; },
        all() { return []; },
      };
    }

    if (normalized.startsWith('SELECT * FROM chat_threads WHERE workspace_id = ?')) {
      return {
        run() { return { changes: 0 }; },
        get(workspace_id: unknown) {
          return self.getActiveThreads().get(String(workspace_id)) as Row | undefined;
        },
        all(workspace_id: unknown) {
          const item = self.getActiveThreads().get(String(workspace_id));
          return (item ? [item] : []) as Row[];
        },
      };
    }

    if (normalized.startsWith('SELECT * FROM chat_turns WHERE workspace_id = ?')) {
      return {
        run() { return { changes: 0 }; },
        get(workspace_id: unknown) {
          const list = self.getActiveTurns().get(String(workspace_id)) || [];
          return list[0] as Row | undefined;
        },
        all(workspace_id: unknown) {
          const list = self.getActiveTurns().get(String(workspace_id)) || [];
          return [...list].sort((a, b) => a.turn_index - b.turn_index) as Row[];
        },
      };
    }

    if (normalized.startsWith('DELETE FROM chat_threads WHERE workspace_id = ?')) {
      return {
        run(workspace_id: unknown) {
          const wsId = String(workspace_id);
          const deletedThread = self.getActiveThreads().delete(wsId);
          const deletedTurns = self.getActiveTurns().delete(wsId);
          if (deletedThread || deletedTurns) {
            self.onMutation();
          }
          return { changes: deletedThread ? 1 : 0 };
        },
        get() { return undefined; },
        all() { return []; },
      };
    }

    if (normalized.startsWith('INSERT INTO tool_approvals')) {
      return {
        run(...args: unknown[]) {
          const appId = String(args[0] ?? '');
          const wsId = String(args[1] ?? '');
          const tool = String(args[2] ?? '');
          const inputJson = String(args[3] ?? '{}');
          const desc = args[4] !== null && args[4] !== undefined ? String(args[4]) : null;
          let decision = 'pending';
          let createdAt = Date.now();

          if (args.length >= 7) {
            decision = String(args[5] ?? 'pending');
            createdAt = Number(args[6] ?? Date.now());
          } else if (args.length === 6) {
            if (typeof args[5] === 'number') {
              createdAt = args[5];
            } else if (!Number.isNaN(Number(args[5])) && String(args[5]).trim() !== '' && !['pending', 'allow', 'deny'].includes(String(args[5]))) {
              createdAt = Number(args[5]);
            } else {
              decision = String(args[5] ?? 'pending');
            }
          }

          const map = self.getActiveApprovals();
          const existing = map.get(appId);
          map.set(appId, {
            id: appId,
            workspace_id: wsId,
            tool,
            input_json: inputJson,
            description: desc,
            decision: existing ? existing.decision : decision,
            created_at: createdAt,
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
        run(decision: unknown, resolved_at: unknown, id: unknown) {
          const appId = String(id);
          const map = self.getActiveApprovals();
          const existing = map.get(appId);
          if (existing) {
            existing.decision = String(decision);
            existing.resolved_at = Number(resolved_at);
            self.onMutation();
            return { changes: 1 };
          }
          return { changes: 0 };
        },
        get() { return undefined; },
        all() { return []; },
      };
    }

    if (normalized.startsWith('SELECT * FROM tool_approvals WHERE workspace_id = ?')) {
      const pendingOnly = normalized.includes("decision = 'pending'");
      return {
        run() { return { changes: 0 }; },
        get(workspace_id: unknown) {
          const list = Array.from(self.getActiveApprovals().values()).filter(
            (a) => a.workspace_id === String(workspace_id) && (!pendingOnly || a.decision === 'pending'),
          );
          return list[0] as Row | undefined;
        },
        all(workspace_id: unknown) {
          const list = Array.from(self.getActiveApprovals().values()).filter(
            (a) => a.workspace_id === String(workspace_id) && (!pendingOnly || a.decision === 'pending'),
          );
          return list.sort((a, b) => a.created_at - b.created_at) as Row[];
        },
      };
    }

    if (normalized.startsWith('SELECT * FROM tool_approvals WHERE id = ?')) {
      return {
        run() { return { changes: 0 }; },
        get(id: unknown) {
          return self.getActiveApprovals().get(String(id)) as Row | undefined;
        },
        all(id: unknown) {
          const item = self.getActiveApprovals().get(String(id));
          return (item ? [item] : []) as Row[];
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
      db = new NodeDatabaseSyncClass(targetPath) as unknown as IDatabaseSync;
    } catch {
      targetPath = ':memory:';
      db = new NodeDatabaseSyncClass(targetPath) as unknown as IDatabaseSync;
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
  const threadStmt = db.prepare<ChatThreadRow>('SELECT * FROM chat_threads WHERE workspace_id = ?');
  const threadRow = threadStmt.get(workspaceId);
  if (!threadRow) return null;

  const turnsStmt = db.prepare<ChatTurnRow>('SELECT * FROM chat_turns WHERE workspace_id = ? ORDER BY turn_index ASC');
  const turnRows = turnsStmt.all(workspaceId);

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

  let sessions: Record<string, { id: string; started: boolean; model?: string; effort?: string }> = {};
  let profilesByProvider: Record<string, string> = {};
  let modelsByProvider: Record<string, string> = {};
  let effortsByProvider: Record<string, string> = {};

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
  const stmt = db.prepare<ToolApprovalRow>(`
    SELECT * FROM tool_approvals
    WHERE workspace_id = ? AND decision = 'pending'
    ORDER BY created_at ASC
  `);
  const rows = stmt.all(workspaceId);
  return rows.map((row) => {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(row.input_json || '{}');
    } catch {
      input = {};
    }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      tool: row.tool,
      input,
      description: row.description || undefined,
      decision: row.decision as 'pending' | 'allow' | 'deny',
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined,
    };
  });
}
