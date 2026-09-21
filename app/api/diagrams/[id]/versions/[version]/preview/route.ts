import { NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth/server"
import { getDiagram } from "@/lib/db/diagrams"
import { getVersionPreview } from "@/lib/db/versions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ id: string; version: string }> }

export async function GET(_request: Request, context: RouteContext) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id, version } = await context.params
    const revision = Number(version)
    if (!Number.isInteger(revision) || revision <= 0) {
        return NextResponse.json({ error: "Invalid version" }, { status: 400 })
    }

    const diagram = getDiagram(user.id, id)
    if (!diagram) {
        return NextResponse.json(
            { error: "Diagram not found" },
            { status: 404 },
        )
    }

    const preview = getVersionPreview(id, revision)
    if (!preview) {
        return new NextResponse(null, { status: 404 })
    }

    return new NextResponse(new Uint8Array(preview.buffer), {
        status: 200,
        headers: {
            "Content-Type": preview.mime,
            "Content-Length": String(preview.buffer.length),
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    })
}
