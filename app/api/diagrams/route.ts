import { NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth/server"
import {
    createDiagram,
    duplicateDiagram,
    getDiagramRow,
    listDiagrams,
    setThumbnail,
} from "@/lib/db/diagrams"
import { parseImageDataUrl } from "@/lib/images"
import {
    createDiagramSchema,
    getMaxRequestBodyBytes,
} from "@/lib/validation/diagram"
import { readJsonBody } from "@/lib/validation/http"
import { isSameOrigin } from "@/lib/validation/origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function thumbnailUrl(id: string, revision: number): string {
    return `/api/diagrams/${id}/thumbnail?v=${revision}`
}

/**
 * `Number(null)` is 0, which used to clamp the list to a single item when no
 * limit was supplied. Only parse the parameter when it is actually present.
 */
function parsePositiveInt(value: string | null): number | undefined {
    if (value === null || value.trim() === "") return undefined
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined
    return Math.floor(parsed)
}

export async function GET(request: Request) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const url = new URL(request.url)
    const search = url.searchParams.get("search") || undefined
    const limitParam = parsePositiveInt(url.searchParams.get("limit"))
    const cursorParam = parsePositiveInt(url.searchParams.get("cursor"))

    const items = listDiagrams(user.id, {
        search,
        limit: limitParam,
        cursor: cursorParam,
    })

    return NextResponse.json({
        items: items.map((item) => ({
            id: item.id,
            title: item.title,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            revision: item.revision,
            messageCount: item.messageCount,
            hasDiagram: item.hasDiagram,
            thumbnailUrl: item.hasThumbnail
                ? thumbnailUrl(item.id, item.revision)
                : undefined,
        })),
    })
}

export async function POST(request: Request) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if (!isSameOrigin(request)) {
        return NextResponse.json({ error: "Invalid origin" }, { status: 403 })
    }

    const body = await readJsonBody(request, getMaxRequestBodyBytes())
    if (!body.ok) {
        return NextResponse.json({ error: body.error }, { status: body.status })
    }

    const parsed = createDiagramSchema.safeParse(body.data)
    if (!parsed.success) {
        return NextResponse.json(
            { error: "Invalid input", issues: parsed.error.issues },
            { status: 400 },
        )
    }

    const input = parsed.data

    if (input.sourceId) {
        const copy = duplicateDiagram(user.id, input.sourceId)
        if (!copy) {
            return NextResponse.json(
                { error: "Diagram not found" },
                { status: 404 },
            )
        }
        const row = getDiagramRow(user.id, copy.id)
        return NextResponse.json(
            {
                id: copy.id,
                title: copy.title,
                revision: copy.revision,
                createdAt: copy.createdAt,
                updatedAt: copy.updatedAt,
                thumbnailUrl: row?.thumbnailBlob
                    ? thumbnailUrl(copy.id, copy.revision)
                    : undefined,
            },
            { status: 201 },
        )
    }

    const created = createDiagram(user.id, {
        title: input.title,
        diagramXml: input.diagramXml,
        messages: input.messages,
        xmlSnapshots: input.xmlSnapshots,
    })

    if (input.thumbnailDataUrl) {
        const image = parseImageDataUrl(input.thumbnailDataUrl)
        if (image) {
            setThumbnail(
                user.id,
                created.id,
                image.mime,
                image.buffer,
                created.revision,
            )
        }
    }

    return NextResponse.json(
        {
            id: created.id,
            title: created.title,
            revision: created.revision,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
        },
        { status: 201 },
    )
}
