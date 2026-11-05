import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.E2E_SERVER_PORT || 6003)
const baseURL = `http://127.0.0.1:${port}`
const databaseDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "next-ai-draw-io-e2e-server-"),
)
const databasePath = path.join(databaseDir, "app.sqlite")
const isCI = Boolean(process.env.CI)

/**
 * Server-storage E2E suite. The regular Playwright config intentionally runs
 * in legacy IndexedDB mode; this config boots the same build with auth and a
 * throwaway SQLite database so autosave is exercised through the real API.
 */
export default defineConfig({
    testDir: "./tests/e2e-server",
    outputDir: "test-results/server",
    fullyParallel: false,
    workers: 1,
    forbidOnly: isCI,
    retries: isCI ? 1 : 0,
    reporter: isCI ? "list" : "html",
    webServer: {
        // Run the production server so the suite matches CI and the real
        // self-hosted deployment. Run `npm run build` first when testing locally.
        command: `node scripts/migrate.mjs && npx next start --port ${port}`,
        url: `${baseURL}/api/health`,
        reuseExistingServer: !isCI,
        timeout: 180_000,
        env: {
            DATABASE_PATH: databasePath,
            AUTH_SECRET: "e2e-server-secret-0123456789abcdef0123456789abcdef",
            AUTH_BASE_URL: baseURL,
            ALLOW_REGISTRATION: "true",
        },
    },
    use: {
        baseURL,
        trace: "on-first-retry",
    },
    projects: [
        {
            name: "chromium-server",
            use: { browserName: "chromium" },
        },
    ],
})
