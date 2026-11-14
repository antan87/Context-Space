/**
 * @module commands/note
 * Attach AI notes to commits and list them for a commit or workspace.
 */

import chalk from 'chalk';
import { Command, CommanderError } from 'commander';

import { resolveWorkspaceQuiet } from '../utils/resolve-workspace.js';
import { addCommitNote, listCommitNotes, type CommitNote } from '../core/commit-notes.js';

export interface NoteAddOptions {
  repo?: string;
  title?: string;
  text?: string;
  workspace?: string;
  harness?: string;
  json?: boolean;
  stdin?: NodeJS.ReadableStream;
}

export interface NoteListOptions {
  repo?: string;
  workspace?: string;
  json?: boolean;
}

const NOTE_EXAMPLES = [
  'Examples:',
  '  ctxspace note HEAD "Keep both imports"',
  '  ctxspace note HEAD -- "--force-push happened" --repo Other',
  '  ctxspace note HEAD --text "--force-push happened" --repo Other',
  '  echo "--force-push happened" | ctxspace note HEAD - --repo Other',
  '  ctxspace note list HEAD --repo Other',
].join('\n');

function resolveHarnessActor(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const candidate = explicit?.trim()
    || env.CTXSPACE_HARNESS?.trim()
    || (env.CLAUDECODE ? 'claude' : undefined);
  return candidate || 'ai';
}

async function readTextFromStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function addNoteOptions(cmd: Command): Command {
  return cmd
    .option('--repo <name>', 'Repository name when a commit ref is ambiguous across repos')
    .option('--title <title>', 'Explicit note title')
    .option('--text <text>', 'Note text (use when text starts with -, or pass - for stdin)')
    .option('--harness <name>', 'AI tool name (defaults to CTXSPACE_HARNESS or ai)')
    .option('-w, --workspace <name>', 'Workspace name, id, or path')
    .option('--json', 'Output JSON');
}

function parseTrailingNoteOptions(noteCmd: Command, extra: string[]): NoteAddOptions {
  const parser = addNoteOptions(new Command(noteCmd.name()))
    .exitOverride()
    .allowExcessArguments(false)
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });

  try {
    parser.parse(extra, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      noteCmd.error(error.message, { exitCode: error.exitCode, code: error.code });
    }
    throw error;
  }

  if (parser.args.length > 0) {
    noteCmd.error(
      `error: too many arguments for 'note'. Expected 2 arguments but got ${2 + parser.args.length}.`,
      { code: 'commander.excessArguments' },
    );
  }
  return parser.opts<NoteAddOptions>();
}

export function formatCommitNotesList(notes: CommitNote[], commitFilter?: string, repoFilter?: string): string {
  if (notes.length === 0) {
    const repo = repoFilter?.trim();
    if (commitFilter) {
      return repo
        ? `No commit notes found for ${commitFilter} in ${repo}.`
        : `No commit notes found for ${commitFilter}.`;
    }
    return repo
      ? `No notes on commits in ${repo}.`
      : 'No commit notes in this workspace.';
  }

  return notes.map((note) => {
    const header = `${note.shortSha} (${note.repo}) · ${note.by} · ${note.at}`;
    const titleLine = `  ${note.title}`;
    const body = note.body.trim();
    if (!body || body === note.title.trim()) {
      return `${header}\n${titleLine}`;
    }
    const bodyLines = note.body
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    return `${header}\n${titleLine}\n${bodyLines}`;
  }).join('\n\n');
}

export async function noteAddCommand(
  commit: string,
  text: string,
  options: NoteAddOptions = {},
): Promise<boolean> {
  const workspacePath = await resolveWorkspaceQuiet(options.workspace);
  if (!workspacePath) {
    process.exitCode = 1;
    return false;
  }

  try {
    const resolvedText = text === '-' ? await readTextFromStdin(options.stdin) : text;
    const result = await addCommitNote(workspacePath, {
      commit,
      text: resolvedText,
      repo: options.repo,
      title: options.title,
      by: resolveHarnessActor(options.harness),
      cwd: process.cwd(),
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `${chalk.green('✓')} Noted ${chalk.bold(result.note.shortSha)} (${result.note.repo}) [${result.note.by}]: ${result.note.title}`,
      );
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(chalk.red(`✖ ${message}`));
    }
    process.exitCode = 1;
    return false;
  }
}

export async function noteListCommand(
  commit?: string,
  options: NoteListOptions = {},
): Promise<boolean> {
  const workspacePath = await resolveWorkspaceQuiet(options.workspace);
  if (!workspacePath) {
    process.exitCode = 1;
    return false;
  }

  try {
    const notes = await listCommitNotes(workspacePath, {
      commit,
      repo: options.repo,
      cwd: process.cwd(),
    });

    if (options.json) {
      console.log(JSON.stringify({ notes }, null, 2));
    } else {
      console.log(formatCommitNotesList(notes, commit, options.repo));
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(chalk.red(`✖ ${message}`));
    }
    process.exitCode = 1;
    return false;
  }
}

export function registerNoteCommand(program: Command, io: { stdin?: NodeJS.ReadableStream } = {}): void {
  const noteCmd = addNoteOptions(
    program
      .command('note')
      .description('Leave a note on a commit, or list commit notes')
      .argument('[commit]', 'Commit hash (>=7 chars) or git reference (HEAD, HEAD~1, origin/...)')
      .argument('[text]', 'Note text (use - to read from stdin, or -- before text starting with -)')
      .allowExcessArguments(true)
      .addHelpText('after', `\n${NOTE_EXAMPLES}\n`),
  ).action(async (commit: string | undefined, text: string | undefined, opts: NoteAddOptions, cmd: Command) => {
    const extra = cmd.args.slice(2);
    const trailingOpts = extra.length > 0 ? parseTrailingNoteOptions(noteCmd, extra) : {};
    const merged: NoteAddOptions = {
      ...opts,
      ...trailingOpts,
      ...(io.stdin ? { stdin: io.stdin } : {}),
    };

    if (text !== undefined && merged.text !== undefined) {
      noteCmd.error('error: pass note text either as <text> or with --text, not both.');
    }

    const resolvedText = merged.text ?? text;
    if (!commit || resolvedText === undefined) {
      if (merged.json) {
        console.log(JSON.stringify({ error: 'Usage: ctxspace note <commit> "<text>" or ctxspace note list [<commit>]' }));
      } else {
        noteCmd.outputHelp();
      }
      process.exitCode = 1;
      return;
    }
    await noteAddCommand(commit, resolvedText, merged);
  });

  noteCmd
    .command('list [commit]')
    .description('List commit notes, newest first (optionally filtered to one commit)')
    .allowExcessArguments(false)
    .option('--repo <name>', 'Filter to one repository')
    .option('-w, --workspace <name>', 'Workspace name, id, or path')
    .option('--json', 'Output JSON')
    .action(async (commit: string | undefined, opts: NoteListOptions, cmd: Command) => {
      const parentOpts = cmd.parent?.opts() as NoteListOptions | undefined;
      await noteListCommand(commit, {
        repo: opts.repo ?? parentOpts?.repo,
        workspace: opts.workspace ?? parentOpts?.workspace,
        json: Boolean(opts.json || parentOpts?.json),
      });
    });
}
