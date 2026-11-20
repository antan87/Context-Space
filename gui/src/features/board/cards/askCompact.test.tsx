import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseFixtures, CardContexts, FIXED_NOW, FIXTURE_ACTIONS } from './cardFixtures.js';
import type { BoardActions } from '../boardActions.js';

/** "Ask in CLI" on the compact cards the Board really draws in an Area: the same conditions as the full card's button. */
const FIXTURES = baseFixtures(FIXED_NOW);

function render(key: string, data: Record<string, unknown> = {}, actions: BoardActions = FIXTURE_ACTIONS): string {
  const fixture = FIXTURES.find((entry) => entry.key === key);
  if (!fixture) throw new Error(`No fixture ${key}`);
  const props = { ...fixture.props, data: { ...fixture.props.data, ...data } } as NodeProps;
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(ReactFlowProvider, null, createElement(CardContexts, { now: FIXED_NOW, actions, children: createElement(fixture.Component as ComponentType<NodeProps>, props) }))));
}

const CASES: Array<{ name: string; key: string; data: Record<string, unknown>; label: string; fileCard: boolean }> = [
  { name: 'a compact document row', key: 'file.compactDocumentRow', data: { readOnly: false }, label: 'Ask in CLI about safety-net.md', fileCard: true },
  { name: 'a compact picture card', key: 'file.compactPicture', data: { readOnly: false }, label: 'Ask in CLI about Split screenshot', fileCard: true },
  { name: 'a compact file card', key: 'file.compactGeneric', data: {}, label: 'Ask in CLI about Architecture brief', fileCard: true },
  { name: 'a compact commit card', key: 'commit.compact', data: {}, label: 'Ask in CLI about commit abc1234', fileCard: false },
];

describe('Ask in CLI on a compact card', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    vi.stubGlobal('document', { documentElement: { classList: { contains: () => false } } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe.each(CASES)('$name', ({ key, data, label, fileCard }) => {
    it('has the action, named after the card, and outside its main press target', () => {
      const html = render(key, data);
      expect(html.match(/btn-ask-card/g)?.length).toBe(1);
      expect(html).toContain(`aria-label="${label}"`);
      // 28 px square: 25 px at the Area's 0.9 zoom. Shown on hover and focus, hidden at rest.
      expect(html).toMatch(/btn-ask-card[^"]*\bsize-7\b[^"]*\bopacity-0\b[^"]*group-hover:opacity-100/);
      // Hidden at rest it takes no press (touch, no hover), and the keyboard still reaches and shows it
      expect(html).toMatch(/btn-ask-card[^"]*\bpointer-events-none\b[^"]*focus-visible:pointer-events-auto[^"]*focus-visible:opacity-100[^"]*group-hover:pointer-events-auto/);
      // Never inside the card's main button: the main press target closes before the action begins.
      const main = html.match(/<button[^>]*data-card-main[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
      expect(main).not.toContain('btn-ask-card');
      expect(html.indexOf('btn-ask-card')).toBeGreaterThan(html.indexOf('data-card-main'));
    });
    it('is not drawn for a read-only workspace', () => {
      expect(render(key, data, { ...FIXTURE_ACTIONS, readOnly: true })).not.toContain('btn-ask-card');
    });
    it('is not drawn when there is no AI session to ask', () => {
      expect(render(key, data, { ...FIXTURE_ACTIONS, askInCLI: undefined })).not.toContain('btn-ask-card');
    });
    if (fileCard) {
      it('is drawn for a read-only card too (a generated workspace file): asking writes nothing to the board file', () => {
        const html = render(key, { ...data, readOnly: true });
        expect(html.match(/btn-ask-card/g)?.length).toBe(1);
        expect(html).toContain(`aria-label="${label}"`);
      });
    }
  });
});
