"use client"

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
import type { ConflictState } from "@/hooks/use-session-manager"

interface ConflictDialogProps {
    conflict: ConflictState | null
    onReloadServer: () => void
    onSaveCopy: () => void
}

export function ConflictDialog({
    conflict,
    onReloadServer,
    onSaveCopy,
}: ConflictDialogProps) {
    const dict = useDictionary()

    return (
        <AlertDialog open={!!conflict}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {dict.diagrams.conflictTitle}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {dict.diagrams.conflictDescription}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={onSaveCopy}>
                        {dict.diagrams.saveCopy}
                    </AlertDialogCancel>
                    <AlertDialogAction onClick={onReloadServer}>
                        {dict.diagrams.reloadServer}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    )
}
