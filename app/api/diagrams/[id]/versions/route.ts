import { NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth/server"
import { getDiagram } from "@/lib/db/diagrams"
import { createVersion, listVersions } from "@/lib/db/versions"
import { parseImageDataUrl } from "@/lib/images"
import {
    createVersionSchema,
    getMaxRequestBodyBytes,
} from "@/lib/validation/diagram"
import { readJsonBody } from "@/lib/validation/http"
import { isSameOrigin } from "@/lib/validation/origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: Request, context: RouteContext) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id } = await context.params
    const diagram = getDiagram(user.id, id)
    if (!diagram) {
        return NextResponse.json(
            { error: "Diagram not found" },
            { status: 404 },
        )
    }

    const versions = listVersions(id)
    return NextResponse.json({
        currentRevision: diagram.revision,
        versions: versions.map((version) => ({
            revision: version.revision,
            createdAt: version.createdAt,
            label: version.label,
            hasPreview: version.hasPreview,
            previewUrl: version.hasPreview
                ? `/api/diagrams/${id}/versions/${version.revision}/preview`
                : undefined,
        })),
    })
}

export async function POST(request: Request, context: RouteContext) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if (!isSameOrigin(request)) {
        return NextResponse.json({ error: "Invalid origin" }, { status: 403 })
    }

    const { id } = await context.params
    const diagram = getDiagram(user.id, id)
    if (!diagram) {
        return NextResponse.json(
            { error: "Diagram not found" },
            { status: 404 },
        )
    }

    const body = await readJsonBody(request, getMaxRequestBodyBytes())
    if (!body.ok) {
        return NextResponse.json({ error: body.error }, { status: body.status })
    }

    const parsed = createVersionSchema.safeParse(body.data)
    if (!parsed.success) {
        return NextResponse.json(
            { error: "Invalid input", issues: parsed.error.issues },
            { status: 400 },
        )
    }

    const preview = parsed.data.previewDataUrl
        ? parseImageDataUrl(parsed.data.previewDataUrl)
        : null

    createVersion({
        diagramId: id,
        revision: diagram.revision,
        diagramXml: parsed.data.diagramXml,
        previewMime: preview?.mime ?? null,
        previewBlob: preview?.buffer ?? null,
        label: parsed.data.label ?? null,
    })

    return NextResponse.json({ ok: true, revision: diagram.revision })
}
