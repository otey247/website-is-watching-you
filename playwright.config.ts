import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? (process.env.CI ? undefined : '/opt/pw-browsers/chromium');

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  // Software WebGL (SwiftShader) renders slowly; scenarios that simulate minutes of play need room.
  timeout: 420_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      executablePath,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium' }, testIgnore: /mobile\.spec/ },
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' }, testMatch: /mobile\.spec/ },
  ],
  webServer: {
    // A production build: test hooks are enabled by the ?test query, and source edits cannot hot-reload mid-run.
    command: 'npx vite build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
