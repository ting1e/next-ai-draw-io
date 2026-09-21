import { describe, expect, it } from "vitest"
import { parseImageDataUrl } from "@/lib/images"
import {
    createDiagramSchema,
    updateDiagramSchema,
} from "@/lib/validation/diagram"
import {
    sanitizeFilename,
    stripControlCharacters,
} from "@/lib/validation/sanitize"

const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`

describe("parseImageDataUrl", () => {
    it("accepts a real PNG data URL", () => {
        const parsed = parseImageDataUrl(PNG_DATA_URL)
        expect(parsed?.mime).toBe("image/png")
        expect(parsed?.buffer.equals(PNG_BYTES)).toBe(true)
    })

    it("rejects SVG data URLs", () => {
        const svg = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`
        expect(parseImageDataUrl(svg)).toBeNull()
    })

    it("rejects mismatched magic bytes", () => {
        const fake = `data:image/png;base64,${Buffer.from("not a png at all").toString("base64")}`
        expect(parseImageDataUrl(fake)).toBeNull()
    })

    it("rejects oversized images", () => {
        expect(parseImageDataUrl(PNG_DATA_URL, 4)).toBeNull()
    })

    it("rejects non-string input", () => {
        expect(parseImageDataUrl(null)).toBeNull()
    })
})

describe("sanitizeFilename", () => {
    it("removes path separators and control characters", () => {
        expect(sanitizeFilename("a/b\\c:d*e?f")).toBe("abcdef")
        expect(sanitizeFilename("a\u0000b\nc")).toBe("abc")
    })

    it("falls back for empty input", () => {
        expect(sanitizeFilename("   ", "diagram")).toBe("diagram")
    })

    it("truncates very long names", () => {
        expect(sanitizeFilename("x".repeat(500)).length).toBe(100)
    })

    it("stripControlCharacters keeps normal text", () => {
        expect(stripControlCharacters("hello world")).toBe("hello world")
    })
})

describe("diagram validation schemas", () => {
    it("rejects titles longer than 200 characters", () => {
        const result = createDiagramSchema.safeParse({
            title: "x".repeat(201),
        })
        expect(result.success).toBe(false)
    })

    it("accepts a valid create payload", () => {
        const result = createDiagramSchema.safeParse({
            title: "Architecture",
            diagramXml: "<mxfile/>",
            messages: [{ id: "m1" }],
            xmlSnapshots: [[0, "<mxfile/>"]],
        })
        expect(result.success).toBe(true)
    })

    it("rejects thumbnails that are not raster data URLs", () => {
        const result = createDiagramSchema.safeParse({
            thumbnailDataUrl: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
        })
        expect(result.success).toBe(false)
    })

    it("rejects diagram XML beyond the configured limit", () => {
        const previous = process.env.MAX_DIAGRAM_XML_MB
        process.env.MAX_DIAGRAM_XML_MB = "0.001"
        try {
            const result = updateDiagramSchema.safeParse({
                baseRevision: 1,
                diagramXml: "x".repeat(4096),
            })
            expect(result.success).toBe(false)
        } finally {
            if (previous === undefined) {
                process.env.MAX_DIAGRAM_XML_MB = undefined
            } else {
                process.env.MAX_DIAGRAM_XML_MB = previous
            }
        }
    })

    it("requires a positive base revision", () => {
        expect(updateDiagramSchema.safeParse({ baseRevision: 0 }).success).toBe(
            false,
        )
        expect(updateDiagramSchema.safeParse({ baseRevision: 3 }).success).toBe(
            true,
        )
    })
})
