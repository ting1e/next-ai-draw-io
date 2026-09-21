"use client"

import { History, Loader2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import Image from "@/components/image-with-basepath"
import { Button } from "@/components/ui/button"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { useDictionary } from "@/hooks/use-dictionary"
import { getApiEndpoint } from "@/lib/base-path"
import { formatMessage } from "@/lib/i18n/utils"

export interface DiagramVersionItem {
    revision: number
    createdAt: number
    label: string | null
    hasPreview: boolean
    previewUrl?: string
}

interface VersionHistoryDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    diagramId: string | null
    onRestore: (xml: string) => void
    onSaveVersion?: () => Promise<void>
}

export function VersionHistoryDialog({
    open,
    onOpenChange,
    diagramId,
    onRestore,
    onSaveVersion,
}: VersionHistoryDialogProps) {
    const dict = useDictionary()
    const [versions, setVersions] = useState<DiagramVersionItem[]>([])
    const [loading, setLoading] = useState(false)
    const [restoring, setRestoring] = useState<number | null>(null)
    const [selected, setSelected] = useState<number | null>(null)
    const [savingVersion, setSavingVersion] = useState(false)

    const loadVersions = useCallback(async () => {
        if (!diagramId) return
        setLoading(true)
        try {
            const response = await fetch(
                getApiEndpoint(`/api/diagrams/${diagramId}/versions`),
                { cache: "no-store" },
            )
            if (!response.ok) throw new Error("Failed to load versions")
            const data = (await response.json()) as {
                versions: DiagramVersionItem[]
            }
            setVersions(data.versions)
        } catch (error) {
            console.error(error)
        } finally {
            setLoading(false)
        }
    }, [diagramId])

    useEffect(() => {
        if (open) {
            setSelected(null)
            loadVersions()
        }
    }, [open, loadVersions])

    const handleRestore = async (revision: number) => {
        if (!diagramId) return
        setRestoring(revision)
        try {
            const response = await fetch(
                getApiEndpoint(
                    `/api/diagrams/${diagramId}/versions/${revision}`,
                ),
                { method: "POST" },
            )
            if (!response.ok) throw new Error("Failed to restore version")
            const data = (await response.json()) as { diagramXml: string }
            onRestore(data.diagramXml)
            toast.success(
                formatMessage(dict.diagrams.restoreTitle, {
                    version: revision,
                }),
            )
            onOpenChange(false)
        } catch (error) {
            console.error(error)
            toast.error(dict.diagrams.saveError)
        } finally {
            setRestoring(null)
        }
    }

    const handleSaveVersion = async () => {
        if (!onSaveVersion) return
        setSavingVersion(true)
        try {
            await onSaveVersion()
            await loadVersions()
        } finally {
            setSavingVersion(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto scrollbar-thin">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <History className="h-4 w-4" />
                        {dict.diagrams.versions}
                    </DialogTitle>
                    <DialogDescription>
                        {dict.history.description}
                    </DialogDescription>
                </DialogHeader>

                {loading ? (
                    <div className="flex items-center justify-center py-8 text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin" />
                    </div>
                ) : versions.length === 0 ? (
                    <div className="text-center p-4 text-gray-500">
                        {dict.diagrams.noVersions}
                    </div>
                ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 py-4">
                        {versions.map((version) => (
                            <div
                                key={version.revision}
                                className={`border rounded-md p-2 cursor-pointer hover:border-primary transition-colors ${
                                    selected === version.revision
                                        ? "border-primary ring-2 ring-primary"
                                        : ""
                                }`}
                                onClick={() => setSelected(version.revision)}
                            >
                                <div className="aspect-video bg-white rounded overflow-hidden flex items-center justify-center">
                                    {version.previewUrl ? (
                                        <Image
                                            src={version.previewUrl}
                                            alt={`${dict.history.version} ${version.revision}`}
                                            width={200}
                                            height={100}
                                            unoptimized
                                            className="object-contain w-full h-full p-1"
                                        />
                                    ) : (
                                        <span className="text-xs text-muted-foreground">
                                            {dict.history.version}{" "}
                                            {version.revision}
                                        </span>
                                    )}
                                </div>
                                <div className="text-xs text-center mt-1 text-gray-500">
                                    {dict.history.version} {version.revision}
                                    {version.label ? ` · ${version.label}` : ""}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                <DialogFooter className="gap-2">
                    {onSaveVersion && (
                        <Button
                            variant="outline"
                            onClick={handleSaveVersion}
                            disabled={savingVersion}
                            className="mr-auto"
                        >
                            {savingVersion && (
                                <Loader2 className="h-4 w-4 animate-spin mr-1" />
                            )}
                            {dict.diagrams.saveVersion}
                        </Button>
                    )}
                    {selected !== null ? (
                        <>
                            <div className="flex-1 text-sm text-muted-foreground">
                                {formatMessage(dict.diagrams.restoreTitle, {
                                    version: selected,
                                })}
                            </div>
                            <Button
                                variant="outline"
                                onClick={() => setSelected(null)}
                            >
                                {dict.common.cancel}
                            </Button>
                            <Button
                                onClick={() => handleRestore(selected)}
                                disabled={restoring !== null}
                            >
                                {restoring !== null && (
                                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                                )}
                                {dict.diagrams.restore}
                            </Button>
                        </>
                    ) : (
                        <Button
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                        >
                            {dict.common.close}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
