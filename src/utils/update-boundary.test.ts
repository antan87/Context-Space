import { afterEach, expect, it, vi } from 'vitest';
import { getToolsStatus } from './update-check.js';
import { GITHUB_RELEASE_API_URL } from '../core/constants.js';

vi.mock('execa', () => ({ execa: vi.fn(async () => ({ exitCode: 0, stdout: '1.0.0' })) }));
vi.mock('../core/config.js', () => ({ loadConfig: vi.fn(async () => ({})), saveConfig: vi.fn(async () => {}) }));
afterEach(() => vi.restoreAllMocks());

it('toolchain checks read ContextSpace from its release and the other tools from the public registry, and cache the result', async () => {
  const requests: { url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    requests.push({ url: String(url), body: options?.body ?? null });
    return new Response(JSON.stringify(String(url) === GITHUB_RELEASE_API_URL ? { tag_name: 'v2.50.0', body: '', assets: [] } : { version: '2.23.0' }), { status: 200 });
  });
  const tools = await getToolsStatus(true);
  expect(requests.map((request) => request.url).sort()).toEqual([GITHUB_RELEASE_API_URL, 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest'].sort());
  expect(requests.every((request) => request.body === null)).toBe(true);
  // The npm package stopped at 2.39 and is deprecated: it is never asked.
  expect(requests.some((request) => request.url.includes('@mrpatronz/nexusflow'))).toBe(false);
  const engine = tools.find((tool) => tool.command === 'ctxspace')!;
  expect(engine.latestVersion).toBe('2.50.0');
  expect(engine.updateCmd).not.toContain('npm');
  await getToolsStatus();
  expect(requests).toHaveLength(2);
});
