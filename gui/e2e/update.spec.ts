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
    await expect(page.getByText('A new version of ContextSpace is available!')).toBeVisible();
    await page.getByText('Release notes').click();
    await expect(page.getByText('Safer desktop updates')).toBeVisible();

    await page.getByRole('button', { name: 'Download update' }).click();
    await expect(page.getByRole('button', { name: 'Retry download' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('download interrupted');

    await page.getByRole('button', { name: 'Retry download' }).click();
    await expect(page.getByRole('button', { name: 'Restart & Install' })).toBeVisible();
    await page.getByRole('button', { name: 'Later' }).click();
    await expect(page.getByRole('button', { name: 'Check for updates' })).toBeVisible();

    // A later manual check is allowed to show the same update again; Later is
    // a session preference, not a forced install or a permanent dismissal.
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(page.getByText('Update ready to install')).toBeVisible();
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
      await expect(page.getByRole('link', { name: 'View release' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Download update|Retry download|Restart & Install/ })).toHaveCount(0);
    });
  });
});
