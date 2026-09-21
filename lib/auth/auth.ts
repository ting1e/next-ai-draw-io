import "server-only"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { sql } from "drizzle-orm"
import { getDb } from "@/lib/db"
import * as schema from "@/lib/db/schema"

export function isAuthEnabled(): boolean {
    return Boolean(process.env.AUTH_SECRET)
}

export function isRegistrationAllowed(): boolean {
    return process.env.ALLOW_REGISTRATION === "true"
}

export function isEmailVerificationRequired(): boolean {
    return process.env.REQUIRE_EMAIL_VERIFICATION === "true"
}

export function countUsers(): number {
    const row = getDb()
        .select({ count: sql<number>`count(*)` })
        .from(schema.user)
        .get()
    return row?.count ?? 0
}

function getTrustedOrigins(): string[] {
    const origins = new Set<string>()
    const baseUrl = process.env.AUTH_BASE_URL || process.env.BETTER_AUTH_URL
    if (baseUrl) origins.add(baseUrl.replace(/\/$/, ""))
    const extra = process.env.AUTH_TRUSTED_ORIGINS
    if (extra) {
        for (const origin of extra.split(",")) {
            const trimmed = origin.trim()
            if (trimmed) origins.add(trimmed.replace(/\/$/, ""))
        }
    }
    return [...origins]
}

async function createAuth() {
    return betterAuth({
        appName: "Next AI Draw.io",
        secret: process.env.AUTH_SECRET,
        baseURL: process.env.AUTH_BASE_URL || process.env.BETTER_AUTH_URL,
        database: drizzleAdapter(getDb(), {
            provider: "sqlite",
            schema: {
                user: schema.user,
                session: schema.session,
                account: schema.account,
                verification: schema.verification,
            },
        }),
        emailAndPassword: {
            enabled: true,
            minPasswordLength: 8,
            maxPasswordLength: 128,
            requireEmailVerification: isEmailVerificationRequired(),
        },
        session: {
            expiresIn: 60 * 60 * 24 * 30,
            updateAge: 60 * 60 * 24,
            cookieCache: {
                enabled: true,
                maxAge: 5 * 60,
            },
        },
        trustedOrigins: getTrustedOrigins(),
        rateLimit: {
            enabled: true,
            window: 60,
            max: 60,
            customRules: {
                "/sign-in/email": { window: 60, max: 5 },
                "/sign-up/email": { window: 60, max: 5 },
                "/change-password": { window: 60, max: 5 },
            },
        },
        databaseHooks: {
            user: {
                create: {
                    before: async () => {
                        if (isRegistrationAllowed()) return
                        // First user is created through /setup; everything else
                        // is rejected while public registration is disabled.
                        if (countUsers() > 0) return false
                    },
                },
            },
        },
    })
}

export type AuthInstance = Awaited<ReturnType<typeof createAuth>>

let authPromise: Promise<AuthInstance> | null = null

export function getAuth(): Promise<AuthInstance> {
    if (!isAuthEnabled()) {
        throw new Error("Auth is not enabled: AUTH_SECRET is not set")
    }
    if (!authPromise) {
        authPromise = createAuth()
    }
    return authPromise
}
