/**
 * @module mcp/screen-tools
 * Tools that let the AI drive the screen: open a document or diff beside the
 * chat, leave a note on a line, suggest the next move, report where a milestone
 * stands, and ask what the user is looking at. They only show things. None edits
 * a file, none presses a key for the user, and the two decisions that belong to
 * the user (reopening and completing a milestone) are proposals the tool says it
 * cannot carry out itself.
 */

import * as fs from 'node:fs/promises';
import { z } from 'zod';

import { advanceLifecycleStep, blockLifecycleStep, loadWorkspaceLifecycle, LifecycleStepError } from '../core/lifecycle.js';
import { refreshPlanningContext } from '../core/planning-refresh.js';
import { readScreenContext } from '../core/screen-context.js';
import {
  SCREEN_NOTE_LIMIT, SCREEN_REASON_LIMIT, SCREEN_TEXT_LIMIT, SCREEN_TITLE_LIMIT,
  appendScreenEvent,
} from '../core/screen-events.js';
import { resolveScreenRepo, resolveScreenTarget, SCREEN_PATH_MAX_LENGTH } from '../core/screen-paths.js';
import { findWorkspaceRoot, loadFeatureConfig } from '../core/workspace.js';
import type { NexusFlowTool } from './tools.js';
import { useThePlanCommand } from './planning-tools.js';

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

const milestoneSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100).describe('The milestone id, from get_work_context.'),
  state: z.enum(['in_progress', 'blocked', 'reopened', 'done']),
  note: z.string().max(SCREEN_TEXT_LIMIT).optional().describe('Required for blocked, reopened and done: what it waits on, what is wrong, or what shows it is finished.'),
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
    'set_milestone',
    `${useThePlanCommand('set_milestone')} Report where a milestone stands. in_progress starts it (its dependencies must be finished). blocked says what it is waiting on; a note is required. reopened and done are only proposals: you cannot reopen or complete a milestone yourself, because the user decides and a finished milestone must pass its own check. The tool says which one happened. Read get_work_context for milestone ids.`,
    milestoneSchema,
    async (input, { root, workspacePath }) => {
      const deprecated = useThePlanCommand('set_milestone');
      const lifecycle = await loadWorkspaceLifecycle(workspacePath, { includeFleet: false });
      const step = lifecycle.steps.find((candidate) => candidate.id === input.id);
      if (!step) throw new Error(`There is no milestone "${input.id}". Read get_work_context for the ids.`);
      const needNote = (what: string) => { if (!input.note?.trim()) throw new Error(`Add a note: ${what}.`); };

      if (input.state === 'in_progress') {
        if (step.status === 'in_progress') return { deprecated, status: 'unchanged', milestone: input.id, message: 'It is already in progress.' };
        if (step.status === 'completed' || step.status === 'verified') {
          throw new Error(`"${step.title}" is already ${step.status}. Only the user can reopen finished work.`);
        }
        try {
          await advanceLifecycleStep(workspacePath, input.id, 'start', { by: 'agent', harness: input.harness });
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : String(error));
        }
        await appendScreenEvent(root, { harness: input.harness, event: 'milestone', payload: { stepId: input.id, state: 'in_progress', note: input.note } });
        return { deprecated, status: 'started', milestone: input.id, ...(await refreshPlanningContext(root)) };
      }

      if (input.state === 'blocked') {
        needNote('what the milestone is blocked on');
        try {
          await blockLifecycleStep(workspacePath, input.id, { reason: input.note! }, { by: 'agent', harness: input.harness });
        } catch (error) {
          if (error instanceof LifecycleStepError) throw new Error(error.message);
          throw error;
        }
        await appendScreenEvent(root, { harness: input.harness, event: 'milestone', payload: { stepId: input.id, state: 'blocked', note: input.note } });
        return { deprecated, status: 'blocked', milestone: input.id, message: 'The user can see what it is waiting on. Start it again when the block is gone.', ...(await refreshPlanningContext(root)) };
      }

      if (input.state === 'reopened') {
        needNote('what is wrong, so the user can decide');
        // A verified milestone passed its check but is not finished, and the user sees it as in progress.
        if (step.status !== 'completed') {
          throw new Error(`"${step.title}" is ${step.status.replace('_', ' ')}, so there is nothing to reopen. Only a finished milestone can be reopened; say what is wrong in the chat.`);
        }
        const { status } = await appendScreenEvent(root, { harness: input.harness, event: 'milestone_proposal', payload: { stepId: input.id, proposal: 'reopen', reason: input.note! } });
        return { deprecated, status: status === 'shown' ? 'proposed' : 'already_proposed', milestone: input.id, message: 'This is a proposal. You cannot reopen a milestone yourself: the user sees your reason and decides. Carry on with other work until they do.' };
      }

      needNote('what shows the milestone is finished');
      if (step.status !== 'in_progress' && step.status !== 'verified') {
        throw new Error(`"${step.title}" is ${step.status}, so it cannot be proposed as done. Start it first.`);
      }
      const { status } = await appendScreenEvent(root, { harness: input.harness, event: 'milestone_proposal', payload: { stepId: input.id, proposal: 'complete', reason: input.note! } });
      return { deprecated, status: status === 'shown' ? 'proposed' : 'already_proposed', milestone: input.id, message: 'This is a proposal. You cannot complete a milestone yourself: it has to pass its own check and the user decides.' };
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
