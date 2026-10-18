/**
 * @module core/ask-user
 * An AI tells the user it is blocked and needs their answer. The request goes into the chat ledger, where the app turns
 * it into an alert ("the AI is waiting for your answer"), and into PLAN.md as a decision. Behind both the MCP tool
 * `request_user_input` and `ctxspace ask`, so an AI without MCP asks the same way and gets the same alert.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';

import { findWorkspaceRoot, loadFeatureConfig } from './workspace.js';
import { addChatQuestionToPlan } from './plan-questions.js';
import {
  INPUT_REQUEST_DISPLAY_LIMIT,
  INPUT_REQUEST_HARNESS_LIMIT,
  cleanInputOptions,
  cleanInputRequestText,
  latestInputRequest,
} from './attention.js';
import { resolveWorkspaceChatLedger } from './constants.js';

/**
 * An identical request from the same harness inside this window is one alert, not
 * two. It exists for a retried or doubled call. It is short because an agent that
 * asks the same generic question ("Proceed?") again after the user has answered
 * must still be able to raise a new alert, and nothing here can see the reply.
 */
const INPUT_REQUEST_REPEAT_WINDOW_MS = 30_000;

const WAIT_NOTE = 'The user has been alerted. Write your full question in the chat and end your turn; they will reply there. Do not continue the task or ask again for the same question.';

/** A request the caller got wrong. The message says how to put it right, so it is shown as it is. */
export class AskUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AskUserError';
  }
}

/** What an AI asks. Anything can arrive from a tool call, so every field is checked here. */
export interface AskUserInput {
  message: unknown;
  options?: unknown;
  harness?: unknown;
}

/** What the AI is told back. `message` is what it should read: wait for the answer. */
export interface AskUserResult {
  status: 'requested' | 'already_requested';
  workspaceId: string;
  harness: string;
  timestamp: string;
  /** The question as the plan words it, when it was added to PLAN.md. */
  planQuestion?: string;
  message: string;
}

let inputRequestQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs input requests one at a time in this process, so the repeat check and the
 * append cannot interleave when an agent issues parallel calls.
 */
function serializeInputRequests<T>(task: () => Promise<T>): Promise<T> {
  const run = inputRequestQueue.then(task, task);
  inputRequestQueue = run.catch(() => undefined);
  return run;
}

/**
 * Alerts the user that the AI waits for their answer.
 *
 * Asking the same thing again within a short while is one alert. The question is also added to PLAN.md; a plan that
 * cannot be changed must not stop the alert.
 *
 * @throws {AskUserError} When the question is empty or too long, or the options are not a list.
 */
export async function askUser(workspacePath: string, input: AskUserInput): Promise<AskUserResult> {
  const feature = await loadFeatureConfig(workspacePath);
  if (!feature) throw new AskUserError('Workspace not found.');
  // Stored exactly as it will be shown, so what is recorded and what is compared agree.
  const message = cleanInputRequestText(input.message);
  if (!message) throw new AskUserError('The request message cannot be empty.');
  if (message.length > INPUT_REQUEST_DISPLAY_LIMIT) {
    throw new AskUserError(
      `The request message is ${message.length} characters; keep it to ${INPUT_REQUEST_DISPLAY_LIMIT} or fewer and put the detail in the chat.`,
    );
  }
  const harness = cleanInputRequestText(input.harness).slice(0, INPUT_REQUEST_HARNESS_LIMIT) || 'agent';
  if (input.options !== undefined && !Array.isArray(input.options)) throw new AskUserError('options must be a list of short answers.');
  const options = cleanInputOptions(input.options);

  // This can be called from below the workspace root; the ledger lives at the root.
  const root = (await findWorkspaceRoot(workspacePath)) ?? workspacePath;

  return serializeInputRequests<AskUserResult>(async () => {
    const now = Date.now();
    // Reads the end of the ledger only, so a long-lived workspace does not pay for its history.
    const latest = await latestInputRequest(root, now);
    const repeat = latest
      && latest.harness === harness
      && latest.message === message
      && JSON.stringify(latest.options ?? []) === JSON.stringify(options ?? [])
      && now - Date.parse(latest.timestamp) < INPUT_REQUEST_REPEAT_WINDOW_MS
      ? latest
      : null;
    if (repeat) {
      return { status: 'already_requested', workspaceId: feature.id, harness, timestamp: repeat.timestamp, message: WAIT_NOTE };
    }

    const ledger = await resolveWorkspaceChatLedger(root);
    await fs.mkdir(ledger.chatDir, { recursive: true });
    const entry = {
      id: randomUUID(),
      timestamp: new Date(now).toISOString(),
      harness,
      author: 'agent',
      kind: 'input_request',
      message,
      ...(options ? { options } : {}),
    };
    await fs.appendFile(ledger.chatPath, JSON.stringify(entry) + '\n', 'utf8');
    // The same question in the plan, so the user answers it once and the plan says what it holds up.
    // A plan that cannot be changed must not stop the alert.
    const inPlan = await addChatQuestionToPlan(root, { message, options, harness }).catch(() => undefined);
    return {
      status: 'requested',
      workspaceId: feature.id,
      harness,
      timestamp: entry.timestamp,
      ...(inPlan ? { planQuestion: inPlan.question } : {}),
      message: inPlan
        ? `${WAIT_NOTE} It is a decision in PLAN.md too; when the user answers, tick it and add their words on an "Answer:" line under it.`
        : WAIT_NOTE,
    };
  });
}
