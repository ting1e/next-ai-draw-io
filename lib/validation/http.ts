export type JsonBodyResult =
    | { ok: true; data: unknown }
    | { ok: false; status: number; error: string }

/**
 * Reads and parses a JSON request body while enforcing a hard byte limit.
 * Route handlers do not enforce a body limit by default, so large payloads
 * must be rejected explicitly.
 */
export async function readJsonBody(
    request: Request,
    maxBytes: number,
): Promise<JsonBodyResult> {
    const declaredLength = Number(request.headers.get("content-length") || 0)
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        return { ok: false, status: 413, error: "Payload too large" }
    }

    let text: string
    try {
        if (!request.body) {
            text = ""
        } else {
            // Read incrementally instead of request.text(): a chunked request
            // without Content-Length must be rejected as soon as it crosses
            // the limit, before the whole body is buffered in memory.
            const reader = request.body.getReader()
            const decoder = new TextDecoder()
            const chunks: string[] = []
            let receivedBytes = 0

            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    if (!value) continue

                    receivedBytes += value.byteLength
                    if (receivedBytes > maxBytes) {
                        await reader.cancel().catch(() => {})
                        return {
                            ok: false,
                            status: 413,
                            error: "Payload too large",
                        }
                    }
                    chunks.push(decoder.decode(value, { stream: true }))
                }
                chunks.push(decoder.decode())
                text = chunks.join("")
            } finally {
                reader.releaseLock()
            }
        }
    } catch {
        return { ok: false, status: 400, error: "Unable to read request body" }
    }

    try {
        return { ok: true, data: JSON.parse(text) }
    } catch {
        return { ok: false, status: 400, error: "Invalid JSON" }
    }
}
