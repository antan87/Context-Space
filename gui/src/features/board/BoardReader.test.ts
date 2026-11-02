import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BoardReader } from './BoardReader.js';
import { forgeDisplayName, type CommitDetail } from './commitContext.js';

describe('BoardReader Header & Vendor Link', () => {
  const createTestClient = () =>
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

  it('renders commit subject, repo and short SHA subtitle with Full screen toggle and Close buttons', () => {
    const queryClient = createTestClient();
    const commitTarget = {
      card: 'commit:billing:a1b2c3d4e5f67890',
      title: 'feat: add export generator',
      commit: { repo: 'billing', sha: 'a1b2c3d4e5f67890' },
    };

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(BoardReader, {
          workspaceId: 'demo-ws',
          target: commitTarget,
          request: 1,
          layout: 'large',
          onLayout: () => {},
          covers: false,
          width: 480,
          onClose: () => {},
          onOpenInDocs: () => {},
          onOpenFile: () => {},
        }),
      ),
    );

    expect(html).toContain('feat: add export generator');
    expect(html).toContain('billing · a1b2c3d');
    // Header action buttons
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('aria-label="Full screen"');
    expect(html).toContain('aria-label="Close"');
  });

  it('renders a calm, visible forge badge in the subtitle when commit is pushed with valid webUrl', () => {
    const queryClient = createTestClient();
    const commitData: CommitDetail = {
      repo: 'billing',
      sha: 'a1b2c3d4e5f678901234567890abcdef12345678',
      shortSha: 'a1b2c3d',
      author: 'Developer',
      at: '2026-11-01T10:00:00Z',
      subject: 'feat: add export generator',
      body: 'Detailed body text',
      parents: [],
      files: [],
      moreFiles: 0,
      additions: 10,
      deletions: 2,
      pushed: true,
      forge: 'github',
      webUrl: 'https://github.com/my-org/billing/commit/a1b2c3d4e5f678901234567890abcdef12345678',
    };

    // Pre-populate query cache with commit detail
    queryClient.setQueryData(['board-commit', 'demo-ws', 'billing', commitData.sha], commitData);

    const commitTarget = {
      card: `commit:billing:${commitData.sha}`,
      title: 'feat: add export generator',
      commit: { repo: 'billing', sha: commitData.sha },
    };

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(BoardReader, {
          workspaceId: 'demo-ws',
          target: commitTarget,
          request: 1,
          layout: 'large',
          onLayout: () => {},
          covers: false,
          width: 480,
          onClose: () => {},
          onOpenInDocs: () => {},
          onOpenFile: () => {},
        }),
      ),
    );

    // Verify vendor badge is in header
    expect(html).toContain('<span>GitHub</span>');
    expect(html).toContain('href="https://github.com/my-org/billing/commit/a1b2c3d4e5f678901234567890abcdef12345678"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('title="Open commit on GitHub"');
    // Lucide SquareArrowOutUpRight SVG arrow is rendered
    expect(html).toContain('lucide-square-arrow-out-up-right');
  });

  it('omits the forge badge link when commit is not pushed', () => {
    const queryClient = createTestClient();
    const commitData: CommitDetail = {
      repo: 'billing',
      sha: 'a1b2c3d4e5f678901234567890abcdef12345678',
      shortSha: 'a1b2c3d',
      author: 'Developer',
      at: '2026-11-01T10:00:00Z',
      subject: 'feat: unpushed local commit',
      body: '',
      parents: [],
      files: [],
      moreFiles: 0,
      additions: 5,
      deletions: 0,
      pushed: false, // NOT pushed
      forge: 'github',
      webUrl: 'https://github.com/my-org/billing/commit/a1b2c3d4e5f678901234567890abcdef12345678',
    };

    queryClient.setQueryData(['board-commit', 'demo-ws', 'billing', commitData.sha], commitData);

    const commitTarget = {
      card: `commit:billing:${commitData.sha}`,
      title: 'feat: unpushed local commit',
      commit: { repo: 'billing', sha: commitData.sha },
    };

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(BoardReader, {
          workspaceId: 'demo-ws',
          target: commitTarget,
          request: 1,
          layout: 'large',
          onLayout: () => {},
          covers: false,
          width: 480,
          onClose: () => {},
          onOpenInDocs: () => {},
          onOpenFile: () => {},
        }),
      ),
    );

    // Header has NO links
    expect(html).not.toContain('Open commit on GitHub');
    expect(html).not.toContain('<span>GitHub</span>');
  });

  it('omits the forge badge link when webUrl protocol is unsafe or null', () => {
    const queryClient = createTestClient();
    const commitData: CommitDetail = {
      repo: 'billing',
      sha: 'a1b2c3d4e5f678901234567890abcdef12345678',
      shortSha: 'a1b2c3d',
      author: 'Developer',
      at: '2026-11-01T10:00:00Z',
      subject: 'feat: unsafe url commit',
      body: '',
      parents: [],
      files: [],
      moreFiles: 0,
      additions: 5,
      deletions: 0,
      pushed: true,
      forge: 'github',
      webUrl: 'javascript:alert(1)', // Unsafe URL!
    };

    queryClient.setQueryData(['board-commit', 'demo-ws', 'billing', commitData.sha], commitData);

    const commitTarget = {
      card: `commit:billing:${commitData.sha}`,
      title: 'feat: unsafe url commit',
      commit: { repo: 'billing', sha: commitData.sha },
    };

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(BoardReader, {
          workspaceId: 'demo-ws',
          target: commitTarget,
          request: 1,
          layout: 'large',
          onLayout: () => {},
          covers: false,
          width: 480,
          onClose: () => {},
          onOpenInDocs: () => {},
          onOpenFile: () => {},
        }),
      ),
    );

    expect(html).not.toContain('javascript:alert(1)');
    expect(html).not.toContain('<span>GitHub</span>');
  });

  it('keeps header quiet with only More actions and Close buttons for non-commit document previews', () => {
    const queryClient = createTestClient();
    const docTarget = {
      path: 'docs/architecture.md',
      title: 'Architecture overview',
    };

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(BoardReader, {
          workspaceId: 'demo-ws',
          target: docTarget,
          request: 1,
          layout: 'large',
          onLayout: () => {},
          covers: false,
          width: 480,
          onClose: () => {},
          onOpenInDocs: () => {},
          onOpenFile: () => {},
        }),
      ),
    );

    expect(html).toContain('Architecture overview');
    expect(html).toContain('docs/architecture.md');
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('aria-label="Close"');
    // Non-commit reader keeps original quiet header without extra toggle button
    expect(html).not.toContain('aria-label="Full screen"');
  });

  it('infers forge name from webUrl when forge kind is unknown or null', () => {
    expect(forgeDisplayName('unknown', 'https://github.corp.example.com/org/repo/commit/123')).toBe('GitHub');
    expect(forgeDisplayName('unknown', 'https://gitlab.internal.io/org/repo/-/commit/123')).toBe('GitLab');
    expect(forgeDisplayName(null, 'https://dev.azure.com/org/repo')).toBe('Azure DevOps');
    expect(forgeDisplayName(null, 'https://bitbucket.org/org/repo')).toBe('Bitbucket');
    expect(forgeDisplayName('unknown', 'https://code.company.org/repo')).toBe('Code');
  });

  it('renders badge with aria-label for accessibility', () => {
    const queryClient = createTestClient();
    const commitData: CommitDetail = {
      repo: 'billing',
      sha: 'a1b2c3d4e5f678901234567890abcdef12345678',
      shortSha: 'a1b2c3d',
      author: 'Developer',
      at: '2026-11-01T10:00:00Z',
      subject: 'feat: add export generator',
      body: 'Detailed body text',
      parents: [],
      files: [],
      moreFiles: 0,
      additions: 10,
      deletions: 2,
      pushed: true,
      forge: 'gitlab',
      webUrl: 'https://gitlab.com/my-org/billing/-/commit/a1b2c3d4e5f678901234567890abcdef12345678',
    };

    queryClient.setQueryData(['board-commit', 'demo-ws', 'billing', commitData.sha], commitData);

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(BoardReader, {
          workspaceId: 'demo-ws',
          target: {
            card: `commit:billing:${commitData.sha}`,
            title: 'feat: add export generator',
            commit: { repo: 'billing', sha: commitData.sha },
          },
          request: 1,
          layout: 'large',
          onLayout: () => {},
          covers: false,
          width: 480,
          onClose: () => {},
          onOpenInDocs: () => {},
          onOpenFile: () => {},
        }),
      ),
    );

    expect(html).toContain('aria-label="Open commit on GitLab"');
    expect(html).toContain('<span>GitLab</span>');
  });
});
