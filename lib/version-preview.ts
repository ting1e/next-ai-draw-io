/**
 * A historical version should only carry a preview when the uploaded image
 * was generated from the same XML revision. Missing fingerprints mean the
 * client could not prove the match, so the version is stored without a
 * preview instead of showing a stale image.
 */
export function selectVersionPreview<T>(
    image: T | undefined,
    thumbnailFingerprint: string | undefined,
    diagramFingerprint: string | undefined,
): T | undefined {
    if (!image || !thumbnailFingerprint || !diagramFingerprint) {
        return undefined
    }
    return thumbnailFingerprint === diagramFingerprint ? image : undefined
}
