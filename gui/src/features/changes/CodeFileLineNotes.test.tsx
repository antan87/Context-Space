import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
vi.mock('monaco-editor/esm/vs/editor/editor.api', () => ({ Range: class {}, editor: {} }));
const base = { id: 'note', path: 'src/values.ts', repo: 'demo-repo', line: 2, endLine: 3, anchor: 'two\nthree', anchorCut: false, text: 'A pinned **answer**', tag: 'risk' as const, harness: 'codex', createdAt: '2026-11-17T12:00:00.000Z' };
async function render(content: string, note = base) {
  const { CodeFileLineNotes } = await import('./CodeFileLineNotes.js');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['line-notes', 'demo'], { notes: [note, { ...note, id: 'another-repo', repo: 'other' }] });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(CodeFileLineNotes, { editor: {} as monaco.editor.IStandaloneCodeEditor, workspace: 'demo', path: 'src/values.ts', repo: 'demo-repo', content, active: true, openNoteId: 'note' })));
}
describe('Code file notes panel', () => {
  it('opens the requested note, with text, author, range, Done and Close', async () => {
    const html = await render('one\ntwo\nthree');
    expect(html).toContain('A pinned <strong>answer</strong>');
    expect(html).toContain('codex'); expect(html).toContain('lines 2');
    expect(html).toContain('>Done</button>'); expect(html).toContain('>Close</button>');
    expect(html).toContain('Notes (1)');
  });
  it('uses moved placement for the open note', async () => {
    const html = await render('inserted\none\ntwo\nthree');
    expect(html).toContain('moved'); expect(html).not.toContain('These lines changed since');
  });
  it('shows the saved anchor when the lines changed', async () => {
    const html = await render('one\nedited\nthree');
    expect(html).toContain('These lines changed since'); expect(html).toContain('two\nthree');
  });
});
