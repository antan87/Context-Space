import { test, expect } from './fixtures';

test.describe('desktop update controls', () => {
  test('shows startup errors, retries a failed download, and keeps Later optional', async ({ page }) => {
    await page.addInitScript(() => {
      type MockUpdateState = {
        supported: boolean;
        status: string;
        currentVersion: string;
        version: string | null;
        releaseNotes: string | null;
        progress: number;
        error: string | null;
      };
      let downloadCalls = 0;
      let state: MockUpdateState = {
        supported: true,
        status: 'idle',
        currentVersion: '2.10.0',
        version: null,
        releaseNotes: null,
        progress: 0,
        error: null,
      };
      const listeners: Array<(next: MockUpdateState) => void> = [];
      const publish = (next: MockUpdateState) => {
        state = next;
        for (const listener of listeners) listener(state);
        return state;
      };
      const available = (): MockUpdateState => ({
        ...state,
        status: 'available',
        version: '2.11.0',
        releaseNotes: 'Safer desktop updates',
        progress: 0,
        error: null,
      });
      Object.defineProperty(window, '__nexusTestAllowUpdateRetry', { value: false, writable: true });
      Object.defineProperty(window, 'nexusBridge', {
        configurable: true,
        value: {
          getServerPort: async () => 3000,
          updates: {
            getStatus: async () => state,
            check: async () => {
              // React StrictMode may run the startup effect more than once.
              // Keep metadata offline until the test explicitly opts into the
              // manual retry, so duplicate startup checks remain deterministic.
              if (!(window as any).__nexusTestAllowUpdateRetry) {
                return publish({ ...state, status: 'error', error: 'startup metadata unavailable' });
              }
              if (state.status === 'downloaded') return state;
              return publish(available());
            },
            download: async () => {
              downloadCalls += 1;
              if (downloadCalls === 1) return publish({ ...available(), status: 'error', error: 'download interrupted' });
              return publish({ ...available(), status: 'downloaded', progress: 100 });
            },
            restart: async () => state,
            onEvent: (listener: (next: MockUpdateState) => void) => {
              listeners.push(listener);
              return () => {
                const index = listeners.indexOf(listener);
                if (index >= 0) listeners.splice(index, 1);
              };
            },
          },
        },
      });
    });

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('startup metadata unavailable');

    await page.evaluate(() => { (window as any).__nexusTestAllowUpdateRetry = true; });
    await page.getByRole('button', { name: 'Check again' }).click();
    // A small dot beside the version, not a banner above the work; its popover has the same actions.
    await expect(page.getByText('A new version of ContextSpace is available')).toHaveCount(0);
    await page.getByTestId('update-dot').click();
    await expect(page.getByText('A new version of ContextSpace is available')).toBeVisible();
    await page.getByText('Release notes').click();
    await expect(page.getByText('Safer desktop updates')).toBeVisible();

    await page.getByRole('button', { name: 'Download update' }).click();
    await expect(page.getByRole('button', { name: 'Retry download' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('download interrupted');
    // The failed state is named and drawn in the warning colour, not the normal one.
    await expect(page.getByTestId('update-dot')).toHaveAttribute('aria-label', 'Update needs attention');
    await expect(page.getByTestId('update-dot-mark')).toHaveClass(/state-needs/);

    await page.getByRole('button', { name: 'Retry download' }).click();
    await expect(page.getByRole('button', { name: 'Restart & Install' })).toBeVisible();
    await page.getByRole('button', { name: 'Later' }).click();
    await expect(page.getByTestId('update-dot')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Check for updates' })).toBeVisible();

    // A later manual check is allowed to show the same update again; Later is
    // a session preference, not a forced install or a permanent dismissal.
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await page.getByTestId('update-dot').click();
    await expect(page.getByText('Update ready to install').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restart & Install' })).toBeVisible();
  });

  test.describe('browser mode', () => {
    test.use({
      updateStatusData: {
        currentVersion: '2.10.0',
        latestVersion: '2.11.0',
        updateAvailable: true,
        releaseUrl: 'https://github.com/antan87/Context-Space/releases/latest',
        releaseNotes: 'Browser can read these notes',
      },
    });

    test('keeps manual status but exposes no native install controls', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Check for updates' })).toBeVisible();
      await page.getByTestId('update-dot').click();
      await expect(page.getByRole('link', { name: 'View release' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Download update|Retry download|Restart & Install/ })).toHaveCount(0);
    });
  });

  test.describe('the update dot', () => {
    test.use({
      updateStatusData: {
        currentVersion: '2.10.0',
        latestVersion: '2.11.0',
        updateAvailable: true,
        releaseUrl: 'https://github.com/antan87/Context-Space/releases/latest',
        releaseNotes: 'Browser can read these notes',
      },
    });

    test('is a small dot beside the version, opens Release notes, View release and Later by keyboard, and Later hides it', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto('/#/overview');
      const dot = page.getByTestId('update-dot');
      await expect(dot).toBeVisible();
      const box = (await dot.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(28);
      // No banner pushes the page down.
      await expect(page.getByRole('button', { name: 'Later' })).toHaveCount(0);
      await dot.focus();
      await page.keyboard.press('Enter');
      // Release notes opens with the keyboard.
      const notes = page.getByText('Release notes', { exact: true });
      await expect(notes).toBeVisible();
      await expect(page.getByText('Browser can read these notes')).toBeHidden();
      await notes.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByText('Browser can read these notes')).toBeVisible();
      const release = page.getByRole('link', { name: 'View release' });
      await expect(release).toHaveAttribute('href', /releases/);
      await release.focus();
      await expect(release).toBeFocused();
      // Opening it goes to the release page in a new tab.
      const popup = page.waitForEvent('popup');
      await page.route('https://github.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>release</title>' }));
      await page.keyboard.press('Enter');
      expect((await popup).url()).toMatch(/github\.com\/antan87\/Context-Space\/releases/);
      // Later hides the dot, pressed with the keyboard.
      await page.getByRole('button', { name: 'Later' }).focus();
      await page.keyboard.press('Enter');
      await expect(dot).toHaveCount(0);
    });

    test('pulses a few times the first time a version is seen, then rests', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto('/#/overview');
      const mark = page.getByTestId('update-dot-mark');
      await expect(mark).toBeVisible();
      expect(await mark.evaluate((el) => getComputedStyle(el).animationName)).toBe('pulse');
      expect(await mark.evaluate((el) => getComputedStyle(el).animationIterationCount)).toBe('3');
      // The same version again: remembered, so it does not pulse.
      await page.reload();
      await expect(page.getByTestId('update-dot-mark')).toBeVisible();
      expect(await page.getByTestId('update-dot-mark').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    });

    test('with reduced motion does not pulse and says so once, politely', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/#/overview');
      await expect(page.getByTestId('update-dot-mark')).toBeVisible();
      expect(await page.getByTestId('update-dot-mark').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
      const live = page.locator('[role="status"][aria-live="polite"]').filter({ hasText: 'Update available: v2.11.0' });
      await expect(live).toHaveCount(1);
      await expect(live).toHaveText('Update available: v2.11.0');
      await page.reload();
      await expect(page.getByTestId('update-dot-mark')).toBeVisible();
      await expect(page.locator('[role="status"]').filter({ hasText: 'Update available: v2.11.0' })).toHaveCount(0);
    });
  });
});
