/**
 * @module core/plan-questions
 * A question the AI asks in the chat is also a decision in PLAN.md. The user sees one list of what waits for them
 * (the strip above the chat and Needs you), the plan says what the question holds up, and the answer is kept where
 * every AI reads it.
 */

import { addToPlan, answerDecision, parsePlanFile, setDone } from './plan-file.js';
import { applyForApp, changePlanDbForApp, planDbParts } from './plan-db-app.js';
import { storeOf } from './workspace-db-app.js';
import { changePlanFile, readPlanFile } from './plan-file-store.js';

/** The longest a chat question's words may be on its line in the plan. */
const QUESTION_MAX = 300;

/**
 * What the app writes as the answer when the developer replies in the chat. The app sees that they replied, not what
 * they said. The AI records their words with `ctxspace plan apply` and the observed revision in a moved workspace,
 * or with `ctxspace plan answer` in a file-based workspace.
 */
export const ANSWERED_IN_CHAT = 'Answered in the chat.';

/** A chat question's words on one line, cut at a word when longer than a line of the plan may be. */
export function questionTitle(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim();
  if (text.length <= QUESTION_MAX) return text;
  const cut = text.slice(0, QUESTION_MAX - 1);
  const atWord = cut.replace(/\s+\S*$/, '');
  return `${(atWord.length > QUESTION_MAX / 2 ? atWord : cut).trimEnd()}…`;
}

/**
 * Adds the AI's chat question to PLAN.md as a decision, under the checkpoint being worked on, so that checkpoint
 * shows what it waits for. Asking again while the same question is open adds nothing. Returns the question as the
 * plan words it.
 */
export async function addChatQuestionToPlan(
  workspacePath: string,
  input: { message: string; options?: string[]; harness: string },
): Promise<{ question: string }> {
  const question = questionTitle(input.message);
  const by = input.harness && input.harness !== 'agent' ? input.harness : 'ai';
  if (storeOf(workspacePath) === 'database') {
    const { read } = await planDbParts(workspacePath, 0);
    const { plan } = read;
    const decisions = [...plan.checkpoints.flatMap((cp) => cp.decisions), ...plan.decisions].filter((d) => d.question === question);
    if (decisions.some((decision) => !decision.done)) return { question };
    const replied = decisions.find((decision) => decision.answer === ANSWERED_IN_CHAT);
    if (replied) {
      await changePlanDbForApp(workspacePath, { type: 'tick', key: replied.key, done: false, expected: replied.question }, { by, read });
    } else {
      const current = plan.checkpoints.find((cp) => !cp.done);
      await changePlanDbForApp(workspacePath, { type: 'decide', checkpoint: current?.key, decision: {
        question,
        ...(question !== input.message.trim() ? { detail: input.message.trim() } : {}),
        ...(input.options?.length ? { suggested: input.options } : {}),
      } }, { by, read, strictRevision: true });
    }
    return { question };
  }
  await changePlanFile(workspacePath, (text, plan) => {
    const decisions = [...plan.checkpoints.flatMap((checkpoint) => checkpoint.decisions), ...plan.decisions].filter((decision) => decision.question === question);
    if (decisions.some((decision) => !decision.done)) return text;
    // Asked again after a reply in the chat closed it, before the AI wrote the answer down: the reply was not the answer.
    const replied = decisions.find((decision) => decision.answer === ANSWERED_IN_CHAT);
    if (replied) return setDone(text, replied.key, false);
    const current = plan.checkpoints.find((checkpoint) => !checkpoint.done);
    return addToPlan(text, {
      decision: {
        question,
        ...(question !== input.message.trim() ? { detail: input.message.trim() } : {}),
        ...(input.options?.length ? { suggested: input.options } : {}),
      },
    }, current ? { checkpoint: current.key } : {}).text;
  }, { by });
  return { question };
}

/**
 * The developer replied in the chat to the AI's questions, so the same decisions in the plan are answered too, as
 * theirs: one answer counts everywhere, and nothing asks them twice. Returns the questions it answered.
 */
export async function answerChatQuestionsInPlan(workspacePath: string, messages: readonly string[]): Promise<string[]> {
  if (!messages.length) return [];
  const questions = new Set(messages.map(questionTitle));
  if (storeOf(workspacePath) === 'database') {
    const { read } = await planDbParts(workspacePath, 0);
    const open = [...read.plan.checkpoints.flatMap((cp) => cp.decisions), ...read.plan.decisions]
      .filter((decision) => !decision.done && questions.has(decision.question));
    if (open.length) {
      await applyForApp(workspacePath, open.map((d) => ({ op: 'answer', id: d.key, rev: read.revs.get(d.key), text: ANSWERED_IN_CHAT })),
        { by: 'user', dbId: read.dbId, ifRevision: read.revision });
    }
    return open.map((d) => d.question);
  }
  const { plan, source } = await readPlanFile(workspacePath);
  if (source === 'none') return [];
  const open = [...plan.checkpoints.flatMap((checkpoint) => checkpoint.decisions), ...plan.decisions].filter((decision) => !decision.done && questions.has(decision.question));
  if (!open.length) return [];
  const answered: string[] = [];
  await changePlanFile(workspacePath, (text) => {
    let next = text;
    for (const decision of open) {
      const now = [...parsePlanFile(next).checkpoints.flatMap((checkpoint) => checkpoint.decisions), ...parsePlanFile(next).decisions].find((candidate) => candidate.question === decision.question && !candidate.done);
      if (!now) continue;
      next = answerDecision(next, now.key, ANSWERED_IN_CHAT);
      answered.push(decision.question);
    }
    return next;
  }, { by: 'user' });
  return answered;
}
