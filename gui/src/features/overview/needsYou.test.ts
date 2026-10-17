import { describe, expect, it } from 'vitest';
import { aiClosedLately, needItems, type WorkspaceNeeds } from './needsYou.js';

const empty = (workspaceId: string, fields: Partial<WorkspaceNeeds> = {}): WorkspaceNeeds => ({ workspaceId, questions: [], proposals: [], failedChecks: [], closedByAi: [], ...fields });

describe('what the Overview lists', () => {
  it('groups what waits by workspace, the one that waited longest first, the AI waiting in the chat leading', () => {
    const { groups, aside } = needItems([
      empty('quiet'),
      empty('reader', { questions: [{ id: 'Q9', title: 'Where does Review go?', holdsUp: ['Reader'], detail: 'Suggested answers: Sidebar · Rail', askedBy: 'claude', at: '2026-10-15T09:00:00.000Z' }] }),
      empty('redo-gui', {
        chatQuestion: { message: 'Which palette?', timestamp: '2026-10-15T10:00:00.000Z', harness: 'codex' },
        questions: [{ id: 'Q10', title: 'Fold the bars?', holdsUp: ['Bars'], at: '2026-10-01T09:00:00.000Z' }],
        failedChecks: [{ id: 'M2', title: 'Chat docked' }],
      }),
    ]);
    expect(groups.map((group) => group.workspaceId)).toEqual(['redo-gui', 'reader']);
    expect(groups[0]!.items.map((item) => `${item.kind}:${item.text}`)).toEqual(['chat:Which palette?', 'question:Fold the bars?', 'check:Chat docked']);
    expect(groups[1]!.items[0]).toMatchObject({ kind: 'question', detail: 'Suggested answers: Sidebar · Rail' });
    expect(aside).toEqual([]);
  });

  it('puts the questions nothing waits for aside, oldest first, and does not count a workspace for them', () => {
    const { groups, aside } = needItems([
      empty('reader', { questions: [
        { id: 'Q4', title: 'Keep Workrooms?', holdsUp: [], at: '2026-10-12T09:00:00.000Z' },
        { id: 'Q5', title: 'Which branch?', holdsUp: [], at: '2026-10-16T09:00:00.000Z', waiting: true },
      ] }),
      empty('redo-gui', {
        questions: [{ id: 'Q2', title: 'Dark first?', holdsUp: [], at: '2026-10-02T09:00:00.000Z' }],
        failedChecks: [{ id: 'M2', title: 'Chat docked' }],
      }),
    ]);
    // The AI that asked in the chat waits for its answer, so that one counts.
    expect(groups.map((group) => `${group.workspaceId}:${group.items.map((item) => ('id' in item ? item.id : item.kind)).join(',')}`)).toEqual(['reader:Q5', 'redo-gui:M2']);
    expect(aside.map((item) => `${item.workspaceId}:${item.id}`)).toEqual(['redo-gui:Q2', 'reader:Q4']);
  });

  it('lists what the AI closed lately across workspaces, newest first', () => {
    const closed = aiClosedLately([
      empty('a', { closedByAi: [{ id: 'M1', title: 'One', action: 'done', by: 'claude', at: '2026-10-14T10:00:00.000Z' }] }),
      empty('b', { closedByAi: [{ id: 'M2', title: 'Two', action: 'dropped', by: 'codex', at: '2026-10-15T10:00:00.000Z', note: 'Not needed' }] }),
    ]);
    expect(closed.map((entry) => `${entry.workspaceId}:${entry.id}`)).toEqual(['b:M2', 'a:M1']);
  });
});
