import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  CENTRAL_BOARD_FILES,
  FOLDER_SPECS,
  getAffectedSpecs,
  isCentralBoardFile,
  resolveChangedFiles,
} from '../gui/scripts/affected-e2e.mjs';

const BOARD_READER_SPECS = [
  'e2e/board-reader.spec.ts',
  'e2e/board-reader-back.spec.ts',
  'e2e/board-reader-nav.spec.ts',
  'e2e/board-browsing.spec.ts',
  'e2e/board-knowledge.spec.ts',
  'e2e/board-document-links.spec.ts',
  'e2e/board-review-page.spec.ts',
  'e2e/board-workspace-files.spec.ts',
  'e2e/board-files.spec.ts',
  'e2e/board-point-and-ask.spec.ts',
  'e2e/board-a11y.spec.ts',
  'e2e/board-press.spec.ts',
  'e2e/board-area-view.spec.ts',
  'e2e/board-questions.spec.ts',
  'e2e/board-commits.spec.ts',
  'e2e/board-copy.spec.ts',
  'e2e/board-code-window.spec.ts',
  'e2e/board-assignment.spec.ts',
  'e2e/board-area.spec.ts',
  'e2e/board-index.spec.ts',
  'e2e/board-back.spec.ts',
  'e2e/workspace-shell.spec.ts',
  'e2e/archive.spec.ts',
  'e2e/terminal-code-tree.spec.ts',
];

const BOARD_SIDEBAR_SPECS = [
  'e2e/board-index.spec.ts',
  'e2e/board-knowledge.spec.ts',
  'e2e/board-overview.spec.ts',
  'e2e/board-terminal-coworking.spec.ts',
  'e2e/board-files.spec.ts',
  'e2e/board-area-view.spec.ts',
  'e2e/board-w2-tiers.spec.ts',
  'e2e/board-questions.spec.ts',
  'e2e/board-now-line.spec.ts',
  'e2e/board-reader-back.spec.ts',
  'e2e/board-area.spec.ts',
  'e2e/board-back.spec.ts',
  'e2e/board-reader.spec.ts',
];

// Loaded as a plain Node module so the test runner does not try to transform (and read the source map of) the compiler
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

/**
 * The module specifiers a source file imports or re-exports, read by TypeScript's own scanner: `import`, `import type`,
 * side-effect imports, `export ... from`, `export * from` and dynamic `import("x")`, in any quotes, spacing or comments.
 */
const specifiers = (source: string): string[] => ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName);

/** Whether a source file draws the shared card parts: by their own files, or by name through the design barrel. */
function consumesCardParts(source: string): boolean {
  return specifiers(source).some((from) =>
    /(CardFrame|cardParts)(\.js)?$/.test(from)
    || (/\/design(?:\/index)?(?:\.js)?$/.test(from) && /\b(CardFrame|CARD_BRICK|CARD_FOCUS)\b/.test(source)));
}

/**
 * The files that import one of the design pieces (`Pill`, `Mark`, `FreshDot`) by name, from the design barrel or from the piece's own
 * file, in any spelling (an alias, a type import, a multi-line clause), and the files that re-export them: read from TypeScript's syntax tree.
 */
function usesDesignPieces(source: string, names: readonly string[], files: readonly string[] = names): boolean {
  const file = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fromDesign = (text: string) => /(^|\/)design(\/index)?(\.js)?$/.test(text);
  const fromPiece = (text: string) => new RegExp(`(^|/)(${files.join('|')})(\\.js)?$`).test(text);
  // A dynamic `import('…/design/index.js')` or `import('…/StepCheck.js')` anywhere in the file (a lazy screen, `.then(m => m.StepCheck)`):
  // the names it takes cannot be told, so it counts as a user (DS4's review found this missing).
  let dynamic = false;
  const visit = (node: import('typescript').Node): void => {
    if (dynamic) return;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) && (fromDesign(argument.text) || fromPiece(argument.text))) dynamic = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (dynamic) return true;
  return file.statements.some((statement) => {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && fromPiece(statement.moduleSpecifier.text)) return true;
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && fromDesign(statement.moduleSpecifier.text)) {
      const bindings = statement.importClause?.namedBindings;
      const named = bindings && ts.isNamedImports(bindings) ? bindings.elements.map((element) => (element.propertyName ?? element.name).text) : [];
      return named.some((name) => names.includes(name)) || (bindings !== undefined && ts.isNamespaceImport(bindings)) || statement.importClause?.name !== undefined;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && (fromPiece(statement.moduleSpecifier.text) || fromDesign(statement.moduleSpecifier.text))) {
      const clause = statement.exportClause;
      return !clause || ts.isNamespaceExport(clause) || clause.elements.some((element) => names.includes((element.propertyName ?? element.name).text));
    }
    return false;
  });
}

const DESIGN_PIECES = ['Pill', 'KindLabel', 'Mark', 'FreshDot'] as const;
const ROW_PIECE_NAMES = ['StepCheck', 'rowSurface', 'foldSurface'] as const;
const ROW_PIECE_FILES = ['StepCheck', 'RowSurface'] as const;
const findDesignPieceUsers = (dir: string, names: readonly string[]) => sourceFiles(dir).filter((file) => usesDesignPieces(readFileSync(file, 'utf8'), names));

function sourceFiles(dir: string, withTests = false): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(file, withTests));
    else if (/\.tsx?$/.test(entry.name) && (withTests || !/\.test\.tsx?$/.test(entry.name))) found.push(file);
  }
  return found;
}

const findCardPartsImporters = (dir: string) => sourceFiles(dir).filter((file) => consumesCardParts(readFileSync(file, 'utf8')));

/** Whether a source file imports or re-exports a card file (NoteCard, FileCard): by its path, or through a `cards` index. */
function importsCardFile(source: string, names: readonly string[]): boolean {
  return specifiers(source).some((from) =>
    new RegExp(`(${names.join('|')})(\\.js)?$`).test(from) || /\/cards(?:\/index)?(?:\.js)?$/.test(from));
}

/** Whether a source file imports the BoardNodes barrel in any form. */
const importsBoardNodes = (source: string): boolean => specifiers(source).some((from) => /(^|\/)BoardNodes(\.js)?$/.test(from));

/** Whether a source file imports or re-exports a row file (RowHead, RowControls): by its path, or through a `rows` index. */
function importsRowFile(source: string, names: readonly string[]): boolean {
  return specifiers(source).some((from) =>
    new RegExp(`(^|/)(${names.join('|')})(\\.js)?$`).test(from) || /(^|\/)rows(?:\/index)?(?:\.js)?$/.test(from));
}

const findRowFileImporters = (dir: string, names: readonly string[]) => sourceFiles(dir, true).filter((file) => importsRowFile(readFileSync(file, 'utf8'), names));
const findCardFileImporters = (dir: string, names: readonly string[]) => sourceFiles(dir).filter((file) => importsCardFile(readFileSync(file, 'utf8'), names));
const findBoardNodesImporters = (dir: string) => sourceFiles(dir, true).filter((file) => importsBoardNodes(readFileSync(file, 'utf8')));

describe('affected e2e specs', () => {
  it('selects every existing spec directly, including the app shell outside Board', () => {
    const specs = readdirSync('gui/e2e').filter((name) => name.endsWith('.spec.ts'));
    expect(specs.length).toBeGreaterThan(50);
    for (const name of specs) {
      expect(getAffectedSpecs([`gui/e2e/${name}`]), name).toEqual([`e2e/${name}`]);
    }
  });

  it('ignores deleted specs and never confuses non-gui e2e paths with gui/e2e', () => {
    expect(getAffectedSpecs(['gui/e2e/removed-screen.spec.ts', 'gui/e2e/workspace-shell.spec.ts']))
      .toEqual(['e2e/workspace-shell.spec.ts']);
    expect(getAffectedSpecs(['gui/e2e/removed-screen.spec.ts', 'gui/src/features/board/BoardSidebar.tsx']))
      .toEqual([...BOARD_SIDEBAR_SPECS, 'e2e/board-a11y.spec.ts', 'e2e/accessibility.spec.ts']);
    expect(getAffectedSpecs(['gui/e2e/removed-screen.spec.ts'])).toEqual(['e2e/board']);
    expect(getAffectedSpecs(['desktop/e2e/board-notes.spec.ts'])).toEqual(['e2e']);
  });

  it('prefixes every src/ path with gui/ and handles unknown board vs other paths', () => {
    expect(getAffectedSpecs(['src/features/board/BoardReader.tsx'])).toEqual([...BOARD_READER_SPECS, 'e2e/accessibility.spec.ts']);
    expect(getAffectedSpecs(['src/components/Diagram.tsx'])).toEqual([
      'e2e/board-questions.spec.ts',
      'e2e/board-reader.spec.ts',
      'e2e/board-copy.spec.ts',
    ]);
    expect(getAffectedSpecs(['src/lib/diagram.ts'])).toEqual([
      'e2e/board-questions.spec.ts',
      'e2e/board-reader.spec.ts',
      'e2e/board-copy.spec.ts',
    ]);
    expect(getAffectedSpecs(['src/diagram-frame.ts'])).toEqual([
      'e2e/board-questions.spec.ts',
      'e2e/board-reader.spec.ts',
      'e2e/board-copy.spec.ts',
    ]);

    // Unknown paths inside src/features/board/ run e2e/board; anywhere else runs e2e.
    expect(getAffectedSpecs(['gui/src/features/board/unmapped.tsx'])).toEqual(['e2e/board']);
    expect(getAffectedSpecs(['src/features/board/unmapped.tsx'])).toEqual(['e2e/board']);
    expect(getAffectedSpecs(['gui/src/features/board/cards/futureCard.tsx'])).toEqual(['e2e/board']);

    expect(getAffectedSpecs(['gui/src/unmapped.tsx'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['src/unmapped.tsx'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['src/design/x.tsx'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['gui/src/design/FuturePiece.tsx'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['src/features/chat/ChatPanel.tsx'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['src/core/workspace.ts'])).toEqual(['e2e']);
  });

  it('runs no browser spec for the design guide, guard test and baseline (DS2a)', () => {
    for (const file of [
      'gui/src/design/README.md',
      'src/design/README.md',
      'gui/src/design/designGuard.test.ts',
      'src/design/designGuard.test.ts',
      'gui/src/design/design-baseline.json',
      'src\\design\\README.md',
    ]) {
      expect(getAffectedSpecs([file]), file).toEqual([]);
    }
    expect(getAffectedSpecs(['gui/src/design/README.md', 'gui/src/design/designGuard.test.ts'])).toEqual([]);
    // A real change next to them still decides what runs.
    expect(getAffectedSpecs(['gui/src/design/README.md', 'gui/src/features/board/unmapped.tsx'])).toEqual(['e2e/board']);
    expect(getAffectedSpecs(['gui/src/design/README.md', 'gui/src/design/FuturePiece.tsx'])).toEqual(['e2e']);
    // index.ts stays app-wide; a spec edit beside the docs still runs that spec.
    expect(getAffectedSpecs(['gui/src/design/index.ts', 'gui/src/design/README.md'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['gui/src/design/README.md', 'gui/e2e/board-press.spec.ts'])).toEqual(['e2e/board-press.spec.ts']);
    // The CLI prints nothing and never starts Playwright with no spec.
    const run = spawnSync(process.execPath, ['gui/scripts/affected-e2e.mjs', 'gui/src/design/README.md'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('');
  });

  it('routes every APP_WIDE file to all of e2e', () => {
    const appWideCases = [
      'src/index.css',
      'gui/src/index.css',
      'src/design/tokens.css',
      'gui/src/design/tokens.css',
      'src/design/index.ts',
      'gui/src/design/index.ts',
      'src/components/ui/button.tsx',
      'gui/src/components/ui/badge.tsx',
      'src/components/ui/nested/item.tsx',
      'src/App.tsx',
      'gui/src/App.tsx',
      'src/main.tsx',
      'gui/src/main.tsx',
      'e2e/fixtures.ts',
      'gui/e2e/fixtures.ts',
      'e2e/global-setup.ts',
      'gui/e2e/global-setup.ts',
      'playwright.config.ts',
      'gui/playwright.config.ts',
    ];
    for (const file of appWideCases) {
      expect(getAffectedSpecs([file]), file).toEqual(['e2e']);
    }
    // APP_WIDE overrides mapped leaf and central Board files.
    expect(getAffectedSpecs(['gui/src/features/board/BoardReader.tsx', 'src/index.css'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['gui/src/features/board/boardData.ts', 'gui/src/App.tsx'])).toEqual(['e2e']);
  });

  it('keeps central Board file names exact and lets central files win over mapped rows', () => {
    for (const name of ['nodeTypes', 'areas/types', 'overview/plan', 'BoardCheckpoint', 'BoardNodes']) {
      expect(CENTRAL_BOARD_FILES.has(name), name).toBe(true);
    }
    // DS5a: the row header moved to rows/RowHead.tsx and no file named BoardRowHead is left, so it is no longer central
    for (const name of ['BoardRowHead', 'BoardRowHead.tsx']) expect(CENTRAL_BOARD_FILES.has(name), name).toBe(false);
    expect(existsSync('gui/src/features/board/BoardRowHead.tsx')).toBe(false);
    expect(existsSync('gui/src/features/board/BoardRowHead.test.tsx')).toBe(false);

    const centralPaths = [
      'gui/src/features/board/BoardSection.tsx',
      'src/features/board/BoardSection.tsx',
      'gui/src/features/board/nodeTypes.ts',
      'src/features/board/nodeTypes.ts',
      'gui/src/features/board/areas/types.ts',
      'src/features/board/areas/types.ts',
      'gui/src/features/board/overview/plan.ts',
      'src/features/board/overview/plan.ts',
      'gui/src/features/board/boardData.test.ts',
      'BoardSection.tsx',
    ];
    for (const file of centralPaths) {
      expect(isCentralBoardFile(file), file).toBe(true);
      expect(getAffectedSpecs([file]), file).toEqual(['e2e/board']);
    }

    // Central files win over mapped board-only leaf files regardless of order, while preserving non-board specs.
    expect(getAffectedSpecs([
      'gui/src/features/board/BoardSidebar.tsx',
      'gui/src/features/board/nodeTypes.ts',
    ])).toEqual(['e2e/board', 'e2e/accessibility.spec.ts']);
    expect(getAffectedSpecs([
      'gui/src/features/board/areas/types.ts',
      'gui/src/features/board/BoardSidebar.tsx',
    ])).toEqual(['e2e/board', 'e2e/accessibility.spec.ts']);
    expect(getAffectedSpecs([
      'gui/src/features/board/BoardSidebar.tsx',
      'src/features/board/overview/plan.ts',
    ])).toEqual(['e2e/board', 'e2e/accessibility.spec.ts']);
    expect(getAffectedSpecs([
      'gui/src/features/board/BoardReader.tsx',
      'gui/src/features/board/nodeTypes.ts',
    ])).toEqual([
      'e2e/board',
      'e2e/workspace-shell.spec.ts',
      'e2e/archive.spec.ts',
      'e2e/terminal-code-tree.spec.ts',
      'e2e/accessibility.spec.ts',
    ]);
    expect(getAffectedSpecs([
      'gui/src/features/board/boardData.ts',
      'gui/e2e/theme.spec.ts',
    ])).toEqual(['e2e/board', 'e2e/theme.spec.ts']);

    // Central names must not match outside gui/src/features/board/ or in unrelated subfolders.
    const nonCentralPaths = [
      'gui/src/types.ts',
      'src/types.ts',
      'gui/src/features/changes/types.ts',
      'src/core/plan.ts',
      'gui/src/features/plan/planView.ts',
      'gui/src/features/other/BoardSection.tsx',
      'gui/src/features/board/cards/types.ts',
      'types.ts',
      'plan.ts',
    ];
    for (const file of nonCentralPaths) {
      expect(isCentralBoardFile(file), file).toBe(false);
    }
    expect(getAffectedSpecs(['gui/src/types.ts'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['gui/src/features/changes/types.ts'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['src/core/plan.ts'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['gui/src/features/other/BoardSection.tsx'])).toEqual(['e2e']);
  });

  it('maps the shared card parts (DS2b) to all of e2e/board and the page scan, and only BoardNodes imports them', () => {
    const rowOf = (path: string) => FOLDER_SPECS.find((entry) => entry.path === path);
    const cardFrame = rowOf('gui/src/design/CardFrame.tsx');
    const cardParts = rowOf('gui/src/features/board/cards/cardParts.tsx');
    expect(cardFrame).toBeDefined();
    expect(cardParts).toBeDefined();
    for (const row of [cardFrame!, cardParts!]) {
      expect(row.specs).toEqual(expect.arrayContaining(['e2e/board', 'e2e/accessibility.spec.ts']));
    }
    expect(getAffectedSpecs(['gui/src/design/CardFrame.tsx'])).toEqual(cardFrame!.specs);
    expect(getAffectedSpecs(['gui/src/features/board/cards/cardParts.tsx'])).toEqual(cardParts!.specs);
    // Not the whole app: that is only for design/index.ts, which exports CardFrame.
    expect(getAffectedSpecs(['gui/src/design/CardFrame.tsx'])).not.toEqual(['e2e']);
    expect(getAffectedSpecs(['gui/src/design/index.ts'])).toEqual(['e2e']);

    // The row is safe only while nothing outside the Board draws them: a new importer must extend the row first.
    // (NoteCard.tsx and FileCard.tsx are the cards themselves: they draw the frame and parts, as DS3 moved them out of BoardNodes.tsx; DS5a's rows/RowHead.tsx and rows/RowControls.tsx draw Anchors, brickPress and the card constants the same way.)
    expect(findCardPartsImporters('gui/src').sort()).toEqual([
      'gui/src/design/index.ts',
      'gui/src/features/board/BoardNodes.tsx',
      'gui/src/features/board/cards/FileCard.tsx',
      'gui/src/features/board/cards/NoteCard.tsx',
      'gui/src/features/board/rows/RowControls.tsx',
      'gui/src/features/board/rows/RowHead.tsx',
      // The design page (DS7) draws CardFrame in each of its states; its spec is on the row.
      'gui/src/pages/DesignPieces.tsx',
    ]);
    expect(cardFrame!.specs).toContain('e2e/design-page.spec.ts');
    expect(cardParts!.specs).toContain('e2e/design-page.spec.ts');
    // The guard sees direct imports and consumers through the design barrel, in any spelling
    const consumes = (source: string) => consumesCardParts(source);
    expect(consumes("import { CardFrame } from '../../design/CardFrame.js';")).toBe(true);
    expect(consumes("import { Anchors } from './cards/cardParts.js';")).toBe(true);
    expect(consumes("import { Button, CardFrame } from '../../design/index.js';")).toBe(true);
    expect(consumes("import {\n  Button,\n  CardFrame as Frame,\n} from '../../design';")).toBe(true);
    expect(consumes("import { Button } from '../../design/index.js';")).toBe(false);
    expect(consumes("import { Card } from '../../components/ui/card.js';")).toBe(false);
  });

  it('maps the Note and File cards (DS3) to the specs that show them, and only BoardNodes imports them', () => {
    const rowOf = (path: string) => FOLDER_SPECS.find((entry) => entry.path === path);
    const note = rowOf('gui/src/features/board/cards/NoteCard.tsx');
    const file = rowOf('gui/src/features/board/cards/FileCard.tsx');
    expect(note).toBeDefined();
    expect(file).toBeDefined();
    expect(note!.specs).toEqual(expect.arrayContaining([
      'e2e/board-notes.spec.ts', 'e2e/board-area.spec.ts', 'e2e/board-press.spec.ts', 'e2e/board-a11y.spec.ts',
      'e2e/board-live.spec.ts', 'e2e/board-terminal-coworking.spec.ts', 'e2e/board-index.spec.ts', 'e2e/accessibility.spec.ts',
    ]));
    expect(file!.specs).toEqual(expect.arrayContaining([
      'e2e/board-workspace-files.spec.ts', 'e2e/board-area.spec.ts', 'e2e/board-reader.spec.ts', 'e2e/board-reader-nav.spec.ts',
      'e2e/board-a11y.spec.ts', 'e2e/board-press.spec.ts', 'e2e/board-index.spec.ts', 'e2e/accessibility.spec.ts',
    ]));
    for (const row of [note!, file!]) {
      expect(row.specs).not.toContain('e2e/board');
      expect(getAffectedSpecs([row.path])).toEqual(row.specs);
    }
    expect(getAffectedSpecs(['gui/src/features/board/cards/NoteCard.tsx'])).not.toContain('e2e/board-files.spec.ts');
    expect(getAffectedSpecs(['gui/src/features/board/cards/FileCard.tsx'])).not.toContain('e2e/board-notes.spec.ts');
    // Only BoardNodes.tsx (the barrel BoardSection uses) imports the two cards, directly or through a `cards` index
    expect(findCardFileImporters('gui/src', ['NoteCard', 'FileCard'])).toEqual(['gui/src/features/board/BoardNodes.tsx']);
    const both = ['NoteCard', 'FileCard'];
    expect(importsCardFile("import { BoardNote } from './cards/NoteCard.js';", both)).toBe(true);
    expect(importsCardFile("import { BoardFile } from './cards/FileCard';", both)).toBe(true);
    expect(importsCardFile("import { BoardFile } from './cards/index.js';", both)).toBe(true);
    // Double quotes, `export ... from`, a multi-line clause, a bare import and a dynamic import
    expect(importsCardFile('import { BoardNote } from "./cards/NoteCard.js";', both)).toBe(true);
    expect(importsCardFile('export { BoardFile } from "./cards/FileCard.js";', both)).toBe(true);
    expect(importsCardFile("export {\n  BoardFile,\n} from './cards/FileCard.js';", both)).toBe(true);
    expect(importsCardFile('import { BoardFile } from "./cards/index.js";', both)).toBe(true);
    expect(importsCardFile("export * from './cards';", both)).toBe(true);
    expect(importsCardFile('import "./cards/NoteCard.js";', both)).toBe(true);
    expect(importsCardFile("const card = import('./cards/FileCard.js');", both)).toBe(true);
    expect(importsCardFile("import { BoardNote } from './BoardNodes.js';", both)).toBe(false);
    // Through the BoardNodes barrel, which hands out BoardNote and BoardFile: every importer (tests included) is on a list, so a
    // new one is added on purpose, and adding it is the moment to reconsider the rows above.
    expect(findBoardNodesImporters('gui/src')).toEqual([
      'gui/src/features/board/BoardCheckpoint.test.tsx',
      'gui/src/features/board/BoardSection.tsx',
      // The golden test and the design page draw their cards from the shared fixtures, which are the importer now.
      'gui/src/features/board/cards/cardFixtures.ts',
      'gui/src/features/board/cards/freshDotPin.test.tsx',
    ]);
    // What the scanner sees, in any spelling
    for (const source of [
      "import { BoardNote } from './BoardNodes.js';",
      'import { BoardFile, BoardLane } from "../board/BoardNodes";',
      "import {\n  BoardLane,\n  BoardNote,\n} from './BoardNodes.js';",
      'export { BoardFile } from "./BoardNodes.js";',
      'import * as Nodes from "./BoardNodes.js";',
      'export * from "./BoardNodes.js";',
      'async function load() { return await import("./BoardNodes.js"); }',
      'import type { BoardNote } from "./BoardNodes.js";',
      'import "./BoardNodes.js";',
    ]) expect(importsBoardNodes(source), source).toBe(true);
    expect(importsBoardNodes("import { BoardNote } from './cards/NoteCard.js';")).toBe(false);
    // The comment after `from`, a comment inside the braces, and a dynamic import with a space
    expect(importsCardFile('import { BoardFile } from /* the file card */ "./cards/FileCard.js";', both)).toBe(true);
    expect(importsCardFile('import { /* the card */ BoardFile } from "./cards/FileCard.js";', both)).toBe(true);
    expect(importsCardFile('const card = import ("./cards/FileCard.js");', both)).toBe(true);
    expect(importsCardFile('import type { BoardNote } from "./cards/NoteCard.js";', both)).toBe(true);
    expect(importsCardFile('// import "./cards/NoteCard.js";\nexport const x = 1;', both)).toBe(false);
    // The card-parts guard reads double quotes and `export ... from` too
    expect(consumesCardParts('import { CardFrame } from "../../design/CardFrame.js";')).toBe(true);
    expect(consumesCardParts('export { Anchors } from "./cards/cardParts.js";')).toBe(true);
    expect(consumesCardParts('import { Button, CardFrame } from "../../design/index.js";')).toBe(true);
    expect(consumesCardParts('import { Button } from "../../design/index.js";')).toBe(false);
  });

  it('maps the Area rows (DS5a) to the specs that show them, and only BoardNodes and their own tests import them', () => {
    const rowOf = (path: string) => FOLDER_SPECS.find((entry) => entry.path === path);
    const head = rowOf('gui/src/features/board/rows/RowHead.tsx');
    const controls = rowOf('gui/src/features/board/rows/RowControls.tsx');
    expect(head).toBeDefined();
    expect(controls).toBeDefined();
    expect(head!.specs).toEqual(expect.arrayContaining([
      'e2e/board-step-ticking.spec.ts', 'e2e/board-area.spec.ts', 'e2e/board-area-view.spec.ts', 'e2e/board-now-line.spec.ts',
      'e2e/board-back.spec.ts', 'e2e/board-press.spec.ts', 'e2e/board-reader-nav.spec.ts', 'e2e/board-a11y.spec.ts', 'e2e/accessibility.spec.ts',
    ]));
    expect(controls!.specs).toEqual(expect.arrayContaining([
      'e2e/board-area.spec.ts', 'e2e/board-area-view.spec.ts', 'e2e/board-step-ticking.spec.ts', 'e2e/board-commit-list.spec.ts',
      'e2e/board-live.spec.ts', 'e2e/board-a11y.spec.ts', 'e2e/accessibility.spec.ts',
    ]));
    for (const row of [head!, controls!]) {
      expect(row.specs).not.toContain('e2e/board');
      expect(isCentralBoardFile(row.path), row.path).toBe(false);
      expect(getAffectedSpecs([row.path])).toEqual(row.specs);
    }
    // The moved test and the barrel keep their meaning: the test is for the header row, the barrel stays central
    expect(getAffectedSpecs(['gui/src/features/board/rows/RowHead.test.tsx'])).toEqual(head!.specs);
    expect(getAffectedSpecs(['gui/src/features/board/BoardNodes.tsx'])).toEqual(['e2e/board']);
    // A header change does not run the controls' specs (nothing but the shared ones overlap), and the reverse
    expect(getAffectedSpecs(['gui/src/features/board/rows/RowControls.tsx'])).not.toContain('e2e/board-press.spec.ts');
    expect(getAffectedSpecs(['gui/src/features/board/rows/RowHead.tsx'])).not.toContain('e2e/board-live.spec.ts');
    // The rows are safe only while nothing else imports them: a new importer must extend them first.
    const both = ['RowHead', 'RowControls'];
    expect(findRowFileImporters('gui/src', both)).toEqual([
      'gui/src/features/board/BoardNodes.tsx',
      'gui/src/features/board/rows/RowHead.test.tsx',
    ]);
    // What the scanner sees, in any spelling
    for (const source of [
      "import { BoardRowHead } from './rows/RowHead.js';",
      'import { BoardPager } from "./rows/RowControls";',
      "import {\n  BoardFoldRow,\n  BoardPager,\n} from './rows/RowControls.js';",
      'export { BoardRowHead } from "./rows/RowHead.js";',
      'export * from "./rows/RowControls.js";',
      "import * as Rows from './rows/index.js';",
      "export * from './rows';",
      'import "./rows/RowHead.js";',
      'async function load() { return await import ("./rows/RowControls.js"); }',
      'import type { BoardRowHead } from "./rows/RowHead.js";',
      'import { BoardRowHead } from /* the header */ "./rows/RowHead.js";',
      'import { /* the header */ BoardRowHead } from "./rows/RowHead.js";',
    ]) expect(importsRowFile(source, both), source).toBe(true);
    expect(importsRowFile("import { BoardNote } from './cards/NoteCard.js';", both)).toBe(false);
    expect(importsRowFile("import { Anchors } from '../cards/cardParts.js';", both)).toBe(false);
    expect(importsRowFile('// import "./rows/RowHead.js";\nexport const x = 1;', both)).toBe(false);
  });

  it('maps the Board stylesheet (DS11) to the full list of specs that draw the Board, and design/tokens.css to all of e2e', () => {
    const board = [
      'e2e/board',
      'e2e/accessibility.spec.ts',
      'e2e/design-page.spec.ts',
      'e2e/keyboard-journey.spec.ts',
      'e2e/sidebar-rail.spec.ts',
      // Every row also lists the two whole-page scans (WHOLE_PAGE_A11Y_SPECS), appended where the rows are built; inside e2e/board it is a repeat
      'e2e/board-a11y.spec.ts',
    ];
    expect(FOLDER_SPECS.find((entry) => entry.path === 'gui/src/features/board/board.css')?.specs).toEqual(board);
    expect(getAffectedSpecs(['gui/src/features/board/board.css'])).toEqual(board);
    expect(getAffectedSpecs(['src/features/board/board.css'])).toEqual(board);
    // Not the whole app: index.css, which imports it, is APP_WIDE, the stylesheet itself is not
    expect(getAffectedSpecs(['gui/src/features/board/board.css'])).not.toEqual(['e2e']);
    // The tokens stay APP_WIDE: every screen reads them
    expect(getAffectedSpecs(['gui/src/design/tokens.css'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['gui/src/index.css'])).toEqual(['e2e']);
  });

  it('maps Pill, KindLabel, Mark and FreshDot (DS4, R1b) to all of e2e/board and the page scan, and only the files listed below import them', () => {
    const rowOf = (path: string) => FOLDER_SPECS.find((entry) => entry.path === path);
    for (const piece of DESIGN_PIECES) {
      const row = rowOf(`gui/src/design/${piece}.tsx`);
      expect(row, piece).toBeDefined();
      expect(row!.specs, piece).toEqual(expect.arrayContaining(['e2e/board', 'e2e/accessibility.spec.ts']));
      expect(getAffectedSpecs([row!.path]), piece).toEqual(row!.specs);
      // Not the whole app: that is only for design/index.ts
      expect(getAffectedSpecs([row!.path]), piece).not.toEqual(['e2e']);
      expect(row!.specs, piece).toContain('e2e/design-page.spec.ts');
    }
    expect(getAffectedSpecs(['gui/src/design/index.ts'])).toEqual(['e2e']);
    // Their own test is for no browser
    expect(getAffectedSpecs(['gui/src/design/pieces.test.tsx'])).toEqual([]);
    // The rows are safe only while nothing outside the Board draws the pieces: a new user must extend them first.
    expect(findDesignPieceUsers('gui/src', ['Pill']).sort()).toEqual([
      'gui/src/design/index.ts',
      'gui/src/features/changes/CommitsView.tsx',
      // The design page (DS7) draws each piece in every state; its spec is on each piece's row.
      'gui/src/pages/DesignPieces.tsx',
    ]);
    expect(findDesignPieceUsers('gui/src', ['KindLabel']).sort()).toEqual([
      'gui/src/design/index.ts',
      'gui/src/features/board/cards/FileCard.tsx',
      'gui/src/features/board/cards/NoteCard.tsx',
      'gui/src/pages/DesignPieces.tsx',
    ]);
    expect(findDesignPieceUsers('gui/src', ['Mark']).sort()).toEqual(['gui/src/design/index.ts', 'gui/src/features/board/cards/cardParts.tsx', 'gui/src/pages/DesignPieces.tsx']);
    expect(findDesignPieceUsers('gui/src', ['FreshDot']).sort()).toEqual([
      'gui/src/design/index.ts',
      'gui/src/features/board/BoardNodes.tsx',
      'gui/src/features/board/cards/cardParts.tsx',
      'gui/src/pages/DesignPieces.tsx',
    ]);
    // The guard reads aliases, type imports, multi-line clauses, double quotes, the piece's own file and re-exports
    const users = (source: string) => usesDesignPieces(source, DESIGN_PIECES);
    expect(users("import { Button, Pill } from '../../design/index.js';")).toBe(true);
    expect(users('import {\n  Button,\n  Mark as WhoMark,\n} from "../../design";')).toBe(true);
    expect(users("import { FreshDot } from '../design/FreshDot.js';")).toBe(true);
    expect(users("import type { PillProps } from '../design/Pill.js';")).toBe(true);
    expect(users("export { Pill } from './Pill.js';")).toBe(true);
    expect(users("export * from './design/index.js';")).toBe(true);
    expect(users("import { Button } from '../../design/index.js';")).toBe(false);
    expect(users("import { Pill } from './other.js';")).toBe(false);
    expect(users("// import { Pill } from '../design/index.js';\nexport const x = 1;")).toBe(false);
    // ... and a dynamic import of the barrel or of a piece's file (DS5b), also deep inside a function or a `.then`
    expect(users("const lazy = () => import('../../design/index.js');")).toBe(true);
    expect(users('async function load() { const { Pill } = await import("../design/index.js"); return Pill; }')).toBe(true);
    expect(users("export const x = import('../design/Mark.js').then((m) => m.Mark);")).toBe(true);
    expect(users("const x = import('./other.js');")).toBe(false);
    expect(users("// const x = import('../design/index.js');\nexport const y = 1;")).toBe(false);
  });

  it('maps StepCheck and RowSurface (DS5b) to the specs that tick steps or show the Now row, and only Board row files import them', () => {
    const rowOf = (path: string) => FOLDER_SPECS.find((entry) => entry.path === path);
    for (const piece of ROW_PIECE_FILES) {
      const row = rowOf(`gui/src/design/${piece}.tsx`);
      expect(row, piece).toBeDefined();
      expect(row!.specs, piece).toEqual(expect.arrayContaining(['e2e/board-step-ticking.spec.ts', 'e2e/board-area.spec.ts', 'e2e/board-a11y.spec.ts', 'e2e/accessibility.spec.ts']));
      expect(getAffectedSpecs([row!.path]), piece).toEqual(row!.specs);
      // Not the whole app: that is only for design/index.ts
      expect(getAffectedSpecs([row!.path]), piece).not.toEqual(['e2e']);
      // None of the rows maps the whole Board folder by accident: the lists are exact
      expect(row!.specs, piece).not.toContain('e2e/board');
      expect(row!.specs, piece).toContain('e2e/design-page.spec.ts');
    }
    expect(getAffectedSpecs(['gui/src/design/index.ts'])).toEqual(['e2e']);
    // The rows are safe only while nothing outside the Board's row files and the Checkpoint card draws them
    const users = (names: readonly string[], files: readonly string[]) => sourceFiles('gui/src').filter((file) => usesDesignPieces(readFileSync(file, 'utf8'), names, files)).sort();
    expect(users(['StepCheck'], ['StepCheck'])).toEqual([
      'gui/src/design/index.ts',
      'gui/src/features/board/BoardNodes.tsx',
      'gui/src/features/board/rows/RowHead.tsx',
      'gui/src/pages/DesignPieces.tsx',
    ]);
    expect(users(['rowSurface', 'foldSurface'], ['RowSurface'])).toEqual([
      'gui/src/design/index.ts',
      'gui/src/features/board/rows/RowControls.tsx',
      'gui/src/features/board/rows/RowHead.tsx',
      'gui/src/features/changes/CommitsView.tsx',
      'gui/src/pages/DesignPieces.tsx',
    ]);
    expect(usesDesignPieces("import { StepCheck } from '../design/index.js';", ROW_PIECE_NAMES, ROW_PIECE_FILES)).toBe(true);
    expect(usesDesignPieces("import { rowSurface as surface } from '../design/index.js';", ROW_PIECE_NAMES, ROW_PIECE_FILES)).toBe(true);
    expect(usesDesignPieces("import { foldSurface } from '../design/RowSurface.js';", ROW_PIECE_NAMES, ROW_PIECE_FILES)).toBe(true);
    expect(usesDesignPieces("const lazy = import('../design/index.js');", ROW_PIECE_NAMES, ROW_PIECE_FILES)).toBe(true);
    expect(usesDesignPieces("import { Pill } from '../design/index.js';", ROW_PIECE_NAMES, ROW_PIECE_FILES)).toBe(false);
  });

  it('maps Composer (DS6) to its exact spec list, and only the note dialog imports it', () => {
    const row = FOLDER_SPECS.find((entry) => entry.path === 'gui/src/design/Composer.tsx');
    expect(row).toBeDefined();
    // The expected list is written out here on its own: a spec lost from the row, or one added to it, fails this test
    expect(row!.specs).toEqual([
      'e2e/board-notes.spec.ts',
      'e2e/board-area.spec.ts',
      'e2e/board-area-view.spec.ts',
      'e2e/design-page.spec.ts',
    ]);
    expect(getAffectedSpecs([row!.path])).toEqual([
      'e2e/board-notes.spec.ts',
      'e2e/board-area.spec.ts',
      'e2e/board-area-view.spec.ts',
      'e2e/design-page.spec.ts',
    ]);
    expect(getAffectedSpecs(['gui/src/design/Composer.tsx'])).not.toEqual(['e2e']);
    expect(getAffectedSpecs(['gui/src/design/index.ts'])).toEqual(['e2e']);
    // Safe only while nothing else draws it: a second user needs its specs added to the row
    const users = sourceFiles('gui/src').filter((file) => usesDesignPieces(readFileSync(file, 'utf8'), ['Composer'])).sort();
    expect(users).toEqual([
      'gui/src/design/index.ts',
      'gui/src/features/board/NoteDialog.tsx',
      'gui/src/pages/DesignPieces.tsx',
    ]);
    expect(usesDesignPieces("import { Composer } from '../../design/index.js';", ['Composer'])).toBe(true);
    expect(usesDesignPieces("import { Button } from '../../design/index.js';", ['Composer'])).toBe(false);
  });

  it('maps the design page (DS7), its fixtures and the readable check to exact spec lists', () => {
    const row = (path: string) => FOLDER_SPECS.find((entry) => entry.path === path);
    // The page's own files: the page's spec and nothing else (the whole row is written out here, on its own)
    for (const path of ['gui/src/pages/DesignPage.tsx', 'gui/src/pages/DesignPieces.tsx', 'gui/src/pages/designPageLists.ts', 'gui/e2e/design-page-small-text.ts']) {
      expect(row(path), path).toBeDefined();
      expect(row(path)!.specs, path).toEqual(['e2e/design-page.spec.ts']);
      expect(getAffectedSpecs([path]), path).toEqual(['e2e/design-page.spec.ts']);
    }
    // The fixtures are under the Board folder, so the whole-page scans are added to every leaf there; their own test maps to the same row
    const fixtures = ['e2e/design-page.spec.ts', 'e2e/board-a11y.spec.ts', 'e2e/accessibility.spec.ts'];
    expect(row('gui/src/features/board/cards/cardFixtures.ts')!.specs).toEqual(fixtures);
    expect(getAffectedSpecs(['gui/src/features/board/cards/cardFixtures.ts'])).toEqual(fixtures);
    expect(getAffectedSpecs(['gui/src/features/board/cards/cardFixtures.test.ts'])).toEqual(fixtures);
    // The readable check lists every spec that imports it
    expect(row('gui/e2e/readable.ts')!.specs).toEqual(['e2e/board-overview-split.spec.ts', 'e2e/design-page.spec.ts']);
    expect(getAffectedSpecs(['gui/e2e/readable.ts'])).toEqual(['e2e/board-overview-split.spec.ts', 'e2e/design-page.spec.ts']);
    expect(getAffectedSpecs(['e2e/readable.ts'])).toEqual(['e2e/board-overview-split.spec.ts', 'e2e/design-page.spec.ts']);
    const importers = readdirSync('gui/e2e').filter((file) => file.endsWith('.spec.ts')
      && /from\s+['"]\.\/readable(?:\.[jt]s)?['"]/.test(readFileSync(`gui/e2e/${file}`, 'utf8'))).map((file) => `e2e/${file}`).sort();
    expect(importers).toEqual(['e2e/board-overview-split.spec.ts', 'e2e/design-page.spec.ts']);
    // The page's unit test is for no browser, and App.tsx, which has its route, is APP_WIDE
    expect(getAffectedSpecs(['gui/src/pages/designPage.test.ts'])).toEqual([]);
    expect(getAffectedSpecs(['gui/src/App.tsx'])).toEqual(['e2e']);
    // The pieces and the cards the page draws have its spec on their rows (lists written out in each piece's own test above)
    for (const path of [
      'gui/src/design/CardFrame.tsx', 'gui/src/design/Pill.tsx', 'gui/src/design/Mark.tsx', 'gui/src/design/FreshDot.tsx', 'gui/src/design/StepCheck.tsx',
      'gui/src/design/RowSurface.tsx', 'gui/src/design/Composer.tsx', 'gui/src/features/board/cards/cardParts.tsx', 'gui/src/features/board/cards/NoteCard.tsx',
      'gui/src/features/board/cards/FileCard.tsx', 'gui/src/features/board/rows/RowHead.tsx', 'gui/src/features/board/rows/RowControls.tsx',
    ]) expect(getAffectedSpecs([path]), path).toContain('e2e/design-page.spec.ts');
    // The page's files are imported only where they should be: DesignPage by App.tsx, DesignPieces by DesignPage
    const files = sourceFiles('gui/src');
    expect(files.filter((file) => /from\s+['"][^'"]*\/DesignPage(?:\.js)?['"]|import\(\s*['"][^'"]*\/DesignPage(?:\.js)?['"]/.test(readFileSync(file, 'utf8'))).sort()).toEqual(['gui/src/App.tsx']);
    expect(files.filter((file) => /from\s+['"]\.\/DesignPieces(?:\.js)?['"]/.test(readFileSync(file, 'utf8'))).sort()).toEqual(['gui/src/pages/DesignPage.tsx']);
  });

  it('covers every row in FOLDER_SPECS, its src/ and test variants, and existing specs', () => {
    expect(FOLDER_SPECS.length).toBeGreaterThan(20);
    for (const entry of FOLDER_SPECS) {
      expect(new Set(entry.specs).size, `${entry.path} duplicate specs`).toBe(entry.specs.length);
      for (const spec of entry.specs) {
        // 'e2e/board' is a filter for the whole Board folder, not a file
        if (spec === 'e2e/board') continue;
        expect(existsSync(`gui/${spec}`), `${entry.path} -> ${spec}`).toBe(true);
      }
      // knowledgeIndex is a central Board file: it runs all of e2e/board plus its non-Board specs.
      if (entry.path === 'gui/src/features/knowledge/knowledgeIndex.ts') {
        const expected = ['e2e/board', ...entry.specs.filter((spec) => !spec.startsWith('e2e/board'))];
        expect(getAffectedSpecs([entry.path]), entry.path).toEqual(expected);
        continue;
      }
      expect(getAffectedSpecs([entry.path]), entry.path).toEqual(entry.specs);
      const srcPath = entry.path.replace(/^gui\//, '');
      expect(getAffectedSpecs([srcPath]), srcPath).toEqual(entry.specs);

      const ext = entry.path.endsWith('.tsx') ? '.test.tsx' : '.test.ts';
      const testPath = entry.path.replace(/\.[^.]+$/, ext);
      expect(getAffectedSpecs([testPath]), testPath).toEqual(entry.specs);

      for (const bare of entry.bareNames ?? []) {
        expect(getAffectedSpecs([bare]), `${entry.path} bare:${bare}`).toEqual(entry.specs);
      }
    }

    // PA1 point-and-ask spec is included on reader, dock, code window, reviewHistory, and now-line rows.
    for (const file of [
      'gui/src/features/board/BoardReader.tsx',
      'gui/src/features/board/boardReaderLayout.ts',
      'gui/src/features/board/boardDock.ts',
      'gui/src/features/changes/CodeWindow.tsx',
      'gui/src/features/changes/CodeWindowSlot.tsx',
      'gui/src/features/changes/reviewHistory.ts',
      'gui/src/features/board/BoardNowLine.tsx',
      'gui/src/features/board/nowLine.ts',
    ]) {
      expect(getAffectedSpecs([file]), file).toContain('e2e/board-point-and-ask.spec.ts');
    }

    // All Reader rows include every spec that opens or walks the Board Reader.
    for (const file of [
      'gui/src/features/board/BoardReader.tsx',
      'gui/src/features/board/boardReaderLayout.ts',
      'gui/src/features/board/boardReaderTrail.ts',
      'gui/src/features/board/readerPolicy.ts',
      'gui/src/features/board/boardDock.ts',
    ]) {
      expect(getAffectedSpecs([file]), file).toEqual(expect.arrayContaining([
        ...BOARD_READER_SPECS,
      ]));
    }
    expect(getAffectedSpecs(['gui/src/features/board/boardDock.ts'])).toEqual(expect.arrayContaining([
      'e2e/board-commits.spec.ts',
      'e2e/board-commit-list.spec.ts',
      'e2e/board-commit-notes.spec.ts',
      'e2e/board-incoming.spec.ts',
    ]));

    expect(getAffectedSpecs(['gui/src/features/board/ReaderPage.tsx'])).toEqual(expect.arrayContaining([
      'e2e/board-document-links.spec.ts',
      'e2e/board-workspace-files.spec.ts',
      'e2e/board-files.spec.ts',
    ]));

    // Sidebar / Board index, NoteDialog, and answerHoldOff cover all callers (including board-area-view, overview, coworking).
    expect(getAffectedSpecs(['gui/src/features/board/BoardSidebar.tsx'])).toEqual(expect.arrayContaining(BOARD_SIDEBAR_SPECS));
    expect(getAffectedSpecs(['gui/src/features/board/NoteDialog.tsx'])).toEqual(expect.arrayContaining([
      'e2e/board-notes.spec.ts',
      'e2e/board-area.spec.ts',
      'e2e/board-area-view.spec.ts',
    ]));
    expect(getAffectedSpecs(['gui/src/features/board/answerHoldOff.ts'])).toEqual(expect.arrayContaining([
      'e2e/board-decisions.spec.ts',
      'e2e/board-area-view.spec.ts',
    ]));

    // Questions rows cover board-overview and board-overview-split (plus workspaceFilesArea/boardNav/boardReader callers).
    for (const file of [
      'gui/src/features/board/questionsArea.ts',
      'gui/src/features/board/questionsData.ts',
    ]) {
      expect(getAffectedSpecs([file]), file).toEqual(expect.arrayContaining([
        'e2e/board-questions.spec.ts',
        'e2e/board-overview-split.spec.ts',
        'e2e/board-overview.spec.ts',
      ]));
    }
    expect(getAffectedSpecs(['gui/src/features/board/questionsArea.ts'])).toEqual(expect.arrayContaining([
      'e2e/board-reader.spec.ts',
      'e2e/board-workspace-files.spec.ts',
      'e2e/board-files.spec.ts',
      'e2e/board-now-line.spec.ts',
      'e2e/board-index.spec.ts',
      'e2e/board-press.spec.ts',
      'e2e/board-w2-tiers.spec.ts',
      'e2e/board-area-view.spec.ts',
    ]));

    expect(getAffectedSpecs(['gui/src/features/board/boardReveal.ts'])).toEqual(expect.arrayContaining([
      'e2e/board-a11y.spec.ts',
      'e2e/board-area.spec.ts',
      'e2e/board-assignment.spec.ts',
      'e2e/board-live.spec.ts',
      'e2e/board-reader.spec.ts',
    ]));

    // CodeWindow, CodeWindowSlot, reviewHistory, CommitsView, commitListModel, and commitContext cover all Review/CodeWindow callers.
    for (const file of [
      'gui/src/features/changes/CodeWindow.tsx',
      'gui/src/features/changes/CodeWindowSlot.tsx',
      'gui/src/features/changes/reviewHistory.ts',
      'gui/src/features/changes/CommitsView.tsx',
      'gui/src/features/changes/commitListModel.ts',
      'gui/src/features/changes/commitsMode.ts',
      'gui/src/features/board/commitContext.ts',
    ]) {
      expect(getAffectedSpecs([file]), file).toEqual(expect.arrayContaining([
        'e2e/board-code-window.spec.ts',
        'e2e/board-review-page.spec.ts',
        'e2e/board-commits.spec.ts',
        'e2e/board-commit-list.spec.ts',
        'e2e/board-commit-notes.spec.ts',
        'e2e/board-incoming.spec.ts',
        'e2e/board-document-links.spec.ts',
        'e2e/board-point-and-ask.spec.ts',
        'e2e/workspace-shell.spec.ts',
        'e2e/keyboard-journey.spec.ts',
        'e2e/accessibility.spec.ts',
        'e2e/diff-review.spec.ts',
        'e2e/terminal-code-tree.spec.ts',
      ]));
    }
    expect(getAffectedSpecs(['gui/src/features/board/commitContext.ts'])).toEqual(expect.arrayContaining([
      'e2e/board-a11y.spec.ts',
      'e2e/board-assignment.spec.ts',
      'e2e/board-files.spec.ts',
      'e2e/board-index.spec.ts',
      'e2e/board-live.spec.ts',
      'e2e/board-reader.spec.ts',
      'e2e/board-workspace-files.spec.ts',
    ]));
    expect(getAffectedSpecs(['gui/src/features/board/commitSequence.ts'])).toEqual(expect.arrayContaining([
      'e2e/board-commits.spec.ts',
      'e2e/board-commit-list.spec.ts',
      'e2e/board-commit-notes.spec.ts',
      'e2e/board-incoming.spec.ts',
      'e2e/board-review-page.spec.ts',
      'e2e/board-area.spec.ts',
    ]));
    for (const file of [
      'gui/src/features/board/BoardNowLine.tsx',
      'gui/src/features/board/nowLine.ts',
    ]) {
      expect(getAffectedSpecs([file]), file).toEqual(expect.arrayContaining([
        'e2e/board-commit-notes.spec.ts',
        'e2e/board-questions.spec.ts',
        'e2e/board-incoming.spec.ts',
        'e2e/board-overview.spec.ts',
        'e2e/board-overview-split.spec.ts',
        'e2e/board-back.spec.ts',
        'e2e/board-assignment.spec.ts',
        'e2e/board-terminal-coworking.spec.ts',
        'e2e/board-a11y.spec.ts',
        'e2e/board-plan-parity.spec.ts',
        'e2e/board-press.spec.ts',
        'e2e/board-w2-tiers.spec.ts',
        'e2e/archive.spec.ts',
      ]));
    }
    for (const file of [
      'gui/src/features/board/BoardKnowledge.tsx',
      'gui/src/features/knowledge/KnowledgeView.tsx',
      'gui/src/features/knowledge/knowledgeIndex.ts',
      'gui/src/features/knowledge/useKnowledge.ts',
      'gui/src/features/board/AssignmentCard.tsx',
      'gui/src/features/board/assignmentCardView.ts',
    ]) {
      expect(getAffectedSpecs([file]), file).toEqual(expect.arrayContaining([
        'e2e/workspace-shell.spec.ts',
        'e2e/archive.spec.ts',
      ]));
    }
    for (const file of [
      'gui/src/features/board/AssignmentCard.tsx',
      'gui/src/features/board/assignmentCardView.ts',
    ]) {
      expect(getAffectedSpecs([file]), file).toEqual(expect.arrayContaining([
        'e2e/keyboard-journey.spec.ts',
        'e2e/board-terminal-coworking.spec.ts',
        'e2e/board-overview.spec.ts',
        'e2e/board-overview-split.spec.ts',
        'e2e/board-now-line.spec.ts',
        'e2e/board-a11y.spec.ts',
      ]));
    }

    // Passing a single existing file path is preserved as a file path, and option-like base refs are rejected.
    expect(resolveChangedFiles(['gui/src/App.tsx'], null)).toEqual(['gui/src/App.tsx']);
    expect(resolveChangedFiles([], '--exec=evil')).toEqual([]);
  });

  it('normalizes Windows path separators across all path kinds', () => {
    expect(getAffectedSpecs(['gui\\src\\features\\board\\BoardReader.tsx'])).toEqual([...BOARD_READER_SPECS, 'e2e/accessibility.spec.ts']);
    expect(getAffectedSpecs(['src\\components\\Diagram.tsx'])).toEqual([
      'e2e/board-questions.spec.ts',
      'e2e/board-reader.spec.ts',
      'e2e/board-copy.spec.ts',
    ]);
    expect(getAffectedSpecs(['src\\index.css'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['src\\design\\tokens.css'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['src\\components\\ui\\button.tsx'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['gui\\e2e\\fixtures.ts'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['gui\\src\\features\\board\\areas\\types.ts'])).toEqual(['e2e/board']);
    expect(getAffectedSpecs(['gui\\src\\features\\board\\nodeTypes.ts'])).toEqual(['e2e/board']);
    expect(getAffectedSpecs(['gui/src/features/knowledge/knowledgeIndex.ts'])).toEqual([
      'e2e/board',
      'e2e/workspace-shell.spec.ts',
      'e2e/archive.spec.ts',
      'e2e/accessibility.spec.ts',
    ]);
    for (const file of [
      'gui/src/features/board/BoardSidebar.tsx',
      'gui/src/features/board/AssignmentCard.tsx',
      'gui/src/features/board/assignmentCardView.ts',
      'gui/src/features/board/BoardNowLine.tsx',
    ]) {
      expect(getAffectedSpecs([file]), file).toEqual(expect.arrayContaining([
        'e2e/board-a11y.spec.ts',
        'e2e/accessibility.spec.ts',
      ]));
    }
    for (const entry of FOLDER_SPECS) {
      if (/^gui\/src\/features\/(board|knowledge|progress)\//.test(entry.path)) {
        expect(entry.specs, entry.path).toEqual(expect.arrayContaining([
          'e2e/board-a11y.spec.ts',
          'e2e/accessibility.spec.ts',
        ]));
      }
    }
    expect(getAffectedSpecs(['gui\\src\\features\\board\\unmapped.tsx'])).toEqual(['e2e/board']);
    expect(getAffectedSpecs(['gui\\src\\unmapped.tsx'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['gui\\e2e\\board-notes.spec.ts'])).toEqual(['e2e/board-notes.spec.ts']);
  });
});
