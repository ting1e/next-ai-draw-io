"use client"

import { Copy, Download, Pencil, Trash2 } from "lucide-react"
import type { ReactNode } from "react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useDictionary } from "@/hooks/use-dictionary"

interface DiagramActionsProps {
    title: string
    onRename?: (title: string) => void
    onDuplicate?: () => void
    onDownload?: () => void
    onDelete?: () => void
}

function ActionButton({
    label,
    onClick,
    children,
    destructive = false,
}: {
    label: string
    onClick: () => void
    children: ReactNode
    destructive?: boolean
}) {
    return (
        <button
            type="button"
            title={label}
            aria-label={label}
            onClick={(event) => {
                event.stopPropagation()
                onClick()
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className={`p-1.5 rounded-lg text-muted-foreground transition-all ${
                destructive
                    ? "hover:text-destructive hover:bg-destructive/10"
                    : "hover:text-foreground hover:bg-muted"
            }`}
        >
            {children}
        </button>
    )
}

export function DiagramActions({
    title,
    onRename,
    onDuplicate,
    onDownload,
    onDelete,
}: DiagramActionsProps) {
    const dict = useDictionary()
    const [showRename, setShowRename] = useState(false)
    const [draftTitle, setDraftTitle] = useState(title)

    const openRename = () => {
        setDraftTitle(title)
        setShowRename(true)
    }

    return (
        <>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                {onRename && (
                    <ActionButton
                        label={dict.diagrams.rename}
                        onClick={openRename}
                    >
                        <Pencil className="h-4 w-4" />
                    </ActionButton>
                )}
                {onDuplicate && (
                    <ActionButton
                        label={dict.diagrams.duplicate}
                        onClick={onDuplicate}
                    >
                        <Copy className="h-4 w-4" />
                    </ActionButton>
                )}
                {onDownload && (
                    <ActionButton
                        label={dict.diagrams.downloadDrawio}
                        onClick={onDownload}
                    >
                        <Download className="h-4 w-4" />
                    </ActionButton>
                )}
                {onDelete && (
                    <ActionButton
                        label={dict.diagrams.delete}
                        onClick={onDelete}
                        destructive
                    >
                        <Trash2 className="h-4 w-4" />
                    </ActionButton>
                )}
            </div>

            <Dialog open={showRename} onOpenChange={setShowRename}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{dict.diagrams.renameTitle}</DialogTitle>
                    </DialogHeader>
                    <Input
                        value={draftTitle}
                        onChange={(event) => setDraftTitle(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && draftTitle.trim()) {
                                event.preventDefault()
                                onRename?.(draftTitle.trim())
                                setShowRename(false)
                            }
                        }}
                        maxLength={200}
                        autoFocus
                    />
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setShowRename(false)}
                        >
                            {dict.common.cancel}
                        </Button>
                        <Button
                            disabled={!draftTitle.trim()}
                            onClick={() => {
                                onRename?.(draftTitle.trim())
                                setShowRename(false)
                            }}
                        >
                            {dict.common.save}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )
}
