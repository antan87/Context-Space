import { existsSync, readdirSync } from 'node:fs';
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
    ]);
    expect(getAffectedSpecs(['src/lib/diagram.ts'])).toEqual([
      'e2e/board-questions.spec.ts',
      'e2e/board-reader.spec.ts',
    ]);
    expect(getAffectedSpecs(['src/diagram-frame.ts'])).toEqual([
      'e2e/board-questions.spec.ts',
      'e2e/board-reader.spec.ts',
    ]);

    // Unknown paths inside src/features/board/ run e2e/board; anywhere else runs e2e.
    expect(getAffectedSpecs(['gui/src/features/board/unmapped.tsx'])).toEqual(['e2e/board']);
    expect(getAffectedSpecs(['src/features/board/unmapped.tsx'])).toEqual(['e2e/board']);
    expect(getAffectedSpecs(['gui/src/features/board/cards/futureCard.tsx'])).toEqual(['e2e/board']);

    expect(getAffectedSpecs(['gui/src/unmapped.tsx'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['src/unmapped.tsx'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['src/design/x.tsx'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['gui/src/design/CardFrame.tsx'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['src/features/chat/ChatPanel.tsx'])).toEqual(['e2e']);
    expect(getAffectedSpecs(['src/core/workspace.ts'])).toEqual(['e2e']);
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
    for (const name of ['nodeTypes', 'areas/types', 'overview/plan', 'BoardRowHead', 'BoardCheckpoint', 'BoardNodes']) {
      expect(CENTRAL_BOARD_FILES.has(name), name).toBe(true);
    }

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

  it('covers every row in FOLDER_SPECS, its src/ and test variants, and existing specs', () => {
    expect(FOLDER_SPECS.length).toBeGreaterThan(20);
    for (const entry of FOLDER_SPECS) {
      expect(new Set(entry.specs).size, `${entry.path} duplicate specs`).toBe(entry.specs.length);
      for (const spec of entry.specs) {
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
