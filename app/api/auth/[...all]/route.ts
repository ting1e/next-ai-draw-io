import { type NextRequest, NextResponse } from "next/server"
import { getAuth, isAuthEnabled } from "@/lib/auth/auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function handle(request: NextRequest): Promise<Response> {
    if (!isAuthEnabled()) {
        const pathname = new URL(request.url).pathname
        if (pathname.endsWith("/get-session")) {
            return NextResponse.json({ session: null, user: null })
        }
        return NextResponse.json(
            { error: "Authentication is not enabled" },
            { status: 404 },
        )
    }

    const auth = await getAuth()
    return auth.handler(request)
}

export { handle as GET, handle as POST }
