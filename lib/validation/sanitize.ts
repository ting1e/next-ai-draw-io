/**
 * Removes ASCII control characters (including DEL) from user-supplied text.
 * Used for titles and filenames so they can be safely embedded in headers
 * and file names.
 */
export function stripControlCharacters(value: string): string {
    let result = ""
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0
        if (code >= 0x20 && code !== 0x7f) {
            result += char
        }
    }
    return result
}

/**
 * Sanitizes a diagram title / export filename.
 */
export function sanitizeFilename(value: string, fallback = "diagram"): string {
    const cleaned = stripControlCharacters(value)
        .replace(/[/\\:*?"<>|]/g, "")
        .trim()
        .slice(0, 100)
    return cleaned || fallback
}
