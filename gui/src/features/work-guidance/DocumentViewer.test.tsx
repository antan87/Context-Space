import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DocumentViewer } from './DocumentViewer.js';
import type { DocumentPreviewData } from './DocumentPreview.js';

// DOMPurify needs a DOM, which these server renders do not have; what it strips is asserted in the browser (root-documents.spec.ts).
vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

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

  it('keeps Watch in the menu, not as a button, in fillChrome mode', () => {
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

    // The watch toggle lives in the menu, so the title keeps its room.
    expect(html).toContain('aria-label="More document actions"');
    expect(html).not.toContain('aria-label="Watch document for changes"');
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

  it('shows Save and hides Edit while editing in fillChrome mode (Watch is disabled then, asserted in root-documents.spec.ts)', () => {
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

    expect(html).toContain('aria-label="More document actions"');
    expect(html).toContain('aria-label="Save document"');
    expect(html).not.toContain('aria-label="Edit document"');
  });

  it('shows a muted eye beside the title while watching, and none otherwise', () => {
    const render = (watching: boolean) => renderToStaticMarkup(createElement(DocumentViewer, { title: 'test.md', preview: samplePreview, raw: false, fill: true, watching, onToggleWatch: vi.fn() }));
    const on = render(true);
    expect(on).toContain('role="img"');
    expect(on).toContain('aria-label="Watching for changes"');
    expect(on).toContain('title="Watching for changes"');
    expect(render(false)).not.toContain('Watching for changes');
  });

  it('shows Download beside Edit when the document has no preview', () => {
    const docx: DocumentPreviewData = { name: 'brief.docx', kind: 'download', size: 10 };
    const html = renderToStaticMarkup(createElement(DocumentViewer, { title: 'brief.docx', preview: docx, raw: false, fill: true, downloadHref: '/dl/brief.docx' }));
    expect(html).toMatch(/<a [^>]*href="\/dl\/brief.docx"[^>]*>.*?Download/);
    const withPreview = renderToStaticMarkup(createElement(DocumentViewer, { title: 'test.md', preview: samplePreview, raw: false, fill: true, downloadHref: '/dl/test.md' }));
    expect(withPreview).not.toContain('Download');
  });

  describe('scripts of an HTML document', () => {
    const page: DocumentPreviewData = { name: 'page.html', kind: 'html', content: '<h1>A page</h1>', size: 16, modifiedAt: '2026-10-18T12:00:00.000Z' };

    it('run by default, in a frame that never shares the app\'s origin, with no switch and no warning', () => {
      for (const fill of [false, true]) {
        const html = renderToStaticMarkup(createElement(DocumentViewer, { title: 'page.html', preview: page, raw: false, fill }));
        expect(html).toContain('sandbox="allow-scripts"');
        expect(html).not.toContain('allow-same-origin');
        expect(html).not.toMatch(/Stop scripts|Run scripts|runs scripts/);
      }
    });

    it('call the source toggle "View source", never "Raw text"', () => {
      const html = renderToStaticMarkup(createElement(DocumentViewer, { title: 'page.html', preview: page, raw: false, onToggleRaw: () => {} }));
      expect(html).toContain('View source');
      expect(html).not.toContain('Raw text');
    });

    it('show "View page" when the source is shown', () => {
      const html = renderToStaticMarkup(createElement(DocumentViewer, { title: 'page.html', preview: page, raw: true, onToggleRaw: () => {} }));
      expect(html).toContain('View page');
    });

    it('with no chrome of its own in a reader that draws the header', () => {
      const html = renderToStaticMarkup(createElement(DocumentViewer, { title: 'page.html', preview: page, raw: false, fill: true, chromeless: true }));
      expect(html).not.toContain('Copy path');
      expect(html).not.toContain('Expand document');
      expect(html).toContain('sandbox="allow-scripts"');
      expect(html).not.toContain('allow-same-origin');
    });
  });
});
