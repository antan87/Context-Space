import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canOpenCodexSessionInWorkspace,
  canTransferClaudeSessionInWorkspace,
  getClaudeProjectFolderName,
  getAntigravityDir,
  isCanonicalPathWithin,
  isNoiseUserRecord,
  claudeRecordText,
  codexMessageText,
  codexSessionId,
  isCodexSessionId,
  isInjectedContextText,
  getSessionTranscript,
  findSessions,
  findActiveAssistants,
  clearSessionFinderCache,
} from './session-finder.js';

describe('getClaudeProjectFolderName', () => {
  it('matches Claude Code encoding for a Windows path (colon, backslash, dot, underscore)', () => {
    expect(getClaudeProjectFolderName('C:\\Users\\anton.patron\\Git\\workspaces\\improve_las'))
      .toBe('C--Users-anton-patron-Git-workspaces-improve-las');
  });

  it('maps each separator to its own dash without collapsing runs', () => {
    // `C:\` is three non-alphanumerics (colon + backslash) around the drive → `C--`.
    expect(getClaudeProjectFolderName('C:\\Git')).toBe('C--Git');
  });

  it('encodes a POSIX path', () => {
    expect(getClaudeProjectFolderName('/home/a.b/Git/my_repo'))
      .toBe('-home-a-b-Git-my-repo');
  });

  it('preserves case', () => {
    expect(getClaudeProjectFolderName('C:\\Git\\NexusFlow')).toBe('C--Git-NexusFlow');
  });
});

describe('isNoiseUserRecord', () => {
  const mk = (text: string, extra: any = {}) => ({ type: 'user', message: { content: text }, ...extra });

  it('flags meta records', () => {
    expect(isNoiseUserRecord({ isMeta: true, message: { content: 'anything' } }, 'anything')).toBe(true);
  });

  it('flags local-command caveats and slash-command wrappers', () => {
    expect(isNoiseUserRecord(mk('<local-command-caveat>Caveat: ...'), '<local-command-caveat>Caveat: ...')).toBe(true);
    expect(isNoiseUserRecord(mk('<command-name>/plan</command-name>'), '<command-name>/plan</command-name>')).toBe(true);
    expect(isNoiseUserRecord(mk('<local-command-stdout>done</local-command-stdout>'), '<local-command-stdout>done</local-command-stdout>')).toBe(true);
  });

  it('flags empty text and tool-result-only content', () => {
    expect(isNoiseUserRecord(mk(''), '')).toBe(true);
    expect(isNoiseUserRecord({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }, '')).toBe(true);
  });

  it('accepts a real typed prompt', () => {
    expect(isNoiseUserRecord(mk('Please refactor the auth module'), 'Please refactor the auth module')).toBe(false);
  });
});

describe('claudeRecordText', () => {
  it('reads string content', () => {
    expect(claudeRecordText({ message: { content: 'hello' } })).toBe('hello');
  });
  it('joins text blocks from array content', () => {
    expect(claudeRecordText({ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } })).toBe('a b');
  });
});

describe('codexMessageText', () => {
  it('joins the text parts of a response_item message payload', () => {
    expect(codexMessageText({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello ' }, { type: 'input_text', text: 'world' }] }))
      .toBe('hello world');
  });
  it('handles string content', () => {
    expect(codexMessageText({ content: 'plain' })).toBe('plain');
  });
});

describe('codexSessionId', () => {
  it('uses session_meta.payload.id instead of the timestamped rollout filename', () => {
    expect(codexSessionId({
      type: 'session_meta',
      payload: { id: '0199a213-81c0-7800-8aa1-bbab2a035a53', cwd: '/repo' },
    })).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53');
  });

  it('ignores unrelated or empty records', () => {
    expect(codexSessionId({ type: 'turn_context', payload: { id: 'wrong' } })).toBeNull();
    expect(codexSessionId({ type: 'session_meta', payload: { id: '' } })).toBeNull();
    expect(codexSessionId({ type: 'session_meta', payload: { id: 'thread-name' } })).toBeNull();
  });
});

describe('isCodexSessionId', () => {
  it('accepts only complete UUIDs', () => {
    expect(isCodexSessionId('0199a213-81c0-7800-8aa1-bbab2a035a53')).toBe(true);
    expect(isCodexSessionId('53')).toBe(false);
    expect(isCodexSessionId('0199a213-81c0-7800-8aa1-bbab2a035a53; whoami')).toBe(false);
  });
});

describe('Codex Desktop workspace authorization', () => {
  const sessionId = '0199a213-81c0-7800-8aa1-bbab2a035a53';
  let codexHome = '';
  let workspacePath = '';
  let previousCodexHome: string | undefined;

  beforeEach(async () => {
    previousCodexHome = process.env.CODEX_HOME;
    codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-codex-authorization-'));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-workspace-'));
    process.env.CODEX_HOME = codexHome;
    await fs.mkdir(path.join(codexHome, 'sessions'), { recursive: true });
  });

  afterEach(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('requires a matching session_meta cwd inside the canonical workspace', async () => {
    await fs.writeFile(
      path.join(codexHome, 'sessions', 'rollout.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: workspacePath } }),
    );

    await expect(canOpenCodexSessionInWorkspace(workspacePath, [], sessionId)).resolves.toBe(true);
  });

  it('rejects a fuzzy transcript mention when session_meta has no cwd', async () => {
    await fs.writeFile(
      path.join(codexHome, 'sessions', 'old-rollout.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: workspacePath },
        }),
      ].join('\n'),
    );

    await expect(canOpenCodexSessionInWorkspace(workspacePath, [], sessionId)).resolves.toBe(false);
  });

  it('keeps POSIX path authorization case-sensitive', () => {
    expect(isCanonicalPathWithin('/workspaces/NexusFlow', '/workspaces/nexusflow/repo', 'linux'))
      .toBe(false);
  });

  it('matches Windows canonical paths case-insensitively', () => {
    expect(isCanonicalPathWithin('C:\\Workspaces\\NexusFlow', 'c:\\workspaces\\nexusflow\\repo', 'win32'))
      .toBe(true);
  });
});

describe('Claude Desktop transfer authorization', () => {
  const sessionId = '0199a213-81c0-7800-8aa1-bbab2a035a53';
  let claudeConfigDir = '';
  let workspacePath = '';
  let outsidePath = '';
  let previousClaudeConfigDir: string | undefined;

  beforeEach(async () => {
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    claudeConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-claude-authorization-'));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-workspace-'));
    outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-outside-'));
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    await fs.mkdir(
      path.join(claudeConfigDir, 'projects', getClaudeProjectFolderName(workspacePath)),
      { recursive: true },
    );
  });

  afterEach(async () => {
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    await fs.rm(claudeConfigDir, { recursive: true, force: true });
    await fs.rm(workspacePath, { recursive: true, force: true });
    await fs.rm(outsidePath, { recursive: true, force: true });
  });

  it('requires the exact UUID and a canonical recorded cwd in the workspace', async () => {
    await fs.writeFile(
      path.join(claudeConfigDir, 'projects', getClaudeProjectFolderName(workspacePath), `${sessionId}.jsonl`),
      JSON.stringify({ type: 'user', sessionId, cwd: workspacePath }),
    );

    await expect(canTransferClaudeSessionInWorkspace(workspacePath, [], sessionId)).resolves.toBe(true);
  });

  it('rejects a lossy-folder collision whose recorded cwd is outside the workspace', async () => {
    await fs.writeFile(
      path.join(claudeConfigDir, 'projects', getClaudeProjectFolderName(workspacePath), `${sessionId}.jsonl`),
      JSON.stringify({ type: 'user', sessionId, cwd: outsidePath }),
    );

    await expect(canTransferClaudeSessionInWorkspace(workspacePath, [], sessionId)).resolves.toBe(false);
    await expect(canTransferClaudeSessionInWorkspace(workspacePath, [], `${sessionId}; whoami`)).resolves.toBe(false);
  });
});

describe('Codex transcript identity', () => {
  const targetId = '0199a213-81c0-7800-8aa1-bbab2a035a53';
  const otherId = '0199a213-81c0-7800-8aa1-bbab2a035a54';
  let codexHome = '';
  let previousCodexHome: string | undefined;

  beforeEach(async () => {
    previousCodexHome = process.env.CODEX_HOME;
    codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-codex-sessions-'));
    process.env.CODEX_HOME = codexHome;
    await fs.mkdir(path.join(codexHome, 'sessions'), { recursive: true });
  });

  afterEach(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it('verifies session_meta even when another rollout filename has the requested suffix', async () => {
    const sessionsDir = path.join(codexHome, 'sessions');
    await fs.writeFile(
      path.join(sessionsDir, `rollout-timestamp-${targetId}.jsonl`),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: otherId } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'wrong' } }),
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(sessionsDir, 'renamed-rollout.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: targetId } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'correct' } }),
      ].join('\n'),
    );

    await expect(getSessionTranscript('codex', targetId)).resolves.toEqual([
      { role: 'assistant', content: 'correct', timestamp: undefined },
    ]);
  });

  it('rejects partial or attacker-controlled ids before scanning files', async () => {
    await expect(getSessionTranscript('codex', '53')).rejects.toThrow(/Invalid Codex session id/);
  });
});

describe('isInjectedContextText', () => {
  it('flags Codex and Copilot injected context', () => {
    expect(isInjectedContextText('<environment_context>\n  <cwd>...')).toBe(true);
    expect(isInjectedContextText('<user_instructions>do X</user_instructions>')).toBe(true);
    expect(isInjectedContextText('<system_reminder> Custom instructions')).toBe(true);
  });
  it('does not flag a real prompt', () => {
    expect(isInjectedContextText('Refactor the auth module')).toBe(false);
  });
});

describe('getAntigravityDir', () => {
  const origAg = process.env.ANTIGRAVITY_CLI_HOME;
  const origGemini = process.env.GEMINI_CLI_HOME;

  afterEach(() => {
    if (origAg === undefined) delete process.env.ANTIGRAVITY_CLI_HOME;
    else process.env.ANTIGRAVITY_CLI_HOME = origAg;
    if (origGemini === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = origGemini;
  });

  it('prefers ANTIGRAVITY_CLI_HOME when set', () => {
    process.env.ANTIGRAVITY_CLI_HOME = '/custom/ag-home';
    process.env.GEMINI_CLI_HOME = '/custom/gemini-home';
    expect(getAntigravityDir()).toBe('/custom/ag-home');
  });

  it('supports GEMINI_CLI_HOME when ANTIGRAVITY_CLI_HOME is unset', () => {
    delete process.env.ANTIGRAVITY_CLI_HOME;
    process.env.GEMINI_CLI_HOME = '/custom/gemini-home';
    expect(getAntigravityDir()).toBe(path.join('/custom/gemini-home', 'antigravity-cli'));
  });

  it('handles GEMINI_CLI_HOME already pointing to antigravity-cli directory', () => {
    delete process.env.ANTIGRAVITY_CLI_HOME;
    process.env.GEMINI_CLI_HOME = path.join('/custom/gemini-home', 'antigravity-cli');
    expect(getAntigravityDir()).toBe(path.join('/custom/gemini-home', 'antigravity-cli'));
  });

  it('falls back to default homedir location when no env vars are set', () => {
    delete process.env.ANTIGRAVITY_CLI_HOME;
    delete process.env.GEMINI_CLI_HOME;
    expect(getAntigravityDir()).toBe(path.join(os.homedir(), '.gemini', 'antigravity-cli'));
  });
});

describe('JSON error boundaries and malformed lines resilience', () => {
  let tempDir = '';
  let workspaceDir = '';
  let prevAg: string | undefined;
  let prevClaude: string | undefined;
  let prevCodex: string | undefined;

  beforeEach(async () => {
    clearSessionFinderCache();
    prevAg = process.env.ANTIGRAVITY_CLI_HOME;
    prevClaude = process.env.CLAUDE_CONFIG_DIR;
    prevCodex = process.env.CODEX_HOME;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-json-resilience-'));
    workspaceDir = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });

    process.env.ANTIGRAVITY_CLI_HOME = path.join(tempDir, 'ag');
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude');
    process.env.CODEX_HOME = path.join(tempDir, 'codex');

    await fs.mkdir(process.env.ANTIGRAVITY_CLI_HOME, { recursive: true });
    await fs.mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    await fs.mkdir(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
  });

  afterEach(async () => {
    clearSessionFinderCache();
    if (prevAg === undefined) delete process.env.ANTIGRAVITY_CLI_HOME;
    else process.env.ANTIGRAVITY_CLI_HOME = prevAg;
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('continues parsing Claude session files despite malformed JSON lines', async () => {
    const claudeFolder = getClaudeProjectFolderName(workspaceDir);
    const claudeProjDir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', claudeFolder);
    await fs.mkdir(claudeProjDir, { recursive: true });

    const sessionId = '0199a213-81c0-7800-8aa1-bbab2a035a99';
    await fs.writeFile(
      path.join(claudeProjDir, `${sessionId}.jsonl`),
      [
        '{ INVALID JSON LINE }',
        JSON.stringify({ type: 'user', sessionId, timestamp: '2026-08-19T08:00:00.000Z', message: { content: 'Valid prompt' } }),
        'CORRUPTED TEXT',
        JSON.stringify({ type: 'assistant', sessionId, timestamp: '2026-08-19T08:01:00.000Z', message: { content: 'Valid response' } }),
      ].join('\n'),
    );

    const sessions = await findSessions(workspaceDir);
    expect(sessions.find((s) => s.id === sessionId)).toBeDefined();
    expect(sessions.find((s) => s.id === sessionId)?.title).toBe('Valid prompt');

    const transcript = await getSessionTranscript('claude', sessionId);
    expect(transcript).toHaveLength(2);
    expect(transcript[0].content).toBe('Valid prompt');
    expect(transcript[1].content).toBe('Valid response');
  });

  it('loads only the requested history source while preserving the combined listing', async () => {
    const claudeId = '0199a213-81c0-7800-8aa1-bbab2a035a91';
    const workspaceId = '0199a213-81c0-7800-8aa1-bbab2a035a92';
    const claudeProjDir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', getClaudeProjectFolderName(workspaceDir));
    await fs.mkdir(claudeProjDir, { recursive: true });
    await fs.writeFile(path.join(claudeProjDir, `${claudeId}.jsonl`), JSON.stringify({
      type: 'user', sessionId: claudeId, cwd: workspaceDir, timestamp: '2026-08-19T08:00:00.000Z',
      message: { content: 'Claude prompt' },
    }));
    const workspaceSessionsDir = path.join(workspaceDir, '.sessions');
    await fs.mkdir(workspaceSessionsDir, { recursive: true });
    await fs.writeFile(path.join(workspaceSessionsDir, `${workspaceId}.jsonl`), JSON.stringify({
      sessionId: workspaceId, provider: 'codex', userPrompt: 'Workspace prompt', timestamp: '2026-08-19T09:00:00.000Z',
    }));

    expect((await findSessions(workspaceDir, [], 'claude')).map(session => session.id)).toEqual([claudeId]);
    expect((await findSessions(workspaceDir, [], 'workspace')).map(session => session.id)).toEqual([workspaceId]);
    expect((await findSessions(workspaceDir, [], 'codex')).map(session => session.id)).toEqual([]);
    expect((await findSessions(workspaceDir)).map(session => session.id)).toEqual([workspaceId, claudeId]);
  });

  it('with newest, reads Claude history from the most recently active and stops once it has enough', async () => {
    const claudeProjDir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', getClaudeProjectFolderName(workspaceDir));
    await fs.mkdir(claudeProjDir, { recursive: true });
    const ids = ['0199a213-81c0-7800-8aa1-bbab2a035b01', '0199a213-81c0-7800-8aa1-bbab2a035b02', '0199a213-81c0-7800-8aa1-bbab2a035b03'];
    for (const [index, id] of ids.entries()) {
      const file = path.join(claudeProjDir, `${id}.jsonl`);
      await fs.writeFile(file, JSON.stringify({ type: 'user', sessionId: id, cwd: workspaceDir, timestamp: '2026-08-19T08:00:00.000Z', message: { content: `Prompt ${index}` } }));
      // The last one written is the most recently active.
      await fs.utimes(file, new Date(2026, 7, 19, 8, index), new Date(2026, 7, 19, 8, index));
    }
    expect((await findSessions(workspaceDir, [], 'claude')).length).toBe(3);
    expect((await findSessions(workspaceDir, [], 'claude', { newest: 1 })).map((session) => session.id)).toEqual([ids[2]]);
  });

  it('continues parsing Antigravity transcript despite malformed JSON lines', async () => {
    const convId = '0199a213-81c0-7800-8aa1-bbab2a035a98';
    const brainLogDir = path.join(process.env.ANTIGRAVITY_CLI_HOME!, 'brain', convId, '.system_generated', 'logs');
    await fs.mkdir(brainLogDir, { recursive: true });

    await fs.writeFile(
      path.join(brainLogDir, 'transcript.jsonl'),
      [
        '{ MALFORMED JSON }',
        JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>Build feature X</USER_REQUEST>', timestamp: '2026-08-19T08:00:00.000Z' }),
        'INVALID LINE',
        JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Feature built.', timestamp: '2026-08-19T08:01:00.000Z' }),
      ].join('\n'),
    );

    const transcript = await getSessionTranscript('antigravity', convId);
    expect(transcript).toHaveLength(2);
    expect(transcript[0].content).toBe('Build feature X');
    expect(transcript[1].content).toBe('Feature built.');
  });

  describe('findActiveAssistants', () => {
    it('returns empty array when no assistants have sessions', async () => {
      const active = await findActiveAssistants(workspaceDir);
      expect(active).toEqual([]);
    });

    it('detects active Antigravity session and ignores unrelated workspaces', async () => {
      const agHistoryPath = path.join(process.env.ANTIGRAVITY_CLI_HOME!, 'history.jsonl');
      await fs.writeFile(
        agHistoryPath,
        [
          JSON.stringify({ conversationId: 'conv-other', workspace: '/some/other/workspace' }),
          JSON.stringify({ conversationId: 'conv-target', workspace: workspaceDir }),
        ].join('\n'),
      );

      const active = await findActiveAssistants(workspaceDir);
      expect(active).toContain('antigravity');

      const activeOther = await findActiveAssistants('/completely/unrelated/path');
      expect(activeOther).not.toContain('antigravity');
    });

    it('detects active Claude session in projects directory', async () => {
      const claudeFolder = getClaudeProjectFolderName(workspaceDir);
      const claudeProjDir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', claudeFolder);
      await fs.mkdir(claudeProjDir, { recursive: true });
      await fs.writeFile(path.join(claudeProjDir, 'session-123.jsonl'), '{"type":"user"}');

      const active = await findActiveAssistants(workspaceDir);
      expect(active).toContain('claude');
    });

    it('detects active Codex session matching workspace cwd', async () => {
      const codexSessionsDir = path.join(process.env.CODEX_HOME!, 'sessions');
      await fs.writeFile(
        path.join(codexSessionsDir, 'rollout-2026.jsonl'),
        [
          JSON.stringify({ type: 'session_meta', payload: { id: '0199a213-81c0-7800-8aa1-bbab2a035a53', cwd: workspaceDir } }),
          JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'hello' } }),
        ].join('\n'),
      );

      const active = await findActiveAssistants(workspaceDir);
      expect(active).toContain('codex');
    });

    it('returns deduplicated list of active assistants when multiple harnesses are active', async () => {
      // 1. Antigravity
      const agHistoryPath = path.join(process.env.ANTIGRAVITY_CLI_HOME!, 'history.jsonl');
      await fs.writeFile(
        agHistoryPath,
        [
          JSON.stringify({ conversationId: 'conv-1', workspace: workspaceDir }),
          JSON.stringify({ conversationId: 'conv-2', workspace: workspaceDir }),
        ].join('\n'),
      );

      // 2. Claude
      const claudeFolder = getClaudeProjectFolderName(workspaceDir);
      const claudeProjDir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', claudeFolder);
      await fs.mkdir(claudeProjDir, { recursive: true });
      await fs.writeFile(path.join(claudeProjDir, 'session-abc.jsonl'), '{"type":"user"}');

      const active = await findActiveAssistants(workspaceDir);
      expect(active).toHaveLength(2);
      expect(active).toContain('antigravity');
      expect(active).toContain('claude');
    });

    it('leverages caching and detects updates when new sessions are added', async () => {
      const agHistoryPath = path.join(process.env.ANTIGRAVITY_CLI_HOME!, 'history.jsonl');
      await fs.writeFile(
        agHistoryPath,
        JSON.stringify({ conversationId: 'conv-cache', workspace: workspaceDir }) + '\n',
      );

      const first = await findActiveAssistants(workspaceDir);
      expect(first).toContain('antigravity');

      // Second check: cache hit
      const second = await findActiveAssistants(workspaceDir);
      expect(second).toContain('antigravity');

      // Add a Claude session: should immediately detect both
      const claudeFolder = getClaudeProjectFolderName(workspaceDir);
      const claudeProjDir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', claudeFolder);
      await fs.mkdir(claudeProjDir, { recursive: true });
      await fs.writeFile(path.join(claudeProjDir, 'session-new.jsonl'), '{"type":"user"}');

      const third = await findActiveAssistants(workspaceDir);
      expect(third).toHaveLength(2);
      expect(third).toContain('antigravity');
      expect(third).toContain('claude');
    });

    const codexRollout = (cwd: string) => [
      JSON.stringify({ type: 'session_meta', payload: { id: '0199a213-81c0-7800-8aa1-bbab2a035a53', cwd } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'hello' } }),
    ].join('\n') + '\n';

    it('detects a Codex session started in a new date folder after the cache is warm', async () => {
      const codexSessionsDir = path.join(process.env.CODEX_HOME!, 'sessions');
      const earlierDay = path.join(codexSessionsDir, '2026', '09', '01');
      await fs.mkdir(earlierDay, { recursive: true });
      await fs.writeFile(path.join(earlierDay, 'rollout-2026-09-01T10-00-00-a.jsonl'), codexRollout('/some/unrelated/project'));
      // Whole seconds, so restoring the time below reproduces the exact mtime.
      const rootTime = new Date('2026-09-01T00:00:00Z');
      await fs.utimes(codexSessionsDir, rootTime, rootTime);

      expect(await findActiveAssistants(workspaceDir)).not.toContain('codex');

      // Codex only touches the day folder; the sessions root keeps its mtime.
      const newDay = path.join(codexSessionsDir, '2026', '09', '02');
      await fs.mkdir(newDay, { recursive: true });
      await fs.writeFile(path.join(newDay, 'rollout-2026-09-02T10-00-00-b.jsonl'), codexRollout(workspaceDir));
      await fs.utimes(codexSessionsDir, rootTime, rootTime);

      expect(await findActiveAssistants(workspaceDir)).toContain('codex');
    });

    it('reads a session header that is longer than the first read', async () => {
      // Real session_meta lines carry base instructions (~20 KB); make this one exceed 32 KB.
      await fs.writeFile(
        path.join(process.env.CODEX_HOME!, 'sessions', 'rollout-2026-09-06T10-00-00-long.jsonl'),
        JSON.stringify({ type: 'session_meta', payload: { id: '0199a213-81c0-7800-8aa1-bbab2a035a53', cwd: workspaceDir, instructions: 'x'.repeat(40_000) } }) + '\n',
      );

      expect(await findActiveAssistants(workspaceDir)).toContain('codex');
    });

    it('rechecks a Codex rollout whose session header was not written yet', async () => {
      const rollout = path.join(process.env.CODEX_HOME!, 'sessions', 'rollout-2026-09-03T10-00-00-c.jsonl');
      await fs.writeFile(rollout, '');

      expect(await findActiveAssistants(workspaceDir)).not.toContain('codex');

      await fs.appendFile(rollout, codexRollout(workspaceDir));

      expect(await findActiveAssistants(workspaceDir)).toContain('codex');
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'serves unchanged Codex rollouts from the cache without rereading them',
      async () => {
        const rollout = path.join(process.env.CODEX_HOME!, 'sessions', 'rollout-2026-09-04T10-00-00-d.jsonl');
        await fs.writeFile(rollout, codexRollout(workspaceDir));
        expect(await findActiveAssistants(workspaceDir)).toContain('codex');

        // An unreadable file can only still be detected through the cache.
        await fs.chmod(rollout, 0o000);
        try {
          expect(await findActiveAssistants(workspaceDir)).toContain('codex');
        } finally {
          await fs.chmod(rollout, 0o644);
        }
      },
    );

    it('forgets a Codex rollout once it is deleted', async () => {
      const rollout = path.join(process.env.CODEX_HOME!, 'sessions', 'rollout-2026-09-05T10-00-00-e.jsonl');
      await fs.writeFile(rollout, codexRollout(workspaceDir));
      expect(await findActiveAssistants(workspaceDir)).toContain('codex');

      await fs.rm(rollout);

      expect(await findActiveAssistants(workspaceDir)).not.toContain('codex');
    });
  });

  describe('findSessions transcript cache', () => {
    const claudeRecord = (sessionId: string, cwd: string, text: string, i: number) => JSON.stringify({
      type: i % 2 === 0 ? 'user' : 'assistant', sessionId, cwd, isSidechain: false,
      timestamp: new Date(Date.UTC(2026, 8, 1, 10, 0, i)).toISOString(),
      message: { role: i % 2 === 0 ? 'user' : 'assistant', content: text },
    }) + '\n';

    async function writeClaudeSession(sessionId: string, turns: number) {
      const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', getClaudeProjectFolderName(workspaceDir));
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${sessionId}.jsonl`);
      await fs.writeFile(file, Array.from({ length: turns }, (_, i) => claudeRecord(sessionId, workspaceDir, `turn ${i}`, i)).join(''));
      return file;
    }

    it('serves an unchanged transcript from the cache without reading it again', async () => {
      const sessionId = '11111111-1111-4111-8111-111111111111';
      const file = await writeClaudeSession(sessionId, 4);
      // Whole seconds, so restoring the time below reproduces the exact mtime.
      const pinned = new Date('2026-09-01T00:00:00Z');
      await fs.utimes(file, pinned, pinned);
      const first = await findSessions(workspaceDir, [], 'claude');
      expect(first[0]?.title).toBe('turn 0');

      // Same size and mtime, different bytes: only a cache hit still reports the old title.
      const content = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, content.replace('turn 0', 'TURN 0'));
      await fs.utimes(file, pinned, pinned);

      expect(await findSessions(workspaceDir, [], 'claude')).toEqual(first);
    });

    it('re-parses a transcript as soon as it grows', async () => {
      const sessionId = '22222222-2222-4222-8222-222222222222';
      const file = await writeClaudeSession(sessionId, 2);
      expect((await findSessions(workspaceDir, [], 'claude'))[0]?.messageCount).toBe(2);

      await fs.appendFile(file, claudeRecord(sessionId, workspaceDir, 'another turn', 2));

      expect((await findSessions(workspaceDir, [], 'claude'))[0]?.messageCount).toBe(3);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'does not open a rollout again once its cwd is known to belong elsewhere',
      async () => {
        const sessionsDir = path.join(process.env.CODEX_HOME!, 'sessions');
        const other = path.join(sessionsDir, 'rollout-2026-09-01T10-00-00-other.jsonl');
        await fs.writeFile(other, JSON.stringify({ type: 'session_meta', payload: { id: '0199a213-81c0-7800-8aa1-bbab2a035a51', cwd: '/some/unrelated/project' } }) + '\n');
        expect(await findSessions(workspaceDir, [], 'codex')).toEqual([]);

        await fs.chmod(other, 0o000);
        try {
          await expect(findSessions(workspaceDir, [], 'codex')).resolves.toEqual([]);
        } finally {
          await fs.chmod(other, 0o644);
        }
      },
    );

    it('still matches an older rollout without a recorded cwd by its content', async () => {
      const sessionsDir = path.join(process.env.CODEX_HOME!, 'sessions');
      await fs.writeFile(path.join(sessionsDir, 'rollout-2026-01-01T10-00-00-legacy.jsonl'), [
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: `work in ${workspaceDir}` } }),
        JSON.stringify({ type: 'session_meta', payload: { id: '0199a213-81c0-7800-8aa1-bbab2a035a52' } }),
      ].join('\n') + '\n');

      const sessions = await findSessions(workspaceDir, [], 'codex');
      expect(sessions.map((s) => s.id)).toEqual(['0199a213-81c0-7800-8aa1-bbab2a035a52']);
      expect(await findSessions(workspaceDir, [], 'codex')).toEqual(sessions);
    });
  });
});
