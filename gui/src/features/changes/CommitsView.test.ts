import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider, type UseQueryResult } from '@tanstack/react-query';
import type { CommitDetail } from '../board/commitContext.js';
import type { IncomingCommitsReport, RecentCommits } from '../plan/whatsNew.js';
import { CommitsList, CommitsMain } from './CommitsView.js';
import { buildCommitRepoGroups } from './commitListModel.js';
import type { CommitSequence } from './commitsMode.js';

const body = [
  'First paragraph of a long description that explains why.',
  '',
  'Second paragraph with more detail.',
  '',
  'Third paragraph.',
  '',
  'Fourth paragraph.',
].join('\n');

const detail: CommitDetail = {
  repo: 'billing',
  sha: 'a1b2c3d4e5f678901234567890abcdef12345678',
  shortSha: 'a1b2c3d',
  author: 'Developer',
  at: '2026-11-01T10:00:00Z',
  subject: 'feat: add export generator',
  body,
  parents: [],
  files: [
    { path: 'src/export/generator.ts', status: 'added', additions: 40, deletions: 0 },
    { path: 'src/old.ts', oldPath: 'src/older.ts', status: 'renamed', additions: 0, deletions: 0 },
    { path: 'README.md', status: 'modified', additions: 2, deletions: 1 },
  ],
  moreFiles: 0,
  additions: 42,
  deletions: 1,
  pushed: true,
  forge: 'github',
  webUrl: 'https://github.com/org/billing/commit/a1b2c3d',
};

const sequence: CommitSequence = {
  label: 'Export',
  commits: [
    { repo: 'billing', sha: 'f000000', subject: 'Earlier commit', at: '2026-10-31T10:00:00Z', pushed: true, fileCount: 1 },
    { repo: 'billing', sha: 'a1b2c3d4e5f6', subject: 'feat: add export generator', at: '2026-11-01T10:00:00Z', firstBodyLine: 'First paragraph of a long description that explains why.', pushed: true, fileCount: 3 },
    { repo: 'billing', sha: 'e000000', subject: 'Follow-up commit', at: '2026-10-30T10:00:00Z', pushed: false, fileCount: 2 },
  ],
};

function renderMain(file: string | null, hasNextCommit = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const query = { data: detail, isPending: false, isError: false, error: null, refetch: () => undefined } as unknown as UseQueryResult<CommitDetail, Error>;
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(CommitsMain, {
        workspace: 'demo',
        commit: { repo: 'billing', sha: 'a1b2c3d4e5f6' },
        detail: query,
        file,
        ordered: detail.files.map((entry) => entry.path),
        hasNextCommit,
        onOpenFile: () => {},
        onSelectCommitView: () => {},
        onNextCommit: () => {},
        onStepFile: () => {},
        viewMode: 'unified',
        onToggleViewMode: () => {},
        fontControls: null,
        recentPending: false,
      }),
    ),
  );
}

describe('Commits mode view (RV2)', () => {
  it('opens on the full commit description without More folding, arrow headers, or commit menu', () => {
    const html = renderMain(null);
    expect(html).toContain('feat: add export generator');
    expect(html).toContain('Fourth paragraph.');
    expect(html).toContain('by Developer');
    expect(html).toContain('a1b2c3d');
    expect(html).toContain('billing');
    expect(html).toContain('pushed');
    expect(html).toContain('aria-label="Open commit on GitHub"');
    expect(html).toContain('data-testid="commit-files-grid"');
    expect(html).toContain('generator.ts');
    expect(html).toContain('src/export');
    expect(html).not.toContain('line-clamp-3');
    expect(html).not.toContain('>More<');
    expect(html).not.toContain('aria-label="Previous commit"');
    expect(html).not.toContain('aria-label="Next commit"');
    expect(html).not.toContain('aria-label="Choose a commit"');
    expect(html).not.toContain('data-testid="commit-position"');
  });

  it('shows slim Read-the-description bar, file n of m, and Next file / Next commit footer when a file is selected', () => {
    const firstFileHtml = renderMain('src/export/generator.ts', true);
    expect(firstFileHtml).toContain('Read the description');
    expect(firstFileHtml).toContain('file 1 of 3');
    expect(firstFileHtml).toContain('Next file: old.ts');
    expect(firstFileHtml).not.toContain('data-testid="commit-file-position"');

    const lastFileHtml = renderMain('README.md', true);
    expect(lastFileHtml).toContain('file 3 of 3');
    expect(lastFileHtml).toContain('←</span><span class="truncate">old.ts</span>');
    expect(lastFileHtml).toContain('Next commit');
  });

  it('renders a deduplicated grouped tree with only the open commit expanded and key hints at bottom', () => {
    const query = { data: detail, isPending: false, isError: false, error: null, refetch: () => undefined } as unknown as UseQueryResult<CommitDetail, Error>;
    const groups = buildCommitRepoGroups(sequence, undefined, { repo: 'billing', sha: 'a1b2c3d4e5f6' }, detail);
    const html = renderToStaticMarkup(
      createElement(CommitsList, {
        groups,
        commit: { repo: 'billing', sha: 'a1b2c3d4e5f6' },
        expanded: { repo: 'billing', sha: 'a1b2c3d4e5f6' },
        file: null,
        expandedDetail: query,
        recentPending: false,
        onSelectCommit: () => {},
        onSelectFile: () => {},
        onTreeStateChange: () => {},
      }),
    );
    expect(html).toContain('role="region" aria-label="Commits"');
    expect(html).toContain('role="tree"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('not pushed');
    expect(html).toContain('data-testid="commit-list-keys"');
    expect(html).toContain('generator.ts');
    expect(html).toContain('back to Board');
  });

  it('shows incoming status lines only for problem states (sign-in, offline, error, busy) and omits no-upstream / no-remote', () => {
    const query = { data: detail, isPending: false, isError: false, error: null, refetch: () => undefined } as unknown as UseQueryResult<CommitDetail, Error>;
    const quietReport: IncomingCommitsReport = {
      at: '2026-10-01T12:00:00Z',
      repos: [
        {
          repo: 'api',
          remote: 'origin',
          branch: 'feat/local',
          host: { kind: 'github', name: 'GitHub' },
          lastFetchAt: '2026-10-01T11:59:00Z',
          fetching: false,
          state: 'no-upstream',
          message: 'No upstream branch configured yet',
          behind: 0,
          commits: [],
          more: 0,
        },
        {
          repo: 'scratch',
          remote: null,
          branch: 'main',
          host: null,
          lastFetchAt: '2026-10-01T11:59:00Z',
          fetching: false,
          state: 'no-remote',
          message: 'Repository has no remotes configured',
          behind: 0,
          commits: [],
          more: 0,
        },
      ],
    };
    const quietHtml = renderToStaticMarkup(
      createElement(CommitsList, {
        groups: [],
        commit: null,
        expanded: null,
        file: null,
        expandedDetail: query,
        recentPending: false,
        incomingReport: quietReport,
        onCheckIncoming: () => {},
        onSelectCommit: () => {},
        onSelectFile: () => {},
        onTreeStateChange: () => {},
      }),
    );
    expect(quietHtml).not.toContain('data-testid="incoming-status"');
    expect(quietHtml).not.toContain('No upstream branch configured yet');
    expect(quietHtml).not.toContain('Repository has no remotes configured');

    const problemReport: IncomingCommitsReport = {
      at: '2026-10-01T12:00:00Z',
      repos: [
        { ...quietReport.repos[0]!, repo: 'a', state: 'sign-in', message: 'Sign in needed' },
        { ...quietReport.repos[0]!, repo: 'b', state: 'offline', message: 'Could not reach origin' },
        { ...quietReport.repos[0]!, repo: 'c', state: 'error', message: 'Fetch failed' },
        { ...quietReport.repos[0]!, repo: 'd', state: 'busy', message: 'Git repository is busy' },
      ],
    };
    const problemHtml = renderToStaticMarkup(
      createElement(CommitsList, {
        groups: [],
        commit: null,
        expanded: null,
        file: null,
        expandedDetail: query,
        recentPending: false,
        incomingReport: problemReport,
        onSelectCommit: () => {},
        onSelectFile: () => {},
        onTreeStateChange: () => {},
      }),
    );
    expect(problemHtml.match(/data-testid="incoming-status"/g)).toHaveLength(4);
    expect(problemHtml).toContain('a: Sign in needed');
    expect(problemHtml).toContain('b: Could not reach origin');
    expect(problemHtml).toContain('c: Fetch failed');
    expect(problemHtml).toContain('d: Git repository is busy');
  });

  it('truncates long incoming author names on one line with a title tooltip', () => {
    const query = { data: detail, isPending: false, isError: false, error: null, refetch: () => undefined } as unknown as UseQueryResult<CommitDetail, Error>;
    const longAuthor = 'Alexandrina Bartholomew-Montgomery-Featherstonehaugh the Third';
    const incoming: IncomingCommitsReport = {
      at: '2026-10-01T12:00:00Z',
      repos: [{
        repo: 'billing',
        remote: 'origin',
        branch: 'main',
        host: { kind: 'azure', name: 'Azure DevOps' },
        lastFetchAt: '2026-10-01T11:59:00Z',
        fetching: false,
        state: 'ok',
        message: null,
        behind: 1,
        commits: [{
          sha: 'f1e2d3c4b5a6',
          author: longAuthor,
          subject: 'Add streaming CSV writer',
          at: '2026-10-01T11:50:00Z',
          incoming: true,
        }],
        more: 0,
      }],
    };
    const groups = buildCommitRepoGroups(null, undefined, null, null, incoming);
    const html = renderToStaticMarkup(
      createElement(CommitsList, {
        groups,
        commit: null,
        expanded: null,
        file: null,
        expandedDetail: query,
        recentPending: false,
        incomingReport: incoming,
        onSelectCommit: () => {},
        onSelectFile: () => {},
        onTreeStateChange: () => {},
      }),
    );
    expect(html).toContain('data-testid="commit-item-author"');
    expect(html).toContain(`title="${longAuthor}"`);
    expect(html).toContain('truncate');
    expect(html).toContain('origin/main');
  });

  it('renders sticky repo -> branch -> PR hierarchy, hairline state pills (>=12px), 2-line titles, and commit header PR link', () => {
    const query = { data: detail, isPending: false, isError: false, error: null, refetch: () => undefined } as unknown as UseQueryResult<CommitDetail, Error>;
    const recent: RecentCommits = {
      at: '2026-11-10T12:00:00Z',
      from: '2026-11-07T12:00:00Z',
      commits: [
        {
          repo: 'NexusFlow',
          remoteRepo: 'antan87/Context-Space',
          branch: 'feat/NexusFlow-new-canvas-interaction',
          base: 'main',
          pullRequests: [
            {
              number: 482,
              title: 'Board commit notes & PR grouping',
              state: 'MERGED',
              url: 'https://github.com/antan87/Context-Space/pull/482',
            },
          ],
          more: 0,
          commits: [
            {
              sha: '8620e75',
              author: 'Anton',
              subject: 'D2: very long commit subject that wraps cleanly across two lines before clamping with ellipsis',
              at: '2026-11-10T11:00:00Z',
              fileCount: 4,
              pushed: true,
            },
            {
              sha: 'd630e49',
              author: 'Anton',
              subject: 'Add commit notes API',
              at: '2026-11-10T09:00:00Z',
              fileCount: 3,
              pushed: true,
              prNumber: 482,
            },
            {
              sha: '8b143ac',
              author: 'Other',
              subject: 'Merge pull request #480 from antan87/fix',
              at: '2026-11-10T08:00:00Z',
              fileCount: 2,
              pushed: true,
              onBase: true,
            },
          ],
        },
        {
          repo: 'billing',
          remoteRepo: 'acme/billing',
          branch: 'main',
          base: null,
          more: 0,
          commits: [
            {
              sha: '111aaaa',
              author: 'Maria',
              subject: 'Fix invoice tax calculation',
              at: '2026-11-10T07:00:00Z',
              fileCount: 1,
              pushed: true,
            },
          ],
        },
      ],
    };

    const groups = buildCommitRepoGroups(null, recent, { repo: 'NexusFlow', sha: 'd630e49' });
    const html = renderToStaticMarkup(
      createElement(CommitsList, {
        groups,
        commit: { repo: 'NexusFlow', sha: 'd630e49' },
        expanded: null,
        file: null,
        expandedDetail: query,
        recentPending: false,
        onSelectCommit: () => {},
        onSelectFile: () => {},
        onTreeStateChange: () => {},
      }),
    );

    expect(html).toContain('NexusFlow');
    expect(html).toContain('antan87/Context-Space');
    expect(html).not.toContain('acme/billing');
    expect(html).toContain('data-testid="commit-branch-name"');
    expect(html).toContain('feat/NexusFlow-new-canvas-interaction');
    expect(html).toContain('data-testid="commit-branch-base"');
    expect(html).toContain('shrink-0');
    expect(html).toContain('→ main');
    expect(html).toContain('Not in a pull request yet');
    expect(html).toContain('title="Not in a pull request yet"');
    expect(html).toContain('title="Already on main"');
    expect(html).toContain('#482');
    expect(html).toContain('Board commit notes &amp; PR grouping');
    expect(html).toContain('Merged');
    expect(html).toContain('https://github.com/antan87/Context-Space/pull/482');
    expect(html).toContain('Already on main');
    expect(html).toContain('line-clamp-2');
    expect(html).toContain('scroll-pt-9');
    expect(html).toContain('sticky top-0');
    expect(html).not.toContain('text-[10.5px]');
    expect(html).not.toContain('text-[11px]');

    // Verify order: Not in a pull request yet -> PR #482 -> Already on main -> billing
    expect(html.indexOf('Not in a pull request yet')).toBeLessThan(html.indexOf('#482'));
    expect(html.indexOf('#482')).toBeLessThan(html.indexOf('Already on main'));
    expect(html.indexOf('Already on main')).toBeLessThan(html.indexOf('billing'));

    // CommitOverview header includes repo, branch, and linked PR pill
    const headerHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(CommitsMain, {
          workspace: 'demo',
          commit: { repo: 'NexusFlow', sha: 'd630e49' },
          detail: {
            data: { ...detail, repo: 'NexusFlow' },
            isPending: false,
            isFetching: false,
            isError: false,
            error: null,
            refetch: () => undefined,
          } as unknown as UseQueryResult<CommitDetail, Error>,
          commitMeta: {
            branch: 'feat/NexusFlow-new-canvas-interaction',
            pr: {
              number: 482,
              title: 'Board commit notes & PR grouping',
              state: 'MERGED',
              url: 'https://github.com/antan87/Context-Space/pull/482',
            },
          },
          file: null,
          ordered: [],
          hasNextCommit: false,
          onOpenFile: () => {},
          onSelectCommitView: () => {},
          onNextCommit: () => {},
          onStepFile: () => {},
          viewMode: 'unified',
          onToggleViewMode: () => {},
          fontControls: null,
          recentPending: false,
        }),
      ),
    );
    expect(headerHtml).toContain('data-testid="commit-repo"');
    expect(headerHtml).toContain('>NexusFlow</span>');
    expect(headerHtml).toContain('data-testid="commit-branch"');
    expect(headerHtml).toContain('feat/NexusFlow-new-canvas-interaction');
    expect(headerHtml).toContain('data-testid="commit-pr-link"');
    expect(headerHtml).toContain('href="https://github.com/antan87/Context-Space/pull/482"');
    expect(headerHtml).toContain('#482');
    expect(headerHtml).toContain('Merged');
    expect(headerHtml).not.toContain('text-[10.5px]');

    // Malformed PR URL renders a non-link badge instead of a broken link
    const unsafePrHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(CommitsMain, {
          workspace: 'demo',
          commit: { repo: 'NexusFlow', sha: 'd630e49' },
          detail: {
            data: { ...detail, repo: 'NexusFlow' },
            isPending: false,
            isFetching: false,
            isError: false,
            error: null,
            refetch: () => undefined,
          } as unknown as UseQueryResult<CommitDetail, Error>,
          commitMeta: {
            branch: 'feat/x',
            pr: {
              number: 482,
              title: 'Malformed URL PR',
              state: 'OPEN',
              url: 'https://',
            },
          },
          file: null,
          ordered: [],
          hasNextCommit: false,
          onOpenFile: () => {},
          onSelectCommitView: () => {},
          onNextCommit: () => {},
          onStepFile: () => {},
          viewMode: 'unified',
          onToggleViewMode: () => {},
          fontControls: null,
          recentPending: false,
        }),
      ),
    );
    expect(unsafePrHtml).toContain('data-testid="commit-pr-badge"');
    expect(unsafePrHtml).not.toContain('data-testid="commit-pr-link"');
  });

  it('renders malformed PR URL in sidebar as non-link badge with title, uses line-clamp-2 on PR titles, renders PR loading status, and renders a commit its branch does not list under a neutral Other commits group', () => {
    const query = { data: detail, isPending: false, isError: false, error: null, refetch: () => undefined } as unknown as UseQueryResult<CommitDetail, Error>;
    const recent = {
      at: '2026-11-10T12:00:00Z',
      from: '2026-11-07T12:00:00Z',
      commits: [
        {
          repo: 'NexusFlow',
          branch: 'feat/long-branch-name',
          base: 'main',
          prsPending: true as const,
          pullRequests: [
            {
              number: 482,
              title: 'Malformed sidebar PR with a long title that should wrap onto two lines cleanly',
              state: 'OPEN' as const,
              url: 'https://',
            },
          ],
          more: 5,
          commits: [
            { sha: 'd630e49', author: 'Anton', subject: 'PR commit', at: '2026-11-10T09:00:00Z', prNumber: 482 },
          ],
        },
      ],
    } as RecentCommits;
    const held: CommitSequence = {
      label: 'News',
      commits: [{ repo: 'NexusFlow', sha: 'old1234', subject: 'Older evaluated commit', at: '2026-11-01T00:00:00Z' }],
    };
    const groups = buildCommitRepoGroups(held, recent, { repo: 'NexusFlow', sha: 'old1234' });
    const sidebarHtml = renderToStaticMarkup(
      createElement(CommitsList, {
        groups,
        commit: { repo: 'NexusFlow', sha: 'old1234' },
        expanded: null,
        file: null,
        expandedDetail: query,
        recentPending: false,
        onSelectCommit: () => {},
        onSelectFile: () => {},
        onTreeStateChange: () => {},
      }),
    );

    expect(sidebarHtml).not.toContain('data-testid="commit-pr-link"');
    expect(sidebarHtml).not.toContain('href="https://"');
    expect(sidebarHtml).toContain('data-testid="commit-pr-badge"');
    expect(sidebarHtml).toContain('title="#482 Malformed sidebar PR with a long title that should wrap onto two lines cleanly (Open)"');
    expect(sidebarHtml).toMatch(/line-clamp-2[^>]*>Malformed sidebar PR/);
    expect(sidebarHtml).toContain('PR information is loading');
    expect(sidebarHtml).not.toContain('commit-older-toggle');
    expect(sidebarHtml).toContain('title="Other commits"');
    expect(sidebarHtml).toContain('>Other commits<');
    // The branch heading belongs to the commits the branch lists; the old commit must not sit under it.
    expect(sidebarHtml.indexOf('Other commits')).toBeGreaterThan(sidebarHtml.indexOf('d630e49'));
    expect(sidebarHtml).not.toContain('Not in a pull request yet');
  });
});
