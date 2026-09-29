import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// guardAuth() short-circuits when auth is disabled (no AUTH_SECRET in
// tests); the next/headers import still needs to resolve.
vi.mock("next/headers", () => ({ headers: vi.fn() }))

// isPrivateUrl() resolves DNS; mock it so redirect/SSRF tests are deterministic
// and never touch the network. Literal private hosts (localhost, 169.254.x)
// still short-circuit before the lookup.
const lookupMock = vi.hoisted(() => vi.fn())
vi.mock("node:dns/promises", () => ({
    default: { lookup: lookupMock },
    lookup: lookupMock,
}))

import { POST } from "@/app/api/provider-models/route"

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    })
}

function redirectResponse(location: string, status = 302): Response {
    return new Response(null, { status, headers: { Location: location } })
}

function makeRequest(
    body: unknown,
    extraHeaders: Record<string, string> = {},
): Request {
    return new Request("http://localhost/api/provider-models", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...extraHeaders },
        body: JSON.stringify(body),
    })
}

describe("POST /api/provider-models", () => {
    const fetchMock = vi.fn()

    beforeEach(() => {
        fetchMock.mockReset()
        lookupMock.mockReset()
        lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }])
        vi.stubGlobal("fetch", fetchMock)
        delete process.env.ALLOW_PRIVATE_URLS
        delete process.env.AUTH_SECRET
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        delete process.env.ALLOW_PRIVATE_URLS
    })

    it("rejects unsupported providers with 400", async () => {
        const response = await POST(makeRequest({ provider: "bedrock" }))
        expect(response.status).toBe(400)
        const data = await response.json()
        expect(data.error).toContain("not supported")
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("rejects a missing provider with 400", async () => {
        const response = await POST(makeRequest({}))
        expect(response.status).toBe(400)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("fetches models from an OpenAI-compatible endpoint and parses {data:[{id}]}", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                data: [
                    { id: "gpt-b" },
                    { id: "gpt-a" },
                    { id: "gpt-a" }, // duplicate
                    { id: "" }, // ignored
                    { object: "embedding" }, // no id -> ignored
                ],
                object: "list",
            }),
        )

        const response = await POST(
            makeRequest({
                provider: "openai",
                baseUrl: "http://127.0.0.1:9/v1",
                apiKey: "sk-test",
            }),
        )
        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.models).toEqual(["gpt-a", "gpt-b"])

        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toBe("http://127.0.0.1:9/v1/models")
        expect((init as RequestInit).headers).toMatchObject({
            Authorization: "Bearer sk-test",
        })
    })

    it("falls back to the provider default base URL and parses variant payloads", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                models: ["glm-5", { name: "glm-air" }],
            }),
        )

        const response = await POST(makeRequest({ provider: "glm" }))
        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.models).toEqual(["glm-5", "glm-air"])

        const [url] = fetchMock.mock.calls[0]
        expect(String(url)).toBe("https://open.bigmodel.cn/api/paas/v4/models")
    })

    it("returns a friendly error for unauthorized upstream responses", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nope" }, 401))

        const response = await POST(
            makeRequest({
                provider: "deepseek",
                baseUrl: "http://127.0.0.1:9/v1",
                apiKey: "bad",
            }),
        )
        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.models).toEqual([])
        expect(data.error).toBe("Invalid API key")
    })

    it("returns an error when the list is empty", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }))

        const response = await POST(
            makeRequest({
                provider: "deepseek",
                baseUrl: "http://127.0.0.1:9/v1",
                apiKey: "sk-test",
            }),
        )
        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.models).toEqual([])
        expect(data.error).toContain("empty")
    })

    it("blocks private base URLs when ALLOW_PRIVATE_URLS=false", async () => {
        process.env.ALLOW_PRIVATE_URLS = "false"

        const response = await POST(
            makeRequest({
                provider: "openai",
                baseUrl: "http://localhost:9/v1",
                apiKey: "sk-test",
            }),
        )
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
            error: "Invalid base URL",
        })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("rejects non-http protocols", async () => {
        const response = await POST(
            makeRequest({
                provider: "openai",
                baseUrl: "file:///etc/passwd",
                apiKey: "sk-test",
            }),
        )
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
            error: "Invalid base URL",
        })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("rejects base URLs containing embedded credentials", async () => {
        const response = await POST(
            makeRequest({
                provider: "openai",
                baseUrl: "https://user:pass@api.example.com/v1",
                apiKey: "sk-test",
            }),
        )
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
            error: "Base URL must not contain credentials",
        })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("rejects an over-long base URL", async () => {
        const response = await POST(
            makeRequest({
                provider: "openai",
                baseUrl: `https://api.example.com/${"a".repeat(3000)}`,
                apiKey: "sk-test",
            }),
        )
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
            error: "Base URL is too long",
        })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("follows redirects but re-validates each hop", async () => {
        fetchMock
            .mockResolvedValueOnce(
                redirectResponse("http://127.0.0.1:9/v1/models"),
            )
            .mockResolvedValueOnce(jsonResponse({ data: [{ id: "m1" }] }))

        const response = await POST(
            makeRequest({
                provider: "openai",
                baseUrl: "http://127.0.0.1:9/v1",
            }),
        )
        expect(response.status).toBe(200)
        expect((await response.json()).models).toEqual(["m1"])
        expect(fetchMock).toHaveBeenCalledTimes(2)
        const [, secondInit] = fetchMock.mock.calls[1]
        expect((secondInit as RequestInit).redirect).toBe("manual")
    })

    it("does not forward the API key across a cross-origin redirect", async () => {
        fetchMock
            .mockResolvedValueOnce(
                redirectResponse("https://evil.example.net/v1/models"),
            )
            .mockResolvedValueOnce(jsonResponse({ data: [{ id: "m1" }] }))

        const response = await POST(
            makeRequest({
                provider: "openai",
                baseUrl: "https://api.example.com/v1",
                apiKey: "sk-secret",
            }),
        )
        expect(response.status).toBe(200)
        expect((await response.json()).models).toEqual(["m1"])
        expect(fetchMock).toHaveBeenCalledTimes(2)

        const firstHeaders = (fetchMock.mock.calls[0][1] as RequestInit)
            .headers as Record<string, string>
        const secondHeaders = (fetchMock.mock.calls[1][1] as RequestInit)
            .headers as Record<string, string>
        expect(firstHeaders.Authorization).toBe("Bearer sk-secret")
        expect(secondHeaders.Authorization).toBeUndefined()
    })

    it("blocks a redirect that points at a private address", async () => {
        process.env.ALLOW_PRIVATE_URLS = "false"
        fetchMock.mockResolvedValueOnce(
            // Public initial host (mocked DNS), then bounced to cloud metadata.
            redirectResponse("http://169.254.169.254/latest/meta-data/"),
        )

        const response = await POST(
            makeRequest({
                provider: "openai",
                baseUrl: "https://api.example.com/v1",
                apiKey: "sk-test",
            }),
        )
        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.models).toEqual([])
        expect(data.error).toBe("Invalid redirect target")
        // The metadata endpoint must never be contacted.
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("caps redirect chains", async () => {
        fetchMock.mockImplementation(() =>
            Promise.resolve(redirectResponse("http://127.0.0.1:9/v1/models")),
        )

        const response = await POST(
            makeRequest({
                provider: "openai",
                baseUrl: "http://127.0.0.1:9/v1",
            }),
        )
        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.error).toBe("Too many redirects")
        expect(fetchMock).toHaveBeenCalledTimes(4)
    })

    it("rejects an oversized upstream response body", async () => {
        const huge = JSON.stringify({ data: "x".repeat(1024 * 1024 + 100) })
        fetchMock.mockResolvedValueOnce(
            new Response(huge, {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }),
        )

        const response = await POST(
            makeRequest({
                provider: "openai",
                baseUrl: "http://127.0.0.1:9/v1",
            }),
        )
        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.models).toEqual([])
        expect(data.error).toBe("Response too large")
    })

    it("returns an error (not HTML) when the upstream body is not JSON", async () => {
        fetchMock.mockResolvedValueOnce(
            new Response("<html>nope</html>", {
                status: 200,
                headers: { "Content-Type": "text/html" },
            }),
        )
        const response = await POST(
            makeRequest({
                provider: "openai",
                baseUrl: "http://127.0.0.1:9/v1",
            }),
        )
        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.error).toBe("Invalid JSON response")
    })

    it("treats returned model ids as opaque data, never markup", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ data: [{ id: "<img src=x onerror=alert(1)>" }] }),
        )
        const response = await POST(
            makeRequest({
                provider: "openai",
                baseUrl: "http://127.0.0.1:9/v1",
            }),
        )
        const data = await response.json()
        expect(data.models).toEqual(["<img src=x onerror=alert(1)>"])
    })

    it("never returns the API key in an upstream error response", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad" }, 401))
        const response = await POST(
            makeRequest({
                provider: "openai",
                baseUrl: "http://127.0.0.1:9/v1",
                apiKey: "sk-super-secret",
            }),
        )
        const text = await response.text()
        expect(text).not.toContain("sk-super-secret")
        expect(JSON.parse(text).error).toBe("Invalid API key")
    })

    it("rate limits repeated requests per client identity", async () => {
        const headers = { "x-forwarded-for": "203.0.113-ratelimit-test" }
        let limited = 0
        for (let i = 0; i < 25; i++) {
            const response = await POST(
                makeRequest({ provider: "bedrock" }, headers),
            )
            if (response.status === 429) {
                limited++
                expect(response.headers.get("retry-after")).toBeTruthy()
            }
        }
        expect(limited).toBeGreaterThan(0)
        // Unsupported provider never reaches the network.
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
