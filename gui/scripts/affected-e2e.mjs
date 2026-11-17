#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ============================================================================
 * Leaf Feature to E2E Spec Mappings & Safety Justifications
 * ============================================================================
 * Only clearly separated leaf modules are mapped to narrow specs (see FOLDER_SPECS
 * below for the full authoritative mapping and safety rationale). Any change to
 * an APP_WIDE file or any unmapped path outside `gui/src/features/board/` runs
 * all of `gui/e2e`; any change to a central Board file or unmapped path inside
 * `gui/src/features/board/` runs all of `e2e/board`.
 * ============================================================================
 */

const GUI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(GUI_ROOT, '..');

export function normalizeInputPath(file) {
  return file.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^(?:\.\/)+/, '');
}

export function toRepoRelPath(file) {
  if (file.startsWith('gui/')) return file;
  if (file.startsWith('src/') || file.startsWith('e2e/')) return `gui/${file}`;
  if (file === 'playwright.config.ts') return 'gui/playwright.config.ts';
  return file;
}

/**
 * Files whose change can affect any screen across the entire app (all of `gui/e2e`).
 */
export const APP_WIDE_FILES = new Set([
  'gui/src/index.css',
  'gui/src/design/tokens.css',
  'gui/src/design/index.ts',
  'gui/src/App.tsx',
  'gui/src/main.tsx',
  'gui/e2e/fixtures.ts',
  'gui/e2e/global-setup.ts',
  'gui/playwright.config.ts',
]);

export const APP_WIDE_PREFIXES = ['gui/src/components/ui/'];

/**
 * Files no browser can see: the design module's written guide, its style-guard
 * test and the guard's baseline (DS2a). A change to only these runs unit tests
 * and no Playwright spec (`getAffectedSpecs` returns an empty list).
 * `gui/src/design/index.ts` is NOT here: it stays APP_WIDE.
 */
export const NO_BROWSER_FILES = new Set([
  'gui/src/design/designGuard.test.ts',
  'gui/src/design/design-baseline.json',
]);

export function isNoBrowserFile(file) {
  if (!file) return false;
  const normalized = normalizeInputPath(file);
  if (!normalized) return false;
  const repoRel = toRepoRelPath(normalized);
  return NO_BROWSER_FILES.has(repoRel) || /^gui\/src\/design\/(?:[^/]+\/)*[^/]+\.md$/.test(repoRel);
}

export function isAppWideFile(file) {
  if (!file) return false;
  const normalized = normalizeInputPath(file);
  if (!normalized) return false;
  const repoRel = toRepoRelPath(normalized);
  if (APP_WIDE_FILES.has(repoRel)) return true;
  return APP_WIDE_PREFIXES.some((prefix) => repoRel.startsWith(prefix));
}

/**
 * Shared or central board files. Any change to these files runs all of `e2e/board`
 * (matched at `gui/src/features/board/<entry>` or bare `<entry>` without directories).
 */
export const CENTRAL_BOARD_FILES = new Set([
  'BoardSection',
  'BoardSection.tsx',
  'BoardNodes',
  'BoardNodes.tsx',
  'boardAreas',
  'boardAreas.ts',
  'boardRows',
  'boardRows.ts',
  'boardLayout',
  'boardLayout.ts',
  'boardActions',
  'boardActions.ts',
  'boardData',
  'boardData.ts',
  'boardNav',
  'boardNav.ts',
  'boardView',
  'boardView.ts',
  'boardFolds',
  'boardFolds.ts',
  'BoardRowHead',
  'BoardRowHead.tsx',
  'BoardCheckpoint',
  'BoardCheckpoint.tsx',
  'boardThread',
  'boardThread.ts',
  'boardMiniPicture',
  'boardMiniPicture.ts',
  'nodeTypes',
  'nodeTypes.ts',
  'areas/types',
  'areas/types.ts',
  'overview/plan',
  'overview/plan.ts',
]);

export function isCentralBoardFile(file) {
  if (!file) return false;
  const normalized = normalizeInputPath(file);
  if (!normalized) return false;
  if (!normalized.includes('/')) {
    const baseNoExt = normalized.replace(/(?:\.(?:test|spec))?\.[^.]+$/, '');
    return CENTRAL_BOARD_FILES.has(normalized) || CENTRAL_BOARD_FILES.has(baseNoExt);
  }
  const repoRel = toRepoRelPath(normalized);
  const boardPrefix = 'gui/src/features/board/';
  if (!repoRel.startsWith(boardPrefix)) return false;
  const boardRel = repoRel.slice(boardPrefix.length);
  const boardRelNoExt = boardRel.replace(/(?:\.(?:test|spec))?\.[^.]+$/, '');
  return CENTRAL_BOARD_FILES.has(boardRel) || CENTRAL_BOARD_FILES.has(boardRelNoExt);
}

const READER_SPECS = [
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

const CODE_WINDOW_SPECS = [
  'e2e/board-code-window.spec.ts',
  'e2e/board-review-page.spec.ts',
  'e2e/board-commits.spec.ts',
  'e2e/board-commit-list.spec.ts',
  'e2e/board-commit-notes.spec.ts',
  'e2e/board-incoming.spec.ts',
  'e2e/board-document-links.spec.ts',
  'e2e/board-point-and-ask.spec.ts',
  'e2e/board-files.spec.ts',
  'e2e/board-questions.spec.ts',
  'e2e/board-area.spec.ts',
  'e2e/workspace-shell.spec.ts',
  'e2e/accessibility.spec.ts',
  'e2e/keyboard-journey.spec.ts',
  'e2e/diff-review.spec.ts',
  'e2e/fallback-diff-gutter.spec.ts',
  'e2e/code-tree.spec.ts',
  'e2e/safe-delivery.spec.ts',
  'e2e/dashboard.spec.ts',
  'e2e/terminal-code-tree.spec.ts',
  'e2e/terminal-pr-links.spec.ts',
  'e2e/where-are-we.spec.ts',
  'e2e/chat-dock.spec.ts',
];

const NOW_LINE_SPECS = [
  'e2e/board-now-line.spec.ts',
  'e2e/board-knowledge.spec.ts',
  'e2e/board-commit-notes.spec.ts',
  'e2e/board-questions.spec.ts',
  'e2e/board-incoming.spec.ts',
  'e2e/board-overview.spec.ts',
  'e2e/board-overview-split.spec.ts',
  'e2e/board-back.spec.ts',
  'e2e/board-assignment.spec.ts',
  'e2e/board-point-and-ask.spec.ts',
  'e2e/board-area.spec.ts',
  'e2e/board-area-view.spec.ts',
  'e2e/board-terminal-coworking.spec.ts',
  'e2e/board-a11y.spec.ts',
  'e2e/board-plan-parity.spec.ts',
  'e2e/board-press.spec.ts',
  'e2e/board-w2-tiers.spec.ts',
  'e2e/archive.spec.ts',
  'e2e/workspace-shell.spec.ts',
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

const COMMIT_CARD_BOARD_SPECS = [
  'e2e/board-commits.spec.ts',
  'e2e/board-commit-list.spec.ts',
  'e2e/board-commit-notes.spec.ts',
  'e2e/board-incoming.spec.ts',
  'e2e/board-code-window.spec.ts',
  'e2e/board-review-page.spec.ts',
  'e2e/board-area.spec.ts',
  'e2e/board-area-view.spec.ts',
  'e2e/board-back.spec.ts',
  'e2e/board-decisions.spec.ts',
  'e2e/board-document-links.spec.ts',
  'e2e/board-knowledge.spec.ts',
  'e2e/board-notes.spec.ts',
  'e2e/board-now-line.spec.ts',
  'e2e/board-overview.spec.ts',
  'e2e/board-overview-split.spec.ts',
  'e2e/board-press.spec.ts',
  'e2e/board-questions.spec.ts',
  'e2e/board-reader-back.spec.ts',
  'e2e/board-step-ticking.spec.ts',
  'e2e/board-w2-tiers.spec.ts',
  'e2e/board-a11y.spec.ts',
  'e2e/board-assignment.spec.ts',
  'e2e/board-files.spec.ts',
  'e2e/board-index.spec.ts',
  'e2e/board-live.spec.ts',
  'e2e/board-reader.spec.ts',
  'e2e/board-workspace-files.spec.ts',
];

/**
 * The shared pieces of every Board card (DS2b): `cards/cardParts.tsx` (Anchors, the press of a compact card, the cut text,
 * Read all, the byline and the mark) and `design/CardFrame.tsx` (the card's article and its states). Every card kind draws
 * them, and a hand-picked list missed real specs (reader-nav, reader-back, terminal-coworking, commit-notes), so a change
 * runs all of e2e/board plus the whole-page accessibility scan outside it. Not all of e2e: only BoardNodes.tsx imports
 * them (a unit test checks that, also through design/index), and design/index.ts, which exports CardFrame, is APP_WIDE.
 */
const CARD_PARTS_SPECS = ['e2e/board', 'e2e/accessibility.spec.ts'];

const FOLDER_ROWS = [
  ...['lib/diagram.ts', 'lib/diagramFrame.ts', 'lib/diagramSafety.ts', 'diagram-frame.ts', 'components/Diagram.tsx', 'components/diagramFixContext.ts'].map((file) => ({
    folder: `src/${file.replace(/\.tsx?$/, '')}`,
    path: `gui/src/${file}`,
    bareNames: [path.basename(file)],
    specs: ['e2e/board-questions.spec.ts', 'e2e/board-reader.spec.ts'],
    safety: 'Shared diagram drawing on answer cards and Markdown in the reader; exercised in both specs.',
  })),
  // Board Reader (reader overlay, pages, navigation, and reader docking)
  {
    folder: 'src/features/board/BoardReader',
    path: 'gui/src/features/board/BoardReader.tsx',
    bareNames: ['BoardReader', 'BoardReader.tsx'],
    specs: READER_SPECS,
    safety: 'Independent reader drawer, fullscreen/docked views, Knowledge view, and line-notes integration; verified by all specs opening the Board Reader.',
  },
  {
    folder: 'src/features/board/ReaderPage',
    path: 'gui/src/features/board/ReaderPage.tsx',
    bareNames: ['ReaderPage', 'ReaderPage.tsx'],
    specs: [
      'e2e/board-reader.spec.ts',
      'e2e/board-reader-back.spec.ts',
      'e2e/board-reader-nav.spec.ts',
      'e2e/board-browsing.spec.ts',
      'e2e/board-document-links.spec.ts',
      'e2e/board-workspace-files.spec.ts',
      'e2e/board-files.spec.ts',
    ],
    safety: 'HTML document iframe and raw source page container; verified by reader, browsing, document-links, workspace-files, and files specs.',
  },
  {
    folder: 'src/features/board/boardReaderLayout',
    path: 'gui/src/features/board/boardReaderLayout.ts',
    bareNames: ['boardReaderLayout', 'boardReaderLayout.ts'],
    specs: READER_SPECS,
    safety: 'Reader drawer layout math, layout preference, and target collection; verified by all specs opening or stepping through the Board Reader.',
  },
  {
    folder: 'src/features/board/boardReaderTrail',
    path: 'gui/src/features/board/boardReaderTrail.ts',
    bareNames: ['boardReaderTrail', 'boardReaderTrail.ts'],
    specs: READER_SPECS,
    safety: 'Reader breadcrumb navigation trail; verified by all specs opening or navigating within the Board Reader.',
  },
  {
    folder: 'src/features/board/readerPolicy',
    path: 'gui/src/features/board/readerPolicy.ts',
    bareNames: ['readerPolicy', 'readerPolicy.ts'],
    specs: READER_SPECS,
    safety: 'Reader open/close policy logic; verified by all Reader specs alongside readerPolicy.test.ts.',
  },
  {
    folder: 'src/features/board/boardDock',
    path: 'gui/src/features/board/boardDock.ts',
    bareNames: ['boardDock', 'boardDock.ts'],
    specs: [
      ...READER_SPECS,
      'e2e/board-commit-list.spec.ts',
      'e2e/board-commit-notes.spec.ts',
      'e2e/board-incoming.spec.ts',
    ],
    safety: 'Reader dock sizing (readerDock) and fileTitle helper (used by BoardSection, boardActions, and commitContext); verified by all Reader and commit specs.',
  },

  // Overview Reveal Viewport
  {
    folder: 'src/features/board/boardReveal',
    path: 'gui/src/features/board/boardReveal.ts',
    bareNames: ['boardReveal', 'boardReveal.ts'],
    specs: [
      'e2e/board-overview.spec.ts',
      'e2e/board-overview-split.spec.ts',
      'e2e/board-w2-tiers.spec.ts',
      'e2e/board-back.spec.ts',
      'e2e/board-press.spec.ts',
      'e2e/board-index.spec.ts',
      'e2e/board-now-line.spec.ts',
      'e2e/board-area-view.spec.ts',
      'e2e/board-terminal-coworking.spec.ts',
      'e2e/board-a11y.spec.ts',
      'e2e/board-area.spec.ts',
      'e2e/board-assignment.spec.ts',
      'e2e/board-live.spec.ts',
      'e2e/board-reader.spec.ts',
    ],
    safety: 'Pure math helper (revealViewport) for overview card positioning and focus reveal (showFocused / revealOverviewNode in BoardSection); verified by all overview, focus-reveal, and transform assertions.',
  },

  // Changes / Code Window / Review Page
  {
    folder: 'src/features/changes/CodeWindow',
    path: 'gui/src/features/changes/CodeWindow.tsx',
    bareNames: ['CodeWindow', 'CodeWindow.tsx'],
    specs: CODE_WINDOW_SPECS,
    safety: 'Full-frame Review page and keyboard/focus shell hosting uncommitted, commits, and file modes; verified by all Review/CodeWindow specs.',
  },
  {
    folder: 'src/features/changes/CodeWindowSlot',
    path: 'gui/src/features/changes/CodeWindowSlot.tsx',
    bareNames: ['CodeWindowSlot', 'CodeWindowSlot.tsx'],
    specs: CODE_WINDOW_SPECS,
    safety: 'Mount slot and browser-history integration for Review page; verified by all Review/CodeWindow and /changes redirect specs.',
  },
  {
    folder: 'src/features/changes/reviewHistory',
    path: 'gui/src/features/changes/reviewHistory.ts',
    bareNames: ['reviewHistory', 'reviewHistory.ts'],
    specs: CODE_WINDOW_SPECS,
    safety: 'Session-scoped Review history token state machine (used by App.tsx and CodeWindowSlot.tsx); verified by reviewHistory.test.ts and all Review/CodeWindow specs.',
  },

  // Now line
  {
    folder: 'src/features/board/BoardNowLine',
    path: 'gui/src/features/board/BoardNowLine.tsx',
    bareNames: ['BoardNowLine', 'BoardNowLine.tsx'],
    specs: NOW_LINE_SPECS,
    safety: 'Board current-time indicator line overlay and its What\'s new popover; verified by all specs asserting on the Now line, What\'s new, or overview pane height.',
  },
  {
    folder: 'src/features/board/nowLine',
    path: 'gui/src/features/board/nowLine.ts',
    bareNames: ['nowLine', 'nowLine.ts'],
    specs: NOW_LINE_SPECS,
    safety: 'Now line positioning math and What\'s new line formatting/targets; verified by all Now line specs.',
  },

  // Assignment card (description and specs at the top of the overview)
  {
    folder: 'src/features/board/AssignmentCard',
    path: 'gui/src/features/board/AssignmentCard.tsx',
    bareNames: ['AssignmentCard', 'AssignmentCard.tsx'],
    specs: [
      'e2e/board-assignment.spec.ts',
      'e2e/board-overview.spec.ts',
      'e2e/board-overview-split.spec.ts',
      'e2e/board-now-line.spec.ts',
      'e2e/board-a11y.spec.ts',
      'e2e/board-terminal-coworking.spec.ts',
      'e2e/keyboard-journey.spec.ts',
      'e2e/workspace-shell.spec.ts',
      'e2e/archive.spec.ts',
    ],
    safety: 'Card and panel above the overview stage, with their own drafts and requests; verified by board-assignment, board-overview, board-overview-split (text-size walk), board-now-line (height & label checks), board-a11y (Axe), coworking (height fit), keyboard-journey, workspace-shell (draft retention), and archive specs.',
  },
  {
    folder: 'src/features/board/assignmentCardView',
    path: 'gui/src/features/board/assignmentCardView.ts',
    bareNames: ['assignmentCardView', 'assignmentCardView.ts'],
    specs: [
      'e2e/board-assignment.spec.ts',
      'e2e/board-overview.spec.ts',
      'e2e/board-overview-split.spec.ts',
      'e2e/board-now-line.spec.ts',
      'e2e/board-a11y.spec.ts',
      'e2e/board-terminal-coworking.spec.ts',
      'e2e/keyboard-journey.spec.ts',
      'e2e/workspace-shell.spec.ts',
      'e2e/archive.spec.ts',
    ],
    safety: 'Pure helpers (compact card view, save bodies, spec checks) used by AssignmentCard and BoardSection; unit tested and verified by all AssignmentCard specs.',
  },

  // Decisions / Answer hold-off
  {
    folder: 'src/features/board/answerHoldOff',
    path: 'gui/src/features/board/answerHoldOff.ts',
    bareNames: ['answerHoldOff', 'answerHoldOff.ts'],
    specs: ['e2e/board-decisions.spec.ts', 'e2e/board-area-view.spec.ts'],
    safety: 'Hold-off timer logic for question prompt decisions; verified by board-decisions.spec.ts and board-area-view.spec.ts.',
  },

  // Commits mode of the Code window
  {
    folder: 'src/features/changes/CommitsView',
    path: 'gui/src/features/changes/CommitsView.tsx',
    bareNames: ['CommitsView', 'CommitsView.tsx'],
    specs: CODE_WINDOW_SPECS,
    safety: 'Commits mode of the Code window (imported unconditionally by CodeSection for commit list, commit view, notes panel, incoming commits, files grid, step jump, diff flow); verified by all Review/CodeWindow specs.',
  },
  {
    folder: 'src/features/changes/commitListModel',
    path: 'gui/src/features/changes/commitListModel.ts',
    bareNames: ['commitListModel', 'commitListModel.ts'],
    specs: CODE_WINDOW_SPECS,
    safety: 'Pure tree flattening, deduplication, step formatting and keyboard state machine (buildCommitListGroups runs on every CodeSection render); verified by commitListModel.test.ts and all Review/CodeWindow specs.',
  },
  {
    folder: 'src/features/changes/commitsMode',
    path: 'gui/src/features/changes/commitsMode.ts',
    bareNames: ['commitsMode', 'commitsMode.ts'],
    specs: CODE_WINDOW_SPECS,
    safety: 'Helpers for row order, commit lists, and mode state (including applyCodeRequest in CodeSection); unit tested and verified by all Review/commit specs.',
  },
  {
    folder: 'src/features/board/commitSequence',
    path: 'gui/src/features/board/commitSequence.ts',
    bareNames: ['commitSequence', 'commitSequence.ts'],
    specs: [
      'e2e/board-commits.spec.ts',
      'e2e/board-commit-list.spec.ts',
      'e2e/board-commit-notes.spec.ts',
      'e2e/board-incoming.spec.ts',
      'e2e/board-code-window.spec.ts',
      'e2e/board-review-page.spec.ts',
      'e2e/board-area.spec.ts',
    ],
    safety: 'Finds the row of a commit card for the Code window; verified by commits, commit-list, commit-notes, incoming, code-window, review-page, and area specs.',
  },
  {
    folder: 'src/features/board/commitContext',
    path: 'gui/src/features/board/commitContext.ts',
    bareNames: ['commitContext', 'commitContext.ts'],
    specs: Array.from(new Set([...COMMIT_CARD_BOARD_SPECS, ...CODE_WINDOW_SPECS])),
    safety: 'Commit context helper used by boardAreas (for every commit card) and CommitsView (inside CodeSection); verified by commitContext.test.ts, all Board specs with commit cards, and all CodeWindow specs.',
  },

  // Notes
  {
    folder: 'src/features/board/NoteDialog',
    path: 'gui/src/features/board/NoteDialog.tsx',
    bareNames: ['NoteDialog', 'NoteDialog.tsx'],
    specs: ['e2e/board-notes.spec.ts', 'e2e/board-area.spec.ts', 'e2e/board-area-view.spec.ts'],
    safety: 'Note creation and edit modal; verified by board-notes.spec.ts, board-area.spec.ts, and board-area-view.spec.ts.',
  },

  // Sidebar / Index
  {
    folder: 'src/features/board/BoardSidebar',
    path: 'gui/src/features/board/BoardSidebar.tsx',
    bareNames: ['BoardSidebar', 'BoardSidebar.tsx'],
    specs: BOARD_SIDEBAR_SPECS,
    safety: 'Index sidebar navigation drawer; verified by all specs interacting with or asserting on nav[aria-label="Board index"].',
  },

  // Knowledge on the Board (its index entry, search, news lines and the reader)
  {
    folder: 'src/features/board/BoardKnowledge',
    path: 'gui/src/features/board/BoardKnowledge.tsx',
    bareNames: ['BoardKnowledge', 'BoardKnowledge.tsx'],
    specs: ['e2e/board-knowledge.spec.ts', 'e2e/workspace-shell.spec.ts', 'e2e/archive.spec.ts'],
    safety: 'Knowledge as the Board reader draws it (loading, empty, error, entries); verified by board-knowledge, workspace-shell, and archive specs.',
  },
  {
    folder: 'src/features/knowledge/KnowledgeView',
    path: 'gui/src/features/knowledge/KnowledgeView.tsx',
    bareNames: ['KnowledgeView', 'KnowledgeView.tsx'],
    specs: ['e2e/board-knowledge.spec.ts', 'e2e/workspace-shell.spec.ts', 'e2e/archive.spec.ts'],
    safety: 'Entries, search, filter and coming to an entry; verified by board-knowledge, workspace-shell, and archive specs.',
  },
  {
    folder: 'src/features/knowledge/knowledgeIndex',
    path: 'gui/src/features/knowledge/knowledgeIndex.ts',
    bareNames: ['knowledgeIndex', 'knowledgeIndex.ts'],
    specs: Array.from(new Set([
      ...BOARD_SIDEBAR_SPECS,
      'e2e/board-browsing.spec.ts',
      'e2e/board-reader-nav.spec.ts',
      'e2e/board-reader.spec.ts',
      'e2e/workspace-shell.spec.ts',
      'e2e/archive.spec.ts',
    ])),
    safety: 'Pure words and matching for the index entry, search and news lines (imported by BoardSidebar, nowLine, BoardReader, KnowledgeView); unit tested and verified by knowledge, sidebar, now-line, workspace-shell, and archive specs.',
  },
  {
    folder: 'src/features/knowledge/useKnowledge',
    path: 'gui/src/features/knowledge/useKnowledge.ts',
    bareNames: ['useKnowledge', 'useKnowledge.ts'],
    specs: [
      'e2e/board-knowledge.spec.ts',
      'e2e/workspace-shell.spec.ts',
      'e2e/archive.spec.ts',
      'e2e/board-index.spec.ts',
      'e2e/board-now-line.spec.ts',
    ],
    safety: 'Reads the knowledge file for the Board (used by BoardSection and BoardKnowledge); verified by board-knowledge, workspace-shell, archive, index, and now-line specs.',
  },

  // Questions space (answers from explain/*.md as Areas of cards)
  {
    folder: 'src/features/board/questionsArea',
    path: 'gui/src/features/board/questionsArea.ts',
    bareNames: ['questionsArea', 'questionsArea.ts'],
    specs: [
      'e2e/board-questions.spec.ts',
      'e2e/board-overview-split.spec.ts',
      'e2e/board-overview.spec.ts',
      'e2e/board-reader.spec.ts',
      'e2e/board-workspace-files.spec.ts',
      'e2e/board-files.spec.ts',
      'e2e/board-now-line.spec.ts',
      'e2e/board-index.spec.ts',
      'e2e/board-press.spec.ts',
      'e2e/board-w2-tiers.spec.ts',
      'e2e/board-area-view.spec.ts',
    ],
    safety: 'Pure mapping of answers to Areas, rows, cards, counts, question-file predicates, and index lines (used by BoardReader, workspaceFilesArea, boardNav, boardCountNav); unit tested and verified by questions, overview, reader, files, now-line, index, press, tier, and area-view specs.',
  },
  {
    folder: 'src/features/board/questionsData',
    path: 'gui/src/features/board/questionsData.ts',
    bareNames: ['questionsData', 'questionsData.ts'],
    specs: [
      'e2e/board-questions.spec.ts',
      'e2e/board-overview-split.spec.ts',
      'e2e/board-overview.spec.ts',
    ],
    safety: 'Reads the answers (GET /questions) for the Board with its own refresh rules; verified by board-questions, board-overview-split, and board-overview specs.',
  },
  // The shared card parts (DS2b)
  {
    folder: 'src/features/board/cards/cardParts',
    path: 'gui/src/features/board/cards/cardParts.tsx',
    bareNames: ['cardParts', 'cardParts.tsx'],
    specs: CARD_PARTS_SPECS,
    safety: 'Anchors, the press of a compact card, the cut text, Read all, the byline and the mark, drawn by every card kind; verified by cardParts.test.tsx, the golden markup, and all of e2e/board plus accessibility.spec.ts.',
  },
  {
    folder: 'src/design/CardFrame',
    path: 'gui/src/design/CardFrame.tsx',
    bareNames: ['CardFrame', 'CardFrame.tsx'],
    specs: CARD_PARTS_SPECS,
    safety: 'The card article and its archived, pinned, fresh, reading and pressable states, drawn by every Board card that has one; only BoardNodes.tsx imports it, so it is not APP_WIDE (design/index.ts, which exports it, is); verified by cardParts.test.tsx, the golden markup, and all of e2e/board plus accessibility.spec.ts.',
  },
];

/**
 * board-a11y.spec.ts scans the whole Board and accessibility.spec.ts scans the whole
 * page (Board included), so every leaf under these folders can break them.
 */
export const WHOLE_PAGE_A11Y_SPECS = ['e2e/board-a11y.spec.ts', 'e2e/accessibility.spec.ts'];

export const WHOLE_PAGE_A11Y_FOLDERS = [
  'gui/src/features/board/',
  'gui/src/features/knowledge/',
  'gui/src/features/progress/',
];

export const FOLDER_SPECS = FOLDER_ROWS.map((entry) =>
  WHOLE_PAGE_A11Y_FOLDERS.some((folder) => (entry.path || '').startsWith(folder))
    ? { ...entry, specs: Array.from(new Set([...entry.specs, ...WHOLE_PAGE_A11Y_SPECS])) }
    : entry,
);

/**
 * Files outside gui/src/features/board/ that still decide how every Board file renders
 * (isKnowledgeFile picks the reader view for every workspace file). They run all of
 * e2e/board and still keep their leaf row for the non-Board specs.
 */
export const CENTRAL_BOARD_OUTSIDE_FILES = new Set(['gui/src/features/knowledge/knowledgeIndex']);

function isCentralOutsideBoard(file) {
  const base = (file.includes('/') ? toRepoRelPath(file) : file).replace(/(?:\.(?:test|spec))?\.[^.]+$/, '');
  return CENTRAL_BOARD_OUTSIDE_FILES.has(base) || (!file.includes('/') && base === 'knowledgeIndex');
}

export function getAffectedSpecs(changedFiles) {
  if (!changedFiles || changedFiles.length === 0) {
    return ['e2e/board'];
  }

  const resultSpecs = new Set();
  let needsAllBoard = false;
  let sawNoBrowserFile = false;

  for (const rawFile of changedFiles) {
    const file = normalizeInputPath(rawFile);
    if (!file) continue;
    const repoRelPath = toRepoRelPath(file);

    if (isNoBrowserFile(file)) {
      sawNoBrowserFile = true;
      continue;
    }

    // Direct spec file change: if it exists under gui/, run it; if deleted, ignore it
    const specMatch = repoRelPath.match(/^gui\/(e2e\/[a-zA-Z0-9._-]+\.spec\.ts)$/);
    if (specMatch) {
      const specPath = specMatch[1];
      if (fs.existsSync(path.join(GUI_ROOT, specPath))) {
        resultSpecs.add(specPath);
      }
      continue;
    }

    // App-wide files affect every e2e spec across the app
    if (isAppWideFile(file)) {
      return ['e2e'];
    }

    // Central or shared board files affect multiple areas and must run all of e2e/board
    if (isCentralBoardFile(file)) {
      needsAllBoard = true;
      continue;
    }

    if (isCentralOutsideBoard(file)) needsAllBoard = true;

    const isBare = !file.includes('/');
    let matched = false;

    if (isBare) {
      // Only bare filenames without '/' should match by baseName
      const fileBase = file.replace(/(?:\.(?:test|spec))?\.[^.]+$/, '');
      for (const entry of FOLDER_SPECS) {
        const entryBase = path.basename(entry.path || entry.folder).replace(/(?:\.(?:test|spec))?\.[^.]+$/, '');
        const matchesBare =
          (entry.bareNames && (entry.bareNames.includes(file) || entry.bareNames.includes(fileBase))) ||
          entryBase === fileBase ||
          path.basename(entry.path || entry.folder) === file;

        if (matchesBare) {
          matched = true;
          for (const spec of entry.specs) {
            resultSpecs.add(spec);
          }
        }
      }
    } else {
      // For paths with directories, match on full repository-relative paths, never on base name or endsWith
      for (const entry of FOLDER_SPECS) {
        const entryPath = entry.path || entry.folder;
        const normalizedEntryPath = entryPath.startsWith('gui/') ? entryPath : `gui/${entryPath}`;

        // Exact file mapping: match full repository-relative file path or its test file variant
        const cleanEntry = normalizedEntryPath.replace(/(?:\.(?:test|spec))?\.[^.]+$/, '');
        const cleanFile = repoRelPath.replace(/(?:\.(?:test|spec))?\.[^.]+$/, '');
        if (repoRelPath === normalizedEntryPath || cleanFile === cleanEntry) {
          matched = true;
          for (const spec of entry.specs) {
            resultSpecs.add(spec);
          }
        }
      }
    }

    if (!matched) {
      // Unmapped files inside src/features/board/ run all of e2e/board; anywhere else runs all of e2e
      if (repoRelPath.startsWith('gui/src/features/board/')) {
        needsAllBoard = true;
      } else {
        return ['e2e'];
      }
    }
  }

  if (needsAllBoard) {
    const nonBoardSpecs = Array.from(resultSpecs).filter((spec) => !spec.startsWith('e2e/board'));
    return ['e2e/board', ...nonBoardSpecs];
  }

  if (resultSpecs.size === 0) {
    // Only files no browser can see changed: nothing to run (unit tests cover them).
    if (sawNoBrowserFile) return [];
    return ['e2e/board'];
  }

  return Array.from(resultSpecs);
}

export function isGitRef(ref) {
  if (!ref || typeof ref !== 'string') return false;
  // Reject leading dash to prevent git option injection
  if (ref.startsWith('-')) return false;
  try {
    const out = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--revs-only', '--end-of-options', ref], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

const PLAYWRIGHT_VALUE_FLAGS = new Set([
  '-c', '--config',
  '-g', '--grep',
  '-gv', '--grep-invert',
  '-j', '--workers',
  '-p', '--project',
  '--reporter',
  '--repeat-each',
  '--retries',
  '--timeout',
  '--output',
  '--shard',
  '--trace',
  '--tsconfig',
  '--max-failures',
  '--ignore-snapshots',
]);

export function parseCliArgs(argv) {
  const targetInputs = [];
  const playwrightArgs = [];
  let runPlaywright = false;
  let dryRun = false;
  let baseRef = null;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--') {
      const rest = argv.slice(i + 1);
      playwrightArgs.push(...rest);
      break;
    }

    if (arg === '--run') {
      runPlaywright = true;
      i++;
      continue;
    }

    if (arg === '--dry-run') {
      dryRun = true;
      i++;
      continue;
    }

    if (arg === '--base') {
      i++;
      if (i < argv.length) baseRef = argv[i];
      i++;
      continue;
    }

    if (arg.startsWith('--base=')) {
      baseRef = arg.slice('--base='.length);
      i++;
      continue;
    }

    if (PLAYWRIGHT_VALUE_FLAGS.has(arg)) {
      playwrightArgs.push(arg);
      i++;
      if (i < argv.length) {
        playwrightArgs.push(argv[i]);
        i++;
      }
      continue;
    }

    if (arg.startsWith('-')) {
      playwrightArgs.push(arg);
      i++;
      continue;
    }

    targetInputs.push(arg);
    i++;
  }

  return { runPlaywright, dryRun, baseRef, targetInputs, playwrightArgs };
}

function gitChangedSince(ref) {
  const diffOut = execFileSync('git', ['-C', REPO_ROOT, '-c', 'core.quotePath=false', 'diff', '--name-only', '--end-of-options', ref], { encoding: 'utf8' });
  const includesWorkingTree = !ref.includes('..');
  const untrackedOut = includesWorkingTree
    ? execFileSync('git', ['-C', REPO_ROOT, '-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' })
    : '';
  const files = new Set(
    [...diffOut.split('\n'), ...untrackedOut.split('\n')].map((s) => s.trim()).filter(Boolean),
  );
  return Array.from(files);
}

export function resolveChangedFiles(targetInputs, baseRef) {
  if (baseRef) {
    // Prevent git option injection: reject leading dashes and require valid git ref
    if (typeof baseRef !== 'string' || baseRef.startsWith('-') || !isGitRef(baseRef)) {
      return [];
    }
    try {
      return gitChangedSince(baseRef);
    } catch {
      return [];
    }
  }

  if (targetInputs.length > 0) {
    const first = targetInputs[0];
    const normalizedFirst = typeof first === 'string' ? normalizeInputPath(first) : '';
    const existsAsFile = Boolean(
      normalizedFirst &&
        (fs.existsSync(path.join(REPO_ROOT, normalizedFirst)) ||
          fs.existsSync(path.join(GUI_ROOT, normalizedFirst))),
    );
    if (targetInputs.length === 1 && typeof first === 'string' && !first.startsWith('-') && !existsAsFile && isGitRef(first)) {
      try {
        return gitChangedSince(first);
      } catch {
        return [];
      }
    }
    // Direct file paths passed as arguments
    return targetInputs;
  }

  // Default: read tracked changes against HEAD plus untracked non-ignored files
  try {
    return gitChangedSince('HEAD');
  } catch {
    return [];
  }
}

// CLI execution
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const { runPlaywright, dryRun, baseRef, targetInputs, playwrightArgs } = parseCliArgs(argv);

  const changedFiles = resolveChangedFiles(targetInputs, baseRef);
  const specs = getAffectedSpecs(changedFiles);

  if (specs.length === 0) {
    // Playwright with no spec arguments would run everything, so never call it with none.
    console.log('');
    if (runPlaywright && !dryRun) console.error('No browser spec is affected by this change (unit tests only).');
    process.exit(0);
  }

  if (runPlaywright && !dryRun) {
    const cmd = ['playwright', 'test', ...specs, ...playwrightArgs];
    const proc = spawnSync('npx', cmd, { cwd: GUI_ROOT, stdio: 'inherit', env: process.env });
    if (proc.error) {
      process.exit(1);
    }
    process.exit(proc.status ?? 1);
  } else {
    console.log(specs.join(' '));
  }
}
