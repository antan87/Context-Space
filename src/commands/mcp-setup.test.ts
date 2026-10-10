import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMcpResult } from '../core/agent-mcp.js';
import { registerAgentMcp } from '../core/agent-mcp.js';
import { mcpSetupCommand, windowsVerificationHint } from './mcp.js';

vi.mock('../core/agent-mcp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/agent-mcp.js')>()),
  registerAgentMcp: vi.fn(),
}));

let home: string;
let realHome: { HOME?: string; USERPROFILE?: string };
let output: string;

const agent = (id: AgentMcpResult['id'], outcome: AgentMcpResult['outcome']): AgentMcpResult => ({ id, name: id, outcome });
const register = vi.mocked(registerAgentMcp);

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-mcp-setup-'));
  realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  // os.homedir() follows HOME on POSIX and USERPROFILE on Windows.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.exitCode = undefined;
  output = '';
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { output += stripVTControlCharacters(parts.join(' ')) + '\n'; });
  register.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const key of ['HOME', 'USERPROFILE'] as const) {
    if (realHome[key] === undefined) delete process.env[key]; else process.env[key] = realHome[key];
  }
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('mcp setup output', () => {
  it('says what was configured, and to restart agents', async () => {
    register.mockResolvedValue([agent('claude', { result: 'added', how: 'claude mcp add' }), agent('codex', { result: 'not-installed' })]);
    await mcpSetupCommand();
    expect(output).toContain('Configured 1 AI environment.');
    expect(output).toContain('Restart running agent sessions');
    expect(process.exitCode).toBeUndefined();
  });

  it('discloses the role it grants and how to avoid it', async () => {
    register.mockResolvedValue([agent('claude', { result: 'already', serverName: 'contextspace-mcp' })]);
    await mcpSetupCommand();
    expect(output).toContain('"interactive" role');
    expect(output).toContain('--no-agents');
  });

  it('counts editors and agents together', async () => {
    await fs.mkdir(path.join(home, '.cursor'), { recursive: true });
    register.mockResolvedValue([agent('claude', { result: 'added', how: 'claude mcp add' }), agent('codex', { result: 'added', how: 'codex mcp add' })]);
    await mcpSetupCommand();
    expect(output).toContain('Configured 3 AI environments.');
    expect(JSON.parse(await fs.readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers).toHaveProperty('contextspace-mcp');
  });

  describe('editor configs', () => {
    const entry = { command: 'npx', args: ['-y', '@mrpatronz/nexusflow@latest', 'mcp', 'run', '--role', 'interactive'] };

    it('leaves a config that already holds this entry as it is, and says nothing needed changing', async () => {
      await fs.mkdir(path.join(home, '.cursor'), { recursive: true });
      const file = path.join(home, '.cursor', 'mcp.json');
      const saved = JSON.stringify({ mcpServers: { 'contextspace-mcp': entry } });
      await fs.writeFile(file, saved, 'utf8');
      register.mockResolvedValue([agent('claude', { result: 'not-installed' })]);

      await mcpSetupCommand();

      // Written compactly above; a rewrite would come back indented, so equal text means untouched.
      expect(await fs.readFile(file, 'utf8')).toBe(saved);
      expect(output).toContain('Already configured');
      expect(output).toContain('Nothing to change');
      expect(output).not.toContain('Could not find');
    });

    it('still replaces a differing entry, as it always has', async () => {
      await fs.mkdir(path.join(home, '.cursor'), { recursive: true });
      const file = path.join(home, '.cursor', 'mcp.json');
      await fs.writeFile(file, JSON.stringify({ mcpServers: { 'contextspace-mcp': { command: 'old' }, other: { command: 'keep' } } }), 'utf8');
      register.mockResolvedValue([]);

      await mcpSetupCommand();

      const written = JSON.parse(await fs.readFile(file, 'utf8')).mcpServers;
      expect(written['contextspace-mcp']).toEqual(entry);
      expect(written.other).toEqual({ command: 'keep' });
      expect(output).toContain('Configured 1 AI environment.');
    });
  });

  it('leaves agents alone with --no-agents', async () => {
    await mcpSetupCommand({ agents: false });
    expect(register).not.toHaveBeenCalled();
    expect(output).toContain('left alone (--no-agents)');
  });

  describe('dry run', () => {
    it('previews agents, writes no editor config, and says editors are not previewed', async () => {
      await fs.mkdir(path.join(home, '.cursor'), { recursive: true });
      register.mockResolvedValue([agent('claude', { result: 'would-add', how: 'claude mcp add' })]);

      await mcpSetupCommand({ dryRun: true });

      expect(register).toHaveBeenCalledWith({ dryRun: true });
      await expect(fs.access(path.join(home, '.cursor', 'mcp.json'))).rejects.toThrow();
      expect(output).toContain('neither changed nor previewed');
      expect(output).toContain('would register');
      expect(output).toContain('Run again without --dry-run');
      expect(output).not.toContain('Configured');
    });

    it('does not suggest applying when there is nothing to apply', async () => {
      register.mockResolvedValue([agent('claude', { result: 'already', serverName: 'contextspace-mcp' })]);
      await mcpSetupCommand({ dryRun: true });
      expect(output).not.toContain('Run again without --dry-run');
    });
  });

  describe('when nothing is added', () => {
    it('reports nothing to change when agents exist but were already set up', async () => {
      register.mockResolvedValue([agent('claude', { result: 'already', serverName: 'contextspace-mcp' })]);
      await mcpSetupCommand();
      expect(output).toContain('Nothing to change');
      expect(output).not.toContain('Could not find');
    });

    it('does not claim to have found no agent when installed agents were skipped', async () => {
      register.mockResolvedValue([
        agent('pi', { result: 'skipped', reason: 'Pi needs the pi-mcp-adapter package' }),
        agent('claude', { result: 'skipped', reason: 'left alone, could not read ~/.claude.json' }),
      ]);
      await mcpSetupCommand();
      expect(output).toContain('Pi needs the pi-mcp-adapter package');
      expect(output).not.toContain('Could not find');
    });

    it('does not print a second, contradictory verdict after a failure, and sets a failing exit code', async () => {
      register.mockResolvedValue([agent('codex', { result: 'failed', reason: 'codex mcp add exited with code 2' })]);
      await mcpSetupCommand();
      expect(output).toContain('failed: codex mcp add exited with code 2');
      expect(output).not.toContain('Could not find');
      expect(output).not.toContain('Nothing to change');
      expect(process.exitCode).toBe(1);
    });

    it('prints the config to add by hand when no agent and no editor config exists', async () => {
      register.mockResolvedValue([agent('claude', { result: 'not-installed' }), agent('pi', { result: 'not-installed' })]);
      await mcpSetupCommand();
      expect(output).toContain('Could not find any AI agent or standard configuration file');
      expect(output).toContain('"contextspace-mcp"');
      expect(output).toContain('"npx"');
    });
  });
});

describe('windowsVerificationHint', () => {
  const added = (id: AgentMcpResult['id']) => agent(id, { result: 'added', how: `${id} mcp add` });

  it('says nothing off Windows, where nothing about the launcher is in doubt', () => {
    expect(windowsVerificationHint([added('claude')], 'linux')).toEqual([]);
    expect(windowsVerificationHint([added('claude')], 'darwin')).toEqual([]);
  });

  it('says nothing on Windows when nothing was registered', () => {
    expect(windowsVerificationHint([agent('claude', { result: 'already', serverName: 'contextspace-mcp' }), agent('codex', { result: 'not-installed' })], 'win32')).toEqual([]);
  });

  it('tells a Windows user how to confirm the server connected, naming the agents that have a list command', () => {
    const lines = windowsVerificationHint([added('claude'), added('codex'), added('antigravity')], 'win32').join('\n');

    expect(lines).toContain('cmd /c npx');
    expect(lines).toContain('`claude mcp list` or `codex mcp list`');
    expect(lines).toContain('get_work_context');
    expect(lines).toContain('ctxspace doctor');
    expect(lines).not.toContain('antigravity mcp list');
  });

  it('still gives the confirmation steps when only an agent without a list command was registered', () => {
    const lines = windowsVerificationHint([added('pi')], 'win32').join('\n');

    expect(lines).toContain('get_work_context');
    expect(lines).not.toContain('mcp list');
  });
});
