/**
 * @module core/workspace-db
 * The workspace database: the Board's plan, cards, links and history in one SQLite file, in a shape AIs can read.
 * This index is the only import other code uses; the files beside it are private to the module.
 *
 * `ctxspace plan migrate` (core/plan-migrate) builds it and puts it in place. The app reads and writes it through
 * core/workspace-db-app, plan-db-app and board-db-app (DB3b); the command line and MCP follow in DB3c.
 */

export { openWorkspaceDb, openWorkspaceDbAsync, createWorkspaceDb, dbFilePath, getMeta, setMeta, readRevision, readDbId, beginImmediate, commitTransaction, withSnapshot, readWithRetry, validateWorkspaceSchema, WORKSPACE_MARKER, SCHEMA_VERSION, SERVER_BUSY_MS, CLI_BUSY_MS } from './connection.js';
export type { WorkspaceDb, OpenOptions, BusyMode } from './connection.js';
export { WorkspaceDbError, isBusyError } from './errors.js';
export type { WorkspaceDbErrorCode } from './errors.js';
export { TABLES, schemaText, createStatements } from './definitions.js';
export type { TableDef, ColumnDef } from './definitions.js';
export { newId, KIND_LETTER, ID_PATTERN } from './ids.js';
export { applyBatch, actorName, pruneHistory, readRequestReplay } from './batch.js';
export type { BatchInput, BatchResult, Issue } from './batch.js';
export type { Op, IssueCode } from './ops.js';
export { OP_FIELDS, LIMITS } from './ops.js';
export { undo } from './undo.js';
export type { UndoResult } from './undo.js';
export { startCheckRun, finishCheckRun, listCheckRuns } from './check-runs.js';
export type { CheckRun } from './check-runs.js';
export {
  getRevision, listBlocks, getBlock, getItem, listCards, getCard, cardFromRow, listLinks, listPositions, getNow, listChanges,
} from './reads.js';
export type { PlanBlock, ItemView, Card, Link, ChangeEntry, Position } from './reads.js';
export { planView } from './view.js';
export type { PlanViewOptions } from './view.js';
export { exportPlanMarkdown, exportPlan, exportDigest, importPlanText } from './plan-io.js';
export { HEADER_LINE } from './plan-text.js';
export type { PlanExport, ImportResult } from './plan-io.js';
export { stripExport, bodyOf, parsePlanText, parseDetail } from './plan-text.js';
export { runQuery, checkQueryText, QUERY_MAX_ROWS, QUERY_TIMEOUT_MS } from './query.js';
export type { QueryResult, QueryOptions } from './query.js';
export { maybeBackup, restoreBackup, restoreBackupAsync, listBackups, backupsDir, localDay, BACKUPS_KEPT } from './backup.js';
export type { BackupResult, RestoreResult } from './backup.js';
export { exportPortableSnapshot } from './snapshot.js';
export type { SnapshotOptions } from './snapshot.js';
export { importLegacyData } from './legacy-import.js';
export type { LegacyData, LegacyCard, LegacyLink, LegacyCheck, LegacyImportResult, Unmapped, UnmappedWhat, Resolved } from './legacy-import.js';
export { readImportRecord, writeImportRecord } from './import-record.js';
export type { DbImportRecord } from './import-record.js';
