import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"
import { countUsers, getAuth, isAuthEnabled } from "@/lib/auth/auth"
import { getDb } from "@/lib/db"
import { user } from "@/lib/db/schema"
import { readJsonBody } from "@/lib/validation/http"
import { isSameOrigin } from "@/lib/validation/origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const setupSchema = z.object({
    name: z.string().trim().min(1).max(100),
    email: z.email().max(254),
    password: z.string().min(8).max(128),
})

export async function GET() {
    if (!isAuthEnabled()) {
        return NextResponse.json({ authEnabled: false, needsSetup: false })
    }
    return NextResponse.json({
        authEnabled: true,
        needsSetup: countUsers() === 0,
    })
}

export async function POST(request: Request) {
    if (!isAuthEnabled()) {
        return NextResponse.json(
            { error: "Authentication is not enabled" },
            { status: 404 },
        )
    }

    // /setup is only available until the first user exists.
    if (countUsers() > 0) {
        return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    if (!isSameOrigin(request)) {
        return NextResponse.json({ error: "Invalid origin" }, { status: 403 })
    }

    const body = await readJsonBody(request, 64 * 1024)
    if (!body.ok) {
        return NextResponse.json({ error: body.error }, { status: body.status })
    }

    const parsed = setupSchema.safeParse(body.data)
    if (!parsed.success) {
        return NextResponse.json(
            { error: "Invalid input", issues: parsed.error.issues },
            { status: 400 },
        )
    }

    try {
        const auth = await getAuth()
        const response = await auth.api.signUpEmail({
            body: parsed.data,
            asResponse: true,
        })

        if (!response.ok) {
            const text = await response.text()
            return NextResponse.json(
                { error: text || "Failed to create account" },
                { status: response.status },
            )
        }

        const data = (await response.json()) as {
            user?: { id?: string }
        }
        if (data.user?.id) {
            getDb()
                .update(user)
                .set({ role: "admin", emailVerified: true })
                .where(eq(user.id, data.user.id))
                .run()
        }

        const result = NextResponse.json({ ok: true })
        for (const cookie of response.headers.getSetCookie()) {
            result.headers.append("set-cookie", cookie)
        }
        return result
    } catch (error) {
        console.error("[setup] Failed to create initial user:", error)
        return NextResponse.json(
            { error: "Failed to create account" },
            { status: 500 },
        )
    }
}
