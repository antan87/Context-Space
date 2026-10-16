import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { ensureLastingRuntime, installedLastingRuntime, isTemporaryRuntimePath, lastingLauncherPath, lastingRuntimeRoot } from './lasting-runtime.js';
import { runtimeVersion } from './workspace-tools.js';
import { BRAND_CONFIG } from './constants.js';

let base: string;
let home: string;
let appImage: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'lasting-runtime-'));
  home = path.join(base, 'home');
  appImage = path.join(base, 'ContextSpace.AppImage');
  await fs.mkdir(home);
  await fs.writeFile(appImage, 'appimage');
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

/** An unpacked AppImage: the Electron binary and libraries, the full backend, and the large things the copy leaves out. */
async function unpack(version: string, name = 'appimage_extracted_0123456789abcdef') {
  const appDir = path.join(base, name);
  const backend = path.join(appDir, 'resources/backend');
  const put = async (relative: string, content = 'x') => {
    await fs.mkdir(path.dirname(path.join(appDir, relative)), { recursive: true });
    await fs.writeFile(path.join(appDir, relative), content);
  };
  await put('contextspace-desktop', '#!/bin/sh\necho "node=$ELECTRON_RUN_AS_NODE $*"\n');
  await put('libffmpeg.so');
  await put('libvulkan.so.1');
  await put('icudtl.dat');
  await put('v8_context_snapshot.bin');
  await put('locales/en-US.pak');
  await put('chrome-sandbox');
  await put('resources/backend/package.json', JSON.stringify({ name: BRAND_CONFIG.mcp.packageName, version }));
  await put('resources/backend/dist/index.js');
  await put('resources/backend/node_modules/zod/index.js');
  await put('resources/backend/node_modules/@openai/codex-sdk/index.js');
  await put('resources/backend/node_modules/@openai/codex-linux-x64/codex');
  await put('resources/backend/node_modules/@anthropic-ai/claude-agent-sdk/index.js');
  await put('resources/backend/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude');
  await put('resources/backend/node_modules/node-pty/build/pty.node');
  return { appDir, source: { command: path.join(appDir, 'contextspace-desktop'), entry: path.join(backend, 'dist/index.js'), electron: true } };
}
const options = (appDir: string, source: { command: string; entry: string; electron: boolean }, version = '2.42.0') => ({
  source, version, home, platform: 'linux' as const, env: { APPIMAGE: appImage, APPDIR: appDir },
});
/** The lasting copy is Linux-only (it needs symlinks and a unix launcher), so its file tests do not run on Windows. */
const linuxOnly = it.skipIf(process.platform === 'win32');
const exists = (target: string) => fs.access(target).then(() => true, () => false);

linuxOnly('copies the runtime and backend to a lasting place, leaving out the native agent binaries', async () => {
  const { appDir, source } = await unpack('2.42.0');
  const runtime = await ensureLastingRuntime(options(appDir, source));
  const root = lastingRuntimeRoot({}, home);
  expect(runtime).toEqual(installedLastingRuntime({}, home));
  expect(runtime!.command).toBe(path.join(root, 'current/runtime/contextspace-desktop'));
  expect(isTemporaryRuntimePath(runtime!.entry)).toBe(false);
  expect(await fs.readlink(path.join(root, 'current'))).toBe('2.42.0');
  expect(await runtimeVersion(runtime!.entry)).toBe('2.42.0');
  for (const kept of ['runtime/contextspace-desktop', 'runtime/libffmpeg.so', 'runtime/libvulkan.so.1', 'runtime/icudtl.dat', 'runtime/v8_context_snapshot.bin',
    'backend/package.json', 'backend/dist/index.js', 'backend/node_modules/zod/index.js', 'backend/node_modules/@openai/codex-sdk/index.js', 'backend/node_modules/@anthropic-ai/claude-agent-sdk/index.js']) {
    expect(await exists(path.join(root, 'current', kept)), kept).toBe(true);
  }
  for (const left of ['runtime/locales', 'runtime/chrome-sandbox', 'backend/node_modules/@openai/codex-linux-x64', 'backend/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64', 'backend/node_modules/node-pty']) {
    expect(await exists(path.join(root, 'current', left)), left).toBe(false);
  }
  expect((await fs.stat(runtime!.command)).mode & 0o111).not.toBe(0);
});

linuxOnly('does nothing outside a Linux AppImage', async () => {
  const { appDir, source } = await unpack('2.42.0');
  const base = options(appDir, source);
  expect(await ensureLastingRuntime({ ...base, platform: 'win32' })).toBeNull();
  expect(await ensureLastingRuntime({ ...base, platform: 'darwin' })).toBeNull();
  expect(await ensureLastingRuntime({ ...base, env: { APPDIR: appDir } })).toBeNull();
  expect(await ensureLastingRuntime({ ...base, env: { APPIMAGE: appImage, APPDIR: path.join(appDir, 'elsewhere') } })).toBeNull();
  expect(await exists(lastingRuntimeRoot({}, home))).toBe(false);
});

linuxOnly('leaves a finished copy alone, and replaces it when the AppImage changes', async () => {
  const { appDir, source } = await unpack('2.42.0');
  const runtime = (await ensureLastingRuntime(options(appDir, source)))!;
  await fs.writeFile(path.join(path.dirname(runtime.entry), 'marker.txt'), 'kept');
  await ensureLastingRuntime(options(appDir, source));
  expect(await exists(path.join(path.dirname(runtime.entry), 'marker.txt'))).toBe(true);
  await fs.writeFile(appImage, 'a rebuilt appimage of a different size');
  await ensureLastingRuntime(options(appDir, source));
  expect(await exists(path.join(path.dirname(runtime.entry), 'marker.txt'))).toBe(false);
  expect(await exists(runtime.entry)).toBe(true);
});

linuxOnly('moves current up with the app, keeps the previous version, and removes older ones', async () => {
  const root = lastingRuntimeRoot({}, home);
  for (const version of ['2.40.0', '2.41.0', '2.42.0']) {
    const { appDir, source } = await unpack(version, `appimage_extracted_${version.replaceAll('.', '')}abc`);
    await ensureLastingRuntime(options(appDir, source, version));
  }
  expect(await fs.readlink(path.join(root, 'current'))).toBe('2.42.0');
  expect((await fs.readdir(root)).filter((name) => /^\d/.test(name)).sort()).toEqual(['2.41.0', '2.42.0']);
});

linuxOnly('never points current at an older version than it already does', async () => {
  const root = lastingRuntimeRoot({}, home);
  const newer = await unpack('2.43.0', 'appimage_extracted_aaaaaa');
  await ensureLastingRuntime(options(newer.appDir, newer.source, '2.43.0'));
  const older = await unpack('2.42.0', 'appimage_extracted_bbbbbb');
  const runtime = await ensureLastingRuntime(options(older.appDir, older.source, '2.42.0'));
  expect(await fs.readlink(path.join(root, 'current'))).toBe('2.43.0');
  expect(await runtimeVersion(runtime!.entry)).toBe('2.43.0');
});

linuxOnly('leaves no partial copy and keeps current when copying fails', async () => {
  const good = await unpack('2.41.0', 'appimage_extracted_cccccc');
  await ensureLastingRuntime(options(good.appDir, good.source, '2.41.0'));
  const root = lastingRuntimeRoot({}, home);
  const broken = await unpack('2.42.0', 'appimage_extracted_dddddd');
  await fs.rm(path.join(broken.appDir, 'resources/backend/dist'), { recursive: true });
  await fs.rm(broken.source.command);
  await expect(ensureLastingRuntime(options(broken.appDir, broken.source, '2.42.0'))).rejects.toThrow();
  expect(await fs.readlink(path.join(root, 'current'))).toBe('2.41.0');
  expect((await fs.readdir(root)).sort()).toEqual(['2.41.0', 'bin', 'current']); // no staging leftovers
});

it('recognises the AppImage unpack and mount folders as temporary', () => {
  expect(isTemporaryRuntimePath('/tmp/appimage_extracted_3a529ebf28f2e04ce3b0c34b5dce6fce/resources/backend/dist/index.js')).toBe(true);
  expect(isTemporaryRuntimePath('/tmp/.mount_ContextAbc123/resources/backend/dist/index.js')).toBe(true);
  expect(isTemporaryRuntimePath('/home/u/.local/share/contextspace/cli/current/backend/dist/index.js')).toBe(false);
  expect(isTemporaryRuntimePath('/opt/ContextSpace/resources/backend/dist/index.js')).toBe(false);
});

linuxOnly('writes a launcher that follows current, so agents registered with it follow app updates', async () => {
  const { appDir, source } = await unpack('2.42.0', 'appimage_extracted_eeeeee');
  const runtime = (await ensureLastingRuntime(options(appDir, source)))!;
  const launcher = lastingLauncherPath({}, home);
  expect((await fs.stat(launcher)).mode & 0o111).not.toBe(0);
  const run = await execa(launcher, ['mcp', 'run', '--role', 'interactive']);
  expect(run.stdout).toBe(`node=1 ${runtime.entry} mcp run --role interactive`);
  // The next version moves current; the same launcher then runs it.
  const next = await unpack('2.43.0', 'appimage_extracted_ffffff');
  const moved = (await ensureLastingRuntime(options(next.appDir, next.source, '2.43.0')))!;
  expect(moved.entry).toBe(runtime.entry);
  expect(await fs.readlink(path.join(lastingRuntimeRoot({}, home), 'current'))).toBe('2.43.0');
  expect((await execa(launcher, ['--version'])).stdout).toContain(path.join(lastingRuntimeRoot({}, home), 'current/backend/dist/index.js'));
});
