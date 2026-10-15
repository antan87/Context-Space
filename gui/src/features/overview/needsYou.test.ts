import { describe, expect, it } from 'vitest';
import { aiClosedLately, needItems, type WorkspaceNeeds } from './needsYou.js';

const empty = (workspaceId: string, fields: Partial<WorkspaceNeeds> = {}): WorkspaceNeeds => ({ workspaceId, questions: [], proposals: [], failedChecks: [], closedByAi: [], ...fields });

describe('what the Overview lists', () => {
  it('groups what waits by workspace, the one that waited longest first, the AI waiting in the chat leading', () => {
    const groups = needItems([
      empty('quiet'),
      empty('reader', { questions: [{ id: 'Q9', title: 'Where does Review go?', holdsUp: ['Reader'], askedBy: 'claude', at: '2026-10-15T09:00:00.000Z' }] }),
      empty('redo-gui', {
        chatQuestion: { message: 'Which palette?', timestamp: '2026-10-15T10:00:00.000Z', harness: 'codex' },
        questions: [{ id: 'Q10', title: 'Fold the bars?', holdsUp: [], at: '2026-10-01T09:00:00.000Z' }],
        failedChecks: [{ id: 'M2', title: 'Chat docked' }],
      }),
    ]);
    expect(groups.map((group) => group.workspaceId)).toEqual(['redo-gui', 'reader']);
    expect(groups[0]!.items.map((item) => `${item.kind}:${item.text}`)).toEqual(['chat:Which palette?', 'question:Fold the bars?', 'check:Chat docked']);
  });

  it('lists what the AI closed lately across workspaces, newest first', () => {
    const closed = aiClosedLately([
      empty('a', { closedByAi: [{ id: 'M1', title: 'One', action: 'done', by: 'claude', at: '2026-10-14T10:00:00.000Z' }] }),
      empty('b', { closedByAi: [{ id: 'M2', title: 'Two', action: 'dropped', by: 'codex', at: '2026-10-15T10:00:00.000Z', note: 'Not needed' }] }),
    ]);
    expect(closed.map((entry) => `${entry.workspaceId}:${entry.id}`)).toEqual(['b:M2', 'a:M1']);
  });
});
