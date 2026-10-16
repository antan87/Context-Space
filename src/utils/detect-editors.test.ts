import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execa } from 'execa';
import { DETECTION_TTL_MS, clearEditorDetectionCache, detectEditors } from './detect-editors.js';
import { PROBE_TIMEOUT_MS } from './probe.js';

vi.mock('execa');

describe('detectEditors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEditorDetectionCache();
    vi.useRealTimers();
  });

  it('should return detected = true for editors whose commands exit with 0', async () => {
    vi.mocked(execa).mockImplementation((command: any, args?: any, options?: any): any => {
      if (command === 'code' || command === 'cursor') {
        return Promise.resolve({ exitCode: 0 } as any);
      }
      return Promise.resolve({ exitCode: 1 } as any);
    });

    const result = await detectEditors();

    const isWin = process.platform === 'win32';
    const expected = isWin
      ? [
          { name: 'VS Code', command: 'code', detected: true },
          { name: 'VS Code Insiders', command: 'code-insiders', detected: false },
          { name: 'Cursor', command: 'cursor', detected: true },
          { name: 'Antigravity', command: 'antigravity', detected: false },
          { name: 'PowerShell', command: 'powershell', detected: true },
          { name: 'Command Prompt', command: 'cmd', detected: true },
          { name: 'IntelliJ IDEA', command: 'idea', detected: false },
          { name: 'WebStorm', command: 'webstorm', detected: false },
          { name: 'PyCharm', command: 'charm', detected: false },
          { name: 'Sublime Text', command: 'subl', detected: false },
          { name: 'Zed', command: 'zed', detected: false },
          { name: 'Windsurf', command: 'windsurf', detected: false },
        ]
      : [
          { name: 'VS Code', command: 'code', detected: true },
          { name: 'VS Code Insiders', command: 'code-insiders', detected: false },
          { name: 'Cursor', command: 'cursor', detected: true },
          { name: 'Antigravity', command: 'antigravity', detected: false },
          { name: 'IntelliJ IDEA', command: 'idea', detected: false },
          { name: 'WebStorm', command: 'webstorm', detected: false },
          { name: 'PyCharm', command: 'charm', detected: false },
          { name: 'Sublime Text', command: 'subl', detected: false },
          { name: 'Zed', command: 'zed', detected: false },
          { name: 'Windsurf', command: 'windsurf', detected: false },
        ];

    expect(result).toEqual(expected);

    expect(execa).toHaveBeenCalledWith('code', ['--version'], { reject: false, timeout: PROBE_TIMEOUT_MS, shell: isWin, windowsHide: true });
    expect(execa).toHaveBeenCalledWith('code-insiders', ['--version'], { reject: false, timeout: PROBE_TIMEOUT_MS, shell: isWin, windowsHide: true });
    expect(execa).toHaveBeenCalledWith('cursor', ['--version'], { reject: false, timeout: PROBE_TIMEOUT_MS, shell: isWin, windowsHide: true });
    expect(execa).toHaveBeenCalledWith('antigravity', ['--version'], { reject: false, timeout: PROBE_TIMEOUT_MS, shell: isWin, windowsHide: true });
  });

  it('should return detected = false for all editors if execa throws an error (except built-in Windows shells)', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('Spawn error'));

    const result = await detectEditors();
    const isWin = process.platform === 'win32';
    const expected = isWin
      ? [
          { name: 'VS Code', command: 'code', detected: false },
          { name: 'VS Code Insiders', command: 'code-insiders', detected: false },
          { name: 'Cursor', command: 'cursor', detected: false },
          { name: 'Antigravity', command: 'antigravity', detected: false },
          { name: 'PowerShell', command: 'powershell', detected: true },
          { name: 'Command Prompt', command: 'cmd', detected: true },
          { name: 'IntelliJ IDEA', command: 'idea', detected: false },
          { name: 'WebStorm', command: 'webstorm', detected: false },
          { name: 'PyCharm', command: 'charm', detected: false },
          { name: 'Sublime Text', command: 'subl', detected: false },
          { name: 'Zed', command: 'zed', detected: false },
          { name: 'Windsurf', command: 'windsurf', detected: false },
        ]
      : [
          { name: 'VS Code', command: 'code', detected: false },
          { name: 'VS Code Insiders', command: 'code-insiders', detected: false },
          { name: 'Cursor', command: 'cursor', detected: false },
          { name: 'Antigravity', command: 'antigravity', detected: false },
          { name: 'IntelliJ IDEA', command: 'idea', detected: false },
          { name: 'WebStorm', command: 'webstorm', detected: false },
          { name: 'PyCharm', command: 'charm', detected: false },
          { name: 'Sublime Text', command: 'subl', detected: false },
          { name: 'Zed', command: 'zed', detected: false },
          { name: 'Windsurf', command: 'windsurf', detected: false },
        ];

    expect(result).toEqual(expected);
  });

  it('counts a command that starts but never answers as installed', async () => {
    vi.mocked(execa).mockImplementation((command: any): any => Promise.resolve(
      command === 'antigravity' ? { exitCode: undefined, timedOut: true } : { exitCode: 1 },
    ));

    const result = await detectEditors();

    expect(result.find((e) => e.command === 'antigravity')?.detected).toBe(true);
    expect(result.find((e) => e.command === 'code')?.detected).toBe(false);
  });

  it('shares one probe run between concurrent callers and reuses it for 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as any);

    const [first, second] = await Promise.all([detectEditors(), detectEditors()]);
    const probesPerRun = vi.mocked(execa).mock.calls.length;
    expect(second).toBe(first);

    expect(DETECTION_TTL_MS).toBe(10 * 60_000);
    vi.setSystemTime(Date.now() + DETECTION_TTL_MS - 1_000);
    await detectEditors();
    expect(execa).toHaveBeenCalledTimes(probesPerRun);

    vi.setSystemTime(Date.now() + 2_000);
    await detectEditors();
    expect(execa).toHaveBeenCalledTimes(probesPerRun * 2);
  });
});
