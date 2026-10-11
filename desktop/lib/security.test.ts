import { describe, expect, it } from 'vitest';
import { exactLocalOrigin, externalLinkTarget, isAppShellNavigation, isExactLocalOrigin, isTrustedIpcEvent } from './security.js';

describe('desktop renderer security helpers', () => {
  it('accepts only the exact localhost origin and assigned port', () => {
    expect(exactLocalOrigin(43123)).toBe('http://localhost:43123');
    expect(isExactLocalOrigin('http://localhost:43123/', 43123)).toBe(true);
    expect(isExactLocalOrigin('http://localhost:431230/', 43123)).toBe(false);
    expect(isExactLocalOrigin('http://localhost:43123.evil.example/', 43123)).toBe(false);
    expect(isExactLocalOrigin('http://localhost:43124/', 43123)).toBe(false);
  });

  it('rejects userinfo, data URLs, non-http schemes, and invalid ports', () => {
    expect(isExactLocalOrigin('http://user@localhost:43123/', 43123)).toBe(false);
    expect(isExactLocalOrigin('http://localhost:43123@evil.example/', 43123)).toBe(false);
    expect(isExactLocalOrigin('data:text/html,<h1>no</h1>', 43123)).toBe(false);
    expect(isExactLocalOrigin('https://localhost:43123/', 43123)).toBe(false);
    expect(isExactLocalOrigin('http://localhost:0/', 0)).toBe(false);
  });

  it('requires exact webContents, main frame, and main-frame origin for IPC', () => {
    const mainFrame = { url: 'http://localhost:43123/dashboard' };
    const webContents = { mainFrame };
    const window = { webContents };
    expect(isTrustedIpcEvent({ sender: webContents, senderFrame: mainFrame }, window, 43123)).toBe(true);
    expect(isTrustedIpcEvent({ sender: {}, senderFrame: mainFrame }, window, 43123)).toBe(false);
    expect(isTrustedIpcEvent({ sender: webContents, senderFrame: { url: mainFrame.url } }, window, 43123)).toBe(false);
    expect(isTrustedIpcEvent({ sender: webContents, senderFrame: { url: 'data:text/html,evil' } }, window, 43123)).toBe(false);
    expect(isTrustedIpcEvent({ sender: webContents, senderFrame: { url: 'http://localhost:431230/' } }, window, 43123)).toBe(false);
  });
});

describe('desktop navigation guard', () => {
  it('keeps the window on the app shell only', () => {
    expect(isAppShellNavigation('http://localhost:43123/', 43123)).toBe(true);
    expect(isAppShellNavigation('http://localhost:43123/#/workspaces/demo/documents', 43123)).toBe(true);
    expect(isAppShellNavigation('http://localhost:43123/index.html', 43123)).toBe(true);
    // A local file path clicked in a document resolves to another path on the
    // dashboard origin; loading it replaced the app with a bare 404.
    expect(isAppShellNavigation('http://localhost:43123/home/me/workspace/assessment/01.jpeg', 43123)).toBe(false);
    expect(isAppShellNavigation('http://localhost:43123/api/config', 43123)).toBe(false);
    expect(isAppShellNavigation('http://localhost:43124/', 43123)).toBe(false);
    expect(isAppShellNavigation('https://example.com/', 43123)).toBe(false);
  });

  it('hands only public web and mail links to the system handler', () => {
    expect(externalLinkTarget('https://github.com/antan87/Context-Space/releases/latest')).toBe('https://github.com/antan87/Context-Space/releases/latest');
    expect(externalLinkTarget('https://github.com/antan87/NexusFlow/releases/latest')).toBe('https://github.com/antan87/NexusFlow/releases/latest');
    expect(externalLinkTarget('https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html')).toContain('w3.org');
    expect(externalLinkTarget('mailto:team@example.com')).toBe('mailto:team@example.com');
    for (const url of [
      'http://localhost:43123/api/config', 'http://127.0.0.1:43123/', 'http://[::1]:3000/', 'http://app.localhost/',
      'http://0.0.0.0:8080/', 'https://user:secret@example.com/', 'file:///etc/passwd', 'javascript:alert(1)',
      'data:text/html,<h1>x</h1>', 'vscode://file/etc/passwd', 'not a url',
    ]) {
      expect(externalLinkTarget(url)).toBeNull();
    }
  });
});
