import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { needsSurface } from '../../design/index';
import { PlanQuestionBar, type PlanQuestionBarProps } from './StripNotices';

const item = { id: 'q', title: 'Which cache backend?', context: 'Codex asked 3 min ago · holds up Add cache tests', detail: 'It is cheap to change now.\nSuggested answers: Redis · Memory' } as unknown as PlanQuestionBarProps['item'];
const html = (extra: Partial<PlanQuestionBarProps> = {}) => renderToStaticMarkup(createElement(PlanQuestionBar, { item, more: 2, busy: false, onAnswer: async () => true, onShowAll: () => {}, ...extra }));

describe('PlanQuestionBar look (R1e)', () => {
  it('is a needs-rule card with no fill and no needs-coloured border', () => {
    const out = html();
    const group = out.match(/<div role="group" aria-label="A question in the plan waits for your answer" class="([^"]*)"/)?.[1] ?? '';
    for (const cls of needsSurface().split(' ')) expect(group.split(' ')).toContain(cls);
    expect(group).toContain('mx-2');
    expect(group).not.toMatch(/color-mix|border-t|state-needs\)_/);
  });

  it('draws suggested answers as chips and keeps its texts at 12 px', () => {
    const out = html();
    expect(out).toMatch(/<button[^>]*rounded-chip[^>]*>Redis<\/button>/);
    expect(out).toMatch(/<button[^>]*rounded-chip[^>]*>Memory<\/button>/);
    expect(out).not.toMatch(/<p class="[^"]*text-\[11px\]/);
    expect(out).not.toContain('text-[11px] text-muted-foreground');
    expect(out).toContain('2 more wait for you');
  });
});
