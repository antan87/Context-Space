import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider, type UseQueryResult } from '@tanstack/react-query';
import type { CommitDetail } from '../board/commitContext.js';
import { CommitsMain } from './CommitsView.js';
import { orderedCommitFiles } from './commitData.js';
import type { CommitSequence } from './commitsMode.js';

const body = ['First paragraph of a long description that explains why.', '', 'Second paragraph with more detail.', '', 'Third paragraph.', '', 'Fourth paragraph.'].join('\n');
const detail: CommitDetail = {
  repo: 'billing', sha: 'a1b2c3d4e5f678901234567890abcdef12345678', shortSha: 'a1b2c3d', author: 'Developer', at: '2026-11-01T10:00:00Z',
  subject: 'feat: add export generator', body, parents: [],
  files: [
    { path: 'src/export/generator.ts', status: 'added', additions: 40, deletions: 0 },
    { path: 'README.md', status: 'modified', additions: 2, deletions: 1 },
    { path: 'src/old.ts', oldPath: 'src/older.ts', status: 'renamed', additions: 0, deletions: 0 },
  ],
  moreFiles: 0, additions: 42, deletions: 1, pushed: true, forge: 'github', webUrl: 'https://github.com/org/billing/commit/a1b2c3d',
};
const sequence: CommitSequence = { label: 'Export', commits: [
  { repo: 'billing', sha: 'f000000' }, { repo: 'billing', sha: 'a1b2c3d4e5f6' }, { repo: 'billing', sha: 'e000000' },
] };

function render(file: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const query = { data: detail, isPending: false, isError: false, error: null, refetch: () => undefined } as unknown as UseQueryResult<CommitDetail, Error>;
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(CommitsMain, {
    workspace: 'demo', commit: { repo: 'billing', sha: 'a1b2c3d4e5f6' }, detail: query, file, ordered: orderedCommitFiles(detail),
    sequence, held: sequence, recent: undefined, onCommit: () => {}, onStepCommit: () => {}, onStepFile: () => {},
    viewMode: 'unified', onToggleViewMode: () => {}, fontControls: null, recentPending: false,
  })));
}

describe('Commits mode header', () => {
  const html = render('src/export/generator.ts');
  it('shows the subject, the whole description, author, short SHA, repository and whether it is pushed', () => {
    expect(html).toContain('feat: add export generator');
    expect(html).toContain('Fourth paragraph.');
    expect(html).toContain('by Developer');
    expect(html).toContain('a1b2c3d');
    expect(html).toContain('billing');
    expect(html).toContain('pushed');
  });
  it('links to the forge only for a pushed commit with a safe URL', () => {
    expect(html).toContain('aria-label="Open commit on GitHub"');
  });
  it('says where the commit stands in its row and offers the previous and next commit and the list', () => {
    expect(html).toContain('2 of 3 · Export');
    expect(html).toContain('aria-label="Previous commit"');
    expect(html).toContain('aria-label="Next commit"');
    expect(html).toContain('aria-label="Choose a commit"');
  });
  it('folds a long description to a few lines with a More button, so it never pushes the diff away', () => {
    expect(html).toContain('line-clamp-3');
    expect(html).toContain('>More<');
  });
  it('lists the files in the order the tree shows them, and the file bar counts through them', () => {
    expect(orderedCommitFiles(detail)).toEqual(['src/export/generator.ts', 'src/old.ts', 'README.md']);
    expect(html).toContain('1 / 3');
    expect(html).toContain('aria-label="Next file"');
  });
  it('without a chosen file, keeps the header and says to choose one', () => {
    const none = render(null);
    expect(none).toContain('feat: add export generator');
    expect(none).toContain('Choose a file');
  });
});
