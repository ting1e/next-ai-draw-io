import { NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth/server"
import { createDiagram, getDiagram, setThumbnail } from "@/lib/db/diagrams"
import { parseImageDataUrl } from "@/lib/images"
import {
    getMaxRequestBodyBytes,
    importDiagramsSchema,
} from "@/lib/validation/diagram"
import { readJsonBody } from "@/lib/validation/http"
import { isSameOrigin } from "@/lib/validation/origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if (!isSameOrigin(request)) {
        return NextResponse.json({ error: "Invalid origin" }, { status: 403 })
    }

    const body = await readJsonBody(request, getMaxRequestBodyBytes() * 2)
    if (!body.ok) {
        return NextResponse.json({ error: body.error }, { status: body.status })
    }

    const parsed = importDiagramsSchema.safeParse(body.data)
    if (!parsed.success) {
        return NextResponse.json(
            { error: "Invalid input", issues: parsed.error.issues },
            { status: 400 },
        )
    }

    const importedIds: string[] = []

    for (const session of parsed.data.sessions) {
        const created = createDiagram(user.id, {
            title: session.title,
            diagramXml: session.diagramXml,
            messages: session.messages,
            xmlSnapshots: session.xmlSnapshots,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
        })

        // Raw SVG history is intentionally never imported; only PNG thumbnails.
        if (session.thumbnailDataUrl) {
            const image = parseImageDataUrl(session.thumbnailDataUrl)
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

        // Read-back verification before reporting success to the client.
        const verified = getDiagram(user.id, created.id)
        if (verified && verified.id === created.id) {
            importedIds.push(created.id)
        }
    }

    return NextResponse.json({
        ok: true,
        imported: importedIds.length,
        ids: importedIds,
    })
}
