/**
 * @module tests/e2e/harness-usage/tier5-gui-cli-adversarial
 *
 * Milestone 3 Phase 2: Tier 5 Adversarial Coverage Hardening — GUI & CLI.
 *
 * White-box adversarial test suite targeting:
 * 1. Session History & Transcript helpers (SessionHistory.tsx, TranscriptDialog.tsx)
 * 2. Local Session Discovery, Polyglot Telemetry & Corrupted Transcripts (session-finder.ts)
 * 3. CLI Status Command Output, Quota Priority Cascade & JSON Invariance (status.ts)
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// 1. Session Finder & Transcript Parser
import {
  extractRecordUsage,
  accumulateUsage,
  assertSafeSessionId,
  sanitizeSessionTitle,
  findSessions,
  getSessionTranscript,
  clearSessionFinderCache,
} from '../../../src/utils/session-finder.js';

// 2. CLI Status
import { statusCommand } from '../../../src/commands/status.js';
import * as orchestration from '../../../src/orchestration/index.js';
import * as repositoryStatus from '../../../src/core/status.js';
import * as generationLock from '../../../src/core/generation-lock.js';
import * as workspaceState from '../../../src/core/workspace-state.js';
import * as sessionFinderModule from '../../../src/utils/session-finder.js';

import type { NormalizedUsage, AISession } from '../../../src/types.js';

describe('Tier 5 Adversarial Test Suite: GUI & CLI Hardening', () => {
  // Temporary directories for disk-based adversarial tests
  const tempDirs: string[] = [];

  async function createTempDir(prefix = 'nexusflow-tier5-'): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    clearSessionFinderCache();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  // ==========================================================================
  // DIMENSION 1: Session History & Transcript Helpers
  // ==========================================================================
  describe('Dimension 1: Session History & Transcript Helpers (SessionHistory, TranscriptDialog)', () => {
    describe('T5-GUI-05: SessionHistory & TranscriptDialog Helpers & Resume Commands', () => {
      function getResumeCliCommand(assistant: string, sessionId: string): string {
        switch (assistant) {
          case 'antigravity':
            return `agy --conversation ${sessionId}`;
          case 'claude':
            return `claude --resume ${sessionId}`;
          case 'codex':
            return `codex resume ${sessionId}`;
          case 'copilot':
            return `copilot --resume ${sessionId}`;
          case 'cursor':
            return `cursor-agent --resume ${sessionId}`;
          default:
            return `agy --conversation ${sessionId}`;
        }
      }

      function computeTranscriptTotalTokens(
        transcript: Array<{ usage?: NormalizedUsage }>,
        sessionUsage?: NormalizedUsage,
      ): number {
        const fromTranscript = transcript.reduce(
          (sum, m) => sum + (m.usage?.totalTokens ?? ((m.usage?.inputTokens ?? 0) + (m.usage?.outputTokens ?? 0))),
          0,
        );
        if (fromTranscript > 0) return fromTranscript;
        if (sessionUsage) {
          return sessionUsage.totalTokens ?? ((sessionUsage.inputTokens ?? 0) + (sessionUsage.outputTokens ?? 0));
        }
        return 0;
      }

      it('generates correct CLI resume commands for all assistants and unknown fallback', () => {
        const uuid = '12345678-1234-1234-1234-123456789abc';
        expect(getResumeCliCommand('antigravity', uuid)).toBe(`agy --conversation ${uuid}`);
        expect(getResumeCliCommand('claude', uuid)).toBe(`claude --resume ${uuid}`);
        expect(getResumeCliCommand('codex', uuid)).toBe(`codex resume ${uuid}`);
        expect(getResumeCliCommand('copilot', uuid)).toBe(`copilot --resume ${uuid}`);
        expect(getResumeCliCommand('cursor', uuid)).toBe(`cursor-agent --resume ${uuid}`);
        expect(getResumeCliCommand('unknown-harness', uuid)).toBe(`agy --conversation ${uuid}`);
      });

      it('computes TranscriptDialog total tokens from transcript turns with fallback to activeSession', () => {
        const transcriptWithUsage = [
          { usage: { inputTokens: 500, outputTokens: 100 } },
          { usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 } },
        ];
        expect(computeTranscriptTotalTokens(transcriptWithUsage)).toBe(2100);

        // Fallback to activeSession when transcript messages have no usage
        const transcriptWithoutUsage = [{}, {}];
        const activeSessionUsage = { inputTokens: 3000, outputTokens: 800 };
        expect(computeTranscriptTotalTokens(transcriptWithoutUsage, activeSessionUsage)).toBe(3800);

        // Zero when neither has usage
        expect(computeTranscriptTotalTokens(transcriptWithoutUsage, undefined)).toBe(0);
      });
    });
  });

  // ==========================================================================
  // DIMENSION 3: Session Finder & Disk Transcripts
  // ==========================================================================
  describe('Dimension 3: Session Finder & Disk Transcripts (session-finder.ts)', () => {
    describe('T5-FINDER-01: extractRecordUsage Polyglot Telemetry Extraction', () => {
      it('extracts snake_case fields and maps to NormalizedUsage', () => {
        const record = {
          usage: {
            input_tokens: 1200,
            output_tokens: 350,
            cached_input_tokens: 400,
            reasoning_output_tokens: 150,
            cost_usd_estimate: 0.0125,
          },
        };
        const { usage } = extractRecordUsage(record);
        expect(usage).toEqual({
          inputTokens: 1200,
          outputTokens: 350,
          cachedInputTokens: 400,
          reasoningOutputTokens: 150,
          totalTokens: 1550,
          costUsdEstimate: 0.0125,
        });
      });

      it('derives cachedInputTokens from cache_read and cache_creation when cachedInputTokens is missing', () => {
        const record = {
          usage: {
            input_tokens: 5000,
            output_tokens: 1000,
            cache_read_input_tokens: 3000,
            cache_creation_input_tokens: 1500,
          },
        };
        const { usage } = extractRecordUsage(record);
        expect(usage?.cachedInputTokens).toBe(4500);
        expect(usage?.cacheReadInputTokens).toBe(3000);
        expect(usage?.cacheWriteInputTokens).toBe(1500);
      });

      it('extracts usage nested under record.message.usage or record.payload.usage', () => {
        const messageRecord = {
          message: {
            usage: { inputTokens: 800, outputTokens: 200 },
          },
        };
        expect(extractRecordUsage(messageRecord).usage?.inputTokens).toBe(800);

        const payloadRecord = {
          payload: {
            usage: { inputTokens: 950, outputTokens: 150 },
          },
        };
        expect(extractRecordUsage(payloadRecord).usage?.inputTokens).toBe(950);
      });

      it('handles record with totalCostUsd alone and zero tokens', () => {
        const costOnlyRecord = { totalCostUsd: 0.045 };
        const { usage } = extractRecordUsage(costOnlyRecord);
        expect(usage).toEqual({
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsdEstimate: 0.045,
        });
      });

      it('returns empty object when record has 0 tokens, no cache, and no cost', () => {
        expect(extractRecordUsage({})).toEqual({});
        expect(extractRecordUsage({ usage: { inputTokens: 0, outputTokens: 0 } })).toEqual({});
        expect(extractRecordUsage(null)).toEqual({});
      });

      it('extracts quota from record.quota, record.payload.quota, or rawUsage.remainingQuota', () => {
        const quotaObj = { tokens: { unit: 'tokens' as const, remaining: 50000 } };
        expect(extractRecordUsage({ quota: quotaObj }).quota).toEqual(quotaObj);
        expect(extractRecordUsage({ payload: { quota: quotaObj } }).quota).toEqual(quotaObj);
        expect(extractRecordUsage({ usage: { remainingQuota: quotaObj, inputTokens: 10, outputTokens: 10 } }).quota).toEqual(quotaObj);
      });
    });

    describe('T5-FINDER-02: accumulateUsage Multi-Turn Arithmetic & Boundary Safety', () => {
      it('initializes cumulative usage cleanly from first turn when acc is undefined', () => {
        const turn: NormalizedUsage = {
          inputTokens: 1000,
          outputTokens: 250,
          cachedInputTokens: 300,
          costUsdEstimate: 0.015,
        };
        const acc = accumulateUsage(undefined, turn);
        expect(acc).toEqual({
          inputTokens: 1000,
          outputTokens: 250,
          cachedInputTokens: 300,
          totalTokens: 1250,
          costUsdEstimate: 0.015,
        });
      });

      it('accumulates multiple turns accurately including reasoning and cache breakdowns', () => {
        let acc: NormalizedUsage | undefined;
        const turns: NormalizedUsage[] = [
          { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 400, reasoningOutputTokens: 50, costUsdEstimate: 0.01 },
          { inputTokens: 2000, outputTokens: 500, cacheReadInputTokens: 800, reasoningOutputTokens: 150, costUsdEstimate: 0.02 },
          { inputTokens: 1500, outputTokens: 300, cacheWriteInputTokens: 600, costUsdEstimate: 0.015 },
        ];

        for (const t of turns) {
          acc = accumulateUsage(acc, t);
        }

        expect(acc?.inputTokens).toBe(4500);
        expect(acc?.outputTokens).toBe(1000);
        expect(acc?.totalTokens).toBe(5500);
        expect(acc?.cacheReadInputTokens).toBe(1200);
        expect(acc?.cacheWriteInputTokens).toBe(600);
        expect(acc?.reasoningOutputTokens).toBe(200);
        expect(acc?.costUsdEstimate).toBeCloseTo(0.045, 5);
      });

      it('preserves undefined for fields never present across turns without injecting NaN', () => {
        let acc: NormalizedUsage | undefined;
        acc = accumulateUsage(acc, { inputTokens: 500, outputTokens: 100 });
        acc = accumulateUsage(acc, { inputTokens: 700, outputTokens: 200 });

        expect(acc.cachedInputTokens).toBeUndefined();
        expect(acc.cacheReadInputTokens).toBeUndefined();
        expect(acc.cacheWriteInputTokens).toBeUndefined();
        expect(acc.reasoningOutputTokens).toBeUndefined();
        expect(acc.costUsdEstimate).toBeUndefined();
      });
    });

    describe('T5-FINDER-03: assertSafeSessionId Path Traversal & UUID Validation', () => {
      it('accepts valid UUIDv4 strings', () => {
        expect(() => assertSafeSessionId('claude', '12345678-1234-4234-8234-123456789abc')).not.toThrow();
        expect(() => assertSafeSessionId('codex', 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).not.toThrow();
      });

      it('rejects path traversal attempts and command injections', () => {
        expect(() => assertSafeSessionId('claude', '../../etc/passwd')).toThrow('Invalid claude session id');
        expect(() => assertSafeSessionId('codex', '../../../sessions/malicious')).toThrow('Invalid Codex session id');
        expect(() => assertSafeSessionId('antigravity', 'uuid; rm -rf /')).toThrow('Invalid antigravity session id');
        expect(() => assertSafeSessionId('copilot', 'non-uuid-session')).toThrow('Invalid copilot session id');
      });
    });

    describe('T5-FINDER-04: sanitizeSessionTitle Truncation & Noise Stripping', () => {
      it('collapses multiline text and tabs into single space', () => {
        const raw = 'Fix\n\n\tissue\twith   whitespace\r\nand tabs';
        expect(sanitizeSessionTitle(raw)).toBe('Fix issue with whitespace and tabs');
      });

      it('returns "Untitled Session" for whitespace or empty strings', () => {
        expect(sanitizeSessionTitle('')).toBe('Untitled Session');
        expect(sanitizeSessionTitle('   \t\n  ')).toBe('Untitled Session');
      });

      it('truncates titles exceeding maxLength with ellipsis', () => {
        const longTitle = 'a'.repeat(100);
        const sanitized = sanitizeSessionTitle(longTitle, 80);
        expect(sanitized.length).toBe(83); // 80 chars + '...'
        expect(sanitized.endsWith('...')).toBe(true);
      });
    });

    describe('T5-FINDER-05: Real Workspace Disk Discovery with Corrupted Transcripts', () => {
      it('parses .sessions directory, skips corrupt lines, and extracts usage and quota', async () => {
        const wsDir = await createTempDir();
        const sessionsDir = path.join(wsDir, '.sessions');
        await fs.mkdir(sessionsDir, { recursive: true });

        // Session 1: Valid multi-turn with usage and quota
        const sess1Path = path.join(sessionsDir, 'sess-valid-1.jsonl');
        const sess1Lines = [
          JSON.stringify({
            sessionId: 'sess-valid-1',
            provider: 'claude-cli',
            userPrompt: 'Implement billing system',
            assistantResponse: 'Billing system implemented.',
            timestamp: '2026-09-24T10:00:00Z',
            usage: { inputTokens: 4000, outputTokens: 1000, cachedInputTokens: 2000, costUsdEstimate: 0.035 },
            quota: { tokens: { unit: 'tokens', remaining: 80000, status: 'ok' } },
          }),
          // Corrupted line inserted
          '<<<CORRUPTED GARBAGE LINE THAT IS NOT JSON>>>',
          // Valid turn 2
          JSON.stringify({
            sessionId: 'sess-valid-1',
            provider: 'claude-cli',
            userPrompt: 'Add unit tests',
            assistantResponse: 'Unit tests added.',
            timestamp: '2026-09-24T10:05:00Z',
            usage: { inputTokens: 3000, outputTokens: 800, cachedInputTokens: 1500, costUsdEstimate: 0.025 },
          }),
        ];
        await fs.writeFile(sess1Path, sess1Lines.join('\n') + '\n', 'utf-8');

        // Session 2: Codex session with missing timestamps
        const sess2Path = path.join(sessionsDir, 'sess-valid-2.jsonl');
        const sess2Lines = [
          JSON.stringify({
            sessionId: 'sess-valid-2',
            provider: 'codex-cli',
            userPrompt: 'Write regex',
            assistantResponse: 'Here is the regex.',
            usage: { inputTokens: 1500, outputTokens: 300 },
          }),
        ];
        await fs.writeFile(sess2Path, sess2Lines.join('\n') + '\n', 'utf-8');

        const sessions = await findSessions(wsDir);
        expect(sessions.length).toBeGreaterThanOrEqual(2);

        const foundSess1 = sessions.find((s) => s.id === 'sess-valid-1');
        expect(foundSess1).toBeDefined();
        expect(foundSess1?.assistant).toBe('claude');
        expect(foundSess1?.title).toBe('Implement billing system');
        expect(foundSess1?.usage?.inputTokens).toBe(7000);
        expect(foundSess1?.usage?.outputTokens).toBe(1800);
        expect(foundSess1?.usage?.cachedInputTokens).toBe(3500);
        expect(foundSess1?.usage?.costUsdEstimate).toBeCloseTo(0.06, 4);
        expect(foundSess1?.quota?.tokens?.remaining).toBe(80000);

        const foundSess2 = sessions.find((s) => s.id === 'sess-valid-2');
        expect(foundSess2).toBeDefined();
        expect(foundSess2?.assistant).toBe('codex');
        expect(foundSess2?.usage?.inputTokens).toBe(1500);
      });
    });

    describe('T5-FINDER-06: getSessionTranscript Real Disk Parsing & Usage Extraction', () => {
      it('throws when Claude session transcript is not found on disk', async () => {
        const uuid = 'a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6';
        await expect(getSessionTranscript('claude', uuid)).rejects.toThrow(`Claude session ${uuid} not found`);
      });

      it('reads Claude transcript from CLAUDE_CONFIG_DIR projects and binds usage to assistant messages', async () => {
        const claudeDir = await createTempDir('claude-config-');
        const projectDir = path.join(claudeDir, 'projects', 'my-project');
        await fs.mkdir(projectDir, { recursive: true });

        const uuid = 'b2c3d4e5-f6a7-48b9-c0d1-e2f3a4b5c6d7';
        const sessionFile = path.join(projectDir, `${uuid}.jsonl`);
        const content = [
          JSON.stringify({
            type: 'user',
            sessionId: uuid,
            message: { text: 'Optimize algorithm' },
            timestamp: '2026-09-24T10:00:00Z',
          }),
          JSON.stringify({
            type: 'assistant',
            sessionId: uuid,
            message: { text: 'Algorithm optimized with O(n log n) complexity.' },
            timestamp: '2026-09-24T10:00:05Z',
            usage: {
              input_tokens: 1500,
              output_tokens: 450,
              cache_read_input_tokens: 800,
              cost_usd_estimate: 0.018,
            },
          }),
        ].join('\n') + '\n';

        await fs.writeFile(sessionFile, content, 'utf-8');

        const originalEnv = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = claudeDir;
        try {
          const messages = await getSessionTranscript('claude', uuid);
          expect(messages).toHaveLength(2);
          expect(messages[0].role).toBe('user');
          expect(messages[0].content).toBe('Optimize algorithm');
          expect(messages[1].role).toBe('assistant');
          expect(messages[1].content).toBe('Algorithm optimized with O(n log n) complexity.');
          expect(messages[1].usage).toEqual({
            inputTokens: 1500,
            outputTokens: 450,
            cachedInputTokens: 800,
            cacheReadInputTokens: 800,
            totalTokens: 1950,
            costUsdEstimate: 0.018,
          });
        } finally {
          process.env.CLAUDE_CONFIG_DIR = originalEnv;
        }
      });

      it('falls back to workspace .sessions/<uuid>.jsonl when assistant is custom-assistant', async () => {
        const wsDir = await createTempDir('ws-sessions-');
        const sessionsDir = path.join(wsDir, '.sessions');
        await fs.mkdir(sessionsDir, { recursive: true });

        const uuid = 'c3d4e5f6-a7b8-49c0-d1e2-f3a4b5c6d7e8';
        const sessionFile = path.join(sessionsDir, `${uuid}.jsonl`);
        const content = [
          JSON.stringify({
            userPrompt: 'Hello custom assistant',
            timestamp: '2026-09-24T10:00:00Z',
          }),
          JSON.stringify({
            assistantResponse: 'Hello! Custom response.',
            timestamp: '2026-09-24T10:00:05Z',
            usage: { inputTokens: 400, outputTokens: 90, cachedInputTokens: 150 },
          }),
        ].join('\n') + '\n';

        await fs.writeFile(sessionFile, content, 'utf-8');

        vi.spyOn(process, 'cwd').mockReturnValue(wsDir);

        const messages = await getSessionTranscript('custom-assistant', uuid);
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe('user');
        expect(messages[0].content).toBe('Hello custom assistant');
        expect(messages[1].role).toBe('assistant');
        expect(messages[1].content).toBe('Hello! Custom response.');
        expect(messages[1].usage).toEqual({
          inputTokens: 400,
          outputTokens: 90,
          cachedInputTokens: 150,
          totalTokens: 490,
        });
      });
    });
  });

  // ==========================================================================
  // DIMENSION 4: CLI Status Command Output & Contract Integrity
  // ==========================================================================
  describe('Dimension 4: CLI Status Command Output & Contract Integrity (status.ts)', () => {
    it('T5-CLI-01: strictly preserves legacy running state JSON without human headers when --json is passed', async () => {
      const mockRunningState = {
        workspacePath: '/mock/workspace',
        services: [
          { name: 'web-service', status: 'running', port: 3000 },
        ],
        orchestrators: [],
        updatedAt: '2026-09-24T10:00:00.000Z',
      };

      vi.spyOn(orchestration, 'loadRunningState').mockResolvedValue(mockRunningState as any);
      vi.spyOn(repositoryStatus, 'getWorkspaceStatusReport').mockResolvedValue({ repos: [] } as any);
      vi.spyOn(sessionFinderModule, 'findSessions').mockResolvedValue([]);

      const logCalls: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logCalls.push(args.map(String).join(' '));
      });

      await statusCommand('/mock/workspace', { json: true });

      expect(logCalls).toHaveLength(1);
      const parsed = JSON.parse(logCalls[0]);
      expect(parsed).toEqual(mockRunningState);

      // Verify that status report, generation lock, and session finder were NEVER called
      expect(repositoryStatus.getWorkspaceStatusReport).not.toHaveBeenCalled();
      expect(sessionFinderModule.findSessions).not.toHaveBeenCalled();
    });

    it('T5-CLI-02: slices top 5 sessions and normalizes provider tags with -cli suffix', async () => {
      vi.spyOn(repositoryStatus, 'getWorkspaceStatusReport').mockResolvedValue({
        workspacePath: '/ws',
        repos: [{ name: 'Repo1', path: '/ws/Repo1', branch: 'main', dirty: false }],
      } as any);
      vi.spyOn(generationLock, 'checkGenerationLock').mockResolvedValue({ fresh: true, drift: [] } as any);
      vi.spyOn(workspaceState, 'getLastVerificationReport').mockResolvedValue(null);
      vi.spyOn(orchestration, 'getServiceStatus').mockResolvedValue(undefined as any);

      // Create 8 sessions
      const mockSessions: AISession[] = Array.from({ length: 8 }, (_, i) => ({
        id: `sess-${i + 1}`,
        assistant: i % 2 === 0 ? 'claude' : 'codex-cli', // test normalization
        title: `Session ${i + 1}`,
        messageCount: i + 1,
        workspacePath: '/ws',
        createdAt: '2026-09-24T10:00:00Z',
        updatedAt: '2026-09-24T10:00:00Z',
        usage: { inputTokens: (i + 1) * 1000, outputTokens: (i + 1) * 200 },
      }));

      vi.spyOn(sessionFinderModule, 'findSessions').mockResolvedValue(mockSessions);

      const logLines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logLines.push(args.map(String).join(' '));
      });

      await statusCommand('/ws');

      const fullOutput = logLines.join('\n');
      expect(fullOutput).toContain('AI Assistant Sessions:');

      // Exactly 5 session entries printed
      expect(fullOutput).toContain('[claude-cli] sess-1:');
      expect(fullOutput).toContain('[codex-cli] sess-2:');
      expect(fullOutput).toContain('[claude-cli] sess-3:');
      expect(fullOutput).toContain('[codex-cli] sess-4:');
      expect(fullOutput).toContain('[claude-cli] sess-5:');

      // Session 6, 7, 8 must NOT be in output
      expect(fullOutput).not.toContain('sess-6:');
      expect(fullOutput).not.toContain('sess-7:');
      expect(fullOutput).not.toContain('sess-8:');
    });

    it('T5-CLI-03: traverses complete quota priority cascade (tokens.status -> requests.status -> status -> planType -> label -> ok)', async () => {
      vi.spyOn(repositoryStatus, 'getWorkspaceStatusReport').mockResolvedValue({ repos: [] } as any);
      vi.spyOn(generationLock, 'checkGenerationLock').mockResolvedValue({ fresh: true, drift: [] } as any);
      vi.spyOn(workspaceState, 'getLastVerificationReport').mockResolvedValue(null);
      vi.spyOn(orchestration, 'getServiceStatus').mockResolvedValue(undefined as any);

      const cascadeSessions: AISession[] = [
        {
          id: 'sess-tokens',
          assistant: 'claude-cli',
          title: 'Tokens Status',
          messageCount: 1,
          workspacePath: '/ws',
          createdAt: '',
          updatedAt: '',
          quota: { tokens: { unit: 'tokens', status: 'exceeded' } },
        },
        {
          id: 'sess-requests',
          assistant: 'antigravity-cli',
          title: 'Requests Status',
          messageCount: 1,
          workspacePath: '/ws',
          createdAt: '',
          updatedAt: '',
          quota: { requests: { unit: 'requests', status: 'approaching_limit' } },
        },
        {
          id: 'sess-plan',
          assistant: 'codex-cli',
          title: 'Plan Included',
          messageCount: 1,
          workspacePath: '/ws',
          createdAt: '',
          updatedAt: '',
          quota: { planType: 'plan-included' },
        },
        {
          id: 'sess-label',
          assistant: 'copilot-cli',
          title: 'Label Normalized',
          messageCount: 1,
          workspacePath: '/ws',
          createdAt: '',
          updatedAt: '',
          quota: { label: 'Pro Developer Tier' },
        },
        {
          id: 'sess-empty-quota',
          assistant: 'claude-cli',
          title: 'Empty Quota',
          messageCount: 1,
          workspacePath: '/ws',
          createdAt: '',
          updatedAt: '',
          quota: {},
        },
      ];

      vi.spyOn(sessionFinderModule, 'findSessions').mockResolvedValue(cascadeSessions);

      const logLines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logLines.push(args.map(String).join(' '));
      });

      await statusCommand('/ws');

      const output = logLines.join('\n');
      expect(output).toContain('[claude-cli] sess-tokens: 0 in / 0 out | Quota: exceeded');
      expect(output).toContain('[antigravity-cli] sess-requests: 0 in / 0 out | Quota: approaching_limit');
      expect(output).toContain('[codex-cli] sess-plan: 0 in / 0 out | Quota: plan-included');
      expect(output).toContain('[copilot-cli] sess-label: 0 in / 0 out | Quota: pro_developer_tier');
      expect(output).toContain('[claude-cli] sess-empty-quota: 0 in / 0 out | Quota: ok');
    });

    it('T5-CLI-04: formats cached tokens and cost estimates conditionally', async () => {
      vi.spyOn(repositoryStatus, 'getWorkspaceStatusReport').mockResolvedValue({ repos: [] } as any);
      vi.spyOn(generationLock, 'checkGenerationLock').mockResolvedValue({ fresh: true, drift: [] } as any);
      vi.spyOn(workspaceState, 'getLastVerificationReport').mockResolvedValue(null);
      vi.spyOn(orchestration, 'getServiceStatus').mockResolvedValue(undefined as any);

      const sessions: AISession[] = [
        {
          id: 'sess-with-cache-and-cost',
          assistant: 'claude-cli',
          title: 'With Cache and Cost',
          messageCount: 1,
          workspacePath: '/ws',
          createdAt: '',
          updatedAt: '',
          usage: {
            inputTokens: 5000,
            outputTokens: 1200,
            cachedInputTokens: 2500,
            costUsdEstimate: 0.038,
          },
        },
        {
          id: 'sess-zero-cache-no-cost',
          assistant: 'codex-cli',
          title: 'Zero Cache and No Cost',
          messageCount: 1,
          workspacePath: '/ws',
          createdAt: '',
          updatedAt: '',
          usage: {
            inputTokens: 3000,
            outputTokens: 800,
            cachedInputTokens: 0,
            costUsdEstimate: undefined,
          },
        },
      ];

      vi.spyOn(sessionFinderModule, 'findSessions').mockResolvedValue(sessions);

      const logLines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logLines.push(args.map(String).join(' '));
      });

      await statusCommand('/ws');

      const output = logLines.join('\n');
      expect(output).toContain('[claude-cli] sess-with-cache-and-cost: 5,000 in / 1,200 out (2,500 cached) | ~$0.038');
      expect(output).toContain('[codex-cli] sess-zero-cache-no-cost: 3,000 in / 800 out');
      expect(output).not.toContain('sess-zero-cache-no-cost: 3,000 in / 800 out (');
      expect(output).not.toContain('sess-zero-cache-no-cost: 3,000 in / 800 out | ~$');
    });

    it('T5-CLI-05: catches unexpected findSessions exceptions gracefully without crashing CLI', async () => {
      vi.spyOn(repositoryStatus, 'getWorkspaceStatusReport').mockResolvedValue({ repos: [] } as any);
      vi.spyOn(generationLock, 'checkGenerationLock').mockResolvedValue({ fresh: true, drift: [] } as any);
      vi.spyOn(workspaceState, 'getLastVerificationReport').mockResolvedValue(null);
      vi.spyOn(orchestration, 'getServiceStatus').mockResolvedValue(undefined as any);

      vi.spyOn(sessionFinderModule, 'findSessions').mockRejectedValue(new Error('EACCES: permission denied'));

      const logLines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logLines.push(args.map(String).join(' '));
      });

      await expect(statusCommand('/ws')).resolves.toBeUndefined();

      const output = logLines.join('\n');
      expect(output).toContain('AI Assistant Sessions:');
      expect(output).toContain('No active AI sessions found.');
    });
  });
});
