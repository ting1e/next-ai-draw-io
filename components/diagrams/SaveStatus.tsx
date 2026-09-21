"use client"

import { AlertTriangle, Check, Loader2, WifiOff } from "lucide-react"
import { useDictionary } from "@/hooks/use-dictionary"
import type { SaveState } from "@/hooks/use-session-manager"

export function SaveStatus({ state }: { state: SaveState }) {
    const dict = useDictionary()

    if (state === "idle") return null

    if (state === "saving") {
        return (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span className="hidden sm:inline">{dict.diagrams.saving}</span>
            </span>
        )
    }

    if (state === "saved") {
        return (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
                <Check className="h-3 w-3" />
                <span className="hidden sm:inline">{dict.diagrams.saved}</span>
            </span>
        )
    }

    if (state === "conflict") {
        return (
            <span className="flex items-center gap-1 text-xs text-amber-600">
                <AlertTriangle className="h-3 w-3" />
                <span className="hidden sm:inline">
                    {dict.diagrams.conflict}
                </span>
            </span>
        )
    }

    return (
        <span className="flex items-center gap-1 text-xs text-destructive">
            <WifiOff className="h-3 w-3" />
            <span className="hidden sm:inline">{dict.diagrams.saveError}</span>
        </span>
    )
}
