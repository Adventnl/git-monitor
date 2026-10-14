import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:1420', viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run frontend:dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'windows', use: { browserName: 'chromium' } },
    { name: 'mac', use: { browserName: 'webkit', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' } },
  ],
});
