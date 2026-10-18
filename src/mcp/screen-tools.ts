/**
 * @module mcp/screen-tools
 * Tools that let the AI drive the screen: open a document or diff beside the
 * chat, leave a note on a line, suggest the next move, and ask what the user is
 * looking at. They only show things: none edits a file, and none presses a key
 * for the user. Where the plan stands is PLAN.md, which the AI edits itself.
 */

import * as fs from 'node:fs/promises';
import { z } from 'zod';

import { readScreenContext } from '../core/screen-context.js';
import {
  SCREEN_NOTE_LIMIT, SCREEN_REASON_LIMIT, SCREEN_TEXT_LIMIT, SCREEN_TITLE_LIMIT,
  appendScreenEvent,
} from '../core/screen-events.js';
import { resolveScreenRepo, resolveScreenTarget, SCREEN_PATH_MAX_LENGTH } from '../core/screen-paths.js';
import { findWorkspaceRoot, loadFeatureConfig } from '../core/workspace.js';
import type { NexusFlowTool } from './tools.js';

const harness = z.string().max(40).optional().describe('Optional name of the assistant calling this, for example "claude" or "codex".');
const repo = z.string().max(200).optional().describe('Name of one of the workspace repositories. Only needed when the path is relative to that repository and could be ambiguous.');
const line = z.number().int().min(1).max(10_000_000);

interface ScreenToolContext { root: string; workspacePath: string }

function friendly(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return issue ? `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` : 'The input is not valid.';
  }
  return error instanceof Error ? error.message : String(error);
}

function screenTool<T extends z.ZodObject>(
  name: string,
  description: string,
  schema: T,
  action: (input: z.output<T>, ctx: ScreenToolContext) => Promise<unknown>,
  readOnly = false,
): NexusFlowTool {
  const inputSchema = z.toJSONSchema(schema, { io: 'input' });
  return {
    name,
    description,
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: !readOnly ? false : true, openWorldHint: false },
    inputSchema: {
      ...inputSchema,
      additionalProperties: false,
      properties: {
        ...inputSchema.properties,
        workspaceId: { type: 'string', description: 'Optional ID/branchName of the workspace. Defaults to the workspace this server is bound to (or the current directory). Interactive and full sessions may name another workspace; other roles get an error for a different workspace.' },
      },
    },
    handler: async (args, ctx) => {
      try {
        const { workspaceId: _workspaceId, ...input } = args;
        z.string().optional().parse(_workspaceId);
        const validated = schema.strict().parse(input) as z.output<T>;
        if (!(await loadFeatureConfig(ctx.workspacePath))) throw new Error('Workspace not found.');
        // This server can be started below the workspace root; the ledgers live at the root.
        const root = (await findWorkspaceRoot(ctx.workspacePath)) ?? ctx.workspacePath;
        const result = await action(validated, { root, workspacePath: ctx.workspacePath });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: friendly(error) }] };
      }
    },
  };
}

const DOCUMENT_EXTENSIONS = /\.(md|markdown|txt|html?|pdf|csv|json)$/i;

/** Counts lines in a text file small enough to read, or returns undefined when that is not worth doing. */
async function lineCount(absolute: string): Promise<number | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    // One open file for the check and the read, so they cannot be two different files.
    handle = await fs.open(absolute, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return undefined;
    const content = await handle.readFile('utf8');
    if (content.includes('\u0000')) return undefined;
    return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

const SHOWN = 'It is shown to the user beside their chat. This only opens it: they decide whether to look, so keep going and say in the chat what to look at.';

const showSchema = z.object({
  path: z.string().max(SCREEN_PATH_MAX_LENGTH).optional().describe('A file or document inside the workspace, relative to the workspace folder or to a repository, or an absolute path inside either. Required unless you are showing every change in a repository.'),
  repo,
  view: z.enum(['document', 'file', 'diff']).optional().describe('document for something to read, file for code, diff for changes. Chosen from the path when left out.'),
  line: line.optional().describe('First line to bring into view and highlight.'),
  endLine: line.optional().describe('Last line of a highlighted range. Not before line.'),
  note: z.string().max(SCREEN_NOTE_LIMIT).optional().describe('One short sentence on why you are showing it.'),
  harness,
});

const annotateSchema = z.object({
  path: z.string().min(1).max(SCREEN_PATH_MAX_LENGTH).describe('The file or document the note is about.'),
  repo,
  line: line.describe('The line the note is attached to.'),
  text: z.string().min(1).max(SCREEN_TEXT_LIMIT).describe('The note itself, in a few sentences at most.'),
  tag: z.enum(['question', 'risk', 'todo']).optional().describe('question for something you need decided (the default), risk for a concern, todo for something left to do.'),
  harness,
});

const nextSchema = z.object({
  title: z.string().min(1).max(SCREEN_TITLE_LIMIT).describe('The next move, as a short imperative: "Answer two questions in the plan".'),
  reason: z.string().min(1).max(SCREEN_REASON_LIMIT).describe('Why this is the next move, in a sentence or two.'),
  path: z.string().max(SCREEN_PATH_MAX_LENGTH).optional().describe('A file the move starts from, opened when the user takes it.'),
  repo,
  line: line.optional(),
  harness,
});

const contextSchema = z.object({ harness });

export const screenTools: NexusFlowTool[] = [
  screenTool(
    'show_in_reader',
    `Open a document, a file at a line, or a diff in the reader beside the user's chat. Use it when you want the user to read something you wrote or changed instead of pasting it into the chat. It only shows the thing: nothing is edited, and the user decides whether to look. The file must exist inside the workspace. Showing the same thing twice within a minute is ignored. Still say in the chat what to look at.`,
    showSchema,
    async (input, { root, workspacePath }) => {
      let target: { path?: string; repo?: string } = {};
      let view = input.view;
      if (input.path !== undefined) {
        const resolved = await resolveScreenTarget(workspacePath, { path: input.path, repo: input.repo });
        view ??= resolved.repo ? 'file' : DOCUMENT_EXTENSIONS.test(resolved.path) ? 'document' : 'file';
        if (resolved.isDirectory && view !== 'diff') throw new Error(`"${input.path}" is a folder. Name a file, or use view "diff" with the repository.`);
        target = { path: resolved.path, repo: resolved.repo };
      } else {
        if (view !== undefined && view !== 'diff') throw new Error('Give a path, or use view "diff" with a repository to show every change.');
        if (!input.repo) throw new Error('Give a path, or a repository to show its changes.');
        const found = await resolveScreenRepo(workspacePath, input.repo);
        view = 'diff';
        target = { repo: found.name };
      }
      if (input.endLine !== undefined && (input.line === undefined || input.endLine < input.line)) {
        throw new Error('endLine needs a line, and cannot come before it.');
      }
      const { status, event } = await appendScreenEvent(root, {
        harness: input.harness,
        event: 'show',
        payload: { view: view!, ...target, line: input.line, endLine: input.endLine, note: input.note },
      });
      return { status, view, ...target, ...(input.line ? { line: input.line } : {}), message: status === 'shown' ? SHOWN : 'The user was already shown this a moment ago.', eventId: event.id };
    },
  ),

  screenTool(
    'annotate_document',
    `Leave a note on one line of a file or document. The file opens at that line beside the user's chat, and the note is kept with it, labelled as yours; margin notes are not drawn yet, so also say the note in the chat. Use tag question for something you need decided, risk for a concern, todo for something left to do. It never changes the file. The file and line must exist.`,
    annotateSchema,
    async (input, { root, workspacePath }) => {
      const resolved = await resolveScreenTarget(workspacePath, { path: input.path, repo: input.repo });
      if (resolved.isDirectory) throw new Error(`"${input.path}" is a folder. Name a file.`);
      const lines = await lineCount(resolved.absolute);
      if (lines !== undefined && input.line > lines) throw new Error(`"${resolved.path}" has ${lines} lines, so line ${input.line} does not exist.`);
      const { status, event } = await appendScreenEvent(root, {
        harness: input.harness,
        event: 'annotate',
        payload: { path: resolved.path, repo: resolved.repo, line: input.line, text: input.text, tag: input.tag ?? 'question' },
      });
      return { status, path: resolved.path, ...(resolved.repo ? { repo: resolved.repo } : {}), line: input.line, message: status === 'shown' ? 'The file is open at that line beside the user\'s chat. The note itself is not drawn there yet, so say it in the chat too.' : 'The user already has this note.', eventId: event.id };
    },
  ),

  screenTool(
    'suggest_next',
    `Tell the user the one next move you suggest, with the reason. It appears as a Next button in the progress strip, and a newer suggestion replaces the older one. Call it at the end of a turn when there is a clear next step for the user. It is a suggestion only: nothing happens until they choose it.`,
    nextSchema,
    async (input, { root, workspacePath }) => {
      let target: { path?: string; repo?: string; line?: number } = {};
      if (input.path !== undefined) {
        const resolved = await resolveScreenTarget(workspacePath, { path: input.path, repo: input.repo });
        target = { path: resolved.path, repo: resolved.repo, line: input.line };
      }
      const { status, event } = await appendScreenEvent(root, {
        harness: input.harness,
        event: 'next',
        payload: { title: input.title, reason: input.reason, ...target },
      });
      return { status, title: event.event === 'next' ? event.payload.title : input.title, message: status === 'shown' ? 'The suggestion is in the user\'s progress strip.' : 'The user already has this suggestion.', eventId: event.id };
    },
  ),

  screenTool(
    'get_screen_context',
    `Ask what the user is looking at: the open file or document, any text they selected, and what they have marked reviewed. It answers only if the user switched sharing on in the app, and says so when they have not. If it is off, do not ask the user to switch it on: ask your question in the chat instead.`,
    contextSchema,
    async (_input, { root }) => readScreenContext(root),
    true,
  ),
];
