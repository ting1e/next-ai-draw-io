import { NextResponse } from "next/server"
import { countUsers, isAuthEnabled } from "@/lib/auth/auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
    const authEnabled = isAuthEnabled()
    return NextResponse.json({
        accessCodeRequired: !!process.env.ACCESS_CODE_LIST,
        dailyRequestLimit: Number(process.env.DAILY_REQUEST_LIMIT) || 0,
        dailyTokenLimit: Number(process.env.DAILY_TOKEN_LIMIT) || 0,
        tpmLimit: Number(process.env.TPM_LIMIT) || 0,
        authEnabled,
        needsSetup: authEnabled ? countUsers() === 0 : false,
    })
}
