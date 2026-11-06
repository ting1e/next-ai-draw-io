import { describe, expect, it } from "vitest"
import { diagramXmlFingerprint } from "@/lib/diagram-fingerprint"
import { selectVersionPreview } from "@/lib/version-preview"

describe("diagramXmlFingerprint", () => {
    it("is stable for the same XML and changes with the content", () => {
        const first = diagramXmlFingerprint("<mxfile>one</mxfile>")
        expect(diagramXmlFingerprint("<mxfile>one</mxfile>")).toBe(first)
        expect(diagramXmlFingerprint("<mxfile>two</mxfile>")).not.toBe(first)
    })

    it("distinguishes an empty diagram from a real one", () => {
        expect(diagramXmlFingerprint("")).not.toBe(
            diagramXmlFingerprint("<mxfile/>"),
        )
    })
})

describe("selectVersionPreview", () => {
    const image = { mime: "image/png", buffer: Buffer.from("png") }

    it("accepts a preview generated from the versioned XML", () => {
        const fingerprint = diagramXmlFingerprint("<mxfile>v2</mxfile>")
        expect(selectVersionPreview(image, fingerprint, fingerprint)).toBe(
            image,
        )
    })

    it("rejects a preview from an older edit", () => {
        expect(
            selectVersionPreview(
                image,
                diagramXmlFingerprint("<mxfile>v1</mxfile>"),
                diagramXmlFingerprint("<mxfile>v2</mxfile>"),
            ),
        ).toBeUndefined()
    })

    it("rejects a preview when either side cannot prove the match", () => {
        expect(selectVersionPreview(image, undefined, "abc")).toBeUndefined()
        expect(selectVersionPreview(image, "abc", undefined)).toBeUndefined()
        expect(selectVersionPreview(undefined, "abc", "abc")).toBeUndefined()
    })
})
