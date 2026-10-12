import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppSidebar } from './AppSidebar.js';
import { RepositoriesToggle } from './WorkspaceRepositories.js';
import { floatingChatStore } from '../features/chat/floatingChatStore.js';
import type { Feature } from '../types.js';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

const storage = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
};

beforeAll(() => {
  (globalThis as unknown as { localStorage: unknown }).localStorage = localStorageMock;
  (globalThis as unknown as { document: unknown }).document = {
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { classList: { add: () => {}, remove: () => {}, toggle: () => {} }, dataset: {} },
    querySelector: () => null,
  };
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  };
});

afterAll(() => {
  (globalThis as unknown as { document: unknown }).document = originalDocument;
  (globalThis as unknown as { window: unknown }).window = originalWindow;
});

beforeEach(() => {
  storage.clear();
  floatingChatStore.removeTab('feat/alpha');
  floatingChatStore.removeTab('feat/beta');
});

const mockWorkspaces: Feature[] = [
  {
    id: 'ws-alpha',
    branchName: 'feat/alpha',
    name: 'Feature Alpha',
    description: 'First test feature',
    workspacePath: '/path/to/alpha',
    createdAt: '2026-10-01T12:00:00Z',
    repos: ['repo-a'],
  },
  {
    id: 'ws-beta',
    branchName: 'feat/beta',
    name: 'Feature Beta',
    description: 'Second test feature',
    workspacePath: '/path/to/beta',
    createdAt: '2026-10-02T12:00:00Z',
    repos: ['repo-b'],
  },
];

function renderSidebar(props: Partial<Parameters<typeof AppSidebar>[0]> = {}, initialPath = '/workspaces/feat%2Falpha') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        { initialEntries: [initialPath] },
        createElement(AppSidebar, {
          appVersion: '2.39.0',
          workspaces: mockWorkspaces,
          activeWsId: 'feat/alpha',
          ...props,
        })
      )
    )
  );
}

describe('RepositoriesToggle', () => {
  it('renders a button with size-6 and GitBranch icon', () => {
    const html = renderToStaticMarkup(
      createElement(RepositoriesToggle, {
        branch: 'feat/alpha',
        open: false,
        needsPreparing: false,
        branchChanged: false,
        onToggle: () => {},
      })
    );
    expect(html).toContain('<button');
    expect(html).toContain('size-6');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Show repositories and branches for feat/alpha');
  });

  it('reflects open state and shows amber dot when preparing is needed', () => {
    const html = renderToStaticMarkup(
      createElement(RepositoriesToggle, {
        branch: 'feat/alpha',
        open: true,
        needsPreparing: true,
        branchChanged: false,
        onToggle: () => {},
      })
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Hide repositories and branches for feat/alpha');
    expect(html).toContain('bg-amber-500');
  });

  it('shows indicator when branch has changed/drifted', () => {
    const html = renderToStaticMarkup(
      createElement(RepositoriesToggle, {
        branch: 'feat/alpha',
        open: false,
        needsPreparing: false,
        branchChanged: true,
        onToggle: () => {},
      })
    );
    expect(html).toContain('(a branch has changed)');
    expect(html).toContain('bg-amber-500');
  });
});

describe('AppSidebar - Open Sessions and Close Controls', () => {
  it('renders a collapsible button for Open Sessions matching Workspaces', () => {
    floatingChatStore.openCli('feat/alpha');
    floatingChatStore.addTab('feat/beta');

    const html = renderSidebar();

    // Check Open Sessions collapsible header
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Open Sessions');
    expect(html).toContain('aria-label="Open sessions list"');
  });

  it('anchors the close button at right-1.5 and makes it discoverable on the active session', () => {
    floatingChatStore.openCli('feat/alpha');
    floatingChatStore.addTab('feat/beta');

    const html = renderSidebar({ activeWsId: 'feat/alpha' }, '/workspaces/feat%2Falpha');

    // Both sessions have close buttons
    expect(html).toContain('aria-label="Close session Feature Alpha"');
    expect(html).toContain('aria-label="Close session Feature Beta"');

    // On active session, action container has opacity-100 and right-1.5
    expect(html).toContain('right-1.5');
    expect(html).toContain('opacity-100');
    // On inactive session, action container has opacity-0
    expect(html).toContain('opacity-0');

    // RepositoriesToggle is present on active workspace and placed to the left of Close button
    const closeBtnIdx = html.indexOf('aria-label="Close session Feature Alpha"');
    const repoToggleIdx = html.indexOf('repositories and branches for feat/alpha');
    expect(repoToggleIdx).toBeGreaterThan(-1);
    expect(closeBtnIdx).toBeGreaterThan(-1);
    expect(repoToggleIdx).toBeLessThan(closeBtnIdx);
  });

  it('leaves room for actions with pr-20 on active session status line without clipping title', () => {
    floatingChatStore.openCli('feat/alpha');

    const html = renderSidebar({ activeWsId: 'feat/alpha' }, '/workspaces/feat%2Falpha');
    // Status line gets pr-20 to avoid colliding with action pill
    expect(html).toContain('pr-20');
    // The link itself does not force unconditional pr-20 on desktop so title retains full wrapping width
    expect(html).not.toMatch(/data-sidebar-session="feat\/alpha"[^>]*class="[^"]*(?<![:\w-])pr-20(?![-\w])/);
  });

  it('renders discoverable close button in rail mode for active session', () => {
    storage.set('ctxspace_sidebar_collapsed', 'true');
    floatingChatStore.openCli('feat/alpha');
    floatingChatStore.addTab('feat/beta');

    const html = renderSidebar({ activeWsId: 'feat/alpha' }, '/workspaces/feat%2Falpha');

    // Rail mode aside rendered
    expect(html).toContain('w-14');
    expect(html).toContain('aria-label="Open sessions"');

    // Rail mode close button on active session is discoverable (opacity-90)
    expect(html).toContain('opacity-90');
    expect(html).toContain('aria-label="Close session Feature Alpha"');
  });

  it('cleanly removes tab from openTabs when closed', () => {
    floatingChatStore.openCli('feat/alpha');
    floatingChatStore.addTab('feat/beta');
    expect(floatingChatStore.getState().openTabs).toEqual(['feat/alpha', 'feat/beta']);

    floatingChatStore.removeTab('feat/alpha');
    expect(floatingChatStore.getState().openTabs).toEqual(['feat/beta']);
  });

  it('omits Open Sessions section entirely when openTabs is empty', () => {
    const html = renderSidebar({ activeWsId: 'feat/alpha' }, '/workspaces/feat%2Falpha');
    expect(html).not.toContain('Open Sessions');
    expect(html).not.toContain('aria-label="Open sessions list"');
  });

  it('omits CLI history button when workspace is archived', () => {
    const archivedWorkspace: Feature = {
      ...mockWorkspaces[0]!,
      archivedAt: '2026-10-10T10:00:00Z',
    };
    floatingChatStore.openCli('feat/alpha');

    const html = renderSidebar(
      {
        workspaces: [archivedWorkspace, mockWorkspaces[1]!],
        activeWsId: 'feat/alpha',
      },
      '/workspaces/feat%2Falpha'
    );

    expect(html).toContain('aria-label="Close session Feature Alpha"');
    expect(html).not.toContain('Resume CLI chat for feat/alpha');
  });

  it('filters open sessions when initialSearch is provided', () => {
    floatingChatStore.openCli('feat/alpha');
    floatingChatStore.addTab('feat/beta');

    // Filter matching only Alpha
    const htmlMatchingAlpha = renderSidebar({
      activeWsId: 'feat/alpha',
      initialSearch: 'Alpha',
    });

    expect(htmlMatchingAlpha).toContain('data-sidebar-session="feat/alpha"');
    expect(htmlMatchingAlpha).not.toContain('data-sidebar-session="feat/beta"');
    expect(htmlMatchingAlpha).toContain('aria-label="Close session Feature Alpha"');
    expect(htmlMatchingAlpha).not.toContain('aria-label="Close session Feature Beta"');
    expect(htmlMatchingAlpha).not.toContain('No open sessions match');

    // Filter matching neither
    const htmlMatchingNone = renderSidebar({
      activeWsId: 'feat/alpha',
      initialSearch: 'NonExistentXYZ',
    });

    expect(htmlMatchingNone).not.toContain('data-sidebar-session="feat/alpha"');
    expect(htmlMatchingNone).not.toContain('data-sidebar-session="feat/beta"');
    expect(htmlMatchingNone).toContain('No open sessions match');
  });

  it('renders filter search toolbar above Open Sessions', () => {
    floatingChatStore.openCli('feat/alpha');

    const html = renderSidebar({ activeWsId: 'feat/alpha' });
    const searchIdx = html.indexOf('placeholder="Filter..."');
    const openSessionsIdx = html.indexOf('Open Sessions');

    expect(searchIdx).toBeGreaterThan(-1);
    expect(openSessionsIdx).toBeGreaterThan(-1);
    expect(searchIdx).toBeLessThan(openSessionsIdx);
  });

  it('filters open sessions and workspaces by repository name', () => {
    floatingChatStore.openCli('feat/alpha');
    floatingChatStore.addTab('feat/beta');

    const html = renderSidebar({
      activeWsId: 'feat/alpha',
      initialSearch: 'repo-a',
    });

    // Matches Alpha whose repos contains repo-a
    expect(html).toContain('data-sidebar-session="feat/alpha"');
    expect(html).not.toContain('data-sidebar-session="feat/beta"');
  });
});

