import { describe, expect, it } from 'vitest';

import { buildBoardAreas, foldLabel, keepAnswersWithTheirArea, overviewPlan, partitionOverviewTiers } from './boardAreas.js';
import { areaCountItems, fitNewsItems, newsButtonFit, resolveCountTarget } from './boardCountNav.js';
import { buildBoardNav } from './boardNav.js';
import { cleanAnswers, placeQuestionAreas, questionWords, buildQuestionAreas, type QuestionAnswerDto } from './questionsArea.js';
import type { PlanFileView } from '../plan/planFile.js';

const answer = (file: string, question: string, area?: string, modifiedAt = '2026-11-14T10:00:00.000Z'): QuestionAnswerDto => ({
  path: `explain/${file}.md`, question, summary: 'Short.', modifiedAt, ...(area ? { area } : {}),
  parts: [
    { title: 'In short', heading: null, cards: [{ kind: 'text', text: 'Short.' }] },
    { title: 'Part', heading: 'Part', cards: [{ kind: 'code', language: 'ts', copy: 'x', where: 'R/a.ts:1-1', repo: 'R', file: 'a.ts', start: 1, end: 1, check: { status: 'matches' } }] },
  ],
});

const checkpoint = (key: string, title: string, done = false) => ({
  key, title, done, line: 1, decisions: [],
  steps: [{ key: `${key}-s`, text: `Build ${title}`, done, line: 2, kind: 'step', indent: 0, current: !done }],
});
const plan = (...checkpoints: ReturnType<typeof checkpoint>[]) => ({ title: 'Plan', sections: [], decisions: [], steps: [], waiting: [], line: 0, checkpoints } as unknown as PlanFileView);

const ids = (areas: Array<{ id: string }>) => areas.map((area) => area.id);

describe('the area of an answer, as the route gives it', () => {
  it('keeps a checkpoint or plan:own and drops anything else', () => {
    const cleaned = cleanAnswers({ answers: ['checkpoint:the-board', 'plan:own', 'checkpoint:', 'nowhere', 7, undefined, 'checkpoint:användare-kan-logga-in'].map((area, index) => ({ ...answer(`q${index}`, 'Q'), area })) });
    expect(cleaned.map((entry) => entry.area)).toEqual(['checkpoint:the-board', 'plan:own', undefined, undefined, undefined, undefined, 'checkpoint:användare-kan-logga-in']);
  });
});

describe('an Area with a Swedish title', () => {
  it('is named by the id the plan gives it, and an answer about it is placed beside it', () => {
    const areas = buildBoardAreas({ plan: plan(checkpoint('användare-kan-logga-in', 'Användare kan logga in'), checkpoint('b', 'B')), questions: [answer('s', 'Hur loggar man in?', 'checkpoint:användare-kan-logga-in')] });
    expect(ids(areas).slice(0, 2)).toEqual(['checkpoint:användare-kan-logga-in', 'question:explain/s.md']);
    expect(areas[0]!.data.questionItem?.label).toBe('1 question');
  });
});

describe('an answer placed beside its Area', () => {
  const p = plan(checkpoint('one', 'One'), checkpoint('two', 'Two'), checkpoint('three', 'Three'));

  it('stands right after the Area it is about, and the others keep the order E1 gave them, before Workspace files', () => {
    const files = [{ path: 'docs/a.md', modifiedAt: '2026-11-14T10:00:00.000Z', size: 3 }];
    const areas = buildBoardAreas({ plan: p, workspaceFiles: files, questions: [answer('a', 'About two?', 'checkpoint:two'), answer('loose', 'Loose?'), answer('b', 'About one?', 'checkpoint:one')] });
    expect(ids(areas)).toEqual(['checkpoint:one', 'question:explain/b.md', 'checkpoint:two', 'question:explain/a.md', 'checkpoint:three', 'question:explain/loose.md', 'files:workspace']);
  });

  it('falls back to where E1 puts it when its Area does not exist or is not a plan Area', () => {
    const areas = buildBoardAreas({ plan: p, questions: [answer('gone', 'Q?', 'checkpoint:nothing-like-it'), answer('own', 'Q2?', 'plan:own')] });
    expect(ids(areas)).toEqual(['checkpoint:one', 'checkpoint:two', 'checkpoint:three', 'question:explain/gone.md', 'question:explain/own.md']);
    for (const area of areas) {
      expect(area.data.questionItem).toBeUndefined();
      expect(area.data.about).toBeUndefined();
    }
  });

  it('says "1 question" on the Area and "About" on the answer, linked both ways', () => {
    const areas = buildBoardAreas({ plan: p, questions: [answer('a', 'About two?', 'checkpoint:two')] });
    const host = areas.find((area) => area.id === 'checkpoint:two')!;
    const placed = areas.find((area) => area.id === 'question:explain/a.md')!;
    expect(host.data.questionItem).toMatchObject({ kind: 'question', count: 1, label: '1 question', actionLabel: 'Open the answer: About two?' });
    expect(host.data.questionTarget).toBe('question:explain/a.md');
    expect(placed.data.about).toEqual({ id: 'checkpoint:two', title: 'Two' });
    expect(areaCountItems(host.data).map((item) => item.label)).toContain('1 question');
    expect(areas.find((area) => area.id === 'checkpoint:one')!.data.questionItem).toBeUndefined();
  });

  it('counts two answers on one Area, opens the newest, and keeps both after it', () => {
    const areas = buildBoardAreas({ plan: p, questions: [answer('new', 'Newest?', 'checkpoint:one'), answer('old', 'Older?', 'checkpoint:one')] });
    expect(ids(areas).slice(0, 3)).toEqual(['checkpoint:one', 'question:explain/new.md', 'question:explain/old.md']);
    const host = areas[0]!;
    expect(host.data.questionItem).toMatchObject({ count: 2, label: '2 questions', actionLabel: 'Open the newest of the 2 questions: Newest?' });
    expect(host.data.questionTarget).toBe('question:explain/new.md');
    expect(questionWords(1)).toBe('1 question');
    expect(questionWords(3)).toBe('3 questions');
  });

  it('puts "1 question" before the updates in the count line, and among the buttons for what is new', () => {
    const [host] = buildBoardAreas({ plan: p });
    const base = { ...host!, data: { ...host!.data, updateCount: 2, newsItems: [{ kind: 'commits' as const, count: 1, label: '1 commit', actionLabel: 'x' }, { kind: 'updates' as const, count: 2, label: '2 updates', actionLabel: 'y' }] } };
    const { areas } = placeQuestionAreas([base], buildQuestionAreas([answer('a', 'Q?', 'checkpoint:one')]));
    expect(areaCountItems(areas[0]!.data).map((item) => item.kind)).toEqual(['question', 'updates']);
    expect(areas[0]!.data.newsItems!.map((item) => item.kind)).toEqual(['commits', 'question', 'updates']);
  });

  it('does not change the Areas it is given', () => {
    const built = buildBoardAreas({ plan: p });
    const before = JSON.stringify(built);
    placeQuestionAreas(built, buildQuestionAreas([answer('a', 'Q?', 'checkpoint:one')]));
    expect(JSON.stringify(built)).toBe(before);
  });

  it('opens nothing inside the Area itself for "question"', () => {
    const areas = buildBoardAreas({ plan: p, questions: [answer('a', 'Q?', 'checkpoint:one')] });
    expect(resolveCountTarget(areas[0]!, 'question')).toEqual({ rowId: null });
  });
});

describe('where the overview puts an answer', () => {
  const p = plan(checkpoint('one', 'One'), checkpoint('two', 'Two'), checkpoint('three', 'Three', true));

  it('puts it right after its Area in the same tier, and the answers of the focus Area first in tier 4', () => {
    const areas = buildBoardAreas({ plan: p, questions: [answer('f', 'Focus?', 'checkpoint:one'), answer('t', 'Two?', 'checkpoint:two'), answer('d', 'Done?', 'checkpoint:three'), answer('l', 'Loose?')] });
    const tiers = partitionOverviewTiers(areas);
    expect(ids(tiers.tier1)).toEqual(['checkpoint:one']);
    expect(ids(tiers.tier4)).toEqual(['question:explain/f.md', 'checkpoint:two', 'question:explain/t.md', 'question:explain/l.md']);
    expect(ids(tiers.tier5)).toEqual(['checkpoint:three', 'question:explain/d.md']);
  });

  it('does not let an answer be the focus, or stop everything being done', () => {
    const done = plan(checkpoint('a', 'A', true));
    const tiers = partitionOverviewTiers(buildBoardAreas({ plan: done, questions: [answer('q', 'Q?', 'checkpoint:a')] }));
    expect(tiers.tier1).toEqual([]);
    expect(ids(tiers.tier5)).toEqual(['checkpoint:a', 'question:explain/q.md']);
  });

  it('keeps an answer with its Area when a fold cuts the list', () => {
    const areas = buildBoardAreas({ plan: plan(checkpoint('a', 'A'), checkpoint('b', 'B'), checkpoint('c', 'C')), questions: [answer('x', 'X?', 'checkpoint:b'), answer('y', 'Y?', 'checkpoint:b')] });
    const list = partitionOverviewTiers(areas).tier4;
    expect(ids(list)).toEqual(['checkpoint:b', 'question:explain/x.md', 'question:explain/y.md', 'checkpoint:c']);
    // Where the Area has more answers than there is room for, a cut that would show nothing is made where it was asked
    expect(ids(keepAnswersWithTheirArea(list, 1))).toEqual(['checkpoint:b']);
    expect(ids(keepAnswersWithTheirArea(list, 2))).toEqual(['checkpoint:b', 'question:explain/x.md']);
    expect(ids(keepAnswersWithTheirArea(list, 3))).toEqual(['checkpoint:b', 'question:explain/x.md', 'question:explain/y.md']);
    // The Area that stands before the cut goes whole, or not at all
    const withEarlier = [areas.find((area) => area.id === 'checkpoint:a')!, ...list];
    expect(ids(keepAnswersWithTheirArea(withEarlier, 3))).toEqual(['checkpoint:a']);
    expect(ids(keepAnswersWithTheirArea(list, 4))).toHaveLength(4);
    expect(ids(keepAnswersWithTheirArea(list, 0))).toEqual([]);
  });

  it('shows an answer in Split whenever its Area is shown, at the sizes the Board is used at', () => {
    const many = plan(...Array.from({ length: 9 }, (_, i) => checkpoint(`c${i}`, `Checkpoint ${i}`)));
    const areas = buildBoardAreas({ plan: many, questions: Array.from({ length: 6 }, (_, i) => answer(`q${i}`, `Question ${i}?`, `checkpoint:c${(i % 5) + 2}`)) });
    for (const size of [{ width: 1280, height: 700 }, { width: 1100, height: 600 }, { width: 560, height: 700 }, { width: 420, height: 640 }]) {
      for (const expanded of [false, true]) {
        const shown = new Set(overviewPlan(areas, size, { expanded }).nodes.map((node) => node.id));
        for (const entry of areas.filter((area) => area.data.about)) {
          const hostShown = shown.has(entry.data.about!.id);
          if (hostShown) expect(shown.has(entry.id), `${size.width}x${size.height} expanded ${expanded}: ${entry.id}`).toBe(true);
        }
      }
    }
  });
});

describe('the index lists an answer under its Area as well as under Questions', () => {
  const areas = buildBoardAreas({ plan: plan(checkpoint('one', 'One'), checkpoint('two', 'Two')), questions: [answer('a', 'How does one work?', 'checkpoint:one'), answer('b', 'And again?', 'checkpoint:one')] });

  it('has it in the Area mode under its Area and in its own section', () => {
    const sections = buildBoardNav(areas, { mode: 'area' });
    const one = sections.find((section) => section.areaId === 'checkpoint:one')!;
    expect(one.items.map((item) => [item.areaId, item.title])).toEqual([['question:explain/a.md', 'How does one work?'], ['question:explain/b.md', 'And again?']]);
    expect(one.items[0]).toMatchObject({ nodeId: null, subtitle: '1 part · 1 code block' });
    expect(sections.filter((section) => section.group === 'Questions').map((section) => section.areaId)).toEqual(['question:explain/a.md', 'question:explain/b.md']);
  });

  it('keeps them under Questions in the category mode, without listing them twice', () => {
    const sections = buildBoardNav(areas, { mode: 'category' });
    expect(sections.find((section) => section.title === 'Questions')!.items).toHaveLength(2);
    expect(sections.find((section) => section.title === 'Areas')!.items.map((item) => item.areaId)).toEqual(['checkpoint:one', 'checkpoint:two']);
  });
});

describe('the fold says how many Areas are behind it, not how many answers', () => {
  const hosts = Array.from({ length: 10 }, (_, i) => checkpoint(`c${i}`, `Checkpoint ${i}`, i >= 7));
  const questions = hosts.flatMap((host, i) => [answer(`a${i}`, `About ${i}?`, `checkpoint:${host.key}`), answer(`b${i}`, `Again ${i}?`, `checkpoint:${host.key}`)]);
  const base = buildBoardAreas({ plan: plan(...hosts), questions });
  // Some Areas hold a question for the person, so that the "wait for you" label is in play as well
  const areas = base.map((area) => (['checkpoint:c2', 'checkpoint:c3', 'checkpoint:c4'].includes(area.id) ? { ...area, data: { ...area.data, waitingCount: 1 } } : area));
  const sizes = [{ width: 1280, height: 520 }, { width: 1100, height: 600 }, { width: 560, height: 560 }, { width: 420, height: 520 }, { width: 1440, height: 300 }];

  it('counts Areas only, in the number and in each part of its label', () => {
    let folds = 0;
    for (const size of sizes) {
      const plan = overviewPlan(areas, size, { expanded: false });
      const shown = new Set(plan.nodes.map((node) => node.id));
      const hiddenAreas = areas.filter((area) => !area.data.about && !shown.has(area.id));
      const fold = plan.nodes.find((node) => node.type === 'areaFold');
      if (!fold) { expect(hiddenAreas, `${size.width}x${size.height}`).toEqual([]); continue; }
      folds += 1;
      const data = fold.data as { count: number; waitingCount?: number; moreCount?: number; doneCount?: number };
      const hiddenWaiting = hiddenAreas.filter((area) => area.data.waitingCount > 0).length;
      const hiddenDone = hiddenAreas.filter((area) => area.data.done && area.data.waitingCount === 0).length;
      expect(data.count, `count ${size.width}x${size.height}`).toBe(hiddenAreas.length);
      expect(data.waitingCount ?? 0, `waiting ${size.width}x${size.height}`).toBe(hiddenWaiting);
      expect(data.doneCount ?? 0, `done ${size.width}x${size.height}`).toBe(hiddenDone);
    }
    expect(folds).toBeGreaterThan(2);
  });

  it('says "3 done" for three done Areas that have six answers, and "2 wait for you" for two waiting ones with answers', () => {
    const plan = overviewPlan(areas, { width: 420, height: 520 }, { expanded: false });
    const fold = plan.nodes.find((node) => node.type === 'areaFold')!;
    const label = foldLabel(fold.data as never);
    expect(label).not.toMatch(/\b(6|9|12|15|18)\b/);
    expect(label).toMatch(/done/);
  });
});

describe('the buttons for what is new on a card', () => {
  const kinds = ['commits', 'pictures', 'notes', 'documents', 'updates'] as const;

  it('all shrink with the line on an Area with no answer, as before: three or more kinds are shortened, not cut off', () => {
    for (const kind of kinds) expect(newsButtonFit({}, kind), kind).toBe('min-w-0');
  });

  it('keep their words only where the card also has "1 question", and the updates give way first', () => {
    const item = { kind: 'question' as const, count: 1, label: '1 question', actionLabel: 'x' };
    expect(newsButtonFit({ questionItem: item }, 'updates')).toBe('min-w-0');
    for (const kind of kinds.filter((k) => k !== 'updates')) expect(newsButtonFit({ questionItem: item }, kind), kind).toBe('min-w-fit shrink-0');
  });
});

describe('the buttons for what is new that fit whole', () => {
  const item = (kind: 'commits' | 'pictures' | 'notes' | 'question' | 'updates', label: string) => ({ kind, count: 1, label, actionLabel: label });
  const measure = (label: string) => label.length * 7 + 8;
  const all = [item('commits', '4 commits'), item('question', '1 question'), item('updates', '4 updates')];
  const total = (items: { label: string }[]) => items.reduce((sum, entry, i) => sum + measure(entry.label) + (i > 0 ? 8 : 0), 0);

  it('leaves a card with no "1 question" exactly as it was, whatever the room', () => {
    const plain = [item('commits', '4 commits'), item('updates', '4 updates')];
    for (const room of [0, 50, 100, 1000]) expect(fitNewsItems(plain, room, measure)).toEqual(plain);
  });

  it('keeps every button when all fit', () => {
    expect(fitNewsItems(all, total(all), measure)).toEqual(all);
  });

  it('drops the updates first, then the others from the end, and never "1 question"; what is left always fits', () => {
    expect(fitNewsItems(all, total(all) - 1, measure).map((entry) => entry.kind)).toEqual(['commits', 'question']);
    const two = [item('commits', '4 commits'), item('question', '1 question')];
    expect(fitNewsItems(all, total(two) - 1, measure).map((entry) => entry.kind)).toEqual(['question']);
    expect(fitNewsItems(all, 0, measure).map((entry) => entry.kind)).toEqual(['question']);
    for (let room = 0; room < 300; room += 7) {
      const kept = fitNewsItems(all, room, measure);
      expect(kept.some((entry) => entry.kind === 'question')).toBe(true);
      if (kept.length > 1) expect(total(kept)).toBeLessThanOrEqual(room);
    }
  });

  it('drops a middle kind before the question when there is no updates button', () => {
    const items = [item('commits', '4 commits'), item('pictures', '2 pictures'), item('question', '1 question')];
    expect(fitNewsItems(items, total(items) - 1, measure).map((entry) => entry.kind)).toEqual(['commits', 'question']);
  });
});
