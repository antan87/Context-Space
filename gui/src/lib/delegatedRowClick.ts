import type React from 'react';

/**
 * Executes an action on row click unless:
 * 1. The user has highlighted text within the row (preventing accidental triggers during text selection).
 * 2. The click originated from or passed through an interactive child element (button, link, input, etc.).
 * 3. The click was a secondary or middle mouse click (e.g. right-click context menu).
 */
export function handleDelegatedRowClick(
  e: React.MouseEvent<HTMLElement>,
  action: () => void
): void {
  // Only primary clicks (left-click) should activate row navigation
  if (e.button !== undefined && e.button !== 0) {
    return;
  }

  const currentTarget = e.currentTarget;

  // Guard against triggering row navigation while selecting text within this row
  const selection = typeof window !== 'undefined' ? window.getSelection() : null;
  if (selection && selection.toString().trim().length > 0) {
    const anchorInside = selection.anchorNode && typeof currentTarget?.contains === 'function'
      ? currentTarget.contains(selection.anchorNode)
      : false;
    const focusInside = selection.focusNode && typeof currentTarget?.contains === 'function'
      ? currentTarget.contains(selection.focusNode)
      : false;
    if ((!selection.anchorNode && !selection.focusNode) || anchorInside || focusInside) {
      return;
    }
  }

  const rawTarget = e.target as unknown;
  if (!rawTarget) return;

  // Support elements where target might be a Text node (Text nodes lack .closest)
  const targetElement = (
    typeof (rawTarget as { closest?: unknown })?.closest === 'function'
      ? rawTarget
      : (rawTarget as Node)?.parentElement
  ) as HTMLElement | null;

  if (!targetElement) return;

  // Check if click was inside an interactive child element (other than the row itself)
  const interactive = targetElement.closest(
    'button, a, input, textarea, select, summary, label, [role="button"], [role="checkbox"], [role="link"], [role="menuitem"], [role="option"], [data-no-row-click], [data-prevent-row-click]'
  );

  if (interactive && interactive !== currentTarget) {
    return;
  }

  action();
}

/**
 * Handles keyboard activation (Enter or Space) on the delegated row container.
 */
export function handleDelegatedRowKeyDown(
  e: React.KeyboardEvent<HTMLElement>,
  action: () => void
): void {
  if (e.key === 'Enter' || e.key === ' ') {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    const currentTarget = e.currentTarget;
    if (target === currentTarget) {
      e.preventDefault();
      action();
    }
  }
}
