import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UpdateNotice, type UpdateNoticeProps } from './UpdateNotice.js';

const base: UpdateNoticeProps = {
  currentVersion: '2.10.0', latestVersion: '2.11.0', step: 'idle', releaseUrl: 'https://example.test/releases', canInstall: true, busy: false,
  onDownload: vi.fn(), onRestart: vi.fn(), onLater: vi.fn(),
};
const render = (props: Partial<UpdateNoticeProps>) => renderToStaticMarkup(createElement(UpdateNotice, { ...base, ...props }));

describe('UpdateNotice dot', () => {
  it('names the download progress, rounded', () => {
    const html = render({ step: 'downloading', progress: 41.6, busy: true });
    expect(html).toContain('aria-label="Downloading update 42%"');
  });

  it('names a failed update and draws it in the warning colour, not the normal one', () => {
    const html = render({ step: 'error', error: 'download interrupted' });
    expect(html).toContain('aria-label="Update needs attention"');
    expect(html).toMatch(/data-testid="update-dot-mark"[^>]*class="[^"]*state-needs/);
    expect(html).not.toMatch(/data-testid="update-dot-mark"[^>]*class="[^"]*bg-primary/);
  });

  it('names an available update with both versions, in the normal colour', () => {
    const html = render({});
    expect(html).toContain('aria-label="Update available: v2.10.0 to v2.11.0"');
    expect(html).toMatch(/data-testid="update-dot-mark"[^>]*class="[^"]*bg-primary/);
  });

  it('mounts an empty polite live region with the dot, to be filled later', () => {
    expect(render({})).toMatch(/<span role="status" aria-live="polite" class="sr-only"><\/span>/);
  });
});
