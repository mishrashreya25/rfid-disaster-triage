import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 90000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: 'artifacts/test-results',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    viewport: { width: 1440, height: 1050 },
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
    launchOptions: { channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: 'node scripts/e2e-server.js', url: 'http://127.0.0.1:3002/api/health', reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js --port 5174', url: 'http://127.0.0.1:5174', env: { RFID_API_TARGET: 'http://127.0.0.1:3002' }, reuseExistingServer: false },
  ],
});
