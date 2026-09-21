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
})
