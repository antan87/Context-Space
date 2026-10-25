import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  loadWorkspaceState,
  saveWorkspaceState,
  recordRepoSync,
  markValidated,
  recordVerificationReport,
  getLastVerificationReport,
} from './workspace-state.js';
import type { WorkspaceState, WorkspaceVerificationReport } from '../types.js';

vi.mock('node:fs/promises');
vi.mock('./locks.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./locks.js')>(),
  acquireLock: vi.fn(async () => async () => {}),
}));

/** Parses the JSON written by the most recent writeFile call. */
function lastWritten(): WorkspaceState {
  const calls = vi.mocked(fs.writeFile).mock.calls;
  const data = calls[calls.length - 1][1] as string;
  return JSON.parse(data) as WorkspaceState;
}

describe('workspace-state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
  });

  describe('loadWorkspaceState', () => {
    it('returns an empty skeleton when the file is absent', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const state = await loadWorkspaceState('/ws');

      expect(state.workspacePath).toBe('/ws');
      expect(state.repos).toEqual({});
    });

    it('round-trips an existing state file', async () => {
      const existing: WorkspaceState = {
        workspacePath: '/ws',
        repos: { api: { repoName: 'api', lastSyncStatus: 'rebased' } },
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing) as any);

      const state = await loadWorkspaceState('/ws');

      expect(state.repos.api.lastSyncStatus).toBe('rebased');
    });
  });

  describe('recordRepoSync', () => {
    beforeEach(() => {
      vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    it('sets pendingValidation when a repo was rebased', async () => {
      const entry = await recordRepoSync('/ws', 'api', {
        status: 'rebased',
        message: 'Rebased onto latest base',
      });

      expect(entry.pendingValidation).toBe(true);
      expect(entry.lastSyncStatus).toBe('rebased');
      expect(entry.lastSyncedAt).toBeTruthy();
      expect(lastWritten().repos.api.pendingValidation).toBe(true);
    });

    it('does not set pendingValidation for an up-to-date repo', async () => {
      const entry = await recordRepoSync('/ws', 'api', {
        status: 'up-to-date',
        message: 'Up to date',
      });

      expect(entry.pendingValidation).toBe(false);
    });

    it('preserves a prior pending flag on a later no-op sync', async () => {
      const existing: WorkspaceState = {
        workspacePath: '/ws',
        repos: { api: { repoName: 'api', pendingValidation: true } },
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing) as any);

      const entry = await recordRepoSync('/ws', 'api', {
        status: 'up-to-date',
        message: 'Up to date',
      });

      expect(entry.pendingValidation).toBe(true);
    });
  });

  describe('markValidated', () => {
    it('records the result and clears the pending flag', async () => {
      const existing: WorkspaceState = {
        workspacePath: '/ws',
        repos: { api: { repoName: 'api', pendingValidation: true } },
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing) as any);

      const entry = await markValidated('/ws', 'api', 'pass');

      expect(entry.lastValidationResult).toBe('pass');
      expect(entry.pendingValidation).toBe(false);
      expect(entry.lastValidatedAt).toBeTruthy();
    });
  });

  describe('recordVerificationReport', () => {
    it('persists verification report and updates repo state', async () => {
      const existing: WorkspaceState = {
        workspacePath: '/ws',
        repos: { api: { repoName: 'api', pendingValidation: true } },
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing) as any);

      const report: WorkspaceVerificationReport = {
        workspacePath: '/ws',
        overallStatus: 'pass',
        canProgress: true,
        verifiedAt: '2026-09-11T12:00:00.000Z',
        durationMs: 1500,
        repos: [
          {
            repoName: 'api',
            repoPath: '/ws/api',
            status: 'pass',
            command: 'npm test',
            exitCode: 0,
            headSha: 'abc1234',
            clean: true,
            durationMs: 1500,
            verifiedAt: '2026-09-11T12:00:00.000Z',
          },
        ],
      };

      const updated = await recordVerificationReport('/ws', report);

      expect(updated.lastVerification).toEqual(report);
      expect(updated.repos.api.lastValidationResult).toBe('pass');
      expect(updated.repos.api.pendingValidation).toBe(false);
      expect(updated.repos.api.lastVerification?.headSha).toBe('abc1234');

      const saved = lastWritten();
      expect(saved.lastVerification?.overallStatus).toBe('pass');
      expect(saved.repos.api.lastVerification?.status).toBe('pass');
    });
  });

  describe('getLastVerificationReport', () => {
    it('returns null when no verification was recorded', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const report = await getLastVerificationReport('/ws');
      expect(report).toBeNull();
    });

    it('returns recorded report when present', async () => {
      const existing: WorkspaceState = {
        workspacePath: '/ws',
        repos: {},
        lastVerification: {
          workspacePath: '/ws',
          overallStatus: 'pass',
          canProgress: true,
          verifiedAt: '2026-09-11T12:00:00.000Z',
          durationMs: 500,
          repos: [],
        },
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing) as any);
      const report = await getLastVerificationReport('/ws');
      expect(report?.overallStatus).toBe('pass');
    });
  });

  describe('saveWorkspaceState', () => {
    it('writes to .contextspace/state.json and unlinks legacy state files', async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      const state: WorkspaceState = {
        workspacePath: '/ws',
        repos: { api: { repoName: 'api', lastSyncStatus: 'up-to-date' } },
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      await saveWorkspaceState(state);

      // Verify write occurred to primary location
      const calls = vi.mocked(fs.writeFile).mock.calls;
      const targetPath = calls[calls.length - 1][0] as string;
      expect(targetPath).toContain('.contextspace');
      expect(targetPath).toContain('state.json');

      // Verify unlinking attempted for legacy state files
      const unlinked = vi.mocked(fs.unlink).mock.calls.map((c) => String(c[0]));
      expect(unlinked).toContain(path.join('/ws', '.contextspace-state.json'));
      expect(unlinked).toContain(path.join('/ws', '.nexusflow-state.json'));
    });
  });
});
