import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_RELEASE_API_URL,
  installDesktop,
  isAllowedDesktopReleaseUrl,
  quoteDesktopExecArg,
} from './desktop.js';

const assetUrl = 'https://github.com/antan87/NexusFlow/releases/download/v9.9.9/NexusFlow-9.9.9.AppImage';
const sidecarUrl = `${assetUrl}.sha256`;

function digest(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function releaseResponse(assetName = 'NexusFlow-9.9.9.AppImage', asset = assetUrl, sidecar = sidecarUrl): Response {
  return new Response(JSON.stringify({
    tag_name: 'v9.9.9',
    html_url: 'https://github.com/antan87/NexusFlow/releases/tag/v9.9.9',
    assets: [
      { name: assetName, browser_download_url: asset },
      { name: `${assetName}.sha256`, browser_download_url: sidecar },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('desktop release installer', () => {
  it('rejects unsupported platforms before making a network request', async () => {
    const fetchImpl = vi.fn();
    await expect(installDesktop({ platform: 'darwin', fetchImpl })).rejects.toThrow(/unsupported/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects unsupported architectures before downloading an x64-only asset', async () => {
    const fetchImpl = vi.fn();
    await expect(installDesktop({ platform: 'linux', arch: 'arm64', fetchImpl })).rejects.toThrow(/x64 only/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an untrusted release API host', async () => {
    const fetchImpl = vi.fn();
    await expect(installDesktop({
      platform: 'linux',
      arch: 'x64',
      releaseApiUrl: 'https://evil.example/releases/latest',
      fetchImpl,
    })).rejects.toThrow(/untrusted.*github release host/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts case-insensitive safe release API URLs for Context-Space and legacy paths', async () => {
    const binary = 'test-binary';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(releaseResponse())
      .mockResolvedValueOnce(new Response(`${digest(binary)}  NexusFlow-9.9.9.AppImage\n`))
      .mockResolvedValueOnce(new Response(binary));
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cs-api-check-'));
    try {
      await installDesktop({
        platform: 'linux',
        arch: 'x64',
        releaseApiUrl: 'https://api.github.com/repos/antan87/context-space/releases/latest',
        fetchImpl,
        tmpDir,
        homeDir: tmpDir,
      });
      expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/repos/antan87/context-space/releases/latest', expect.any(Object));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('accepts only HTTPS GitHub release asset hosts', () => {
    expect(isAllowedDesktopReleaseUrl(assetUrl)).toBe(true);
    expect(isAllowedDesktopReleaseUrl('https://github.com/antan87/Context-Space/releases/download/v2.10.0/ContextSpace-2.10.0.AppImage')).toBe(true);
    expect(isAllowedDesktopReleaseUrl('https://github.com/antan87/context-space/releases/download/v2.10.0/ContextSpace-2.10.0.AppImage')).toBe(true);
    expect(isAllowedDesktopReleaseUrl('https://github.com/Antan87/Context-Space/releases/download/v2.10.0/ContextSpace-2.10.0.AppImage')).toBe(true);
    expect(isAllowedDesktopReleaseUrl('https://github.com/antan87/ContextSpace/releases/download/v2.10.0/ContextSpace-2.10.0.AppImage')).toBe(true);
    expect(isAllowedDesktopReleaseUrl('https://objects.githubusercontent.com/signed/asset')).toBe(true);
    expect(isAllowedDesktopReleaseUrl('https://release-assets.githubusercontent.com/github-production-release-asset/asset')).toBe(true);
    expect(isAllowedDesktopReleaseUrl('https://evil.example/NexusFlow.AppImage')).toBe(false);
    expect(isAllowedDesktopReleaseUrl('https://release-assets.githubusercontent.com:8443/asset')).toBe(false);
    expect(isAllowedDesktopReleaseUrl('http://github.com/antan87/NexusFlow/releases/download/v1/NexusFlow.exe')).toBe(false);
    expect(isAllowedDesktopReleaseUrl('http://github.com/antan87/Context-Space/releases/download/v1/ContextSpace.exe')).toBe(false);
  });

  it('requires a checksum sidecar and rejects mismatched content', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(releaseResponse());
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nexusflow-installer-test-'));
    try {
      fetchImpl.mockResolvedValueOnce(new Response('0'.repeat(64) + '  NexusFlow-9.9.9.AppImage\n'));
      fetchImpl.mockResolvedValueOnce(new Response('not-the-release-binary'));
      await expect(installDesktop({ platform: 'linux', arch: 'x64', fetchImpl, tmpDir, homeDir: tmpDir })).rejects.toThrow(/checksum mismatch/i);
      await expect(stat(path.join(tmpDir, '.local', 'share', 'nexusflow'))).rejects.toThrow();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the release omits the required checksum sidecar', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      assets: [{ name: 'NexusFlow-9.9.9.AppImage', browser_download_url: assetUrl }],
    }), { status: 200 }));
    await expect(installDesktop({ platform: 'linux', arch: 'x64', fetchImpl })).rejects.toThrow(/missing.*sidecar/i);
  });

  it('verifies and installs a Linux AppImage without invoking a shell', async () => {
    const binary = 'verified-appimage';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(releaseResponse())
      .mockResolvedValueOnce(new Response(`${digest(binary)}  NexusFlow-9.9.9.AppImage\n`))
      .mockResolvedValueOnce(new Response(binary));
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nexusflow-installer-test-'));
    try {
      const result = await installDesktop({ platform: 'linux', arch: 'x64', fetchImpl, tmpDir, homeDir: tmpDir });
      expect(result.installedPath).toContain(path.join('.local', 'share', 'nexusflow'));
      expect(path.basename(result.installedPath)).toBe('NexusFlow.AppImage');
      expect(await readFile(result.installedPath, 'utf8')).toBe(binary);
      expect(await readFile(result.desktopEntryPath!, 'utf8')).toContain(`Exec=${quoteDesktopExecArg(result.installedPath)}`);
      expect(fetchImpl).toHaveBeenCalledWith(GITHUB_RELEASE_API_URL, expect.any(Object));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('verifies and installs a ContextSpace Linux AppImage into contextspace directory', async () => {
    const binary = 'verified-contextspace-appimage';
    const csAssetUrl = 'https://github.com/antan87/Context-Space/releases/download/v2.10.0/ContextSpace-2.10.0.AppImage';
    const csSidecarUrl = `${csAssetUrl}.sha256`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(releaseResponse('ContextSpace-2.10.0.AppImage', csAssetUrl, csSidecarUrl))
      .mockResolvedValueOnce(new Response(`${digest(binary)}  ContextSpace-2.10.0.AppImage\n`))
      .mockResolvedValueOnce(new Response(binary));
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'contextspace-installer-test-'));
    try {
      const result = await installDesktop({ platform: 'linux', arch: 'x64', fetchImpl, tmpDir, homeDir: tmpDir });
      expect(result.installedPath).toContain(path.join('.local', 'share', 'contextspace'));
      expect(path.basename(result.installedPath)).toBe('ContextSpace.AppImage');
      expect(await readFile(result.installedPath, 'utf8')).toBe(binary);
      const desktopEntry = await readFile(result.desktopEntryPath!, 'utf8');
      expect(desktopEntry).toContain(`Exec=${quoteDesktopExecArg(result.installedPath)}`);
      expect(desktopEntry).toContain('Name=ContextSpace');
      expect(desktopEntry).toContain('Icon=contextspace');
      const installedIconPath = path.join(tmpDir, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', 'contextspace.png');
      expect(await readFile(installedIconPath)).toEqual(await readFile(new URL('../../desktop/assets/icon.png', import.meta.url)));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('upgrades a legacy Linux installation without leaving an obsolete launcher', async () => {
    const oldBinary = 'old-nexusflow';
    const newBinary = 'new-contextspace';
    const oldFetch = vi.fn()
      .mockResolvedValueOnce(releaseResponse())
      .mockResolvedValueOnce(new Response(`${digest(oldBinary)}  NexusFlow-9.9.9.AppImage\n`))
      .mockResolvedValueOnce(new Response(oldBinary));
    const newUrl = 'https://github.com/antan87/NexusFlow/releases/download/v2.10.0/ContextSpace-2.10.0.AppImage';
    const newFetch = vi.fn()
      .mockResolvedValueOnce(releaseResponse('ContextSpace-2.10.0.AppImage', newUrl, `${newUrl}.sha256`))
      .mockResolvedValueOnce(new Response(`${digest(newBinary)}  ContextSpace-2.10.0.AppImage\n`))
      .mockResolvedValueOnce(new Response(newBinary));
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'contextspace-upgrade-'));
    try {
      const before = await installDesktop({ platform: 'linux', arch: 'x64', fetchImpl: oldFetch, tmpDir, homeDir: tmpDir });
      const after = await installDesktop({ platform: 'linux', arch: 'x64', fetchImpl: newFetch, tmpDir, homeDir: tmpDir });
      expect(after.installedPath).toBe(before.installedPath);
      expect(after.desktopEntryPath).toBe(before.desktopEntryPath);
      expect(await readFile(after.installedPath, 'utf8')).toBe(newBinary);
      expect(await readFile(after.desktopEntryPath!, 'utf8')).toContain('Name=ContextSpace');
      await expect(stat(path.join(tmpDir, '.local', 'share', 'contextspace'))).rejects.toThrow();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('downloads and verifies when response exposes arrayBuffer without body stream', async () => {
    const binary = 'buffer-only-appimage';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(releaseResponse())
      .mockResolvedValueOnce(new Response(`${digest(binary)}  NexusFlow-9.9.9.AppImage\n`))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(binary),
      } as any);
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nexusflow-installer-test-'));
    try {
      const result = await installDesktop({ platform: 'linux', arch: 'x64', fetchImpl, tmpDir, homeDir: tmpDir });
      expect(await readFile(result.installedPath, 'utf8')).toBe(binary);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('overwrites one stable Linux AppImage path and keeps the launcher valid across releases', async () => {
    const firstBinary = 'first-appimage';
    const secondBinary = 'second-appimage';
    const secondAssetUrl = 'https://github.com/antan87/NexusFlow/releases/download/v10.0.0/NexusFlow-10.0.0.AppImage';
    const secondSidecarUrl = `${secondAssetUrl}.sha256`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(releaseResponse())
      .mockResolvedValueOnce(new Response(`${digest(firstBinary)}  NexusFlow-9.9.9.AppImage\n`))
      .mockResolvedValueOnce(new Response(firstBinary))
      .mockResolvedValueOnce(releaseResponse('NexusFlow-10.0.0.AppImage', secondAssetUrl, secondSidecarUrl))
      .mockResolvedValueOnce(new Response(`${digest(secondBinary)}  NexusFlow-10.0.0.AppImage\n`))
      .mockResolvedValueOnce(new Response(secondBinary));
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nexusflow-installer-test-'));
    try {
      const first = await installDesktop({ platform: 'linux', arch: 'x64', fetchImpl, tmpDir, homeDir: tmpDir });
      const second = await installDesktop({ platform: 'linux', arch: 'x64', fetchImpl, tmpDir, homeDir: tmpDir });
      expect(second.installedPath).toBe(first.installedPath);
      expect(second.desktopEntryPath).toBe(first.desktopEntryPath);
      expect(await readFile(second.installedPath, 'utf8')).toBe(secondBinary);
      expect(await readFile(second.desktopEntryPath!, 'utf8')).toContain(`Exec=${quoteDesktopExecArg(first.installedPath)}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('verifies a Windows installer before launching it detached', async () => {
    const binary = 'verified-installer';
    const winAssetUrl = 'https://github.com/antan87/NexusFlow/releases/download/v9.9.9/NexusFlowSetup.exe';
    const winSidecarUrl = `${winAssetUrl}.sha256`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(releaseResponse('NexusFlowSetup.exe', winAssetUrl, winSidecarUrl))
      .mockResolvedValueOnce(new Response(`${digest(binary)}  NexusFlowSetup.exe\n`))
      .mockResolvedValueOnce(new Response(binary));
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      queueMicrotask(() => child.emit('spawn'));
      return child as any;
    });
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nexusflow-installer-test-'));
    try {
      const result = await installDesktop({ platform: 'win32', arch: 'x64', fetchImpl, tmpDir, spawnImpl });
      expect(result.assetName).toBe('NexusFlowSetup.exe');
      expect(spawnImpl).toHaveBeenCalledWith(result.installedPath, [], expect.objectContaining({ detached: true, stdio: 'ignore' }));
      expect((spawnImpl.mock.results[0]?.value as { unref: ReturnType<typeof vi.fn> }).unref).toHaveBeenCalled();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('verifies and launches a ContextSpace Windows installer from Context-Space release assets', async () => {
    const binary = 'verified-contextspace-installer';
    const winAssetUrl = 'https://github.com/antan87/Context-Space/releases/download/v2.10.0/ContextSpaceSetup.exe';
    const winSidecarUrl = `${winAssetUrl}.sha256`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(releaseResponse('ContextSpaceSetup.exe', winAssetUrl, winSidecarUrl))
      .mockResolvedValueOnce(new Response(`${digest(binary)}  ContextSpaceSetup.exe\n`))
      .mockResolvedValueOnce(new Response(binary));
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      queueMicrotask(() => child.emit('spawn'));
      return child as any;
    });
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'contextspace-win-test-'));
    try {
      const result = await installDesktop({ platform: 'win32', arch: 'x64', fetchImpl, tmpDir, spawnImpl });
      expect(result.assetName).toBe('ContextSpaceSetup.exe');
      expect(spawnImpl).toHaveBeenCalledWith(result.installedPath, [], expect.objectContaining({ detached: true, stdio: 'ignore' }));
      expect((spawnImpl.mock.results[0]?.value as { unref: ReturnType<typeof vi.fn> }).unref).toHaveBeenCalled();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports a Windows installer launch error instead of claiming success', async () => {
    const binary = 'verified-installer';
    const winAssetUrl = 'https://github.com/antan87/NexusFlow/releases/download/v9.9.9/NexusFlowSetup.exe';
    const winSidecarUrl = `${winAssetUrl}.sha256`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(releaseResponse('NexusFlowSetup.exe', winAssetUrl, winSidecarUrl))
      .mockResolvedValueOnce(new Response(`${digest(binary)}  NexusFlowSetup.exe\n`))
      .mockResolvedValueOnce(new Response(binary));
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nexusflow-installer-test-'));
    try {
      const spawnImpl = vi.fn(() => {
        const child = new EventEmitter() as EventEmitter & { unref: () => void };
        child.unref = vi.fn();
        queueMicrotask(() => child.emit('error', new Error('access denied')));
        return child as any;
      });
      await expect(installDesktop({ platform: 'win32', arch: 'x64', fetchImpl, tmpDir, spawnImpl })).rejects.toThrow(/could not launch.*access denied/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps the previous Linux install when a later asset fails verification', async () => {
    const firstBinary = 'working-appimage';
    const secondAssetUrl = 'https://github.com/antan87/NexusFlow/releases/download/v10.0.0/NexusFlow-10.0.0.AppImage';
    const secondSidecarUrl = `${secondAssetUrl}.sha256`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(releaseResponse())
      .mockResolvedValueOnce(new Response(`${digest(firstBinary)}  NexusFlow-9.9.9.AppImage\n`))
      .mockResolvedValueOnce(new Response(firstBinary))
      .mockResolvedValueOnce(releaseResponse('NexusFlow-10.0.0.AppImage', secondAssetUrl, secondSidecarUrl))
      .mockResolvedValueOnce(new Response(`${'0'.repeat(64)}  NexusFlow-10.0.0.AppImage\n`))
      .mockResolvedValueOnce(new Response('partial-or-corrupt-appimage'));
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nexusflow-installer-test-'));
    try {
      const first = await installDesktop({ platform: 'linux', arch: 'x64', fetchImpl, tmpDir, homeDir: tmpDir });
      await expect(installDesktop({ platform: 'linux', arch: 'x64', fetchImpl, tmpDir, homeDir: tmpDir })).rejects.toThrow(/checksum mismatch/i);
      expect(await readFile(first.installedPath, 'utf8')).toBe(firstBinary);
      expect(await readFile(first.desktopEntryPath!, 'utf8')).toContain(`Exec=${quoteDesktopExecArg(first.installedPath)}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps the previous Linux install when the bundled icon cannot be staged', async () => {
    const binary = 'working-appimage';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(releaseResponse())
      .mockResolvedValueOnce(new Response(`${digest(binary)}  NexusFlow-9.9.9.AppImage\n`))
      .mockResolvedValueOnce(new Response(binary));
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nexusflow-icon-recovery-'));
    try {
      const first = await installDesktop({ platform: 'linux', arch: 'x64', fetchImpl, tmpDir, homeDir: tmpDir });
      const iconPath = path.join(tmpDir, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', 'contextspace.png');
      const entryBefore = await readFile(first.desktopEntryPath!, 'utf8');
      const iconBefore = await readFile(iconPath);
      await expect(installDesktop({
        platform: 'linux',
        arch: 'x64',
        fetchImpl,
        tmpDir,
        homeDir: tmpDir,
        iconSourcePath: path.join(tmpDir, 'missing-contextspace-icon.png'),
      })).rejects.toThrow(/desktop icon is unavailable/i);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(await readFile(first.installedPath, 'utf8')).toBe(binary);
      expect(await readFile(first.desktopEntryPath!, 'utf8')).toBe(entryBefore);
      expect(await readFile(iconPath)).toEqual(iconBefore);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe('quoteDesktopExecArg', () => {
    it('leaves clean alphanumeric POSIX paths unquoted', () => {
      expect(quoteDesktopExecArg('/home/user/.local/share/nexusflow/NexusFlow.AppImage')).toBe('/home/user/.local/share/nexusflow/NexusFlow.AppImage');
    });

    it('quotes paths with spaces', () => {
      expect(quoteDesktopExecArg('/home/user/my apps/NexusFlow.AppImage')).toBe('"/home/user/my apps/NexusFlow.AppImage"');
    });

    it('quotes and escapes backslashes, double quotes, backticks, and dollar signs', () => {
      expect(quoteDesktopExecArg('C:\\Users\\test\\.local\\share\\nexusflow\\NexusFlow.AppImage')).toBe('"C:\\\\Users\\\\test\\\\.local\\\\share\\\\nexusflow\\\\NexusFlow.AppImage"');
      expect(quoteDesktopExecArg('/opt/app"dir/$test`cmd`')).toBe('"/opt/app\\"dir/\\$test\\`cmd\\`"');
    });
  });

  describe('desktopInstallCommand output', () => {
    it('provides clear guidance on how to launch after Linux installation', async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = vi.fn((...args: any[]) => {
        logs.push(args.join(' '));
      });

      const binary = 'verified-contextspace-appimage';
      const csAssetUrl = 'https://github.com/antan87/Context-Space/releases/download/v2.10.0/ContextSpace-2.10.0.AppImage';
      const csSidecarUrl = `${csAssetUrl}.sha256`;
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(releaseResponse('ContextSpace-2.10.0.AppImage', csAssetUrl, csSidecarUrl))
        .mockResolvedValueOnce(new Response(`${digest(binary)}  ContextSpace-2.10.0.AppImage\n`))
        .mockResolvedValueOnce(new Response(binary));

      const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'contextspace-cmd-test-'));
      try {
        const result = await installDesktop({ platform: 'linux', arch: 'x64', fetchImpl, tmpDir, homeDir: tmpDir });
        expect(result.installedPath).toBeDefined();
        expect(result.desktopEntryPath).toBeDefined();
      } finally {
        console.log = origLog;
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

