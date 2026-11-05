import { defineConfig } from "@playwright/test"

export default defineConfig({
    testDir: "./tests/e2e",
    // The real embed loads a large editor bundle; allow slow first paints.
    timeout: 120_000,
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? [["list"], ["html"]] : "html",
    webServer: {
        command: process.env.CI ? "npm run start" : "npm run dev",
        port: process.env.CI ? 6001 : 6002,
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
    },
    use: {
        baseURL: process.env.CI
            ? "http://localhost:6001"
            : "http://localhost:6002",
        trace: "on-first-retry",
        // embed.diagrams.net rejects the default HeadlessChrome user agent
        // with HTTP 403, which leaves the editor iframe permanently hidden.
        userAgent:
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    },
    projects: [
        {
            name: "chromium",
            use: { browserName: "chromium" },
        },
    ],
})
