import { defineConfig, devices } from '@playwright/test';

// Browser-level end-to-end tests. These run a real Chromium against the built server and are
// the only tests that exercise client-side behaviour — the HTTP tests under test/ only read the
// returned HTML and never open a browser. Kept in test/browser with a `.spec.ts` suffix so
// Node's own test runner (which globs test/**/*.test.ts) never picks them up, and vice versa.
export default defineConfig({
  testDir: './test/browser',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
