import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { LEGACY_UI_IMPORTERS } from '../../eslint.config.js';

/**
 * Proves the import rules in `gui/eslint.config.js` (README, "The import rules") on virtual
 * files, so they cannot rot: each case lints a snippet as if it lived at the given path.
 */

const GUI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(GUI, 'src');
const eslint = new ESLint({ cwd: GUI });

async function errors(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(GUI, file) });
  return result!.messages.filter((m) => m.severity === 2 && m.ruleId === 'no-restricted-imports').map((m) => m.message.split(' import is restricted')[0]!);
}

describe('design import rules', () => {
  it('(a) design/ stays a leaf', async () => {
    const found = await errors(
      'src/design/Probe.tsx',
      "import { a } from '../features/board/boardData.js';\nimport { b } from '@xyflow/react';\nimport { c } from '@tanstack/react-query';\nimport { d } from './CardFrame.js';\nexport const x = [a, b, c, d];\n",
    );
    expect(found).toEqual(["'../features/board/boardData.js'", "'@xyflow/react'", "'@tanstack/react-query'"]);
  });

  it('(b) outside the module only design/index is public', async () => {
    const code = (spec: string) => `import { x } from '${spec}';\nexport default x;\n`;
    expect(await errors('src/features/board/Probe.tsx', code('../../design/index.js'))).toEqual([]);
    expect(await errors('src/features/board/Probe.tsx', code('../../design'))).toEqual([]);
    expect(await errors('src/features/board/Probe.tsx', code('../../design/CardFrame.js'))).toHaveLength(1);
    expect(await errors('src/features/board/Probe.tsx', code('../../design/reference/DesignPage.js'))).toHaveLength(1);
    // legacy files and the controls themselves follow (b) too
    expect(await errors(LEGACY_UI_IMPORTERS[0]!, code('./design/CardFrame.js'))).toHaveLength(1);
    expect(await errors('src/components/ui/Probe.tsx', code('../../design/CardFrame.js'))).toHaveLength(1);
    expect(await errors('src/components/ui/Probe.tsx', code('../../design/index.js'))).toEqual([]);
  });

  it('(c) new code takes controls from design/index, in every spelling', async () => {
    const code = (spec: string) => `import { x } from '${spec}';\nexport default x;\n`;
    expect(await errors('src/features/board/NewThing.tsx', code('../../components/ui/button.js'))).toHaveLength(1);
    expect(await errors('src/features/board/NewThing.tsx', code('../../components/ui'))).toHaveLength(1);
    expect(await errors('src/features/board/NewThing.tsx', code('../../components/ui/index.js'))).toHaveLength(1);
    expect(await errors('src/components/NewThing.tsx', code('./ui/button.js'))).toHaveLength(1);
    expect(await errors('src/components/NewThing.tsx', code('./ui'))).toHaveLength(1);
    expect(await errors('src/components/sub/NewThing.tsx', code('../ui/button.js'))).toHaveLength(1);
    // not controls: packages with a ui segment, and design/index
    expect(await errors('src/features/changes/NewThing.tsx', code('monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css'))).toEqual([]);
    expect(await errors('src/features/board/NewThing.tsx', code('../../design/index.js'))).toEqual([]);
    // an existing importer is allowed to keep its import
    expect(await errors('src/features/board/BoardNowLine.tsx', code('../../components/ui/button.js'))).toEqual([]);
  });

  it('keeps LEGACY_UI_IMPORTERS equal to the files that really import components/ui', () => {
    const ui = path.join(SRC, 'components/ui');
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const real: string[] = [];
    for (const file of walk(SRC).filter((f) => /\.tsx?$/.test(f))) {
      if (file.startsWith(ui + path.sep) || file.startsWith(path.join(SRC, 'design') + path.sep)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const hits = [...text.matchAll(/(?:from|import\(|mock\(|require\()\s*['"](\.[^'"]*)['"]/g)].some((m) => {
        const target = path.resolve(path.dirname(file), m[1]!);
        return target === ui || target.startsWith(ui + path.sep);
      });
      if (hits) real.push(path.relative(GUI, file).split(path.sep).join('/'));
    }
    expect(real.sort(), 'a new direct components/ui importer: import from design/index instead').toEqual([...LEGACY_UI_IMPORTERS].sort());
  });
});
