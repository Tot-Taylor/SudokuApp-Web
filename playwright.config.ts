import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: 'tests/browser',
  use: { baseURL, actionTimeout: 5000, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'narrow-iphone-webkit', use: { ...devices['iPhone SE (3rd gen)'], viewport: { width: 320, height: 640 } } },
  ],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort',
    url: baseURL,
  },
});
