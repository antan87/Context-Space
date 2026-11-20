import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Mechanical contrast gate for the progress colours and the Dusk palette. It
 * reads the real index.css with the design tokens it imports (design/tokens.css), applies the cascade the way the browser does for
 * each palette and theme, resolves var() and color-mix(), and checks WCAG
 * contrast. Text needs 4.5:1. Graphics that carry meaning (the ring's arcs and
 * its "you are here" marker) need 3:1.
 */
/** The stylesheet with its local `@import "./….css"` lines replaced by the imported file, in place, so the rules come in the order the browser's cascade sees them. */
function readCssWithImports(url: URL): string {
  return readFileSync(url, 'utf8').replace(/^@import "(\.[^"]+\.css)";$/gm, (_all, file: string) => readCssWithImports(new URL(file, url)));
}
const css = readCssWithImports(new URL('../../index.css', import.meta.url));

interface Rule { dark: boolean; palette?: string; specificity: number; order: number; declarations: Record<string, string> }

/** Splits a stylesheet into top-level blocks, keeping nested blocks as children. */
function blocks(source: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  let depth = 0; let start = 0; let selectorStart = 0;
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '{') {
      if (depth === 0) { start = i + 1; }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        out.push({ selector: cleaned.slice(selectorStart, start - 1).trim(), body: cleaned.slice(start, i) });
        selectorStart = i + 1;
      }
    } else if (ch === ';' && depth === 0) {
      selectorStart = i + 1;
    }
  }
  return out;
}

function declarationsOf(body: string): Record<string, string> {
  // Drop nested blocks so only this rule's own declarations remain.
  let flat = ''; let depth = 0;
  for (const ch of body) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (depth === 0) flat += ch;
  }
  const out: Record<string, string> = {};
  for (const match of flat.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[match[1]!] = match[2]!.trim();
  return out;
}

function parseRules(): Rule[] {
  const rules: Rule[] = [];
  let order = 0;
  for (const { selector, body } of blocks(css)) {
    if (selector.startsWith('@')) continue;
    for (const single of selector.split(',').map((part) => part.trim())) {
      const m = /^:root(\.dark)?(?:\[data-color-theme="([a-z]+)"\])?$/.exec(single);
      if (!m) continue;
      const rule = { dark: Boolean(m[1]), palette: m[2], specificity: 1 + (m[1] ? 1 : 0) + (m[2] ? 1 : 0) };
      rules.push({ ...rule, order: order++, declarations: declarationsOf(body) });
      // The default palette keeps its dark values in a nested `@variant dark` block.
      for (const nested of blocks(body)) {
        if (nested.selector === '@variant dark') {
          rules.push({ dark: true, palette: m[2], specificity: rule.specificity + 1, order: order++, declarations: declarationsOf(nested.body) });
        }
      }
    }
  }
  return rules;
}

const rules = parseRules();

function tokensFor(palette: string, theme: 'light' | 'dark'): Record<string, string> {
  return Object.assign({}, ...rules
    .filter((rule) => (!rule.dark || theme === 'dark') && (!rule.palette || rule.palette === palette))
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order)
    .map((rule) => rule.declarations));
}

type Rgb = [number, number, number];

function splitTopLevel(text: string): string[] {
  const parts: string[] = []; let depth = 0; let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += ch;
  }
  parts.push(current.trim());
  return parts;
}

function resolve(value: string, tokens: Record<string, string>, seen: string[] = []): Rgb {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb;
  const ref = /^var\((--[a-z0-9-]+)\)$/i.exec(v);
  if (ref) {
    if (seen.includes(ref[1]!)) throw new Error(`circular token ${ref[1]}`);
    const next = tokens[ref[1]!];
    if (next === undefined) throw new Error(`token ${ref[1]} is not defined`);
    return resolve(next, tokens, [...seen, ref[1]!]);
  }
  const mix = /^color-mix\(in srgb,(.*)\)$/i.exec(v);
  if (mix) {
    const [a, b] = splitTopLevel(mix[1]!).map((arg) => {
      const m = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(arg)!;
      return { color: resolve(m[1]!, tokens, seen), pct: m[2] === undefined ? undefined : Number(m[2]) };
    });
    const wa = a!.pct ?? (b!.pct === undefined ? 50 : 100 - b!.pct);
    const wb = b!.pct ?? (100 - wa);
    const total = wa + wb;
    return a!.color.map((c, i) => (c * wa + b!.color[i]! * wb) / total) as Rgb;
  }
  throw new Error(`cannot resolve "${v}"`);
}

const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const PALETTES = ['sunset', 'aurora', 'forest', 'nebula', 'glacier', 'dusk'];
const THEMES = ['light', 'dark'] as const;
const STATE_TEXT = ['--state-needs', '--state-ai', '--state-done', '--state-reopened'];
const TONES = Array.from({ length: 7 }, (_, i) => `--ring-t${i}`);

describe('the stylesheet reader', () => {
  it('finds the palette blocks and resolves a dark default palette value', () => {
    expect(tokensFor('sunset', 'dark')['--background']).toBe('#090d13');
    expect(tokensFor('sunset', 'light')['--background']).toBe('#f6f8fa');
    expect(tokensFor('aurora', 'dark')['--background']).toBe('#070f1b');
  });

  it('lets a later, more specific block win, as the browser does', () => {
    // The dark progress tokens come last and must beat every palette's light block.
    expect(tokensFor('aurora', 'dark')['--state-needs']).toBe('#fb923c');
    expect(tokensFor('aurora', 'light')['--state-needs']).toBe('#ad370a');
  });
});

describe('the dark progress block beats the palettes that set the sunset ring colours', () => {
  it.each(['sunset', 'dusk'])('%s in dark takes the brand colours for the ring and the dark orange for "waits for you"', (palette) => {
    const tokens = tokensFor(palette, 'dark');
    expect([tokens['--ring-a'], tokens['--ring-b'], tokens['--ring-c']]).toEqual(['var(--brand-first)', 'var(--brand-middle)', 'var(--brand-last)']);
    expect(tokens['--state-needs']).toBe('#fb923c');
  });
});

describe.each(PALETTES.flatMap((palette) => THEMES.map((theme) => [palette, theme] as const)))('an archived card in %s %s', (palette, theme) => {
  it('keeps muted text at 4.5:1 on the muted surface at 70 % over the background', () => {
    const tokens = tokensFor(palette, theme);
    const surface = resolve('color-mix(in srgb, var(--muted) 70%, var(--background))', tokens);
    expect(contrast(resolve(tokens['--muted-foreground']!, tokens), surface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('Dusk is a complete palette', () => {
  it.each(THEMES)('defines every surface and action token in %s', (theme) => {
    const tokens = tokensFor('dusk', theme);
    const own = Object.assign({}, ...rules.filter((r) => r.palette === 'dusk' && (theme === 'dark' ? r.dark : !r.dark)).map((r) => r.declarations));
    for (const name of ['--background', '--foreground', '--card', '--card-foreground', '--popover', '--popover-foreground',
      '--primary', '--primary-foreground', '--secondary', '--secondary-foreground', '--muted', '--muted-foreground',
      '--accent', '--accent-foreground', '--border', '--input', '--ring']) {
      expect(own[name], `${name} in dusk ${theme}`).toBeDefined();
      expect(tokens[name]).toBe(own[name]);
    }
  });

  it('keeps the approved sunset brand colours', () => {
    const tokens = tokensFor('dusk', 'dark');
    expect([tokens['--brand-first'], tokens['--brand-middle'], tokens['--brand-last'], tokens['--brand-depth']])
      .toEqual(['#fde047', '#fb923c', '#f43f5e', '#6366f1']);
  });
});

describe.each(THEMES)('Dusk text contrast in %s theme', (theme) => {
  const tokens = tokensFor('dusk', theme);
  const text: Array<[string, string]> = [
    ['--foreground', '--background'], ['--card-foreground', '--card'], ['--popover-foreground', '--popover'],
    ['--muted-foreground', '--background'], ['--muted-foreground', '--card'], ['--muted-foreground', '--muted'],
    ['--primary-foreground', '--primary'], ['--secondary-foreground', '--secondary'], ['--accent-foreground', '--accent'],
  ];
  it.each(text)('%s on %s reaches 4.5:1', (fg, bg) => {
    expect(contrast(resolve(tokens[fg]!, tokens), resolve(tokens[bg]!, tokens))).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each(PALETTES.flatMap((palette) => THEMES.map((theme) => [palette, theme] as const)))('progress colours in %s %s', (palette, theme) => {
  const tokens = tokensFor(palette, theme);
  const surfaces = ['--background', '--card'] as const;

  it.each(STATE_TEXT.flatMap((state) => surfaces.map((surface) => [state, surface] as const)))('%s reads as text on %s (4.5:1)', (state, surface) => {
    expect(contrast(resolve(tokens[state]!, tokens), resolve(tokens[surface]!, tokens))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(TONES.flatMap((tone) => surfaces.map((surface) => [tone, surface] as const)))('ring arc %s is visible on %s (3:1)', (tone, surface) => {
    expect(contrast(resolve(tokens[tone]!, tokens), resolve(tokens[surface]!, tokens))).toBeGreaterThanOrEqual(3);
  });

  it.each(surfaces)('the "you are here" marker is visible on %s (3:1)', (surface) => {
    expect(contrast(resolve(tokens['--state-now']!, tokens), resolve(tokens[surface]!, tokens))).toBeGreaterThanOrEqual(3);
  });

  // R1c: the Now row's 3 px rule is the only colour of the row, so it must stand out from the card it sits on and from the canvas around it.
  it.each(surfaces)('the Now row\'s 3 px rule (--state-now) is visible on %s (3:1)', (surface) => {
    expect(contrast(resolve(tokens['--state-now']!, tokens), resolve(tokens[surface]!, tokens))).toBeGreaterThanOrEqual(3);
  });

  // R1d: the Waits for you box's 3 px rule is its only colour, so it must stand out from the card it sits on and from the canvas around it.
  it.each(surfaces)('the Waits for you box\'s 3 px rule (--state-needs) is visible on %s (3:1)', (surface) => {
    expect(contrast(resolve(tokens['--state-needs']!, tokens), resolve(tokens[surface]!, tokens))).toBeGreaterThanOrEqual(3);
  });

  // Fix round 1: a hovered row on the card must move away from the card the right way: lighter in dark, darker in light, never toward the canvas.
  it.each([['--accent', 30], ['--primary', 10], ['--primary', 5]] as const)('a row hover of %s at %s %% over the card moves away from the card the right way', (token, pct) => {
    const card = resolve(tokens['--card']!, tokens);
    const mixed = resolve(`color-mix(in srgb, var(${token}) ${pct}%, var(--card))`, tokens);
    if (theme === 'dark') expect(luminance(mixed)).toBeGreaterThan(luminance(card));
    else expect(luminance(mixed)).toBeLessThan(luminance(card));
  });

  it('keeps arcs that are still ahead faintly visible against the card (1.2:1) without competing with finished ones', () => {
    const card = resolve(tokens['--card']!, tokens);
    const dim = contrast(resolve(tokens['--ring-dim']!, tokens), card);
    expect(dim).toBeGreaterThanOrEqual(1.2);
    for (const tone of TONES) expect(contrast(resolve(tokens[tone]!, tokens), card)).toBeGreaterThan(dim);
  });
});
