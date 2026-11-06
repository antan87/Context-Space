import { describe, expect, it } from 'vitest';
import { plainText, stripHeadingColon } from './plainText.js';

describe('plainText', () => {
  it('drops bold, code, emphasis, links and a heading\'s trailing colon, and keeps the words', () => {
    expect(plainText('**End-User Tester Audit & Co-Working Polish**:')).toBe('End-User Tester Audit & Co-Working Polish');
    expect(plainText('Run `npm test` and *then* _again_')).toBe('Run npm test and then again');
    expect(plainText('See [the docs](https://x.test/a_b) now')).toBe('See the docs now');
    expect(plainText('**Slice A: Purge** (706fc9f)')).toBe('Slice A: Purge (706fc9f)');
  });
  it('leaves underscores inside words and plain text alone', () => {
    expect(plainText('rename snake_case_name to camelCase')).toBe('rename snake_case_name to camelCase');
    expect(plainText('Plain step')).toBe('Plain step');
    expect(plainText('')).toBe('');
  });
  it.each([
    ['`__init__.py`', '__init__.py'],
    ['`rm -rf src/**/*.ts`', 'rm -rf src/**/*.ts'],
    ['`a*b` times `c*d`', 'a*b times c*d'],
    ['Set `FOO_BAR__BAZ`', 'Set FOO_BAR__BAZ'],
    ['5 * 3 * 2', '5 * 3 * 2'],
    ['[docs](https://x.test/a_(b)_c) now', 'docs now'],
    ['![pic](a.png)', 'pic'],
    ['snake_case_name', 'snake_case_name'],
    ['**bold** and __bold__ and *em*', 'bold and bold and em'],
  ])('keeps legitimate text: %s', (input, expected) => {
    expect(plainText(input)).toBe(expected);
  });
});

describe('stripHeadingColon', () => {
  it('removes a trailing colon outside or inside the closing marks and keeps the marks', () => {
    expect(stripHeadingColon('**Slice C**:')).toBe('**Slice C**');
    expect(stripHeadingColon('**Slice C:**')).toBe('**Slice C**');
    expect(stripHeadingColon('Slice C :')).toBe('Slice C');
    expect(stripHeadingColon('Slice C: Purge')).toBe('Slice C: Purge');
  });
});
