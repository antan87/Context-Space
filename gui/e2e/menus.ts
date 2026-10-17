import { expect, type Locator } from '@playwright/test';

/**
 * Opens a menu and waits for one of its items. A click that lands while the page is still drawing what it just
 * loaded can open a menu that the redraw closes again, so the trigger is clicked again until the item shows; an
 * item already showing is never clicked shut.
 */
export async function openMenuFor(trigger: Locator, item: Locator): Promise<void> {
  await expect(async () => {
    if (!(await item.isVisible())) await trigger.click();
    await expect(item).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}
