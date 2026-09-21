"use client"

import { Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useDictionary } from "@/hooks/use-dictionary"
import { getApiEndpoint } from "@/lib/base-path"
import { formatMessage } from "@/lib/i18n/utils"
import {
    getAllSessionMetadata,
    getSession,
    isIndexedDBAvailable,
} from "@/lib/session-storage"
import { encodeThumbnailForServer } from "@/lib/thumbnails"

export const SERVER_IMPORT_MARKER = "next-ai-draw-io-imported-to-server"
const IMPORT_BATCH_SIZE = 5

interface ImportLegacyDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onImported?: () => void
}

export function ImportLegacyDialog({
    open,
    onOpenChange,
    onImported,
}: ImportLegacyDialogProps) {
    const dict = useDictionary()
    const [count, setCount] = useState(0)
    const [importing, setImporting] = useState(false)

    useEffect(() => {
        if (!open) return
        if (!isIndexedDBAvailable()) return
        getAllSessionMetadata()
            .then((metadata) => setCount(metadata.length))
            .catch(() => setCount(0))
    }, [open])

    const handleImport = async () => {
        setImporting(true)
        let imported = 0
        try {
            const metadata = await getAllSessionMetadata()
            const payloads: unknown[] = []

            for (const meta of metadata) {
                const session = await getSession(meta.id)
                if (!session) continue
                // Raw SVG history is never uploaded; thumbnails are rasterized.
                const thumbnailDataUrl = await encodeThumbnailForServer(
                    session.thumbnailDataUrl,
                )
                payloads.push({
                    title: session.title,
                    createdAt: session.createdAt,
                    updatedAt: session.updatedAt,
                    diagramXml: session.diagramXml,
                    messages: session.messages,
                    xmlSnapshots: session.xmlSnapshots,
                    ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
                })
            }

            for (let i = 0; i < payloads.length; i += IMPORT_BATCH_SIZE) {
                const batch = payloads.slice(i, i + IMPORT_BATCH_SIZE)
                const response = await fetch(
                    getApiEndpoint("/api/diagrams/import"),
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ sessions: batch }),
                    },
                )
                if (!response.ok) {
                    throw new Error(`Import failed with ${response.status}`)
                }
                const data = (await response.json()) as { imported: number }
                imported += data.imported
            }

            // Legacy data is intentionally kept locally as a safety net.
            localStorage.setItem(SERVER_IMPORT_MARKER, "true")
            toast.success(
                formatMessage(dict.diagrams.importSuccess, { count: imported }),
            )
            onImported?.()
            onOpenChange(false)
        } catch (error) {
            console.error("Failed to import legacy sessions:", error)
            toast.error(dict.diagrams.importFailed)
        } finally {
            setImporting(false)
        }
    }

    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {dict.diagrams.importTitle}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {formatMessage(dict.diagrams.importDescription, {
                            count,
                        })}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={importing}>
                        {dict.diagrams.importLater}
                    </AlertDialogCancel>
                    <AlertDialogAction
                        onClick={handleImport}
                        disabled={importing || count === 0}
                    >
                        {importing && (
                            <Loader2 className="h-4 w-4 animate-spin mr-1" />
                        )}
                        {formatMessage(dict.diagrams.importAction, { count })}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    )
}
