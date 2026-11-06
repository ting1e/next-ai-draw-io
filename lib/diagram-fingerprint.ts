/**
 * Fast, stable fingerprint used to match a preview image with the diagram
 * XML it was generated from. This is not a security hash: the client and
 * server only compare fingerprints to avoid attaching a stale thumbnail to a
 * historical version.
 */
export function diagramXmlFingerprint(xml: string): string {
    let hash = 2166136261
    for (let index = 0; index < xml.length; index++) {
        hash ^= xml.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
    }
    return `${xml.length.toString(36)}-${(hash >>> 0).toString(16)}`
}
