import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveLaunch, terminalEnvironment, withWorkspaceCli } from './targets.js';

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
