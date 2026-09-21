"use client"

import { getApiEndpoint } from "@/lib/base-path"
import type {
    ChatSession,
    SessionMetadata,
    StoredMessage,
} from "@/lib/session-storage"
import { encodeThumbnailForServer } from "@/lib/thumbnails"
import type {
    CreateSessionInput,
    SaveOptions,
    SaveOutcome,
    SessionStorageProvider,
} from "./types"

interface ServerDiagramDocument {
    id: string
    title: string
    diagramXml?: string
    messages?: unknown[]
    xmlSnapshots?: [number, string][]
    revision: number
    createdAt: number
    updatedAt: number
    thumbnailUrl?: string
}

interface ServerDiagramListItem {
    id: string
    title: string
    createdAt: number
    updatedAt: number
    revision: number
    messageCount: number
    hasDiagram: boolean
    thumbnailUrl?: string
}

function toChatSession(doc: ServerDiagramDocument): ChatSession {
    return {
        id: doc.id,
        title: doc.title,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        messages: Array.isArray(doc.messages)
            ? (doc.messages as StoredMessage[])
            : [],
        xmlSnapshots: Array.isArray(doc.xmlSnapshots) ? doc.xmlSnapshots : [],
        diagramXml: doc.diagramXml ?? "",
        thumbnailDataUrl: doc.thumbnailUrl,
        revision: doc.revision,
    }
}

async function parseError(response: Response): Promise<string> {
    try {
        const data = await response.json()
        if (typeof data?.error === "string") return data.error
    } catch {
        // ignore
    }
    return `Request failed with status ${response.status}`
}

/**
 * Server-backed storage. The server SQLite database is the authoritative
 * source of truth; every write is guarded by the revision returned from the
 * last read/write (optimistic concurrency).
 */
export function createServerStorageProvider(): SessionStorageProvider {
    async function create(
        input: CreateSessionInput = {},
    ): Promise<ChatSession> {
        const thumbnailDataUrl = await encodeThumbnailForServer(
            input.thumbnailDataUrl,
        )
        const response = await fetch(getApiEndpoint("/api/diagrams"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                title: input.title,
                diagramXml: input.diagramXml,
                messages: input.messages,
                xmlSnapshots: input.xmlSnapshots,
                ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
            }),
        })
        if (!response.ok) {
            throw new Error(await parseError(response))
        }
        const data = (await response.json()) as ServerDiagramDocument
        return {
            id: data.id,
            title: data.title,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            messages: input.messages ?? [],
            xmlSnapshots: input.xmlSnapshots ?? [],
            diagramXml: input.diagramXml ?? "",
            thumbnailDataUrl: data.thumbnailUrl ?? input.thumbnailDataUrl,
            revision: data.revision,
        }
    }

    async function get(id: string): Promise<ChatSession | null> {
        const response = await fetch(getApiEndpoint(`/api/diagrams/${id}`), {
            cache: "no-store",
        })
        if (response.status === 404) return null
        if (!response.ok) {
            throw new Error(await parseError(response))
        }
        return toChatSession((await response.json()) as ServerDiagramDocument)
    }

    async function save(
        session: ChatSession,
        options?: SaveOptions,
    ): Promise<SaveOutcome> {
        if (!session.revision) {
            const created = await create({
                title: session.title,
                messages: session.messages,
                xmlSnapshots: session.xmlSnapshots,
                diagramXml: session.diagramXml,
                thumbnailDataUrl: session.thumbnailDataUrl,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
            })
            return { ok: true, revision: created.revision }
        }

        const thumbnailDataUrl = await encodeThumbnailForServer(
            session.thumbnailDataUrl,
        )

        const response = await fetch(
            getApiEndpoint(`/api/diagrams/${session.id}`),
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    baseRevision: session.revision,
                    title: session.title,
                    diagramXml: session.diagramXml,
                    messages: session.messages,
                    xmlSnapshots: session.xmlSnapshots,
                    ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
                    ...(options?.createVersion
                        ? {
                              createVersion: true,
                              versionLabel: options.versionLabel,
                          }
                        : {}),
                }),
            },
        )

        if (response.status === 409) {
            const data = (await response.json()) as {
                server: ServerDiagramDocument
            }
            return {
                ok: false,
                error: "conflict",
                server: toChatSession(data.server),
            }
        }
        if (!response.ok) {
            return {
                ok: false,
                error: "failed",
                message: await parseError(response),
            }
        }

        const data = (await response.json()) as {
            revision: number
            updatedAt: number
            thumbnailUrl?: string
        }
        return {
            ok: true,
            revision: data.revision,
            updatedAt: data.updatedAt,
            thumbnailUrl: data.thumbnailUrl,
        }
    }

    return {
        kind: "server",
        isAvailable: () => typeof window !== "undefined",
        async list(options?: { search?: string }): Promise<SessionMetadata[]> {
            const params = new URLSearchParams({ limit: "200" })
            if (options?.search) params.set("search", options.search)
            const response = await fetch(
                getApiEndpoint(`/api/diagrams?${params.toString()}`),
                { cache: "no-store" },
            )
            if (!response.ok) {
                throw new Error(await parseError(response))
            }
            const data = (await response.json()) as {
                items: ServerDiagramListItem[]
            }
            return data.items.map((item) => ({
                id: item.id,
                title: item.title,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                messageCount: item.messageCount,
                hasDiagram: item.hasDiagram,
                thumbnailDataUrl: item.thumbnailUrl,
                revision: item.revision,
            }))
        },
        get,
        create,
        save,
        async delete(id: string): Promise<void> {
            const response = await fetch(
                getApiEndpoint(`/api/diagrams/${id}`),
                { method: "DELETE" },
            )
            if (!response.ok && response.status !== 404) {
                throw new Error(await parseError(response))
            }
        },
        async rename(id: string, title: string): Promise<void> {
            const response = await fetch(
                getApiEndpoint(`/api/diagrams/${id}`),
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ title }),
                },
            )
            if (!response.ok) {
                throw new Error(await parseError(response))
            }
        },
        async duplicate(id: string): Promise<ChatSession | null> {
            const response = await fetch(getApiEndpoint("/api/diagrams"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sourceId: id }),
            })
            if (!response.ok) {
                if (response.status === 404) return null
                throw new Error(await parseError(response))
            }
            const data = (await response.json()) as ServerDiagramDocument
            return {
                id: data.id,
                title: data.title,
                createdAt: data.createdAt,
                updatedAt: data.updatedAt,
                messages: [],
                xmlSnapshots: [],
                diagramXml: "",
                thumbnailDataUrl: data.thumbnailUrl,
                revision: data.revision,
            }
        },
    }
}
