import { MAX_THUMBNAIL_BYTES } from "@/lib/validation/diagram"

export interface ParsedImage {
    mime: string
    buffer: Buffer
}

const DATA_URL_PATTERN =
    /^data:(image\/(?:png|webp|jpeg));base64,([a-z0-9+/=]+)$/i

function hasValidMagicBytes(mime: string, buffer: Buffer): boolean {
    if (buffer.length < 12) return false
    if (mime === "image/png") {
        return (
            buffer[0] === 0x89 &&
            buffer[1] === 0x50 &&
            buffer[2] === 0x4e &&
            buffer[3] === 0x47
        )
    }
    if (mime === "image/jpeg") {
        return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    }
    if (mime === "image/webp") {
        return (
            buffer.toString("ascii", 0, 4) === "RIFF" &&
            buffer.toString("ascii", 8, 12) === "WEBP"
        )
    }
    return false
}

/**
 * Decodes a base64 raster image data URL. SVG and any non-raster formats are
 * rejected on purpose: previews are never rendered as raw markup.
 */
export function parseImageDataUrl(
    dataUrl: unknown,
    maxBytes = MAX_THUMBNAIL_BYTES,
): ParsedImage | null {
    if (typeof dataUrl !== "string") return null
    const match = DATA_URL_PATTERN.exec(dataUrl.trim())
    if (!match) return null

    const mime = match[1].toLowerCase()
    const base64 = match[2]
    if (base64.length > maxBytes * 2) return null

    let buffer: Buffer
    try {
        buffer = Buffer.from(base64, "base64")
    } catch {
        return null
    }

    if (buffer.length === 0 || buffer.length > maxBytes) return null
    if (!hasValidMagicBytes(mime, buffer)) return null

    return { mime, buffer }
}
