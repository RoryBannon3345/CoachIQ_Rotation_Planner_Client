import { defineConfig, devices } from '@playwright/test';

/**
 * Cross-browser end-to-end tests for the SHIPPED Client, `dist/CoachIQ_Rotation_Planner_Client.html`,
 * opened from disk. `npm run test:browsers` builds first. Phones and the iPad are Playwright's device
 * emulations (WebKit stands in for iOS Safari); Firefox has no mobile emulation, so it runs at a
 * phone's size. `*.live.spec.mjs` loads the deployed GitHub Pages copy and needs the internet.
 * Run from PowerShell: the Bash tool's sandbox kills browser processes.
 */
const clipboard = { permissions: ['clipboard-read', 'clipboard-write'] };

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'en-US' },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 15'] } },
    { name: 'ipad', use: { ...devices['iPad (gen 7)'] } },
    { name: 'android', use: { ...devices['Pixel 7'], ...clipboard } },
    { name: 'firefox-phone', use: { ...devices['Desktop Firefox'], viewport: { width: 393, height: 852 } } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...clipboard } },
    { name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge', ...clipboard } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
