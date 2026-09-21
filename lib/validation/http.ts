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
    if (declaredLength > maxBytes) {
        return { ok: false, status: 413, error: "Payload too large" }
    }

    let text: string
    try {
        text = await request.text()
    } catch {
        return { ok: false, status: 400, error: "Unable to read request body" }
    }

    if (Buffer.byteLength(text, "utf8") > maxBytes) {
        return { ok: false, status: 413, error: "Payload too large" }
    }

    try {
        return { ok: true, data: JSON.parse(text) }
    } catch {
        return { ok: false, status: 400, error: "Invalid JSON" }
    }
}
