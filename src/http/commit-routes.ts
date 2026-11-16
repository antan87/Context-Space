/**
 * @module http/commit-routes
 * Commit detail endpoint: returns full details for a single commit within a workspace repo.
 */

import type { Hono, Context, Handler } from 'hono';
import { z } from 'zod';
import {
  CommitInputError,
  CommitNotFoundError,
  CommitTooLargeError,
  RepoNotFoundError,
  readCommit,
  readCommitFileDiff,
} from '../core/commit-detail.js';

const workspaceId = z.string().trim().min(1, 'Workspace id is required.');
const repoName = z.string().trim().min(1, 'Repository name is required.');
// A short hex equal to a branch/tag name resolves to that ref first,
// which is acceptable because the full SHA is returned.
const commitSha = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{7,64}$/, 'Commit SHA must be a 7 to 64 character hexadecimal string.');

function statusOf(error: unknown): 400 | 404 | 413 | 500 {
  if (error instanceof CommitInputError || error instanceof z.ZodError) return 400;
  if (error instanceof RepoNotFoundError || error instanceof CommitNotFoundError) return 404;
  if (error instanceof CommitTooLargeError) return 413;
  return 500;
}

/** Mounted behind the server's existing local-origin boundary. */
export function registerCommitRoutes(app: Hono, resolveWorkspace: (id: string) => Promise<string | null>) {
  const handle = (action: (workspacePath: string, c: Context) => Promise<object>): Handler => async (c) => {
    try {
      const id = workspaceId.parse(c.req.param('id'));
      const root = await resolveWorkspace(id);
      if (!root) return c.json({ error: 'Workspace not found.' }, 404);
      return c.json(await action(root, c));
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issue = error.issues[0];
        return c.json(
          { error: issue ? `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` : 'Invalid request.' },
          400,
        );
      }
      if (
        error instanceof CommitInputError ||
        error instanceof RepoNotFoundError ||
        error instanceof CommitNotFoundError ||
        error instanceof CommitTooLargeError
      ) {
        return c.json({ error: error.message }, statusOf(error));
      }
      return c.json({ error: 'Could not read this commit.' }, 500);
    }
  };

  app.get(
    '/api/workspace/:id/commits/:repo/:sha/diff',
    handle(async (root, c) => {
      const repo = repoName.parse(c.req.param('repo'));
      const sha = commitSha.parse(c.req.param('sha'));
      const file = c.req.query('file') ?? '';
      if (!file) {
        throw new CommitInputError('File query parameter is required.');
      }
      return readCommitFileDiff(root, repo, sha, file);
    }),
  );

  app.get(
    '/api/workspace/:id/commits/:repo/:sha',
    handle(async (root, c) => {
      const repo = repoName.parse(c.req.param('repo'));
      const sha = commitSha.parse(c.req.param('sha'));
      return readCommit(root, repo, sha);
    }),
  );
}
