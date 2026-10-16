import { describe, expect, it } from 'vitest';
import { hardWrapSkip } from './wrappedRows.js';

const COLS = 40;
/** A row whose text ends exactly at the last column. */
const edge = (text: string) => text.padStart(COLS, ' ');

describe('hardWrapSkip', () => {
  it('joins a URL or path that reaches the last column with the row that goes on with it', () => {
    const first = '  PR: https://github.com/mrpatronz/nexus';
    expect(first).toHaveLength(COLS);
    expect(hardWrapSkip(first, 'flow/pull/123', COLS)).toBe(0);
    // A CLI that indents its text indents the rest of the word too.
    expect(hardWrapSkip(first, '  flow/pull/123 created', COLS)).toBe(2);
    expect(hardWrapSkip(edge('/home/anton-patron/Dev/workspaces/'), 'bugs-findings/NexusFlow/a.ts', COLS)).toBe(0);
  });

  it('does not join a row that stops short of the edge, or a sentence that ends at it', () => {
    expect(hardWrapSkip('  PR: https://github.com/o/r/pull/12', 'pull/123', COLS)).toBeNull();
    expect(hardWrapSkip(edge('Some words that happen to fill the line'), 'and then go on', COLS)).toBeNull();
    // A path that ends at the edge, followed by prose punctuation or a new bullet.
    expect(hardWrapSkip(edge('  see src/app/AppSidebar'), '- next item', COLS)).toBeNull();
    expect(hardWrapSkip(edge('  see src/app/AppSidebar'), '1. next item', COLS)).toBeNull();
    expect(hardWrapSkip(edge('  see src/app/AppSidebar'), '* next item', COLS)).toBeNull();
    expect(hardWrapSkip(edge('  see src/app/AppSidebar'), '', COLS)).toBeNull();
    expect(hardWrapSkip(edge('  see src/app/AppSidebar'), '   ', COLS)).toBeNull();
  });

  it('needs a real width', () => {
    expect(hardWrapSkip('a/b', 'c/d', 0)).toBeNull();
    expect(hardWrapSkip('a/b', 'c/d', 1)).toBeNull();
  });
});
