import { z } from "zod"

export const MAX_TITLE_LENGTH = 200
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024
export const MAX_IMPORT_SESSIONS = 200

export function getMaxDiagramXmlBytes(): number {
    const mb = Number(process.env.MAX_DIAGRAM_XML_MB)
    return (Number.isFinite(mb) && mb > 0 ? mb : 10) * 1024 * 1024
}

export function getMaxMessageDataBytes(): number {
    const mb = Number(process.env.MAX_MESSAGE_DATA_MB)
    return (Number.isFinite(mb) && mb > 0 ? mb : 10) * 1024 * 1024
}

export function getMaxRequestBodyBytes(): number {
    const mb = Number(process.env.MAX_REQUEST_BODY_MB)
    return (Number.isFinite(mb) && mb > 0 ? mb : 20) * 1024 * 1024
}

const titleSchema = z.string().max(MAX_TITLE_LENGTH)

const snapshotsSchema = z
    .array(z.tuple([z.number().int().nonnegative(), z.string()]))
    .max(5000)

const messagesSchema = z.array(z.unknown()).max(20000)

const thumbnailDataUrlSchema = z
    .string()
    .max(MAX_THUMBNAIL_BYTES * 2)
    .refine(
        (value) =>
            /^data:image\/(png|webp|jpeg);base64,[a-z0-9+/=]+$/i.test(value),
        { message: "Thumbnail must be a base64 PNG/WebP/JPEG data URL" },
    )

function withinXmlLimit(value: string | undefined): boolean {
    if (value === undefined) return true
    return Buffer.byteLength(value, "utf8") <= getMaxDiagramXmlBytes()
}

function withinMessageLimit(value: unknown): boolean {
    if (value === undefined) return true
    try {
        return (
            Buffer.byteLength(JSON.stringify(value), "utf8") <=
            getMaxMessageDataBytes()
        )
    } catch {
        return false
    }
}

export const createDiagramSchema = z
    .object({
        title: titleSchema.optional(),
        sourceId: z.string().min(1).max(64).optional(),
        diagramXml: z.string().optional(),
        messages: messagesSchema.optional(),
        xmlSnapshots: snapshotsSchema.optional(),
        thumbnailDataUrl: thumbnailDataUrlSchema.optional(),
    })
    .refine((value) => withinXmlLimit(value.diagramXml), {
        message: "Diagram XML exceeds the configured size limit",
    })
    .refine((value) => withinMessageLimit(value.messages), {
        message: "Message data exceeds the configured size limit",
    })

export const updateDiagramSchema = z
    .object({
        baseRevision: z.number().int().positive().optional(),
        title: titleSchema.optional(),
        diagramXml: z.string().optional(),
        messages: messagesSchema.optional(),
        xmlSnapshots: snapshotsSchema.optional(),
        thumbnailDataUrl: thumbnailDataUrlSchema.nullable().optional(),
        createVersion: z.boolean().optional(),
        versionLabel: z.string().max(100).nullable().optional(),
    })
    .refine((value) => withinXmlLimit(value.diagramXml), {
        message: "Diagram XML exceeds the configured size limit",
    })
    .refine((value) => withinMessageLimit(value.messages), {
        message: "Message data exceeds the configured size limit",
    })

export const importSessionSchema = z
    .object({
        title: titleSchema.optional(),
        createdAt: z.number().int().nonnegative().optional(),
        updatedAt: z.number().int().nonnegative().optional(),
        diagramXml: z.string().optional(),
        messages: messagesSchema.optional(),
        xmlSnapshots: snapshotsSchema.optional(),
        thumbnailDataUrl: thumbnailDataUrlSchema.optional(),
    })
    .refine((value) => withinXmlLimit(value.diagramXml), {
        message: "Diagram XML exceeds the configured size limit",
    })
    .refine((value) => withinMessageLimit(value.messages), {
        message: "Message data exceeds the configured size limit",
    })

export const importDiagramsSchema = z.object({
    sessions: z.array(importSessionSchema).min(1).max(MAX_IMPORT_SESSIONS),
})

export const createVersionSchema = z
    .object({
        diagramXml: z.string(),
        label: z.string().max(100).nullable().optional(),
        previewDataUrl: thumbnailDataUrlSchema.nullable().optional(),
    })
    .refine((value) => withinXmlLimit(value.diagramXml), {
        message: "Diagram XML exceeds the configured size limit",
    })

export type CreateDiagramInputBody = z.infer<typeof createDiagramSchema>
export type UpdateDiagramInputBody = z.infer<typeof updateDiagramSchema>
export type ImportDiagramsInputBody = z.infer<typeof importDiagramsSchema>
export type CreateVersionInputBody = z.infer<typeof createVersionSchema>
