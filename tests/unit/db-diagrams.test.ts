import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "next-ai-drawio-db-"))
process.env.DATABASE_PATH = path.join(tmpDir, "test.sqlite")

type DiagramsModule = typeof import("@/lib/db/diagrams")
type VersionsModule = typeof import("@/lib/db/versions")
type SchemaModule = typeof import("@/lib/db/schema")

let diagrams: DiagramsModule
let versions: VersionsModule
let schema: SchemaModule
let getDb: typeof import("@/lib/db").getDb

const USER_A = "user-a"
const USER_B = "user-b"

beforeAll(async () => {
    schema = await import("@/lib/db/schema")
    const dbModule = await import("@/lib/db")
    getDb = dbModule.getDb
    diagrams = await import("@/lib/db/diagrams")
    versions = await import("@/lib/db/versions")

    const now = new Date()
    getDb()
        .insert(schema.user)
        .values([
            {
                id: USER_A,
                name: "User A",
                email: "a@example.com",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
            },
            {
                id: USER_B,
                name: "User B",
                email: "b@example.com",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
            },
        ])
        .run()
})

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("diagram persistence", () => {
    it("creates, lists and reads a diagram for its owner", () => {
        const created = diagrams.createDiagram(USER_A, {
            title: "System Architecture",
            diagramXml: "<mxfile/>",
            messages: [{ id: "m1", role: "user", parts: [] }],
        })
        expect(created.id).toBeTruthy()
        expect(created.revision).toBe(1)

        const list = diagrams.listDiagrams(USER_A)
        expect(list).toHaveLength(1)
        expect(list[0].title).toBe("System Architecture")
        expect(list[0].messageCount).toBe(1)
        expect(list[0].hasDiagram).toBe(true)

        const loaded = diagrams.getDiagram(USER_A, created.id)
        expect(loaded?.diagramXml).toBe("<mxfile/>")
    })

    it("never exposes another user's diagram", () => {
        const created = diagrams.createDiagram(USER_A, { title: "Private" })
        expect(diagrams.getDiagram(USER_B, created.id)).toBeNull()
        expect(
            diagrams.updateDiagram(USER_B, created.id, 1, {
                diagramXml: "x",
            }),
        ).toEqual({ ok: false, reason: "not_found" })
        expect(diagrams.softDeleteDiagram(USER_B, created.id)).toBe(false)
        expect(diagrams.getDiagram(USER_A, created.id)).not.toBeNull()
    })

    it("rejects stale revisions with a conflict", () => {
        const created = diagrams.createDiagram(USER_A, { title: "Revisions" })

        const first = diagrams.updateDiagram(USER_A, created.id, 1, {
            diagramXml: "<mxfile>v2</mxfile>",
        })
        expect(first).toEqual({
            ok: true,
            revision: 2,
            updatedAt: expect.any(Number),
        })

        const stale = diagrams.updateDiagram(USER_A, created.id, 1, {
            diagramXml: "<mxfile>stale</mxfile>",
        })
        expect(stale.ok).toBe(false)
        if (!stale.ok && stale.reason === "conflict") {
            expect(stale.current.revision).toBe(2)
            expect(stale.current.diagramXml).toBe("<mxfile>v2</mxfile>")
        } else {
            throw new Error("expected conflict")
        }

        const retry = diagrams.updateDiagram(USER_A, created.id, 2, {
            diagramXml: "<mxfile>v3</mxfile>",
        })
        expect(retry.ok).toBe(true)
    })

    it("soft deletes and hides diagrams from listings", () => {
        const created = diagrams.createDiagram(USER_A, { title: "Delete me" })
        expect(diagrams.softDeleteDiagram(USER_A, created.id)).toBe(true)
        expect(diagrams.getDiagram(USER_A, created.id)).toBeNull()
        expect(
            diagrams.listDiagrams(USER_A).some((d) => d.id === created.id),
        ).toBe(false)
    })

    it("duplicates a diagram with its content", () => {
        const created = diagrams.createDiagram(USER_A, {
            title: "Original",
            diagramXml: "<mxfile>copy</mxfile>",
            messages: [{ id: "m1" }],
        })
        const copy = diagrams.duplicateDiagram(USER_A, created.id)
        expect(copy?.id).not.toBe(created.id)
        expect(copy?.title).toBe("Original (copy)")
        expect(copy?.diagramXml).toBe("<mxfile>copy</mxfile>")
        expect(copy?.revision).toBe(1)
    })

    it("renames and normalizes titles", () => {
        const created = diagrams.createDiagram(USER_A, { title: "Old" })
        expect(diagrams.renameDiagram(USER_A, created.id, "New")).toBe(true)
        expect(diagrams.getDiagram(USER_A, created.id)?.title).toBe("New")

        const long = "x".repeat(500)
        const withLongTitle = diagrams.createDiagram(USER_A, { title: long })
        expect(withLongTitle.title.length).toBe(diagrams.MAX_TITLE_LENGTH)

        const empty = diagrams.createDiagram(USER_A, { title: "   " })
        expect(empty.title).toBe(diagrams.DEFAULT_DIAGRAM_TITLE)
    })

    it("searches diagrams by title", () => {
        const user = "user-search"
        getDb()
            .insert(schema.user)
            .values({
                id: user,
                name: "Search",
                email: "search@example.com",
                emailVerified: true,
                createdAt: new Date(),
                updatedAt: new Date(),
            })
            .run()
        diagrams.createDiagram(user, { title: "Alpha Flow" })
        diagrams.createDiagram(user, { title: "Beta Flow" })
        diagrams.createDiagram(user, { title: "Gamma" })

        expect(diagrams.listDiagrams(user, { search: "flow" })).toHaveLength(2)
        expect(diagrams.listDiagrams(user, { search: "%" })).toHaveLength(0)
    })
})

describe("diagram versions", () => {
    it("snapshots, restores and prunes versions", () => {
        const created = diagrams.createDiagram(USER_A, {
            title: "Versioned",
            diagramXml: "<mxfile>v1</mxfile>",
        })

        versions.createVersion({
            diagramId: created.id,
            revision: 1,
            diagramXml: "<mxfile>v1</mxfile>",
        })
        versions.createVersion({
            diagramId: created.id,
            revision: 2,
            diagramXml: "<mxfile>v2</mxfile>",
        })

        const list = versions.listVersions(created.id)
        expect(list.map((v) => v.revision)).toEqual([2, 1])
        expect(versions.getVersion(created.id, 1)?.diagramXml).toBe(
            "<mxfile>v1</mxfile>",
        )

        versions.pruneVersions(created.id, 1)
        expect(versions.listVersions(created.id)).toHaveLength(1)
        expect(versions.countVersions(created.id)).toBe(1)
    })

    it("only auto-snapshots when XML changed and interval elapsed", () => {
        const created = diagrams.createDiagram(USER_A, {
            title: "Snapshot policy",
            diagramXml: "<mxfile>a</mxfile>",
        })
        // No versions yet - first change should snapshot
        expect(
            versions.shouldCreateVersion(
                created.id,
                "<mxfile>a</mxfile>",
                false,
            ),
        ).toBe(true)

        versions.createVersion({
            diagramId: created.id,
            revision: 1,
            diagramXml: "<mxfile>a</mxfile>",
        })
        // Unchanged XML should not snapshot
        expect(
            versions.shouldCreateVersion(
                created.id,
                "<mxfile>a</mxfile>",
                false,
            ),
        ).toBe(false)
        // Changed XML but within the 5 minute window should not snapshot
        expect(
            versions.shouldCreateVersion(
                created.id,
                "<mxfile>b</mxfile>",
                false,
            ),
        ).toBe(false)
        // Explicit request always snapshots
        expect(
            versions.shouldCreateVersion(
                created.id,
                "<mxfile>a</mxfile>",
                true,
            ),
        ).toBe(true)
    })
})
