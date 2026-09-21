import "server-only"
import { and, desc, eq, sql } from "drizzle-orm"
import { nanoid } from "nanoid"
import { getDb, getSqlite } from "./index"
import { type DiagramVersionRow, diagramVersions } from "./schema"

export const DEFAULT_MAX_VERSIONS = 50
export const VERSION_INTERVAL_MS = 5 * 60 * 1000

export interface DiagramVersion {
    id: string
    diagramId: string
    revision: number
    diagramXml: string
    hasPreview: boolean
    label: string | null
    createdAt: number
}

export function getMaxVersions(): number {
    const parsed = Number(process.env.MAX_DIAGRAM_VERSIONS)
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_VERSIONS
    return Math.floor(parsed)
}

function toVersion(row: DiagramVersionRow): DiagramVersion {
    return {
        id: row.id,
        diagramId: row.diagramId,
        revision: row.revision,
        diagramXml: row.diagramXml,
        hasPreview: !!row.previewBlob,
        label: row.label,
        createdAt: row.createdAt,
    }
}

export function listVersions(diagramId: string, limit = 100): DiagramVersion[] {
    const rows = getDb()
        .select()
        .from(diagramVersions)
        .where(eq(diagramVersions.diagramId, diagramId))
        .orderBy(desc(diagramVersions.revision))
        .limit(Math.min(Math.max(limit, 1), 500))
        .all()
    return rows.map(toVersion)
}

export function getVersion(
    diagramId: string,
    revision: number,
): DiagramVersion | null {
    const row = getDb()
        .select()
        .from(diagramVersions)
        .where(
            and(
                eq(diagramVersions.diagramId, diagramId),
                eq(diagramVersions.revision, revision),
            ),
        )
        .get()
    return row ? toVersion(row) : null
}

export function getLatestVersion(diagramId: string): DiagramVersion | null {
    const row = getDb()
        .select()
        .from(diagramVersions)
        .where(eq(diagramVersions.diagramId, diagramId))
        .orderBy(desc(diagramVersions.revision))
        .limit(1)
        .get()
    return row ? toVersion(row) : null
}

export function getVersionPreview(
    diagramId: string,
    revision: number,
): { mime: string; buffer: Buffer } | null {
    const row = getDb()
        .select({
            mime: diagramVersions.previewMime,
            buffer: diagramVersions.previewBlob,
        })
        .from(diagramVersions)
        .where(
            and(
                eq(diagramVersions.diagramId, diagramId),
                eq(diagramVersions.revision, revision),
            ),
        )
        .get()
    if (!row?.buffer || !row.mime) return null
    return { mime: row.mime, buffer: row.buffer }
}

export function createVersion(input: {
    diagramId: string
    revision: number
    diagramXml: string
    previewMime?: string | null
    previewBlob?: Buffer | null
    label?: string | null
    createdAt?: number
}): void {
    getDb()
        .insert(diagramVersions)
        .values({
            id: nanoid(),
            diagramId: input.diagramId,
            revision: input.revision,
            diagramXml: input.diagramXml,
            previewMime: input.previewMime ?? null,
            previewBlob: input.previewBlob ?? null,
            label: input.label ?? null,
            createdAt: input.createdAt ?? Date.now(),
        })
        .onConflictDoNothing()
        .run()
    pruneVersions(input.diagramId, getMaxVersions())
}

export function pruneVersions(diagramId: string, maxVersions: number): void {
    if (maxVersions <= 0) return
    getSqlite()
        .prepare(
            `DELETE FROM diagram_versions
             WHERE diagram_id = ?
               AND id NOT IN (
                 SELECT id FROM diagram_versions
                 WHERE diagram_id = ?
                 ORDER BY revision DESC
                 LIMIT ?
               )`,
        )
        .run(diagramId, diagramId, maxVersions)
}

/**
 * Snapshot policy: always snapshot on explicit request (AI edit finished or
 * user pressed "save version"), and otherwise at most once every 5 minutes
 * when the XML actually changed.
 */
export function shouldCreateVersion(
    diagramId: string,
    diagramXml: string,
    force: boolean,
): boolean {
    if (force) return true
    const latest = getLatestVersion(diagramId)
    if (!latest) return diagramXml.trim().length > 0
    if (latest.diagramXml === diagramXml) return false
    return Date.now() - latest.createdAt >= VERSION_INTERVAL_MS
}

export function countVersions(diagramId: string): number {
    const row = getDb()
        .select({ count: sql<number>`count(*)` })
        .from(diagramVersions)
        .where(eq(diagramVersions.diagramId, diagramId))
        .get()
    return row?.count ?? 0
}
