import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { newsEntries, newsTotal } from '../plan/whatsNew.js';
import { newsLines } from './nowLine.js';
const tools = { notes: [], request: 1, active: true, readOnly: false, onDone: async () => {} };
describe('reader source lines', () => {
  it('rendered Markdown carries source lines including blank lines and fence markers', async () => {
    const { ReaderLines } = await import('./ReaderLines.js');
    const html = renderToStaticMarkup(createElement(ReaderLines, { content: '# Title\n\nA paragraph\nacross two lines\n\n```ts\nx();\n```', markdown: true, tools }));
    expect(html).toContain('data-source-line="3" data-source-end="4"');
    expect(html).toContain('data-source-line="6" data-source-end="8"');
  });
  it('a note ages with a fake clock instead of keeping just now forever', async () => {
    const { ReaderLines } = await import('./ReaderLines.js');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
      const note = { id: 'n', path: 'a.ts', line: 1, endLine: 1, anchor: 'one', anchorCut: false, text: 'Answer', tag: 'todo' as const, harness: 'codex', createdAt: new Date().toISOString() };
      const props = { content: 'one', markdown: false, tools: { ...tools, notes: [note], openNoteId: 'n' } };
      expect(renderToStaticMarkup(createElement(ReaderLines, props))).toContain('just now');
      vi.advanceTimersByTime(5 * 60_000);
      expect(renderToStaticMarkup(createElement(ReaderLines, props))).not.toContain('just now');
    } finally { vi.useRealTimers(); }
  });
  it('a news note has an actionable reader destination even without a board card', () => {
    const n = { id: 'note-1', path: 'gone.ts', repo: 'app', line: 12, endLine: 18, anchor: 'old', anchorCut: false, text: 'Answer', tag: 'question' as const, harness: 'codex', createdAt: new Date().toISOString() };
    const empty = { items: [], more: 0 };
    const news = { at: n.createdAt, from: n.createdAt, basis: 'last-look' as const, reader: 'user', plan: empty, documents: empty, knowledge: empty, commits: [], lineNotes: { items: [n], more: 0 }, problems: [], empty: false };
    expect(newsTotal(news)).toBe(1);
    expect(newsEntries(news)[0]).toMatchObject({ text: expect.stringContaining('Note on app/gone.ts lines 12-18 (codex)'), ref: { kind: 'lineNote', note: n } });
    expect(newsLines(news, [])[0].lineNote).toEqual(n);
  });
});

it('a note on blank rendered Markdown still has a marker at its clamped line', async () => {
  const { ReaderLines } = await import('./ReaderLines.js');
  const note = { id: 'blank', path: 'empty.md', line: 1, endLine: 1, anchor: '', anchorCut: false, text: 'An empty-file answer', tag: 'question' as const, harness: 'codex', createdAt: new Date().toISOString() };
  const html = renderToStaticMarkup(createElement(ReaderLines, { content: '', markdown: true, tools: { ...tools, notes: [note] } }));
  expect(html).toContain('data-note-marker="1"');
});

// Plain text is still one preformatted source block; annotations must not change its text.
it.each(['# File docs/early-notes.txt', '  indented\n\nlast line  \n'])('plain text keeps its preformatted block: %j', async content => {
  const { ReaderLines } = await import('./ReaderLines.js');
  const html = renderToStaticMarkup(createElement(ReaderLines, { content, markdown: false, tools }));
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
  expect(pre, 'the old reader pre remains available').not.toBeNull();
  expect(pre![1].replace(/<[^>]+>/g, '')).toBe(content);
  expect(pre![1]).toContain('data-source-line="1"');
  expect(html).toMatch(/<pre[^>]*class="[^"]*whitespace-pre-wrap[^"]*font-mono/);
});

describe('notes outside rendered Markdown blocks', () => {
  const cases = [
    ['review3 reference definition', '# Title\n\nRead [the API][api].\n\n[api]: ./api.md', 5, 3],
    ['front-matter blank line', '---\ntitle: Guide\n\n---\n\n# Body', 3, 2],
    ['definition before the first rendered block', '[api]: ./api.md\n\n# Title', 1, 3],
    ['comment between rendered blocks', '# Title\n\n<!-- hidden -->\n\nLast paragraph.', 3, 1],
    ['trailing blank line', '# Title\n\nParagraph.\n\n', 4, 3],
  ] as const;
  it.each(cases)('%s stays visible at its owning rendered block', async (_name, content, line, block) => {
    const { ReaderLines } = await import('./ReaderLines.js');
    const note = { id: 'orphan', path: 'guide.md', line, endLine: line, anchor: content.split('\n')[line - 1], anchorCut: false, text: 'An answer on non-rendered source', tag: 'question' as const, harness: 'codex', createdAt: new Date().toISOString() };
    const html = renderToStaticMarkup(createElement(ReaderLines, { content, markdown: true, tools: { ...tools, notes: [note], openNoteId: note.id } }));
    expect(html).toContain(`data-note-marker="${block}"`);
    expect(html.match(/data-note-marker=/g)).toHaveLength(1);
    expect(html).toContain(`data-note-id="${note.id}"`);
    expect(html).toContain(`lines ${line}-${line}`);
    expect(html).toContain(note.text);
    expect(html).toContain('>Done</button>'); expect(html).toContain('>Close</button>');
    expect(html).not.toContain('data-source-single=""');
  });
  it('keeps source rows when the Markdown has no rendered blocks', async () => {
    const { ReaderLines } = await import('./ReaderLines.js');
    const content = '[api]: ./api.md';
    const note = { id: 'definition-only', path: 'guide.md', line: 1, endLine: 1, anchor: content, anchorCut: false, text: 'Definition answer', tag: 'question' as const, harness: 'codex', createdAt: new Date().toISOString() };
    const html = renderToStaticMarkup(createElement(ReaderLines, { content, markdown: true, tools: { ...tools, notes: [note], openNoteId: note.id } }));
    expect(html).toContain('<pre'); expect(html).toContain('data-source-line="1"');
    expect(html).toContain('data-note-marker="1"'); expect(html).toContain('data-note-id="definition-only"');
    expect(html).toContain(content); expect(html).toContain(note.text);
  });
});
