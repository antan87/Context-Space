/**
 * @module http/board-routes
 * The workspace board for the app: read it, and change it with a list of small operations (add, update or remove a
 * card, move, link, unlink) that are applied all or none. The app changes the board as `user`; an AI changes it through
 * the MCP tools. The rules, limits and the file itself are core/board.
 */

import type { Hono, Context, Handler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { ArchivedWorkspaceError } from '../core/archive-guard.js';
import { BoardChangeError, BoardConflictError, BoardInputError, BoardWorkspaceError, changeBoard, readBoard } from '../core/board.js';
import { boardDbForApp, boardRequestId, changeBoardDb } from '../core/board-db-app.js';
import { PlanDbChangeError } from '../core/plan-db-app.js';
import { storeOf } from '../core/workspace-db-app.js';
import { planErrorAnswer } from './plan-file-routes.js';
import { WorkspaceMovedError } from '../core/workspace-db-switch.js';
import { WorkspaceDbError } from '../core/workspace-db/index.js';

/** A request is at most this many changes of a few thousand characters each. */
const BODY_LIMIT = 1_000_000;

const request = z.object({
  revision: z.number().int().nonnegative().optional(),
  /** The database the board was read from (a workspace moved to its database): a replaced one refuses the change. */
  dbId: z.string().min(1).max(64).optional(),
  requestId: boardRequestId.optional(),
  // Each change is checked by the board, which says which change and field is wrong.
  changes: z.array(z.unknown()).min(1, 'Give at least one change.'),
}).strict();

function statusOf(error: unknown): 400 | 404 | 409 | 500 {
  // The request: not a valid change, or one this board cannot take.
  if (error instanceof BoardInputError || error instanceof BoardChangeError) return 400;
  if (error instanceof BoardWorkspaceError) return 404;
  if (error instanceof BoardConflictError || error instanceof ArchivedWorkspaceError) return 409;
  // The stored board is not usable, or something failed that the request did not cause (a write, the lock, the disk).
  return 500;
}

/** Mounted behind the server's existing local-origin boundary. */
export function registerBoardRoutes(app: Hono, resolveWorkspace: (id: string) => Promise<string | null>) {
  const handle = (action: (workspacePath: string, c: Context) => Promise<object>): Handler => async (c) => {
    try {
      const root = await resolveWorkspace(z.string().min(1).parse(c.req.param('id')));
      if (!root) return c.json({ error: 'Workspace not found.' }, 404);
      return c.json(await action(root, c));
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issue = error.issues[0];
        return c.json({ error: issue ? `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` : 'Invalid request.' }, 400);
      }
      if (error instanceof PlanDbChangeError || error instanceof WorkspaceDbError || error instanceof WorkspaceMovedError) {
        const answer = planErrorAnswer(error);
        return c.json(answer.body, answer.status as 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, statusOf(error));
    }
  };

  // A workspace moved to its database reads and writes the board there; any other reads and writes the board file.
  app.get('/api/workspace/:id/board', handle((root) => (storeOf(root) === 'database' ? boardDbForApp(root) : readBoard(root))));

  app.post('/api/workspace/:id/board/changes',
    bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'That request is too large. Send fewer changes at once.' }, 413) }),
    handle(async (root, c) => {
      let body: unknown;
      try { body = await c.req.json(); } catch { throw new BoardInputError('The request must be JSON.'); }
      const input = request.parse(body);
      if (storeOf(root) === 'database') {
        const { board, results, requestId } = await changeBoardDb(root, input.changes, { by: 'user', revision: input.revision, dbId: input.dbId, requestId: input.requestId });
        return { ...board, results, ...(results.some((result) => result.op === 'add_card') ? { requestId } : {}) };
      }
      if (input.dbId !== undefined || input.requestId !== undefined) {
        throw new PlanDbChangeError('This workspace uses the Board file. Read the board again before changing it.', 409, 'db_changed');
      }
      const { board, results } = await changeBoard(root, input.changes, { by: 'user', revision: input.revision });
      return { ...board, results };
    }));
}
