/**
 * Decide what to do with an autosave event while a freshly loaded session is
 * still hydrating Draw.io.
 *
 * Draw.io fires an autosave right after a diagram is loaded, echoing the XML
 * that was just injected. That echo must not be persisted. Hydration is a
 * one-shot gate: the first chart change either matches the echo (ignore it and
 * end hydration) or differs (end hydration and treat it as a real edit).
 */
export function consumeHydrationEcho(
    baseline: string | null,
    nextXml: string,
): { baseline: string | null; isEcho: boolean } {
    if (baseline === null) {
        return { baseline: null, isEcho: false }
    }
    return { baseline: null, isEcho: nextXml === baseline }
}
