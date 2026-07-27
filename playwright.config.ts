import { defineConfig } from "@playwright/test";

// E2E suite: runs against a real production build + PostgreSQL (see
// .github/workflows/e2e.yml). Single worker — specs share one database and
// exercise cross-user flows, so parallel workers would race each other.
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3998",
    trace: "retain-on-failure",
    // Sandboxed dev environments can pin a chromium binary; CI leaves this
    // unset and uses the browsers `npx playwright install` fetched.
    ...(process.env.E2E_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } }
      : {}),
  },
});
