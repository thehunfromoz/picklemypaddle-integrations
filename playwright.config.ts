import { defineConfig, devices } from '@playwright/test';

// SCRUM-72: walk an order through the admin in a real browser, on a desktop and a phone-sized
// screen. The admin is started by tests/e2e/server.ts; Playwright adds the Tailscale identity
// headers that Tailscale Serve would add in the stacks.
const PORT = Number(process.env.E2E_ADMIN_PORT ?? 4411);

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }], ['./tests/e2e/notice-reporter.ts']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    extraHTTPHeaders: {
      'Tailscale-User-Login': 'e2e-admin@test.picklemypaddle.com',
      'Tailscale-User-Name': 'E2E Admin',
    },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'pnpm exec tsx tests/e2e/server.ts',
    // Answers 403 without the identity headers, which Playwright counts as up.
    url: `http://127.0.0.1:${PORT}/admin/admin.css`,
    env: { E2E_ADMIN_PORT: String(PORT), IMAGE_ENGINE: process.env.IMAGE_ENGINE ?? 'auto' },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
