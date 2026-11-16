import { describe, expect, it } from 'vitest';

import { buildBoardAreas, isStepless, partitionOverviewTiers } from './boardAreas.js';
import { areaCountItems, resolveCountTarget } from './boardCountNav.js';
import { isBoardAreaId, isCardId } from './boardData.js';
import { buildBoardNav } from './boardNav.js';
import { collectAreaReaderTargets } from './boardReaderLayout.js';
import { areaBoardLayout, areaRows, areaStage } from './boardRows.js';
import {
  ANSWER_CARD_HEIGHT,
  buildQuestionAreas,
  cleanAnswers,
  codeHead,
  codeHeadParts,
  codeStatus,
  differingLines,
  isAnswerCardId,
  isQuestionAreaId,
  isQuestionFile,
  readableText,
  type QuestionAnswerDto,
} from './questionsArea.js';
import { groupWorkspaceFiles } from './workspaceFilesArea.js';
import type { PlanFileView } from '../plan/planFile.js';

const answer = (file: string, question: string, overrides: Partial<QuestionAnswerDto> = {}): QuestionAnswerDto => ({
  path: `explain/${file}.md`,
  question,
  summary: 'Every request is **checked** first.',
  modifiedAt: '2026-11-14T10:00:00.000Z',
  parts: [
    { title: 'In short', heading: null, cards: [{ kind: 'text', text: 'Every request is **checked** first.' }] },
    {
      title: 'Sign-in', heading: 'Sign-in',
      cards: [
        { kind: 'text', text: 'It happens in one place.' },
        { kind: 'code', language: 'ts', copy: 'const a = 1;', where: 'NexusFlow/src/http/auth.ts:12-14', repo: 'NexusFlow', repoPath: '/w/NexusFlow', file: 'src/http/auth.ts', start: 12, end: 14, check: { status: 'matches' } },
        { kind: 'code', language: 'ts', copy: 'const b = 2;', where: 'NexusFlow/src/http/b.ts:3-3', repo: 'NexusFlow', repoPath: '/w/NexusFlow', file: 'src/http/b.ts', start: 3, end: 3, check: { status: 'changed', current: 'const b = 3;' } },
      ],
    },
    {
      title: 'What you see', heading: 'What you see',
      cards: [{ kind: 'picture', alt: 'The list', path: '../board-pictures/x.png', src: 'board-pictures/x.png' }, { kind: 'diagram', source: 'graph TD\nA-->B' }],
    },
  ],
  ...overrides,
});

const plan = {
  title: 'Plan', sections: [], decisions: [], steps: [], waiting: [], line: 0,
  checkpoints: [{ key: 'cp', title: 'CP', done: false, line: 1, steps: [{ key: 's1', text: 'Build', done: false, line: 2, kind: 'step', indent: 0, current: true }], decisions: [] }],
} as unknown as PlanFileView;

describe('answers as Areas', () => {
  it('builds one Area for each answer, in the order given, with its own ids that never read as cards or plan Areas', () => {
    const areas = buildQuestionAreas([answer('a', 'How do we enforce security?'), answer('b', 'Second?')]);
    expect(areas.map((area) => area.id)).toEqual(['question:explain/a.md', 'question:explain/b.md']);
    for (const area of areas) {
      expect(area.kind).toBe('questions');
      expect(isQuestionAreaId(area.id)).toBe(true);
      expect(isCardId(area.id)).toBe(false);
      expect(isBoardAreaId(area.id)).toBe(false);
      expect(isStepless(area.data.kind)).toBe(true);
      expect(area.cards).toEqual([]);
      for (const id of area.allMemberNodeIds) {
        expect(isAnswerCardId(id)).toBe(true);
        expect(isCardId(id)).toBe(false);
      }
    }
    expect(areas[0]!.data.title).toBe('How do we enforce security?');
    expect(areas[0]!.data.preview).toBe('Every request is checked first.');
    expect(areas[0]!.data.answerCounts).toEqual({ parts: 2, code: 2, pictures: 1, changed: 1 });
  });

  it('counts "N parts · N code blocks · N picture" and "N changed since", and opens the row of the first card counted', () => {
    const [area] = buildQuestionAreas([answer('a', 'Q?')]);
    expect(areaCountItems(area!.data).map((item) => [item.kind, item.label, Boolean(item.warn)])).toEqual([
      ['parts', '2 parts', false], ['code', '2 code blocks', false], ['pictures', '1 picture', false], ['changed', 'Out of date · 1 copy', true],
    ]);
    expect(resolveCountTarget(area!, 'changed')).toEqual({ rowId: 'row:q:1', cardId: 'qcard:explain/a.md#4' });
    expect(resolveCountTarget(area!, 'pictures')).toEqual({ rowId: 'row:q:2', cardId: 'qcard:explain/a.md#5' });
    expect(resolveCountTarget(area!, 'parts')).toEqual({ rowId: null });
  });

  it('says nothing about changes when none changed', () => {
    const clean = answer('a', 'Q?');
    clean.parts[1]!.cards[2] = { ...(clean.parts[1]!.cards[2] as object), check: { status: 'matches' } } as never;
    const [area] = buildQuestionAreas([clean]);
    expect(areaCountItems(area!.data).map((item) => item.kind)).toEqual(['parts', 'code', 'pictures']);
  });

  it('puts the answers after the plan Areas and before Workspace files, and adds nothing for no answers', () => {
    const files = [{ path: 'docs/a.md', modifiedAt: '2026-11-14T10:00:00.000Z', size: 3 }];
    const withAnswers = buildBoardAreas({ plan, workspaceFiles: files, questions: [answer('a', 'Q1?'), answer('b', 'Q2?')] });
    expect(withAnswers.map((area) => area.id)).toEqual(['checkpoint:cp', 'question:explain/a.md', 'question:explain/b.md', 'files:workspace']);
    const without = buildBoardAreas({ plan, workspaceFiles: files, questions: [] });
    expect(without.map((area) => area.id)).toEqual(['checkpoint:cp', 'files:workspace']);
    expect(buildBoardAreas({ plan, workspaceFiles: files }).map((area) => area.id)).toEqual(['checkpoint:cp', 'files:workspace']);
    // An empty workspace with answers has them, and nothing else
    expect(buildBoardAreas({ questions: [answer('a', 'Q?')] }).map((area) => area.id)).toEqual(['question:explain/a.md']);
  });

  it('keeps the plan focus on a plan Area, and does not make an answer the Now', () => {
    const areas = buildBoardAreas({ plan, questions: [answer('a', 'Q?')] });
    const tiers = partitionOverviewTiers(areas);
    expect(tiers.tier1.map((area) => area.id)).toEqual(['checkpoint:cp']);
    expect(areas.find((area) => area.kind === 'questions')!.data).toMatchObject({ current: false, nowSet: false, done: false, waitingCount: 0 });
  });

  it('keeps explain/*.md out of Workspace files, and only those', () => {
    const entry = (path: string) => ({ path, modifiedAt: '2026-11-14T10:00:00.000Z', size: 3 });
    const grouped = groupWorkspaceFiles([entry('explain/q.md'), entry('explain/sub/deep.md'), entry('docs/explain/q.md'), entry('explain.md'), entry('PLAN.md')]);
    expect(grouped.documents.map((file) => file.path).sort()).toEqual(['PLAN.md', 'docs/explain/q.md', 'explain.md', 'explain/sub/deep.md']);
    expect(isQuestionFile('explain/q.md')).toBe(true);
    expect(isQuestionFile('./explain/Q.MD')).toBe(true);
    expect(isQuestionFile('explain/sub/q.md')).toBe(false);
  });

  it('rebuilds the reply field by field and drops what is unusable', () => {
    const cleaned = cleanAnswers({ answers: [
      answer('ok', 'Fine?'),
      { path: '../escape.md', question: 'x', parts: [] },
      { path: 'explain/bad.md', question: 'x', parts: 'nope' },
      { path: 'explain/odd.md', question: 7, summary: {}, parts: [{ title: 3, cards: [{ kind: 'code', check: { status: 'weird' }, start: -2 }, { kind: 'mystery' }, 5] }, null] },
    ] });
    expect(cleaned.map((entry) => entry.path)).toEqual(['explain/ok.md', 'explain/odd.md']);
    expect(cleaned[1]).toMatchObject({ question: 'explain/odd.md', summary: '', parts: [{ title: 'Part', heading: null, cards: [{ kind: 'code', check: { status: 'none' } }] }] });
    expect(cleanAnswers(null)).toEqual([]);
    expect(cleanAnswers({ answers: 'x' })).toEqual([]);
  });
});

describe('an answer as rows of cards', () => {
  const [area] = buildQuestionAreas([answer('a', 'Q?')]);

  it('has the short answer first, then one row for each part, each with its cards in order', () => {
    const rows = areaRows(area!, {});
    expect(rows.map((row) => [row.id, row.title, row.items.map((item) => (item.data as { variant: string }).variant)])).toEqual([
      ['row:q:0', 'In short', ['text']],
      ['row:q:1', 'Sign-in', ['text', 'code', 'code']],
      ['row:q:2', 'What you see', ['picture', 'diagram']],
    ]);
    expect(rows[1]!.items.map((item) => item.id)).toEqual(['qcard:explain/a.md#2', 'qcard:explain/a.md#3', 'qcard:explain/a.md#4']);
    expect(rows.every((row) => row.items.every((item) => item.type === 'answer' && item.height === ANSWER_CARD_HEIGHT))).toBe(true);
  });

  it('draws the cards at a readable size, fixed and read-only, on the sizes the Board is used at', () => {
    for (const size of [{ width: 1280, height: 800 }, { width: 1100, height: 700 }, { width: 1440, height: 900 }, { width: 420, height: 700 }]) {
      const nodes = areaBoardLayout(area!, { size });
      const cards = nodes.filter((node) => node.type === 'answer');
      expect(cards.length, `${size.width}x${size.height}`).toBeGreaterThan(0);
      const stage = areaStage(size);
      for (const node of cards) {
        expect(node.height).toBe(ANSWER_CARD_HEIGHT);
        expect(node.width).toBeGreaterThanOrEqual(Math.min(300, stage.width));
        expect(node.draggable).toBe(false);
        expect(node.selectable).toBe(false);
        expect(node.deletable).toBe(false);
        expect(node.position.x + (node.width ?? 0)).toBeLessThanOrEqual(stage.width + 1);
      }
      // Every row has its header, so a row that does not fit is one line and not missing
      expect(nodes.filter((node) => node.type === 'step' || node.type === 'fold').length).toBe(3);
    }
  });

  it('wraps the cards of a part onto as many lines as it needs and folds whole parts, never "+N more" on a part that is shown', () => {
    // A narrow stage (the board half of a Split): one card to a line
    const size = { width: 520, height: 800 };
    const nodes = areaBoardLayout(area!, { size });
    const ids = nodes.filter((node) => node.type === 'answer').map((node) => node.id);
    expect(ids).toEqual(expect.arrayContaining(['qcard:explain/a.md#1', 'qcard:explain/a.md#2', 'qcard:explain/a.md#3', 'qcard:explain/a.md#4']));
    expect(nodes.some((node) => node.type === 'more')).toBe(false);
    // The part that does not fit is one folded line; the Area stays on one screen
    expect(nodes.some((node) => node.type === 'fold')).toBe(true);
    const stage = areaStage(size);
    for (const node of nodes) expect(node.position.y + (node.height ?? 0)).toBeLessThanOrEqual(stage.height + 1);
  });

  it('never folds "In short", at any size, and a folded part previews its own words, never its title again', () => {
    for (const size of [{ width: 520, height: 620 }, { width: 520, height: 800 }, { width: 431, height: 700 }, { width: 1280, height: 400 }]) {
      const nodes = areaBoardLayout(area!, { size });
      expect(nodes.some((node) => node.id === 'qcard:explain/a.md#1'), `${size.width}x${size.height}`).toBe(true);
      for (const node of nodes) {
        if (node.type !== 'fold') continue;
        const data = node.data as { title: string; preview?: string };
        expect(data.preview ?? '').not.toContain(data.title);
      }
    }
    const [mixed] = buildQuestionAreas([answer('c', 'Q3?', { parts: [
      { title: 'In short', heading: null, cards: [{ kind: 'text', text: 'The **short** answer.' }] },
      { title: 'First part', heading: 'First part', cards: [{ kind: 'text', text: 'Its own words.' }, { kind: 'code', language: 'ts', copy: 'a', where: 'R/a.ts', repo: 'R', repoPath: '/w/R', file: 'a.ts', start: 1, end: 1, check: { status: 'matches' } }] },
      { title: 'Code only', heading: 'Code only', cards: [{ kind: 'code', language: 'ts', copy: 'a', where: 'R/b.ts', repo: 'R', repoPath: '/w/R', file: 'b.ts', start: 4, end: 6, check: { status: 'matches' } }] },
    ] })]);
    const folds = areaBoardLayout(mixed!, { size: { width: 520, height: 330 } }).filter((node) => node.type === 'fold').map((node) => (node.data as { title: string; preview?: string }));
    expect(folds.find((f) => f.title === 'First part')?.preview).toBe('Its own words.');
    expect(folds.find((f) => f.title === 'Code only')?.preview).toBe('R/b.ts · 4–6');
  });

  it('says what a folded part holds, with its checks', () => {
    const rows = areaRows(area!, {});
    expect(rows.map((row) => row.summary)).toEqual(['1 card', '3 cards · 1 changed since', '2 cards']);
    const [other] = buildQuestionAreas([answer('b', 'Q2?', { parts: [{ title: 'P', heading: 'P', cards: [
      { kind: 'code', language: 'ts', copy: 'a', where: 'R/a.ts', repo: 'R', repoPath: '/w/R', file: 'a.ts', start: 1, end: 1, check: { status: 'matches' } },
      { kind: 'code', language: 'ts', copy: 'b', where: 'R/b.ts', repo: 'R', repoPath: '/w/R', file: 'b.ts', start: 1, end: 1, check: { status: 'moved', start: 4, end: 4 } },
    ] }, { title: 'Q', heading: 'Q', cards: [
      { kind: 'code', language: 'ts', copy: 'c', where: 'R/c.ts', repo: 'R', check: { status: 'gone' }, start: 1, end: 1 },
      { kind: 'code', language: 'ts', copy: 'd', where: 'X/d.ts', check: { status: 'not-in-workspace' }, start: 1, end: 1 },
    ] }] })]);
    expect(areaRows(other!, {}).map((row) => row.summary)).toEqual(['2 cards · Matches', '2 cards · 1 file gone · 1 not checked']);
  });

  it('opens a row to show all of its cards', () => {
    const nodes = areaBoardLayout(area!, { size: { width: 1280, height: 800 }, openRow: 'row:q:1' });
    expect(nodes.filter((node) => node.type === 'answer' && node.id.startsWith('qcard:explain/a.md#')).map((node) => node.id)).toEqual(expect.arrayContaining(['qcard:explain/a.md#2', 'qcard:explain/a.md#3', 'qcard:explain/a.md#4']));
  });

  it('reads the answer in the reader from its text, picture and diagram cards, at the part\'s heading', () => {
    const targets = collectAreaReaderTargets(area!);
    expect(targets.map((target) => [target.card, target.path, target.heading])).toEqual([
      ['qcard:explain/a.md#1', 'explain/a.md', undefined],
      ['qcard:explain/a.md#2', 'explain/a.md', 'Sign-in'],
      ['qcard:explain/a.md#5', 'board-pictures/x.png', undefined],
      ['qcard:explain/a.md#6', 'explain/a.md', 'What you see'],
    ]);
  });
});

describe('the index', () => {
  const areas = buildBoardAreas({ plan, questions: [answer('a', 'How do we enforce security?')] });

  it('lists answers under Questions, not under Areas, and finds them by their words', () => {
    const sections = buildBoardNav(areas, { mode: 'category' });
    expect(sections.map((section) => section.title)).toEqual(['Areas', 'Questions']);
    const questions = sections.find((section) => section.title === 'Questions')!;
    expect(questions.items).toHaveLength(1);
    expect(questions.items[0]).toMatchObject({ areaId: 'question:explain/a.md', title: 'How do we enforce security?', subtitle: '2 parts · 2 code blocks · 1 picture · Out of date · 1 copy' });
    expect(sections.find((section) => section.title === 'Areas')!.items.map((item) => item.areaId)).toEqual(['checkpoint:cp']);
    // By the question, the short answer and the name of a part
    for (const query of ['security', 'checked first', 'sign-in']) {
      expect(buildBoardNav(areas, { mode: 'category', query }).some((section) => section.title === 'Questions'), query).toBe(true);
    }
    expect(buildBoardNav(areas, { mode: 'category', query: 'nothing-like-this' })).toEqual([]);
  });

  it('lists them in the Area mode under a heading of their own', () => {
    const sections = buildBoardNav(areas, { mode: 'area' });
    expect(sections.map((section) => [section.title, section.group])).toEqual([['CP', undefined], ['How do we enforce security?', 'Questions']]);
    expect(sections[1]!.items[0]).toMatchObject({ areaId: 'question:explain/a.md', nodeId: null });
  });
});

describe('the index search', () => {
  it('matches an answer by its short answer, and a plan Area not by its preview text', () => {
    const [area] = buildBoardAreas({ plan });
    const withPreview = { ...area!, data: { ...area!.data, preview: 'zebra-preview-words' } };
    expect(buildBoardNav([withPreview], { mode: 'category', query: 'zebra-preview-words' })).toEqual([]);
    const [question] = buildQuestionAreas([answer('a', 'Q?', { summary: 'zebra' })]);
    expect(buildBoardNav([{ ...question!, data: { ...question!.data, preview: 'zebra' } }], { mode: 'category', query: 'zebra' })).toHaveLength(1);
  });
});

describe('what a code card says', () => {
  it('says what the check found, and what to do when the place is not here', () => {
    expect(codeStatus({ status: 'matches' })).toEqual({ label: 'Matches', tone: 'ok' });
    expect(codeStatus({ status: 'moved', start: 52, end: 80 })).toEqual({ label: 'Moved to 52–80', tone: 'ok' });
    expect(codeStatus({ status: 'changed' })).toEqual({ label: 'Changed since', tone: 'warn' });
    expect(codeStatus({ status: 'gone' })).toEqual({ label: 'File gone', tone: 'warn' });
    expect(codeStatus({ status: 'not-in-workspace' }, 'Billing/src/a.ts')).toEqual({ label: 'Not in this workspace', tone: 'muted', hint: 'Add Billing to the workspace to check it' });
    expect(codeStatus({ status: 'unreadable' })?.label).toBe('Could not be checked');
    expect(codeStatus({ status: 'none' })).toBeNull();
  });

  it('heads a card with the place and its lines, following a copy that moved', () => {
    expect(codeHead({ where: 'NexusFlow/src/http/auth.ts', language: 'ts', start: 12, end: 40 })).toBe('NexusFlow/src/http/auth.ts · 12–40');
    expect(codeHead({ where: 'a.md', language: 'md', start: 7, end: 7 })).toBe('a.md · 7');
    expect(codeHead({ where: 'a.ts', language: 'ts', start: 1, end: 2 }, { status: 'moved', start: 52, end: 80 })).toBe('a.ts · 52–80');
    expect(codeHead({ language: 'bash' })).toBe('bash');
    // In two parts, so a long place can be cut at its start and the lines never are
    expect(codeHeadParts({ where: 'NexusFlow/src/http/auth.ts', language: 'ts', start: 12, end: 40 })).toEqual({ name: 'NexusFlow/src/http/auth.ts', lines: ' · 12–40' });
    expect(codeHeadParts({ language: 'bash' })).toEqual({ name: 'bash', lines: '' });
  });

  it('marks the lines that differ between the copy and the lines now', () => {
    expect(differingLines(['a', 'b', 'c'], ['a', 'B', 'c', 'd'])).toEqual({ before: [false, true, false], after: [false, true, false, true] });
    expect(differingLines(['a  '], ['a'])).toEqual({ before: [false], after: [false] });
    expect(differingLines(['x'], [])).toEqual({ before: [true], after: [] });
  });

  it('shows text as plain words, with no marks of Markdown', () => {
    expect(readableText('**Bold** and `code` with [a link](http://x.y)\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |')).toBe('Bold and code with a link one two a · b 1 · 2');
  });
});

describe('answer freshness', () => {
  it('labels changed and gone copies and makes the refresh request', async () => {
    const { answerCounts, answerView, answerCountWords, refreshRequest } = await import('./questionsArea.js');
    const dto = answer('fresh', 'How?');
    const codes = dto.parts.flatMap((part) => part.cards).filter((card) => card.kind === 'code');
    if (codes[0]?.kind !== 'code' || codes[1]?.kind !== 'code') throw new Error('expected code');
    codes[0].check = { status: 'changed' };
    codes[1].check = { status: 'gone' };
    const view = answerView(dto);
    expect(answerCountWords(answerCounts(view)).at(-1)?.label).toBe('Out of date · 2 copies');
    expect(refreshRequest(view)).toContain('Refresh the answer explain/fresh.md ("How?"): these copies no longer match:');
    expect(refreshRequest(view)).toContain('(changed)');
    expect(refreshRequest(view)).toContain('(gone)');
  });
});

describe('fix1 diagram repair request', () => {
  it('names the answer, part and Mermaid diagnostic without starting or submitting anything', async () => {
    const { diagramFixRequest } = await import('./questionsArea.js');
    expect(diagramFixRequest({ path: 'explain/x.md', question: 'How do we save?', heading: 'Saving a draft' }, "Parse error on line 2: Expecting 'SQE', got 'PS'"))
      .toBe('Fix the diagram in explain/x.md ("How do we save?"), part "Saving a draft": Mermaid says: Parse error on line 2: Expecting \'SQE\', got \'PS\'. Follow the diagram rules of the contextspace-explain skill.');
  });
  it('leaves the part out when the reader has no heading', async () => {
    const { diagramFixRequest } = await import('./questionsArea.js');
    expect(diagramFixRequest({ path: 'explain/x.md', question: 'How?' }, 'No diagram type detected'))
      .toBe('Fix the diagram in explain/x.md ("How?"): Mermaid says: No diagram type detected. Follow the diagram rules of the contextspace-explain skill.');
  });
});
