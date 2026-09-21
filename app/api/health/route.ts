import { NextResponse } from "next/server"
import { isAuthEnabled } from "@/lib/auth/auth"
import { getSqlite } from "@/lib/db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
    let database = "disabled"
    if (isAuthEnabled()) {
        try {
            getSqlite().prepare("SELECT 1").get()
            database = "ok"
        } catch {
            database = "error"
        }
    }

    return NextResponse.json({
        status: database === "error" ? "degraded" : "ok",
        database,
    })
}
