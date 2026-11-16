import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual hook without loading Playwright or launching/killing apps.
const source = readFileSync(new URL('../desktop/e2e/app.spec.js', import.meta.url), 'utf8');
const hook = source.match(/test\.afterAll\(async \(\) => \{([\s\S]*?)\n  \}\);/);
if (!hook) throw new Error('Desktop afterAll hook was not found');
const teardown = new Script(`(async () => {${hook[1]}\n})()`);

describe('desktop E2E Windows teardown', () => {
  it.each(['result', 'throw'])('bounds taskkill after a hanging close and swallows a timeout (%s)', async (failure) => {
    const close = vi.fn(() => new Promise<void>(() => {}));
    const timeoutError = Object.assign(new Error('taskkill timed out'), { code: 'ETIMEDOUT' });
    const spawnSync = vi.fn(() => {
      if (failure === 'throw') throw timeoutError;
      return { error: timeoutError, status: null };
    });
    let deadline: (() => void) | undefined;
    const setTimeout = vi.fn((resolve: () => void) => { deadline = resolve; });
    const finished = teardown.runInNewContext({
      app: { process: () => ({ pid: 12345 }), close },
      process: { platform: 'win32' },
      spawnSync,
      setTimeout,
    }) as Promise<void>;

    expect(close).toHaveBeenCalledOnce();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 8_000);
    deadline!();
    await expect(finished).resolves.toBeUndefined();
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith(
      'taskkill', ['/pid', '12345', '/T', '/F'],
      expect.objectContaining({ stdio: 'ignore', timeout: 5_000, killSignal: 'SIGKILL' }),
    );
  });
});
