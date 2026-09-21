import { NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth/server"
import { getDiagram } from "@/lib/db/diagrams"
import { sanitizeFilename } from "@/lib/validation/sanitize"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ id: string }> }

function toDrawioXml(diagramXml: string): string {
    const trimmed = diagramXml.trim()
    if (!trimmed) {
        return `<mxfile><diagram name="Page-1" id="page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`
    }
    if (trimmed.includes("<mxfile")) return trimmed
    return `<mxfile><diagram name="Page-1" id="page-1">${trimmed}</diagram></mxfile>`
}

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

    const filename = `${sanitizeFilename(diagram.title)}.drawio`
    return new NextResponse(toDrawioXml(diagram.diagramXml), {
        status: 200,
        headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
            "X-Content-Type-Options": "nosniff",
        },
    })
}
