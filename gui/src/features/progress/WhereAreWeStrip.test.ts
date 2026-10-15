import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { MilestoneFact, ProgressFacts, ScreenEvent, WorkGuidance } from '../../types';
import { ProgressPanel, ReopenForm, type ProgressPanelProps } from './ProgressPanel';
import { activeProposals, nextAction } from './progressView';
import { WhereAreWeBar, type WhereAreWeBarProps } from './WhereAreWeStrip';

const milestone = (id: string, state: MilestoneFact['state'], extra: Partial<MilestoneFact> = {}): MilestoneFact =>
  ({ id, title: `Title ${id}`, state, verified: false, reopenCount: 0, waitingOn: [], ...extra });

function facts(milestones: MilestoneFact[], extra: Partial<ProgressFacts> = {}): ProgressFacts {
  const count = (state: MilestoneFact['state']) => milestones.filter((m) => m.state === state).length;
  return {
    workspaceId: 'demo', generatedAt: '2026-10-02T12:00:00.000Z', milestones,
    counts: { total: milestones.length, done: count('done'), inProgress: count('in_progress'), reopened: count('reopened'), blocked: count('blocked'), upcoming: count('upcoming') },
    openQuestions: [], changes: { repos: [], files: 0, additions: 0, deletions: 0 },
    verification: { status: 'never', freshness: 'unknown' }, unavailable: [], ...extra,
  };
}

const guidance: WorkGuidance = {
  version: 1, revision: 0, workType: 'feature', size: 'standard', documents: [],
  assignment: { stage: 'implement', objective: 'Make invoices load fast', expectedOutput: 'A cache', stopCondition: 'Under one second' },
};

const noop = () => undefined;
const panel = (f: ProgressFacts, extra: Partial<ProgressPanelProps> = {}) => renderToStaticMarkup(createElement(ProgressPanel, {
  id: 'p', facts: f, guidance, proposals: [], acknowledging: false, now: Date.parse('2026-10-02T12:00:00.000Z'),
  onReopen: async () => null, onDismissProposal: noop, onFill: noop, onOpenFile: noop, onAcknowledge: noop, ...extra,
}));
const bar = (f: ProgressFacts, extra: Partial<WhereAreWeBarProps> = {}) => renderToStaticMarkup(createElement(WhereAreWeBar, {
  facts: f, guidance, action: null, expanded: false, panelId: 'panel-1', notice: '', onToggle: noop, onNext: noop, ...extra,
}));
const count = (html: string, needle: string) => html.split(needle).length - 1;

const proposalEvent = (stepId: string, proposal: 'reopen' | 'complete', reason: string): ScreenEvent =>
  ({ id: `p-${stepId}`, timestamp: '2026-10-02T10:00:00.000Z', harness: 'claude', event: 'milestone_proposal', payload: { stepId, proposal, reason } });

describe('WhereAreWeBar', () => {
  const plan = [milestone('a', 'done'), milestone('b', 'in_progress')];

  it('shows what is worked on now, the state and the checkable facts in one button that opens the panel, with the goal in its tooltip', () => {
    const html = bar(facts(plan, { currentMilestoneId: 'b', openQuestions: [{ id: 'q', timestamp: 't', harness: 'c', message: 'm' }], changes: { repos: [], files: 3, additions: 1, deletions: 1 } }));
    expect(html).toContain('Now · </span>Title b');
    expect(html).toContain('title="Make invoices load fast · 1 of 2 done · 1 question · 3 files changed"');
    expect(html).toContain('data-tone="needs"');
    expect(html).toContain('Needs you');
    expect(html).toContain('1 of 2 done');
    expect(html).toContain('1 question');
    expect(html).toContain('3 files changed');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="panel-1"');
  });

  it('keeps the ring out of the accessible name and draws the milestones in it', () => {
    const html = bar(facts(plan, { currentMilestoneId: 'b' }));
    expect(html).toContain('aria-hidden="true"');
    expect(count(html, 'data-kind='), html).toBe(2);
    expect(html).toContain('class="ring-sun"');
  });

  it('says so when no goal is set, and falls back to the current milestone', () => {
    expect(bar(facts([]), { guidance: undefined })).toContain('No goal set yet');
    expect(bar(facts(plan, { currentMilestoneId: 'b' }), { guidance: undefined })).toContain('Title b');
  });

  it('shows a Next button only when there is something to do, named with its reason', () => {
    expect(bar(facts([milestone('a', 'done')]))).not.toContain('Next:');
    const action = nextAction(facts(plan, { currentMilestoneId: 'b' }));
    const html = bar(facts(plan), { action });
    expect(html).toContain('Continue &quot;Title b&quot;');
    expect(html).toContain('aria-label="Next: Continue &quot;Title b&quot;. It is in progress."');
  });

  it('keeps a live region for notices, which are shown above the chat', () => {
    expect(bar(facts(plan))).toContain('<span role="status" class="sr-only"></span>');
    expect(bar(facts(plan), { notice: 'Added to the chat prompt. Press Enter to send it.' })).toContain('<span role="status" class="sr-only">Added to the chat prompt. Press Enter to send it.</span>');
  });

  it('says it needs you when a question in the plan waits, even when the chat asks nothing', () => {
    expect(bar(facts(plan, { currentMilestoneId: 'b' }), { planQuestions: 1 })).toContain('data-tone="needs">Needs you');
  });

  it('turns the chevron when open', () => {
    expect(bar(facts(plan), { expanded: true })).toContain('aria-expanded="true"');
  });

  it('shows the AI\'s words as text, never as markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = bar(facts([milestone('a', 'in_progress', { title: hostile })], { currentMilestoneId: 'a' }), { guidance: undefined });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('ProgressPanel', () => {
  it('offers Reopen only for finished milestones', () => {
    const html = panel(facts([milestone('a', 'done'), milestone('b', 'in_progress'), milestone('c', 'upcoming'), milestone('d', 'blocked'), milestone('e', 'reopened')]));
    // One quiet icon button, named for what it reopens, on the finished milestone only.
    expect(count(html, 'aria-label="Reopen &quot;')).toBe(1);
    expect(html).toContain('aria-label="Reopen &quot;Title a&quot;"');
    expect(html).not.toContain('>Reopen</button>');
  });

  it('writes every state as a word, so colour is never the only signal', () => {
    const html = panel(facts([milestone('a', 'done'), milestone('b', 'in_progress'), milestone('c', 'upcoming'), milestone('d', 'blocked', { blockedReason: 'needs a key' }), milestone('e', 'reopened')]));
    for (const word of ['Done', 'In progress', 'Not started', 'Blocked', 'Reopened']) expect(html).toContain(`>${word}</span>`);
    expect(html).toContain('needs a key');
  });

  it('says who reopened a milestone and why', () => {
    const html = panel(facts([milestone('a', 'reopened', { reopen: { at: '2026-10-02T09:00:00.000Z', reason: 'misses a case', by: 'agent' } })]));
    expect(html).toContain('Reopened by the AI 3 h ago: misses a case');
    expect(panel(facts([milestone('a', 'reopened', { reopen: { at: '2026-10-02T09:00:00.000Z', reason: 'x', by: 'user' } })]))).toContain('Reopened by you 3 h ago: x');
    expect(panel(facts([milestone('a', 'done', { reopenCount: 2 })]))).toContain('Reopened 2 times before');
    expect(panel(facts([milestone('a', 'done', { reopenCount: 1 })]))).toContain('Reopened once before');
  });

  it('names what an upcoming milestone is waiting on', () => {
    const html = panel(facts([milestone('a', 'in_progress'), milestone('b', 'upcoming', { waitingOn: ['a'] })]));
    expect(html).toContain('Waiting on &quot;Title a&quot;');
  });

  it('shows the goal fields, and Not set for an empty one', () => {
    const html = panel(facts([]), { guidance: { ...guidance, assignment: { ...guidance.assignment, expectedOutput: '' } } });
    expect(html).toContain('Make invoices load fast');
    expect(html).toContain('Under one second');
    expect(html).toContain('Not set');
    expect(panel(facts([]), { guidance: undefined })).toContain('The goal has not loaded.');
  });

  it('labels the AI\'s questions as its own, offers its options and a way to say they were answered', () => {
    const html = panel(facts([], { openQuestions: [{ id: 'q', timestamp: '2026-10-02T11:00:00.000Z', harness: 'claude', message: 'Which cache?', options: ['Redis', 'In memory'] }] }));
    expect(html).toContain('The AI asked 1 h ago:');
    expect(html).toContain('Which cache?');
    expect(html).toContain('>Redis</button>');
    expect(html).toContain('>In memory</button>');
    expect(html).toContain('Adds this to the chat prompt. You press Enter.');
    // Said once, as an icon at the heading's edge, not as a block under the list.
    expect(html).toContain('aria-label="I answered in the chat"');
    expect(count(html, 'I answered in the chat')).toBe(1);
    expect(html).not.toContain('Nothing is waiting on you.');
  });

  it('says nothing is waiting when nothing is, and offers no answered button', () => {
    const html = panel(facts([milestone('a', 'done')]));
    expect(html).toContain('Nothing is waiting on you.');
    expect(html).not.toContain('I answered in the chat');
  });

  it('shows the AI\'s text escaped, in questions, proposals and notes', () => {
    const hostile = '<script>alert(1)</script>';
    const f = facts([milestone('a', 'done')], { openQuestions: [{ id: 'q', timestamp: 't', harness: 'c', message: hostile, options: [hostile] }] });
    const html = panel(f, { proposals: activeProposals([proposalEvent('a', 'reopen', hostile)], f) });
    expect(html).not.toContain('<script>');
    expect(count(html, '&lt;script&gt;')).toBeGreaterThanOrEqual(3);
  });

  it('shows a reopen proposal with its reason and buttons the developer decides with', () => {
    const f = facts([milestone('a', 'done')]);
    const html = panel(f, { proposals: activeProposals([proposalEvent('a', 'reopen', 'The edge case is not covered')], f) });
    expect(html).toContain('The AI suggests reopening this');
    expect(html).toContain('The edge case is not covered');
    // The two things to do about it are icons, named for the action, beside the AI's words.
    expect(html).toContain('aria-label="Reopen with this reason"');
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).not.toContain('>Dismiss</button>');
    expect(html).not.toContain('>Reopen with this reason</button>');
  });

  it('shows a completion proposal with a way to ask for proof, and no way to complete it', () => {
    const f = facts([milestone('b', 'in_progress')]);
    const html = panel(f, { proposals: activeProposals([proposalEvent('b', 'complete', 'All tests pass')], f) });
    expect(html).toContain('The AI thinks this is done');
    expect(html).toContain('aria-label="Ask for proof"');
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).not.toMatch(/>Complete/);
  });

  it('reports a failing check and a stale pass in words', () => {
    expect(panel(facts([], { verification: { status: 'fail', freshness: 'fresh', verifiedAt: '2026-10-02T09:00:00.000Z' } }))).toContain('The last check failed 3 h ago.');
    expect(panel(facts([], { verification: { status: 'pass', freshness: 'stale', verifiedAt: '2026-10-02T09:00:00.000Z' } }))).toContain('the code has changed since');
  });

  it('lists touched files that open on click, capped, with a count of the rest', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ file: `src/f${i}.ts`, type: 'modified', additions: i, deletions: 1 }));
    const html = panel(
      facts([], { changes: { repos: [{ repoName: 'api', files: 30, additions: 435, deletions: 30 }], files: 30, additions: 435, deletions: 30 } }),
      { changes: [{ repoName: 'api', repoPath: '/dev/api', files: many }] },
    );
    expect(html).toContain('30 files, +435 −30');
    expect(count(html, 'title="api/src/f')).toBe(25);
    expect(html).toContain('and 5 more');
    expect(html).toContain('+3 −1');
  });

  it('says when there are no changes, when the files are loading, and when a repository could not be read', () => {
    expect(panel(facts([]))).toContain('No changes yet.');
    const counted = facts([], { changes: { repos: [{ repoName: 'api', files: 2, additions: 1, deletions: 0 }], files: 2, additions: 1, deletions: 0 } });
    expect(panel(counted)).toContain('Loading files...');
    expect(panel(counted, { changesError: 'Could not list the changed files.' })).toContain('Could not list the changed files.');
    const unreadable = facts([], { changes: { repos: [{ repoName: 'api', files: 0, additions: 0, deletions: 0, unavailable: true }], files: 0, additions: 0, deletions: 0 } });
    expect(panel(unreadable)).toContain('Could not read the changes in api.');
  });

  it('does not claim "No changes yet" when the changes could not be read', () => {
    const html = panel(facts([], { unavailable: [{ source: 'changes', reason: 'git failed' }] }));
    expect(html).not.toContain('No changes yet.');
    expect(html).toContain('Could not read: changes (git failed)');
    expect(html).toContain('left out, not counted as zero');
  });

  it('says so when there is no plan', () => {
    expect(panel(facts([]))).toContain('No milestones are planned yet.');
  });
});

describe('ReopenForm', () => {
  const form = (extra: Partial<Parameters<typeof ReopenForm>[0]> = {}) => renderToStaticMarkup(createElement(ReopenForm, {
    id: 'r', title: 'Cache', reason: '', pending: false, onChange: noop, onSubmit: noop, onCancel: noop, ...extra,
  }));

  it('asks for a reason in a labelled field with the backend\'s length limit', () => {
    const html = form();
    expect(html).toContain('<label for="r"');
    expect(html).toContain('Why does \u201cCache\u201d need rework?');
    expect(html).toContain('maxLength="500"');
    expect(html).toContain('required');
  });

  it('will not submit without a reason, or while sending', () => {
    expect(form()).toMatch(/<button type="submit"[^>]* disabled=""/);
    expect(form({ reason: '   ' })).toMatch(/<button type="submit"[^>]* disabled=""/);
    expect(form({ reason: 'Missing a case' })).not.toMatch(/<button type="submit"[^>]* disabled=""/);
    expect(form({ reason: 'Missing a case', pending: true })).toMatch(/<button type="submit"[^>]* disabled=""/);
    expect(form({ reason: 'x', pending: true })).toContain('Reopening...');
  });

  it('shows a failure as an alert', () => {
    expect(form({ error: 'That step is not finished.' })).toContain('role="alert"');
  });
});
