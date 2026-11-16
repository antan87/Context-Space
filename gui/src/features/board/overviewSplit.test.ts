import { describe, expect, it } from 'vitest';

import { buildBoardAreas } from './boardAreas.js';
import type { PlanFileView } from '../plan/planFile.js';
import type { WhatsNewView } from '../plan/whatsNew.js';
import type { QuestionAnswerDto } from './questionsArea.js';
import { partitionOverviewTiers } from './boardAreas.js';
import { readerDock } from './boardDock.js';
import { areaRowSecondaryRoom, compactFocusCard, COMPACT_STAGE, MINI_BAR_MIN, MINI_SUBTITLE_MIN, isCompactStage, miniSecondLine, overviewPlan, type AreaData, type BoardArea } from './boardAreas.js';

/** FT1: what the overview shows of a realistic workspace on the stages the board is used on (the same sizes as the e2e). */
const stages = { split1100: { width: 482, height: 656 }, split1280: { width: 572, height: 756 }, board1440: { width: 1320, height: 800 }, board1280: { width: 1160, height: 720 } };

const base: AreaData = {
  kind: 'checkpoint', title: 'x', done: false, current: false, nowSet: false, stepsDone: 1, stepsTotal: 3, waitingCount: 0, noteCount: 0, fileCount: 0,
  pictureCount: 0, documentCount: 0, commitCount: 0, archivedCount: 0, pictures: [], fresh: false,
};
const area = (id: string, data: Partial<AreaData>): BoardArea => ({
  id, kind: 'checkpoint', data: { ...base, title: `Title of ${id}`, ...data }, documents: [], repos: [], cards: [], archivedCount: 0, allMemberNodeIds: [id],
});

/** A focus Area with pictures and three open steps, one that waits, an answer with news, and a dozen plain Areas that have a next step. */
const workspace = (plain = 14): BoardArea[] => [
  area('focus', {
    title: 'A Board tab shows the real work, whatever its size', current: true, preview: 'Two notes', noteCount: 2, pictureCount: 3, stepsDone: 52, stepsTotal: 76,
    pictures: [1, 2, 3].map((n) => ({ path: `p${n}.png`, alt: `P${n}` })),
    openSteps: [1, 2, 3].map((n) => ({ key: `s${n}`, text: `Open step number ${n} of the focus Area`, done: false })),
  }),
  area('plan', { kind: 'plan', title: 'Plan', waitingCount: 1, waitingQuestion: 'Should Review get a keyboard shortcut?', stepsDone: 5, stepsTotal: 12 }),
  area('answer', { kind: 'questions', title: 'How does the Board learn about commits and files?', newsSummary: '1 answer', newestChangeTime: 5, stepsDone: 0, stepsTotal: 0 }),
  ...Array.from({ length: plain }, (_, i) => area(`plain-${i}`, { nextOpenStep: `Order, from the first to the last number ${i}`, stepsDone: 0, stepsTotal: 4 })),
];

const minis = (areas: BoardArea[], size: { width: number; height: number }) => {
  const plan = overviewPlan(areas, size);
  return { plan, cards: plan.nodes.filter((node) => node.type === 'areaMini'), hero: plan.nodes.find((node) => node.type === 'area') };
};

describe('FT1: the overview shows more Areas in Split', () => {
  it('shows at least 4 Areas at 1100x700 Split, and at least 6 at 1280x800 Split', () => {
    expect(minis(workspace(), stages.split1100).cards.length).toBeGreaterThanOrEqual(4);
    expect(minis(workspace(), stages.split1280).cards.length).toBeGreaterThanOrEqual(6);
  });

  it('keeps the Area that waits and the answer among those shown, ahead of the plain ones', () => {
    for (const stage of [stages.split1100, stages.split1280, { width: 678, height: 574 }, { width: 886, height: 574 }]) {
      const ids = minis(workspace(), stage).cards.map((node) => node.id);
      expect(ids.slice(0, 2)).toEqual(['plan', 'answer']);
    }
  });

  it('never folds a waiting or answer Area while plainer Areas show, on any stage and any number of Areas', () => {
    for (const stage of Object.values(stages)) {
      for (const plain of [0, 1, 3, 8, 14, 30]) {
        const ids = new Set(minis(workspace(plain), stage).cards.map((node) => node.id));
        if ([...ids].some((id) => id.startsWith('plain-'))) {
          expect(ids.has('plan')).toBe(true);
          expect(ids.has('answer')).toBe(true);
        }
      }
    }
  });

  it('puts the Plan card in the rows with the others: no card stands alone on a line with an empty half beside it', () => {
    for (const stage of [stages.split1100, stages.split1280, stages.board1440, stages.board1280]) {
      const { cards } = minis(workspace(), stage);
      const lines = new Map<number, number>();
      for (const node of cards) lines.set(node.position.y, (lines.get(node.position.y) ?? 0) + 1);
      const columns = new Set(cards.map((node) => node.position.x)).size;
      const counts = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
      for (const n of counts.slice(0, -1)) expect(n).toBe(columns);
    }
    // At 1440x900 Board the first line holds the Plan card and others, not the Plan card alone
    const first = minis(workspace(), stages.board1440).cards.filter((node) => node.position.y === minis(workspace(), stages.board1440).cards[0]!.position.y);
    expect(first.length).toBeGreaterThan(1);
  });

  it('draws a compact focus card in Split and on a short stage, and the whole one on a wide, tall stage', () => {
    for (const stage of [stages.split1100, stages.split1280]) {
      const hero = minis(workspace(), stage).hero!;
      expect(hero.data.heroShowPictures).toBe(false);
      expect(hero.data.heroShowPreview).toBe(false);
      expect(hero.data.heroOpenStepLimit).toBe(1);
      expect(hero.height).toBeLessThan(230);
    }
    for (const stage of [stages.board1440, stages.board1280]) {
      const hero = minis(workspace(), stage).hero!;
      expect(hero.data.heroShowPictures).toBe(true);
      expect(hero.data.heroOpenStepLimit).toBe(3);
    }
    // A short wide stage is compact too
    expect(minis(workspace(), { width: 1320, height: 520 }).hero!.data.heroShowPictures).toBe(false);
  });

  it('does not change the focus card when a reader docks beside the 1280x800 Board: the stage without the reader decides', () => {
    // 1280x800 Board: a row of 1160 px; the reader takes its share and the stage that is left is narrow
    const full = { width: 1160, height: 720 };
    const docked = { width: full.width - readerDock(full.width).width, height: full.height };
    expect(docked.width).toBeLessThan(COMPACT_STAGE.width);
    expect(compactFocusCard(full)).toBe(false);
    // With the reader docked, the card is decided by the width the stage has with none
    expect(compactFocusCard(docked, full.width)).toBe(false);
    expect(compactFocusCard(docked, full.width)).toBe(compactFocusCard(full));
    // And the plan keeps its thumbnails when told so
    const hero = overviewPlan(workspace(), docked, { compact: compactFocusCard(docked, full.width) }).nodes.find((node) => node.type === 'area')!;
    expect((hero.data as AreaData).heroShowPictures).toBe(true);
    // A stage that is narrow with no reader is still compact (Split)
    expect(compactFocusCard(stages.split1100)).toBe(true);
  });

  it('switches to the compact focus card by the width and height of the room', () => {
    const room = (width: number, height: number) => ({ width, height });
    expect(isCompactStage(room(COMPACT_STAGE.width - 1, 900))).toBe(true);
    expect(isCompactStage(room(COMPACT_STAGE.width, COMPACT_STAGE.height))).toBe(false);
    expect(isCompactStage(room(1280, COMPACT_STAGE.height - 1))).toBe(true);
  });

  it('keeps every card whole inside the stage', () => {
    for (const stage of Object.values(stages)) {
      const plan = overviewPlan(workspace(), stage);
      for (const node of plan.nodes) {
        expect(node.position.y + node.height! + plan.viewport!.y).toBeLessThanOrEqual(stage.height - 32 + 0.01);
      }
    }
  });
});

describe('FT1: the second line of a small card', () => {
  const steps = 44; // "44 of 47"

  it('draws a subtitle with at least about 12 characters before its ellipsis, or none', () => {
    const subtitle = 'Order, from the first to the last number';
    // Plenty of room: drawn
    expect(miniSecondLine({ room: 400, stepsPx: steps, subtitle, hasSteps: true }).subtitle).toBe(true);
    for (let room = 0; room <= 400; room += 5) {
      const line = miniSecondLine({ room, stepsPx: steps, subtitle, hasSteps: true });
      if (line.subtitle) expect(line.subtitleMax).toBeGreaterThanOrEqual(MINI_SUBTITLE_MIN);
    }
    // The room "Order, fro…" had: the subtitle is not drawn
    expect(miniSecondLine({ room: 130, stepsPx: steps, subtitle, hasSteps: true }).subtitle).toBe(false);
    // A subtitle shorter than the least is drawn whole where it fits
    expect(miniSecondLine({ room: 110, stepsPx: steps, subtitle: 'Do it', hasSteps: true }).subtitle).toBe(true);
  });

  it('draws the progress bar only where it is at least 32 px wide', () => {
    for (let room = 0; room <= 400; room += 3) {
      for (const subtitle of [undefined, 'Order, from the first to the last number']) {
        const line = miniSecondLine({ room, stepsPx: steps, subtitle, hasSteps: true });
        if (line.bar) {
          const left = room - steps - 8 - (line.subtitle ? line.subtitleMax + 8 : 0);
          expect(left).toBeGreaterThanOrEqual(MINI_BAR_MIN);
        }
      }
    }
    expect(miniSecondLine({ room: 90, stepsPx: steps, hasSteps: true }).bar).toBe(true);
    expect(miniSecondLine({ room: 60, stepsPx: steps, hasSteps: true }).bar).toBe(false);
    expect(miniSecondLine({ room: 300, stepsPx: steps, hasSteps: false }).bar).toBe(false);
  });
});

describe('FT1 fix 1: answer news and the waiting group', () => {
  const checkpoint = (n: number) => ({ key: `c${n}`, title: `Checkpoint ${n} of the plan`, done: false, line: 1, decisions: [], steps: [{ key: `c${n}-s`, text: `Build ${n}`, done: false, line: 2, kind: 'step', indent: 0, current: n === 0 }] });
  const plan = (count: number) => ({ title: 'Plan', sections: [], decisions: [], steps: [], waiting: [], line: 0, checkpoints: Array.from({ length: count }, (_, i) => checkpoint(i)) } as unknown as PlanFileView);
  const answer = (area: string): QuestionAnswerDto => ({
    path: 'explain/late.md', question: 'What about the late one?', summary: 'Short.', area, modifiedAt: '2026-11-14T10:00:00.000Z',
    parts: [{ title: 'In short', heading: null, cards: [{ kind: 'text', text: 'Short.' }] }],
  });

  /** The news as the Board has it on the client: the Answers group of the What's new view, by the answer's path. */
  const withNews = (change: 'added' | 'changed' | 'out-of-date') => ({
    reader: 'user', at: new Date().toISOString(), from: new Date().toISOString(), basis: 'last-look', empty: false, problems: [], commits: [], incoming: [],
    plan: { items: [], more: 0 }, documents: { items: [], more: 0 }, knowledge: { items: [], more: 0 },
    answers: { items: [{ path: 'explain/late.md', question: 'What about the late one?', change, copies: 1, at: new Date().toISOString() }], more: 0 },
  } as unknown as WhatsNewView);
  const shown = (news?: WhatsNewView) => {
    const areas = buildBoardAreas({ plan: plan(20), questions: [answer('checkpoint:c18')], ...(news ? { news } : {}) });
    return { areas, ids: overviewPlan(areas, stages.split1100).nodes.map((node) => node.id) };
  };

  it('keeps an answer with news, and its late Area, among those shown at 1100x700 Split, through the news the app has', () => {
    for (const change of ['added', 'changed', 'out-of-date'] as const) {
      const { areas, ids } = shown(withNews(change));
      expect(areas.find((a) => a.id.startsWith('question:'))!.data.about?.id).toBe('checkpoint:c18');
      expect(ids).toContain('checkpoint:c18');
      expect(ids).toContain('question:explain/late.md');
      expect(ids.indexOf('checkpoint:c18')).toBeLessThan(ids.indexOf('checkpoint:c1'));
    }
    // The card says what moved
    const card = overviewPlan(shown(withNews('changed')).areas, stages.split1100).nodes.find((n) => n.id === 'checkpoint:c18')!;
    expect((card.data as AreaData).newsSummary).toBe('Answer updated');
  });

  it('does not promote the same answer when there is no news about it', () => {
    expect(shown().ids).not.toContain('checkpoint:c18');
    expect(shown().ids).not.toContain('question:explain/late.md');
  });

  it('ignores answer news once it is marked seen (Got it keeps the items, sets empty), and both Areas stay on the board', () => {
    const seen = { ...withNews('changed'), empty: true } as WhatsNewView;
    expect(seen.answers!.items.length).toBe(1);
    const { areas, ids } = shown(seen);
    expect(ids).not.toContain('checkpoint:c18');
    expect(areas.map((a) => a.id)).toEqual(expect.arrayContaining(['checkpoint:c18', 'question:explain/late.md']));
    expect(areas.find((a) => a.id.startsWith('question:'))!.data.newsSummary).toBeUndefined();
  });

  it('gives a host with two answers the newest of their times, whatever the order they come in', () => {
    const answerOf = (id: string, at: number) => area(id, { kind: 'questions', stepsTotal: 0, newsSummary: 'Answer updated', newestChangeTime: at, about: { id: 'host', title: 'Host' } });
    const areas = [
      area('focus', { current: true }), area('host', {}), answerOf('new', 2000), answerOf('old', 1000),
      area('other', { newsSummary: '1 commit', newestChangeTime: 1500 }),
    ];
    expect(partitionOverviewTiers(areas).tier3.map((a) => a.id)).toEqual(['host', 'new', 'old', 'other']);
    expect(partitionOverviewTiers([...areas.slice(0, 2), areas[3]!, areas[2]!, areas[4]!]).tier3.map((a) => a.id)).toEqual(['host', 'old', 'new', 'other']);
  });

  it('does not let plainer Areas take the slots of a waiting group that overflows (rows)', () => {
    const waiting = (id: string, extra: Partial<AreaData> = {}) => area(id, { waitingCount: 1, waitingQuestion: `Question of ${id}?`, ...extra });
    const areas = [
      area('focus', { current: true, openSteps: [{ key: 's', text: 'Step', done: false }] }),
      waiting('wait-a'), waiting('wait-b'),
      area('answer-b', { kind: 'questions', title: 'Answer about B', about: { id: 'wait-b', title: 'B' }, stepsTotal: 0 }),
      ...Array.from({ length: 6 }, (_, i) => area(`plain-${i}`, { nextOpenStep: 'Next' })),
    ];
    let checked = 0;
    for (let height = 200; height <= 460; height += 4) {
      const nodes = overviewPlan(areas, { width: 400, height }).nodes;
      const ids = nodes.map((node) => node.id);
      if (nodes.some((node) => node.type === 'areaRow') && !ids.includes('wait-b')) {
        checked += 1;
        expect(ids.some((id) => id.startsWith('plain-')), `plain Areas shown at ${height} while waiting B is folded`).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('P1: overview row secondary room', () => {
  it('hides secondary text when a narrow row has no room after the title and counts, and keeps it when the title is short or the row is wide', () => {
    const longTitle: AreaData = {
      ...base,
      tier: 4,
      title: 'You can inspect any change: what changed, the code, the pictures and the reviews',
      nextOpenStep: 'The AI writes what was done, in plain words, when it commits',
      stepsDone: 0,
      stepsTotal: 5,
    };
    const shortTitle: AreaData = {
      ...longTitle,
      title: 'Plan',
    };
    const withQuestion: AreaData = {
      ...longTitle,
      title: 'The Board is powerful enough to be where the work happens',
      questionItem: { kind: 'question', count: 1, label: '1 question', actionLabel: 'Show 1 question' },
      stepsDone: 46,
      stepsTotal: 51,
    };

    expect(areaRowSecondaryRoom(longTitle, 340).showSecondary).toBe(false);
    expect(areaRowSecondaryRoom(shortTitle, 340).showSecondary).toBe(true);
    expect(areaRowSecondaryRoom(shortTitle, 340).room).toBeGreaterThanOrEqual(MINI_SUBTITLE_MIN);
    expect(areaRowSecondaryRoom(withQuestion, 340).showSecondary).toBe(false);
    expect(areaRowSecondaryRoom(shortTitle, 552).showSecondary).toBe(true);
  });

  it('handles Tier 2 waiting questions, Tier 3 news, and listArea file counts', () => {
    const tier2Medium: AreaData = {
      ...base,
      tier: 2,
      title: 'The plan is the first thing to read',
      waitingCount: 1,
      waitingQuestion: 'Which layout style is preferred?',
      stepsDone: 0,
      stepsTotal: 1,
    };
    const tier3Short: AreaData = {
      ...base,
      tier: 3,
      title: 'Plan',
      newsItems: [{ kind: 'commits', count: 1, label: '1 commit', actionLabel: 'Show the 1 commit' }],
      newsSummary: '1 commit',
      stepsDone: 1,
      stepsTotal: 3,
    };
    const tier3LongWithQuestion: AreaData = {
      ...base,
      tier: 3,
      title: 'The Board is powerful enough to be where the work happens, and it replaces the Plan tab.',
      questionItem: { kind: 'question', count: 1, label: '1 question', actionLabel: 'Open the answer' },
      newsItems: [
        { kind: 'commits', count: 1, label: '1 commit', actionLabel: 'Show the 1 commit' },
        { kind: 'question', count: 1, label: '1 question', actionLabel: 'Open the answer' },
      ],
      newsSummary: '1 commit',
      stepsDone: 1,
      stepsTotal: 3,
    };
    const tier3QuestionAndUpdates: AreaData = {
      ...base,
      tier: 3,
      title: 'Plan',
      questionItem: { kind: 'question', count: 1, label: '1 question', actionLabel: 'Open the answer' },
      newsItems: [
        { kind: 'question', count: 1, label: '1 question', actionLabel: 'Open the answer' },
        { kind: 'updates', count: 2, label: '2 updates', actionLabel: 'Show the 2 updates' },
      ],
      newsSummary: '2 updates',
      stepsDone: 1,
      stepsTotal: 3,
    };
    const questionsLong: AreaData = {
      ...base,
      kind: 'questions',
      tier: 4,
      title: 'How does the Board learn about commits others pushed, without ever asking for a password?',
      stepsDone: 0,
      stepsTotal: 0,
    };

    expect(areaRowSecondaryRoom(tier2Medium, 340).showSecondary).toBe(false);
    expect(areaRowSecondaryRoom(tier2Medium, 552).showSecondary).toBe(true);
    expect(areaRowSecondaryRoom(tier3Short, 340).showSecondary).toBe(true);
    expect(areaRowSecondaryRoom(tier3LongWithQuestion, 340)).toEqual({ room: 0, showSecondary: false });
    expect(areaRowSecondaryRoom(tier3LongWithQuestion, 552).showSecondary).toBe(false);
    expect(areaRowSecondaryRoom(tier3QuestionAndUpdates, 340).showSecondary).toBe(true);
    expect(areaRowSecondaryRoom(questionsLong, 340, { fileCounts: '5 parts · 5 code blocks · 1 picture' }).showSecondary).toBe(false);
  });
});
