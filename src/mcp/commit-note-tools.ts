import { z } from 'zod';

import { BOARD_LIMITS, BoardWorkspaceError, boardFields } from '../core/board.js';
import { addCommitNote, listCommitNotes } from '../core/commit-notes.js';
import { findWorkspaceRoot, loadFeatureConfig } from '../core/workspace.js';
import type { NexusFlowTool } from './tools.js';

const HARNESS_PROP = {
  type: 'string',
  maxLength: 40,
  description: 'Which AI tool made the note, such as claude or codex (defaults to ai).',
} as const;

const WORKSPACE_ID_PROP = {
  type: 'string',
  description:
    'Optional ID/branchName of the workspace. Defaults to the workspace this server is bound to (or the current directory). Interactive and full sessions may name another workspace; other roles get an error for a different workspace.',
} as const;

function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return error.message;
  const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${where}${issue.message}`;
}

interface CommitNoteToolContext {
  root: string;
  cwd: string;
}

function commitNoteTool<T extends z.ZodObject>(
  name: string,
  description: string,
  schema: T,
  readOnlyHint: boolean,
  action: (input: z.output<T>, context: CommitNoteToolContext, harness?: string) => Promise<unknown>,
): NexusFlowTool {
  const rawJsonSchema = z.toJSONSchema(schema, { io: 'input' }) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    name,
    description,
    annotations: {
      readOnlyHint,
      destructiveHint: false,
      idempotentHint: readOnlyHint,
      openWorldHint: false,
    },
    inputSchema: {
      ...rawJsonSchema,
      type: 'object',
      additionalProperties: false,
      properties: {
        ...(rawJsonSchema.properties ?? {}),
        harness: HARNESS_PROP,
        workspaceId: WORKSPACE_ID_PROP,
      },
    },
    handler: async (args, ctx) => {
      try {
        const { workspaceId: _workspaceId, harness: rawHarness, ...rest } = args ?? {};
        z.string().optional().parse(_workspaceId);
        const harness = z.string().max(40).optional().parse(rawHarness);
        const validated = schema.strict().parse(rest) as z.output<T>;
        if (!(await loadFeatureConfig(ctx.workspacePath))) throw new BoardWorkspaceError();
        // This server can be started below the workspace root; the board and manifest live at the root.
        const root = (await findWorkspaceRoot(ctx.workspacePath)) ?? ctx.workspacePath;
        const result = await action(validated, { root, cwd: ctx.workspacePath }, harness);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof z.ZodError
          ? describeZodError(error)
          : error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    },
  };
}

const noteOnCommitSchema = z.object({
  commit: z.string().trim().min(1).max(256).describe('Commit hash (7 or more hex chars) or reference such as HEAD, HEAD~1, or origin/branch.'),
  text: z.string().min(1).max(BOARD_LIMITS.body).describe('The note text. Keep it specific: what happened and what to check.'),
  repo: z.string().trim().min(1).max(200).optional().describe('Repository name when the commit reference matches more than one repository.'),
  title: boardFields.title.optional().describe('Optional title; defaults to the first non-empty line of text cut to 200 characters.'),
});

const notesOnCommitSchema = z.object({
  commit: z.string().trim().min(1).max(256).optional().describe('Commit hash (>=7 chars) or git reference to filter by. Leave out to list all commit notes in the workspace.'),
  repo: z.string().trim().min(1).max(200).optional().describe('Repository name to filter or disambiguate.'),
});

export const commitNoteTools: NexusFlowTool[] = [
  commitNoteTool(
    'note_on_commit',
    'Leave an AI note on a commit (full or >=7-char hash, HEAD, HEAD~1, or remote-tracking ref such as origin/...). Use this after a merge, pull, or rebase that needed decisions or went wrong, or when you notice something important in a commit. Commit notes stay attached to the commit for Review and What\'s new rather than cluttering board Areas.',
    noteOnCommitSchema,
    false,
    async (input, { root, cwd }, harness) =>
      addCommitNote(root, {
        commit: input.commit,
        text: input.text,
        repo: input.repo,
        title: input.title,
        by: harness,
        cwd,
      }),
  ),
  commitNoteTool(
    'notes_on_commit',
    'List AI commit notes for a specific commit or across the entire workspace, newest first (hash, repository, author, timestamp, title, and body). Notes stay readable even if the commit was later rebased away.',
    notesOnCommitSchema,
    true,
    async (input, { root, cwd }) => ({
      notes: await listCommitNotes(root, {
        commit: input.commit,
        repo: input.repo,
        cwd,
      }),
    }),
  ),
];
