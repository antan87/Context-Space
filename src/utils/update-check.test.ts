import { describe, it, expect, vi, afterEach } from 'vitest';

import { isNewerVersion, engineUpdateAdvice, printUpdateBanner } from './update-check.js';
import { GITHUB_RELEASE_PAGE_URL } from '../core/constants.js';

describe('isNewerVersion', () => {
  it('detects higher major/minor/patch', () => {
    expect(isNewerVersion('1.8.0', '2.0.0')).toBe(true);
    expect(isNewerVersion('1.8.0', '1.9.0')).toBe(true);
    expect(isNewerVersion('1.8.0', '1.8.1')).toBe(true);
  });

  it('returns false when equal or older', () => {
    expect(isNewerVersion('1.8.0', '1.8.0')).toBe(false);
    expect(isNewerVersion('1.9.0', '1.8.0')).toBe(false);
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(false);
  });

  it('tolerates a leading v and a prerelease/build suffix instead of returning NaN-false', () => {
    // Previously `.map(Number)` turned '0-rc' into NaN and reported no update.
    expect(isNewerVersion('1.8.0', 'v1.9.0')).toBe(true);
    expect(isNewerVersion('1.8.0', '1.9.0-rc.1')).toBe(true);
    expect(isNewerVersion('1.8.0-beta.2', '1.8.0-beta.3')).toBe(false); // same numeric core
  });

  it('treats a stable release as newer than a prerelease of the same core', () => {
    expect(isNewerVersion('1.8.0-rc.1', '1.8.0')).toBe(true);
    expect(isNewerVersion('1.8.0', '1.8.0-rc.1')).toBe(false);
  });

  it('safely handles empty, 0.0.0, or unknown fallback version strings', () => {
    expect(isNewerVersion('0.0.0', '2.5.2')).toBe(false);
    expect(isNewerVersion('unknown', '2.5.2')).toBe(false);
    expect(isNewerVersion('', '2.5.2')).toBe(false);
  });
});

describe('how to update, now that ContextSpace ships only as a release', () => {
  afterEach(() => vi.restoreAllMocks());

  it('points Windows and Linux at the installer, and macOS at the release page', () => {
    expect(engineUpdateAdvice('linux')).toEqual({ command: 'ctxspace desktop install', sentence: 'Run ctxspace desktop install to update!' });
    expect(engineUpdateAdvice('win32').command).toBe('ctxspace desktop install');
    expect(engineUpdateAdvice('darwin')).toEqual({ command: null, sentence: `Download it from ${GITHUB_RELEASE_PAGE_URL}` });
  });

  it('never tells anyone to install the deprecated npm package', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { lines.push(String(line ?? '')); });
    printUpdateBanner({ currentVersion: '2.42.0', latestVersion: '2.50.0', updateAvailable: true });
    const banner = lines.join('\n');
    expect(banner).toContain('2.50.0');
    expect(banner).not.toMatch(/npm/);
    printUpdateBanner({ currentVersion: '2.50.0', latestVersion: '2.50.0', updateAvailable: false });
    expect(lines.join('\n')).toBe(banner);
  });
});
