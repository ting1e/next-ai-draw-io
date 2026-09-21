import { randomUUID } from "crypto"
import { z } from "zod"
import { guardAuth } from "@/lib/auth/server"
import { getLangfuseClient } from "@/lib/langfuse"
import { readJsonBody } from "@/lib/validation/http"

const MAX_LOG_BODY_BYTES = 64 * 1024

const saveSchema = z.object({
    filename: z.string().min(1).max(255),
    format: z.enum(["drawio", "png", "svg"]),
    sessionId: z.string().min(1).max(200).optional(),
})

export async function POST(req: Request) {
    const langfuse = getLangfuseClient()
    if (!langfuse) {
        return Response.json({ success: true, logged: false })
    }

    const auth = await guardAuth()
    if (auth.denied) return auth.denied

    // Validate input
    const bodyResult = await readJsonBody(req, MAX_LOG_BODY_BYTES)
    if (!bodyResult.ok) {
        return Response.json(
            { success: false, error: bodyResult.error },
            { status: bodyResult.status },
        )
    }
    let data
    try {
        data = saveSchema.parse(bodyResult.data)
    } catch {
        return Response.json(
            { success: false, error: "Invalid input" },
            { status: 400 },
        )
    }

    const { filename, format, sessionId } = data

    // Skip logging if no sessionId - prevents attaching to wrong user's trace
    if (!sessionId) {
        return Response.json({ success: true, logged: false })
    }

    try {
        const timestamp = new Date().toISOString()

        // Find the most recent chat trace for this session to attach the save flag
        const tracesResponse = await langfuse.api.trace.list({
            sessionId,
            limit: 1,
        })

        const traces = tracesResponse.data || []
        const latestTrace = traces[0]

        if (latestTrace) {
            // Add a score to the existing trace to flag that user saved
            await langfuse.api.ingestion.batch({
                batch: [
                    {
                        type: "score-create",
                        id: randomUUID(),
                        timestamp,
                        body: {
                            id: randomUUID(),
                            traceId: latestTrace.id,
                            name: "diagram-saved",
                            value: 1,
                            comment: `User saved diagram as ${filename}.${format}`,
                        },
                    },
                ],
            })
        }
        // If no trace found, skip logging (user hasn't chatted yet)

        return Response.json({ success: true, logged: !!latestTrace })
    } catch (error) {
        console.error("Langfuse save error:", error)
        return Response.json(
            { success: false, error: "Failed to log save" },
            { status: 500 },
        )
    }
}
