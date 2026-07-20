import { defineConfig } from '@playwright/test'

const isCi = Boolean(process.env.CI)

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  timeout: 45_000,
  reporter: isCi ? 'line' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3212',
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'TRASHPAL_LOCAL_DEMO_PORT=3213 pnpm demo:api',
      url: 'http://127.0.0.1:3213/v1/operator/cases',
      reuseExistingServer: !isCi,
      timeout: 120_000,
    },
    {
      command: 'TRASHPAL_LOCAL_DEMO_PORT=3213 pnpm --filter @trashpal/web dev -- --host 127.0.0.1 --port 3212',
      url: 'http://127.0.0.1:3212',
      reuseExistingServer: !isCi,
      timeout: 60_000,
    },
  ],
})
