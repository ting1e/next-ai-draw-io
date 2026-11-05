import { describe, expect, it } from "vitest"
import {
    shouldRefreshThumbnail,
    THUMBNAIL_REFRESH_INTERVAL_MS,
} from "@/lib/thumbnails"

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
