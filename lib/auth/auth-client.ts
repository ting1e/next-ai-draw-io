"use client"

import { createAuthClient } from "better-auth/react"
import { getApiEndpoint } from "@/lib/base-path"

/**
 * Better Auth browser client. The auth endpoints are mounted under the
 * Next.js base path so subdirectory deployments keep working.
 */
export const authClient = createAuthClient({
    baseURL: typeof window !== "undefined" ? window.location.origin : undefined,
    basePath: getApiEndpoint("/api/auth"),
})
