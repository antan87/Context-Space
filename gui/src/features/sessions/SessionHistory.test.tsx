import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { SessionHistory } from './SessionHistory.js';
import type { AISession, Feature } from '../../types.js';

const mockWorkspace: Feature = {
  id: 'ws-test',
  branchName: 'feat/test',
  name: 'Test Workspace',
  description: 'Test feature',
  workspacePath: '/path/to/test',
  createdAt: '2026-10-01T12:00:00Z',
  repos: ['repo-a'],
};

const mockSessions: AISession[] = [
  {
    id: 'agy-session-12345678',
    assistant: 'antigravity',
    title: 'Fix auth login bug',
    messageCount: 5,
    updatedAt: '2026-10-05T12:00:00Z',
    createdAt: '2026-10-05T10:00:00Z',
  },
  {
    id: 'claude-session-87654321',
    assistant: 'claude',
    title: 'Refactor search components',
    messageCount: 12,
    updatedAt: '2026-10-06T14:00:00Z',
    createdAt: '2026-10-06T11:00:00Z',
  },
  {
    id: 'codex-session-11223344',
    assistant: 'codex',
    title: undefined as unknown as string, // Tests safety against undefined title
    messageCount: 2,
    updatedAt: '2026-10-07T08:00:00Z',
    createdAt: '2026-10-07T07:00:00Z',
  },
];

function renderHistory(props: Partial<Parameters<typeof SessionHistory>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        {},
        createElement(SessionHistory, {
          ws: mockWorkspace,
          sessions: mockSessions,
          sessionsLoading: false,
          setActiveSession: () => {},
          setTranscript: () => {},
          fetchSessionTranscript: async () => {},
          handleOpenDesktopSession: async () => true,
          ...props,
        })
      )
    )
  );
}

describe('SessionHistory - Search and Filter', () => {
  it('renders default grouped view with collapsed harnesses when no search query is active', () => {
    const html = renderHistory();
    expect(html).toContain('Google Antigravity');
    expect(html).toContain('Claude Code');
    expect(html).toContain('OpenAI Codex');
    // In collapsed grouped view without search, session rows are not rendered
    expect(html).not.toContain('Fix auth login bug');
    expect(html).not.toContain('Refactor search components');
  });

  it('auto-expands matching harnesses and sessions when search query is entered in grouped view', () => {
    const html = renderHistory({ initialSearch: 'auth login' });
    // Should show Antigravity card and its matching session
    expect(html).toContain('CLI: agy');
    expect(html).toContain('Fix auth login bug');
    // Non-matching harnesses are not rendered in the grouped card list
    expect(html).not.toContain('CLI: claude');
    expect(html).not.toContain('Refactor search components');
  });

  it('renders empty message in grouped view when search query matches no sessions', () => {
    const html = renderHistory({ initialSearch: 'nonexistent-session-query' });
    expect(html).toContain('No chat sessions match your search filter.');
    expect(html).not.toContain('Fix auth login bug');
    expect(html).not.toContain('Refactor search components');
  });

  it('filters sessions in timeline view and handles undefined title safely', () => {
    const html = renderHistory({
      initialViewMode: 'timeline',
      initialSearch: 'Refactor',
    });
    expect(html).toContain('Refactor search components');
    expect(html).not.toContain('Fix auth login bug');
  });

  it('matches session by session ID and assistant display name', () => {
    // Search by partial session ID
    const htmlById = renderHistory({
      initialViewMode: 'timeline',
      initialSearch: '87654321',
    });
    expect(htmlById).toContain('Refactor search components');
    expect(htmlById).not.toContain('Fix auth login bug');

    // Search by assistant name
    const htmlByAst = renderHistory({
      initialViewMode: 'timeline',
      initialSearch: 'claude code',
    });
    expect(htmlByAst).toContain('Refactor search components');
  });

  it('displays empty message in timeline view when no sessions match', () => {
    const html = renderHistory({
      initialViewMode: 'timeline',
      initialSearch: 'completely-bogus',
    });
    expect(html).toContain('No chat sessions match your search filter.');
  });
});
