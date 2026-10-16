import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A rule outside every @layer beats every Tailwind utility, whatever its specificity. The app's global focus ring
 * used to be one, so `outline-none` on a field never took effect and a focused input drew its own ring and the
 * outline of this rule on top of it. These checks keep that rule where utilities can replace it.
 */
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level blocks: their selector or at-rule, and their body. */
function topLevelBlocks(source: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  let depth = 0;
  let bodyStart = 0;
  let selectorStart = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '{') {
      if (depth === 0) bodyStart = index + 1;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        out.push({ selector: source.slice(selectorStart, bodyStart - 1).trim(), body: source.slice(bodyStart, index) });
        selectorStart = index + 1;
      }
    } else if (char === ';' && depth === 0) {
      selectorStart = index + 1;
    }
  }
  return out;
}

describe('the global focus ring', () => {
  const blocks = topLevelBlocks(css);

  it('is not declared outside a layer, where it would override component styles', () => {
    const unlayered = blocks.filter((block) => !block.selector.startsWith('@') && /(^|[\s,>+~])(:where\()?:focus(-visible)?\)?$/.test(block.selector));
    expect(unlayered.map((block) => block.selector)).toEqual([]);
  });

  it('sits in the base layer with no specificity, so `outline-none` and ring utilities replace it', () => {
    const base = blocks.filter((block) => block.selector === '@layer base').map((block) => block.body).join('\n');
    expect(base).toMatch(/:where\(:focus-visible\)\s*\{[^}]*outline:\s*2px solid var\(--ring\)/);
  });

  it('does not reshape the focused element', () => {
    const rule = /:where\(:focus-visible\)\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toBeDefined();
    expect(rule![1]).not.toMatch(/border-radius/);
  });
});
