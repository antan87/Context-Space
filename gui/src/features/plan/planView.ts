/**
 * The words the plan's screens share: who did something, when, the answers an AI suggests with its question, and why
 * it asks. Pure, so it is tested on its own.
 */

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The answers an AI suggested with its question, kept in the question's detail as "Suggested answers: A · B". */
export function suggestedAnswers(detail: string | undefined): string[] {
  const line = detail?.split('\n').find((candidate) => candidate.startsWith('Suggested answers: '));
  return line ? line.slice('Suggested answers: '.length).split(' · ').map((answer) => answer.trim()).filter(Boolean) : [];
}

/** Why the AI asks, as it wrote in the question's detail, without the suggested answers shown as buttons. */
export function questionWhy(detail: string | undefined): string {
  return detail?.split('\n').filter((line) => !line.startsWith('Suggested answers: ')).join('\n').trim() ?? '';
}

/** Who made a change, as the tab says it: You, the AI tool by name, or ContextSpace. */
export function whoName(by: string | undefined): string {
  const name = (by ?? 'agent').trim();
  if (/^user$/i.test(name)) return 'You';
  if (/^agent$/i.test(name)) return 'The AI';
  if (/^contextspace$/i.test(name)) return 'ContextSpace';
  if (/^antigravity$/i.test(name)) return 'Antigravity';
  return sentenceCase(name);
}

/** "2 min ago", "3 h ago", "Oct 7". Empty when the time is unknown, never an invented date. */
export function whenText(at: string | undefined, now: Date = new Date()): string {
  const then = at ? Date.parse(at) : NaN;
  // The epoch stands in for a time that was never recorded; showing it would say "Jan 1".
  if (!Number.isFinite(then) || then <= 0) return '';
  const minutes = Math.round((now.getTime() - then) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
