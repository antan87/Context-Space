import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DocumentViewer } from './DocumentViewer.js';
import type { DocumentPreviewData } from './DocumentPreview.js';

describe('DocumentViewer', () => {
  const samplePreview: DocumentPreviewData = {
    name: 'test.md',
    kind: 'markdown',
    content: '# Hello world',
    size: 13,
    modifiedAt: '2026-10-18T12:00:00.000Z',
  };

  it('renders Watch button when onToggleWatch is provided (normal chrome)', () => {
    const onToggleWatch = vi.fn();
    const html = renderToStaticMarkup(
      createElement(DocumentViewer, {
        title: 'test.md',
        preview: samplePreview,
        raw: false,
        watching: false,
        onToggleWatch,
        editable: true,
      }),
    );

    expect(html).toContain('Watch');
    expect(html).toContain('aria-label="Watch document for changes"');
    expect(html).toContain('aria-pressed="false"');
    // Not editing, so not disabled as an HTML attribute
    expect(html).not.toMatch(/<button\b[^>]*\sdisabled[=>][^>]*aria-label="Watch document for changes"/);
  });

  it('renders Watch button in active state when watching is true', () => {
    const onToggleWatch = vi.fn();
    const html = renderToStaticMarkup(
      createElement(DocumentViewer, {
        title: 'test.md',
        preview: samplePreview,
        raw: false,
        watching: true,
        onToggleWatch,
        editable: true,
      }),
    );

    expect(html).toContain('Watching');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('text-emerald-500');
  });

  it('renders Watch button in fillChrome mode', () => {
    const onToggleWatch = vi.fn();
    const html = renderToStaticMarkup(
      createElement(DocumentViewer, {
        title: 'test.md',
        preview: samplePreview,
        raw: false,
        fill: true,
        watching: false,
        onToggleWatch,
        editable: true,
      }),
    );

    expect(html).toContain('aria-label="Watch document for changes"');
    expect(html).toContain('aria-pressed="false"');
  });

  it('omits Watch button when onToggleWatch is not provided', () => {
    const html = renderToStaticMarkup(
      createElement(DocumentViewer, {
        title: 'test.md',
        preview: samplePreview,
        raw: false,
      }),
    );

    expect(html).not.toContain('Watch document for changes');
  });

  it('disables Watch button during active editing in normal chrome', () => {
    const onToggleWatch = vi.fn();
    const html = renderToStaticMarkup(
      createElement(DocumentViewer, {
        title: 'test.md',
        preview: samplePreview,
        raw: false,
        watching: false,
        onToggleWatch,
        editable: true,
        initialEditing: true,
      }),
    );

    expect(html).toContain('title="Cannot watch while editing"');
    expect(html).toMatch(/<button\b[^>]*\sdisabled[=>][^>]*aria-label="Watch document for changes"/);
    expect(html).toContain('aria-label="Save document"');
    expect(html).not.toContain('aria-label="Edit document"');
  });

  it('disables Watch button during active editing in fillChrome mode', () => {
    const onToggleWatch = vi.fn();
    const html = renderToStaticMarkup(
      createElement(DocumentViewer, {
        title: 'test.md',
        preview: samplePreview,
        raw: false,
        fill: true,
        watching: true,
        onToggleWatch,
        editable: true,
        initialEditing: true,
      }),
    );

    expect(html).toContain('title="Cannot watch while editing"');
    expect(html).toMatch(/<button\b[^>]*\sdisabled[=>][^>]*aria-label="Watching document for changes \(live reload\)"/);
    expect(html).toContain('aria-label="Save document"');
    expect(html).not.toContain('aria-label="Edit document"');
  });
});

