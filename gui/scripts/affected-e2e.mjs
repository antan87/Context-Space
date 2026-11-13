#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ============================================================================
 * Leaf Feature to E2E Spec Mappings & Safety Justifications
 * ============================================================================
 * Only clearly separated leaf modules are mapped to narrow specs. Any change to
 * a shared/central board file (BoardSection.tsx, BoardNodes.tsx, boardAreas.ts,
 * boardRows.ts, boardLayout.ts, boardActions.ts, boardData.ts, boardNav.ts, etc.)
 * or any path the table does not name exactly runs all of `e2e/board`.
 *
 * | Leaf Feature / Path                  | Affected Specs                                           | Safety Justification                                                                                 |
 * |--------------------------------------|----------------------------------------------------------|------------------------------------------------------------------------------------------------------|
 * | BoardReader, ReaderPage, boardDock,  | e2e/board-reader.spec.ts, e2e/board-reader-back.spec.ts, | Isolated reader drawer/overlay, breadcrumb trail, and dock sizing math (readerDock); navigation,     |
 * | boardReaderLayout, boardReaderTrail, | e2e/board-reader-nav.spec.ts,                            | reading, and drawer controls are fully verified by reader and browsing specs.                        |
 * | readerPolicy                         | e2e/board-browsing.spec.ts                               |                                                                                                      |
 * |--------------------------------------|----------------------------------------------------------|------------------------------------------------------------------------------------------------------|
 * | boardReveal                          | e2e/board-overview.spec.ts                               | Pure math function (revealViewport) calculating overview viewport shifts when centering cards.       |
 * |--------------------------------------|----------------------------------------------------------|------------------------------------------------------------------------------------------------------|
 * | CodeWindow, CodeWindowSlot           | e2e/board-code-window.spec.ts                             | Self-contained diff viewer modal window over the board; verified by board-code-window.spec.ts.        |
 * | (gui/src/features/changes/CodeWindow)|                                                          |                                                                                                      |
 * |--------------------------------------|----------------------------------------------------------|------------------------------------------------------------------------------------------------------|
 * | BoardNowLine, nowLine                | e2e/board-now-line.spec.ts                               | Isolated overlay marker line displaying current timeline position; does not alter card layout/state. |
 * |--------------------------------------|----------------------------------------------------------|------------------------------------------------------------------------------------------------------|
 * | answerHoldOff                        | e2e/board-decisions.spec.ts                              | Isolated hold-off timer logic for decision prompt interaction.                                       |
 * |--------------------------------------|----------------------------------------------------------|------------------------------------------------------------------------------------------------------|
 * | CommitsView, commitsMode,            | e2e/board-commits.spec.ts,                                | Commits mode of the Code window: header, file list, diff and moving between commits; commitContext |
 * | commitSequence, commitContext        | e2e/board-code-window.spec.ts                             | still feeds it. Isolated from canvas graph layout.                                                   |
 * |--------------------------------------|----------------------------------------------------------|------------------------------------------------------------------------------------------------------|
 * | NoteDialog                           | e2e/board-notes.spec.ts,                                 | Modal dialog for creating and editing note cards; tested by notes and area specs.                    |
 * |                                      | e2e/board-area.spec.ts                                   |                                                                                                      |
 * |--------------------------------------|----------------------------------------------------------|------------------------------------------------------------------------------------------------------|
 * | AssignmentCard, assignmentCardView    | e2e/board-assignment.spec.ts                             | Assignment card and panel above the overview; own drafts and requests; overview specs check its fit. |
 * |--------------------------------------|----------------------------------------------------------|------------------------------------------------------------------------------------------------------|
 * | BoardSidebar                         | e2e/board-index.spec.ts                                  | Collapsible navigation sidebar drawer component beside the board; tested by board-index.spec.ts.     |
 * ============================================================================
 */

/**
 * Shared or central board files. Any change to these files (or anything not
 * explicitly mapped in FOLDER_SPECS) falls back to running all of `e2e/board`.
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
]);

export function isCentralBoardFile(file) {
  if (!file) return false;
  const normalized = file.trim().replace(/\\/g, '/');
  const base = path.basename(normalized);
  const baseNoExt = base.replace(/(?:\.(?:test|spec))?\.[^.]+$/, '');
  return CENTRAL_BOARD_FILES.has(base) || CENTRAL_BOARD_FILES.has(baseNoExt);
}

export const FOLDER_SPECS = [
  // Board Reader (reader overlay, pages, navigation, and reader docking)
  {
    folder: 'src/features/board/BoardReader',
    path: 'gui/src/features/board/BoardReader.tsx',
    bareNames: ['BoardReader', 'BoardReader.tsx'],
    specs: [
      'e2e/board-reader.spec.ts',
      'e2e/board-reader-back.spec.ts',
      'e2e/board-reader-nav.spec.ts',
      'e2e/board-browsing.spec.ts',
    ],
    safety: 'Independent reader drawer and controls; verified by reader navigation and browsing specs.',
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
    ],
    safety: 'Reader page container; verified by reader navigation and browsing specs.',
  },
  {
    folder: 'src/features/board/boardReaderLayout',
    path: 'gui/src/features/board/boardReaderLayout.ts',
    bareNames: ['boardReaderLayout', 'boardReaderLayout.ts'],
    specs: [
      'e2e/board-reader.spec.ts',
      'e2e/board-reader-back.spec.ts',
      'e2e/board-reader-nav.spec.ts',
      'e2e/board-browsing.spec.ts',
    ],
    safety: 'Reader drawer layout math; verified by reader specs.',
  },
  {
    folder: 'src/features/board/boardReaderTrail',
    path: 'gui/src/features/board/boardReaderTrail.ts',
    bareNames: ['boardReaderTrail', 'boardReaderTrail.ts'],
    specs: [
      'e2e/board-reader.spec.ts',
      'e2e/board-reader-back.spec.ts',
      'e2e/board-reader-nav.spec.ts',
      'e2e/board-browsing.spec.ts',
    ],
    safety: 'Reader breadcrumb navigation trail; verified by reader specs.',
  },
  {
    folder: 'src/features/board/readerPolicy',
    path: 'gui/src/features/board/readerPolicy.ts',
    bareNames: ['readerPolicy', 'readerPolicy.ts'],
    specs: [
      'e2e/board-reader.spec.ts',
      'e2e/board-reader-back.spec.ts',
      'e2e/board-reader-nav.spec.ts',
      'e2e/board-browsing.spec.ts',
    ],
    safety: 'Reader open/close policy logic; verified by reader specs.',
  },
  {
    folder: 'src/features/board/boardDock',
    path: 'gui/src/features/board/boardDock.ts',
    bareNames: ['boardDock', 'boardDock.ts'],
    specs: [
      'e2e/board-reader.spec.ts',
      'e2e/board-reader-back.spec.ts',
      'e2e/board-reader-nav.spec.ts',
      'e2e/board-browsing.spec.ts',
    ],
    safety: 'Reader dock sizing helper (readerDock); affects only reader docking, verified by reader specs.',
  },

  // Overview Reveal Viewport
  {
    folder: 'src/features/board/boardReveal',
    path: 'gui/src/features/board/boardReveal.ts',
    bareNames: ['boardReveal', 'boardReveal.ts'],
    specs: ['e2e/board-overview.spec.ts'],
    safety: 'Pure math helper (revealViewport) for overview card positioning; verified by board-overview.spec.ts.',
  },

  // Changes / Code Window
  {
    folder: 'src/features/changes/CodeWindow',
    path: 'gui/src/features/changes/CodeWindow.tsx',
    bareNames: ['CodeWindow', 'CodeWindow.tsx'],
    specs: ['e2e/board-code-window.spec.ts'],
    safety: 'Diff viewer and code inspection window modal; verified by board-code-window.spec.ts.',
  },
  {
    folder: 'src/features/changes/CodeWindowSlot',
    path: 'gui/src/features/changes/CodeWindowSlot.tsx',
    bareNames: ['CodeWindowSlot', 'CodeWindowSlot.tsx'],
    specs: ['e2e/board-code-window.spec.ts'],
    safety: 'Mount slot for CodeWindow modal; verified by board-code-window.spec.ts.',
  },

  // Now line
  {
    folder: 'src/features/board/BoardNowLine',
    path: 'gui/src/features/board/BoardNowLine.tsx',
    bareNames: ['BoardNowLine', 'BoardNowLine.tsx'],
    specs: ['e2e/board-now-line.spec.ts'],
    safety: 'Board current-time indicator line overlay; verified by board-now-line.spec.ts.',
  },
  {
    folder: 'src/features/board/nowLine',
    path: 'gui/src/features/board/nowLine.ts',
    bareNames: ['nowLine', 'nowLine.ts'],
    specs: ['e2e/board-now-line.spec.ts'],
    safety: 'Now line positioning math; verified by board-now-line.spec.ts.',
  },

  // Assignment card (description and specs at the top of the overview)
  {
    folder: 'src/features/board/AssignmentCard',
    path: 'gui/src/features/board/AssignmentCard.tsx',
    bareNames: ['AssignmentCard', 'AssignmentCard.tsx'],
    specs: ['e2e/board-assignment.spec.ts', 'e2e/board-overview.spec.ts'],
    safety: 'Card and panel above the overview stage, with their own drafts and requests; verified by board-assignment.spec.ts, and the overview specs for fit.',
  },
  {
    folder: 'src/features/board/assignmentCardView',
    path: 'gui/src/features/board/assignmentCardView.ts',
    bareNames: ['assignmentCardView', 'assignmentCardView.ts'],
    specs: ['e2e/board-assignment.spec.ts'],
    safety: 'Pure helpers (compact card view, save bodies, spec checks); unit tested and verified by board-assignment.spec.ts.',
  },

  // Decisions / Answer hold-off
  {
    folder: 'src/features/board/answerHoldOff',
    path: 'gui/src/features/board/answerHoldOff.ts',
    bareNames: ['answerHoldOff', 'answerHoldOff.ts'],
    specs: ['e2e/board-decisions.spec.ts'],
    safety: 'Hold-off timer logic for question prompt decisions; verified by board-decisions.spec.ts.',
  },

  // Commits mode of the Code window
  {
    folder: 'src/features/changes/CommitsView',
    path: 'gui/src/features/changes/CommitsView.tsx',
    bareNames: ['CommitsView', 'CommitsView.tsx'],
    specs: ['e2e/board-commits.spec.ts', 'e2e/board-code-window.spec.ts'],
    safety: 'Commits mode of the Code window (header, files, diff, previous/next commit); verified by board-commits.spec.ts.',
  },
  {
    folder: 'src/features/changes/commitsMode',
    path: 'gui/src/features/changes/commitsMode.ts',
    bareNames: ['commitsMode', 'commitsMode.ts'],
    specs: ['e2e/board-commits.spec.ts'],
    safety: 'Pure helpers for row order, commit lists and mode state; unit tested and verified by board-commits.spec.ts.',
  },
  {
    folder: 'src/features/board/commitSequence',
    path: 'gui/src/features/board/commitSequence.ts',
    bareNames: ['commitSequence', 'commitSequence.ts'],
    specs: ['e2e/board-commits.spec.ts'],
    safety: 'Finds the row of a commit card for the Code window; verified by board-commits.spec.ts.',
  },
  {
    folder: 'src/features/board/commitContext',
    path: 'gui/src/features/board/commitContext.ts',
    bareNames: ['commitContext', 'commitContext.ts'],
    specs: ['e2e/board-commits.spec.ts'],
    safety: 'Commit context helper; verified by board-commits.spec.ts.',
  },

  // Notes
  {
    folder: 'src/features/board/NoteDialog',
    path: 'gui/src/features/board/NoteDialog.tsx',
    bareNames: ['NoteDialog', 'NoteDialog.tsx'],
    specs: ['e2e/board-notes.spec.ts', 'e2e/board-area.spec.ts'],
    safety: 'Note creation and edit modal; verified by board-notes.spec.ts and board-area.spec.ts.',
  },

  // Sidebar / Index
  {
    folder: 'src/features/board/BoardSidebar',
    path: 'gui/src/features/board/BoardSidebar.tsx',
    bareNames: ['BoardSidebar', 'BoardSidebar.tsx'],
    specs: ['e2e/board-index.spec.ts'],
    safety: 'Index sidebar navigation drawer; verified by board-index.spec.ts.',
  },
];

export function getAffectedSpecs(changedFiles) {
  if (!changedFiles || changedFiles.length === 0) {
    return ['e2e/board'];
  }

  const resultSpecs = new Set();

  for (const rawFile of changedFiles) {
    const file = rawFile.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!file) continue;

    // Direct spec file change: if it exists, run it; if deleted, ignore it
    const specMatch = file.match(/(?:^|\/)(e2e\/board[a-zA-Z0-9_-]*\.spec\.ts)$/);
    if (specMatch) {
      const specPath = specMatch[1];
      if (fs.existsSync(specPath) || fs.existsSync(path.join('gui', specPath))) {
        resultSpecs.add(specPath);
      }
      continue;
    }

    // Central or shared board files affect multiple areas and must run all of e2e/board
    if (isCentralBoardFile(file)) {
      return ['e2e/board'];
    }

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
      const repoRelPath = file.startsWith('gui/')
        ? file
        : file.startsWith('src/features/')
          ? `gui/${file}`
          : file;

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
      // Anything the table does not name exactly runs all of e2e/board
      return ['e2e/board'];
    }
  }

  if (resultSpecs.size === 0) {
    return ['e2e/board'];
  }

  return Array.from(resultSpecs);
}

export function isGitRef(ref) {
  if (!ref || typeof ref !== 'string') return false;
  // Reject leading dash to prevent git option injection
  if (ref.startsWith('-')) return false;
  try {
    const out = execFileSync('git', ['rev-parse', '--revs-only', '--end-of-options', ref], {
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

export function resolveChangedFiles(targetInputs, baseRef) {
  if (baseRef) {
    // Prevent git option injection: reject leading dashes and require valid git ref
    if (typeof baseRef !== 'string' || baseRef.startsWith('-') || !isGitRef(baseRef)) {
      return [];
    }
    try {
      const output = execFileSync('git', ['diff', '--name-only', '--end-of-options', baseRef], { encoding: 'utf8' });
      return output.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  if (targetInputs.length > 0) {
    const first = targetInputs[0];
    if (typeof first === 'string' && !first.startsWith('-') && isGitRef(first)) {
      try {
        const output = execFileSync('git', ['diff', '--name-only', '--end-of-options', first], { encoding: 'utf8' });
        return output.split('\n').map((s) => s.trim()).filter(Boolean);
      } catch {
        return [];
      }
    }
    // Direct file paths passed as arguments
    return targetInputs;
  }

  // Default: read git diff --name-only HEAD
  try {
    const output = execFileSync('git', ['diff', '--name-only', '--end-of-options', 'HEAD'], { encoding: 'utf8' });
    const files = output.split('\n').map((s) => s.trim()).filter(Boolean);
    return files;
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

  if (runPlaywright && !dryRun) {
    const cmd = ['playwright', 'test', ...specs, ...playwrightArgs];
    const proc = spawnSync('npx', cmd, { stdio: 'inherit', env: process.env });
    if (proc.error) {
      process.exit(1);
    }
    process.exit(proc.status ?? 1);
  } else {
    console.log(specs.join(' '));
  }
}
