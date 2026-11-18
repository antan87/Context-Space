/** What names a folded group or row to those who cannot see it: what it says of itself. That it can be opened is said by its state (aria-expanded). */
export const summaryLabel = (parts: Array<string | false | undefined>) => parts.filter(Boolean).join(', ');
