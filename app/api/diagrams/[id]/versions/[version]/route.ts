import { NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth/server"
import { getDiagram, updateDiagram } from "@/lib/db/diagrams"
import { createVersion, getVersion, getVersionPreview } from "@/lib/db/versions"
import { isSameOrigin } from "@/lib/validation/origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ id: string; version: string }> }

function parseRevision(value: string): number | null {
    const revision = Number(value)
    if (!Number.isInteger(revision) || revision <= 0) return null
    return revision
}

export async function GET(_request: Request, context: RouteContext) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id, version } = await context.params
    const revision = parseRevision(version)
    if (revision === null) {
        return NextResponse.json({ error: "Invalid version" }, { status: 400 })
    }

    const diagram = getDiagram(user.id, id)
    if (!diagram) {
        return NextResponse.json(
            { error: "Diagram not found" },
            { status: 404 },
        )
    }

    const snapshot = getVersion(id, revision)
    if (!snapshot) {
        return NextResponse.json(
            { error: "Version not found" },
            { status: 404 },
        )
    }

    const preview = getVersionPreview(id, revision)
    return NextResponse.json({
        revision: snapshot.revision,
        diagramXml: snapshot.diagramXml,
        label: snapshot.label,
        createdAt: snapshot.createdAt,
        hasPreview: !!preview,
        previewUrl: preview
            ? `/api/diagrams/${id}/versions/${revision}/preview`
            : undefined,
    })
}

/**
 * Restore a version. The current revision is snapshotted first so a restore
 * is itself undoable, then the document is bumped to a new revision.
 */
export async function POST(request: Request, context: RouteContext) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if (!isSameOrigin(request)) {
        return NextResponse.json({ error: "Invalid origin" }, { status: 403 })
    }

    const { id, version } = await context.params
    const revision = parseRevision(version)
    if (revision === null) {
        return NextResponse.json({ error: "Invalid version" }, { status: 400 })
    }

    const diagram = getDiagram(user.id, id)
    if (!diagram) {
        return NextResponse.json(
            { error: "Diagram not found" },
            { status: 404 },
        )
    }

    const snapshot = getVersion(id, revision)
    if (!snapshot) {
        return NextResponse.json(
            { error: "Version not found" },
            { status: 404 },
        )
    }

    createVersion({
        diagramId: id,
        revision: diagram.revision,
        diagramXml: diagram.diagramXml,
        label: "Before restore",
    })

    const result = updateDiagram(user.id, id, diagram.revision, {
        diagramXml: snapshot.diagramXml,
    })

    if (!result.ok) {
        return NextResponse.json(
            { error: "Failed to restore version" },
            { status: 409 },
        )
    }

    return NextResponse.json({
        ok: true,
        revision: result.revision,
        diagramXml: snapshot.diagramXml,
    })
}
