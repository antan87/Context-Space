import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FreshDot, Mark, Pill, PILL_LEGACY, type PillTone } from './index.js';

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

/** The small pieces of the design module (DS4). The cards' golden markup pins them in place; these pin each piece on its own. */
describe('Pill', () => {
  it('draws today\'s kind tag by default (the legacy look), whatever the tone', () => {
    const legacy = '<span class="rounded bg-muted/80 px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">note</span>';
    expect(PILL_LEGACY).toBe('rounded bg-muted/80 px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground');
    expect(html(createElement(Pill, null, 'note'))).toBe(legacy);
    expect(html(createElement(Pill, { tone: 'ai' }, 'note'))).toBe(legacy);
  });

  it('puts a given class first, as the cards wrote shrink-0', () => {
    expect(html(createElement(Pill, { className: 'shrink-0' }, 'commit')))
      .toBe('<span class="shrink-0 rounded bg-muted/80 px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">commit</span>');
  });

  it('keeps the text it is given', () => {
    expect(html(createElement(Pill, null, 'picture'))).toContain('>picture</span>');
  });

  it('has a hairline class for each of the seven tones, in the tone\'s own colour at 12 px', () => {
    const expected: Record<PillTone, string> = {
      neutral: 'bg-muted text-muted-foreground',
      accent: 'bg-primary/10 text-primary',
      ai: 'bg-state-ai/12 text-state-ai',
      needs: 'bg-state-needs/12 text-state-needs',
      done: 'bg-state-done/12 text-state-done',
      reopened: 'bg-state-reopened/12 text-state-reopened',
      warning: 'bg-warning/12 text-warning-foreground',
    };
    for (const [tone, classes] of Object.entries(expected)) {
      const out = html(createElement(Pill, { tone: tone as PillTone, look: 'hairline' }, 'x'));
      expect(out).toBe(`<span class="inline-flex items-center rounded-sm px-1.5 text-xs font-medium leading-4 ${classes}">x</span>`);
      expect(out).not.toContain('text-[10.5px]');
    }
  });
});

describe('Mark', () => {
  it('draws the AI tone as the cards do today', () => {
    expect(html(createElement(Mark, { ai: true, label: 'Claude, 5 min ago', id: 'm1' })))
      .toBe('<span id="m1" title="Claude, 5 min ago" class="rounded-full px-1.5 text-[12.5px] leading-4 bg-state-ai/12 font-medium text-state-ai"><span aria-hidden="true">AI</span><span class="sr-only">Claude, 5 min ago</span></span>');
  });

  it('draws the person tone as the cards do today', () => {
    expect(html(createElement(Mark, { ai: false, label: 'You, 5 min ago', id: 'm2' })))
      .toBe('<span id="m2" title="You, 5 min ago" class="rounded-full px-1.5 text-[12.5px] leading-4 text-muted-foreground"><span aria-hidden="true">you</span><span class="sr-only">You, 5 min ago</span></span>');
  });

  it('has no id when it is given none', () => {
    expect(html(createElement(Mark, { ai: true, label: 'x' }))).not.toContain(' id=');
  });
});

describe('FreshDot', () => {
  it('keeps its title and aria-hidden in the block form', () => {
    expect(html(createElement(FreshDot)))
      .toBe('<span class="size-1.5 shrink-0 rounded-full bg-primary" title="New since you looked" aria-hidden="true"></span>');
  });

  it('keeps its title and aria-hidden in the inline form', () => {
    expect(html(createElement(FreshDot, { inline: true })))
      .toBe('<span class="mr-1.5 inline-block size-1.5 shrink-0 rounded-full bg-primary align-middle" title="New since you looked" aria-hidden="true"></span>');
  });
});
