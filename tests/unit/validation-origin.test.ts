import { describe, expect, it } from "vitest"
import { isSameOrigin } from "@/lib/validation/origin"

function request(headers: Record<string, string>): Request {
    return new Request("http://draw.example.com/api/diagrams", {
        method: "POST",
        headers,
    })
}

describe("isSameOrigin", () => {
    it("allows requests without an Origin header (non-browser clients)", () => {
        expect(isSameOrigin(request({ host: "draw.example.com" }))).toBe(true)
    })

    it("allows a matching Origin and Host pair", () => {
        expect(
            isSameOrigin(
                request({
                    origin: "http://draw.example.com",
                    host: "draw.example.com",
                }),
            ),
        ).toBe(true)
    })

    it("rejects a cross-site Origin", () => {
        expect(
            isSameOrigin(
                request({
                    origin: "https://evil.example",
                    host: "draw.example.com",
                }),
            ),
        ).toBe(false)
    })

    it("rejects a malformed Origin", () => {
        expect(
            isSameOrigin(
                request({ origin: "not a url", host: "draw.example.com" }),
            ),
        ).toBe(false)
    })

    it("rejects when the Host header is missing", () => {
        expect(
            isSameOrigin(request({ origin: "http://draw.example.com" })),
        ).toBe(false)
    })
})
