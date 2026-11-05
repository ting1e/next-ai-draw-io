import { describe, expect, it } from "vitest"
import { consumeHydrationEcho } from "@/lib/autosave-hydration"

describe("consumeHydrationEcho", () => {
    it("passes edits through when not hydrating", () => {
        expect(consumeHydrationEcho(null, "<mxfile>edited</mxfile>")).toEqual({
            baseline: null,
            isEcho: false,
        })
    })

    it("ignores an identical post-load echo and ends hydration", () => {
        expect(
            consumeHydrationEcho(
                "<mxfile>loaded</mxfile>",
                "<mxfile>loaded</mxfile>",
            ),
        ).toEqual({ baseline: null, isEcho: true })
    })

    it("treats a changed XML as a real edit and ends hydration", () => {
        expect(
            consumeHydrationEcho(
                "<mxfile>loaded</mxfile>",
                "<mxfile>edited</mxfile>",
            ),
        ).toEqual({ baseline: null, isEcho: false })
    })
})
