import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveLaunch, terminalEnvironment, withWorkspaceCli } from './targets.js';
import { createSchema } from './routes.js';

describe('interactive terminal targets', () => {
  it('rejects raw commands, unsupported targets and invalid resume IDs', () => {
    expect(() => resolveLaunch('sh -c echo injected')).toThrow('target');
    expect(() => resolveLaunch('shell', 'session')).toThrow('saved');
  });
  it('does not leak Electron-as-Node or injected Node options to the harness', () => {
    const env = terminalEnvironment(); expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.TERM).toBe('xterm-256color'); expect(env.PATH).toBeTruthy();
  });
  it('prefers the workspace ContextSpace CLI when launching its terminal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-terminal-path-'));
    try {
      const bin = path.join(root, '.contextspace', 'bin');
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'ctxspace.cmd' : 'ctxspace'), 'echo test', { mode: 0o755 });
      const launch = resolveLaunch('shell');
      expect(withWorkspaceCli(launch, root).env.PATH?.split(path.delimiter)[0]).toBe(bin);
      expect(withWorkspaceCli(launch, path.join(root, 'missing')).env.PATH).toBe(launch.env.PATH);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === 'win32')('starts a new session with its first message, where the tool can take one', async () => {
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-terminal-prompt-'));
    try {
      for (const name of ['claude', 'agy', 'pi', 'copilot']) await fs.writeFile(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
      const env = { PATH: bin, SHELL: '/bin/sh' };
      const text = 'Work on M2 CSV export endpoint. Read the plan with `ctxspace plan` first.';
      expect(resolveLaunch('claude', undefined, env, 'linux', text).args).toEqual([text]);
      expect(resolveLaunch('antigravity', undefined, env, 'linux', text).args).toEqual(['--prompt-interactive', text]);
      expect(resolveLaunch('pi', undefined, env, 'linux', text).args).toEqual(['--', text]);
      // A tool that cannot take one starts without it; a shell and a resumed conversation never get one.
      expect(resolveLaunch('copilot', undefined, env, 'linux', text).args).toEqual([]);
      expect(resolveLaunch('shell', undefined, env, 'linux', text).args).toEqual(['-l']);
      expect(resolveLaunch('claude', '123e4567-e89b-42d3-a456-426614174000', env, 'linux', text).args).toEqual(['--resume', '123e4567-e89b-42d3-a456-426614174000']);
    } finally { await fs.rm(bin, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === 'win32')('tells an AI tool it is one, and a shell that it is not', async () => {
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-terminal-harness-'));
    try {
      await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
      const env = { PATH: bin, SHELL: '/bin/sh', CTXSPACE_HARNESS: 'codex' };
      expect(resolveLaunch('claude', undefined, env).env.CTXSPACE_HARNESS).toBe('claude');
      expect(resolveLaunch('shell', undefined, env).env.CTXSPACE_HARNESS).toBeUndefined();
      expect(env.CTXSPACE_HARNESS).toBe('codex');
    } finally { await fs.rm(bin, { recursive: true, force: true }); }
  });
});

describe('the first message a new session starts with', () => {
  const launch = { launchId: '123e4567-e89b-42d3-a456-426614174000', target: 'claude' };
  it('is one line of plain text, without control characters or line breaks', () => {
    expect(createSchema.parse({ ...launch, prompt: 'Work on M2\r\nrm -rf ~\u001b[2J now' }).prompt).toBe('Work on M2 rm -rf ~ [2J now');
  });
  it('is refused when empty, too long, or given to a resumed conversation', () => {
    expect(() => createSchema.parse({ ...launch, prompt: '\n\t ' })).toThrow();
    expect(() => createSchema.parse({ ...launch, prompt: 'x'.repeat(1001) })).toThrow();
    expect(() => createSchema.parse({ ...launch, sessionId: launch.launchId, prompt: 'Work on M2' })).toThrow();
  });
});
