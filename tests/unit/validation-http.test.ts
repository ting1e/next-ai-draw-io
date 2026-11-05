import { describe, expect, it } from "vitest"
import { readJsonBody } from "@/lib/validation/http"

function jsonRequest(body: string, contentLength?: string): Request {
    const headers = new Headers({ "Content-Type": "application/json" })
    if (contentLength !== undefined) {
        headers.set("Content-Length", contentLength)
    }
    return new Request("http://localhost/api/test", {
        method: "POST",
        headers,
        body,
    })
}

/**
 * Minimal Request stand-in for chunked bodies. A real Request with a
 * ReadableStream body requires the non-standard `duplex` option, while
 * readJsonBody only reads `headers` and `body`.
 */
function streamRequest(
    chunks: Uint8Array[],
    onCancel?: () => void,
    close = true,
): Request {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            if (close) controller.close()
        },
        cancel() {
            onCancel?.()
        },
    })
    return {
        headers: new Headers({ "Content-Type": "application/json" }),
        body,
    } as unknown as Request
}

describe("readJsonBody", () => {
    it("parses a valid JSON body", async () => {
        const result = await readJsonBody(jsonRequest('{"ok":true}'), 1024)
        expect(result).toEqual({ ok: true, data: { ok: true } })
    })

    it("rejects a declared content length above the limit with 413", async () => {
        const result = await readJsonBody(
            jsonRequest('{"a":1}', String(10 * 1024 * 1024)),
            1024,
        )
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(413)
    })

    it("rejects an undeclared body above the limit with 413", async () => {
        const body = JSON.stringify({ pad: "x".repeat(4096) })
        const result = await readJsonBody(jsonRequest(body), 1024)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(413)
    })

    it("rejects malformed JSON with 400", async () => {
        const result = await readJsonBody(jsonRequest("{not json"), 1024)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(400)
    })

    it("stops reading a chunked body as soon as it exceeds the limit", async () => {
        let cancelled = false
        const encoder = new TextEncoder()
        const result = await readJsonBody(
            streamRequest(
                [encoder.encode('{"pad":"'), encoder.encode("x".repeat(4096))],
                () => {
                    cancelled = true
                },
                false,
            ),
            1024,
        )
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(413)
        expect(cancelled).toBe(true)
    })

    it("decodes multi-byte characters split across chunks", async () => {
        const encoder = new TextEncoder()
        const bytes = encoder.encode('{"value":"图"}')
        const splitAt = bytes.indexOf(0xe5) + 1
        const result = await readJsonBody(
            streamRequest([bytes.slice(0, splitAt), bytes.slice(splitAt)]),
            1024,
        )
        expect(result).toEqual({ ok: true, data: { value: "图" } })
    })
})
