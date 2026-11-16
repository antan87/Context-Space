import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getAffectedSpecs } from '../gui/scripts/affected-e2e.mjs';

describe('affected e2e specs', () => {
  it('selects every existing spec directly, including the app shell outside Board', () => {
    const specs = readdirSync('gui/e2e').filter((name) => name.endsWith('.spec.ts'));
    expect(specs.length).toBeGreaterThan(50);
    for (const name of specs) {
      expect(getAffectedSpecs([`gui/e2e/${name}`]), name).toEqual([`e2e/${name}`]);
    }
  });

  it('ignores a deleted spec and retains conservative coverage for unknown source paths', () => {
    expect(getAffectedSpecs(['gui/e2e/removed-screen.spec.ts', 'gui/e2e/workspace-shell.spec.ts']))
      .toEqual(['e2e/workspace-shell.spec.ts']);
    expect(getAffectedSpecs(['gui/src/unmapped.tsx'])).toEqual(['e2e/board']);
  });
});
