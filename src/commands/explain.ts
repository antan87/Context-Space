/**
 * @module commands/explain
 * Lists the answers in the workspace's explain/ folder and whether each copied code block still matches the real file.
 * Read only: nothing is written. `--areas` lists the Area ids an answer can name in its `area:` front matter.
 */

import chalk from 'chalk';
import type { Command } from 'commander';

import { readQuestions, summarizeAnswers, type AnswerSummary } from '../core/questions.js';
import { readPlanFile } from '../core/plan-file-store.js';
import { areasOf } from '../mcp/board-tools.js';
import { resolveWorkspaceQuiet } from '../utils/resolve-workspace.js';

export interface ExplainOptions {
  workspace?: string;
  json?: boolean;
  areas?: boolean;
}

export function formatExplain(answers: AnswerSummary[]): string {
  if (answers.length === 0) return 'No answers yet. Write one in explain/<topic>.md (skill contextspace-explain).';
  const lines: string[] = [];
  for (const answer of answers) {
    lines.push(answer.path, `  ${answer.question}`, `  area: ${answer.area ?? 'no area'}`);
    lines.push(`  parts: ${answer.parts.length > 0 ? answer.parts.join(' | ') : 'none'}`, `  code blocks: ${answer.codeBlocks}`);
    for (const copy of answer.notMatching) {
      lines.push(`  does not match: ${copy.where} ${copy.status}${copy.start !== undefined ? ` (now ${copy.start}-${copy.end}, write that in the fence)` : ''}`);
    }
  }
  if (answers.every((answer) => answer.notMatching.length === 0)) lines.push('', 'All copies match');
  return lines.join('\n');
}

export async function explainCommand(options: ExplainOptions = {}): Promise<boolean> {
  const fail = (message: string): false => {
    if (options.json) console.log(JSON.stringify({ error: message }));
    else console.error(chalk.red(`✖ ${message}`));
    process.exitCode = 1;
    return false;
  };
  try {
    const workspacePath = await resolveWorkspaceQuiet(options.workspace);
    if (!workspacePath) return fail('Not inside a ContextSpace workspace. Run this in a workspace folder, or pass -w <workspace>.');
    if (options.areas) {
      const { plan } = await readPlanFile(workspacePath);
      const areas = areasOf(plan);
      if (options.json) console.log(JSON.stringify({ areas }, null, 2));
      else console.log(areas.items.length === 0 ? 'No Areas: the plan has no checkpoints.' : areas.items.map((item) => `${item.id}  ${item.title}${item.current ? '  (current)' : ''}`).join('\n'));
      return true;
    }
    const answers = summarizeAnswers(await readQuestions(workspacePath));
    if (options.json) console.log(JSON.stringify({ answers, allMatch: answers.every((answer) => answer.notMatching.length === 0) }, null, 2));
    else console.log(formatExplain(answers));
    return true;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function registerExplainCommand(program: Command): void {
  program
    .command('explain')
    .description('List the answers in explain/ and the copied code that no longer matches (read only); --areas lists the Area ids an answer can use')
    .option('--areas', 'List the Area ids and titles an answer can name in `area:`')
    .option('-w, --workspace <name>', 'Workspace name, id, or path')
    .option('--json', 'Output JSON')
    .action(async (options: ExplainOptions) => { await explainCommand(options); });
}
