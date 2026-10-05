import { defineConfig, devices } from "@playwright/test";

const APP_PORT = 3100;
export const APP_PASSWORD = "e2e-password";

export default defineConfig({
  testDir: "e2e",
  // Tests share one database and the default profile, so run them in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${APP_PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/support/services.mjs",
      url: "http://127.0.0.1:3199/health",
      reuseExistingServer: false,
    },
    {
      // Production build, as deployed. Set E2E_SKIP_BUILD=1 to reuse an existing .next build.
      command: `${process.env.E2E_SKIP_BUILD ? "" : "node node_modules/next/dist/bin/next build && "}node node_modules/next/dist/bin/next start -p ${APP_PORT}`,
      url: `http://localhost:${APP_PORT}/login`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: "postgres://postgres@127.0.0.1:54329/postgres",
        APP_PASSWORD,
        BGG_API_TOKEN: "e2e-token",
        BGG_API_BASE: "http://127.0.0.1:3199/xmlapi2",
        DEFAULT_PROFILE: "galeswift",
      },
    },
  ],
});
