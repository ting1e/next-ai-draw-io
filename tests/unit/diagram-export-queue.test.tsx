import { act, renderHook } from "@testing-library/react"
import type { EventExport } from "react-drawio"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DiagramProvider, useDiagram } from "@/contexts/diagram-context"

vi.mock("@/lib/utils", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/utils")>()
    return {
        ...actual,
        extractDiagramXML: (data: string) => {
            if (data.includes("T05F")) return "<mxfile>one</mxfile>"
            if (data.includes("VFdP")) return "<mxfile>two</mxfile>"
            return "<mxfile>normal</mxfile>"
        },
    }
})

const SVG_DATA = "data:image/svg+xml;base64,PHN2Zy8+"
const PNG_DATA =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
const SVG_ONE = "data:image/svg+xml;base64,T05F"
const SVG_TWO = "data:image/svg+xml;base64,VFdP"
const DIAGRAM_XML = `<mxfile><diagram name="Page-1" id="page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node" value="Export queue fixture with enough content to count as a real diagram" vertex="1" parent="1"><mxGeometry x="100" y="100" width="200" height="80" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`

function exportEvent(data: string, format: "xmlsvg" | "png"): EventExport {
    return {
        event: "export",
        format,
        message: {},
        data,
        xml: "",
    } as EventExport
}

function setup() {
    const exportDiagram = vi.fn()
    const drawio = {
        load: vi.fn(),
        exportDiagram,
    }
    const { result } = renderHook(() => useDiagram(), {
        wrapper: DiagramProvider,
    })

    act(() => {
        result.current.drawioRef.current = drawio as never
        result.current.loadDiagram(DIAGRAM_XML, true)
    })

    return { result, exportDiagram }
}

afterEach(() => {
    vi.useRealTimers()
})

describe("DiagramProvider export queue", () => {
    it("clears a completed export timeout before the next request", async () => {
        vi.useFakeTimers()
        const { result, exportDiagram } = setup()

        let first!: Promise<string | null>
        act(() => {
            first = result.current.getThumbnailSvg()
        })
        expect(exportDiagram).toHaveBeenCalledTimes(1)

        act(() => {
            result.current.handleDiagramExport(exportEvent(SVG_DATA, "xmlsvg"))
        })
        await expect(first).resolves.toBe(SVG_DATA)

        // The first request's 3s timeout must not be able to clear the second
        // request's resolver when it fires here.
        act(() => {
            vi.advanceTimersByTime(1000)
        })
        let second!: Promise<string | null>
        act(() => {
            second = result.current.getThumbnailSvg()
        })
        expect(exportDiagram).toHaveBeenCalledTimes(2)

        act(() => {
            vi.advanceTimersByTime(2100)
        })
        act(() => {
            result.current.handleDiagramExport(exportEvent(SVG_DATA, "xmlsvg"))
        })
        act(() => {
            vi.advanceTimersByTime(1000)
        })

        await expect(second).resolves.toBe(SVG_DATA)
    })

    it("recreates the export channel after a user export timeout and ignores late responses", async () => {
        vi.useFakeTimers()
        const { result, exportDiagram } = setup()

        act(() => {
            result.current.onDrawioLoad()
        })
        act(() => {
            result.current.handleExport()
        })
        expect(exportDiagram).toHaveBeenCalledTimes(1)

        act(() => {
            vi.advanceTimersByTime(10_000)
        })
        expect(result.current.exportChannelEpoch).toBe(1)
        expect(result.current.isDrawioReady).toBe(false)

        // The next request waits for the fresh iframe.
        act(() => {
            result.current.handleExport()
        })
        expect(exportDiagram).toHaveBeenCalledTimes(1)

        // A late response from the timed-out channel is discarded.
        act(() => {
            result.current.handleDiagramExport(exportEvent(SVG_DATA, "xmlsvg"))
        })
        expect(result.current.latestSvg).toBe("")
        expect(exportDiagram).toHaveBeenCalledTimes(1)

        await act(async () => {
            result.current.onDrawioLoad()
        })
        await act(async () => {
            vi.advanceTimersByTime(0)
        })
        expect(exportDiagram).toHaveBeenCalledTimes(2)

        act(() => {
            result.current.handleDiagramExport(exportEvent(SVG_DATA, "xmlsvg"))
        })
        expect(result.current.latestSvg).toBe(SVG_DATA)
    })

    it("resumes the queue when the recreated iframe never loads", async () => {
        vi.useFakeTimers()
        const { result, exportDiagram } = setup()

        act(() => {
            result.current.handleExport()
        })
        act(() => {
            vi.advanceTimersByTime(10_000)
        })
        expect(result.current.exportChannelEpoch).toBe(1)

        act(() => {
            result.current.handleExport()
        })
        // Recovery blocks the queue until its deadline, then lets the next
        // task start (and time out) instead of hanging forever.
        expect(exportDiagram).toHaveBeenCalledTimes(1)
        await act(async () => {
            vi.advanceTimersByTime(5000)
        })
        expect(exportDiagram).toHaveBeenCalledTimes(2)

        act(() => {
            vi.advanceTimersByTime(10_000)
        })
        expect(result.current.exportChannelEpoch).toBe(2)
    })

    it("does not recreate the iframe when a thumbnail export times out", async () => {
        vi.useFakeTimers()
        const { result, exportDiagram } = setup()

        act(() => {
            result.current.onDrawioLoad()
        })

        let timedOut!: Promise<string | null>
        act(() => {
            timedOut = result.current.getThumbnailSvg()
        })
        act(() => {
            vi.advanceTimersByTime(3000)
        })
        await expect(timedOut).resolves.toBeNull()
        expect(result.current.exportChannelEpoch).toBe(0)
        expect(result.current.isDrawioReady).toBe(true)

        // Saving continues with the existing editor: the next background
        // export starts immediately instead of waiting for a reload.
        let next!: Promise<string | null>
        act(() => {
            next = result.current.getThumbnailSvg()
        })
        expect(exportDiagram).toHaveBeenCalledTimes(2)
        act(() => {
            vi.advanceTimersByTime(3000)
        })
        await expect(next).resolves.toBeNull()
        expect(result.current.exportChannelEpoch).toBe(0)
    })

    it("accepts autosaves again after the recreated iframe loads", async () => {
        vi.useFakeTimers()
        const { result } = setup()

        let timedOut!: Promise<string | null>
        act(() => {
            timedOut = result.current.getThumbnailSvg()
        })
        act(() => {
            vi.advanceTimersByTime(3000)
        })
        await expect(timedOut).resolves.toBeNull()

        const edited = DIAGRAM_XML.replace(
            "Export queue fixture",
            "Edited after remount",
        )
        // While the replacement iframe is not ready, a late autosave must not
        // overwrite the pending restore.
        act(() => {
            result.current.handleDiagramAutoSave({ xml: edited })
        })
        expect(result.current.chartXML).toBe(DIAGRAM_XML)

        await act(async () => {
            result.current.onDrawioLoad()
        })
        act(() => {
            result.current.handleDiagramAutoSave({ xml: edited })
        })
        expect(result.current.chartXML).toBe(edited)
    })

    it("records history per export task instead of using a global flag", async () => {
        const { result } = setup()

        act(() => {
            result.current.handleExport()
        })
        act(() => {
            result.current.handleDiagramExport(exportEvent(SVG_ONE, "xmlsvg"))
        })
        expect(result.current.diagramHistory.map((item) => item.xml)).toEqual([
            "<mxfile>one</mxfile>",
        ])

        act(() => {
            result.current.handleExportWithoutHistory()
        })
        act(() => {
            result.current.handleDiagramExport(exportEvent(SVG_DATA, "xmlsvg"))
        })
        expect(result.current.diagramHistory).toHaveLength(1)

        act(() => {
            result.current.handleExport()
        })
        act(() => {
            result.current.handleDiagramExport(exportEvent(SVG_TWO, "xmlsvg"))
        })
        expect(result.current.diagramHistory.map((item) => item.xml)).toEqual([
            "<mxfile>one</mxfile>",
            "<mxfile>two</mxfile>",
        ])
    })

    it("serializes SVG and PNG exports instead of racing resolvers", async () => {
        vi.useFakeTimers()
        const { result, exportDiagram } = setup()

        let thumbnail!: Promise<string | null>
        let validation!: Promise<string | null>
        act(() => {
            thumbnail = result.current.getThumbnailSvg()
            validation = result.current.captureValidationPng()
        })

        // The PNG request waits until the SVG request has been answered.
        expect(exportDiagram).toHaveBeenCalledTimes(1)
        expect(exportDiagram.mock.calls[0][0]).toMatchObject({
            format: "xmlsvg",
        })

        act(() => {
            result.current.handleDiagramExport(exportEvent(SVG_DATA, "xmlsvg"))
        })
        await expect(thumbnail).resolves.toBe(SVG_DATA)
        expect(exportDiagram).toHaveBeenCalledTimes(2)
        expect(exportDiagram.mock.calls[1][0]).toMatchObject({ format: "png" })

        act(() => {
            result.current.handleDiagramExport(exportEvent(PNG_DATA, "png"))
        })
        await expect(validation).resolves.toBe(PNG_DATA)
    })
})
