import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatSession } from "@/lib/session-storage"
import { createServerStorageProvider } from "@/lib/storage/server-storage"

const provider = createServerStorageProvider()

function session(overrides: Partial<ChatSession> = {}): ChatSession {
    return {
        id: "diagram-1",
        title: "Test",
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        xmlSnapshots: [],
        diagramXml: "<mxfile/>",
        revision: 3,
        ...overrides,
    }
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    })
}

describe("ServerStorage provider", () => {
    const fetchMock = vi.fn()

    beforeEach(() => {
        fetchMock.mockReset()
        vi.stubGlobal("fetch", fetchMock)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("maps list responses to session metadata", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                items: [
                    {
                        id: "d1",
                        title: "Architecture",
                        createdAt: 10,
                        updatedAt: 20,
                        revision: 4,
                        messageCount: 2,
                        hasDiagram: true,
                        thumbnailUrl: "/api/diagrams/d1/thumbnail?v=4",
                    },
                ],
            }),
        )

        const list = await provider.list()
        expect(list).toHaveLength(1)
        expect(list[0]).toMatchObject({
            id: "d1",
            title: "Architecture",
            revision: 4,
            thumbnailDataUrl: "/api/diagrams/d1/thumbnail?v=4",
        })
    })

    it("sends baseRevision on save and returns the new revision", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ ok: true, revision: 4, updatedAt: 99 }),
        )

        const outcome = await provider.save(session())
        expect(outcome).toEqual({ ok: true, revision: 4, updatedAt: 99 })

        const [, init] = fetchMock.mock.calls[0]
        const body = JSON.parse(init.body as string)
        expect(body.baseRevision).toBe(3)
        expect(body.diagramXml).toBe("<mxfile/>")
    })

    it("sends the thumbnail fingerprint and version options in the PATCH body", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ revision: 4, updatedAt: 9 }),
        )

        const outcome = await provider.save(
            session({
                thumbnailDataUrl:
                    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
            }),
            {
                createVersion: true,
                versionLabel: "Manual save",
                thumbnailXmlFingerprint: "2f-abc123",
            },
        )

        expect(outcome.ok).toBe(true)
        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toContain("/api/diagrams/diagram-1")
        expect(init.method).toBe("PATCH")
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        expect(body.baseRevision).toBe(3)
        expect(body.thumbnailXmlFingerprint).toBe("2f-abc123")
        expect(body.createVersion).toBe(true)
        expect(body.versionLabel).toBe("Manual save")
        expect(body.thumbnailDataUrl).toContain("data:image/png;base64,")
    })

    it("omits the fingerprint when the client did not capture one", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ revision: 4, updatedAt: 9 }),
        )

        await provider.save(session(), { createVersion: true })

        const [, init] = fetchMock.mock.calls[0]
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        expect(body).not.toHaveProperty("thumbnailXmlFingerprint")
    })

    it("surfaces conflicts with the server document", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                {
                    error: "conflict",
                    server: {
                        id: "diagram-1",
                        title: "Server copy",
                        diagramXml: "<mxfile>server</mxfile>",
                        messages: [],
                        xmlSnapshots: [],
                        revision: 7,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                },
                409,
            ),
        )

        const outcome = await provider.save(session())
        expect(outcome.ok).toBe(false)
        if (!outcome.ok && outcome.error === "conflict") {
            expect(outcome.server.revision).toBe(7)
            expect(outcome.server.diagramXml).toBe("<mxfile>server</mxfile>")
        } else {
            throw new Error("expected a conflict outcome")
        }
    })

    it("restores a version through the version endpoint", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                ok: true,
                revision: 6,
                diagramXml: "<mxfile>restored</mxfile>",
            }),
        )

        const restored = await provider.restoreVersion?.("diagram-1", 2)
        expect(restored).toEqual({
            diagramXml: "<mxfile>restored</mxfile>",
            revision: 6,
        })

        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toContain("/api/diagrams/diagram-1/versions/2")
        expect(init.method).toBe("POST")
    })

    it("treats 404 as a missing session on get", async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
        await expect(provider.get("missing")).resolves.toBeNull()
    })

    it("creates diagrams without a revision by POSTing", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                {
                    id: "new-1",
                    title: "New",
                    revision: 1,
                    createdAt: 5,
                    updatedAt: 5,
                },
                201,
            ),
        )

        const created = await provider.create({
            title: "New",
            diagramXml: "<mxfile/>",
        })
        expect(created.id).toBe("new-1")
        expect(created.revision).toBe(1)
        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toContain("/api/diagrams")
        expect(init.method).toBe("POST")
    })
})
