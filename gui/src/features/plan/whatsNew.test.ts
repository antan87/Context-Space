import { describe, expect, it } from 'vitest';
import { agoText, newsCounts, newsGroups, newsHeading, newsSummary, type WhatsNewView } from './whatsNew.js';

const NOW = new Date('2026-06-17T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const none = { items: [], more: 0 };

const news = (fields: Partial<WhatsNewView> = {}): WhatsNewView => ({
  reader: 'user', at: NOW.toISOString(), from: ago(120), basis: 'last-look', plan: none, documents: none, knowledge: none, commits: [], problems: [], empty: false, ...fields,
});

const change = (by: string, text: string, minutes: number, action: 'ticked' | 'added' | 'answered' = 'ticked', note?: string) =>
  ({ at: ago(minutes), by, action, kind: 'step' as const, key: text, text, ...(note ? { note } : {}) });

const document = (name: string, change: 'added' | 'changed', minutes: number) => ({ name, kind: 'markdown', change, at: ago(minutes) });

describe('agoText', () => {
  it('says "just now" for under a minute, then how long ago', () => {
    expect(agoText(ago(0.5), NOW)).toBe('just now');
    expect(agoText(ago(1.5), NOW)).toBe('2 min ago');
    expect(agoText(ago(180), NOW)).toBe('3 h ago');
    expect(agoText(undefined, NOW)).toBe('');
  });
});

describe('newsCounts', () => {
  it('counts each part of the list, and leaves out what did not change', () => {
    expect(newsCounts(news({
      plan: { items: [change('claude', 'A', 5), change('codex', 'B', 4), change('file', 'C', 3)], more: 0 },
      documents: { items: [document('docs/export-flow.png', 'added', 10)], more: 0 },
      commits: [{ repo: 'api', commits: [{ sha: 'a1b2c3d', author: 'Anna', subject: 'One', at: ago(5) }, { sha: 'b2c3d4e', author: 'Ben', subject: 'Two', at: ago(4) }], more: 0 }],
    }))).toEqual(['3 plan changes', '1 new document', '2 commits']);
    expect(newsCounts(news())).toEqual([]);
  });

  it('says new and changed documents apart, and new knowledge entries, in the singular too', () => {
    expect(newsCounts(news({
      documents: { items: [document('a.md', 'added', 1), document('b.md', 'changed', 2), document('c.md', 'changed', 3)], more: 0 },
      knowledge: { items: [{ id: 'x', title: 'A lesson', date: '2026-06-16', type: 'gotcha' }], more: 0 },
      commits: [{ repo: 'api', commits: [{ sha: 'a1b2c3d', author: 'Anna', subject: 'One', at: ago(5) }], more: 0 }],
    }))).toEqual(['1 new document', '2 changed documents', '1 new knowledge entry', '1 commit']);
  });

  it('adds what is not listed to the counts, across repositories, and says when it is at least that many', () => {
    const commit = { sha: 'a1b2c3d', author: 'Anna', subject: 'One', at: ago(5) };
    expect(newsCounts(news({
      plan: { items: [change('claude', 'A', 5)], more: 4 },
      documents: { items: [document('a.md', 'added', 1)], more: 2 },
      knowledge: { items: [], more: 3 },
      commits: [{ repo: 'api', commits: [commit], more: 90, moreAtLeast: true }, { repo: 'web', commits: [commit], more: 0 }, { repo: 'old', commits: [], more: 0, problem: 'The folder is missing.' }],
    }))).toEqual(['5 plan changes', '3 documents', '3 new knowledge entries', '92+ commits']);
  });
});

describe('newsHeading and newsSummary', () => {
  it('says since the last look, then what changed', () => {
    const view = news({ plan: { items: [change('claude', 'A', 5)], more: 0 }, commits: [{ repo: 'api', commits: [{ sha: 'a1b2c3d', author: 'Anna', subject: 'One', at: ago(5) }], more: 0 }] });
    expect(newsHeading(view, NOW)).toBe('Since you last looked, 2 h ago');
    expect(newsSummary(view, NOW)).toBe('Since you last looked, 2 h ago: 1 plan change, 1 commit');
    expect(newsHeading({ ...view, from: ago(0.5) }, NOW)).toBe('Since you last looked just now');
    expect(newsHeading({ ...view, from: ago(60 * 24) }, NOW)).toBe('Since you last looked, yesterday');
  });

  it('reaches back the last days for a first look', () => {
    expect(newsHeading(news({ basis: 'first-look', from: new Date(NOW.getTime() - 3 * 86_400_000).toISOString() }), NOW)).toBe('In the last 3 days');
  });
});

describe('newsGroups', () => {
  it('lists each part as the command does, with who and when, and nothing for a part that did not change', () => {
    const groups = newsGroups(news({
      plan: { items: [change('claude', 'Write the CSV writer', 40), change('codex', 'Which time zone?', 30, 'answered', 'UTC'), change('file', 'Add the Export button', 20, 'added')], more: 2 },
      documents: { items: [document('docs/export-flow.png', 'added', 60)], more: 1 },
      knowledge: { items: [{ id: 'x', title: 'Plan md has its own lock', date: '2026-06-16', type: 'gotcha' }, { id: 'y', title: 'Untyped', date: null, type: null }], more: 0 },
      commits: [{ repo: 'api', commits: [{ sha: 'a1b2c3d', author: 'Anna', subject: 'Fix rounding in totals', at: ago(180) }], more: 90, moreAtLeast: true }],
    }), NOW);

    expect(groups).toEqual([
      { title: 'Plan', lines: [
        'and 2 earlier, not shown',
        'Claude ticked “Write the CSV writer” · 40 min ago',
        'Codex answered “Which time zone?”: UTC · 30 min ago',
        'An edit to PLAN.md added “Add the Export button” · 20 min ago',
      ] },
      { title: 'Documents', lines: ['docs/export-flow.png added · 1 h ago', 'and 1 more'] },
      { title: 'Knowledge', lines: ['gotcha “Plan md has its own lock” · 2026-06-16', 'note “Untyped”'] },
      { title: 'Commits', lines: ['api: a1b2c3d Fix rounding in totals (Anna) · 3 h ago', 'and 90+ more in api'] },
    ]);
  });

  it('says which repositories could not be read, and what else could not', () => {
    const groups = newsGroups(news({ plan: { items: [change('claude', 'A', 5)], more: 0 }, commits: [{ repo: 'web', commits: [], more: 0, problem: 'This is not a git repository.' }], problems: ['The documents could not be read: denied'] }), NOW);
    expect(groups.at(-1)).toEqual({ title: 'Not read', lines: ['web could not be read: This is not a git repository.', 'The documents could not be read: denied'] });
    expect(groups.map((group) => group.title)).toEqual(['Plan', 'Not read']);
  });
});
