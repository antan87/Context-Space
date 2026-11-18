import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

/** The text field's own classes, as the note dialog drew them: base, focus, then the font. */
const COMPOSER_BASE = 'w-full min-h-[140px] max-h-[260px] rounded-lg border border-input bg-background p-3 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/72 outline-none transition-shadow';
const COMPOSER_FOCUS = 'focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/20 resize-y';

export interface ComposerProps
  extends Omit<ComponentProps<'textarea'>, 'value' | 'defaultValue' | 'onChange' | 'className' | 'children'> {
  /** The text. The field is controlled: it shows what it is given and nothing else. */
  value: string;
  /** Gets the new text (a string, not the event). */
  onChange: (value: string) => void;
  /** Draws the text in the code font at 12.5 px instead of the sans font. */
  mono?: boolean;
  /** Extra classes, drawn last, so they win over the field's own (twMerge). */
  className?: string;
}

/**
 * The multi-line text field of the Board's writing surfaces: a controlled `<textarea>` that takes plain values.
 * The note dialog's body is its first user (DS6). `id`, `name`, `placeholder`, `maxLength`, `rows`, `disabled`, `autoFocus`,
 * `onKeyDown`, `aria-*` and `ref` go straight to the textarea. It has no auto-grow, toolbar, saving or error state yet:
 * the in-place note and the Hairline restyle (R1) will add what they need.
 */
export function Composer({ value, onChange, mono = false, className, ...rest }: ComposerProps) {
  return <textarea
    {...rest}
    value={value}
    onChange={(event) => onChange(event.target.value)}
    className={cn(
      COMPOSER_BASE,
      COMPOSER_FOCUS,
      mono ? 'font-mono text-[12.5px]' : 'font-sans',
      className,
    )}
  />;
}
