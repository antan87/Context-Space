import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BoardReader } from './BoardReader.js';
import { forgeDisplayName } from './commitContext.js';

describe('BoardReader header and forge names', () => {
  const createTestClient = () =>
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

  it('renders Full screen toggle and layout switch buttons for document previews', () => {
    const queryClient = createTestClient();
    const docTarget = {
      path: 'docs/architecture.md',
      title: 'Architecture overview',
    };

    const htmlLarge = renderToStaticMarkup(
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
          onOpenFile: () => {},
        }),
      ),
    );

    expect(htmlLarge).toContain('Architecture overview');
    expect(htmlLarge).toContain('docs/architecture.md');
    expect(htmlLarge).toContain('aria-label="More actions"');
    expect(htmlLarge).toContain('aria-label="Close"');
    // Full screen toggle is now available for all documents
    expect(htmlLarge).toContain('aria-label="Full screen"');

    const htmlSide = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(BoardReader, {
          workspaceId: 'demo-ws',
          target: docTarget,
          request: 1,
          layout: 'side',
          onLayout: () => {},
          covers: false,
          width: 480,
          onClose: () => {},
          onOpenFile: () => {},
        }),
      ),
    );

    // Full screen toggle is available in side layout too
    expect(htmlSide).toContain('aria-label="Full screen"');
  });

  it('renders navigation controls when indexInfo contains multiple items', () => {
    const queryClient = createTestClient();
    const docTarget = {
      path: 'docs/architecture.md',
      title: 'Architecture overview',
    };

    const htmlWithNav = renderToStaticMarkup(
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
          onOpenFile: () => {},
          onNext: () => {},
          onPrevious: () => {},
          nextTitle: 'Next Doc',
          previousTitle: 'Prev Doc',
          indexInfo: { current: 2, total: 5 },
        }),
      ),
    );

    expect(htmlWithNav).toContain('aria-label="Item navigation"');
    expect(htmlWithNav).toContain('2 / 5');
    expect(htmlWithNav).toContain('aria-label="Previous: Prev Doc ([ or Alt+←])"');
    expect(htmlWithNav).toContain('aria-label="Next: Next Doc (] or Alt+→)"');
  });

  it('infers forge name from webUrl when forge kind is unknown or null', () => {
    expect(forgeDisplayName('unknown', 'https://github.corp.example.com/org/repo/commit/123')).toBe('GitHub');
    expect(forgeDisplayName('unknown', 'https://gitlab.internal.io/org/repo/-/commit/123')).toBe('GitLab');
    expect(forgeDisplayName(null, 'https://dev.azure.com/org/repo')).toBe('Azure DevOps');
    expect(forgeDisplayName(null, 'https://bitbucket.org/org/repo')).toBe('Bitbucket');
    expect(forgeDisplayName('unknown', 'https://code.company.org/repo')).toBe('Code');
  });
});
