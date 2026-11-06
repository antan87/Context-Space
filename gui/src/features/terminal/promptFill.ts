/**
 * Text that a button puts into the chat prompt. The prompt is a live terminal,
 * so every character is a keystroke: a carriage return would press Enter and an
 * escape would start a control sequence. A button may only type, never send, so
 * everything that is not plain text is turned into a space, and the user is the
 * one who presses Enter.
 */

/** Longest text one button may type into the prompt, in characters. */
export const PROMPT_FILL_LIMIT = 600;

// C0 and C1 controls (Enter, Escape, Ctrl-C, the 8-bit CSI), line and paragraph
// separators, and the invisible and bidirectional marks that can disguise text.
// Matching control characters is the whole point of this expression.
// eslint-disable-next-line no-control-regex
const NOT_PLAIN_TEXT = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** The plain text a button may type into the prompt, or an empty string when nothing usable is left. */
export function toPromptText(text: unknown): string {
  if (typeof text !== 'string') return '';
  const plain = text.replace(NOT_PLAIN_TEXT, ' ').replace(/\s+/g, ' ').trim();
  if (plain.length <= PROMPT_FILL_LIMIT) return plain;
  // Never cut a surrogate pair in half.
  const cut = /[\ud800-\udbff]/.test(plain[PROMPT_FILL_LIMIT - 1]!) ? PROMPT_FILL_LIMIT - 1 : PROMPT_FILL_LIMIT;
  return plain.slice(0, cut).trimEnd();
}

const registeredFillers = new Map<string, (text: string) => boolean>();

/** Registers a prompt filler function for a workspace, returning an unregister callback. */
export function registerPromptFiller(workspace: string, filler: (text: string) => boolean): () => void {
  registeredFillers.set(workspace, filler);
  return () => {
    if (registeredFillers.get(workspace) === filler) {
      registeredFillers.delete(workspace);
    }
  };
}

/** What the filling that is running right now asks for. Read by the pane's filler, which runs synchronously inside the call. */
let assistantOnlyNow = false;
export const promptFillWantsAssistant = (): boolean => assistantOnlyNow;

/**
 * Types text into the terminal prompt of the given workspace if available. With `assistantOnly`, a plain shell is refused like a
 * closed terminal: text typed into it would be a command line, not a message to an AI.
 */
export function fillPromptForWorkspace(workspace: string, text: string, options: { assistantOnly?: boolean } = {}): boolean {
  const filler = registeredFillers.get(workspace);
  if (!filler) return false;
  assistantOnlyNow = options.assistantOnly === true;
  try {
    return filler(text);
  } finally {
    assistantOnlyNow = false;
  }
}
