import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PluggableDiffViewer } from './PluggableDiffViewer.js';
import { FallbackDiffAdapter } from './adapters/FallbackDiffAdapter.js';
import { parseUnifiedDiff, mapRealLineToSnippetLine, getHunkSnippetLine } from './utils/diffParser.js';

describe('PluggableDiffViewer & Diff Adapters', () => {
  const samplePatch = [
    '--- a/src/index.ts',
    '+++ b/src/index.ts',
    '@@ -10,3 +10,4 @@',
    ' line 10',
    '+line 11 added',
    ' line 12',
    ' line 13',
    '@@ -50,3 +51,3 @@',
    ' line 50',
    '-line 51 old',
    '+line 51 new',
    ' line 52',
  ].join('\n');

  it('shows which change is in view in one slim toolbar, with the way to the next and previous one', () => {
    const html = renderToStaticMarkup(
      createElement(PluggableDiffViewer, {
        filePath: 'src/index.ts',
        repoName: 'nexusflow',
        patchText: samplePatch,
      })
    );

    expect(html).toContain('role="toolbar" aria-label="Diff"');
    expect(html).toContain('Change 1 of 2');
    expect(html).toContain('aria-label="Previous change"');
    expect(html).toContain('aria-label="Next change"');
    expect(html).toContain('aria-label="More diff options"');
    // No second toolbar, tab strip or bottom bar repeating the same controls.
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('Hunk <strong');
  });

  it('separates real line numbers from snippet lines when fullFileContent is absent', () => {
    const parsed = parseUnifiedDiff(samplePatch);
    expect(parsed.hunks.length).toBe(2);

    // For Hunk 1 (startLineModified = 10):
    // Real modified lines: 10, 11 (added), 12, 13
    // Mapped snippet lines: 1, 2, 3, 4
    expect(mapRealLineToSnippetLine(10, parsed.hunks)).toBe(1);
    expect(mapRealLineToSnippetLine(11, parsed.hunks)).toBe(2);
    expect(mapRealLineToSnippetLine(12, parsed.hunks)).toBe(3);
    expect(mapRealLineToSnippetLine(13, parsed.hunks)).toBe(4);

    // For Hunk 2 (startLineModified = 51):
    // Real modified lines: 51, 52 (changed), 53
    // Mapped snippet lines: 5, 6, 7
    expect(mapRealLineToSnippetLine(51, parsed.hunks)).toBe(5);
    expect(mapRealLineToSnippetLine(52, parsed.hunks)).toBe(6);
    expect(mapRealLineToSnippetLine(53, parsed.hunks)).toBe(7);

    // Outside hunks returns null
    expect(mapRealLineToSnippetLine(1, parsed.hunks)).toBeNull();
    expect(mapRealLineToSnippetLine(30, parsed.hunks)).toBeNull();

    // Hunk navigation maps directly to start snippet line of each hunk
    expect(getHunkSnippetLine(0, parsed.hunks)).toBe(1);
    expect(getHunkSnippetLine(1, parsed.hunks)).toBe(5);
  });

  it('FallbackDiffAdapter renders lines with well-spaced gutter columns, vertical dividers, and dedicated diff markers', () => {
    const html = renderToStaticMarkup(
      createElement(FallbackDiffAdapter, {
        filePath: 'src/index.ts',
        patchText: samplePatch,
        targetLine: 11,
      })
    );

    // Verify data-mod-line attributes exist with real line numbers
    expect(html).toContain('data-mod-line="10"');
    expect(html).toContain('data-mod-line="11"');
    expect(html).toContain('data-mod-line="12"');
    expect(html).toContain('data-mod-line="13"');
    expect(html).toContain('data-mod-line="51"');
    expect(html).toContain('data-mod-line="52"');
    expect(html).toContain('data-mod-line="53"');

    // Target line has data-is-target="true"
    expect(html).toContain('data-is-target="true"');

    // Gutter columns have dedicated widths and vertical dividers
    expect(html).toContain('w-12 shrink-0 select-none text-right pr-2 text-[10px] font-mono text-muted-foreground/70 border-r border-border/40');
    // Diff marker column has dedicated width w-5 and right border
    expect(html).toContain('w-5 shrink-0 select-none text-center font-bold font-mono text-xs border-r border-border/40');
    // Added marker '+' and deleted marker '-' are present
    expect(html).toContain('data-diff-marker="+"');
    expect(html).toContain('data-diff-marker="-"');
  });

  it('targets the first changed line of each change, not its leading context', () => {
    // Change 1 starts with context at line 10 and adds line 11; change 2 starts at 51 and replaces line 52.
    const { hunks } = parseUnifiedDiff(samplePatch);
    expect(hunks.map((hunk) => hunk.firstChangedLineModified)).toEqual([11, 52]);
  });

  it('offers Refine only when the caller can act on it, and moves past the last change to the next file', () => {
    const plain = renderToStaticMarkup(createElement(PluggableDiffViewer, { filePath: 'src/index.ts', repoName: 'nexusflow', patchText: samplePatch }));
    expect(plain).not.toContain('Ask AI');
    const withRefine = renderToStaticMarkup(createElement(PluggableDiffViewer, {
      filePath: 'src/index.ts', repoName: 'nexusflow', patchText: samplePatch,
      onRequestRefine: () => undefined, onPrevFile: () => undefined,
    }));
    expect(withRefine).toContain('Ask AI');
    // At the first change, the previous button goes to the previous file instead of doing nothing.
    expect(withRefine).toContain('aria-label="Previous file"');
  });

  it('renders empty diff message gracefully when patch is empty', () => {
    const html = renderToStaticMarkup(
      createElement(FallbackDiffAdapter, {
        filePath: 'src/index.ts',
        patchText: '',
      })
    );

    expect(html).toContain('No diff changes recorded.');
  });

  it('FallbackDiffAdapter targets and highlights pure deletions via targetOrigLine', () => {
    const deletionPatch = [
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -20,4 +21,1 @@',
      ' ctx 21',
      '-deleted line 22',
      '-deleted line 23',
      ' ctx 22',
    ].join('\n');

    const html = renderToStaticMarkup(
      createElement(FallbackDiffAdapter, {
        filePath: 'src/index.ts',
        patchText: deletionPatch,
        targetOrigLine: 21,
      })
    );

    // The deleted line (orig 21) is marked as target
    expect(html).toContain('data-orig-line="21"');
    expect(html).toContain('data-is-target="true"');
    // Context line (mod 22) must NOT be marked as target
    expect(html).not.toMatch(/data-mod-line="22"[^>]*data-is-target="true"/);
  });
});
