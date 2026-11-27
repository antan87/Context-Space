import { describe, expect, it } from 'vitest';
import { boardNews, type WhatsNewView, type RecentCommits, type NewsCommit } from './whatsNew.js';
import { buildBoardAreas } from '../board/boardAreas.js';
import type { PlanFileView } from './planFile.js';

const plan = {
  title: 'P', file: 'PLAN.md', source: 'file', store: 'database',
  checkpoints: [
    { key: 'c1aaaa', title: 'Current checkpoint', done: false, steps: [{ key: 's1aaaa', text: 'Now step', done: false }], decisions: [] },
    { key: 'c2bbbb', title: 'Later checkpoint', done: false, steps: [{ key: 's2bbbb', text: 'Named step', done: false }], decisions: [] },
  ],
  steps: [], decisions: [], waiting: [],
} as unknown as PlanFileView;

// 11 commits in the last hours; the OLDEST names s2bbbb. The server's recent list carries steps (detailed format);
// the news list does not (repoNews is called without `detailed`, so its format has no body).
const at = (i: number) => new Date(Date.UTC(2026, 10, 27, 12, 0, 0) - i * 60_000).toISOString();
const sha = (i: number) => `${(0xa000000 + i).toString(16)}${'0'.repeat(33)}`;
const commit = (i: number, withSteps: boolean): NewsCommit => ({ sha: sha(i).slice(0, 7), author: 'A', subject: `c${i}`, at: at(i), ...(withSteps && i === 10 ? { steps: ['s2bbbb'] } : {}) });

describe('a trailer commit the Board draws from the news list, not the recent list', () => {
  it('is placed in the Area of its step: the news carries steps like the recent list does', () => {
    const list = (withSteps: boolean) => Array.from({ length: 11 }, (_, i) => commit(i, withSteps));
    const recent: RecentCommits = { at: at(0), from: at(5000), commits: [{ repo: 'r', more: 0, commits: list(true) }] } as RecentCommits;
    const news = { basis: 'since', from: at(5000), at: at(0), empty: false, commits: [{ repo: 'r', more: 0, commits: list(true) }] } as unknown as WhatsNewView;
    const merged = boardNews(news, recent)!;
    expect(merged.commits[0]!.commits.find((c) => c.subject === 'c10')!.steps).toEqual(['s2bbbb']);
    const areas = buildBoardAreas({ plan, news: merged, focusNow: Date.parse(at(0)) });
    expect(areas.find((a) => a.id === 'checkpoint:c2bbbb')!.data.commitCount).toBe(1);
    expect(areas.find((a) => a.id === 'checkpoint:c1aaaa')!.data.commitCount).toBe(10);
  });
});
