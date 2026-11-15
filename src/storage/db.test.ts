import { describe, expect, it, beforeEach } from 'vitest';
import {
  initDatabase,
  saveChatThread,
  loadChatThread,
  clearChatThread,
  recordApproval,
  resolveApproval,
  getPendingApprovals,
  FallbackDatabase,
  type StoredChatThread,
  type ChatThreadRow,
  type ChatTurnRow,
  type ToolApprovalRow,
  type IPreparedStatement,
} from './db.js';

describe('storage/db SQLite persistence', () => {
  let db: ReturnType<typeof initDatabase>;

  beforeEach(() => {
    db = initDatabase(':memory:');
  });

  it('saves and loads a chat thread with turns', () => {
    const thread: Omit<StoredChatThread, 'updatedAt'> = {
      workspaceId: 'ws-test-1',
      providerId: 'claude-cli',
      sessions: {
        'claude-cli': { id: 'sess-123', started: true, model: 'claude-3-7-sonnet' },
      },
      profilesByProvider: { 'claude-cli': 'workspace-write' },
      modelsByProvider: { 'claude-cli': 'claude-3-7-sonnet' },
      effortsByProvider: { 'claude-cli': 'high' },
      messages: [
        { role: 'user', content: 'Hello', ts: 1000 },
        { role: 'assistant', content: 'Hi there!', ts: 2000, filesChanged: ['src/a.ts', 'src/b.ts'] },
        { role: 'system', content: 'File edited', kind: 'note', ts: 3000 },
      ],
    };

    saveChatThread(thread, db);
    const loaded = loadChatThread('ws-test-1', db);

    expect(loaded).not.toBeNull();
    expect(loaded?.workspaceId).toBe('ws-test-1');
    expect(loaded?.providerId).toBe('claude-cli');
    expect(loaded?.sessions['claude-cli']).toEqual({ id: 'sess-123', started: true, model: 'claude-3-7-sonnet' });
    expect(loaded?.profilesByProvider['claude-cli']).toBe('workspace-write');
    expect(loaded?.modelsByProvider['claude-cli']).toBe('claude-3-7-sonnet');
    expect(loaded?.effortsByProvider['claude-cli']).toBe('high');
    expect(loaded?.messages).toHaveLength(3);
    expect(loaded?.messages[0]).toEqual({ role: 'user', content: 'Hello', ts: 1000 });
    expect(loaded?.messages[1]).toEqual({ role: 'assistant', content: 'Hi there!', ts: 2000, filesChanged: ['src/a.ts', 'src/b.ts'] });
    expect(loaded?.messages[2]).toEqual({ role: 'system', content: 'File edited', kind: 'note', ts: 3000 });
  });

  it('overwrites thread turns on update', () => {
    saveChatThread({
      workspaceId: 'ws-test-2',
      providerId: null,
      sessions: {},
      profilesByProvider: {},
      modelsByProvider: {},
      effortsByProvider: {},
      messages: [{ role: 'user', content: 'Initial message' }],
    }, db);

    let loaded = loadChatThread('ws-test-2', db);
    expect(loaded?.messages).toHaveLength(1);

    saveChatThread({
      workspaceId: 'ws-test-2',
      providerId: 'codex-cli',
      sessions: {},
      profilesByProvider: {},
      modelsByProvider: {},
      effortsByProvider: {},
      messages: [
        { role: 'user', content: 'Initial message' },
        { role: 'assistant', content: 'Reply' },
      ],
    }, db);

    loaded = loadChatThread('ws-test-2', db);
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.providerId).toBe('codex-cli');
  });

  it('clears chat thread and turns', () => {
    saveChatThread({
      workspaceId: 'ws-test-3',
      providerId: 'claude-cli',
      sessions: {},
      profilesByProvider: {},
      modelsByProvider: {},
      effortsByProvider: {},
      messages: [{ role: 'user', content: 'Test' }],
    }, db);

    expect(loadChatThread('ws-test-3', db)).not.toBeNull();
    clearChatThread('ws-test-3', db);
    expect(loadChatThread('ws-test-3', db)).toBeNull();
  });

  it('records and resolves approvals', () => {
    recordApproval({
      id: 'app-1',
      workspaceId: 'ws-test-4',
      tool: 'Bash',
      input: { command: 'npm test' },
      description: 'Run unit tests',
    }, db);

    let pending = getPendingApprovals('ws-test-4', db);
    expect(pending).toHaveLength(1);
    expect(pending[0].tool).toBe('Bash');
    expect(pending[0].input).toEqual({ command: 'npm test' });
    expect(pending[0].description).toBe('Run unit tests');
    expect(pending[0].decision).toBe('pending');

    resolveApproval('app-1', 'allow', db);
    pending = getPendingApprovals('ws-test-4', db);
    expect(pending).toHaveLength(0);
  });

  describe('FallbackDatabase (Node 20 runtime compatibility)', () => {
    let fallbackDb: FallbackDatabase;

    beforeEach(() => {
      fallbackDb = new FallbackDatabase(':memory:');
    });

    it('saves, loads, updates, and clears threads with fallback store', () => {
      saveChatThread({
        workspaceId: 'fallback-ws-1',
        providerId: 'codex-cli',
        sessions: { 'codex-cli': { id: 's-1', started: true } },
        profilesByProvider: { 'codex-cli': 'review' },
        modelsByProvider: { 'codex-cli': 'gpt-5.6' },
        effortsByProvider: { 'codex-cli': 'low' },
        messages: [
          { role: 'user', content: 'Fallback test' },
          { role: 'assistant', content: 'Fallback reply', filesChanged: ['file.txt'] },
        ],
      }, fallbackDb);

      const loaded = loadChatThread('fallback-ws-1', fallbackDb);
      expect(loaded).not.toBeNull();
      expect(loaded?.workspaceId).toBe('fallback-ws-1');
      expect(loaded?.providerId).toBe('codex-cli');
      expect(loaded?.messages).toHaveLength(2);
      expect(loaded?.messages[1].filesChanged).toEqual(['file.txt']);

      clearChatThread('fallback-ws-1', fallbackDb);
      expect(loadChatThread('fallback-ws-1', fallbackDb)).toBeNull();
    });

    it('records and resolves approvals with fallback store', () => {
      recordApproval({
        id: 'fb-app-1',
        workspaceId: 'fallback-ws-2',
        tool: 'Write',
        input: { file: 'a.txt' },
        description: 'Create a.txt',
      }, fallbackDb);

      let pending = getPendingApprovals('fallback-ws-2', fallbackDb);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('fb-app-1');

      resolveApproval('fb-app-1', 'allow', fallbackDb);
      pending = getPendingApprovals('fallback-ws-2', fallbackDb);
      expect(pending).toHaveLength(0);
    });

    it('supports transaction rollback and discards uncommitted staging mutations', () => {
      saveChatThread({
        workspaceId: 'tx-ws-1',
        providerId: 'claude-cli',
        sessions: {},
        profilesByProvider: {},
        modelsByProvider: {},
        effortsByProvider: {},
        messages: [{ role: 'user', content: 'Initial msg' }],
      }, fallbackDb);

      expect(loadChatThread('tx-ws-1', fallbackDb)?.messages).toHaveLength(1);

      // Begin transaction, perform mutation, and rollback
      fallbackDb.exec('BEGIN TRANSACTION;');
      fallbackDb.prepare('DELETE FROM chat_turns WHERE workspace_id = ?').run('tx-ws-1');
      fallbackDb.prepare('INSERT INTO chat_turns (id, workspace_id, turn_index, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('turn-stage', 'tx-ws-1', 0, 'user', 'Staged msg', Date.now());

      // While in transaction, staging holds the new value
      expect(loadChatThread('tx-ws-1', fallbackDb)?.messages[0].content).toBe('Staged msg');

      // Rollback
      fallbackDb.exec('ROLLBACK;');

      // Active state remains restored
      const afterRollback = loadChatThread('tx-ws-1', fallbackDb);
      expect(afterRollback?.messages).toHaveLength(1);
      expect(afterRollback?.messages[0].content).toBe('Initial msg');
    });

    it('persists atomically with .bak copy and recovers when primary JSON is corrupted', async () => {
      const fsMod = await import('node:fs');
      const osMod = await import('node:os');
      const pathMod = await import('node:path');

      const tempDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'nf-db-test-'));
      const dbPath = pathMod.join(tempDir, 'test.db');
      const jsonPath = pathMod.join(tempDir, 'test.json');
      const bakPath = pathMod.join(tempDir, 'test.json.bak');

      try {
        const diskDb = new FallbackDatabase(dbPath);
        saveChatThread({
          workspaceId: 'disk-ws-1',
          providerId: 'claude-cli',
          sessions: {},
          profilesByProvider: {},
          modelsByProvider: {},
          effortsByProvider: {},
          messages: [{ role: 'user', content: 'Version 1' }],
        }, diskDb);

        const initialJson = fsMod.readFileSync(jsonPath, 'utf8');
        expect(initialJson).toContain('Version 1');

        // Update to generate .bak copy
        saveChatThread({
          workspaceId: 'disk-ws-1',
          providerId: 'claude-cli',
          sessions: {},
          profilesByProvider: {},
          modelsByProvider: {},
          effortsByProvider: {},
          messages: [{ role: 'user', content: 'Version 2' }],
        }, diskDb);

        const bakContent = JSON.parse(fsMod.readFileSync(bakPath, 'utf8'));
        expect(bakContent.turns['disk-ws-1'][0].content).toBe('Version 1');

        // Intentionally corrupt primary JSON
        fsMod.writeFileSync(jsonPath, '{ corrupt json string... !!', 'utf8');

        // New FallbackDatabase should recover seamlessly from .bak
        const recoveredDb = new FallbackDatabase(dbPath);
        const recoveredThread = loadChatThread('disk-ws-1', recoveredDb);
        expect(recoveredThread).not.toBeNull();
        expect(recoveredThread?.messages[0].content).toBe('Version 1');
      } finally {
        fsMod.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('does not publish uncommitted state and allows clean rollback if persistence fails during COMMIT', async () => {
      const fsMod = await import('node:fs');
      const osMod = await import('node:os');
      const pathMod = await import('node:path');
      const { vi } = await import('vitest');

      const tempDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'nf-db-commit-fail-'));
      const dbPath = pathMod.join(tempDir, 'test.db');

      try {
        const diskDb = new FallbackDatabase(dbPath);
        saveChatThread({
          workspaceId: 'tx-commit-ws',
          providerId: 'claude-cli',
          sessions: {},
          profilesByProvider: {},
          modelsByProvider: {},
          effortsByProvider: {},
          messages: [{ role: 'user', content: 'Initial message' }],
        }, diskDb);

        // Verify initial state persisted
        expect(loadChatThread('tx-commit-ws', diskDb)?.providerId).toBe('claude-cli');

        // Inject failure during saveToDisk execution
        const saveSpy = vi.spyOn(diskDb as any, 'saveToDisk').mockImplementation(() => {
          throw new Error('Injected rename failure during atomic write');
        });

        // Attempt to save updated thread with changed provider — this will fail at COMMIT
        expect(() => {
          saveChatThread({
            workspaceId: 'tx-commit-ws',
            providerId: 'codex-cli',
            sessions: {},
            profilesByProvider: {},
            modelsByProvider: {},
            effortsByProvider: {},
            messages: [{ role: 'user', content: 'Attempted update' }],
          }, diskDb);
        }).toThrow('Injected rename failure during atomic write');

        saveSpy.mockRestore();

        // 1. In-memory read must NOT return the failed 'codex-cli' provider
        const inMemoryThread = loadChatThread('tx-commit-ws', diskDb);
        expect(inMemoryThread?.providerId).toBe('claude-cli');
        expect(inMemoryThread?.messages[0].content).toBe('Initial message');

        // 2. Freshly opened database must also return the original 'claude-cli' provider
        const freshDb = new FallbackDatabase(dbPath);
        const freshThread = loadChatThread('tx-commit-ws', freshDb);
        expect(freshThread?.providerId).toBe('claude-cli');
        expect(freshThread?.messages[0].content).toBe('Initial message');

        // 3. A subsequent successful mutation must persist without leaking the failed 'codex-cli'
        saveChatThread({
          workspaceId: 'tx-commit-ws',
          providerId: 'claude-cli',
          sessions: {},
          profilesByProvider: {},
          modelsByProvider: {},
          effortsByProvider: {},
          messages: [
            { role: 'user', content: 'Initial message' },
            { role: 'assistant', content: 'Successful follow-up' },
          ],
        }, diskDb);

        const updatedThread = loadChatThread('tx-commit-ws', diskDb);
        expect(updatedThread?.providerId).toBe('claude-cli');
        expect(updatedThread?.messages).toHaveLength(2);

        const freshDb2 = new FallbackDatabase(dbPath);
        const persistedThread = loadChatThread('tx-commit-ws', freshDb2);
        expect(persistedThread?.providerId).toBe('claude-cli');
        expect(persistedThread?.messages).toHaveLength(2);
      } finally {
        fsMod.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('strongly typed prepared statements and row interfaces', () => {
    it('executes parameterized SELECT queries returning typed row interfaces', () => {
      saveChatThread({
        workspaceId: 'typed-ws-1',
        providerId: 'codex-cli',
        sessions: { 'codex-cli': { id: 's-typed', started: true } },
        profilesByProvider: { 'codex-cli': 'coder' },
        modelsByProvider: { 'codex-cli': 'gpt-5' },
        effortsByProvider: { 'codex-cli': 'high' },
        messages: [
          { role: 'user', content: 'hello typed world', ts: 12345 },
        ],
      }, db);

      const threadStmt: IPreparedStatement<ChatThreadRow> = db.prepare<ChatThreadRow>(
        'SELECT * FROM chat_threads WHERE workspace_id = ?'
      );
      const threadRow = threadStmt.get('typed-ws-1');
      expect(threadRow).toBeDefined();
      expect(threadRow?.workspace_id).toBe('typed-ws-1');
      expect(threadRow?.provider_id).toBe('codex-cli');
      expect(JSON.parse(threadRow?.sessions_json ?? '{}')).toEqual({ 'codex-cli': { id: 's-typed', started: true } });

      const turnsStmt: IPreparedStatement<ChatTurnRow> = db.prepare<ChatTurnRow>(
        'SELECT * FROM chat_turns WHERE workspace_id = ? ORDER BY turn_index ASC'
      );
      const turnRows = turnsStmt.all('typed-ws-1');
      expect(turnRows).toHaveLength(1);
      expect(turnRows[0].role).toBe('user');
      expect(turnRows[0].content).toBe('hello typed world');

      recordApproval({
        id: 'app-typed-1',
        workspaceId: 'typed-ws-1',
        tool: 'Terminal',
        input: { cmd: 'ls' },
        description: 'Directory listing',
      }, db);

      const appStmt: IPreparedStatement<ToolApprovalRow> = db.prepare<ToolApprovalRow>(
        'SELECT * FROM tool_approvals WHERE workspace_id = ?'
      );
      const appRows = appStmt.all('typed-ws-1');
      expect(appRows).toHaveLength(1);
      expect(appRows[0].tool).toBe('Terminal');
      expect(appRows[0].decision).toBe('pending');
    });

    it('executes parameterized SELECT queries on FallbackDatabase returning typed row interfaces', () => {
      const fb = new FallbackDatabase(':memory:');
      saveChatThread({
        workspaceId: 'fb-typed-1',
        providerId: 'claude-cli',
        sessions: {},
        profilesByProvider: {},
        modelsByProvider: {},
        effortsByProvider: {},
        messages: [
          { role: 'assistant', content: 'fallback typed turn', ts: 999 },
        ],
      }, fb);

      const threadStmt: IPreparedStatement<ChatThreadRow> = fb.prepare<ChatThreadRow>(
        'SELECT * FROM chat_threads WHERE workspace_id = ?'
      );
      const threadRow = threadStmt.get('fb-typed-1');
      expect(threadRow?.workspace_id).toBe('fb-typed-1');

      const turnsStmt: IPreparedStatement<ChatTurnRow> = fb.prepare<ChatTurnRow>(
        'SELECT * FROM chat_turns WHERE workspace_id = ?'
      );
      const turnRows = turnsStmt.all('fb-typed-1');
      expect(turnRows).toHaveLength(1);
      expect(turnRows[0].content).toBe('fallback typed turn');
    });

    it('correctly maps columns for partial-column INSERT INTO chat_turns on FallbackDatabase', () => {
      const fb = new FallbackDatabase(':memory:');
      const ts = 1729790000000;
      fb.prepare('INSERT INTO chat_turns (id, workspace_id, turn_index, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('turn-partial', 'ws-partial', 0, 'user', 'partial turn msg', ts);

      const turnsStmt: IPreparedStatement<ChatTurnRow> = fb.prepare<ChatTurnRow>(
        'SELECT * FROM chat_turns WHERE workspace_id = ?'
      );
      const rows = turnsStmt.all('ws-partial');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('turn-partial');
      expect(rows[0].content).toBe('partial turn msg');
      expect(rows[0].kind).toBeNull();
      expect(rows[0].created_at).toBe(ts);
    });

    it('returns accurate changes count on FallbackDatabase for UPDATE and DELETE statements', () => {
      const fb = new FallbackDatabase(':memory:');
      recordApproval({
        id: 'app-changes-1',
        workspaceId: 'ws-changes',
        tool: 'Terminal',
        input: { cmd: 'echo 1' },
      }, fb);

      // Updating existing approval returns changes: 1
      const updateRes = fb.prepare('UPDATE tool_approvals SET decision = ?, resolved_at = ? WHERE id = ?')
        .run('allow', Date.now(), 'app-changes-1');
      expect(updateRes.changes).toBe(1);

      // Updating non-existent approval returns changes: 0
      const updateNonExistent = fb.prepare('UPDATE tool_approvals SET decision = ?, resolved_at = ? WHERE id = ?')
        .run('allow', Date.now(), 'non-existent-id');
      expect(updateNonExistent.changes).toBe(0);

      // Deleting existing thread returns changes: 1
      saveChatThread({
        workspaceId: 'ws-to-delete',
        providerId: null,
        sessions: {},
        profilesByProvider: {},
        modelsByProvider: {},
        effortsByProvider: {},
        messages: [{ role: 'user', content: 'hello' }],
      }, fb);
      const deleteThreadRes = fb.prepare('DELETE FROM chat_threads WHERE workspace_id = ?').run('ws-to-delete');
      expect(deleteThreadRes.changes).toBe(1);

      // Deleting non-existent thread returns changes: 0
      const deleteNonExistent = fb.prepare('DELETE FROM chat_threads WHERE workspace_id = ?').run('no-such-ws');
      expect(deleteNonExistent.changes).toBe(0);
    });

    it('supports general tool_approvals query (including resolved) and query by id on FallbackDatabase', () => {
      const fb = new FallbackDatabase(':memory:');
      recordApproval({ id: 'app-res-1', workspaceId: 'ws-app', tool: 'Bash', input: {} }, fb);
      recordApproval({ id: 'app-res-2', workspaceId: 'ws-app', tool: 'Read', input: {} }, fb);
      resolveApproval('app-res-1', 'allow', fb);

      // Query without pending filter should return both allow and pending
      const allStmt = fb.prepare<ToolApprovalRow>('SELECT * FROM tool_approvals WHERE workspace_id = ?');
      const allRows = allStmt.all('ws-app');
      expect(allRows).toHaveLength(2);

      // Query with pending filter returns only the 1 pending approval
      const pendingStmt = fb.prepare<ToolApprovalRow>(
        "SELECT * FROM tool_approvals WHERE workspace_id = ? AND decision = 'pending'"
      );
      const pendingRows = pendingStmt.all('ws-app');
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0].id).toBe('app-res-2');

      // Query by id
      const byIdStmt = fb.prepare<ToolApprovalRow>('SELECT * FROM tool_approvals WHERE id = ?');
      const byIdRow = byIdStmt.get('app-res-1');
      expect(byIdRow?.decision).toBe('allow');
    });
  });
});
