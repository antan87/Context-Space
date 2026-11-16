import { describe, expect, it } from 'vitest';
import {
  assignmentCardView, assignmentSaveBody, checkObjective, checkSpec, checkSpecFileName, checkSpecText, specSaveBody, specTitleFromFile,
  OBJECTIVE_LIMIT, SPEC_CHAR_LIMIT,
} from './assignmentCardView.js';
import type { WorkDocument, WorkGuidance } from '../../types.js';

const doc = (id: string, title: string): WorkDocument => ({ id, title, role: 'requirements', status: 'approved', scope: {}, summary: '', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' });
const guidance = (objective: string, documents: WorkDocument[] = []): WorkGuidance => ({
  version: 1, revision: 7, workType: 'feature', size: 'epic', documents,
  assignment: { stage: 'design', objective, expectedOutput: 'A report', stopCondition: 'Stop at review', milestoneId: 'm1' },
});

describe('assignmentCardView', () => {
  it('shows the first non-empty line of the description', () => {
    const view = assignmentCardView(guidance('\n\n  Build the board card.  \nSecond line that stays out.'));
    expect(view).toMatchObject({ firstLine: 'Build the board card.', hasDescription: true, specs: [] });
  });
  it('cuts a long first line with an ellipsis', () => {
    const view = assignmentCardView(guidance('x'.repeat(500)));
    expect(view.firstLine.length).toBeLessThanOrEqual(200);
    expect(view.firstLine.endsWith('…')).toBe(true);
  });
  it('says there is no description for an empty or blank objective', () => {
    expect(assignmentCardView(guidance(''))).toMatchObject({ firstLine: '', hasDescription: false });
    expect(assignmentCardView(guidance(' \n \t'))).toMatchObject({ hasDescription: false });
  });
  it('lists every source document as a named chip, naming an untitled one', () => {
    const view = assignmentCardView(guidance('Go', [doc('a', 'Export requirements'), doc('b', '  ')]));
    expect(view.specs).toEqual([{ id: 'a', title: 'Export requirements' }, { id: 'b', title: 'Untitled spec' }]);
  });
});

describe('assignmentSaveBody', () => {
  it('changes only the objective: everything else goes back as saved', () => {
    const saved = guidance('Old');
    expect(assignmentSaveBody(saved, 7, 'New')).toEqual({
      revision: 7, workType: 'feature', size: 'epic',
      assignment: { stage: 'design', objective: 'New', expectedOutput: 'A report', stopCondition: 'Stop at review', milestoneId: 'm1' },
    });
  });
});

describe('checkObjective', () => {
  it('accepts up to the limit and refuses past it, saying by how much', () => {
    expect(checkObjective('x'.repeat(OBJECTIVE_LIMIT))).toBeNull();
    expect(checkObjective('x'.repeat(OBJECTIVE_LIMIT + 5))).toMatch(/5 characters over/);
  });
});

describe('spec checks', () => {
  it('accepts Markdown and text file names, in any case, and refuses the rest', () => {
    for (const name of ['a.md', 'A.MARKDOWN', 'notes.txt']) expect(checkSpecFileName(name)).toBeNull();
    for (const name of ['a.pdf', 'a.docx', 'md', 'a.md.exe']) expect(checkSpecFileName(name)).toMatch(/not a Markdown or text file/);
  });
  it('takes the title from the file name without its extension', () => {
    expect(specTitleFromFile('Export requirements.md')).toBe('Export requirements');
    expect(specTitleFromFile('.md')).toBe('.md');
  });
  it('refuses text over 500,000 characters, binary text and text too large to send', () => {
    expect(checkSpecText('x'.repeat(SPEC_CHAR_LIMIT))).toBeNull();
    expect(checkSpecText('x'.repeat(SPEC_CHAR_LIMIT + 1))).toMatch(/500,000/);
    expect(checkSpecText('abc\u0000def')).toMatch(/not a text file/);
    expect(checkSpecText('é'.repeat(400_000))).toMatch(/too large to send/);
  });
  it('measures the text as it is sent: escaped newlines and quotes count twice', () => {
    expect(checkSpecText('\n'.repeat(250_000))).toBeNull();
    expect(checkSpecText('\n'.repeat(300_000))).toMatch(/too large to send/);
    expect(checkSpecText('"'.repeat(300_000))).toMatch(/too large to send/);
    expect(checkSpecText('a'.repeat(300_000))).toBeNull();
    // the text, the title and a summary of quotes together still fit under the route's limit
    expect(checkSpec({ title: 'T', content: '"a'.repeat(185_000), summary: '"'.repeat(4000) })).toBeNull();
  });
  it('needs a title and some text', () => {
    expect(checkSpec({ title: ' ', content: 'x', summary: '' })).toMatch(/title/);
    expect(checkSpec({ title: 'T'.repeat(201), content: 'x', summary: '' })).toMatch(/200/);
    expect(checkSpec({ title: 'T', content: ' \n', summary: '' })).toMatch(/Paste/);
    expect(checkSpec({ title: 'T', content: 'x', summary: '' })).toBeNull();
  });
  it('sends approved requirements for the whole project, with the text as typed', () => {
    expect(specSaveBody(3, { title: ' Spec ', content: '# Body\n', summary: ' short ' })).toEqual({
      revision: 3, title: 'Spec', role: 'requirements', status: 'approved', scope: {}, summary: 'short', content: '# Body\n',
    });
  });
});
