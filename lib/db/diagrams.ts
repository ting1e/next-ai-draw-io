import "server-only"
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm"
import { nanoid } from "nanoid"
import { stripControlCharacters } from "@/lib/validation/sanitize"
import { getDb } from "./index"
import { type DiagramRow, diagrams } from "./schema"

export interface DiagramDocument {
    id: string
    userId: string
    title: string
    diagramXml: string
    messages: unknown[]
    xmlSnapshots: [number, string][]
    revision: number
    createdAt: number
    updatedAt: number
}

export interface DiagramMetadata {
    id: string
    title: string
    createdAt: number
    updatedAt: number
    revision: number
    messageCount: number
    hasDiagram: boolean
    hasThumbnail: boolean
}

export interface CreateDiagramInput {
    title?: string
    diagramXml?: string
    messages?: unknown[]
    xmlSnapshots?: [number, string][]
    createdAt?: number
    updatedAt?: number
}

export interface UpdateDiagramPatch {
    title?: string
    diagramXml?: string
    messages?: unknown[]
    xmlSnapshots?: [number, string][]
    thumbnailMime?: string | null
    thumbnailBlob?: Buffer | null
    thumbnailRevision?: number | null
}

export type UpdateDiagramResult =
    | { ok: true; revision: number; updatedAt: number }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "conflict"; current: DiagramDocument }

export const DEFAULT_DIAGRAM_TITLE = "Untitled Diagram"
export const MAX_TITLE_LENGTH = 200

export function normalizeTitle(title: unknown): string {
    if (typeof title !== "string") return DEFAULT_DIAGRAM_TITLE
    const trimmed = stripControlCharacters(title).trim()
    if (!trimmed) return DEFAULT_DIAGRAM_TITLE
    return trimmed.slice(0, MAX_TITLE_LENGTH)
}

function parseJsonArray(value: string): unknown[] {
    try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

function parseSnapshots(value: string): [number, string][] {
    try {
        const parsed = JSON.parse(value)
        if (!Array.isArray(parsed)) return []
        return parsed.filter(
            (entry): entry is [number, string] =>
                Array.isArray(entry) &&
                typeof entry[0] === "number" &&
                typeof entry[1] === "string",
        )
    } catch {
        return []
    }
}

export function toDiagramDocument(row: DiagramRow): DiagramDocument {
    return {
        id: row.id,
        userId: row.userId,
        title: row.title,
        diagramXml: row.diagramXml,
        messages: parseJsonArray(row.messagesJson),
        xmlSnapshots: parseSnapshots(row.xmlSnapshotsJson),
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    }
}

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

export function listDiagrams(
    userId: string,
    options: { search?: string; limit?: number; cursor?: number } = {},
): DiagramMetadata[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
    const conditions = [eq(diagrams.userId, userId), isNull(diagrams.deletedAt)]

    const search = options.search?.trim()
    if (search) {
        conditions.push(
            sql`${diagrams.title} LIKE ${`%${escapeLike(search)}%`} ESCAPE '\\'`,
        )
    }
    if (options.cursor && Number.isFinite(options.cursor)) {
        conditions.push(lt(diagrams.updatedAt, options.cursor))
    }

    const rows = getDb()
        .select({
            id: diagrams.id,
            title: diagrams.title,
            createdAt: diagrams.createdAt,
            updatedAt: diagrams.updatedAt,
            revision: diagrams.revision,
            messagesJson: diagrams.messagesJson,
            diagramXml: diagrams.diagramXml,
            thumbnailRevision: diagrams.thumbnailRevision,
            thumbnailBlob: diagrams.thumbnailBlob,
        })
        .from(diagrams)
        .where(and(...conditions))
        .orderBy(desc(diagrams.updatedAt))
        .limit(limit)
        .all()

    return rows.map((row) => ({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        revision: row.revision,
        messageCount: parseJsonArray(row.messagesJson).length,
        hasDiagram: row.diagramXml.trim().length > 0,
        hasThumbnail: !!row.thumbnailBlob && row.thumbnailRevision !== null,
    }))
}

export function createDiagram(
    userId: string,
    input: CreateDiagramInput = {},
): DiagramDocument {
    const db = getDb()
    const now = Date.now()
    const id = nanoid()
    const createdAt = input.createdAt ?? now
    const updatedAt = input.updatedAt ?? createdAt

    db.insert(diagrams)
        .values({
            id,
            userId,
            title: normalizeTitle(input.title),
            diagramXml: input.diagramXml ?? "",
            messagesJson: JSON.stringify(input.messages ?? []),
            xmlSnapshotsJson: JSON.stringify(input.xmlSnapshots ?? []),
            revision: 1,
            createdAt,
            updatedAt,
        })
        .run()

    return {
        id,
        userId,
        title: normalizeTitle(input.title),
        diagramXml: input.diagramXml ?? "",
        messages: input.messages ?? [],
        xmlSnapshots: input.xmlSnapshots ?? [],
        revision: 1,
        createdAt,
        updatedAt,
    }
}

export function getDiagram(userId: string, id: string): DiagramDocument | null {
    const row = getDb()
        .select()
        .from(diagrams)
        .where(
            and(
                eq(diagrams.id, id),
                eq(diagrams.userId, userId),
                isNull(diagrams.deletedAt),
            ),
        )
        .get()
    return row ? toDiagramDocument(row) : null
}

export function getDiagramRow(userId: string, id: string): DiagramRow | null {
    return (
        getDb()
            .select()
            .from(diagrams)
            .where(
                and(
                    eq(diagrams.id, id),
                    eq(diagrams.userId, userId),
                    isNull(diagrams.deletedAt),
                ),
            )
            .get() ?? null
    )
}

export function updateDiagram(
    userId: string,
    id: string,
    baseRevision: number,
    patch: UpdateDiagramPatch,
): UpdateDiagramResult {
    const db = getDb()
    const current = getDiagramRow(userId, id)
    if (!current) return { ok: false, reason: "not_found" }
    if (current.revision !== baseRevision) {
        return {
            ok: false,
            reason: "conflict",
            current: toDiagramDocument(current),
        }
    }

    const now = Date.now()
    const nextRevision = baseRevision + 1
    const values: Partial<typeof diagrams.$inferInsert> = {
        revision: sql`${diagrams.revision} + 1` as unknown as number,
        updatedAt: now,
    }
    if (patch.title !== undefined) values.title = normalizeTitle(patch.title)
    if (patch.diagramXml !== undefined) values.diagramXml = patch.diagramXml
    if (patch.messages !== undefined) {
        values.messagesJson = JSON.stringify(patch.messages)
    }
    if (patch.xmlSnapshots !== undefined) {
        values.xmlSnapshotsJson = JSON.stringify(patch.xmlSnapshots)
    }
    if (patch.thumbnailMime !== undefined) {
        values.thumbnailMime = patch.thumbnailMime
    }
    if (patch.thumbnailBlob !== undefined) {
        values.thumbnailBlob = patch.thumbnailBlob
    }
    if (patch.thumbnailRevision !== undefined) {
        values.thumbnailRevision = patch.thumbnailRevision
    }

    const result = db
        .update(diagrams)
        .set(values)
        .where(
            and(
                eq(diagrams.id, id),
                eq(diagrams.userId, userId),
                eq(diagrams.revision, baseRevision),
                isNull(diagrams.deletedAt),
            ),
        )
        .run()

    if (result.changes === 0) {
        const fresh = getDiagramRow(userId, id)
        if (!fresh) return { ok: false, reason: "not_found" }
        return {
            ok: false,
            reason: "conflict",
            current: toDiagramDocument(fresh),
        }
    }

    return { ok: true, revision: nextRevision, updatedAt: now }
}

export function renameDiagram(
    userId: string,
    id: string,
    title: string,
): boolean {
    const result = getDb()
        .update(diagrams)
        .set({ title: normalizeTitle(title), updatedAt: Date.now() })
        .where(
            and(
                eq(diagrams.id, id),
                eq(diagrams.userId, userId),
                isNull(diagrams.deletedAt),
            ),
        )
        .run()
    return result.changes > 0
}

export function softDeleteDiagram(userId: string, id: string): boolean {
    const result = getDb()
        .update(diagrams)
        .set({ deletedAt: Date.now() })
        .where(
            and(
                eq(diagrams.id, id),
                eq(diagrams.userId, userId),
                isNull(diagrams.deletedAt),
            ),
        )
        .run()
    return result.changes > 0
}

export function duplicateDiagram(
    userId: string,
    id: string,
): DiagramDocument | null {
    const source = getDiagram(userId, id)
    if (!source) return null
    const copy = createDiagram(userId, {
        title: `${source.title} (copy)`,
        diagramXml: source.diagramXml,
        messages: source.messages,
        xmlSnapshots: source.xmlSnapshots,
    })

    const row = getDiagramRow(userId, id)
    if (row?.thumbnailBlob) {
        getDb()
            .update(diagrams)
            .set({
                thumbnailMime: row.thumbnailMime,
                thumbnailBlob: row.thumbnailBlob,
                thumbnailRevision: copy.revision,
            })
            .where(eq(diagrams.id, copy.id))
            .run()
    }

    return copy
}

export function setThumbnail(
    userId: string,
    id: string,
    mime: string,
    buffer: Buffer,
    revision: number,
): boolean {
    const result = getDb()
        .update(diagrams)
        .set({
            thumbnailMime: mime,
            thumbnailBlob: buffer,
            thumbnailRevision: revision,
        })
        .where(
            and(
                eq(diagrams.id, id),
                eq(diagrams.userId, userId),
                isNull(diagrams.deletedAt),
            ),
        )
        .run()
    return result.changes > 0
}

export function getThumbnail(
    userId: string,
    id: string,
): { mime: string; buffer: Buffer; revision: number } | null {
    const row = getDb()
        .select({
            mime: diagrams.thumbnailMime,
            buffer: diagrams.thumbnailBlob,
            revision: diagrams.thumbnailRevision,
        })
        .from(diagrams)
        .where(
            and(
                eq(diagrams.id, id),
                eq(diagrams.userId, userId),
                isNull(diagrams.deletedAt),
            ),
        )
        .get()

    if (!row?.buffer || !row.mime) return null
    return {
        mime: row.mime,
        buffer: row.buffer,
        revision: row.revision ?? 0,
    }
}

export function countUserDiagrams(userId: string): number {
    const row = getDb()
        .select({ count: sql<number>`count(*)` })
        .from(diagrams)
        .where(and(eq(diagrams.userId, userId), isNull(diagrams.deletedAt)))
        .get()
    return row?.count ?? 0
}
