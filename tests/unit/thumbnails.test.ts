import { afterEach, describe, expect, it, vi } from "vitest"
import {
    nextThumbnailBaseline,
    shouldRefreshThumbnail,
    THUMBNAIL_REFRESH_INTERVAL_MS,
    toSizedPngDataUrl,
} from "@/lib/thumbnails"

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe("toSizedPngDataUrl", () => {
    it("rasterizes an existing PNG so version previews stay within 512px", async () => {
        const drawImage = vi.fn()
        const canvas = {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage }),
            toDataURL: () => "data:image/png;base64,resized",
        }

        class FakeImage {
            decoding = ""
            naturalWidth = 1024
            naturalHeight = 768
            width = 1024
            height = 768
            onload: (() => void) | null = null
            onerror: (() => void) | null = null
            set src(_value: string) {
                this.onload?.()
            }
        }

        vi.stubGlobal("Image", FakeImage)
        const originalCreateElement = document.createElement.bind(document)
        vi.spyOn(document, "createElement").mockImplementation(((
            tag: string,
            options?: ElementCreationOptions,
        ) =>
            tag === "canvas"
                ? (canvas as unknown as HTMLElement)
                : originalCreateElement(
                      tag,
                      options,
                  )) as typeof document.createElement)

        await expect(
            toSizedPngDataUrl("data:image/png;base64,original"),
        ).resolves.toBe("data:image/png;base64,resized")
        expect(canvas.width).toBe(512)
        expect(canvas.height).toBe(384)
        expect(drawImage).toHaveBeenCalledTimes(1)
    })
})

const BASE = {
    force: false,
    hasThumbnail: true,
    currentXml: "<mxfile>edited</mxfile>",
    thumbnailXml: "<mxfile>loaded</mxfile>",
}

describe("shouldRefreshThumbnail", () => {
    it("refreshes a missing thumbnail immediately", () => {
        expect(
            shouldRefreshThumbnail({
                ...BASE,
                hasThumbnail: false,
                elapsedMs: 0,
            }),
        ).toBe(true)
    })

    it("refreshes when a version preview or manual save forces it", () => {
        expect(
            shouldRefreshThumbnail({
                ...BASE,
                force: true,
                currentXml: BASE.thumbnailXml,
                elapsedMs: 0,
            }),
        ).toBe(true)
    })

    it("keeps the current thumbnail until the refresh interval elapses", () => {
        expect(
            shouldRefreshThumbnail({
                ...BASE,
                elapsedMs: THUMBNAIL_REFRESH_INTERVAL_MS - 1,
            }),
        ).toBe(false)
    })

    it("refreshes once the XML changed and the interval elapsed", () => {
        expect(
            shouldRefreshThumbnail({
                ...BASE,
                elapsedMs: THUMBNAIL_REFRESH_INTERVAL_MS,
            }),
        ).toBe(true)
    })

    it("does not refresh when the XML is unchanged", () => {
        expect(
            shouldRefreshThumbnail({
                ...BASE,
                currentXml: BASE.thumbnailXml,
                elapsedMs: THUMBNAIL_REFRESH_INTERVAL_MS,
            }),
        ).toBe(false)
    })
})

describe("nextThumbnailBaseline", () => {
    const baseline = {
        xml: "<mxfile>old</mxfile>",
        capturedAt: 1_000,
    }
    const currentXml = "<mxfile>current</mxfile>"
    const data = {
        thumbnailXml: currentXml,
        thumbnailCapturedAt: 2_000,
    }

    it("commits the generated thumbnail only after a successful save", () => {
        expect(nextThumbnailBaseline(baseline, currentXml, data, true)).toEqual(
            { xml: currentXml, capturedAt: 2_000 },
        )
    })

    it("keeps the old baseline on failure and retries on the next save", () => {
        const failed = nextThumbnailBaseline(baseline, currentXml, data, false)
        expect(failed).toEqual({ xml: baseline.xml, capturedAt: 0 })

        const retried = nextThumbnailBaseline(
            failed,
            currentXml,
            { thumbnailXml: currentXml, thumbnailCapturedAt: 3_000 },
            true,
        )
        expect(retried).toEqual({ xml: currentXml, capturedAt: 3_000 })
    })

    it("ignores a thumbnail that belongs to an older edit", () => {
        expect(
            nextThumbnailBaseline(
                baseline,
                "<mxfile>newer</mxfile>",
                data,
                true,
            ),
        ).toBe(baseline)
    })
})
