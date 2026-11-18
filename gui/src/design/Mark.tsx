import { cn } from '../lib/utils.js';

export interface MarkProps {
  /** Made by the AI (true) or by a person (false). */
  ai: boolean;
  /** The whole byline: it is the mark's tooltip and, for a screen reader, its text instead of the word "AI" or "you". */
  label: string;
  id?: string;
}

/** The AI tone and the person tone of the mark, as today's cards draw them. */
export const MARK_BASE = 'rounded-full px-1.5 text-[12.5px] leading-4';
export const MARK_AI = 'bg-state-ai/12 font-medium text-state-ai';
export const MARK_PERSON = 'text-muted-foreground';

/** Who made a card, as a word that stays quiet: "AI" in the AI's tone, or "you". The visible word is hidden from a screen reader, which reads `label`. */
export function Mark({ ai, label, id }: MarkProps) {
  return <span id={id} title={label} className={cn(MARK_BASE, ai ? MARK_AI : MARK_PERSON)}>
    <span aria-hidden="true">{ai ? 'AI' : 'you'}</span><span className="sr-only">{label}</span>
  </span>;
}
