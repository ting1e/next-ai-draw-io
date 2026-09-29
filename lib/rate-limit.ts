/**
 * Minimal in-memory fixed-window rate limiter.
 *
 * Best effort only: state lives in the process, so on serverless or
 * multi-instance deployments every instance enforces its own window and a cold
 * start resets it. It exists to blunt accidental request storms (e.g. a client
 * hammering a "fetch models" button) and is NOT an authorization control.
 */
export interface RateLimitResult {
    ok: boolean
    /** Seconds until the window resets, when the limit was hit. */
    retryAfterSeconds?: number
}

export interface RateLimiter {
    check(key: string, now?: number): RateLimitResult
    /** Test helper: drop all tracked windows. */
    reset(): void
}

export function createRateLimiter(options: {
    limit: number
    windowMs: number
}): RateLimiter {
    const hits = new Map<string, { count: number; resetAt: number }>()

    return {
        check(key: string, now = Date.now()): RateLimitResult {
            const entry = hits.get(key)
            if (!entry || entry.resetAt <= now) {
                // Opportunistically evict expired windows so the map cannot
                // grow without bound on a long-lived instance.
                if (hits.size >= 1000) {
                    for (const [existingKey, value] of hits) {
                        if (value.resetAt <= now) hits.delete(existingKey)
                    }
                }
                hits.set(key, { count: 1, resetAt: now + options.windowMs })
                return { ok: true }
            }
            if (entry.count >= options.limit) {
                return {
                    ok: false,
                    retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
                }
            }
            entry.count++
            return { ok: true }
        },
        reset() {
            hits.clear()
        },
    }
}
