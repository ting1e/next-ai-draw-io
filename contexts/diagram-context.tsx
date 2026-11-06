"use client"

import type React from "react"
import { createContext, useContext, useEffect, useRef, useState } from "react"
import type { DrawIoEmbedRef, EventExport } from "react-drawio"
import { toast } from "sonner"
import type { ExportFormat } from "@/components/save-dialog"
import { getApiEndpoint } from "@/lib/base-path"
import {
    extractDiagramXML,
    isRealDiagram,
    validateAndFixXml,
} from "../lib/utils"

interface DiagramContextType {
    chartXML: string
    latestSvg: string
    diagramHistory: { svg: string; xml: string }[]
    setDiagramHistory: (history: { svg: string; xml: string }[]) => void
    loadDiagram: (chart: string, skipValidation?: boolean) => string | null
    handleExport: () => void
    handleExportWithoutHistory: () => void
    resolverRef: React.MutableRefObject<((value: string) => void) | null>
    drawioRef: React.MutableRefObject<DrawIoEmbedRef | null>
    handleDiagramExport: (data: EventExport) => void
    handleDiagramAutoSave: (data: { xml?: string }) => void
    clearDiagram: () => void
    saveDiagramToFile: (
        filename: string,
        format: ExportFormat,
        sessionId?: string,
        successMessage?: string,
    ) => void
    getThumbnailSvg: () => Promise<string | null>
    captureValidationPng: () => Promise<string | null>
    /**
     * Direct PNG export used for version previews. Returns a PNG data URL
     * without going through SVG -> Canvas conversion.
     */
    captureVersionPreviewPng: () => Promise<string | null>
    /** Changes when the iframe is recreated after an export timeout. */
    exportChannelEpoch: number
    isDrawioReady: boolean
    onDrawioLoad: () => void
    resetDrawioReady: () => void
    showSaveDialog: boolean
    setShowSaveDialog: (show: boolean) => void
}

const DiagramContext = createContext<DiagramContextType | undefined>(undefined)

function isSvgExportData(data: string | undefined): data is string {
    return (
        !!data &&
        (data.startsWith("data:image/svg+xml") ||
            data.trimStart().startsWith("<svg"))
    )
}

type DrawioExportFormat = "svg" | "xmlsvg" | "png"

// A recreated iframe normally signals `load` quickly. If it stays silent
// (for example the embed is unreachable), resume the queue so queued exports
// can time out instead of blocking saves forever.
const EXPORT_RECOVERY_TIMEOUT_MS = 5_000

interface ExportTask {
    format: DrawioExportFormat
    timeoutMs: number
    saveToHistory: boolean
    // Background exports (thumbnails, validation snapshots) must never
    // recreate the editor iframe on timeout: doing so reloads the diagram
    // right after a save. Explicit user exports still reset the channel so a
    // late response cannot be consumed by the next task.
    background?: boolean
    onData: (data: EventExport) => void
    onTimeout?: () => void
}

export function DiagramProvider({ children }: { children: React.ReactNode }) {
    const [chartXML, setChartXML] = useState<string>("")
    const [latestSvg, setLatestSvg] = useState<string>("")
    const [diagramHistory, setDiagramHistory] = useState<
        { svg: string; xml: string }[]
    >([])
    const [isDrawioReady, setIsDrawioReady] = useState(false)
    const [exportChannelEpoch, setExportChannelEpoch] = useState(0)
    const [showSaveDialog, setShowSaveDialog] = useState(false)
    const hasCalledOnLoadRef = useRef(false)
    const drawioRef = useRef<DrawIoEmbedRef | null>(null)
    const resolverRef = useRef<((value: string) => void) | null>(null)
    // Draw.io export events do not identify which request they answer, so all
    // exports are serialized. A queued task owns exactly one in-flight export
    // and its own timeout.
    const exportQueueRef = useRef<ExportTask[]>([])
    const activeExportRef = useRef<{
        task: ExportTask
        timer: ReturnType<typeof setTimeout>
    } | null>(null)
    // A timed-out export may still send a late response. Recreate the iframe
    // and pause the queue until the fresh instance has loaded.
    const exportRecoveryPendingRef = useRef(false)
    const exportRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
    )
    // Track latest chartXML for restoration after remount
    const chartXMLRef = useRef<string>("")
    // Mirrors isDrawioReady synchronously. DrawIoEmbed registers its message
    // listener once, so a remounted iframe would otherwise keep calling an
    // autosave handler that captured the pre-remount "not ready" state.
    const isDrawioReadyRef = useRef(false)

    const onDrawioLoad = () => {
        // Only set ready state once to prevent infinite loops
        if (hasCalledOnLoadRef.current) return
        hasCalledOnLoadRef.current = true
        isDrawioReadyRef.current = true
        if (exportRecoveryTimerRef.current) {
            clearTimeout(exportRecoveryTimerRef.current)
            exportRecoveryTimerRef.current = null
        }
        setIsDrawioReady(true)
        // Restore diagram after remount (e.g., theme/UI change)
        if (drawioRef.current && isRealDiagram(chartXMLRef.current)) {
            drawioRef.current.load({ xml: chartXMLRef.current })
        }
    }

    const resetDrawioReady = () => {
        hasCalledOnLoadRef.current = false
        isDrawioReadyRef.current = false
        setIsDrawioReady(false)
    }

    // Keep chartXMLRef in sync with state for restoration after remount
    useEffect(() => {
        chartXMLRef.current = chartXML
    }, [chartXML])

    const handleXmlExportData = (data: EventExport, saveToHistory: boolean) => {
        // Don't write chartXML here: exports don't change the diagram, and
        // data.xml from xmlsvg exports has compressed <diagram> payloads that
        // would break edit_diagram/display_diagram. Autosave keeps chartXML
        // up to date with the full uncompressed multi-page document (#879).
        const extractedXML = extractDiagramXML(data.data)
        setLatestSvg(data.data)

        // Only add to history if this was a user-initiated export
        // Limit to 20 entries to prevent memory leaks during long sessions
        const MAX_HISTORY_SIZE = 20
        if (saveToHistory) {
            setDiagramHistory((prev) => {
                const newHistory = [
                    ...prev,
                    {
                        svg: data.data,
                        xml: extractedXML,
                    },
                ]
                // Keep only the last MAX_HISTORY_SIZE entries (circular buffer)
                return newHistory.slice(-MAX_HISTORY_SIZE)
            })
        }

        if (resolverRef.current) {
            resolverRef.current(extractedXML)
            resolverRef.current = null
        }
    }

    const startNextExport = () => {
        if (activeExportRef.current || exportRecoveryPendingRef.current) return
        const task = exportQueueRef.current.shift()
        if (!task) return

        if (!drawioRef.current) {
            task.onTimeout?.()
            startNextExport()
            return
        }

        const timer = setTimeout(() => {
            const active = activeExportRef.current
            // A stale timer must not clear a newer request's resolver.
            if (!active || active.task !== task) return
            activeExportRef.current = null
            try {
                task.onTimeout?.()
            } finally {
                if (task.background) {
                    // Saving must not reload the editor. A late background
                    // response is harmless: it describes the same diagram and
                    // at worst becomes the next thumbnail.
                    startNextExport()
                } else {
                    // The old iframe may still answer. Recreate it so a late
                    // response cannot be consumed by the next queued task.
                    exportRecoveryPendingRef.current = true
                    hasCalledOnLoadRef.current = false
                    isDrawioReadyRef.current = false
                    setIsDrawioReady(false)
                    setExportChannelEpoch((epoch) => epoch + 1)
                    if (exportRecoveryTimerRef.current) {
                        clearTimeout(exportRecoveryTimerRef.current)
                    }
                    exportRecoveryTimerRef.current = setTimeout(() => {
                        exportRecoveryTimerRef.current = null
                        if (!exportRecoveryPendingRef.current) return
                        exportRecoveryPendingRef.current = false
                        startNextExport()
                    }, EXPORT_RECOVERY_TIMEOUT_MS)
                }
            }
        }, task.timeoutMs)

        activeExportRef.current = { task, timer }
        try {
            drawioRef.current.exportDiagram({ format: task.format })
        } catch {
            clearTimeout(timer)
            activeExportRef.current = null
            task.onTimeout?.()
            startNextExport()
        }
    }

    const requestExport = (task: ExportTask) => {
        exportQueueRef.current.push(task)
        startNextExport()
    }

    // Resume the queue only after the recreated iframe has loaded.
    useEffect(() => {
        if (!isDrawioReady || !exportRecoveryPendingRef.current) return
        exportRecoveryPendingRef.current = false
        if (exportRecoveryTimerRef.current) {
            clearTimeout(exportRecoveryTimerRef.current)
            exportRecoveryTimerRef.current = null
        }
        startNextExport()
    })

    const requestXmlExport = (saveToHistory: boolean) => {
        if (!drawioRef.current) return
        requestExport({
            format: "xmlsvg",
            timeoutMs: 10_000,
            saveToHistory,
            onData: (data) => handleXmlExportData(data, saveToHistory),
        })
    }

    const handleExport = () => requestXmlExport(true)

    const handleExportWithoutHistory = () => requestXmlExport(false)

    // Get current diagram as SVG for thumbnail (used by session storage)
    const getThumbnailSvg = async (): Promise<string | null> => {
        if (!drawioRef.current) return null
        // Don't export if diagram is empty
        if (!isRealDiagram(chartXMLRef.current)) return null

        return new Promise<string | null>((resolve) => {
            let settled = false
            const finish = (value: string | null) => {
                if (settled) return
                settled = true
                resolve(value)
            }

            requestExport({
                format: "xmlsvg",
                timeoutMs: 3000,
                saveToHistory: false,
                background: true,
                onData: (data) => {
                    const svgData = isSvgExportData(data.data)
                        ? data.data
                        : null
                    if (svgData) setLatestSvg(svgData)
                    finish(svgData)
                },
                onTimeout: () => finish(null),
            })
        })
    }

    // Capture the current diagram as a PNG using Draw.io's own raster export.
    const capturePng = async (timeoutMs: number): Promise<string | null> => {
        if (!drawioRef.current) return null
        // Don't export if diagram is empty
        if (!isRealDiagram(chartXMLRef.current)) return null

        return new Promise<string | null>((resolve) => {
            let settled = false
            const finish = (value: string | null) => {
                if (settled) return
                settled = true
                resolve(value)
            }

            requestExport({
                format: "png",
                timeoutMs,
                saveToHistory: false,
                background: true,
                onData: (data) => {
                    finish(
                        data.data?.startsWith("data:image/png")
                            ? data.data
                            : null,
                    )
                },
                onTimeout: () => finish(null),
            })
        })
    }

    // Capture current diagram as PNG for VLM validation
    const captureValidationPng = () => capturePng(5000)

    // Version previews need a slightly longer budget than validation
    // snapshots because they are created during an explicit save.
    const captureVersionPreviewPng = () => capturePng(10_000)

    const loadDiagram = (
        chart: string,
        skipValidation?: boolean,
    ): string | null => {
        let xmlToLoad = chart

        // Validate XML structure before loading (unless skipped for internal use)
        if (!skipValidation) {
            const validation = validateAndFixXml(chart)
            if (!validation.valid) {
                console.warn(
                    "[loadDiagram] Validation error:",
                    validation.error,
                )
                return validation.error
            }
            // Use fixed XML if auto-fix was applied
            if (validation.fixed) {
                console.log(
                    "[loadDiagram] Auto-fixed XML issues:",
                    validation.fixes,
                )
                xmlToLoad = validation.fixed
            }
        }

        // Keep chartXML in sync even when diagrams are injected (e.g., display_diagram tool)
        setChartXML(xmlToLoad)

        if (drawioRef.current) {
            drawioRef.current.load({
                xml: xmlToLoad,
            })
        }

        return null
    }

    const handleDiagramExport = (data: EventExport) => {
        // The iframe is being replaced; anything arriving now belongs to the
        // timed-out channel.
        if (exportRecoveryPendingRef.current) return

        const active = activeExportRef.current
        if (active) {
            // A late response for a previously timed-out request must not be
            // mistaken for the current one.
            if (data.format !== active.task.format) return
            clearTimeout(active.timer)
            activeExportRef.current = null
            try {
                active.task.onData(data)
            } catch (error) {
                console.error("Failed to process diagram export:", error)
            } finally {
                startNextExport()
            }
            return
        }

        // Unsolicited exports (for example from the editor UI) can still be
        // surfaced as diagram history. Raster formats have no XML to extract.
        if (data.format === "png" || data.format === "xmlpng") return
        try {
            handleXmlExportData(data, false)
        } catch (error) {
            console.error("Failed to process diagram export:", error)
        }
    }

    const handleDiagramAutoSave = (data: { xml?: string }) => {
        if (!data?.xml) return
        // Don't overwrite a pending restore - if we have a real diagram in state
        // but DrawIO isn't ready yet, it means we're waiting to restore.
        // Read refs instead of render values because the embed installs this
        // listener only once, including across iframe recreations.
        if (!isDrawioReadyRef.current && isRealDiagram(chartXMLRef.current)) {
            return
        }
        setChartXML(data.xml)
    }

    const clearDiagram = () => {
        const emptyDiagram = `<mxfile><diagram name="Page-1" id="page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`
        // Skip validation for trusted internal template (loadDiagram also sets chartXML)
        loadDiagram(emptyDiagram, true)
        setLatestSvg("")
        setDiagramHistory([])
    }

    const saveDiagramToFile = (
        filename: string,
        format: ExportFormat,
        sessionId?: string,
        successMessage?: string,
    ) => {
        if (!drawioRef.current) {
            console.warn("Draw.io editor not ready")
            return
        }

        // Map format to draw.io export format
        const drawioFormat: DrawioExportFormat =
            format === "drawio" || format === "xmlsvg" ? "xmlsvg" : format

        requestExport({
            format: drawioFormat,
            timeoutMs: 10_000,
            saveToHistory: false,
            onData: (data) => {
                const exportData = data.data
                const fullDiagramXML = data.xml
                let fileContent: string | Blob
                let mimeType: string
                let extension: string

                if (format === "drawio") {
                    // Prefer the complete document from the export event so all pages are saved.
                    const xml = fullDiagramXML?.trim()
                        ? fullDiagramXML
                        : extractDiagramXML(exportData)
                    let xmlContent = xml
                    if (!xml.includes("<mxfile")) {
                        xmlContent = `<mxfile><diagram name="Page-1" id="page-1">${xml}</diagram></mxfile>`
                    }
                    fileContent = xmlContent
                    mimeType = "application/xml"
                    extension = ".drawio"
                } else if (format === "png") {
                    // PNG data comes as base64 data URL
                    fileContent = exportData
                    mimeType = "image/png"
                    extension = ".png"
                } else if (format === "xmlsvg") {
                    // Editable SVG: pass data URL directly (like PNG)
                    fileContent = exportData
                    mimeType = "image/svg+xml"
                    extension = ".drawio.svg"
                } else {
                    // SVG format (view-only)
                    fileContent = exportData
                    mimeType = "image/svg+xml"
                    extension = ".svg"
                }

                // Log save event to Langfuse (flags the trace)
                logSaveToLangfuse(filename, format, sessionId)

                // Handle download
                let url: string
                if (
                    typeof fileContent === "string" &&
                    fileContent.startsWith("data:")
                ) {
                    // Already a data URL (PNG)
                    url = fileContent
                } else {
                    const blob = new Blob([fileContent], { type: mimeType })
                    url = URL.createObjectURL(blob)
                }

                const a = document.createElement("a")
                a.href = url
                a.download = `${filename}${extension}`
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)

                // Show success toast after download is initiated
                if (successMessage) {
                    toast.success(successMessage, {
                        position: "bottom-left",
                        duration: 2500,
                    })
                }

                // Delay URL revocation to ensure download completes
                if (!url.startsWith("data:")) {
                    setTimeout(() => URL.revokeObjectURL(url), 100)
                }
            },
            onTimeout: () => {
                console.warn("Draw.io export timed out while saving")
            },
        })
    }

    // Log save event to Langfuse (just flags the trace, doesn't send content)
    const logSaveToLangfuse = async (
        filename: string,
        format: string,
        sessionId?: string,
    ) => {
        try {
            await fetch(getApiEndpoint("/api/log-save"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename, format, sessionId }),
            })
        } catch (error) {
            console.warn("Failed to log save to Langfuse:", error)
        }
    }

    return (
        <DiagramContext.Provider
            value={{
                chartXML,
                latestSvg,
                diagramHistory,
                setDiagramHistory,
                loadDiagram,
                handleExport,
                handleExportWithoutHistory,
                resolverRef,
                drawioRef,
                handleDiagramExport,
                handleDiagramAutoSave,
                clearDiagram,
                saveDiagramToFile,
                getThumbnailSvg,
                captureValidationPng,
                captureVersionPreviewPng,
                exportChannelEpoch,
                isDrawioReady,
                onDrawioLoad,
                resetDrawioReady,
                showSaveDialog,
                setShowSaveDialog,
            }}
        >
            {children}
        </DiagramContext.Provider>
    )
}

export function useDiagram() {
    const context = useContext(DiagramContext)
    if (context === undefined) {
        throw new Error("useDiagram must be used within a DiagramProvider")
    }
    return context
}
