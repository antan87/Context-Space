import { describe, it, expect, vi, beforeEach } from 'vitest';

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { execa } from 'execa';
import { app, archiveRefusedAction, canOfferClaudeDesktopTransfer } from './server.js';
import * as archive from './core/archive.js';
import * as workspace from './core/workspace.js';
import * as config from './core/config.js';
import * as desktop from './commands/desktop.js';
import * as configPaths from './core/config-paths.js';
import * as analyzers from './analyzers/index.js';
import * as generators from './generators/index.js';
import * as workflows from './utils/workflows.js';
import * as skillsCatalog from './utils/skills-catalog.js';
import * as agentsCatalog from './resources/agents-catalog.js';
import * as resourceService from './resources/service.js';
import * as detectAi from './utils/detect-ai.js';
import { clearCustomDomainRegistrations, registerSampleDomainPacks } from './core/domain-packs.js';
import { HARNESSES } from './harnesses/registry.js';

import * as newRepo from './core/new-repo.js';
import * as orchestration from './orchestration/index.js';
import * as sessionFinder from './utils/session-finder.js';
import { ProviderRegistry } from './agent/ProviderRegistry.js';
import { workroomManager } from './workrooms/manager.js';
import { clearEditorDetectionCache } from './utils/detect-editors.js';

// Mock dependencies
vi.mock('node:fs/promises');
vi.mock('execa');
vi.mock('./core/workspace.js');
vi.mock('./core/archive.js');
vi.mock('./core/config.js');
vi.mock('./core/config-paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./core/config-paths.js')>()),
  checkConfigPaths: vi.fn(),
}));
vi.mock('./core/domain-packs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core/domain-packs.js')>();
  return {
    ...actual,
    saveDomainPack: async (pack: Parameters<typeof actual.registerCustomDomainPack>[0]) => actual.registerCustomDomainPack(pack),
    saveOrganization: async (org: Parameters<typeof actual.registerCustomOrganization>[0]) => actual.registerCustomOrganization(org),
    deleteDomainPack: async (id: string) => actual.unregisterCustomDomainPack(id),
    deleteOrganization: async (id: string) => actual.unregisterCustomOrganization(id),
  };
});
vi.mock('./utils/system-scanner.js');
vi.mock('./utils/update-check.js');
vi.mock('./analyzers/index.js');
vi.mock('./generators/index.js');
vi.mock('./utils/workflows.js');
vi.mock('./utils/skills-catalog.js');
vi.mock('./resources/agents-catalog.js');
vi.mock('./resources/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resources/service.js')>();
  return {
    ...actual,
    withResourceAdministrationLock: vi.fn((operation: () => Promise<unknown>) => operation()),
    validateResourceSelections: vi.fn().mockResolvedValue(undefined),
    previewResourceSelections: vi.fn(actual.previewResourceSelections),
  };
});
vi.mock('./utils/detect-ai.js', () => ({
  detectAIAssistants: vi.fn().mockResolvedValue([])
}));
vi.mock('./utils/terminal-launch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/terminal-launch.js')>();
  return {
    ...actual,
    launchWorkspaceTerminal: vi.fn().mockResolvedValue({
      success: true,
      command: 'claude --resume 0199a213-81c0-7800-8aa1-bbab2a035a54',
    }),
  };
});
vi.mock('./core/new-repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core/new-repo.js')>();
  return {
    ...actual,
    createNewRepo: vi.fn(),
  };
});
vi.mock('./orchestration/index.js');



/** Runs `run` with only `commands` on PATH, standing for installed editors (node:fs/promises is mocked here, so sync fs). */
async function withEditorsOnPath<T>(commands: readonly string[], run: () => Promise<T>): Promise<T> {
  const bin = fsSync.mkdtempSync(path.join(os.tmpdir(), 'editor-bin-'));
  const savedPath = process.env.PATH;
  for (const command of commands) {
    fsSync.writeFileSync(path.join(bin, process.platform === 'win32' ? `${command}.cmd` : command), process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  }
  process.env.PATH = bin;
  clearEditorDetectionCache();
  try {
    return await run();
  } finally {
    process.env.PATH = savedPath;
    clearEditorDetectionCache();
    fsSync.rmSync(bin, { recursive: true, force: true });
  }
}

describe('Server API Endpoints Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEditorDetectionCache();
  });

  it('keeps diagnostic capture and export behind the local host/origin guards', async () => {
    for (const route of ['preview', 'review', 'export']) {
      const response = await app.request(`/api/diagnostics/${route}`, {
        method: 'POST', headers: { Origin: 'https://outside.example', 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(response.status).toBe(403);
    }
    const response = await app.request('/api/data-guide', { headers: { Host: 'outside.example' } });
    expect(response.status).toBe(403);
  });

  it('rejects an invalid transcript session id at the HTTP boundary', async () => {
    const response = await app.request('/api/session/codex/53/transcript');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid session UUID format.' });
  });

  describe('POST /api/open-editor', () => {
    const workspacesDir = path.resolve('mock-workspaces');
    const workspacePath = path.join(workspacesDir, 'test-workspace');

    it('rejects cross-origin requests to open-editor', async () => {
      const response = await app.request('/api/open-editor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://malicious-site.example.com',
        },
        body: JSON.stringify({ workspacePath, command: 'code' }),
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'Forbidden cross-origin request.' });
    });

    it('should return 400 for forbidden editor commands', async () => {
      const response = await app.request('/api/open-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspacePath: '/mock/workspace/path',
          command: 'rm -rf /'
        })
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Forbidden editor command');
    });

    it('explicitly rejects legacy interactive terminal editors', async () => {
      const response = await app.request('/api/open-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, command: 'nvim' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Forbidden editor command' });
    });

    it('should return 400 if workspace path does not exist', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir } as any);
      vi.spyOn(fs, 'stat').mockRejectedValue(new Error('File not found'));

      const response = await app.request('/api/open-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspacePath,
          command: 'code-insiders'
        })
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Workspace path does not exist');
    });

    it('should return 400 if workspace path is not a directory', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir } as any);
      vi.spyOn(fs, 'stat').mockResolvedValue({
        isDirectory: () => false
      } as any);

      const response = await app.request('/api/open-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspacePath,
          command: 'code-insiders'
        })
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Workspace path is not a directory');
    });

    it('should launch a detected editor through the server-owned target', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir } as any);
      vi.spyOn(fs, 'stat').mockResolvedValue({
        isDirectory: () => true
      } as any);
      vi.spyOn(fs, 'access').mockRejectedValue(new Error('No generated workspace file'));
      vi.spyOn(fs, 'realpath').mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.spyOn(workspace, 'loadWorkspaceManifest').mockResolvedValue({
        id: 'test-workspace',
        workspacePath,
      } as any);

      vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as any);

      const response = await withEditorsOnPath(['code-insiders'], () => app.request('/api/open-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspacePath,
          command: 'code-insiders'
        })
      }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      expect(execa).toHaveBeenCalledWith('code-insiders', [process.platform === 'win32' ? `"${workspacePath}"` : workspacePath], {
        stdio: 'ignore',
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    });

    it('should launch a specific file when filePath is provided', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir } as any);
      vi.spyOn(fs, 'stat').mockResolvedValue({
        isDirectory: () => true
      } as any);
      vi.spyOn(fs, 'realpath').mockImplementation(async (candidate) => path.resolve(String(candidate)));
      // A launch target must exist as a regular file, so describe one.
      vi.spyOn(fs, 'lstat').mockResolvedValue({
        isSymbolicLink: () => false,
        isFile: () => true,
      } as any);
      vi.spyOn(workspace, 'loadWorkspaceManifest').mockResolvedValue({
        id: 'test-workspace',
        workspacePath,
      } as any);

      vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as any);

      const targetFile = 'src/example.ts';
      const expectedTarget = path.resolve(workspacePath, targetFile);

      const response = await withEditorsOnPath(['code-insiders'], () => app.request('/api/open-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspacePath,
          command: 'code-insiders',
          filePath: targetFile,
        })
      }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      expect(execa).toHaveBeenCalledWith('code-insiders', [process.platform === 'win32' ? `"${expectedTarget}"` : expectedTarget], {
        stdio: 'ignore',
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    });

    it('should launch an in-place repo located in devDir', async () => {
      const devDir = path.resolve('mock-dev-dir');
      const repoDir = path.join(devDir, 'in-place-repo');
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir, devDir } as any);
      vi.spyOn(fs, 'stat').mockResolvedValue({
        isDirectory: () => true
      } as any);
      // A launch target under devDir must resolve inside it and be a git repository.
      vi.spyOn(fs, 'realpath').mockImplementation(async (candidate) => path.resolve(String(candidate)));
      // Only `.git` exists: a blanket "exists" would also make the editor look for a .code-workspace file.
      vi.spyOn(fs, 'access').mockImplementation(async (candidate) => {
        if (path.basename(String(candidate)) === '.git') return undefined;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as any);

      const response = await withEditorsOnPath(['code'], () => app.request('/api/open-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspacePath: repoDir,
          command: 'code',
        })
      }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      expect(execa).toHaveBeenCalledWith('code', [process.platform === 'win32' ? `"${repoDir}"` : repoDir], {
        stdio: 'ignore',
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    });

    it('rejects an existing directory outside the configured workspace root and devDir', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir, devDir: path.resolve('mock-dev-dir') } as any);

      const response = await app.request('/api/open-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspacePath: path.resolve('outside-workspace'),
          command: 'code',
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Invalid workspace path' });
    });
  });

  describe('workspace launch targets', () => {
    const workspacesDir = path.resolve('launch-workspaces');
    const workspacePath = path.join(workspacesDir, 'safe-workspace');

    beforeEach(() => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir } as any);
      vi.spyOn(fs, 'realpath').mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.spyOn(workspace, 'loadWorkspaceManifest').mockResolvedValue({
        id: 'safe-workspace',
        description: 'Improve the local Desktop handoff',
        repos: [],
        workspacePath,
      } as any);
    });

    it('returns stable ids and never exposes executable commands', async () => {
      vi.mocked(execa).mockResolvedValue({ exitCode: 1 } as any);

      const response = await app.request('/api/workspace-launch-targets');
      const targets = await response.json() as Array<Record<string, unknown>>;

      expect(response.status).toBe(200);
      expect(targets.map((target) => target.id)).toContain('codex-desktop');
      expect(targets.map((target) => target.id)).toContain('vscode-insiders');
      expect(targets.every((target) => !('command' in target) && !('uri' in target))).toBe(true);
    });

    it('rejects a client-supplied target outside the closed catalog', async () => {
      vi.mocked(execa).mockResolvedValue({ exitCode: 1 } as any);

      const response = await app.request('/api/workspace/safe-workspace/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: 'editor:../../calc.exe' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Unknown workspace launch target.' });
    });

    it('rejects a workspace whose canonical path escapes through a symlink', async () => {
      const outsidePath = path.resolve('outside-launch-workspace');
      vi.mocked(fs.realpath).mockImplementation(async (candidate) =>
        path.resolve(String(candidate)) === workspacePath
          ? outsidePath
          : path.resolve(String(candidate)),
      );

      const response = await app.request('/api/workspace/safe-workspace/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: 'codex-desktop' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Invalid workspace path' });
      expect(execa).not.toHaveBeenCalled();
    });

    it('rejects a child path that only inherits a parent workspace manifest', async () => {
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue(null);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({
        id: 'parent-workspace',
        workspacePath: workspacesDir,
      } as any);

      const response = await app.request('/api/workspace/safe-workspace/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: 'codex-desktop' }),
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Workspace configuration not found.' });
      expect(execa).not.toHaveBeenCalled();
    });

    it('returns a conflict when the selected app is unavailable', async () => {
      vi.mocked(execa).mockResolvedValue({ exitCode: 1 } as any);

      const response = await app.request('/api/workspace/safe-workspace/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: 'codex-desktop' }),
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatch(/not installed|unavailable|supported/i);
    });

    it('launches Codex with a once-encoded validated workspace path', async () => {
      const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.mocked(execa).mockImplementation((async (command: any): Promise<any> => ({
        exitCode: command === 'reg.exe' || command === 'cmd.exe' ? 0 : 1,
      })) as any);

      try {
        const response = await app.request('/api/workspace/safe-workspace/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetId: 'codex-desktop' }),
        });

        expect(response.status).toBe(200);
        const prompt = 'Read the workspace instructions and implementation plan, inspect the repository state, then begin the task described for this workspace. Ask before making a decision that materially changes scope.\n\nWorkspace task: Improve the local Desktop handoff';
        expect(execa).toHaveBeenCalledWith(
          'cmd.exe',
          ['/d', '/v:off', '/s', '/c', 'start "" "%NEXUSFLOW_DESKTOP_URI%"'],
          {
            env: {
              NEXUSFLOW_DESKTOP_URI:
                `codex://threads/new?path=${encodeURIComponent(workspacePath)}&prompt=${encodeURIComponent(prompt)}`,
            },
            shell: false,
            windowsHide: true,
            windowsVerbatimArguments: true,
          },
        );
      } finally {
        platform.mockRestore();
      }
    });

    it('opens only a Codex thread recorded for the selected workspace', async () => {
      const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const sessionId = '0199a213-81c0-7800-8aa1-bbab2a035a53';
      const authorizeSession = vi.spyOn(sessionFinder, 'canOpenCodexSessionInWorkspace')
        .mockResolvedValue(true);
      vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as any);

      try {
        const response = await app.request('/api/workspace/safe-workspace/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetId: 'codex-desktop', action: 'resume', sessionId }),
        });

        expect(response.status).toBe(200);
        expect(execa).toHaveBeenCalledWith(
          'cmd.exe',
          ['/d', '/v:off', '/s', '/c', 'start "" "%NEXUSFLOW_DESKTOP_URI%"'],
          {
            env: { NEXUSFLOW_DESKTOP_URI: `codex://threads/${sessionId}` },
            shell: false,
            windowsHide: true,
            windowsVerbatimArguments: true,
          },
        );
      } finally {
        authorizeSession.mockRestore();
        platform.mockRestore();
      }
    });

    it('does not open a Codex thread owned by another workspace', async () => {
      const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const authorizeSession = vi.spyOn(sessionFinder, 'canOpenCodexSessionInWorkspace')
        .mockResolvedValue(false);
      vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as any);

      try {
        const response = await app.request('/api/workspace/safe-workspace/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetId: 'codex-desktop',
            action: 'resume',
            sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
          }),
        });

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({
          error: 'Codex session not found in this workspace.',
        });
        expect(execa).not.toHaveBeenCalledWith('cmd.exe', expect.anything(), expect.anything());
      } finally {
        authorizeSession.mockRestore();
        platform.mockRestore();
      }
    });

    it('launches a terminal for a valid workspace', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({
        id: 'safe-workspace',
        repos: [path.join(workspacePath, 'repo')],
        workspacePath,
      } as any);

      const response = await app.request('/api/workspace/safe-workspace/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant: 'claude',
          sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a54',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.command).toBe('claude --resume 0199a213-81c0-7800-8aa1-bbab2a035a54');
    });

    it('rejects cross-origin requests to terminal launch', async () => {
      const response = await app.request('/api/workspace/safe-workspace/terminal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://malicious-site.example.com',
        },
        body: JSON.stringify({
          assistant: 'claude',
        }),
      });

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe('Forbidden cross-origin request.');
    });

    it('rejects cross-origin requests to workspace launch', async () => {
      const response = await app.request('/api/workspace/safe-workspace/launch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://malicious-site.example.com',
        },
        body: JSON.stringify({ targetId: 'codex-desktop' }),
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'Forbidden cross-origin request.' });
    });

    it('rejects invalid assistant and malformed session ID', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({
        id: 'safe-workspace',
        repos: [path.join(workspacePath, 'repo')],
        workspacePath,
      } as any);

      const invalidAssistantRes = await app.request('/api/workspace/safe-workspace/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant: 'unknown-harness-name',
        }),
      });
      expect(invalidAssistantRes.status).toBe(400);

      const invalidIdRes = await app.request('/api/workspace/safe-workspace/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant: 'claude',
          sessionId: 'not-a-valid-session; rm -rf /',
        }),
      });
      expect(invalidIdRes.status).toBe(400);
      await expect(invalidIdRes.json()).resolves.toEqual({ error: 'Invalid session ID format.' });

      const validAlphanumericIdRes = await app.request('/api/workspace/safe-workspace/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant: 'copilot',
          sessionId: 'copilot-session-12345',
        }),
      });
      expect(validAlphanumericIdRes.status).toBe(200);

      const invalidTitleRes = await app.request('/api/workspace/safe-workspace/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant: 'claude',
          title: 12345,
        }),
      });
      expect(invalidTitleRes.status).toBe(400);
      await expect(invalidTitleRes.json()).resolves.toEqual({ error: 'Title must be a string.' });

      const invalidCwdRes = await app.request('/api/workspace/safe-workspace/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: '../../outside',
        }),
      });
      expect(invalidCwdRes.status).toBe(400);
      await expect(invalidCwdRes.json()).resolves.toEqual({ error: 'Launch directory must be within workspace.' });

      const validCwdRes = await app.request('/api/workspace/safe-workspace/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: path.join(workspacePath, 'repo'),
        }),
      });
      expect(validCwdRes.status).toBe(200);
    });
  });

  describe('workspace recent session handoffs', () => {
    const workspacesDir = path.resolve('session-workspaces');
    const workspacePath = path.join(workspacesDir, 'safe-workspace');
    const codexId = '0199a213-81c0-7800-8aa1-bbab2a035a53';
    const claudeId = '0199a213-81c0-7800-8aa1-bbab2a035a54';
    const unauthorizedCodexId = '0199a213-81c0-7800-8aa1-bbab2a035a55';

    it('returns only server-authorized Desktop handoff capabilities', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({
        id: 'safe-workspace',
        repos: [path.join(workspacePath, 'repo')],
        workspacePath,
      } as any);
      const find = vi.spyOn(sessionFinder, 'findSessions').mockResolvedValue([
        {
          id: 'copilot-session', assistant: 'copilot', title: 'Newer Copilot task',
          createdAt: '2026-08-16T03:00:00.000Z', updatedAt: '2026-08-16T03:00:00.000Z',
          messageCount: 2, workspacePath,
        },
        {
          id: 'antigravity-session', assistant: 'antigravity', title: 'Newer Antigravity task',
          createdAt: '2026-08-16T02:00:00.000Z', updatedAt: '2026-08-16T02:00:00.000Z',
          messageCount: 2, workspacePath,
        },
        {
          id: unauthorizedCodexId, assistant: 'codex', title: 'Fuzzy Codex task',
          createdAt: '2026-08-16T01:00:00.000Z', updatedAt: '2026-08-16T01:00:00.000Z',
          messageCount: 2, workspacePath,
        },
        {
          id: codexId, assistant: 'codex', title: 'Codex task',
          createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
          messageCount: 4, workspacePath,
        },
        {
          id: claudeId, assistant: 'claude', title: 'Claude task',
          createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
          messageCount: 2, workspacePath,
        },
      ] as any);
      const codexAuth = vi.spyOn(sessionFinder, 'canOpenCodexSessionInWorkspace')
        .mockImplementation(async (_workspace, _repos, sessionId) => sessionId === codexId);
      const claudeAuth = vi.spyOn(sessionFinder, 'canTransferClaudeSessionInWorkspace').mockResolvedValue(true);
      const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const architecture = vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '');
      vi.stubEnv('CLAUDE_CODE_USE_FOUNDRY', '');
      const provider = vi.spyOn(ProviderRegistry, 'getProvider').mockReturnValue({
        isConfigured: () => true,
      } as any);

      try {
        const response = await app.request(
          '/api/workspace/safe-workspace/sessions?limit=2&desktopHandoffOnly=true',
        );
        const body = await response.json() as any;

        expect(response.status).toBe(200);
        expect(body.sessions).toHaveLength(2);
        expect(body.sessions[0].desktopHandoff).toEqual({ targetId: 'codex-desktop', method: 'direct' });
        expect(body.sessions[1].desktopHandoff).toEqual({ targetId: 'claude-desktop', method: 'guided' });
        expect(codexAuth).toHaveBeenCalledWith(workspacePath, [path.join(workspacePath, 'repo')], codexId);
        expect(claudeAuth).toHaveBeenCalledWith(workspacePath, [path.join(workspacePath, 'repo')], claudeId);
      } finally {
        find.mockRestore();
        codexAuth.mockRestore();
        claudeAuth.mockRestore();
        provider.mockRestore();
        platform.mockRestore();
        architecture.mockRestore();
        vi.unstubAllEnvs();
      }
    });

    it('omits a discovered session when strong authorization fails', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({
        id: 'safe-workspace', repos: [], workspacePath,
      } as any);
      const find = vi.spyOn(sessionFinder, 'findSessions').mockResolvedValue([{
        id: codexId, assistant: 'codex', title: 'Fuzzy match only',
        createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
        messageCount: 2, workspacePath,
      }] as any);
      const codexAuth = vi.spyOn(sessionFinder, 'canOpenCodexSessionInWorkspace').mockResolvedValue(false);

      try {
        const response = await app.request(
          '/api/workspace/safe-workspace/sessions?limit=3&desktopHandoffOnly=true',
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ sessions: [] });
      } finally {
        find.mockRestore();
        codexAuth.mockRestore();
      }
    });

    it('rejects an excessive recent-session limit', async () => {
      const response = await app.request('/api/workspace/safe-workspace/sessions?limit=200');
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Session limit must be an integer from 1 to 20.' });
    });

    it('validates a source and scans only that source for progressive history requests', async () => {
      const sourceList = await app.request('/api/session-sources');
      expect(sourceList.status).toBe(200);
      expect((await sourceList.json() as { sources: string[] }).sources).toContain('pi');
      const invalid = await app.request('/api/workspace/safe-workspace/sessions?source=unknown');
      expect(invalid.status).toBe(400);
      const combined = await app.request('/api/workspace/safe-workspace/sessions?source=codex&desktopHandoffOnly=true');
      expect(combined.status).toBe(400);

      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir } as any);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({
        id: 'safe-workspace', repos: [path.join(workspacePath, 'repo')], workspacePath,
      } as any);
      const find = vi.spyOn(sessionFinder, 'findSessions').mockResolvedValue([]);
      try {
        const response = await app.request('/api/workspace/safe-workspace/sessions?source=codex');
        expect(response.status).toBe(200);
        expect(find).toHaveBeenCalledWith(workspacePath, [path.join(workspacePath, 'repo')], 'codex');
        const piResponse = await app.request('/api/workspace/safe-workspace/sessions?source=pi');
        expect(piResponse.status).toBe(200);
        expect(find).toHaveBeenCalledWith(workspacePath, [path.join(workspacePath, 'repo')], 'pi');
      } finally {
        find.mockRestore();
      }
    });

    it('returns the newest conversations that can be continued, per tool, when asked with newest', async () => {
      expect((await app.request('/api/workspace/safe-workspace/sessions?source=claude&newest=9')).status).toBe(400);
      expect((await app.request('/api/workspace/safe-workspace/sessions?newest=1&desktopHandoffOnly=true')).status).toBe(400);

      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir } as any);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({ id: 'safe-workspace', repos: [], workspacePath } as any);
      const session = (id: string, extra: object = {}) => ({ id, assistant: 'claude', title: id, updatedAt: '', recordedCwd: workspacePath, ...extra });
      const find = vi.spyOn(sessionFinder, 'findSessions').mockResolvedValue([
        session('helper', { threadKind: 'subagent' }), session('newest'), session('older'), session('no-folder', { recordedCwd: undefined }),
      ] as any);
      try {
        const response = await app.request('/api/workspace/safe-workspace/sessions?source=claude&newest=1');
        expect(response.status).toBe(200);
        expect(find).toHaveBeenCalledWith(workspacePath, [], 'claude', { newest: 1 });
        expect((await response.json() as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual(['newest']);
      } finally {
        find.mockRestore();
      }
    });

    it('gates Claude Desktop transfer to supported subscription CLI environments', () => {
      const configured = () => true;

      expect(canOfferClaudeDesktopTransfer('win32', 'x64', {}, configured)).toBe(true);
      expect(canOfferClaudeDesktopTransfer('darwin', 'arm64', {}, configured)).toBe(true);
      expect(canOfferClaudeDesktopTransfer('linux', 'x64', {}, configured)).toBe(false);
      expect(canOfferClaudeDesktopTransfer('win32', 'arm64', {}, configured)).toBe(false);
      expect(canOfferClaudeDesktopTransfer('win32', 'x64', { ANTHROPIC_API_KEY: 'configured' }, configured)).toBe(false);
      expect(canOfferClaudeDesktopTransfer('win32', 'x64', {}, () => false)).toBe(false);
    });

    it('falls back gracefully when ProviderRegistry has no claude-cli', () => {
      const getProvider = vi.spyOn(ProviderRegistry, 'getProvider').mockReturnValue(undefined);
      try {
        expect(canOfferClaudeDesktopTransfer('win32', 'x64', {})).toBe(false);
      } finally {
        getProvider.mockRestore();
      }
    });
  });

  describe('POST /api/workspace/:id/resume', () => {
    it('uses the Pi resume command from the CLI catalog', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue({ id: 'test-ws', repos: [], assistants: [] } as any);
      const response = await app.request('/api/workspace/test-ws/resume', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant: 'pi', sessionId: '01a0df53-f0a9-7290-bdd1-5c094ab07027' }),
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { resumeCommand: string }).resumeCommand).toBe('pi --session 01a0df53-f0a9-7290-bdd1-5c094ab07027');
    });

    it('rejects cross-origin requests to resume', async () => {
      const response = await app.request('/api/workspace/test-ws/resume', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://malicious-site.example.com',
        },
        body: JSON.stringify({ assistant: 'antigravity' }),
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'Forbidden cross-origin request.' });
    });

    it('rejects invalid sessionId UUID on resume', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue({
        id: 'test-ws',
        repos: [],
        assistants: ['antigravity'],
      } as any);

      const response = await app.request('/api/workspace/test-ws/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant: 'antigravity',
          sessionId: 'malicious-uuid-attempt',
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Invalid session UUID format.' });
    });

    it('should fail with 400 if command is forbidden', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({
        workspacesDir: '/mock/workspaces'
      } as any);
      vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue({
        id: 'test-ws',
        repos: [],
        assistants: ['antigravity']
      } as any);

      const response = await app.request('/api/workspace/test-ws/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'malicious-editor',
          assistant: 'antigravity'
        })
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Forbidden editor command');
    });

    it('should spawn the editor with proper options when resuming', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({
        workspacesDir: '/mock/workspaces'
      } as any);
      vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue({
        id: 'test-ws',
        repos: [],
        assistants: ['antigravity']
      } as any);

      const dummyChild = {
        unref: vi.fn(),
        catch: vi.fn().mockReturnThis()
      };
      vi.mocked(execa).mockReturnValue(dummyChild as any);

      const response = await app.request('/api/workspace/test-ws/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'code',
          assistant: 'antigravity'
        })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      const isWin = process.platform === 'win32';
      expect(execa).toHaveBeenCalledWith('code', [expect.any(String)], {
        stdio: 'ignore',
        shell: isWin,
        windowsHide: true,
      });
    });
  });

  describe('archived workspaces', () => {
    const archived = { id: 'old-ws', repos: [], assistants: [], archivedAt: '2026-09-28T10:00:00.000Z' };

    it('matches only actions that change repositories or start processes', () => {
      expect(archiveRefusedAction('POST', '/api/workspace/feat%2Fx/commit')).toEqual({ id: 'feat/x', action: 'commit' });
      expect(archiveRefusedAction('POST', '/api/workspace/ws/services/api/start')).toEqual({ id: 'ws', action: 'services' });
      expect(archiveRefusedAction('POST', '/api/workspace/ws/services/stop')).toBeNull();
      expect(archiveRefusedAction('POST', '/api/workspace/ws/archive')).toBeNull();
      expect(archiveRefusedAction('POST', '/api/workspace/ws/unarchive')).toBeNull();
      expect(archiveRefusedAction('POST', '/api/workspace/ws/knowledge/entry')).toBeNull();
      expect(archiveRefusedAction('DELETE', '/api/workspace/ws')).toBeNull();
      expect(archiveRefusedAction('GET', '/api/workspace/ws/commit')).toBeNull();
    });

    it('refuses to resume a session in an archived workspace with a conflict', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue(archived as any);

      const response = await app.request('/api/workspace/old-ws/resume', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant: 'pi' }),
      });

      expect(response.status).toBe(409);
      const data = await response.json() as { code: string; error: string };
      expect(data.code).toBe('WORKSPACE_ARCHIVED');
      expect(data.error).toMatch(/cannot start assistant sessions/);
      expect(execa).not.toHaveBeenCalled();
    });

    it('archives with a report, and answers a blocked archive with 409 and its blockers', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue({ id: 'ws', repos: [], assistants: [] } as any);
      const base = {
        workspacePath: '/mock/workspaces/ws', workspaceId: 'ws', dryRun: false, alreadyArchived: false,
        repos: [], kept: [], notes: [], errors: [], archived: false, branches: [],
      };
      vi.mocked(archive.archiveWorkspace)
        .mockResolvedValueOnce({ ...base, ready: false, blockers: ['api: 2 uncommitted file(s).'] })
        .mockResolvedValueOnce({ ...base, ready: true, blockers: [], archived: true, archivedAt: 'now' });
      const post = (body: object) => app.request('/api/workspace/ws/archive', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });

      const blocked = await post({});
      expect(blocked.status).toBe(409);
      expect((await blocked.json() as { error: string }).error).toBe('api: 2 uncommitted file(s).');

      const done = await post({ park: true });
      expect(done.status).toBe(200);
      expect(archive.archiveWorkspace).toHaveBeenLastCalledWith(path.resolve('/mock/workspaces', 'ws'), { park: true, dryRun: false, keepBranches: false, deleteRemoteBranches: false, fetch: undefined });
    });

    it('returns 404 for an unknown workspace instead of archiving', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue(null);
      const response = await app.request('/api/workspace/missing/unarchive', { method: 'POST' });
      expect(response.status).toBe(404);
      expect(archive.unarchiveWorkspace).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/config', () => {
    it('should load configuration successfully', async () => {
      vi.spyOn(config, 'getConfigDir').mockReturnValue('/mock/config-dir');
      vi.spyOn(config, 'loadConfig').mockResolvedValue({
        devDir: '/mock/dev',
        scanDepth: 2
      } as any);
      vi.spyOn(config, 'getDefaultConfig').mockReturnValue({ devDir: '/home/me/dev', workspacesDir: '/home/me/dev/workspaces' } as any);
      vi.spyOn(fs, 'access').mockResolvedValue();

      const response = await app.request('/api/config');
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.config.devDir).toBe('/mock/dev');
      expect(data.exists).toBe(true);
    });

    it('reports the server platform and suggested folders for setup', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ devDir: '', scanDepth: 2 } as any);
      vi.spyOn(config, 'getDefaultConfig').mockReturnValue({ devDir: '/home/me/dev', workspacesDir: '/home/me/dev/workspaces' } as any);
      vi.spyOn(fs, 'access').mockRejectedValueOnce(new Error('ENOENT'));
      const data = await (await app.request('/api/config')).json();
      expect(data).toMatchObject({ exists: false, platform: process.platform, suggested: { devDir: '/home/me/dev', workspacesDir: '/home/me/dev/workspaces' } });
    });
  });

  describe('POST /api/config folders', () => {
    const ok = (p: string) => ({ path: p, status: 'ok' as const, message: '' });
    const post = (body: unknown) => app.request('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    beforeEach(() => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ devDir: '/old/dev', workspacesDir: '/old/ws', scanDepth: 2 } as any);
      vi.spyOn(config, 'saveConfig').mockResolvedValue();
    });

    it('refuses unusable folders with field messages and saves nothing', async () => {
      vi.mocked(configPaths.checkConfigPaths).mockResolvedValue({
        ok: false,
        devDir: { path: '/new/dev', status: 'missing', message: "This folder doesn't exist.", canCreate: true },
        workspacesDir: ok('/new/ws'),
      });
      const response = await post({ devDir: '/new/dev', workspacesDir: '/new/ws' });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ fields: { devDir: { status: 'missing', message: "This folder doesn't exist." } } });
      expect(config.saveConfig).not.toHaveBeenCalled();
    });

    it('creates a missing workspaces folder only when asked, and never stores the request flag', async () => {
      vi.mocked(configPaths.checkConfigPaths)
        .mockResolvedValueOnce({ ok: false, devDir: ok('/new/dev'), workspacesDir: { path: '/new/ws', status: 'missing', message: '', canCreate: true } })
        .mockResolvedValueOnce({ ok: true, devDir: ok('/new/dev'), workspacesDir: ok('/new/ws') });
      const response = await post({ devDir: '/new/dev', workspacesDir: '/new/ws', createWorkspacesDir: true });
      expect(response.status).toBe(200);
      expect(fs.mkdir).toHaveBeenCalledWith('/new/ws', { recursive: true });
      const saved = vi.mocked(config.saveConfig).mock.calls[0][0] as unknown as Record<string, unknown>;
      expect(saved).toMatchObject({ devDir: '/new/dev', workspacesDir: '/new/ws' });
      expect(saved).not.toHaveProperty('createWorkspacesDir');
    });

    it('does not re-check folders that did not change', async () => {
      const response = await post({ devDir: '/old/dev', workspacesDir: '/old/ws', scanDepth: 3 });
      expect(response.status).toBe(200);
      expect(configPaths.checkConfigPaths).not.toHaveBeenCalled();
      expect(config.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ scanDepth: 3 }));
    });
  });

  describe('POST /api/config saves only the settings the app edits', () => {
    const post = (body: unknown) => app.request('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const stored = {
      version: '1.0.0',
      devDir: '/old/dev',
      workspacesDir: '/old/ws',
      defaultAssistant: null,
      scanDepth: 2,
      excludePatterns: ['node_modules'],
      plugins: ['/home/me/plugins/mine.mjs'],
      lastUpdateCheck: '2026-01-01T00:00:00.000Z',
      latestVersion: '1.0.0',
      latestDownloadUrl: 'https://example.com/stored',
      latestReleaseNotes: 'stored notes',
    };
    const savedConfig = () => vi.mocked(config.saveConfig).mock.calls[0][0] as unknown as Record<string, unknown>;

    beforeEach(() => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ ...stored } as any);
      vi.spyOn(config, 'saveConfig').mockResolvedValue();
    });

    it('does not store a key that is not part of the config', async () => {
      const response = await post({ devDir: '/old/dev', workspacesDir: '/old/ws', somethingUnknown: 'value', nested: { a: 1 } });
      expect(response.status).toBe(200);
      expect(savedConfig()).not.toHaveProperty('somethingUnknown');
      expect(savedConfig()).not.toHaveProperty('nested');
      expect((await response.json()).config).not.toHaveProperty('somethingUnknown');
    });

    it('keeps the stored value for settings the app does not edit, whatever the request says', async () => {
      const response = await post({
        devDir: '/old/dev',
        workspacesDir: '/old/ws',
        version: '9.9.9',
        excludePatterns: ['changed'],
        plugins: ['/tmp/other.mjs'],
        lastUpdateCheck: '2030-01-01T00:00:00.000Z',
        latestVersion: '9.9.9',
        latestDownloadUrl: 'https://example.com/changed',
        latestReleaseNotes: 'changed notes',
      });
      expect(response.status).toBe(200);
      expect(savedConfig()).toMatchObject({
        version: stored.version,
        excludePatterns: stored.excludePatterns,
        plugins: stored.plugins,
        lastUpdateCheck: stored.lastUpdateCheck,
        latestVersion: stored.latestVersion,
        latestDownloadUrl: stored.latestDownloadUrl,
        latestReleaseNotes: stored.latestReleaseNotes,
      });
    });

    it('still saves every setting the app edits when the GUI posts the whole config back', async () => {
      const response = await post({
        ...stored,
        defaultAssistant: 'claude',
        defaultEditor: 'code',
        scanDepth: 4,
        storageProvider: 'local',
        adapterConfig: { local: { path: '/data' } },
      });
      expect(response.status).toBe(200);
      expect(savedConfig()).toMatchObject({
        devDir: '/old/dev',
        workspacesDir: '/old/ws',
        defaultAssistant: 'claude',
        defaultEditor: 'code',
        scanDepth: 4,
        storageProvider: 'local',
        adapterConfig: { local: { path: '/data' } },
      });
    });

    it('still refuses an invalid value for a setting the app edits', async () => {
      const response = await post({ scanDepth: 99 });
      expect(response.status).toBe(400);
      expect(config.saveConfig).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/adapters', () => {
    it('should return all registered storage adapters with meta', async () => {
      const response = await app.request('/api/adapters');
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.adapters).toBeDefined();
      expect(Array.isArray(data.adapters)).toBe(true);
      // `local` is the only built-in backend: a backend that relocates the
      // generated files out of the workspace cannot work, since assistants read
      // AGENTS.md and CLAUDE.md from the root. Plugins may still register more.
      const names = data.adapters.map((a: any) => a.name);
      expect(names).toContain('local');
      expect(names).not.toContain('central-vault');
    });
  });

  describe('GET /api/harnesses', () => {
    it('describes every harness in the registry for the GUI, without launch details', async () => {
      const response = await app.request('/api/harnesses');
      expect(response.status).toBe(200);
      const { harnesses } = await response.json() as { harnesses: Array<Record<string, unknown>> };
      expect(harnesses.map((h) => h.id)).toEqual(Object.keys(HARNESSES));
      expect(harnesses.find((h) => h.id === 'pi')).toEqual({
        id: 'pi',
        name: 'Pi',
        workspaceSkillFolder: '.agents/skills',
        globalSkillRoots: ['~/.pi/agent/skills', '~/.agents/skills'],
        history: true,
        instructionsFile: null,
      });
      expect(harnesses.find((h) => h.id === 'claude')).toMatchObject({ workspaceSkillFolder: '.claude/skills', instructionsFile: 'CLAUDE.md' });
      for (const harness of harnesses) expect(Object.keys(harness).sort()).toEqual(['globalSkillRoots', 'history', 'id', 'instructionsFile', 'name', 'workspaceSkillFolder']);
    });
  });

  describe('GET /api/repos/branches', () => {
    it('should return 400 when the path parameter is missing', async () => {
      const response = await app.request('/api/repos/branches');
      expect(response.status).toBe(400);
    });

    it('should return 400 when the path escapes devDir', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ devDir: '/mock/dev' } as any);

      const response = await app.request(
        `/api/repos/branches?path=${encodeURIComponent('/mock/dev/../../etc')}`,
      );
      expect(response.status).toBe(400);
    });

    it('should list local and origin branches for a repo inside devDir', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ devDir: '/mock/dev' } as any);
      vi.mocked(execa).mockResolvedValue({
        stdout: 'main\nfeature/x\norigin/HEAD\norigin/main\norigin/remote-only',
      } as any);

      const response = await app.request(
        `/api/repos/branches?path=${encodeURIComponent('/mock/dev/repo1')}`,
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.local).toEqual(['main', 'feature/x']);
      expect(data.remote).toEqual(['main', 'remote-only']);
    });
  });

  describe('GET /api/repos/freshness and POST /api/repos/freshness and POST /api/repos/pull', () => {
    it('GET /api/repos/freshness returns 400 when path parameter is missing', async () => {
      const response = await app.request('/api/repos/freshness');
      expect(response.status).toBe(400);
    });

    it('GET /api/repos/freshness returns 400 when path escapes devDir', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ devDir: '/mock/dev' } as any);
      const response = await app.request(
        `/api/repos/freshness?path=${encodeURIComponent('/mock/dev/../../etc')}`,
      );
      expect(response.status).toBe(400);
    });

    it('POST /api/repos/freshness returns 400 when repos array is missing', async () => {
      const response = await app.request('/api/repos/freshness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });

    it('POST /api/repos/pull returns 400 when neither path nor repos is provided', async () => {
      const response = await app.request('/api/repos/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/repos/new', () => {
    it('should return 400 when the name is missing', async () => {
      const response = await app.request('/api/repos/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });

    it('should scaffold a repo in devDir and return it', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ devDir: '/mock/dev' } as any);
      const repo = { name: 'newproj', path: '/mock/dev/newproj', defaultBranch: 'main' };
      vi.mocked(newRepo.createNewRepo).mockResolvedValue(repo);

      const response = await app.request('/api/repos/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'newproj' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.repo).toEqual(repo);
      expect(newRepo.createNewRepo).toHaveBeenCalledWith('/mock/dev', 'newproj');
    });
  });



  describe('GET and PUT /api/workspace/:id/knowledge', () => {
    it('should get workspace knowledge content', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({
        workspacesDir: '/mock/workspaces'
      } as any);
      vi.spyOn(fs, 'readFile').mockResolvedValue('# Mock Knowledge File content');

      const response = await app.request('/api/workspace/test-ws/knowledge');
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.content).toBe('# Mock Knowledge File content');
    });

    it('should write workspace knowledge content', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({
        workspacesDir: '/mock/workspaces'
      } as any);
      vi.spyOn(fs, 'writeFile').mockResolvedValue();

      const response = await app.request('/api/workspace/test-ws/knowledge', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '# Updated Content' })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it('returns a compatibility-friendly 400 when a structured entry omits its required title', async () => {
      const response = await app.request('/api/workspace/test-ws/knowledge/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'decision', message: 'Use explicit titles.' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'A short knowledge title is required.' });
    });

    it('rejects a base-knowledge repo traversal at the HTTP boundary', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({
        id: 'test-ws',
        repos: ['/mock/workspaces/test-ws/api'],
      } as any);

      const response = await app.request('/api/workspace/test-ws/knowledge/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'gotcha', title: 'Traversal', message: 'must stay contained', repo: '../outside',
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/Invalid repository name/) });
    });
  });

  describe('GET /api/workspace/:id/stream', () => {
    it('returns messages joined with live authoritative workflow progress', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({
        workspacesDir: '/mock/workspaces',
      } as any);

      const fakeChat = JSON.stringify({
        id: 'msg-stream-1',
        message: 'Completed verification',
        author: 'agent',
        harness: 'codex',
        stepId: 'step-verify',
        evidence: '14 tests passed',
        status: 'proposed',
        stepProposal: {
          stepId: 'step-verify',
          status: 'completion_proposed',
          evidence: '14 tests passed',
        },
        timestamp: new Date().toISOString(),
      });
      const readSpy = vi.spyOn(fs, 'readFile').mockResolvedValue(fakeChat);

      const mockSnapshot = {
        roomId: 'room-123',
        name: 'Stream Room',
        workflowProgress: {
          schemaVersion: 1,
          revision: 2,
          steps: [
            {
              stepId: 'step-verify',
              status: 'completed',
              evidence: 'Human confirmed with 14 tests passing',
              revision: 2,
              updatedAt: new Date().toISOString(),
            },
          ],
        },
      };

      const mockClient = {
        snapshot: vi.fn().mockResolvedValue(mockSnapshot),
      };

      const managerModule = await import('./workrooms/manager.js');
      const loadClientSpy = vi.spyOn(managerModule, 'loadPinnedWorkroomClientForWorkspace').mockResolvedValue(mockClient as any);

      try {
        const response = await app.request('/api/workspace/test-ws/stream');
        expect(response.status).toBe(200);
        const data = (await response.json()) as any;
        expect(data.workspaceId).toBe('test-ws');
        expect(data.isRemoteActive).toBe(true);
        expect(data.workflowProgress).toBeDefined();
        expect(data.messages).toHaveLength(1);
        expect(data.messages[0].stepProposal.status).toBe('completed');
        expect(data.messages[0].stepProposal.evidence).toBe('Human confirmed with 14 tests passing');
      } finally {
        loadClientSpy.mockRestore();
        readSpy.mockRestore();
      }
    });

    it('falls back gracefully to unjoined messages when no workroom is connected', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({
        workspacesDir: '/mock/workspaces',
      } as any);

      const fakeChat = JSON.stringify({
        id: 'msg-stream-2',
        message: 'Initial proposal',
        author: 'agent',
        stepId: 'step-plan',
        status: 'proposed',
        timestamp: new Date().toISOString(),
      });
      const readSpy = vi.spyOn(fs, 'readFile').mockResolvedValue(fakeChat);

      const managerModule = await import('./workrooms/manager.js');
      const loadClientSpy = vi.spyOn(managerModule, 'loadPinnedWorkroomClientForWorkspace').mockRejectedValue(new Error('No pinned workroom'));
      const hasActiveSpy = vi.spyOn(workroomManager, 'hasActiveRoom').mockReturnValue(false);

      try {
        const response = await app.request('/api/workspace/test-ws/stream');
        expect(response.status).toBe(200);
        const data = (await response.json()) as any;
        expect(data.isRemoteActive).toBe(false);
        expect(data.workflowProgress).toBeNull();
        expect(data.messages).toHaveLength(1);
        expect(data.messages[0].stepId).toBe('step-plan');
      } finally {
        loadClientSpy.mockRestore();
        hasActiveSpy.mockRestore();
        readSpy.mockRestore();
      }
    });
  });

  describe('POST /api/updates/install', () => {
    it('should fail if tool not found', async () => {
      const response = await app.request('/api/updates/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolId: 'invalid-tool' })
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe('Tool not found');
    });

    it('should install a tool successfully if execa exits with 0', async () => {
      vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: 'Successfully updated' } as any);

      const response = await app.request('/api/updates/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolId: 'claude' })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.output).toBe('Successfully updated');
      expect(execa).toHaveBeenCalledWith('npm', ['install', '-g', '@anthropic-ai/claude-code'], expect.any(Object));
    });

    it('installs ContextSpace from its release, never from the deprecated npm package', async () => {
      vi.mocked(execa).mockClear();
      const install = vi.spyOn(desktop, 'installDesktop').mockResolvedValue({
        platform: 'linux', assetName: 'ContextSpace-2.50.0.AppImage', sha256: 'x', installedPath: '/home/u/.local/share/contextspace/ContextSpace.AppImage',
      } as any);
      try {
        const response = await app.request('/api/updates/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolId: 'nexusflow' })
        });
        expect(response.status).toBe(200);
        expect((await response.json()).output).toContain('ContextSpace-2.50.0.AppImage');
        expect(install).toHaveBeenCalledOnce();
        expect(execa).not.toHaveBeenCalled();
      } finally { install.mockRestore(); }
    });

    it('reports a failed release install instead of falling back to npm', async () => {
      vi.mocked(execa).mockClear();
      const install = vi.spyOn(desktop, 'installDesktop').mockRejectedValue(new Error('Desktop installer is unsupported on darwin.'));
      try {
        const response = await app.request('/api/updates/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolId: 'nexusflow' })
        });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(execa).not.toHaveBeenCalled();
      } finally { install.mockRestore(); }
    });
  });

  describe('POST /api/workspace', () => {
    it('should complete workspace creation successfully', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({
        devDir: '/mock',
        workspacesDir: '/mock/workspaces',
        storageProvider: 'local'
      } as any);

      vi.spyOn(workspace, 'createWorkspace').mockResolvedValue('/mock/workspaces/test-ws-creation-no-pack');
      vi.spyOn(analyzers, 'analyzeAllRepos').mockResolvedValue(new Map());
      vi.spyOn(generators, 'generateContextFiles').mockResolvedValue(undefined);

      const response = await app.request('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branchName: 'test-ws-creation-no-pack',
          name: 'Readable workspace title',
          flowType: 'epic',
          description: 'A test workspace',
          repos: [{ name: 'repo-1', path: '/mock/repo-1' }],
          assistants: ['antigravity']
        })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.jobId).toBe('test-ws-creation-no-pack');

      // Wait a brief tick for the background job to execute
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(vi.mocked(workspace.createWorkspace).mock.calls[0][0].flowType).toBe('epic');
      expect(vi.mocked(workspace.createWorkspace).mock.calls[0][0].name).toBe('Readable workspace title');
      expect(analyzers.analyzeAllRepos).toHaveBeenCalled();
      expect(generators.generateContextFiles).toHaveBeenCalled();

      // Read status via SSE stream route
      const streamResponse = await app.request('/api/workspace/create-stream/test-ws-creation-no-pack');
      expect(streamResponse.status).toBe(200);
      const text = await streamResponse.text();
      expect(text).toContain('"status":"completed"');
      expect(text).toContain('"progress":100');
    });

    it('saves enabledSkills and enabledAgents during workspace creation', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({
        devDir: '/mock',
        workspacesDir: '/mock/workspaces',
        storageProvider: 'local'
      } as any);

      vi.spyOn(workspace, 'createWorkspace').mockResolvedValue('/mock/workspaces/skills-ws');
      vi.spyOn(analyzers, 'analyzeAllRepos').mockResolvedValue(new Map());
      vi.spyOn(generators, 'generateContextFiles').mockResolvedValue(undefined);
      vi.spyOn(skillsCatalog, 'saveWorkspaceSkillsConfig').mockResolvedValue(undefined as any);

      const response = await app.request('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branchName: 'skills-ws',
          description: 'Skills workspace',
          repos: [{ name: 'repo-1', path: '/mock/repo-1' }],
          assistants: ['antigravity'],
          enabledSkills: ['pr-review-toolkit', 'unit-test-coverage'],
          enabledAgents: ['my-agent'],
        })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(skillsCatalog.saveWorkspaceSkillsConfig).toHaveBeenCalledWith(
        expect.stringContaining('skills-ws'),
        {
          enabledSkills: ['pr-review-toolkit', 'unit-test-coverage'],
          enabledAgents: ['my-agent'],
          enabledCategories: [],
          disabledSkills: [],
        }
      );
    });

    it('saves the subscribed categories, and the skills left out of them, during workspace creation', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({
        devDir: '/mock',
        workspacesDir: '/mock/workspaces',
        storageProvider: 'local'
      } as any);

      vi.spyOn(workspace, 'createWorkspace').mockResolvedValue('/mock/workspaces/categories-ws');
      vi.spyOn(analyzers, 'analyzeAllRepos').mockResolvedValue(new Map());
      vi.spyOn(generators, 'generateContextFiles').mockResolvedValue(undefined);
      vi.spyOn(skillsCatalog, 'saveWorkspaceSkillsConfig').mockResolvedValue(undefined as any);

      const response = await app.request('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branchName: 'categories-ws',
          description: 'Categories workspace',
          repos: [{ name: 'repo-1', path: '/mock/repo-1' }],
          assistants: [],
          enabledSkills: ['standup'],
          enabledCategories: ['pull-requests'],
          disabledSkills: ['write-description'],
        })
      });

      expect(response.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(skillsCatalog.saveWorkspaceSkillsConfig).toHaveBeenCalledWith(
        expect.stringContaining('categories-ws'),
        { enabledSkills: ['standup'], enabledAgents: [], enabledCategories: ['pull-requests'], disabledSkills: ['write-description'] },
      );
    });

    it('creates a workspace when description is omitted (optional description)', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({
        devDir: '/mock',
        workspacesDir: '/mock/workspaces',
        storageProvider: 'local'
      } as any);

      vi.spyOn(workspace, 'createWorkspace').mockResolvedValue('/mock/workspaces/no-desc-ws');
      vi.spyOn(analyzers, 'analyzeAllRepos').mockResolvedValue(new Map());
      vi.spyOn(generators, 'generateContextFiles').mockResolvedValue(undefined);

      const response = await app.request('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branchName: 'no-desc-ws',
          name: 'Fast workspace',
          repos: [{ name: 'repo-1', path: '/mock/repo-1' }],
          assistants: ['claude'],
        })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(vi.mocked(workspace.createWorkspace).mock.calls[0][0].name).toBe('Fast workspace');
      expect(vi.mocked(workspace.createWorkspace).mock.calls[0][0].description).toBe('');
    });

    it('rejects workspace creation when repo path escapes devDir', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({
        devDir: '/mock/dev',
        workspacesDir: '/mock/workspaces',
        storageProvider: 'local',
      } as any);

      const response = await app.request('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branchName: 'escaped-ws',
          description: 'Path escape test',
          repos: [{ name: 'repo-1', path: '/etc/shadow' }],
          assistants: ['antigravity'],
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Invalid workspace path');
    });

    // XML context packing tests removed.

    it('rejects in-place creation without a name', async () => {
      const response = await app.request('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'in-place',
          description: 'nameless',
          repos: [{ name: 'repo-1', path: '/mock/repo-1' }],
          assistants: ['claude']
        })
      });

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('name');
    });

    it('rejects worktree creation without a branch name', async () => {
      const response = await app.request('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'branchless',
          repos: [{ name: 'repo-1', path: '/mock/repo-1' }],
          assistants: ['claude']
        })
      });

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('branchName');
    });

    it('creates an in-place workspace against the source repos (no worktree remap)', async () => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({
        devDir: '/mock',
        workspacesDir: '/mock/workspaces',
        storageProvider: 'local'
      } as any);
      vi.spyOn(workspace, 'createWorkspace').mockResolvedValue('/mock/workspaces/my-quick-fix');
      vi.spyOn(analyzers, 'analyzeAllRepos').mockResolvedValue(new Map());
      vi.spyOn(generators, 'generateContextFiles').mockResolvedValue(undefined);

      const response = await app.request('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'in-place',
          name: 'My Quick Fix',
          projectId: 'billing',
          description: 'in-place workspace',
          repos: [{ name: 'repo-1', path: '/mock/repo-1', defaultBranch: 'main' }],
          assistants: ['claude']
        })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      // The name is slugified into the job/workspace id.
      expect(data.jobId).toBe('my-quick-fix');

      await new Promise((resolve) => setTimeout(resolve, 50));

      const feature = vi.mocked(workspace.createWorkspace).mock.calls[0][0];
      expect(feature.mode).toBe('in-place');
      expect(feature.id).toBe('my-quick-fix');
      expect(feature.projectId).toBe('billing');
      expect(feature.name).toBe('My Quick Fix');
      // Repos stay at their source paths — no join(workspacePath, name) remap.
      expect(feature.repos).toEqual(['/mock/repo-1']);
      // Analysis also runs against the source repos.
      const analyzed = vi.mocked(analyzers.analyzeAllRepos).mock.calls[0][0];
      expect(analyzed[0].path).toBe('/mock/repo-1');

      // The SSE stream reports the in-place step set.
      const streamResponse = await app.request('/api/workspace/create-stream/my-quick-fix');
      const text = await streamResponse.text();
      expect(text).toContain('"status":"completed"');
      expect(text).toContain('Register Workspace');
      expect(text).not.toContain('Create Git Worktrees');
    });
  });

  describe('Workflows Templates API', () => {
    it('GET /api/workflows/templates should return list of templates', async () => {
      vi.spyOn(workflows, 'getWorkflowTemplates').mockResolvedValue([
        { id: 'test-id', name: 'Test Name', description: 'Test Desc', content: 'Test Content', custom: false }
      ]);

      const response = await app.request('/api/workflows/templates');
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({
        templates: [
          { id: 'test-id', name: 'Test Name', description: 'Test Desc', content: 'Test Content', custom: false }
        ]
      });
    });

    it('POST /api/workflows/templates should create or update template', async () => {
      vi.spyOn(workflows, 'saveWorkflowTemplate').mockResolvedValue({
        id: 'test-id',
        name: 'Test Name',
        description: 'Test Desc',
        content: 'Test Content',
        custom: true
      });

      const response = await app.request('/api/workflows/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'old-id', name: 'Test Name', content: 'Test Content' })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.template.id).toBe('test-id');
      expect(workflows.saveWorkflowTemplate).toHaveBeenCalledWith('Test Name', 'Test Content', 'old-id');
    });

    it('DELETE /api/workflows/templates/:id should delete template', async () => {
      vi.spyOn(workflows, 'getWorkflowTemplates').mockResolvedValue([
        { id: 'test-id', name: 'Test Name', description: 'Test Desc', content: 'Test Content', custom: true }
      ]);
      vi.spyOn(workflows, 'deleteWorkflowTemplate').mockResolvedValue(undefined);

      const response = await app.request('/api/workflows/templates/test-id', {
        method: 'DELETE'
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(workflows.deleteWorkflowTemplate).toHaveBeenCalledWith('test-id');
    });

    it('POST /api/workflows/templates/:id/analyze should run inspection with comment', async () => {
      vi.mocked(detectAi.detectAIAssistants).mockResolvedValue([
        { name: 'antigravity', displayName: 'Antigravity', detected: true, command: 'agy' }
      ]);
      
      vi.mocked(execa).mockResolvedValue({
        exitCode: 0,
        stdout: 'Review result: Success\n=== SUGGESTED IMPROVEMENT START ===\n# Refined Strategy\n=== SUGGESTED IMPROVEMENT END ==='
      } as any);

      const response = await app.request('/api/workflows/templates/test-id/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'My Strategy guidelines',
          assistant: 'antigravity',
          comment: 'Check for timeouts'
        })
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.analysis).toContain('Review result: Success');
      expect(data.suggestedImprovement).toBe('# Refined Strategy');
      expect(execa).toHaveBeenCalled();
      
      const calledArgs = vi.mocked(execa).mock.calls[0][1];
      expect(JSON.stringify(calledArgs)).toContain('Check for timeouts');
    });

    it('uses non-interactive codex exec with the prompt on stdin', async () => {
      vi.mocked(detectAi.detectAIAssistants).mockResolvedValue([
        { name: 'codex', displayName: 'OpenAI Codex', detected: true, command: 'codex' }
      ]);
      vi.mocked(execa).mockResolvedValue({
        exitCode: 0,
        stdout: 'Review result'
      } as any);

      const response = await app.request('/api/workflows/templates/test-id/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Rules', assistant: 'codex' })
      });

      expect(response.status).toBe(200);
      const [command, args, options] = vi.mocked(execa).mock.calls[0] as unknown as [
        string,
        string[],
        { input?: string },
      ];
      expect(command).toBe('codex');
      expect(args).toEqual(['exec', '--color', 'never', '-']);
      expect(options?.input).toContain('Rules');
    });

    describe('POST /api/workspace/suggest-workflow', () => {
      it('should suggest a workflow using heuristics when local LLM is disabled', async () => {
        vi.spyOn(config, 'loadConfig').mockResolvedValue({
          version: '1.0',
          devDir: '/dev',
          workspacesDir: '/dev/workspaces',
          defaultAssistant: null,
          scanDepth: 2
        });

        const response = await app.request('/api/workspace/suggest-workflow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: 'Fix a typo in README.md and update comments',
            repos: [{ name: 'my-project', path: '/dev/my-project', defaultBranch: 'main' }]
          })
        });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.difficulty).toBe('simple');
        expect(data.suggestedWorkflowId).toBe('solo-developer');
        expect(data.customInstructions).toContain('Solo Developer');
      });

      it('should suggest a complex workflow when description contains complex keywords', async () => {
        vi.spyOn(config, 'loadConfig').mockResolvedValue({
          version: '1.0',
          devDir: '/dev',
          workspacesDir: '/dev/workspaces',
          defaultAssistant: null,
          scanDepth: 2
        });

        const response = await app.request('/api/workspace/suggest-workflow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: 'Refactor database schema and migrate data to postgres',
            repos: [{ name: 'my-project', path: '/dev/my-project', defaultBranch: 'main' }]
          })
        });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.difficulty).toBe('complex');
        expect(data.suggestedWorkflowId).toBe('plan-implement-review');
        expect(data.customInstructions).toContain('Plan, Implement, Review');
      });

      it('POST /api/workspace/:id/isolate isolates a repository', async () => {
        vi.spyOn(config, 'loadConfig').mockResolvedValue({
          version: '1.0',
          devDir: '/dev',
          workspacesDir: '/dev/workspaces',
          defaultAssistant: null,
          scanDepth: 2,
        });

        vi.mocked(workspace.isolateWorkspaceRepo).mockResolvedValue({
          repoName: 'my-repo',
          sourcePath: '/dev/my-repo',
          worktreePath: '/dev/workspaces/my-ws/my-repo',
          branchName: 'feat/my-repo-ws',
          baseBranch: 'main',
          alreadyIsolated: false,
        });

        const response = await app.request('/api/workspace/my-ws/isolate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: 'my-repo', branchName: 'feat/my-repo-ws' }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.repoName).toBe('my-repo');
        expect(data.branchName).toBe('feat/my-repo-ws');
        expect(workspace.isolateWorkspaceRepo).toHaveBeenCalledWith(
          path.resolve('/dev/workspaces', 'my-ws'),
          'my-repo',
          { branchName: 'feat/my-repo-ws', baseBranch: undefined },
        );
      });

      it('POST /api/workspace/:id/isolate requires repo parameter', async () => {
        vi.spyOn(config, 'loadConfig').mockResolvedValue({
          version: '1.0',
          devDir: '/dev',
          workspacesDir: '/dev/workspaces',
          defaultAssistant: null,
          scanDepth: 2,
        });

        const response = await app.request('/api/workspace/my-ws/isolate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toContain('Missing "repo" parameter');
      });

      it('POST /api/workspace/:id/isolate rejects whitespace repo and path traversal ids', async () => {
        vi.spyOn(config, 'loadConfig').mockResolvedValue({
          version: '1.0',
          devDir: '/dev',
          workspacesDir: '/dev/workspaces',
          defaultAssistant: null,
          scanDepth: 2,
        });

        const res1 = await app.request('/api/workspace/my-ws/isolate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: '   ' }),
        });
        expect(res1.status).toBe(400);

        const res2 = await app.request('/api/workspace/..%2f..%2fevil/isolate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: 'my-repo' }),
        });
        expect(res2.status).toBe(400);
      });
    });
  });

  describe('Schedules API', () => {
    beforeEach(() => {
      vi.spyOn(config, 'getConfigDir').mockReturnValue('/mock/home/.nexusflow');
      vi.spyOn(config, 'ensureConfigDir').mockResolvedValue(undefined);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined as any);
      vi.mocked(fs.unlink).mockResolvedValue(undefined as any);
      vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: Date.now() } as any);
      vi.mocked(fs.open).mockResolvedValue({
        writeFile: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      } as any);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    });

    it('GET /api/schedules should return jobs with a computed nextDueAt', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        version: 1,
        jobs: [{
          id: 'sync-ws-abc',
          workspacePath: '/mock/ws',
          task: 'sync',
          intervalMinutes: 60,
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastRunAt: '2026-01-02T10:00:00.000Z',
        }],
      }) as any);

      const response = await app.request('/api/schedules');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.jobs).toHaveLength(1);
      expect(data.jobs[0].id).toBe('sync-ws-abc');
      expect(data.jobs[0].nextDueAt).toBe('2026-01-02T11:00:00.000Z');
    });

    it('POST /api/schedules should reject an unknown task', async () => {
      const response = await app.request('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'deploy', every: '2h', workspacePath: '/mock/ws' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('task must be');
    });

    it('POST /api/schedules should create a job for a valid workspace', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT')); // empty store
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue({
        id: 'ws-1',
        branchName: 'ws-1',
        description: '',
        repos: [],
        assistants: [],
        workspacePath: '/mock/workspaces/ws-1',
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      const response = await app.request('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'refresh', every: '2h', workspaceId: 'ws-1' }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.job.task).toBe('refresh');
      expect(data.job.intervalMinutes).toBe(120);
      expect(data.job.enabled).toBe(true);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('POST /api/schedules/:id/enabled should update job enabled status', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        version: 1,
        jobs: [{
          id: 'job-1',
          workspacePath: '/mock/ws',
          task: 'sync',
          intervalMinutes: 60,
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        }],
      }) as any);

      const response = await app.request('/api/schedules/job-1/enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.job.enabled).toBe(false);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('POST /api/schedules/:id/enabled should reject invalid enabled type', async () => {
      const response = await app.request('/api/schedules/job-1/enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: 'not-a-boolean' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('enabled must be a boolean');
    });

    it('DELETE /api/schedules/:id should 404 for an unknown job', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

      const response = await app.request('/api/schedules/nope', { method: 'DELETE' });

      expect(response.status).toBe(404);
    });
  });

  describe('Security hardening', () => {
    describe('workspace path traversal (A2.2)', () => {
      it('DELETE /api/workspace/:id rejects a traversal id without touching the filesystem', async () => {
        vi.spyOn(config, 'loadConfig').mockResolvedValue({
          workspacesDir: '/mock/workspaces',
        } as any);
        const deleteSpy = vi
          .spyOn(workspace, 'deleteWorkspace')
          .mockResolvedValue(undefined as any);

        const response = await app.request(
          `/api/workspace/${encodeURIComponent('../../evil')}`,
          { method: 'DELETE' },
        );

        expect(response.status).toBe(400);
        expect(deleteSpy).not.toHaveBeenCalled();
      });

      it('GET /api/workspace/:id/knowledge rejects a traversal id without reading the file', async () => {
        vi.spyOn(config, 'loadConfig').mockResolvedValue({
          workspacesDir: '/mock/workspaces',
        } as any);
        const readSpy = vi.spyOn(fs, 'readFile');

        const response = await app.request(
          `/api/workspace/${encodeURIComponent('../../../etc/passwd')}/knowledge`,
        );

        expect(response.status).toBe(400);
        expect(readSpy).not.toHaveBeenCalled();
      });

      it('accepts a normal workspace id', async () => {
        vi.spyOn(config, 'loadConfig').mockResolvedValue({
          workspacesDir: '/mock/workspaces',
        } as any);
        vi.mocked(fs.readFile).mockResolvedValue('# Knowledge' as any);

        const response = await app.request('/api/workspace/my-feature/knowledge');

        expect(response.status).toBe(200);
      });
    });

    describe('diff repo containment (A2.3)', () => {
      it('rejects file traversal before reading outside the repository', async () => {
        vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
        vi.mocked(workspace.loadFeatureConfig).mockResolvedValue(null);
        const response = await app.request('/api/workspace/feat/changes/diff?repo=repo&file=..%2F..%2Foutside.txt');
        expect(response.status).toBe(400);
        expect(execa).not.toHaveBeenCalled();
      });
      it('rejects a sibling-prefix repo escape', async () => {
        vi.spyOn(config, 'loadConfig').mockResolvedValue({
          workspacesDir: '/mock/workspaces',
        } as any);
        const execSpy = vi.mocked(execa);

        // Workspace "feat"; sibling "feat-secret" shares the name prefix.
        const response = await app.request(
          `/api/workspace/feat/changes/diff?repo=${encodeURIComponent(
            '../feat-secret/repo',
          )}&file=x.ts`,
        );

        expect(response.status).toBe(400);
        expect(execSpy).not.toHaveBeenCalled();
      });
    });

    describe('CORS is restricted to localhost (A2.1)', () => {
      it('does not echo a non-localhost Origin', async () => {
        vi.spyOn(config, 'loadConfig').mockResolvedValue({
          workspacesDir: '/mock/workspaces',
        } as any);

        const response = await app.request('/api/config', {
          headers: { Origin: 'http://evil.example.com' },
        });

        expect(response.headers.get('access-control-allow-origin')).not.toBe(
          'http://evil.example.com',
        );
      });

      it('allows a localhost Origin', async () => {
        vi.spyOn(config, 'loadConfig').mockResolvedValue({
          workspacesDir: '/mock/workspaces',
        } as any);

        const response = await app.request('/api/config', {
          headers: { Origin: 'http://localhost:5173' },
        });

        expect(response.headers.get('access-control-allow-origin')).toBe(
          'http://localhost:5173',
        );
      });
    });

    describe('Workroom human authority', () => {
      it('rejects originless non-browser mutation clients', async () => {
        const response = await app.request('/api/workrooms/stop', { method: 'POST' });
        expect(response.status).toBe(403);
      });

      it('rejects a hostile page on another loopback port', async () => {
        const response = await app.request('/api/workrooms/bootstrap', {
          method: 'POST',
          headers: { Origin: 'http://localhost:5173' },
        });
        expect(response.status).toBe(403);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      });

      it.each([
        '/api/workrooms/interfaces',
        '/api/workrooms/status',
        '/api/workrooms/paused',
        '/api/workrooms/quarantined',
        '/api/workrooms/preview/feature-one',
        '/api/workrooms/snapshot',
        '/api/workrooms/local-resources',
      ])('rejects hostile loopback reads and grants them no Workroom CORS access: %s', async (pathname) => {
        const response = await app.request(pathname, {
          headers: { Origin: 'http://localhost:5173' },
        });
        expect(response.status).toBe(403);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      });

      it('requires the dashboard bootstrap even for idle Workroom reads', async () => {
        const denied = await app.request('/api/workrooms/status', {
          headers: { Origin: 'http://localhost' },
        });
        expect(denied.status).toBe(403);

        const bootstrapResponse = await app.request('/api/workrooms/bootstrap', {
          method: 'POST',
          headers: { Origin: 'http://localhost' },
        });
        const bootstrap = await bootstrapResponse.json() as { token: string };
        const cookie = bootstrapResponse.headers.get('set-cookie')?.split(';', 1)[0];
        const allowed = await app.request('/api/workrooms/status', {
          headers: {
            Origin: 'http://localhost',
            Cookie: cookie!,
            'X-NexusFlow-Workroom-Bootstrap': bootstrap.token,
          },
        });
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get('cache-control')).toBe('no-store');
        await expect(allowed.json()).resolves.toMatchObject({ status: { mode: 'idle' } });
      });

      it('reports and explicitly reclaims a lost local human session', async () => {
        const manager = workroomManager as any;
        manager.host = { service: { verifyHostRecoveryPassword: async (password: string) => password === 'correct horse battery staple' } };
        manager.activeRoomChanged();
        try {
          const bootstrapResponse = await app.request('/api/workrooms/bootstrap', {
            method: 'POST', headers: { Origin: 'http://localhost' },
          });
          const bootstrap = await bootstrapResponse.json() as { token: string };
          const bootstrapCookie = bootstrapResponse.headers.get('set-cookie')?.split(';', 1)[0];
          const headers = {
            Origin: 'http://localhost',
            Cookie: bootstrapCookie!,
            'X-NexusFlow-Workroom-Bootstrap': bootstrap.token,
          };
          const locked = await app.request('/api/workrooms/session', { headers });
          await expect(locked.json()).resolves.toEqual({ active: true, locked: true, roomType: 'host' });

          const rejected = await app.request('/api/workrooms/session/reclaim', {
            method: 'POST', headers, body: JSON.stringify({ password: 'wrong password value' }),
          });
          expect(rejected.status).toBe(401);

          const reclaimed = await app.request('/api/workrooms/session/reclaim', {
            method: 'POST', headers, body: JSON.stringify({ password: 'correct horse battery staple' }),
          });
          expect(reclaimed.status).toBe(200);
          const humanCookie = reclaimed.headers.get('set-cookie')?.split(';', 1)[0];
          expect(humanCookie).toContain('contextspace_workroom_human=');
          const unlocked = await app.request('/api/workrooms/session', {
            headers: { ...headers, Cookie: `${bootstrapCookie}; ${humanCookie}` },
          });
          await expect(unlocked.json()).resolves.toEqual({ active: true, locked: false, roomType: 'host' });
        } finally {
          manager.host = undefined;
          manager.activeRoomChanged();
        }
      });

      it('requires an exact-origin bootstrap and then a human session', async () => {
        const bootstrapResponse = await app.request('/api/workrooms/bootstrap', {
          method: 'POST',
          headers: { Origin: 'http://localhost' },
        });
        expect(bootstrapResponse.status).toBe(200);
        const bootstrap = await bootstrapResponse.json() as { token: string };
        const cookie = bootstrapResponse.headers.get('set-cookie')?.split(';', 1)[0];
        expect(cookie).toContain('contextspace_workroom_bootstrap=');

        const response = await app.request('/api/workrooms/stop', {
          method: 'POST',
          headers: {
            Origin: 'http://localhost',
            Cookie: cookie!,
            'X-NexusFlow-Workroom-Bootstrap': bootstrap.token,
          },
        });
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/human session/i) });
      });
    });

  });

  describe('desktop updater ownership', () => {
    it('does not expose the retired backend binary download/apply endpoints', async () => {
      const download = await app.request('/api/updates/download', { method: 'POST' });
      const apply = await app.request('/api/updates/apply', { method: 'POST' });
      expect(download.status).toBe(404);
      expect(apply.status).toBe(404);
    });
  });

  describe('Services & orchestration endpoints', () => {
    beforeEach(() => {
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
    });

    it('POST /services/start re-detects server-side and ignores the request body', async () => {
      vi.mocked(orchestration.detectAllServices).mockResolvedValue([
        { name: 'api', command: 'npm', args: ['run', 'dev'], cwd: '/mock', source: 'package.json', declared: true },
      ] as any);
      vi.mocked(orchestration.startServices).mockResolvedValue([{ name: 'api', status: 'running', pid: 7 }]);

      const response = await app.request('/api/workspace/ws/services/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ services: [{ name: 'evil', command: 'rm', args: ['-rf', '/'], cwd: '/', source: 'x' }] }),
      });

      expect(response.status).toBe(200);
      expect(orchestration.detectAllServices).toHaveBeenCalled();
      // The started services are the DETECTED ones, not the client's payload.
      const started = vi.mocked(orchestration.startServices).mock.calls[0]?.[0];
      expect(started).toEqual([{ name: 'api', command: 'npm', args: ['run', 'dev'], cwd: '/mock', source: 'package.json', declared: true }]);
    });

    it('POST /services/start starts only declared services and reports each result', async () => {
      vi.mocked(orchestration.detectAllServices).mockResolvedValue([
        { name: 'app/web', command: '/bin/sh', args: ['-c', 'npm run dev'], cwd: '/mock', source: 'procfile', declared: true },
        { name: 'tools', command: 'npm', args: ['run', 'dev'], cwd: '/mock', source: 'package.json', declared: false },
      ] as any);
      vi.mocked(orchestration.startServices).mockResolvedValue([{ name: 'app/web', status: 'failed', reason: 'Port 3000 is already in use by another process.' }]);

      const response = await app.request('/api/workspace/ws/services/start', { method: 'POST' });
      expect(response.status).toBe(200);
      expect(vi.mocked(orchestration.startServices).mock.calls.at(-1)?.[0].map((s: any) => s.name)).toEqual(['app/web']);
      await expect(response.json()).resolves.toMatchObject({ success: false, results: [{ name: 'app/web', status: 'failed', reason: expect.stringContaining('Port 3000') }] });
    });

    it('POST /services/start refuses when nothing is declared instead of starting guesses', async () => {
      vi.mocked(orchestration.startServices).mockClear();
      vi.mocked(orchestration.detectAllServices).mockResolvedValue([
        { name: 'tools', command: 'npm', args: ['run', 'dev'], cwd: '/mock', source: 'package.json', declared: false },
      ] as any);

      const response = await app.request('/api/workspace/ws/services/start', { method: 'POST' });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('Procfile.dev') });
      expect(orchestration.startServices).not.toHaveBeenCalled();
    });

    it('POST /services/:name/start 404s for an unknown service', async () => {
      vi.mocked(orchestration.detectAllServices).mockResolvedValue([]);

      const response = await app.request('/api/workspace/ws/services/ghost/start', { method: 'POST' });
      expect(response.status).toBe(404);
    });

    it('POST /orchestrators/start rejects an unknown detection id', async () => {
      vi.mocked(orchestration.detectOrchestrationTools).mockResolvedValue([]);

      const response = await app.request('/api/workspace/ws/orchestrators/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'docker-compose:nope.yml' }),
      });
      expect(response.status).toBe(404);
    });

    it('POST /orchestrators/stop still stops a recorded tool that is no longer detected', async () => {
      vi.mocked(orchestration.detectOrchestrationTools).mockResolvedValue([]);
      vi.mocked(orchestration.stopRecordedOrchestrator).mockResolvedValue(true);

      const response = await app.request('/api/workspace/ws/orchestrators/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'procfile:Procfile' }),
      });
      expect(response.status).toBe(200);
      expect(orchestration.stopRecordedOrchestrator).toHaveBeenCalledWith('procfile:Procfile', expect.any(String));
    });

    it('GET /services/logs/:name rejects a traversal service name without reading outside the log dir', async () => {
      const response = await app.request(
        `/api/workspace/ws/services/logs/${encodeURIComponent('../../secret')}`,
      );
      expect(response.status).toBe(400);
    });
  });

  describe('Skills & Categories Endpoints', () => {
    it('GET /api/skills/categories returns default categories', async () => {
      vi.mocked(skillsCatalog.getSkillCategories).mockResolvedValue([
        {
          id: 'pull-requests',
          name: 'Pull Requests & Review',
          description: 'PR review skills',
          icon: 'git-pull-request',
          color: '#3b82f6',
          custom: false,
          isTemplate: true,
        },
      ]);

      const response = await app.request('/api/skills/categories');
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.categories).toBeDefined();
      expect(data.categories.length).toBe(1);
      expect(data.categories[0].id).toBe('pull-requests');
      expect(data.categories[0].isTemplate).toBe(true);
    });

    it('POST /api/skills/categories creates a custom category', async () => {
      vi.mocked(skillsCatalog.saveSkillCategory).mockResolvedValue({
        id: 'serverless-workflows',
        name: 'Serverless Workflows',
        description: 'AWS Lambda and Cloudflare workers',
        icon: 'zap',
        color: '#ec4899',
        custom: true,
        isTemplate: false,
      });

      const response = await app.request('/api/skills/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Serverless Workflows',
          description: 'AWS Lambda and Cloudflare workers',
          icon: 'zap',
          color: '#ec4899',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.category.id).toBe('serverless-workflows');
      expect(data.category.custom).toBe(true);
    });

    it('GET /api/skills returns all skills', async () => {
      vi.mocked(skillsCatalog.getAllSkills).mockResolvedValue([
        {
          id: 'pr-review-toolkit',
          name: 'pr-review-toolkit',
          title: 'PR Review Toolkit',
          category: 'pull-requests',
          description: 'Review pull requests',
          custom: false,
          content: '# PR Review',
        },
      ]);

      const response = await app.request('/api/skills');
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skills).toBeDefined();
      expect(data.skills.length).toBe(1);
      expect(data.skills[0].id).toBe('pr-review-toolkit');
    });

    it('POST /api/skills creates a new skill package', async () => {
      vi.mocked(skillsCatalog.saveSkill).mockResolvedValue({
        id: 'graphql-linter',
        name: 'graphql-linter',
        title: 'GraphQL Schema Linter',
        category: 'database-migrations',
        description: 'Validates GraphQL schemas for deprecated fields',
        custom: true,
        content: '# GraphQL Schema Linter\n\nRun graphql-inspector validate.',
      });

      const response = await app.request('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'graphql-linter',
          title: 'GraphQL Schema Linter',
          category: 'database-migrations',
          description: 'Validates GraphQL schemas for deprecated fields',
          content: '# GraphQL Schema Linter\n\nRun graphql-inspector validate.',
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.skill.id).toBe('graphql-linter');
      expect(data.skill.custom).toBe(true);
    });

    it('POST /api/skills validates workspace-local scope parameters', async () => {
      // workspace scope without workspaceId returns 400
      const noWsRes = await app.request('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'local-test',
          content: '# Local Test',
          scope: 'workspace',
        }),
      });
      expect(noWsRes.status).toBe(400);

      // workspace scope with unknown workspace returns 404
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: path.resolve('/workspaces') } as any);
      vi.mocked(workspace.listWorkspaces).mockResolvedValue([]);

      const unknownWsRes = await app.request('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'local-test',
          content: '# Local Test',
          scope: 'workspace',
          workspaceId: 'non-existent-ws',
        }),
      });
      expect(unknownWsRes.status).toBe(404);
    });

    it('DELETE /api/skills/:id?workspace=non-existent returns 404', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: path.resolve('/workspaces') } as any);
      vi.mocked(workspace.listWorkspaces).mockResolvedValue([]);

      const response = await app.request('/api/skills/local-test?workspace=non-existent-ws', {
        method: 'DELETE',
      });
      expect(response.status).toBe(404);
    });

    it('GET and POST /api/agents administer Codex-native agents', async () => {
      const agent = {
        id: 'reviewer',
        name: 'reviewer',
        category: 'general',
        description: 'Review a fixed diff.',
        developerInstructions: 'Review correctness and security.',
        sandboxMode: 'read-only' as const,
        custom: true,
      };
      vi.mocked(agentsCatalog.getAllAgents).mockResolvedValue([agent]);
      vi.mocked(agentsCatalog.saveAgent).mockResolvedValue(agent);

      const listResponse = await app.request('/api/agents');
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual({ agents: [agent] });

      const saveResponse = await app.request('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agent),
      });
      expect(saveResponse.status).toBe(200);
      expect(agentsCatalog.saveAgent).toHaveBeenCalledWith(agent);
    });

    it('blocks deleting resources that are still assigned to a workspace', async () => {
      const workspacePath = path.resolve('/workspaces/example');
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: path.resolve('/workspaces') } as any);
      vi.mocked(workspace.listWorkspaces).mockResolvedValue([{ id: 'example', workspacePath }] as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({ workspacePath } as any);
      vi.mocked(skillsCatalog.getWorkspaceSkillsConfig).mockResolvedValue({
        schemaVersion: 1,
        revision: 1,
        enabledSkills: ['pr-review-toolkit'],
        enabledAgents: ['reviewer'],
        enabledCategories: [],
      });

      const skillResponse = await app.request('/api/skills/pr-review-toolkit', { method: 'DELETE' });
      expect(skillResponse.status).toBe(409);
      await expect(skillResponse.json()).resolves.toMatchObject({ workspaces: ['example'] });
      expect(skillsCatalog.deleteSkill).not.toHaveBeenCalled();

      const agentResponse = await app.request('/api/agents/reviewer', { method: 'DELETE' });
      expect(agentResponse.status).toBe(409);
      await expect(agentResponse.json()).resolves.toMatchObject({ workspaces: ['example'] });
      expect(agentsCatalog.deleteAgent).not.toHaveBeenCalled();
    });

    it('requires an exact existing workspace before reading resource assignments', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/workspaces' } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => {
        if (String(candidate).endsWith('missing')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return String(candidate);
      });

      const response = await app.request('/api/skills/workspace/missing');
      expect(response.status).toBe(404);
      expect(skillsCatalog.getWorkspaceSkillsConfig).not.toHaveBeenCalled();
    });

    it('saves versioned skill and agent assignments for an exact workspace', async () => {
      const workspacePath = path.resolve('/workspaces/example');
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: path.resolve('/workspaces') } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({ workspacePath } as any);
      vi.mocked(skillsCatalog.getAllSkills).mockResolvedValue([]);
      vi.mocked(skillsCatalog.saveWorkspaceSkillsConfig).mockResolvedValue({
        schemaVersion: 2,
        revision: 4,
        enabledSkills: ['pr-review-toolkit'],
        enabledAgents: ['reviewer'],
        enabledCategories: [],
      });

      const response = await app.request('/api/skills/workspace/example/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 3,
          enabledSkills: ['pr-review-toolkit'],
          enabledAgents: ['reviewer'],
          enabledCategories: [],
        }),
      });

      expect(response.status).toBe(200);
      expect(resourceService.validateResourceSelections).toHaveBeenCalledWith(['pr-review-toolkit'], ['reviewer'], workspacePath);
      expect(skillsCatalog.saveWorkspaceSkillsConfig).toHaveBeenCalledWith(
        workspacePath,
        { enabledSkills: ['pr-review-toolkit'], enabledAgents: ['reviewer'], enabledCategories: [], disabledSkills: [] },
        3,
      );
    });

    it('saves the subscribed categories and the skills switched off, and drops skills a harness ships', async () => {
      const workspacePath = path.resolve('/workspaces/example');
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: path.resolve('/workspaces') } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({ workspacePath } as any);
      vi.mocked(skillsCatalog.getAllSkills).mockResolvedValue([
        { id: 'standup', name: 'standup', category: 'notes', description: 'Notes', content: '# Notes', custom: true },
        { id: 'pdf', name: 'pdf', category: 'documents', description: 'PDFs', content: '# PDF', custom: false, scope: 'global', source: { harness: 'claude', label: 'Claude Code', root: '/home/me/.claude/skills' } },
      ]);
      vi.mocked(skillsCatalog.saveWorkspaceSkillsConfig).mockResolvedValue({ schemaVersion: 2, revision: 5, enabledSkills: ['standup'] });

      const response = await app.request('/api/skills/workspace/example/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 4,
          enabledSkills: ['pdf', 'standup'],
          enabledAgents: [],
          enabledCategories: ['pull-requests'],
          disabledSkills: ['write-description'],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ success: true, config: { revision: 5 } });
      expect(resourceService.validateResourceSelections).toHaveBeenCalledWith(['standup'], [], workspacePath);
      expect(skillsCatalog.saveWorkspaceSkillsConfig).toHaveBeenCalledWith(
        workspacePath,
        { enabledSkills: ['standup'], enabledAgents: [], enabledCategories: ['pull-requests'], disabledSkills: ['write-description'] },
        4,
      );
    });

    it.each([
      [{ enabledCategories: 'pull-requests' }],
      [{ disabledSkills: 'standup' }],
    ])('rejects categories or exceptions that are not lists (%j)', async (extra) => {
      const response = await app.request('/api/skills/workspace/example/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 0, enabledSkills: [], enabledAgents: [], ...extra }),
      });

      expect(response.status).toBe(400);
      expect(skillsCatalog.saveWorkspaceSkillsConfig).not.toHaveBeenCalled();
    });

    it('returns what the saved selection turns on and what the workspace holds', async () => {
      const workspacePath = path.resolve('/workspaces/example');
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: path.resolve('/workspaces') } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({ workspacePath } as any);
      const library = (id: string, category: string) => ({ id, name: id, category, description: id, content: `# ${id}`, custom: true });
      vi.mocked(skillsCatalog.getAllSkills).mockResolvedValue([
        library('review-pr', 'pull-requests'),
        library('write-description', 'pull-requests'),
        library('standup', 'notes'),
        library('run-e2e', 'testing'),
        { ...library('local-plan', 'general'), scope: 'workspace' as const },
        { ...library('pdf', 'pull-requests'), custom: false, scope: 'global' as const, source: { harness: 'claude', label: 'Claude Code', root: '/home/me/.claude/skills' } },
      ]);
      vi.mocked(skillsCatalog.getWorkspaceSkillsConfig).mockResolvedValue({
        schemaVersion: 2,
        revision: 3,
        enabledSkills: ['standup', 'pdf'],
        disabledSkills: ['write-description'],
        enabledAgents: [],
        enabledCategories: ['pull-requests'],
      });
      vi.mocked(skillsCatalog.listInstalledSkillIds).mockResolvedValue(['review-pr', 'stale-copy']);

      const response = await app.request('/api/skills/workspace/example');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.config).toMatchObject({ revision: 3, enabledCategories: ['pull-requests'], disabledSkills: ['write-description'] });
      // Single picks, then the category, minus the exception; nothing a harness ships; no workspace-only skill once a selection is saved.
      expect(body.resolvedSkills).toEqual(['standup', 'review-pr']);
      expect(body.installedSkills).toEqual(['review-pr', 'stale-copy']);
      expect(skillsCatalog.getAllSkills).toHaveBeenCalledWith(workspacePath);
      expect(skillsCatalog.listInstalledSkillIds).toHaveBeenCalledWith(workspacePath);
    });

    it('turns on the skills written inside a workspace that has no saved selection yet', async () => {
      const workspacePath = path.resolve('/workspaces/example');
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: path.resolve('/workspaces') } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({ workspacePath } as any);
      vi.mocked(skillsCatalog.getAllSkills).mockResolvedValue([
        { id: 'local-plan', name: 'local-plan', category: 'general', description: 'Plan', content: '# Plan', custom: true, scope: 'workspace' },
        { id: 'standup', name: 'standup', category: 'notes', description: 'Notes', content: '# Notes', custom: true },
      ]);
      vi.mocked(skillsCatalog.getWorkspaceSkillsConfig).mockResolvedValue({
        schemaVersion: 2, revision: 0, enabledSkills: [], disabledSkills: [], enabledAgents: [], enabledCategories: [],
      });
      vi.mocked(skillsCatalog.listInstalledSkillIds).mockResolvedValue([]);

      const response = await app.request('/api/skills/workspace/example');

      await expect(response.json()).resolves.toMatchObject({ resolvedSkills: ['local-plan'], installedSkills: [] });
    });

    it('POST /api/skills/import adds a harness skill to My library', async () => {
      const skill = { id: 'pdf', name: 'pdf', category: 'documents', description: 'PDFs', content: '# PDF', custom: true, scope: 'global' as const };
      vi.mocked(skillsCatalog.importHarnessSkill).mockResolvedValue(skill);

      const response = await app.request('/api/skills/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ harness: 'claude', id: 'pdf' }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ skill });
      expect(skillsCatalog.importHarnessSkill).toHaveBeenCalledWith('claude', 'pdf');
    });

    it.each([
      ['not-found', 404, 'No skill named "pdf" is built into claude.'],
      ['exists', 409, 'My library already has a skill named "pdf".'],
    ] as const)('POST /api/skills/import answers %s with %i', async (code, status, message) => {
      // The catalog module is mocked here, so the error carries its fields by hand.
      vi.mocked(skillsCatalog.importHarnessSkill).mockRejectedValueOnce(
        Object.assign(new skillsCatalog.SkillImportError(code, message), { code, message }),
      );

      const response = await app.request('/api/skills/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ harness: 'claude', id: 'pdf' }),
      });

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: message });
    });

    it('POST /api/skills/import needs a harness and an id', async () => {
      for (const body of [{}, { harness: 'claude' }, { id: 'pdf' }, { harness: 1, id: 'pdf' }]) {
        const response = await app.request('/api/skills/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
      expect(skillsCatalog.importHarnessSkill).not.toHaveBeenCalled();
    });

    it('POST /api/resources/preview passes the chosen categories on', async () => {
      // What the preview contains is covered where it is computed (resources/service.test.ts).
      vi.mocked(resourceService.previewResourceSelections).mockResolvedValueOnce([]);

      const response = await app.request('/api/resources/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skills: ['standup'], agents: [], assistants: ['claude', 'unknown-tool'], categories: ['pull-requests'] }),
      });

      expect(response.status).toBe(200);
      expect(resourceService.previewResourceSelections).toHaveBeenCalledWith(['standup'], [], ['claude'], ['pull-requests'], []);
    });

    it('POST /api/resources/preview treats Pi as an assistant and drops names that are not harnesses', async () => {
      vi.mocked(resourceService.previewResourceSelections).mockResolvedValueOnce([]);

      const response = await app.request('/api/resources/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skills: [], assistants: ['pi', 'cursor', 'toString'] }),
      });

      expect(response.status).toBe(200);
      expect(resourceService.previewResourceSelections).toHaveBeenCalledWith([], [], ['pi', 'cursor'], [], []);
    });

    it('POST /api/resources/preview works without categories', async () => {
      vi.mocked(resourceService.previewResourceSelections).mockResolvedValueOnce([]);

      const response = await app.request('/api/resources/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skills: ['standup'] }),
      });

      expect(response.status).toBe(200);
      expect(resourceService.previewResourceSelections).toHaveBeenCalledWith(['standup'], [], [], [], []);
    });

    it('rejects workspace assignments that reference missing catalog resources', async () => {
      const workspacePath = path.resolve('/workspaces/example');
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: path.resolve('/workspaces') } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({ workspacePath } as any);
      vi.mocked(skillsCatalog.getAllSkills).mockResolvedValue([]);
      vi.mocked(resourceService.validateResourceSelections).mockRejectedValueOnce(
        new resourceService.ResourceSelectionError(['missing-skill'], ['missing_agent']),
      );

      const response = await app.request('/api/skills/workspace/example/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 0,
          enabledSkills: ['missing-skill'],
          enabledAgents: ['missing_agent'],
          enabledCategories: [],
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        missingSkills: ['missing-skill'],
        missingAgents: ['missing_agent'],
      });
      expect(skillsCatalog.saveWorkspaceSkillsConfig).not.toHaveBeenCalled();
    });

    it('requires an assignment revision and maps stale revisions to a conflict', async () => {
      const missingRevision = await app.request('/api/skills/workspace/example/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledSkills: [], enabledAgents: [] }),
      });
      expect(missingRevision.status).toBe(400);
      expect(config.loadConfig).not.toHaveBeenCalled();

      const workspacePath = path.resolve('/workspaces/example');
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: path.resolve('/workspaces') } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({ workspacePath } as any);
      vi.mocked(skillsCatalog.getAllSkills).mockResolvedValue([]);
      const revisionError = new skillsCatalog.WorkspaceResourceRevisionError(2, 3);
      revisionError.message = 'Workspace resource configuration changed (expected revision 2, current 3).';
      vi.mocked(skillsCatalog.saveWorkspaceSkillsConfig).mockRejectedValueOnce(revisionError);

      const staleRevision = await app.request('/api/skills/workspace/example/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 2, enabledSkills: [], enabledAgents: [] }),
      });
      expect(staleRevision.status).toBe(409);
      await expect(staleRevision.json()).resolves.toMatchObject({
        error: expect.stringContaining('expected revision 2, current 3'),
      });
    });
  });

  describe('Enterprise & Modular Domain Packs Endpoints', () => {
    it('GET /api/enterprise/domain-packs returns empty array when clean slate (generic default)', async () => {
      clearCustomDomainRegistrations();
      try {
        const response = await app.request('/api/enterprise/domain-packs');
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.domainPacks).toEqual([]);
      } finally {
        registerSampleDomainPacks();
      }
    });

    it('GET /api/enterprise/organizations returns registered organizations', async () => {
      const response = await app.request('/api/enterprise/organizations');
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.organizations.some((o: any) => o.id === 'acme')).toBe(true);
    });

    it('GET /api/enterprise/domain-packs returns registered domain packs', async () => {
      const response = await app.request('/api/enterprise/domain-packs');
      expect(response.status).toBe(200);
      const data = await response.json();
      const ids = data.domainPacks.map((p: any) => p.id);
      expect(ids).toContain('economy');
      expect(ids).toContain('hr');
      expect(ids).toContain('transport');
    });

    it('POST /api/enterprise/match-domains matches domain packs from text spec', async () => {
      const response = await app.request('/api/enterprise/match-domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Calculate Swedish VAT and export customer invoice' }),
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.matched.length).toBeGreaterThan(0);
      expect(data.matched[0].id).toBe('economy');
    });

    it('GET /api/workspace/:id/domain-packs returns resolved domain rules for workspace', async () => {
      const workspacePath = path.resolve('/workspaces/enterprise-ws');
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: path.resolve('/workspaces') } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({ workspacePath } as any);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({
        id: 'enterprise-ws',
        branchName: 'enterprise-ws',
        description: 'Enterprise integration',
        organizationId: 'acme',
        domainPacks: ['economy'],
        repos: [],
        assistants: ['claude'],
        workspacePath,
        createdAt: '2026-07-17T00:00:00.000Z',
      } as any);

      const response = await app.request('/api/workspace/enterprise-ws/domain-packs');
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.organizationId).toBe('acme');
      expect(data.assignedDomainPackIds).toEqual(['economy']);
      expect(data.organization.name).toBe('Acme Corp');
      expect(data.allRules.some((r: string) => r.includes('Swedish VAT standard rates'))).toBe(true);
    });

    it('POST /api/workspace/:id/domain-packs updates workspace domains and rules', async () => {
      const workspacePath = path.resolve('/workspaces/enterprise-ws');
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: path.resolve('/workspaces') } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({ workspacePath } as any);
      const featureMock = {
        id: 'enterprise-ws',
        branchName: 'enterprise-ws',
        description: 'Enterprise integration',
        organizationId: undefined,
        domainPacks: [],
        repos: [],
        assistants: ['claude'],
        workspacePath,
        createdAt: '2026-07-17T00:00:00.000Z',
      };
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue(featureMock as any);
      vi.mocked(workspace.saveFeatureConfig).mockResolvedValue(undefined);

      const response = await app.request('/api/workspace/enterprise-ws/domain-packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'acme',
          domainPacks: ['economy', 'transport'],
        }),
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.feature.organizationId).toBe('acme');
      expect(data.feature.domainPacks).toEqual(['economy', 'transport']);
      expect(workspace.saveFeatureConfig).toHaveBeenCalledWith(workspacePath, expect.objectContaining({
        organizationId: 'acme',
        domainPacks: ['economy', 'transport'],
      }));
    });

    it('POST /api/workspace/:id/update-spec updates specification and auto-matches domain packs', async () => {
      const workspacePath = path.resolve('/workspaces/enterprise-ws');
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: path.resolve('/workspaces') } as any);
      vi.mocked(fs.realpath).mockImplementation(async (candidate) => path.resolve(String(candidate)));
      vi.mocked(workspace.loadWorkspaceManifest).mockResolvedValue({ workspacePath } as any);
      const featureMock = {
        id: 'enterprise-ws',
        branchName: 'enterprise-ws',
        description: 'Original spec',
        organizationId: 'acme',
        domainPacks: ['economy'],
        repos: [],
        assistants: ['claude'],
        workspacePath,
        createdAt: '2026-07-17T00:00:00.000Z',
      };
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue(featureMock as any);
      vi.mocked(workspace.saveFeatureConfig).mockResolvedValue(undefined);

      const response = await app.request('/api/workspace/enterprise-ws/update-spec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'Updated PO requirements: calculate employee payroll deductions and kollektivavtal benefits',
          autoMatchDomains: true,
        }),
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.newlyMatched).toContain('hr');
      expect(data.feature.domainPacks).toContain('economy');
      expect(data.feature.domainPacks).toContain('hr');
    });

    it('POST, GET, PUT, and DELETE /api/enterprise/domain-packs manages custom domain packs', async () => {
      const postRes = await app.request('/api/enterprise/domain-packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'custom-fintech',
          name: 'Fintech & Payments',
          description: 'Payment gateway integrations and settlement reconciliations.',
          tags: ['fintech', 'payment', 'stripe', 'pci'],
          rules: ['Zero plain-text credit card storage (PCI-DSS).'],
          verifyCommand: 'npm test -- fintech',
        }),
      });
      expect(postRes.status).toBe(200);
      const postData = await postRes.json();
      expect(postData.success).toBe(true);
      expect(postData.domainPack.id).toBe('custom-fintech');
      expect(postData.domainPack.isTemplate).toBe(false);

      // GET by id
      const getRes = await app.request('/api/enterprise/domain-packs/custom-fintech');
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.domainPack.id).toBe('custom-fintech');
      expect(getData.domainPack.verifyCommand).toBe('npm test -- fintech');

      // GET non-existent returns 404
      const missingRes = await app.request('/api/enterprise/domain-packs/non-existent-pack');
      expect(missingRes.status).toBe(404);

      // PUT non-existent returns 404
      const missingPutRes = await app.request('/api/enterprise/domain-packs/non-existent-pack', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Non Existent' }),
      });
      expect(missingPutRes.status).toBe(404);

      // PUT update
      const putRes = await app.request('/api/enterprise/domain-packs/custom-fintech', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Fintech, Payments & Crypto',
          rules: ['Zero plain-text credit card storage (PCI-DSS).', 'All crypto ledger transactions require signature.'],
          verifyCommand: 'npm test -- fintech-crypto',
        }),
      });
      expect(putRes.status).toBe(200);
      const putData = await putRes.json();
      expect(putData.success).toBe(true);
      expect(putData.domainPack.name).toBe('Fintech, Payments & Crypto');
      expect(putData.domainPack.rules).toHaveLength(2);
      expect(putData.domainPack.verifyCommand).toBe('npm test -- fintech-crypto');

      // PUT update clearing rules and verifyCommand
      const clearPutRes = await app.request('/api/enterprise/domain-packs/custom-fintech', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rules: [],
          verifyCommand: '',
        }),
      });
      expect(clearPutRes.status).toBe(200);
      const clearPutData = await clearPutRes.json();
      expect(clearPutData.domainPack.rules).toHaveLength(0);
      expect(clearPutData.domainPack.verifyCommand).toBeUndefined();

      const delRes = await app.request('/api/enterprise/domain-packs/custom-fintech', {
        method: 'DELETE',
      });
      expect(delRes.status).toBe(200);
      const delData = await delRes.json();
      expect(delData.success).toBe(true);

      const afterDelRes = await app.request('/api/enterprise/domain-packs/custom-fintech');
      expect(afterDelRes.status).toBe(404);

      // Customizing registered domain pack and deleting it
      const overrideBuiltin = await app.request('/api/enterprise/domain-packs/economy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Overridden Economy',
          rules: ['Strict bespoke invoice rules'],
        }),
      });
      expect(overrideBuiltin.status).toBe(200);
      const overrideData = await overrideBuiltin.json();
      expect(overrideData.domainPack.name).toBe('Overridden Economy');
      expect(overrideData.domainPack.isTemplate).toBe(false);

      // Reset / unregister via DELETE
      const resetBuiltin = await app.request('/api/enterprise/domain-packs/economy', {
        method: 'DELETE',
      });
      expect(resetBuiltin.status).toBe(200);

      const restoredBuiltin = await app.request('/api/enterprise/domain-packs/economy');
      expect(restoredBuiltin.status).toBe(404);
    });

    it('POST and DELETE /api/enterprise/organizations registers and unregisters custom organizations', async () => {
      const postRes = await app.request('/api/enterprise/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'spotify',
          name: 'Spotify',
          commitMessagePattern: '^SPOT-[0-9]+: .+$',
          rules: ['Squad ownership tags required in PR.'],
        }),
      });
      expect(postRes.status).toBe(200);
      const postData = await postRes.json();
      expect(postData.success).toBe(true);
      expect(postData.organization.id).toBe('spotify');

      const delRes = await app.request('/api/enterprise/organizations/spotify', {
        method: 'DELETE',
      });
      expect(delRes.status).toBe(200);
      const delData = await delRes.json();
      expect(delData.success).toBe(true);
    });
  });

  describe('GET /api/workspaces/status', () => {
    it('checks only the requested page and rejects invalid page sizes', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/workspaces' } as any);
      vi.mocked(workspace.listWorkspaces).mockResolvedValue(Array.from({ length: 30 }, (_, index) => ({
        id: `ws-${index}`,
        branchName: `feature-${index}`,
        workspacePath: `/workspaces/feature-${index}`,
        repos: [],
        createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      })) as any);
      const findActive = vi.spyOn(sessionFinder, 'findActiveAssistants').mockResolvedValue([]);
      try {
        const first = await app.request('/api/workspaces/status?offset=0&limit=24');
        expect(first.status).toBe(200);
        const firstPage = await first.json();
        expect(firstPage.total).toBe(30);
        expect(firstPage.snapshot).toEqual(expect.any(String));
        expect(firstPage.nextOffset).toBe(24);
        expect(Object.keys(firstPage.statuses)).toHaveLength(24);
        expect(firstPage.statuses['feature-29']).toBeDefined();
        expect(firstPage.statuses['feature-0']).toBeUndefined();
        expect(findActive).toHaveBeenCalledTimes(24);

        const second = await app.request(`/api/workspaces/status?offset=24&limit=24&snapshot=${firstPage.snapshot}`);
        expect(second.status).toBe(200);
        const secondPage = await second.json();
        expect(secondPage.nextOffset).toBeNull();
        expect(Object.keys(secondPage.statuses)).toHaveLength(6);
        expect(findActive).toHaveBeenCalledTimes(30);
        expect(workspace.listWorkspaces).toHaveBeenCalledTimes(1);
        expect((await app.request('/api/workspaces/status?offset=0&limit=100')).status).toBe(400);
        expect((await app.request('/api/workspaces/status?offset=-1&limit=24')).status).toBe(400);
        expect((await app.request('/api/workspaces/status?offset=24&limit=24')).status).toBe(400);
        expect((await app.request('/api/workspaces/status?offset=24&limit=24&snapshot=missing')).status).toBe(410);
      } finally {
        findActive.mockRestore();
      }
    });

    it('runs git status once per repository per scan when workspaces share it', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/workspaces' } as any);
      vi.mocked(workspace.listWorkspaces).mockResolvedValue(['a', 'b', 'c'].map((name, index) => ({
        id: `ws-${name}`,
        branchName: `shared-${name}`,
        mode: 'in-place',
        workspacePath: `/workspaces/shared-${name}`,
        repos: ['/repos/shared'],
        createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      })) as any);
      vi.mocked(execa).mockResolvedValue({ stdout: ' M src/a.ts\0', stderr: '', exitCode: 0 } as any);
      const findActive = vi.spyOn(sessionFinder, 'findActiveAssistants').mockResolvedValue([]);
      const statusRuns = () => vi.mocked(execa).mock.calls.filter(([, args]) => (args as string[] | undefined)?.includes('status')).length;
      try {
        const page = await (await app.request('/api/workspaces/status?offset=0&limit=24')).json();
        expect(Object.values(page.statuses).map((status: any) => status.changedFiles)).toEqual([1, 1, 1]);
        expect(statusRuns()).toBe(1);

        // A new scan reads fresh status.
        await app.request('/api/workspaces/status?offset=0&limit=24');
        expect(statusRuns()).toBe(2);
      } finally {
        findActive.mockRestore();
      }
    });

    it('returns workspace statuses including active AI assistants', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/workspaces' } as any);
      vi.mocked(workspace.listWorkspaces).mockResolvedValue([
        {
          id: 'ws-1',
          branchName: 'feature-one',
          workspacePath: '/workspaces/feature-one',
          repos: ['repo1'],
        },
        {
          id: 'ws-2',
          branchName: 'feature-two',
          workspacePath: '/workspaces/feature-two',
          repos: ['repo2'],
        },
      ] as any);

      const findActive = vi.spyOn(sessionFinder, 'findActiveAssistants').mockImplementation(async (wsPath) => {
        if (wsPath === '/workspaces/feature-one') {
          return ['antigravity', 'claude'];
        }
        return [];
      });

      const response = await app.request('/api/workspaces/status');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body['feature-one']).toMatchObject({
        id: 'ws-1',
        branchName: 'feature-one',
        activeAssistants: ['antigravity', 'claude'],
      });
      expect(body['feature-two']).toMatchObject({
        id: 'ws-2',
        branchName: 'feature-two',
        activeAssistants: [],
      });

      findActive.mockRestore();
    });
  });

  it('returns the persisted verification details with the lifecycle', async () => {
    const lifecycleCore = await import('./core/lifecycle.js');
    const stateCore = await import('./core/workspace-state.js');
    const lifecycle = { workspaceId: 'demo', flowType: 'feature', steps: [], updatedAt: '' };
    const report = { overallStatus: 'fail', repos: [{ repoName: 'api', error: 'Repository changed', stdout: 'test output' }] };
    vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/workspaces' } as any);
    const lifecycleSpy = vi.spyOn(lifecycleCore, 'loadWorkspaceLifecycle').mockResolvedValue(lifecycle as any);
    const stateSpy = vi.spyOn(stateCore, 'loadWorkspaceState').mockResolvedValue({ lastVerification: report } as any);
    try {
      const response = await app.request('/api/workspace/demo/lifecycle');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ lifecycle, report, plan: '' });
      expect(lifecycleSpy).toHaveBeenLastCalledWith(expect.any(String), { includeFleet: false });
      expect((await app.request('/api/workspace/demo/lifecycle?fleet=1')).status).toBe(200);
      expect(lifecycleSpy).toHaveBeenLastCalledWith(expect.any(String), { includeFleet: true });
    } finally {
      lifecycleSpy.mockRestore();
      stateSpy.mockRestore();
    }
  });

  describe('POST /api/workspace/:id/changes/revert', () => {
    beforeEach(() => {
      vi.mocked(fs.open).mockImplementation((async (p: any) => {
        return {
          readFile: vi.fn().mockImplementation(async () => fs.readFile(p)),
          stat: vi.fn().mockImplementation(async () => fs.stat(p)),
          close: vi.fn().mockResolvedValue(undefined),
        } as any;
      }) as any);
    });

    it('rejects non-local origins', async () => {
      const res = await app.request('/api/workspace/test-ws/changes/revert', {
        method: 'POST',
        headers: { 'Origin': 'http://evil.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: ['src/index.ts'] }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects empty files array', async () => {
      const res = await app.request('/api/workspace/test-ws/changes/revert', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [] }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects path traversal in file paths', async () => {
      const res = await app.request('/api/workspace/test-ws/changes/revert', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: ['../../etc/passwd'] }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when repository name is ambiguous in an in-place workspace', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({
        id: 'test-ws',
        branchName: 'test-ws',
        mode: 'in-place',
        repos: ['/path/to/groupA/my-repo', '/path/to/groupB/my-repo'],
        assistants: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      } as any);

      const res = await app.request('/api/workspace/test-ws/changes/revert', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'my-repo', files: ['file.txt'] }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Ambiguous repository 'my-repo'");
    });

    it('successfully reverts tracked and untracked files', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({
        id: 'test-ws',
        branchName: 'test-ws',
        repos: ['/mock/workspaces/test-ws'],
        assistants: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      } as any);

      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('existing content'));
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      vi.mocked(execa).mockImplementation((async (cmd: any, args?: readonly string[]) => {
        if (cmd === 'git' && args?.[0] === 'status') {
          const file = args[args.length - 1];
          if (file === 'tracked.ts') return { stdout: ' M tracked.ts' };
          if (file === 'untracked.ts') return { stdout: '?? untracked.ts' };
          return { stdout: '' };
        }
        if (cmd === 'git' && args?.[0] === 'checkout') {
          return { stdout: '' };
        }
        return { stdout: '' };
      }) as any);

      const res = await app.request('/api/workspace/test-ws/changes/revert', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: ['tracked.ts', 'untracked.ts'] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.reverted).toEqual(['tracked.ts', 'untracked.ts']);
      expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('untracked.ts'));
    });

    it('rolls back previously reverted changes if execution fails mid-way', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({
        id: 'test-ws',
        branchName: 'test-ws',
        repos: ['/mock/workspaces/test-ws'],
        assistants: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      } as any);

      const snap1 = Buffer.from('console.log("file1 original");');
      const snap2 = Buffer.from('console.log("file2 original");');

      vi.mocked(fs.readFile).mockImplementation((async (filePath: any) => {
        if (String(filePath).includes('file1.ts')) return snap1;
        if (String(filePath).includes('file2.ts')) return snap2;
        return Buffer.from('');
      }) as any);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      vi.mocked(execa).mockImplementation((async (cmd: any, args?: readonly string[]) => {
        if (cmd === 'git' && args?.[0] === 'status') {
          return { stdout: ` M ${args[args.length - 1]}` };
        }
        if (cmd === 'git' && args?.[0] === 'checkout') {
          const file = args[args.length - 1];
          if (file === 'file2.ts') {
            throw new Error('Lockfile contention on file2.ts');
          }
          return { stdout: '' };
        }
        return { stdout: '' };
      }) as any);

      const res = await app.request('/api/workspace/test-ws/changes/revert', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: ['file1.ts', 'file2.ts'] }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain('Lockfile contention on file2.ts');
      expect(data.error).toContain('rolled back');

      // Verify file1 was restored via rollback
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('file1.ts'),
        snap1,
      );
    });

    it('rejects unmerged conflict statuses during preflight', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({
        id: 'test-ws',
        branchName: 'test-ws',
        repos: ['/mock/workspaces/test-ws'],
        assistants: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      } as any);

      vi.mocked(execa).mockImplementation((async (cmd: any, args?: readonly string[]) => {
        if (cmd === 'git' && args?.[0] === 'status') {
          return { stdout: 'UU conflict.ts' };
        }
        return { stdout: '' };
      }) as any);

      const res = await app.request('/api/workspace/test-ws/changes/revert', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: ['conflict.ts'] }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('unmerged git conflicts');
    });

    it('preserves and restores Git index and file metadata when revert fails on second file', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({
        id: 'test-ws',
        branchName: 'test-ws',
        repos: ['/mock/workspaces/test-ws'],
        assistants: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      } as any);

      const aWorking = Buffer.from('a.txt working tree bytes');
      const indexBytes = Buffer.from('binary-git-index-snapshot-12345');

      vi.mocked(fs.stat).mockResolvedValue({ mode: 0o100644 } as any);
      vi.mocked(fs.readFile).mockImplementation((async (filePath: any) => {
        if (String(filePath).endsWith('.git/index') || String(filePath).includes('index')) {
          return indexBytes;
        }
        if (String(filePath).includes('a.txt')) return aWorking;
        return Buffer.from('');
      }) as any);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      vi.mocked(execa).mockImplementation((async (cmd: any, args?: readonly string[]) => {
        if (cmd === 'git' && args?.[0] === 'rev-parse' && args?.[1] === '--git-path') {
          return { stdout: '.git/index' };
        }
        if (cmd === 'git' && args?.[0] === 'status') {
          const file = args[args.length - 1];
          if (file === 'a.txt') return { stdout: 'MM a.txt' }; // staged + unstaged changes
          if (file === 'b.txt') return { stdout: 'A  b.txt' }; // newly staged file absent from HEAD
          return { stdout: '' };
        }
        if (cmd === 'git' && args?.[0] === 'checkout') {
          const file = args[args.length - 1];
          if (file === 'b.txt') {
            throw new Error('git checkout HEAD failed for newly added b.txt');
          }
          return { stdout: '' };
        }
        return { stdout: '' };
      }) as any);

      const res = await app.request('/api/workspace/test-ws/changes/revert', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: ['a.txt', 'b.txt'] }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain('git checkout HEAD failed for newly added b.txt');
      expect(data.error).toContain('rolled back');

      // Verify git index snapshot was written back to restore staged state
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/[/\\]\.git[/\\]index/),
        indexBytes,
      );
      // Verify a.txt working tree was restored
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('a.txt'),
        aWorking,
      );
    });

    it('accurately reports failure when rollback restoration fails without overstating recovery', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({
        id: 'test-ws',
        branchName: 'test-ws',
        repos: ['/mock/workspaces/test-ws'],
        assistants: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      } as any);

      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('original file'));
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('EPERM: disk permission denied on rollback'));

      vi.mocked(execa).mockImplementation((async (cmd: any, args?: readonly string[]) => {
        if (cmd === 'git' && args?.[0] === 'status') {
          return { stdout: ` M ${args[args.length - 1]}` };
        }
        if (cmd === 'git' && args?.[0] === 'checkout') {
          const file = args[args.length - 1];
          if (file === 'file2.ts') {
            throw new Error('Primary checkout error on file2.ts');
          }
          return { stdout: '' };
        }
        return { stdout: '' };
      }) as any);

      const res = await app.request('/api/workspace/test-ws/changes/revert', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: ['file1.ts', 'file2.ts'] }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain('Primary checkout error on file2.ts');
      expect(data.error).toContain('Warning: Rollback could not fully restore state');
      expect(data.error).not.toContain('Any modified files were rolled back.');
    });

    it('fails preflight if an existing Git index cannot be snapshotted', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({
        id: 'test-ws',
        branchName: 'test-ws',
        repos: ['/mock/workspaces/test-ws'],
        assistants: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      } as any);

      vi.mocked(execa).mockImplementation((async (cmd: any, args?: readonly string[]) => {
        if (cmd === 'git' && args?.[0] === 'rev-parse' && args?.[1] === '--git-path') {
          return { stdout: '.git/index' };
        }
        return { stdout: '' };
      }) as any);

      vi.mocked(fs.readFile).mockImplementation((async (filePath: any) => {
        if (String(filePath).includes('index')) {
          const err = new Error('EACCES: permission denied on .git/index');
          (err as any).code = 'EACCES';
          throw err;
        }
        return Buffer.from('');
      }) as any);

      const res = await app.request('/api/workspace/test-ws/changes/revert', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: ['file1.ts'] }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain('Failed to snapshot Git index before revert');
      expect(data.error).toContain('EACCES');
    });

    it('accurately reports failure when unlinking a previously absent tracked file fails during rollback', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({
        id: 'test-ws',
        branchName: 'test-ws',
        repos: ['/mock/workspaces/test-ws'],
        assistants: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      } as any);

      // Both tracked files were deleted before the request
      vi.mocked(fs.open).mockImplementation((async (p: any) => {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        (err as any).code = 'ENOENT';
        throw err;
      }) as any);
      vi.mocked(fs.readFile).mockImplementation((async (p: any) => {
        if (String(p).includes('index')) return Buffer.from('index-data');
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        (err as any).code = 'ENOENT';
        throw err;
      }) as any);

      vi.mocked(execa).mockImplementation((async (cmd: any, args?: readonly string[]) => {
        if (cmd === 'git' && args?.[0] === 'rev-parse' && args?.[1] === '--git-path') {
          return { stdout: '.git/index' };
        }
        if (cmd === 'git' && args?.[0] === 'status') {
          const file = args[args.length - 1];
          if (file === 'del1.ts') return { stdout: ' D del1.ts' };
          if (file === 'del2.ts') return { stdout: ' D del2.ts' };
          return { stdout: '' };
        }
        if (cmd === 'git' && args?.[0] === 'checkout') {
          const file = args[args.length - 1];
          if (file === 'del2.ts') {
            throw new Error('Checkout failed on del2.ts');
          }
          return { stdout: '' };
        }
        return { stdout: '' };
      }) as any);

      // Unlinking del1.ts during rollback fails with EACCES
      vi.mocked(fs.unlink).mockImplementation((async (p: any) => {
        if (String(p).includes('del1.ts')) {
          const err = new Error('EACCES: permission denied, unlink');
          (err as any).code = 'EACCES';
          throw err;
        }
        return undefined;
      }) as any);

      const res = await app.request('/api/workspace/test-ws/changes/revert', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: ['del1.ts', 'del2.ts'] }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain('Checkout failed on del2.ts');
      expect(data.error).toContain('Warning: Rollback could not fully restore state');
      expect(data.error).toContain('Failed to remove checked-out file del1.ts');
      expect(data.error).not.toContain('Any modified files were rolled back.');
    });

    it('accurately reports failure when mode restoration via chmod fails during rollback', async () => {
      vi.mocked(config.loadConfig).mockResolvedValue({ workspacesDir: '/mock/workspaces' } as any);
      vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({
        id: 'test-ws',
        branchName: 'test-ws',
        repos: ['/mock/workspaces/test-ws'],
        assistants: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      } as any);

      vi.mocked(fs.stat).mockResolvedValue({ mode: 0o755 } as any);
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('file-bytes'));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.chmod).mockRejectedValue(new Error('EPERM: operation not permitted, chmod'));

      vi.mocked(execa).mockImplementation((async (cmd: any, args?: readonly string[]) => {
        if (cmd === 'git' && args?.[0] === 'rev-parse' && args?.[1] === '--git-path') {
          return { stdout: '.git/index' };
        }
        if (cmd === 'git' && args?.[0] === 'status') {
          return { stdout: ` M ${args[args.length - 1]}` };
        }
        if (cmd === 'git' && args?.[0] === 'checkout') {
          const file = args[args.length - 1];
          if (file === 'file2.ts') {
            throw new Error('Lock contention on file2.ts');
          }
          return { stdout: '' };
        }
        return { stdout: '' };
      }) as any);

      const res = await app.request('/api/workspace/test-ws/changes/revert', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: ['file1.ts', 'file2.ts'] }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain('Lock contention on file2.ts');
      expect(data.error).toContain('Warning: Rollback could not fully restore state');
      expect(data.error).toContain('Failed to restore mode on file1.ts');
      expect(data.error).not.toContain('Any modified files were rolled back.');
    });
  });
});

describe('pages outside the app', () => {
  it('lead back to the app instead of a bare 404 when a document link leaves it', async () => {
    const page = await app.request('/home/me/workspaces/audit/assessment/screenshots/01.jpeg', { headers: { accept: 'text/html,application/xhtml+xml' } });
    expect(page.status).toBe(404);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('href="/"');
    // The requested path is never reflected into the page.
    expect(html).not.toContain('01.jpeg');
  });

  it('keeps plain 404s for API and asset requests', async () => {
    const api = await app.request('/api/not-a-route', { headers: { accept: 'text/html' } });
    expect(api.status).toBe(404);
    expect(await api.text()).not.toContain('href="/"');
    const asset = await app.request('/assets/missing.js', { headers: { accept: '*/*' } });
    expect(asset.status).toBe(404);
    expect(asset.headers.get('content-type') ?? '').not.toContain('text/html');
  });
});
