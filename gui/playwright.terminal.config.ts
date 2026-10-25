import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './terminal-e2e',
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4187', trace: 'retain-on-failure' },
  webServer: { command: 'node terminal-e2e/server.mjs', url: 'http://127.0.0.1:4187/api/workspaces', reuseExistingServer: false },
});
