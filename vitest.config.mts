import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import tsconfigPaths from "vite-tsconfig-paths"
import { defineConfig } from "vitest/config"

export default defineConfig({
    plugins: [tsconfigPaths(), react()],
    resolve: {
        alias: {
            // `server-only` throws when imported outside the react-server
            // condition; alias it to the no-op entry for unit tests.
            "server-only": fileURLToPath(
                new URL("./node_modules/server-only/empty.js", import.meta.url),
            ),
        },
    },
    test: {
        environment: "jsdom",
        include: ["tests/**/*.test.{ts,tsx}"],
        coverage: {
            provider: "v8",
            reporter: ["text", "json", "html"],
            include: ["lib/**/*.ts", "app/**/*.ts", "app/**/*.tsx"],
            exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.d.ts"],
        },
    },
})
