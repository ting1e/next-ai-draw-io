import "server-only"
import { headers } from "next/headers"
import { getAuth, isAuthEnabled } from "./auth"

export interface SessionUser {
    id: string
    email: string
    name: string
    role?: string | null
}

/**
 * Returns the authenticated user or null. Never trust client-supplied
 * user/owner identifiers - this is the single source of identity.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
    if (!isAuthEnabled()) return null
    const auth = await getAuth()
    const session = await auth.api.getSession({
        headers: await headers(),
    })
    if (!session?.user) return null
    return {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role: (session.user as { role?: string | null }).role ?? null,
    }
}

export type AuthGuardResult =
    | { denied: Response; user?: never }
    | { denied?: never; user: SessionUser | null }

/**
 * Guards business API routes that are public in legacy (no-auth) mode but
 * must require a session as soon as AUTH_SECRET is configured. Returns the
 * session user so callers can key quotas/telemetry on the real identity
 * instead of client-supplied headers.
 */
export async function guardAuth(): Promise<AuthGuardResult> {
    if (!isAuthEnabled()) return { user: null }
    const user = await getSessionUser()
    if (!user) {
        return {
            denied: Response.json({ error: "Unauthorized" }, { status: 401 }),
        }
    }
    return { user }
}
