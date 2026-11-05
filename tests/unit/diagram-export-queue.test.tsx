import { act, renderHook } from "@testing-library/react"
import type { EventExport } from "react-drawio"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DiagramProvider, useDiagram } from "@/contexts/diagram-context"

const SVG_DATA = "data:image/svg+xml;base64,PHN2Zy8+"
const PNG_DATA =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
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
