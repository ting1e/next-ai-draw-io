import { NextResponse } from "next/server"
import { guardAuth } from "@/lib/auth/server"
import { createRateLimiter } from "@/lib/rate-limit"
import { allowPrivateUrls, isPrivateUrl } from "@/lib/ssrf-protection"
import {
    OPENAI_COMPATIBLE_MODEL_LIST_PROVIDERS,
    PROVIDER_INFO,
    type ProviderName,
} from "@/lib/types/model-config"
import { readJsonBody } from "@/lib/validation/http"

export const runtime = "nodejs"

const MAX_BODY_BYTES = 64 * 1024
const MAX_BASE_URL_LENGTH = 2048
const UPSTREAM_TIMEOUT_MS = 10_000
// Never let the platform follow redirects for us - a public host could bounce
// the request to an internal one after our initial SSRF check. Follow manually
// and re-validate every hop instead.
const MAX_REDIRECTS = 3
// Model lists are only used to populate a picker; cap the upstream payload so a
// malicious/compromised endpoint cannot stream an unbounded body into memory.
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_MODELS_RETURNED = 500
// Best-effort throttle (per authenticated user, else per client IP); see
// lib/rate-limit.ts for the serverless caveats.
const modelsLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 })

interface ProviderModelsRequest {
    provider?: string
    baseUrl?: string
    apiKey?: string
}

/**
 * Extracts model IDs from the common list shapes:
 * - OpenAI-compatible: `{ data: [{ id }] }`
 * - Variants seen in the wild: `{ models: [...] }` or a bare array
 * - Items may be strings or objects with `id` / `model` / `name`
 *
 * Values are treated as opaque text; they are never interpolated into HTML or
 * executed, and the caller renders them as plain text.
 */
function extractModelIds(payload: unknown): string[] {
    let items: unknown[] = []
    if (Array.isArray(payload)) {
        items = payload
    } else if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>
        if (Array.isArray(record.data)) items = record.data
        else if (Array.isArray(record.models)) items = record.models
    }

    const ids = new Set<string>()
    for (const item of items) {
        if (typeof item === "string") {
            if (item.trim()) ids.add(item.trim())
            continue
        }
        if (item && typeof item === "object") {
            const record = item as Record<string, unknown>
            const id = record.id ?? record.model ?? record.name
            if (typeof id === "string" && id.trim()) ids.add(id.trim())
        }
    }
    return Array.from(ids).sort((a, b) => a.localeCompare(b))
}

function describeUpstreamError(response: Response): string {
    if (response.status === 401 || response.status === 403) {
        return "Invalid API key"
    }
    if (response.status === 404) {
        return "Model list endpoint not found - this API may not support listing models"
    }
    if (response.status === 429) {
        return "Rate limited - try again later"
    }
    return `Model list request failed with status ${response.status}`
}

/**
 * Validates a user-supplied (or redirect-supplied) URL and returns it only when
 * it is safe for the server to request.
 *
 * SECURITY: `isPrivateUrl` resolves DNS and checks every returned address, so
 * public-looking names mapping to internal IPs are caught. It cannot close the
 * DNS-rebinding TOCTOU window between this check and the later connection, and
 * `allowPrivateUrls()` defaults to true for self-hosted convenience - public
 * deployments must set ALLOW_PRIVATE_URLS=false (the shipped compose files do).
 */
async function resolveSafeTarget(
    raw: string,
): Promise<{ url: URL } | { error: string }> {
    const trimmed = raw.trim()
    if (!trimmed) return { error: "Base URL is required" }
    if (trimmed.length > MAX_BASE_URL_LENGTH) {
        return { error: "Base URL is too long" }
    }

    let url: URL
    try {
        url = new URL(trimmed)
    } catch {
        return { error: "Invalid base URL" }
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { error: "Invalid base URL" }
    }
    // Embedded credentials would be forwarded and could leak into logs.
    if (url.username || url.password) {
        return { error: "Base URL must not contain credentials" }
    }
    if (!allowPrivateUrls() && (await isPrivateUrl(url.toString()))) {
        return { error: "Invalid base URL" }
    }

    return { url }
}

/**
 * Reads a JSON body while enforcing a hard byte cap. Without this a malicious
 * endpoint could stream an unbounded body into memory.
 */
async function readCappedJson(
    response: Response,
    maxBytes: number,
): Promise<{ data: unknown } | { error: string }> {
    const declaredLength = Number(response.headers.get("content-length") || 0)
    if (declaredLength > maxBytes) return { error: "Response too large" }

    const reader = response.body?.getReader()
    if (!reader) {
        const text = await response.text()
        if (Buffer.byteLength(text, "utf8") > maxBytes) {
            return { error: "Response too large" }
        }
        try {
            return { data: JSON.parse(text) }
        } catch {
            return { error: "Invalid JSON response" }
        }
    }

    const chunks: Uint8Array[] = []
    let total = 0
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value) continue
            total += value.byteLength
            if (total > maxBytes) {
                await reader.cancel()
                return { error: "Response too large" }
            }
            chunks.push(value)
        }
    } catch {
        return { error: "Failed to read response" }
    }

    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
    }
    try {
        return { data: JSON.parse(new TextDecoder().decode(merged)) }
    } catch {
        return { error: "Invalid JSON response" }
    }
}

/**
 * GETs a model list, following at most MAX_REDIRECTS redirects and re-running
 * the SSRF validation on every hop. The API key is only sent to the original
 * origin: a redirect to a different host must not receive the credentials.
 */
async function fetchModelList(
    initial: URL,
    apiKey: string | undefined,
): Promise<{ response: Response } | { error: string }> {
    let current = initial
    // One deadline for the whole redirect chain, not per hop.
    const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const headers: Record<string, string> = {
            Accept: "application/json",
        }
        // Some local gateways (SGLang, LM Studio) list models without a key -
        // only send the header when one is configured.
        if (apiKey && current.origin === initial.origin) {
            headers.Authorization = `Bearer ${apiKey}`
        }

        const response = await fetch(current.toString(), {
            method: "GET",
            headers,
            cache: "no-store",
            redirect: "manual",
            signal,
        })

        const isRedirect = response.status >= 300 && response.status < 400
        if (!isRedirect) return { response }

        // Drain the redirect body so the connection can be reused.
        const body = response.body
        if (body) {
            body.cancel().catch(() => {
                /* ignore */
            })
        }

        const location = response.headers.get("location")
        if (!location) return { response }
        if (hop === MAX_REDIRECTS) {
            return { error: "Too many redirects" }
        }

        let nextUrl: string
        try {
            nextUrl = new URL(location, current).toString()
        } catch {
            return { error: "Invalid redirect target" }
        }

        const target = await resolveSafeTarget(nextUrl)
        if ("error" in target) {
            // Do not echo the blocked target back to the client.
            return { error: "Invalid redirect target" }
        }
        current = target.url
    }

    return { error: "Too many redirects" }
}

function clientIdentity(req: Request, userId: string | null): string {
    if (userId) return `user:${userId}`
    const forwarded = req.headers.get("x-forwarded-for")
    const ip = forwarded?.split(",")[0]?.trim()
    return `ip:${ip || "unknown"}`
}

/**
 * Generic "fetch models" endpoint for user-configured providers.
 *
 * First version supports OpenAI-compatible APIs: the model list is read from
 * `GET {baseUrl}/models` with a Bearer token, which covers OpenAI, DeepSeek,
 * SiliconFlow, OpenRouter, Qwen, GLM, Kimi, ModelScope, Doubao, Novita and
 * other compatible gateways. Special APIs (Anthropic, Google, Ollama,
 * Bedrock) can be added to the same switch later.
 *
 * Security mirrors /api/validate-model: guardAuth(), strict body limits, a
 * best-effort rate limit, and SSRF protection on the effective base URL and on
 * every redirect hop (private URLs require ALLOW_PRIVATE_URLS, enabling
 * Ollama / LM Studio style local endpoints). The API key travels only in the
 * Authorization header and is never logged or returned.
 */
export async function POST(req: Request) {
    try {
        const auth = await guardAuth()
        if (auth.denied) return auth.denied

        const limit = modelsLimiter.check(
            clientIdentity(req, auth.user?.id ?? null),
        )
        if (!limit.ok) {
            return NextResponse.json(
                { models: [], error: "Too many requests - try again shortly" },
                {
                    status: 429,
                    headers: {
                        "Retry-After": String(limit.retryAfterSeconds ?? 60),
                    },
                },
            )
        }

        const bodyResult = await readJsonBody(req, MAX_BODY_BYTES)
        if (!bodyResult.ok) {
            return NextResponse.json(
                { error: bodyResult.error },
                { status: bodyResult.status },
            )
        }
        const body = (bodyResult.data ?? {}) as ProviderModelsRequest
        const { provider, baseUrl, apiKey } = body

        if (
            !provider ||
            !OPENAI_COMPATIBLE_MODEL_LIST_PROVIDERS.includes(
                provider as ProviderName,
            )
        ) {
            return NextResponse.json(
                {
                    error: `Model listing is not supported for provider: ${provider || "unknown"}`,
                },
                { status: 400 },
            )
        }

        const effectiveBaseUrl = (
            baseUrl ||
            PROVIDER_INFO[provider as ProviderName]?.defaultBaseUrl ||
            ""
        ).trim()
        if (!effectiveBaseUrl) {
            return NextResponse.json(
                { error: `No base URL configured for provider: ${provider}` },
                { status: 400 },
            )
        }

        const target = await resolveSafeTarget(
            `${effectiveBaseUrl.replace(/\/+$/, "")}/models`,
        )
        if ("error" in target) {
            return NextResponse.json({ error: target.error }, { status: 400 })
        }

        const fetched = await fetchModelList(target.url, apiKey)
        if ("error" in fetched) {
            return NextResponse.json(
                { models: [], error: fetched.error },
                { status: 200 },
            )
        }

        const response = fetched.response
        if (!response.ok) {
            return NextResponse.json(
                { models: [], error: describeUpstreamError(response) },
                { status: 200 },
            )
        }

        const parsed = await readCappedJson(response, MAX_RESPONSE_BYTES)
        if ("error" in parsed) {
            return NextResponse.json(
                { models: [], error: parsed.error },
                { status: 200 },
            )
        }

        const models = extractModelIds(parsed.data).slice(
            0,
            MAX_MODELS_RETURNED,
        )
        if (models.length === 0) {
            return NextResponse.json(
                { models: [], error: "The API returned an empty model list" },
                { status: 200 },
            )
        }

        return NextResponse.json(
            { models },
            { headers: { "Cache-Control": "no-store" } },
        )
    } catch (error) {
        // Never log the request URL (it could contain query secrets); the API
        // key lives in the Authorization header and is not part of the error.
        console.warn(
            "[provider-models] Failed to fetch models:",
            error instanceof Error ? error.message : "unknown error",
        )
        const message = error instanceof Error ? error.message : ""
        const friendly =
            message.toLowerCase().includes("timeout") ||
            message.toLowerCase().includes("abort")
                ? "Request timed out"
                : "Could not reach the model list endpoint"
        return NextResponse.json(
            { models: [], error: friendly },
            { status: 200 },
        )
    }
}
