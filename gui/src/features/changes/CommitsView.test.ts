import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider, type UseQueryResult } from '@tanstack/react-query';
import type { CommitDetail } from '../board/commitContext.js';
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
});
