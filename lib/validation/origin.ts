/**
 * Best-effort same-origin check for state-changing requests. This is a
 * defense-in-depth layer on top of Better Auth's cookie security model.
 */
export function isSameOrigin(request: Request): boolean {
    const origin = request.headers.get("origin")
    if (!origin) return true

    const host = request.headers.get("host")
    if (!host) return false

    try {
        return new URL(origin).host === host
    } catch {
        return false
    }
}
