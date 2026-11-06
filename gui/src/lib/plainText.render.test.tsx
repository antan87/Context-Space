import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InlinePlanMarkdown } from '../components/InlinePlanMarkdown.js';
import { plainText } from './plainText.js';

/** The words the styled text shows: the markup without its tags, with an image as its alt text, as a reader sees them. */
const shown = (content: string) => renderToStaticMarkup(<InlinePlanMarkdown content={content} />)
  .replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

describe('InlinePlanMarkdown shows the same words as plainText', () => {
  it.each([
    '`__init__.py`', '`rm -rf src/**/*.ts`', '`a*b` times `c*d`', 'Set `FOO_BAR__BAZ`', '5 * 3 * 2', '[docs](https://x.test/a_(b)_c) now',
    '![pic](a.png)', 'snake_case_name', '**bold** and __bold__ and *em*', 'Run `npm test` and *then* _again_',
  ])('%s', (input) => {
    expect(shown(input)).toBe(plainText(input));
  });
});
