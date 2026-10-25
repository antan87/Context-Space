import { describe, expect, it } from 'vitest';
import { stripComments, findViolationsInContent, runChecks } from './check-no-any.mjs';

describe('check-no-any script', () => {
  describe('stripComments', () => {
    it('strips line comments while preserving line count', () => {
      const src = 'const x = 1; // any comment here\nconst y = 2;';
      const stripped = stripComments(src);
      expect(stripped.split('\n').length).toBe(2);
      expect(stripped).not.toContain('any comment');
      expect(stripped).toContain('const x = 1;');
      expect(stripped).toContain('const y = 2;');
    });

    it('strips block comments while preserving line count', () => {
      const src = 'const x = 1;\n/* this is any\n * multi-line comment\n */\nconst y = 2;';
      const stripped = stripComments(src);
      expect(stripped.split('\n').length).toBe(5);
      expect(stripped).not.toContain('this is any');
      expect(stripped).toContain('const y = 2;');
    });
  });

  describe('findViolationsInContent', () => {
    it('detects catch (...: any)', () => {
      const code = 'try { work(); } catch (err: any) { console.error(err); }';
      const violations = findViolationsInContent(code, 'src/test.ts', false);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('no-catch-any');
      expect(violations[0]!.line).toBe(1);
    });

    it('detects null as any bypass', () => {
      const code = 'function getModel() {\n  return null as any;\n}';
      const violations = findViolationsInContent(code, 'gui/src/model.ts', false);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('no-null-as-any');
      expect(violations[0]!.line).toBe(2);
    });

    it('detects explicit any type annotations when checkTypes is enabled', () => {
      const code = [
        'let a: any = 1;',
        'const b = obj as any;',
        'function test(x: Promise<any>) {}',
        'const list: any[] = [];',
        'interface Dict { [key: string]: any; }',
      ].join('\n');

      const violations = findViolationsInContent(code, 'gui/src/file.ts', true);
      expect(violations).toHaveLength(5);
      expect(violations.every((v) => v.rule === 'no-explicit-any')).toBe(true);
    });

    it('ignores words matching "any" inside comments', () => {
      const code = [
        '/**',
        ' * This function handles any given request.',
        ' */',
        '// Any comment here',
        'export function safe() { return true; }',
      ].join('\n');

      const violations = findViolationsInContent(code, 'gui/src/safe.ts', true);
      expect(violations).toHaveLength(0);
    });
  });

  describe('runChecks', () => {
    it('passes cleanly across current repository codebase', () => {
      const result = runChecks();
      expect(result.violations).toEqual([]);
      expect(result.guiCount).toBeGreaterThan(0);
      expect(result.scannedCount).toBeGreaterThan(0);
    });
  });
});
