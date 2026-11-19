/**
 * @module core/workspace-db/query
 * `runQuery`: the read-only guard for `ctxspace plan query` (v5 point 8).
 *
 * One statement, `SELECT` or `WITH` only, at most `maxRows` rows (200), and a time cap. The query runs in a child
 * process that is killed at the cap: SQLite cannot be interrupted from Node, and a worker thread stuck in a native
 * call cannot be stopped, so a process is the only thing that really ends a runaway query.
 *
 * Layers, each enough on its own for what it covers, so the guard stands where `setAuthorizer` does not exist
 * (Node 22.13 lacks it; later Node versions have it):
 * 1. the text: one statement (checked with a small tokenizer, so a `;` inside a string is fine), starting `SELECT` or `WITH`;
 * 2. a read-only connection (`readOnly: true` and `PRAGMA query_only = ON`): no write of any kind, even `WITH ... DELETE`;
 * 3. `setAuthorizer`, when the runtime has it: only SELECT, READ, FUNCTION and RECURSIVE are allowed, which also
 *    refuses `ATTACH`, `PRAGMA` and every write.
 * `authorizer: 'off'` forces layer 3 off, so tests can prove layers 1 and 2 alone hold.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { dbFilePath } from './connection.js';
import { WorkspaceDbError } from './errors.js';

export interface QueryOptions {
  timeoutMs?: number;
  maxRows?: number;
  /** `off` forces the authorizer off (tests). */
  authorizer?: 'auto' | 'off';
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** More rows were available than maxRows. */
  truncated: boolean;
  ms: number;
}

export const QUERY_MAX_ROWS = 200;
export const QUERY_TIMEOUT_MS = 2000;

/** Splits off string literals, quoted names and comments, so what is left can be checked for `;` and the first word. */
export function checkQueryText(sql: string): string | null {
  let i = 0;
  let code = '';
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') { while (i < sql.length && sql[i] !== '\n') i += 1; code += ' '; continue; }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return 'An unterminated /* comment.';
      i = end + 2; code += ' '; continue;
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return `An unterminated ${c} quote.`;
        if (sql[j] === close) { if (close !== ']' && sql[j + 1] === close) { j += 2; continue; } break; }
        j += 1;
      }
      i = j + 1; code += ' x '; continue;
    }
    code += c; i += 1;
  }
  const trimmed = code.trim().replace(/;+\s*$/, '');
  if (trimmed.includes(';')) return 'One statement only: a ";" is followed by more SQL.';
  if (!/^(select|with)\b/i.test(trimmed)) return 'Only a single SELECT (or WITH ... SELECT) is allowed here. To change data use `ctxspace plan apply`.';
  // table-valued PRAGMA functions are PRAGMAs: refused in every mode, however the name is quoted (see `ctxspace plan schema` instead)
  if (/pragma_/i.test(sql)) return 'PRAGMA functions (pragma_table_info and the like) are not allowed. `ctxspace plan schema` lists the tables and columns.';
  return null;
}

// The child's program. Plain JavaScript in a string: it runs under `node -e` from a source tree, from `dist`, and under
// vitest alike, with no file to find.
const CHILD = `
const { DatabaseSync, constants } = require('node:sqlite');
const [file, sql, max, auth] = process.argv.slice(1);
const out = (v) => { process.stdout.write(JSON.stringify(v)); };
try {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  db.exec('PRAGMA busy_timeout = 1500');
  db.exec('PRAGMA query_only = ON');
  let authorizer = false;
  if (auth !== 'off' && typeof db.setAuthorizer === 'function') {
    const ok = new Set([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE]);
    db.setAuthorizer((code) => (ok.has(code) ? constants.SQLITE_OK : constants.SQLITE_DENY));
    authorizer = true;
  }
  const stmt = db.prepare(sql);
  const limit = Number(max);
  const rows = [];
  let truncated = false;
  for (const r of stmt.iterate()) {
    if (rows.length >= limit) { truncated = true; break; }
    rows.push({ ...r });
  }
  out({ columns: rows[0] ? Object.keys(rows[0]) : stmt.columns().map((c) => c.name), rows, truncated, authorizer });
} catch (e) {
  out({ error: String(e && e.message || e) });
}
`;

/**
 * Runs one read-only query on the workspace database. Rejects with a {@link WorkspaceDbError}: `query_refused` (the text
 * or the database said no) or `query_timeout` (the child was killed at the cap).
 */
export async function runQuery(workspacePath: string, sql: string, options: QueryOptions = {}): Promise<QueryResult> {
  const whole = (v: unknown, name: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new WorkspaceDbError('query_refused', `${name} must be a whole number of at least 1 (got ${String(v)}).`);
    return v;
  };
  const timeoutMs = Math.min(options.timeoutMs === undefined ? QUERY_TIMEOUT_MS : whole(options.timeoutMs, 'timeoutMs'), 10_000);
  const maxRows = Math.min(options.maxRows === undefined ? QUERY_MAX_ROWS : whole(options.maxRows, 'maxRows'), QUERY_MAX_ROWS);
  if (typeof sql !== 'string' || !sql.trim()) throw new WorkspaceDbError('query_refused', 'Give a SELECT, for example: select id, name from blocks where done = 0 limit 20. See `ctxspace plan schema`.');
  const problem = checkQueryText(sql);
  if (problem) throw new WorkspaceDbError('query_refused', problem);
  const file = dbFilePath(workspacePath);
  if (!existsSync(file)) throw new WorkspaceDbError('missing', `There is no workspace database at ${file}.`);
  const started = Date.now();
  return new Promise<QueryResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', CHILD, '--', file, sql, String(maxRows), options.authorizer ?? 'auto'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    let output = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(new WorkspaceDbError('query_refused', `Could not run the query: ${error.message}`, { cause: error })); });
    child.on('close', () => {
      clearTimeout(timer);
      if (killed) { reject(new WorkspaceDbError('query_timeout', `The query was stopped after ${timeoutMs / 1000} s. Make it narrower: add WHERE and LIMIT.`)); return; }
      type Answer = { error?: string; columns?: string[]; rows?: Array<Record<string, unknown>>; truncated?: boolean };
      let parsed = null as Answer | null;
      try { parsed = JSON.parse(output) as Answer; } catch { /* below */ }
      if (!parsed) { reject(new WorkspaceDbError('query_refused', 'The query failed without an answer.')); return; }
      if (parsed.error) {
        const message = /not authorized/i.test(parsed.error)
          ? 'Refused: this connection is read-only (no UPDATE, INSERT, ATTACH, PRAGMA ...). To change data use `ctxspace plan apply`.'
          : /readonly|read-only/i.test(parsed.error)
            ? 'Refused: this connection is read-only. To change data use `ctxspace plan apply`.'
            : /no such (table|column)/i.test(parsed.error) ? `${parsed.error}. See \`ctxspace plan schema\`.` : parsed.error;
        reject(new WorkspaceDbError('query_refused', message));
        return;
      }
      resolve({ columns: parsed.columns ?? [], rows: parsed.rows ?? [], truncated: parsed.truncated === true, ms: Date.now() - started });
    });
  });
}
