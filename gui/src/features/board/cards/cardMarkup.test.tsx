import { existsSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { baseFixtures, CardProviders, FIXED_NOW } from './cardFixtures.js';

/**
 * Golden markup snapshots for every node kind registered in BoardSection.tsx:
 *
 * OVERVIEW_NODE_TYPES: area, areaRow, areaMini, areaFold, checkpoint
 * AREA_NODE_TYPES: lane, checkpoint, document, commit, placeholder, uncommitted,
 *   note, file, answer, step, fold, more, pager
 *
 * Move slices must leave these snapshots byte-for-byte unchanged; only an explicit
 * restyle slice may update them. The cards' data lives in `cardFixtures.tsx` (the design page draws the same ones).
 */

const FIXTURES = baseFixtures(FIXED_NOW);

/** Draws one fixture the way the test always has: inside the query client, the React Flow provider, the Board's actions, the reading context and the commit notes. */
function render(key: string): string {
  const fixture = FIXTURES.find((entry) => entry.key === key);
  if (!fixture) throw new Error(`No fixture ${key}`);
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(CardProviders, { now: FIXED_NOW, reading: fixture.reading }, createElement(fixture.Component, fixture.props)),
    ),
  );
}

describe('board node golden markup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    vi.stubGlobal('document', {
      documentElement: {
        classList: {
          contains: () => false,
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('covers all 17 node types registered by OVERVIEW_NODE_TYPES and AREA_NODE_TYPES', () => {
    const overviewKinds = ['area', 'areaRow', 'areaMini', 'areaFold', 'checkpoint'] as const;
    const areaKinds = [
      'lane',
      'checkpoint',
      'document',
      'commit',
      'placeholder',
      'uncommitted',
      'note',
      'file',
      'answer',
      'step',
      'fold',
      'more',
      'pager',
    ] as const;
    const distinct = new Set<string>([...overviewKinds, ...areaKinds]);
    expect(distinct.size).toBe(17);

    // Cross-check against the live OVERVIEW_NODE_TYPES / AREA_NODE_TYPES definitions so new node kinds cannot go unpinned.
    const nodeTypesPath = new URL('../nodeTypes.ts', import.meta.url);
    const sectionPath = new URL('../BoardSection.tsx', import.meta.url);
    const source = readFileSync(existsSync(nodeTypesPath) ? nodeTypesPath : sectionPath, 'utf8');
    const parseKeys = (name: string) => {
      const match = source.match(new RegExp(`const ${name}\\b[^=]*=\\s*\\{([^}]+)\\}`));
      expect(match, name).toBeTruthy();
      return Array.from(match![1]!.matchAll(/\b([a-zA-Z0-9_]+)\s*:/g), (m) => m[1]!);
    };
    const registered = new Set([...parseKeys('OVERVIEW_NODE_TYPES'), ...parseKeys('AREA_NODE_TYPES')]);
    expect(registered).toEqual(distinct);
  });

  it('area: BoardArea overview card', () => {
    const html = render('area.default');
    expect(html).toMatchSnapshot();
  });

  it('areaRow: BoardAreaRow overview row', () => {
    const html = render('areaRow.default');
    expect(html).toMatchSnapshot();
  });

  it('areaMini: BoardAreaMini checkpoint and questions variants', () => {
    const checkpointMini = render('areaMini.checkpointMini');
    const questionsMini = render('areaMini.questionsMini');
    expect({ checkpointMini, questionsMini }).toMatchSnapshot();
  });

  it('areaMini and area extra variants: Tier 3 news overlay, Workspace files mini, and done/plan BoardArea', () => {
    const newsMini = render('areaMini.newsMini');
    const filesMini = render('areaMini.filesMini');
    const doneArea = render('area.doneArea');
    const planArea = render('area.planArea');
    expect({ newsMini, filesMini, doneArea, planArea }).toMatchSnapshot();
  });

  it('areaFold: BoardAreaFold collapsed and expanded', () => {
    const collapsed = render('areaFold.collapsed');
    const expanded = render('areaFold.expanded');
    expect({ collapsed, expanded }).toMatchSnapshot();
  });

  it('checkpoint: BoardCheckpoint open, folded, plan, and waitingOnly', () => {
    const open = render('checkpoint.open');
    const folded = render('checkpoint.folded');
    const waitingFrame = render('checkpoint.waitingFrame');
    const planFrame = render('checkpoint.planFrame');
    expect({ open, folded, waitingFrame, planFrame }).toMatchSnapshot();
  });

  it('lane: BoardLane open and folded', () => {
    const open = render('lane.open');
    const folded = render('lane.folded');
    expect({ open, folded }).toMatchSnapshot();
  });

  it('document: BoardDocument full (reading) and compact (external dimmed)', () => {
    const full = render('document.full');
    const compact = render('document.compact');
    expect({ full, compact }).toMatchSnapshot();
  });

  it('commit: BoardCommit full and compact with pictures and commit note marker', () => {
    const full = render('commit.full');
    const compact = render('commit.compact');
    expect({ full, compact }).toMatchSnapshot();
  });

  it('placeholder: BoardPlaceholder full and compact', () => {
    const full = render('placeholder.full');
    const compact = render('placeholder.compact');
    expect({ full, compact }).toMatchSnapshot();
  });

  it('uncommitted: BoardUncommitted card', () => {
    const html = render('uncommitted.default');
    expect(html).toMatchSnapshot();
  });

  it('note: BoardNote full (pinned fresh), compact, and archived', () => {
    const full = render('note.full');
    const compact = render('note.compact');
    const archived = render('note.archived');
    expect({ full, compact, archived }).toMatchSnapshot();
  });

  it('file: BoardFile full image, full markdown, compact picture, compact doc row, and compact card', () => {
    const fullImage = render('file.fullImage');
    const fullDoc = render('file.fullDoc');
    const compactPicture = render('file.compactPicture');
    const compactDocumentRow = render('file.compactDocumentRow');
    const compactGeneric = render('file.compactGeneric');
    expect({
      fullImage,
      fullDoc,
      compactPicture,
      compactDocumentRow,
      compactGeneric,
    }).toMatchSnapshot();
  });

  it('answer: BoardAnswerCard text, code (matches and changed), picture, and diagram variants', () => {
    const text = render('answer.text');
    const codeMatches = render('answer.codeMatches');
    const codeChanged = render('answer.codeChanged');
    const picture = render('answer.picture');
    const pictureMissing = render('answer.pictureMissing');
    const diagram = render('answer.diagram');
    expect({ text, codeMatches, codeChanged, picture, pictureMissing, diagram }).toMatchSnapshot();
  });

  it('step: BoardRowHead prominent, regular step, static done step, and tabbed row', () => {
    const prominent = render('step.prominent');
    const regular = render('step.regular');
    const staticDone = render('step.staticDone');
    const tabbed = render('step.tabbed');
    expect({ prominent, regular, staticDone, tabbed }).toMatchSnapshot();
  });

  it('fold: BoardFoldRow folded step row', () => {
    const html = render('fold.default');
    expect(html).toMatchSnapshot();
  });

  it('more: BoardMoreTile overflow button', () => {
    const html = render('more.default');
    expect(html).toMatchSnapshot();
  });

  it('pager: BoardPager row pagination controls', () => {
    const html = render('pager.default');
    expect(html).toMatchSnapshot();
  });
});
