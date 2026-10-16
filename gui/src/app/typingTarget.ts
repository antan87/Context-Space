interface MaybeElement {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/**
 * Whether a key pressed on this element is for typing or choosing in it, so a single-letter app shortcut must leave
 * it alone: text fields, a `<select>` (its letters jump to an option), editable text, and the custom comboboxes and
 * lists that stand in for them. The terminal's own input counts too, since a CLI is typed into.
 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as MaybeElement;
  const tag = element.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable) return true;
  return Boolean(element.closest?.('[role="combobox"], [role="listbox"], [role="textbox"], [role="searchbox"], [role="spinbutton"]'));
}
