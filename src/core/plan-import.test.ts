import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  IMPORTED_NOTES_TITLE,
  PLAN_ARCHIVE_DIR,
  applyPlanningNotes,
  importPlanningNotes,
  notesHaveContent,
  ownerFrom,
  parsePlanningNotes,
} from './plan-import.js';
import { PLANNING_NOTES_FILE, PLANNING_NOTES_TEMPLATE } from './planning-notes.js';
import { changePlan, emptyPlan, mutatePlan, readPlan, type PlanDocument } from './plan.js';
import { saveWorkspaceState } from './workspace-state.js';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';

const AT = '2026-10-10T12:00:00.000Z';

/** The template with rows added under the given table headings. */
function notes(rows: Partial<Record<'outcomes' | 'questions' | 'existing' | 'decisions', string[]>>, extra = ''): string {
  const after = (heading: string, lines: string[] = []) => (text: string) => {
    const start = text.indexOf(heading);
    const separator = text.indexOf('| --- |', start);
    const end = text.indexOf('\n', separator) + 1;
    return lines.length ? `${text.slice(0, end)}${lines.join('\n')}\n${text.slice(end)}` : text;
  };
  let text = PLANNING_NOTES_TEMPLATE;
  text = after('## Outcomes', rows.outcomes)(text);
  text = after('## Open questions', rows.questions)(text);
  text = after('## Existing work', rows.existing)(text);
  text = after('## Flagged defects', rows.decisions)(text);
  return text + extra;
}

function planWith(...milestones: Array<{ id: string; title: string; waitsFor?: string[] }>): PlanDocument {
  const plan = emptyPlan();
  for (const milestone of milestones) {
    plan.items.push({ kind: 'milestone', status: 'todo', waitsFor: [], createdAt: AT, updatedAt: AT, history: [], ...milestone });
  }
  return plan;
}

describe('parsePlanningNotes', () => {
  it('finds nothing in the untouched template', () => {
    const parsed = parsePlanningNotes(PLANNING_NOTES_TEMPLATE);
    expect(Object.values(parsed.rows).flat()).toEqual([]);
    expect(parsed.leftover).toEqual([]);
    expect(notesHaveContent(parsed)).toBe(false);
  });

  it('reads the rows of the four tables, with escaped pipes and empty cells', () => {
    const parsed = parsePlanningNotes(notes({
      outcomes: ['| M2 | Users download a CSV \\| Excel later | api#41 | M1 | — |'],
      questions: ['| Q1 | Max rows? | PO | open | M2 | |'],
      existing: ['| CSV helper | api@abc | merged | tests pass | none |'],
      decisions: ['| Excel | defer | Later | PO | after 2.5 |'],
    }));
    expect(parsed.rows.outcomes).toEqual([['M2', 'Users download a CSV | Excel later', 'api#41', 'M1', '']]);
    expect(parsed.rows.questions).toEqual([['Q1', 'Max rows?', 'PO', 'open', 'M2', '']]);
    expect(parsed.rows.existing).toEqual([['CSV helper', 'api@abc', 'merged', 'tests pass', '']]);
    expect(parsed.rows.decisions).toEqual([['Excel', 'defer', 'Later', 'PO', 'after 2.5']]);
    expect(parsed.leftover).toEqual([]);
  });

  it('keeps malformed rows, added prose and unknown tables, under their headings, so nothing is lost', () => {
    const parsed = parsePlanningNotes(notes(
      { outcomes: ['| only two | cells |', '| | no id at all | x | y | z |'] },
      '\n## Risks\n\n| Risk | Mitigation |\n| --- | --- |\n| Timeouts | Stream |\n\nAgreed with sales.\n',
    ));
    expect(parsed.rows.outcomes).toEqual([]);
    expect(parsed.leftover).toEqual([
      '## Outcomes and release order',
      '| only two | cells |',
      '| | no id at all | x | y | z |',
      '',
      '## Risks',
      '| Risk | Mitigation |',
      '| --- | --- |',
      '| Timeouts | Stream |',
      '',
      'Agreed with sales.',
    ]);
    expect(notesHaveContent(parsed)).toBe(true);
  });

  it('reads Windows line endings and a notes file with no template at all', () => {
    const parsed = parsePlanningNotes('## Open questions\r\n\r\n| ID | Question | Owner | Status | Blocks | Resolution |\r\n| --- | --- | --- | --- | --- | --- |\r\n| Q1 | Which zone? | | open | | |\r\n');
    expect(parsed.rows.questions).toEqual([['Q1', 'Which zone?', '', 'open', '', '']]);
    // A header the template does not have is the author's own text, kept as a table.
    expect(parsed.leftover).toEqual(['## Open questions', '| ID | Question | Owner | Status | Blocks | Resolution |', '| --- | --- | --- | --- | --- | --- |']);
  });
});

describe('ownerFrom', () => {
  it('maps the user and the AI, and keeps a person\'s name as written', () => {
    expect(ownerFrom('')).toBe('user');
    expect(ownerFrom('You')).toBe('user');
    expect(ownerFrom('Claude')).toBe('agent');
    expect(ownerFrom('the AI')).toBe('agent');
    expect(ownerFrom('PO')).toBe('PO');
    expect(ownerFrom('Anna Berg')).toBe('Anna Berg');
  });
});

describe('applyPlanningNotes', () => {
  it('adds each row as the right kind of item, attaches outcomes to their milestones and keeps the waits', () => {
    const plan = planWith({ id: 'M1', title: 'Database query' }, { id: 'M2', title: 'CSV endpoint' });
    const result = applyPlanningNotes(plan, parsePlanningNotes(notes({
      outcomes: ['| M2 | Users download a CSV | api#41 | M1 | With 2.5 |', '| M3 | Export button | web | M2, M9 | After the API |'],
      questions: ['| Q1 | Max rows? | PO | open | M2 | Asked in Slack |', '| Q2 | Time zone? | | resolved | M3 | UTC |', '| Q9 | Old idea? | Claude | dropped | | Not needed |'],
      existing: ['| CSV helper | api@abc | merged | tests pass | none |'],
      decisions: ['| Excel | defer | Not now | PO | after 2.5 |', '| Slow button | flag only | Replaced | | |', '| Streaming | implement | Big reports | | M2 |', '| Pagination | undecided | | | |'],
    })), AT);

    expect(result.updated).toEqual(['M2']);
    expect(result.added).toEqual(['M3', 'Q1', 'Q2', 'Q9', 'E1', 'D1', 'D2', 'D3', 'D4']);
    const item = (id: string) => plan.items.find((candidate) => candidate.id === id)!;
    expect(item('M2').detail).toContain('Outcome: Users download a CSV\nWork item: api#41\nRelease order: With 2.5');
    expect(item('M2').waitsFor).toEqual(['M1', 'Q1']);
    expect(item('M3')).toMatchObject({ kind: 'milestone', title: 'Export button', status: 'todo', waitsFor: ['M2', 'Q2'] });
    expect(item('M3').detail).toContain('Also waited for, in the old notes: M9');
    expect(item('Q1')).toMatchObject({ kind: 'question', owner: 'PO', status: 'todo', detail: 'So far: Asked in Slack' });
    expect(item('Q2')).toMatchObject({ owner: 'user', status: 'done', resolution: 'UTC' });
    expect(item('Q9')).toMatchObject({ owner: 'agent', status: 'dropped', resolution: 'Not needed' });
    expect(item('E1')).toMatchObject({ kind: 'existing', status: 'done', resolution: 'merged; tests pass', detail: 'Where: api@abc' });
    expect(item('D1')).toMatchObject({ status: 'later', revisitWhen: 'after 2.5', owner: 'PO' });
    expect(item('D2')).toMatchObject({ status: 'done', resolution: 'Flag only: Replaced' });
    expect(item('D3')).toMatchObject({ status: 'done', resolution: 'Implement: Big reports' });
    expect(item('D4')).toMatchObject({ status: 'todo' });
    for (const id of result.added) expect(item(id).history).toEqual([{ at: AT, by: 'contextspace', action: 'imported', note: `From ${PLANNING_NOTES_FILE}` }]);
  });

  it('never makes a circle of waits, and says which waits it left out', () => {
    const plan = planWith({ id: 'M1', title: 'First' }, { id: 'M2', title: 'Second', waitsFor: ['M1'] });
    applyPlanningNotes(plan, parsePlanningNotes(notes({ outcomes: ['| M1 | First thing | | M2 | |'] })), AT);
    expect(plan.items.find((item) => item.id === 'M1')!.waitsFor).toEqual([]);
    expect(plan.items.find((item) => item.id === 'M1')!.detail).toContain('Also waited for, in the old notes: M2');
  });

  it('gives a row a new code when its code is taken by another kind of item', () => {
    const plan = planWith({ id: 'Q1', title: 'A milestone someone called Q1' });
    applyPlanningNotes(plan, parsePlanningNotes(notes({ questions: ['| Q1 | Which zone? | | open | | |'] })), AT);
    expect(plan.items.map((item) => `${item.id} ${item.kind}`)).toEqual(['Q1 milestone', 'Q2 question']);
  });

  it('adds nothing twice: applying the same notes again changes nothing', () => {
    const plan = planWith({ id: 'M1', title: 'Database query' });
    const parsed = parsePlanningNotes(notes({ outcomes: ['| M1 | Rows load | | | |'], questions: ['| Q1 | Max rows? | | open | M1 | |'] }, '\nAgreed with sales.\n'));
    applyPlanningNotes(plan, parsed, AT, '.contextspace/archive/x.md');
    const once = JSON.stringify(plan);
    expect(applyPlanningNotes(plan, parsed, AT, '.contextspace/archive/x.md')).toEqual({ added: [], updated: [] });
    expect(JSON.stringify(plan)).toBe(once);
  });

  it('leaves leftover text in the archived notes file instead of asking the user about it', () => {
    const plan = emptyPlan();
    applyPlanningNotes(plan, parsePlanningNotes(notes({}, `\n## Notes\n\n${'Long text. '.repeat(600)}\n`)), AT, '.contextspace/archive/notes.md');
    expect(plan.items.some((item) => item.title === IMPORTED_NOTES_TITLE)).toBe(false);
    expect(plan.items).toEqual([]);
  });
});

describe('importPlanningNotes', () => {
  let root: string;
  const notesPath = () => path.join(root, PLANNING_NOTES_FILE);
  const exists = (file: string) => fs.access(path.join(root, file)).then(() => true, () => false);

  beforeEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-import-'));
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'reports', branchName: 'reports', description: 'Reports', repos: [], assistants: [], workspacePath: root }));
  });
  afterEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does nothing without a notes file', async () => {
    expect(await importPlanningNotes(root)).toEqual({ status: 'none', added: [], updated: [], removed: true });
    expect(await exists('contextspace-plan.json')).toBe(false);
  });

  it('moves the notes into the plan, keeps the file in the archive, removes it, and is a no-op the second time', async () => {
    const content = notes({ questions: ['| Q1 | Max rows? | | open | | |'] });
    await fs.writeFile(notesPath(), content);

    const first = await importPlanningNotes(root, new Date(AT));
    const archived = `${PLAN_ARCHIVE_DIR}/contextspace-milestones-2026-10-10.md`;
    expect(first).toEqual({ status: 'imported', added: ['Q1'], updated: [], archivedAs: archived, removed: true });
    expect(await fs.readFile(path.join(root, archived), 'utf8')).toBe(content);
    expect(await exists(PLANNING_NOTES_FILE)).toBe(false);
    const plan = await readPlan(root);
    expect(plan.imports).toEqual([expect.objectContaining({ file: PLANNING_NOTES_FILE, at: AT, archivedAs: archived, items: ['Q1'] })]);
    // No generated summary follows it any more: PLAN.md is the plan people read.
    expect(await exists('contextspace-plan.md')).toBe(false);

    expect(await importPlanningNotes(root)).toMatchObject({ status: 'none' });
    expect((await readPlan(root)).items).toHaveLength(1);
  });

  it('finishes an interrupted import without adding anything twice', async () => {
    const content = notes({ questions: ['| Q1 | Max rows? | | open | | |'] });
    await fs.writeFile(notesPath(), content);
    await importPlanningNotes(root, new Date(AT));
    // As if the run stopped after saving the plan: the file is back and the copy is gone.
    await fs.writeFile(notesPath(), content);
    await fs.rm(path.join(root, PLAN_ARCHIVE_DIR), { recursive: true });

    const again = await importPlanningNotes(root, new Date(AT));
    expect(again).toMatchObject({ status: 'already', added: [], removed: true, archivedAs: `${PLAN_ARCHIVE_DIR}/contextspace-milestones-2026-10-10.md` });
    expect(await fs.readFile(path.join(root, again.archivedAs!), 'utf8')).toBe(content);
    expect(await exists(PLANNING_NOTES_FILE)).toBe(false);
    expect((await readPlan(root)).items).toHaveLength(1);
  });

  it('moves notes written later through the old tools, adding only what is new, and keeps both copies', async () => {
    await fs.writeFile(notesPath(), notes({ questions: ['| Q1 | Max rows? | | open | | |'] }));
    await importPlanningNotes(root, new Date(AT));
    await fs.writeFile(notesPath(), notes({ questions: ['| Q1 | Max rows? | | open | | |', '| Q2 | Time zone? | | open | | |'] }));

    const later = await importPlanningNotes(root, new Date('2026-10-10T15:30:00.000Z'));
    expect(later).toMatchObject({ status: 'imported', added: ['Q2'] });
    expect(later.archivedAs).toBe(`${PLAN_ARCHIVE_DIR}/contextspace-milestones-2026-10-10T15-30-00-000Z.md`);
    expect((await readPlan(root)).items.map((item) => item.id)).toEqual(['Q1', 'Q2']);
    expect(await fs.readdir(path.join(root, PLAN_ARCHIVE_DIR))).toHaveLength(2);
  });

  it('removes the untouched template without keeping a copy or adding items', async () => {
    await fs.writeFile(notesPath(), PLANNING_NOTES_TEMPLATE);
    expect(await importPlanningNotes(root)).toMatchObject({ status: 'imported', added: [], removed: true });
    expect(await exists(PLANNING_NOTES_FILE)).toBe(false);
    expect(await exists(PLAN_ARCHIVE_DIR)).toBe(false);
  });

  it('keeps a copy of anything else, even when nothing in it could be read', async () => {
    await fs.writeFile(notesPath(), '# notes\n');
    const result = await importPlanningNotes(root, new Date(AT));
    expect(result.archivedAs).toBeDefined();
    expect(await fs.readFile(path.join(root, result.archivedAs!), 'utf8')).toBe('# notes\n');
  });

  it('adds the notes to milestones that come from an older lifecycle', async () => {
    await saveWorkspaceState({ workspacePath: root, repos: {}, updatedAt: '', lifecycle: {
      workspaceId: 'reports', flowType: 'feature', updatedAt: AT,
      steps: [{ id: 'query', title: 'Database query', status: 'pending' }],
    } });
    await fs.writeFile(notesPath(), notes({ outcomes: ['| query | Rows load in under a second | | | |'] }));
    expect(await importPlanningNotes(root, new Date(AT))).toMatchObject({ status: 'imported', updated: ['query'] });
    expect((await readPlan(root)).items[0]!.detail).toContain('Outcome: Rows load in under a second');
  });

  it('leaves the file when the storage adapter cannot remove files, and does not import it again', async () => {
    class KeepsFiles extends LocalStorageAdapter {}
    Object.defineProperty(KeepsFiles.prototype, 'deleteWorkspaceFile', { value: undefined });
    setActiveStorageProvider(new KeepsFiles());
    await fs.writeFile(notesPath(), notes({ questions: ['| Q1 | Max rows? | | open | | |'] }));

    expect(await importPlanningNotes(root, new Date(AT))).toMatchObject({ status: 'imported', removed: false });
    expect(await exists(PLANNING_NOTES_FILE)).toBe(true);
    expect(await importPlanningNotes(root, new Date(AT))).toMatchObject({ status: 'already', added: [], removed: false });
    expect((await readPlan(root)).items).toHaveLength(1);
  });

  it('changes nothing when the plan cannot be read', async () => {
    await fs.writeFile(path.join(root, 'contextspace-plan.json'), '{ broken');
    await fs.writeFile(notesPath(), notes({ questions: ['| Q1 | Max rows? | | open | | |'] }));
    await expect(importPlanningNotes(root)).rejects.toThrow(/can't be read/);
    expect(await exists(PLANNING_NOTES_FILE)).toBe(true);
    expect(await exists(PLAN_ARCHIVE_DIR)).toBe(false);
  });

  it('runs once when two processes start it together', async () => {
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'Database query' }, { actor: { by: 'user' } });
    await fs.writeFile(notesPath(), notes({ questions: ['| Q1 | Max rows? | | open | M1 | |'] }));
    const results = await Promise.all([importPlanningNotes(root, new Date(AT)), importPlanningNotes(root, new Date(AT))]);
    expect(results.filter((result) => result.status === 'imported')).toHaveLength(1);
    const plan = await readPlan(root);
    expect(plan.items.map((item) => item.id)).toEqual(['M1', 'Q1']);
    expect(plan.items[0]!.waitsFor).toEqual(['Q1']);
    // The recorded import survives a later, unrelated change.
    await mutatePlan(root, (current) => { current.items[0]!.title = 'Database query for rows'; });
    expect((await readPlan(root)).imports).toHaveLength(1);
  });
});
