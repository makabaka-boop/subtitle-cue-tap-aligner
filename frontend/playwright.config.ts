import { defineConfig, devices } from "@playwright/test";

// In CI / the verify service PLAYWRIGHT_BASE_URL points at a stack that is
// already running; otherwise Playwright starts the Vite dev server itself.
const baseURL = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "list" : undefined,
  use: {
    baseURL: baseURL ?? "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      // Use the full Chromium build (works with the browsers shipped in the
      // Playwright Docker image as well as a local `playwright install`).
      use: { ...devices["Desktop Chrome"], channel: "chromium" },
    },
  ],
  webServer: baseURL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:5173",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
