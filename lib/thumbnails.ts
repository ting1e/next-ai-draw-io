"use client"

const MAX_THUMBNAIL_DIMENSION = 512

/**
 * Converts an SVG/data image URL into a PNG data URL using an offscreen
 * canvas. Returns null when the source cannot be rasterized (e.g. tainted
 * canvas) - callers should simply skip the thumbnail in that case.
 */
export async function toPngDataUrl(source: string): Promise<string | null> {
    if (typeof document === "undefined") return null
    if (source.startsWith("data:image/png")) return source

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
                    MAX_THUMBNAIL_DIMENSION / Math.max(width, height),
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
