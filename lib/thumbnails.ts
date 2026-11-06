"use client"

const MAX_THUMBNAIL_DIMENSION = 512
// Matches MAX_THUMBNAIL_BYTES * 2 in lib/validation/diagram.ts. A 512px PNG
// is far smaller, but the save must survive an unexpected encoder result.
const MAX_VERSION_PREVIEW_DATA_URL_LENGTH = 4 * 1024 * 1024
export const THUMBNAIL_REFRESH_INTERVAL_MS = 60_000

/**
 * Thumbnails are expensive to export, rasterize and upload, so keep the
 * existing preview while the user is editing and refresh it periodically.
 * Missing previews, explicit version saves and manual/page-hide saves always
 * refresh.
 */
export function shouldRefreshThumbnail({
    force,
    hasThumbnail,
    currentXml,
    thumbnailXml,
    elapsedMs,
    intervalMs = THUMBNAIL_REFRESH_INTERVAL_MS,
}: {
    force: boolean
    hasThumbnail: boolean
    currentXml: string
    thumbnailXml: string | null
    elapsedMs: number
    intervalMs?: number
}): boolean {
    if (force) return true
    if (!hasThumbnail) return true
    if (!currentXml || currentXml === thumbnailXml) return false
    return elapsedMs >= intervalMs
}

export interface ThumbnailBaseline {
    xml: string | null
    capturedAt: number
}

/**
 * Applies the result of a save to the thumbnail baseline. A generated
 * thumbnail may only become the baseline once the save that uploaded it
 * succeeded. On failure the XML is kept but the throttle is cleared so the
 * next save regenerates it immediately.
 */
export function nextThumbnailBaseline(
    baseline: ThumbnailBaseline,
    currentXml: string,
    data: { thumbnailXml?: string; thumbnailCapturedAt?: number },
    saved: boolean,
): ThumbnailBaseline {
    if (!data.thumbnailXml || data.thumbnailXml !== currentXml) {
        return baseline
    }
    if (saved) {
        if (!data.thumbnailCapturedAt) return baseline
        return {
            xml: data.thumbnailXml,
            capturedAt: data.thumbnailCapturedAt,
        }
    }
    if (baseline.capturedAt === 0) return baseline
    return { xml: baseline.xml, capturedAt: 0 }
}

/**
 * Converts an SVG/data image URL into a PNG data URL using an offscreen
 * canvas. Returns null when the source cannot be rasterized (e.g. tainted
 * canvas) - callers should simply skip the thumbnail in that case.
 */
function rasterizeToPng(
    source: string,
    maxDimension: number,
    keepPngSource: boolean,
): Promise<string | null> {
    if (typeof document === "undefined") return Promise.resolve(null)
    if (keepPngSource && source.startsWith("data:image/png")) {
        return Promise.resolve(source)
    }

    const url = source.startsWith("<svg")
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
        : source

    return new Promise((resolve) => {
        const image = new window.Image()
        image.decoding = "async"
        image.onload = () => {
            try {
                const width = image.naturalWidth || image.width || 1
                const height = image.naturalHeight || image.height || 1
                const scale = Math.min(
                    1,
                    maxDimension / Math.max(width, height),
                )
                const canvas = document.createElement("canvas")
                canvas.width = Math.max(1, Math.round(width * scale))
                canvas.height = Math.max(1, Math.round(height * scale))
                const context = canvas.getContext("2d")
                if (!context) {
                    resolve(null)
                    return
                }
                context.drawImage(image, 0, 0, canvas.width, canvas.height)
                resolve(canvas.toDataURL("image/png"))
            } catch {
                resolve(null)
            }
        }
        image.onerror = () => resolve(null)
        image.src = url
    })
}

export function toPngDataUrl(source: string): Promise<string | null> {
    return rasterizeToPng(source, MAX_THUMBNAIL_DIMENSION, true)
}

/**
 * Always rasterizes and downscales the source to the thumbnail bounds. Used
 * for version previews so a large Draw.io PNG export stays within the server
 * image limit.
 */
export function toSizedPngDataUrl(source: string): Promise<string | null> {
    return rasterizeToPng(source, MAX_THUMBNAIL_DIMENSION, false).then((png) =>
        // The server rejects oversized data URLs, so treat an unexpectedly
        // large preview as a failed preview instead of failing the save.
        png && png.length <= MAX_VERSION_PREVIEW_DATA_URL_LENGTH ? png : null,
    )
}

/**
 * Normalizes a client thumbnail for upload. Existing server thumbnail URLs
 * are ignored (the stored blob is still valid), anything else is rasterized
 * to PNG. Raw SVG is never uploaded.
 */
export async function encodeThumbnailForServer(
    value: string | undefined,
): Promise<string | undefined> {
    if (!value) return undefined
    if (value.startsWith("data:image/png")) return value
    if (value.startsWith("data:") || value.startsWith("<svg")) {
        return (await toPngDataUrl(value)) ?? undefined
    }
    return undefined
}
