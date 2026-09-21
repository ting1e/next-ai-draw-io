import { NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth/server"
import { getThumbnail } from "@/lib/db/diagrams"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: Request, context: RouteContext) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id } = await context.params
    const thumbnail = getThumbnail(user.id, id)
    if (!thumbnail) {
        return new NextResponse(null, { status: 404 })
    }

    return new NextResponse(new Uint8Array(thumbnail.buffer), {
        status: 200,
        headers: {
            "Content-Type": thumbnail.mime,
            "Content-Length": String(thumbnail.buffer.length),
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    })
}
