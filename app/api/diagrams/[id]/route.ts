import { NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth/server"
import {
    getDiagram,
    getDiagramRow,
    renameDiagram,
    softDeleteDiagram,
    updateDiagram,
} from "@/lib/db/diagrams"
import { createVersion, shouldCreateVersion } from "@/lib/db/versions"
import { parseImageDataUrl } from "@/lib/images"
import {
    getMaxRequestBodyBytes,
    updateDiagramSchema,
} from "@/lib/validation/diagram"
import { readJsonBody } from "@/lib/validation/http"
import { isSameOrigin } from "@/lib/validation/origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ id: string }> }

function toServerPayload(
    doc: NonNullable<ReturnType<typeof getDiagram>>,
    hasThumbnail: boolean,
) {
    return {
        id: doc.id,
        title: doc.title,
        diagramXml: doc.diagramXml,
        messages: doc.messages,
        xmlSnapshots: doc.xmlSnapshots,
        revision: doc.revision,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        thumbnailUrl: hasThumbnail
            ? `/api/diagrams/${doc.id}/thumbnail?v=${doc.revision}`
            : undefined,
    }
}

export async function GET(_request: Request, context: RouteContext) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id } = await context.params
    const doc = getDiagram(user.id, id)
    if (!doc) {
        return NextResponse.json(
            { error: "Diagram not found" },
            { status: 404 },
        )
    }
    const row = getDiagramRow(user.id, id)
    return NextResponse.json(toServerPayload(doc, !!row?.thumbnailBlob))
}

export async function PATCH(request: Request, context: RouteContext) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if (!isSameOrigin(request)) {
        return NextResponse.json({ error: "Invalid origin" }, { status: 403 })
    }

    const { id } = await context.params
    const body = await readJsonBody(request, getMaxRequestBodyBytes())
    if (!body.ok) {
        return NextResponse.json({ error: body.error }, { status: body.status })
    }

    const parsed = updateDiagramSchema.safeParse(body.data)
    if (!parsed.success) {
        return NextResponse.json(
            { error: "Invalid input", issues: parsed.error.issues },
            { status: 400 },
        )
    }

    const input = parsed.data

    // Metadata-only update (rename) does not touch the document revision.
    if (input.baseRevision === undefined) {
        if (input.title === undefined) {
            return NextResponse.json(
                { error: "baseRevision or title is required" },
                { status: 400 },
            )
        }
        const renamed = renameDiagram(user.id, id, input.title)
        if (!renamed) {
            return NextResponse.json(
                { error: "Diagram not found" },
                { status: 404 },
            )
        }
        return NextResponse.json({ ok: true })
    }

    const image =
        typeof input.thumbnailDataUrl === "string"
            ? parseImageDataUrl(input.thumbnailDataUrl)
            : undefined
    const clearThumbnail = input.thumbnailDataUrl === null
    const nextRevision = input.baseRevision + 1

    const result = updateDiagram(user.id, id, input.baseRevision, {
        title: input.title,
        diagramXml: input.diagramXml,
        messages: input.messages,
        xmlSnapshots: input.xmlSnapshots,
        ...(image
            ? {
                  thumbnailMime: image.mime,
                  thumbnailBlob: image.buffer,
                  thumbnailRevision: nextRevision,
              }
            : {}),
        ...(clearThumbnail
            ? {
                  thumbnailMime: null,
                  thumbnailBlob: null,
                  thumbnailRevision: null,
              }
            : {}),
    })

    if (!result.ok) {
        if (result.reason === "not_found") {
            return NextResponse.json(
                { error: "Diagram not found" },
                { status: 404 },
            )
        }
        const row = getDiagramRow(user.id, id)
        return NextResponse.json(
            {
                error: "conflict",
                server: toServerPayload(result.current, !!row?.thumbnailBlob),
            },
            { status: 409 },
        )
    }

    if (input.diagramXml !== undefined) {
        try {
            if (
                shouldCreateVersion(
                    id,
                    input.diagramXml,
                    input.createVersion === true,
                )
            ) {
                createVersion({
                    diagramId: id,
                    revision: result.revision,
                    diagramXml: input.diagramXml,
                    previewMime: image?.mime ?? null,
                    previewBlob: image?.buffer ?? null,
                    label: input.versionLabel ?? null,
                })
            }
        } catch (error) {
            console.error(
                "[diagrams] Failed to create version snapshot:",
                error,
            )
        }
    }

    const row = getDiagramRow(user.id, id)
    return NextResponse.json({
        ok: true,
        revision: result.revision,
        updatedAt: result.updatedAt,
        thumbnailUrl: row?.thumbnailBlob
            ? `/api/diagrams/${id}/thumbnail?v=${row.thumbnailRevision ?? result.revision}`
            : undefined,
    })
}

export async function DELETE(request: Request, context: RouteContext) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if (!isSameOrigin(request)) {
        return NextResponse.json({ error: "Invalid origin" }, { status: 403 })
    }

    const { id } = await context.params
    const deleted = softDeleteDiagram(user.id, id)
    if (!deleted) {
        return NextResponse.json(
            { error: "Diagram not found" },
            { status: 404 },
        )
    }
    return NextResponse.json({ ok: true })
}
