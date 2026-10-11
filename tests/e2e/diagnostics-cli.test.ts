import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { fork } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;
const cli = path.resolve('dist/index.js');
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-diagnostics-cli-'))); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const run = (...args: string[]) => execa(process.execPath, [cli, ...args], {
  cwd: root, reject: false, env: { CONTEXTSPACE_HOME: path.join(root, 'profile'), NEXUSFLOW_HOME: path.join(root, 'profile') },
});

// Each test starts the built CLI several times in a row (a real TTY via
// `script` in one of them). A cold start takes seconds on a loaded machine, so
// the default 30 s per test is too tight; correctness, not speed, is tested here.
const BUILT_CLI_TIMEOUT_MS = 120_000;

describe('built diagnostics CLI', { timeout: BUILT_CLI_TIMEOUT_MS }, () => {
  it('leaves complete sanitized staging bytes and preserves the destination when interrupted before publication', async () => {
    const destination = path.join(root, 'existing.json');
    await fs.writeFile(destination, 'previous output');
    const child = fork(path.resolve('tests/e2e/fixtures/interrupted-diagnostic.mjs'), [destination], {
      execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, CONTEXTSPACE_HOME: path.join(root, 'profile'), NEXUSFLOW_HOME: path.join(root, 'profile') },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Writer did not reach publication')), 10_000);
        child.once('message', () => { clearTimeout(timer); resolve(); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Writer exited before publication')); });
      });
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill('SIGKILL');
        await exited;
      }
    }
    expect(await fs.readFile(destination, 'utf8')).toBe('previous output');
    const staged = (await fs.readdir(root)).filter(name => name.endsWith('.tmp'));
    expect(staged).toHaveLength(1);
    const report = JSON.parse(await fs.readFile(path.join(root, staged[0]!), 'utf8'));
    expect(report.purpose).toBe('support-status-only');
    expect(Object.keys(report.sections)).toEqual(['runtime']);
    expect(JSON.stringify(report)).not.toContain(root);
  });

  it.runIf(process.platform === 'linux')('keeps data commands offline in a real TTY while ordinary cold/warm update checks retain their documented behavior', async () => {
    const probe = path.join(root, 'probe.mjs');
    const log = path.join(root, 'requests.jsonl');
    await fs.writeFile(log, '', { flag: 'wx' });
    await fs.writeFile(probe, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, options) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: String(url), headers: options?.headers, body: options?.body ?? null }) + '\\n');
  return new Response(JSON.stringify({ tag_name: 'v2.23.0', body: '', assets: [] }), { status: 200 });
};`);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const tty = (...args: string[]) => execa('script', ['-qec', [process.execPath, '--import', probe, cli, ...args].map(quote).join(' '), '/dev/null'], {
      cwd: root, reject: false, env: { CONTEXTSPACE_HOME: path.join(root, 'profile'), NEXUSFLOW_HOME: path.join(root, 'profile') },
    });
    expect((await tty('data')).exitCode).toBe(0);
    expect((await tty('diagnostics', 'preview')).exitCode).toBe(0);
    expect(await fs.readFile(log, 'utf8')).toBe('');
    expect((await tty('config', 'get', 'scanDepth')).exitCode).toBe(0);
    const requests = (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests).toEqual([{ url: 'https://api.github.com/repos/antan87/Context-Space/releases/latest', headers: { 'User-Agent': 'ContextSpace-Updater' }, body: null }]);
    expect((await tty('config', 'get', 'scanDepth')).exitCode).toBe(0);
    expect((await fs.readFile(log, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('offers parseable previews and exact captured exports with a nonzero stale-review failure', async () => {
    const preview = await run('diagnostics', 'preview', '--candidate', 'candidate.json');
    expect(preview.exitCode).toBe(0);
    const captured = JSON.parse(preview.stdout);
    expect(captured.report.sections.runtime).toBeDefined();
    expect(await fs.readFile(path.join(root, 'candidate.json'), 'utf8')).toBe(captured.content);
    const stale = await run('diagnostics', 'export', 'candidate.json', '--digest', 'bad', '--output', 'bad.json');
    expect(stale.exitCode).not.toBe(0);
    await expect(fs.access(path.join(root, 'bad.json'))).rejects.toThrow();
    const saved = await run('diagnostics', 'export', 'candidate.json', '--digest', captured.digest, '--output', 'report.json');
    expect(saved.exitCode).toBe(0);
    expect(JSON.parse(saved.stdout).saved).toBe(true);
    expect(await fs.readFile(path.join(root, 'report.json'), 'utf8')).toBe(captured.content);
    expect((await run('diagnostics', 'export', 'candidate.json', '--digest', captured.digest, '--output', 'report.json')).exitCode).not.toBe(0);
    expect(await fs.readFile(path.join(root, 'report.json'), 'utf8')).toBe(captured.content);
  });

  it('omits selected sections and leaves a first-run profile untouched', async () => {
    const result = await run('diagnostics', 'preview', '--omit', 'runtime');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).report.sections).toEqual({});
    await expect(fs.access(path.join(root, 'profile'))).rejects.toThrow();
    const guide = await run('data', '--json');
    expect(guide.exitCode).toBe(0);
    expect(JSON.parse(guide.stdout).locations.profile).toBe(path.join(root, 'profile'));
    expect((await run('diagnostics', '--help')).stdout).toContain('preview');
    expect((await run('diagnostics', 'export', '--help')).stdout).toContain('--digest');
  });

  it('does not echo private candidate contents or paths on validation errors', async () => {
    const canary = 'PRIVATE_CREDENTIAL_IN_INVALID_FILE';
    await fs.writeFile(path.join(root, 'bad.json'), canary);
    const result = await run('diagnostics', 'export', 'bad.json', '--digest', canary, '--output', 'output');
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(canary);
    expect(result.stdout + result.stderr).not.toContain(root);
  });
});
