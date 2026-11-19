import { createElement, createRef, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cn } from '../lib/utils.js';
import { readFileSync } from 'node:fs';
import { CardFrame, Composer, foldSurface, FreshDot, Mark, KindLabel, KIND_LABEL, Pill, rowSurface, StepCheck, type KindLabelKind, type PillTone } from './index.js';

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

/** The small pieces of the design module (DS4). The cards' golden markup pins them in place; these pin each piece on its own. */
describe('Pill', () => {
  it('puts a given class first, as the cards wrote shrink-0', () => {
    expect(html(createElement(Pill, { className: 'shrink-0' }, 'x')))
      .toBe('<span class="shrink-0 inline-flex items-center rounded-sm px-1.5 text-xs font-medium leading-4 bg-muted text-muted-foreground">x</span>');
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
      const out = html(createElement(Pill, { tone: tone as PillTone }, 'x'));
      expect(out).toBe(`<span class="inline-flex items-center rounded-sm px-1.5 text-xs font-medium leading-4 ${classes}">x</span>`);
      expect(out).not.toContain('text-[10.5px]');
    }
  });
});

describe('KindLabel', () => {
  const kinds: KindLabelKind[] = ['note', 'commit', 'picture', 'html', 'pdf', 'markdown', 'other'];

  it('draws a hidden icon and the word, muted, at the Board\'s meta size, with no box', () => {
    for (const kind of kinds) {
      const out = html(createElement(KindLabel, { kind }));
      expect(out.startsWith(`<span class="${KIND_LABEL}"><svg `)).toBe(true);
      expect(out).toMatch(/<svg [^>]*aria-hidden="true"/);
      expect(out).toMatch(/<svg [^>]*class="[^"]*size-3\.5/);
      expect(out.endsWith(`</svg>${kind}</span>`)).toBe(true);
    }
    expect(KIND_LABEL).toContain('text-[length:var(--type-board-meta-size)]');
    expect(KIND_LABEL).toContain('font-normal');
    expect(KIND_LABEL).toContain('text-muted-foreground');
    expect(KIND_LABEL).not.toMatch(/\b(bg-|border|rounded|px-|py-)/);
  });

  it('gives each kind its own icon and takes a given class last', () => {
    const icons = new Set(kinds.map((kind) => /<svg .*<\/svg>/.exec(html(createElement(KindLabel, { kind })))?.[0]));
    expect(icons.size).toBe(kinds.length);
    expect(html(createElement(KindLabel, { kind: 'commit', className: 'mt-1' }))).toMatch(/^<span class="inline-flex [^"]* mt-1"><svg/);
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

describe('StepCheck (DS5b)', () => {
  const base = { label: 'Mark "Ship" done', title: 'Mark "Ship" done', disabled: false, busy: false, pressable: true, testId: 'step-checkbox-ship', onToggle: () => {} };
  const FRAME = 'flex size-6 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1';
  const CHECK = '<svg class="size-3.5" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="3" viewBox="0 0 24 24" width="24"><path d="M5.252 12.7 10.2 18.63 18.748 5.37"></path></svg>';

  it('draws the unchecked box as the rows do today, with the caller\'s classes first', () => {
    expect(html(createElement(StepCheck, { ...base, checked: false, className: 'nodrag nopan' })))
      .toBe(`<button type="button" role="checkbox" data-testid="step-checkbox-ship" aria-checked="false" aria-label="Mark &quot;Ship&quot; done" title="Mark &quot;Ship&quot; done" class="nodrag nopan ${FRAME} border-muted-foreground/40 bg-background hover:border-primary cursor-pointer"></button>`);
  });

  it('draws the checked box with the check icon', () => {
    expect(html(createElement(StepCheck, { ...base, checked: true, label: 'Mark "Ship" not done', title: 'Mark "Ship" not done' })))
      .toBe(`<button type="button" role="checkbox" data-testid="step-checkbox-ship" aria-checked="true" aria-label="Mark &quot;Ship&quot; not done" title="Mark &quot;Ship&quot; not done" class="${FRAME} border-primary bg-primary text-primary-foreground cursor-pointer">${CHECK}</button>`);
  });

  it('dims and never shows a pointer while busy, even when pressable', () => {
    const out = html(createElement(StepCheck, { ...base, checked: false, busy: true, disabled: true }));
    expect(out).toContain('opacity-50 cursor-not-allowed');
    expect(out).not.toContain('cursor-pointer');
    expect(out).toContain(' disabled=""');
  });

  it('has a pointer only when pressable, and is disabled only when told', () => {
    const quiet = html(createElement(StepCheck, { ...base, checked: false, pressable: false }));
    expect(quiet).not.toContain('cursor-pointer');
    expect(quiet).not.toContain('disabled');
    expect(html(createElement(StepCheck, { ...base, checked: false, disabled: true }))).toContain(' disabled=""');
  });

  it('shows the label as the name and the title as the tooltip, which can differ', () => {
    const out = html(createElement(StepCheck, { ...base, checked: false, title: 'Could not save' }));
    expect(out).toContain('aria-label="Mark &quot;Ship&quot; done"');
    expect(out).toContain('title="Could not save"');
  });

  it('presses through onToggle and stops the click from reaching the row, but not while busy', () => {
    const press = (props: { busy: boolean }) => {
      const calls: string[] = [];
      const element = StepCheck({ ...base, checked: false, busy: props.busy, onToggle: () => calls.push('toggle') });
      const onClick = (element.props as { onClick: (event: { stopPropagation: () => void }) => void }).onClick;
      onClick({ stopPropagation: () => calls.push('stop') });
      return calls;
    };
    expect(press({ busy: false })).toEqual(['stop', 'toggle']);
    expect(press({ busy: true })).toEqual(['stop']);
  });
});

describe('RowSurface (DS5b)', () => {
  const NOW = 'rounded-xl border border-l-4 border-primary/40 border-l-state-now bg-gradient-to-r from-state-now/10 via-primary/5 to-transparent px-3';
  const set = (value: string) => value.split(/\s+/).sort();

  it('draws the Now surface with its left rule, and a quiet row without one', () => {
    expect(rowSurface({ now: true })).toBe(NOW);
    expect(rowSurface({ now: false })).toBe('rounded-lg px-1');
    expect(rowSurface({ now: false })).not.toContain('border-l-state-now');
    expect(rowSurface({ now: true, hover: 'hover:bg-primary/5' })).toBe(`${NOW} hover:bg-primary/5`);
  });

  it('keeps the stripe: twMerge drops no class of the Now surface, in any caller\'s composition', () => {
    expect(set(cn('relative flex', rowSurface({ now: true }), 'text-left'))).toEqual(set(`relative flex ${NOW} text-left`));
    expect(rowSurface({ now: true })).toContain('border-l-4 border-primary/40 border-l-state-now');
  });

  it('draws the folded row in the order the fold has always had', () => {
    expect(foldSurface(true)).toBe('rounded-xl border px-3 text-left hover:bg-accent/30 border-primary/40 bg-gradient-to-r from-state-now/10 via-primary/5 to-transparent border-l-4 border-l-state-now');
    expect(foldSurface(false)).toBe('rounded-xl border px-3 text-left hover:bg-accent/30 border-border/60 bg-card/50');
  });

  // The two step-row sites that write the Now surface in a different order than the helper (not in any golden snapshot): the class SET after
  // twMerge must be the same as before. (Proof (a) of the packet; computed style and pictures are proofs (b) and (c).)
  it('keeps each moved site\'s class set after twMerge (the class-order proof)', () => {
    const was = {
      head: cn('relative flex h-full w-full items-center gap-2 overflow-hidden text-left', 'rounded-xl border border-primary/40 bg-gradient-to-r from-state-now/10 via-primary/5 to-transparent px-3 border-l-4 border-l-state-now hover:bg-primary/5'),
      headQuiet: cn('relative flex h-full w-full items-center gap-2 overflow-hidden text-left', 'rounded-lg px-1'),
      toggle: cn('board-row-control nodrag nopan relative flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left', 'rounded-xl border border-primary/40 bg-gradient-to-r from-state-now/10 via-primary/5 to-transparent px-3 hover:bg-primary/10 border-l-4 border-l-state-now'),
      toggleQuiet: cn('board-row-control nodrag nopan relative flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left', 'rounded-lg px-1 hover:bg-accent/30'),
    };
    const now = {
      head: cn('relative flex h-full w-full items-center gap-2 overflow-hidden text-left', rowSurface({ now: true, hover: 'hover:bg-primary/5' })),
      headQuiet: cn('relative flex h-full w-full items-center gap-2 overflow-hidden text-left', rowSurface({ now: false })),
      toggle: cn('board-row-control nodrag nopan relative flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left', rowSurface({ now: true, hover: 'hover:bg-primary/10' })),
      toggleQuiet: cn('board-row-control nodrag nopan relative flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left', rowSurface({ now: false, hover: 'hover:bg-accent/30' })),
    };
    for (const key of Object.keys(was) as (keyof typeof was)[]) {
      expect(set(now[key]), key).toEqual(set(was[key]));
    }
    expect(set(was.head)).toContain('border-l-state-now');
  });
});

/**
 * Composer (DS6). The note dialog's body was a hand-built textarea; these strings are copied from that code at HEAD (565857e), so
 * the piece must draw exactly what the dialog drew. No test renders the dialog itself (its portal draws nothing on the server);
 * the real app's `outerHTML` before and after is the second proof (DS6 report).
 */
describe('Composer (DS6)', () => {
  const BASE = 'w-full min-h-[140px] max-h-[260px] rounded-lg border border-input bg-background p-3 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/72 outline-none transition-shadow';
  const FOCUS = 'focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/20 resize-y';
  const dialog = { id: 'body-1', name: 'body', placeholder: 'Write Markdown, lists, notes, or links...', maxLength: 4000, rows: 5, onChange: () => undefined };
  // What the dialog wrote, class order and all (cn of the three strings, the font last)
  const wasClass = (mono: boolean) => cn(BASE, FOCUS, mono ? 'font-mono text-[12.5px]' : 'font-sans');

  it('draws the note dialog\'s body textarea byte for byte, in sans', () => {
    expect(html(createElement(Composer, { ...dialog, value: 'Hello' })))
      .toBe(`<textarea id="body-1" name="body" placeholder="Write Markdown, lists, notes, or links..." maxLength="4000" rows="5" class="${wasClass(false)}">Hello</textarea>`);
    expect(wasClass(false)).toBe(`${BASE} ${FOCUS} font-sans`);
  });

  it('draws the mono font as the dialog did: the font-mono class and 12.5 px replace the 13 px, the rest stays', () => {
    const out = html(createElement(Composer, { ...dialog, value: '', mono: true }));
    expect(out).toBe(`<textarea id="body-1" name="body" placeholder="Write Markdown, lists, notes, or links..." maxLength="4000" rows="5" class="${wasClass(true)}"></textarea>`);
    expect(wasClass(true)).toContain('font-mono text-[12.5px]');
    expect(wasClass(true)).not.toContain('text-[13px]');
    expect(wasClass(true)).not.toContain('font-sans');
  });

  it('shows the value it is given, escaped, and nothing it was not given (no default rows, no default length)', () => {
    expect(html(createElement(Composer, { value: 'a <b> & c', onChange: () => undefined })))
      .toBe(`<textarea class="${wasClass(false)}">a &lt;b&gt; &amp; c</textarea>`);
  });

  it('passes disabled, required, aria-*, key handlers and autoFocus through', () => {
    const onKeyDown = () => undefined;
    const out = html(createElement(Composer, { value: '', onChange: () => undefined, disabled: true, 'aria-label': 'Your note', 'aria-describedby': 'hint', onKeyDown, required: true }));
    expect(out).toContain(' disabled=""');
    expect(out).toContain(' aria-label="Your note"');
    expect(out).toContain(' aria-describedby="hint"');
    expect(out).toContain(' required=""');
    const element = Composer({ value: '', onChange: () => undefined, onKeyDown, autoFocus: true }) as ReactElement<Record<string, unknown>>;
    expect(element.props.onKeyDown).toBe(onKeyDown);
    expect(element.props.autoFocus).toBe(true);
  });

  it('gives onChange the new text as a string, not the event', () => {
    const got: unknown[] = [];
    const element = Composer({ value: 'old', onChange: (value) => got.push(value) }) as ReactElement<{ onChange: (event: { target: { value: string } }) => void; value: string }>;
    expect(element.props.value).toBe('old');
    element.props.onChange({ target: { value: 'new text\nsecond line' } });
    element.props.onChange({ target: { value: '' } });
    expect(got).toEqual(['new text\nsecond line', '']);
  });

  it('hands the ref to the textarea (React 19 takes ref as a prop)', () => {
    const ref = createRef<HTMLTextAreaElement>();
    const element = Composer({ value: '', onChange: () => undefined, ref }) as ReactElement<{ ref: unknown }>;
    expect(element.type).toBe('textarea');
    expect(element.props.ref).toBe(ref);
  });

  it('draws a caller\'s class last, where it wins over the field\'s own', () => {
    expect(html(createElement(Composer, { value: '', onChange: () => undefined, className: 'min-h-[200px] extra' })))
      .toBe(`<textarea class="${cn(wasClass(false), 'min-h-[200px] extra')}"></textarea>`);
    expect(cn(wasClass(false), 'min-h-[200px] extra')).toContain('min-h-[200px]');
    expect(cn(wasClass(false), 'min-h-[200px] extra')).not.toContain('min-h-[140px]');
  });
});

/** The Hairline card frame (R1a): the frame's classes in each state, and the tokens they use. */
describe('CardFrame, Hairline', () => {
  const classes = (props: Parameters<typeof CardFrame>[0] extends infer P ? Partial<P> : never = {}) =>
    /<article[^>]*? class="([^"]*)"/.exec(html(createElement(CardFrame, { labelledBy: 't', ...props }, 'x')))![1]!.split(' ');
  const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

  it('has 8 px corners, a 1 px border and no shadow at rest, in a plain card', () => {
    const c = classes();
    expect(c).toContain('rounded-card');
    expect(c).toContain('border');
    expect(c).toContain('border-border');
    expect(c).toContain('bg-card');
    expect(c.filter((name) => /^shadow-/.test(name) || /^ring/.test(name) || name === 'rounded-xl')).toEqual([]);
  });

  it('animates the border, shadow, lift (the `translate` property, not `transform`) and the pressable tint', () => {
    const transition = classes().find((name) => name.startsWith('transition-['))!;
    for (const property of ['border-color', 'box-shadow', 'translate', 'background-color']) expect(transition).toContain(property);
    expect(transition).not.toContain('transform');
  });

  it('lifts 1 px, shows its hover shadow and takes the hover border only on hover, and the motion only without reduced motion', () => {
    const c = classes();
    expect(c).toContain('hover:border-border-hover');
    expect(c).toContain('motion-safe:hover:-translate-y-px');
    expect(c).toContain('motion-safe:hover:shadow-card-hover');
    expect(c).toContain('duration-120');
    expect(c).toContain('ease-out');
    expect(c.filter((name) => /^hover:(shadow|-translate)/.test(name))).toEqual([]);
  });

  it('keeps a primary border for pinned, even on hover', () => {
    const c = classes({ pinned: true });
    expect(c).toContain('border-primary/50');
    expect(c.filter((name) => name.includes('border-border'))).toEqual([]);
  });

  it('is dashed, muted and at 70 % when archived, and archived wins over pinned', () => {
    for (const c of [classes({ archived: true }), classes({ archived: true, pinned: true })]) {
      expect(c).toEqual(expect.arrayContaining(['border-dashed', 'border-border/70', 'bg-muted/70', 'text-muted-foreground']));
      expect(c).not.toContain('border-primary/50');
      // No opacity on the card: it would weaken the text, the focus ring and the reading mark.
      expect(c.filter((name) => /(^|:)opacity-/.test(name))).toEqual([]);
    }
    expect(classes({ archived: true, compact: true, reading: true })).toEqual(expect.arrayContaining(['has-[:focus-visible]:ring-2', 'has-[:focus-visible]:ring-ring', 'outline-primary']));
    expect(classes({ archived: true, compact: true, reading: true }).filter((name) => /(^|:)opacity-/.test(name))).toEqual([]);
  });

  it('is a 1 px primary border plus a 1 px inner ring when reading, not the old ring-2', () => {
    const c = classes({ reading: true });
    expect(c).toEqual(expect.arrayContaining(['border-primary', 'hover:border-primary', 'outline-1', '-outline-offset-2', 'outline-primary']));
    expect(c).not.toContain('ring-2');
    expect(c).not.toContain('hover:border-border-hover');
  });

  it('keeps the keyboard ring (2 px --ring) on a compact card, and a pressable card is still a brick', () => {
    expect(classes({ compact: true })).toEqual(expect.arrayContaining(['has-[:focus-visible]:ring-2', 'has-[:focus-visible]:ring-ring']));
    expect(classes({ onPress: () => {} })).toEqual(expect.arrayContaining(['board-brick', 'cursor-pointer']));
  });

  it('draws only with tokens that exist: the radius, shadow, hover border and divider, and the type scales', () => {
    for (const [name, value] of [['--r-sm', '4px'], ['--r-md', '6px'], ['--r-lg', '8px'], ['--r-xl', '12px'], ['--r-full', '9999px'],
      ['--shadow-hover', '0 1px 2px rgb(0 0 0 / .06)'], ['--shadow-raised', '0 8px 24px rgb(0 0 0 / .12)'], ['--border-hover', '#afb8c1']] as const) {
      expect(tokens, name).toContain(`${name}: ${value};`);
    }
    for (const [name, value] of [['--shadow-hover', '0 1px 2px rgb(0 0 0 / .4)'], ['--shadow-raised', '0 8px 24px rgb(0 0 0 / .5)'], ['--border-hover', '#484f58']] as const) {
      expect(tokens, `${name} in dark`).toContain(`    ${name}: ${value};`);
    }
    expect(tokens).toContain('--divider: color-mix(in srgb, var(--border) 60%, transparent);');
    expect(tokens).toContain('--radius-card: var(--r-lg);');
    expect(tokens).toContain('--shadow-card-hover: var(--shadow-hover);');
    expect(tokens).toContain('--color-border-hover: var(--border-hover);');
    for (const kind of ['area-title', 'panel-title', 'card-title', 'ui', 'reading', 'meta', 'label']) {
      for (const part of ['size', 'leading']) {
        expect(tokens, `--type-${kind}-${part}`).toContain(`--type-${kind}-${part}:`);
        expect(tokens, `--type-board-${kind}-${part}`).toContain(`--type-board-${kind}-${part}:`);
      }
      expect(tokens, `--type-${kind}-weight`).toContain(`--type-${kind}-weight:`);
    }
    expect(tokens).toContain('--type-board-meta-size: 13.5px;');
  });
});
