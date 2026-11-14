import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider, type UseQueryResult } from '@tanstack/react-query';
import type { CommitDetail } from '../board/commitContext.js';
import type { IncomingCommitsReport } from '../plan/whatsNew.js';
import { CommitsList, CommitsMain } from './CommitsView.js';
import { buildCommitListGroups } from './commitListModel.js';
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

  it('renders a single deduplicated tree with only the open commit expanded and key hints at bottom', () => {
    const query = { data: detail, isPending: false, isError: false, error: null, refetch: () => undefined } as unknown as UseQueryResult<CommitDetail, Error>;
    const groups = buildCommitListGroups(sequence, undefined, { repo: 'billing', sha: 'a1b2c3d4e5f6' }, detail);
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
    expect(html).toContain('role="tree" aria-label="Commits"');
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
    const groups = buildCommitListGroups(null, undefined, null, null, incoming);
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
  });
});
