/**
 * The line "Ask in CLI" types into the active AI session for a card: one short line that names the card, so the AI can find and read it
 * (a card id for `board_read`, a workspace path it can open, a commit it can show). It is only typed; the person presses Enter.
 */
export type AskCard =
  | { kind: 'note'; id?: string; title?: string; text?: string }
  | { kind: 'file'; id?: string; title?: string; path: string }
  | { kind: 'commit'; sha: string; subject?: string; repo?: string }
  | { kind: 'question'; question: string; checkpoint?: string };

/** What a caller hands to `askInCLI` to type a finished line as it is (a plain string is still "Regarding …"). */
export interface AskLine { readonly line: string }
export const isAskLine = (value: unknown): value is AskLine => typeof value === 'object' && value !== null && typeof (value as AskLine).line === 'string';

const MAX_TITLE = 80;

/** One line of plain words: no control characters or line separators, marks that would break the quotes turned into ' and the length cut with "…". */
function words(text: string | undefined, max = MAX_TITLE): string {
  const plain = Array.from(text ?? '', (c) => { const n = c.charCodeAt(0); return n < 32 || (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029 ? ' ' : c; })
    .join('').replace(/["`“”]/g, "'").replace(/\s+/g, ' ').trim();
  const chars = Array.from(plain);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : plain;
}

/** A path or id: never cut, only freed of control characters. */
function token(text: string): string {
  return Array.from(text, (c) => { const n = c.charCodeAt(0); return n < 32 || (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029 ? ' ' : c; }).join('').replace(/\s+/g, ' ').trim();
}

export function askText(card: AskCard): string {
  switch (card.kind) {
    case 'note': {
      const title = words(card.title) || words(card.text, 60);
      const id = card.id ? token(card.id) : '';
      const what = title ? `the board note "${title}"` : 'this board note';
      return `About ${what}${id ? ` (card ${id}; board_read shows it)` : ''}: `;
    }
    case 'file': {
      const path = token(card.path) || 'this file';
      const title = words(card.title);
      const id = card.id ? token(card.id) : '';
      const parts = id ? `board card ${title ? `"${title}", ` : ''}${id}` : title && title !== path ? `"${title}"` : '';
      return `About ${path}${parts ? ` (${parts})` : ''}: `;
    }
    case 'commit': {
      const sha = token(card.sha).slice(0, 7);
      const subject = words(card.subject);
      const repo = card.repo ? token(card.repo) : '';
      return `About commit ${sha}${subject ? ` "${subject}"` : ''}${repo ? ` in ${repo}` : ''}: `;
    }
    case 'question': {
      const question = words(card.question.replace(/[*_#]/g, ''), 100);
      const checkpoint = words(card.checkpoint);
      return `About the plan ${question ? `question "${question}"` : 'question'}${checkpoint ? ` (${checkpoint})` : ''}: `;
    }
  }
}

export const askCard = (card: AskCard): AskLine => ({ line: askText(card) });
