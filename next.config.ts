import type { NextConfig } from "next"
import packageJson from "./package.json"

/**
 * Phase-1 CSP. `'unsafe-inline'` is required for Next.js's hydration
 * bootstrap (a nonce-based policy needs middleware and is a later step), but
 * `object-src 'none'`, `connect-src 'self'` and `frame-src` still contain
 * script injection and exfiltration. Skip the draw.io proxy path: the editor
 * is a separate same-origin document that legitimately needs its own inline
 * scripts/workers, and the app-level policy is what protects the host page.
 */
function buildContentSecurityPolicy(): string {
    const frameSrc = new Set(["'self'"])
    const drawioUrl = process.env.NEXT_PUBLIC_DRAWIO_BASE_URL || ""
    if (/^https?:\/\//.test(drawioUrl)) {
        try {
            frameSrc.add(new URL(drawioUrl).origin)
        } catch {
            // Ignore malformed configuration; 'self' still applies.
        }
    }

    const scriptSrc = ["'self'", "'unsafe-inline'"]
    const connectSrc = ["'self'"]
    if (process.env.NEXT_PUBLIC_GA_ID) {
        scriptSrc.push("https://www.googletagmanager.com")
        connectSrc.push("https://www.google-analytics.com")
    }

    return [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'self'",
        "form-action 'self'",
        `script-src ${scriptSrc.join(" ")}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "media-src 'self'",
        `connect-src ${connectSrc.join(" ")}`,
        `frame-src ${[...frameSrc].join(" ")}`,
        "worker-src 'self' blob:",
        "manifest-src 'self'",
    ].join("; ")
}

function securityHeaders(): { key: string; value: string }[] {
    const headers = [
        { key: "X-Content-Type-Options", value: "nosniff" },
        {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
        },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
        },
    ]
    if (process.env.NODE_ENV === "production") {
        headers.push({
            key: "Content-Security-Policy",
            value: buildContentSecurityPolicy(),
        })
    }
    return headers
}

const nextConfig: NextConfig = {
    output: "standalone",
    basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
    env: {
        APP_VERSION: packageJson.version,
    },
    serverExternalPackages: ["better-sqlite3"],
    outputFileTracingIncludes: {
        "*": ["./instrumentation.ts", "./drizzle/**"],
    },
    // lib/server-model-config.ts reads ai-models.json via a dynamic path, which
    // makes Turbopack's file tracing include the whole project in
    // .next/standalone. Keep local data, backups and development-only trees
    // out of the runtime image regardless of what else gets traced.
    outputFileTracingExcludes: {
        "*": [
            "./data/**",
            "./data-security/**",
            "./backups/**",
            "./tests/**",
            "./docs/**",
            "./electron/**",
            "./packages/**",
            "./edge-functions/**",
            "./*.md",
        ],
    },
    async rewrites() {
        // Serve the self-hosted draw.io editor through the app origin
        // (/drawio/*) so the draw.io container never needs a public port.
        // DRAWIO_INTERNAL_URL is read when the config is loaded (build time).
        const drawioInternalUrl =
            process.env.DRAWIO_INTERNAL_URL || "http://drawio:8080"
        return [
            {
                source: "/drawio",
                destination: `${drawioInternalUrl}/index.html`,
            },
            {
                source: "/drawio/:path*",
                destination: `${drawioInternalUrl}/:path*`,
            },
        ]
    },
    async headers() {
        const all = securityHeaders()
        const cspHeaders = all.filter(
            (header) => header.key === "Content-Security-Policy",
        )
        const commonHeaders = all.filter(
            (header) => header.key !== "Content-Security-Policy",
        )

        const rules: {
            source: string
            headers: { key: string; value: string }[]
        }[] = []
        if (cspHeaders.length > 0) {
            // Keep the editor proxy path CSP-free; it is its own document.
            rules.push({ source: "/((?!drawio).*)", headers: cspHeaders })
        }
        rules.push({ source: "/(.*)", headers: commonHeaders })
        return rules
    },
}

export default nextConfig

if (process.env.NODE_ENV === "development") {
    import("@opennextjs/cloudflare").then(
        ({ initOpenNextCloudflareForDev }) => {
            initOpenNextCloudflareForDev()
        },
    )
}
