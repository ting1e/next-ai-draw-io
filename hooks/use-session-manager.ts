"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
    type ChatSession,
    extractTitle,
    type SessionMetadata,
    type StoredMessage,
} from "@/lib/session-storage"
import { createIndexedDbProvider } from "@/lib/storage/indexeddb-storage"
import type { SaveOutcome, SessionStorageProvider } from "@/lib/storage/types"

export interface SessionData {
    id?: string
    messages: StoredMessage[]
    xmlSnapshots: [number, string][]
    diagramXml: string
    thumbnailDataUrl?: string
    diagramHistory?: { svg: string; xml: string }[]
    revision?: number
    /** Force creation of a server-side version snapshot for this save. */
    createVersion?: boolean
    versionLabel?: string
}

export type SaveState = "idle" | "saving" | "saved" | "error" | "conflict"

export interface ConflictState {
    serverSession: ChatSession
}

export interface UseSessionManagerReturn {
    // State
    sessions: SessionMetadata[]
    currentSessionId: string | null
    currentSession: ChatSession | null
    isLoading: boolean
    isAvailable: boolean
    saveState: SaveState
    conflict: ConflictState | null
    providerKind: "indexeddb" | "server"

    // Actions
    switchSession: (id: string) => Promise<SessionData | null>
    deleteSession: (id: string) => Promise<{ wasCurrentSession: boolean }>
    // forSessionId: optional session ID to verify save targets correct session (prevents stale debounce writes)
    saveCurrentSession: (
        data: SessionData,
        forSessionId?: string | null,
    ) => Promise<SaveOutcome>
    refreshSessions: () => Promise<void>
    clearCurrentSession: () => void
    renameSession: (id: string, title: string) => Promise<void>
    duplicateSession: (id: string) => Promise<ChatSession | null>
    resolveConflictReload: () => Promise<SessionData | null>
    resolveConflictSaveCopy: () => Promise<SessionData | null>
}

interface UseSessionManagerOptions {
    /** Session ID from URL param - if provided, load this session; if null, start blank */
    initialSessionId?: string | null
    /**
     * Storage provider. `undefined` keeps the legacy IndexedDB behavior;
     * `null` means the provider is not ready yet (e.g. auth still loading).
     */
    provider?: SessionStorageProvider | null
}

function toSessionData(session: ChatSession): SessionData {
    return {
        id: session.id,
        messages: session.messages,
        xmlSnapshots: session.xmlSnapshots,
        diagramXml: session.diagramXml,
        thumbnailDataUrl: session.thumbnailDataUrl,
        diagramHistory: session.diagramHistory,
        revision: session.revision,
    }
}

export function useSessionManager(
    options: UseSessionManagerOptions = {},
): UseSessionManagerReturn {
    const { initialSessionId, provider: providerOption } = options

    const provider = useMemo<SessionStorageProvider | null>(() => {
        if (providerOption === undefined) return createIndexedDbProvider()
        return providerOption
    }, [providerOption])

    const [sessions, setSessions] = useState<SessionMetadata[]>([])
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(
        null,
    )
    const [currentSession, setCurrentSession] = useState<ChatSession | null>(
        null,
    )
    const [isLoading, setIsLoading] = useState(true)
    const [isAvailable, setIsAvailable] = useState(false)
    const [saveState, setSaveState] = useState<SaveState>("idle")
    const [conflict, setConflict] = useState<ConflictState | null>(null)

    const pendingSaveRef = useRef<{ session: ChatSession } | null>(null)

    const isInitializedRef = useRef(false)
    // Sequence guard for URL changes - prevents out-of-order async resolution
    const urlChangeSequenceRef = useRef(0)

    // Load sessions list
    const refreshSessions = useCallback(async () => {
        if (!provider?.isAvailable()) return
        try {
            const metadata = await provider.list()
            setSessions(metadata)
        } catch (error) {
            console.error("Failed to refresh sessions:", error)
        }
    }, [provider])

    // Initialize on mount / when the provider becomes available
    useEffect(() => {
        if (!provider) return
        if (isInitializedRef.current) return
        isInitializedRef.current = true

        async function init() {
            setIsLoading(true)

            if (!provider?.isAvailable()) {
                setIsAvailable(false)
                setIsLoading(false)
                return
            }

            setIsAvailable(true)

            try {
                if (provider.kind === "indexeddb") {
                    // One-time conversion from the legacy localStorage format.
                    const { migrateFromLocalStorage } = await import(
                        "@/lib/session-storage"
                    )
                    await migrateFromLocalStorage()
                }

                // Load sessions list
                const metadata = await provider.list()
                setSessions(metadata)

                // Only load a session if initialSessionId is provided (from URL param)
                if (initialSessionId) {
                    const session = await provider.get(initialSessionId)
                    if (session) {
                        setCurrentSession(session)
                        setCurrentSessionId(session.id)
                    }
                    // If session not found, stay in blank state (URL has invalid session ID)
                }
                // If no initialSessionId, start with blank state (no auto-restore)
            } catch (error) {
                console.error("Failed to initialize session manager:", error)
            } finally {
                setIsLoading(false)
            }
        }

        init()
    }, [initialSessionId, provider])

    // Handle URL session ID changes after initialization
    // Note: intentionally NOT including currentSessionId in deps to avoid race conditions
    // when clearCurrentSession() is called before URL updates
    useEffect(() => {
        if (!isInitializedRef.current) return // Wait for initial load
        if (!isAvailable) return

        // Increment sequence to invalidate any pending async operations
        urlChangeSequenceRef.current++
        const currentSequence = urlChangeSequenceRef.current

        async function handleSessionIdChange() {
            if (initialSessionId) {
                // URL has session ID - load it
                const session = await provider?.get(initialSessionId)

                // Check if this request is still the latest (sequence guard)
                if (currentSequence !== urlChangeSequenceRef.current) {
                    return
                }

                if (session) {
                    // Only update if the session is different from current
                    setCurrentSessionId((current) => {
                        if (current !== session.id) {
                            setCurrentSession(session)
                            return session.id
                        }
                        return current
                    })
                }
            }
            // Removed: else clause that clears session
            // Clearing is now handled explicitly by clearCurrentSession()
            // This prevents race conditions when URL update is async
        }

        handleSessionIdChange()
    }, [initialSessionId, isAvailable, provider])

    // Refresh sessions on window focus (multi-tab sync)
    useEffect(() => {
        const handleFocus = () => {
            refreshSessions()
        }
        window.addEventListener("focus", handleFocus)
        return () => window.removeEventListener("focus", handleFocus)
    }, [refreshSessions])

    // Switch to a different session
    const switchSession = useCallback(
        async (id: string): Promise<SessionData | null> => {
            if (id === currentSessionId) return null
            if (!provider) return null

            // Save current session first if it has messages
            if (currentSession && currentSession.messages.length > 0) {
                await provider.save(currentSession)
            }

            // Load the target session
            const session = await provider.get(id)
            if (!session) {
                console.error("Session not found:", id)
                return null
            }

            // Update state
            setCurrentSession(session)
            setCurrentSessionId(session.id)
            setSaveState("idle")
            setConflict(null)

            return toSessionData(session)
        },
        [currentSessionId, currentSession, provider],
    )

    // Delete a session
    const deleteSession = useCallback(
        async (id: string): Promise<{ wasCurrentSession: boolean }> => {
            if (!provider) return { wasCurrentSession: false }
            const wasCurrentSession = id === currentSessionId
            await provider.delete(id)

            // If deleting current session, clear state (caller will show new empty session)
            if (wasCurrentSession) {
                setCurrentSession(null)
                setCurrentSessionId(null)
            }

            await refreshSessions()

            return { wasCurrentSession }
        },
        [currentSessionId, provider, refreshSessions],
    )

    const updateMetadataList = useCallback((session: ChatSession) => {
        setSessions((prev) =>
            prev.map((s) =>
                s.id === session.id
                    ? {
                          ...s,
                          title: session.title,
                          updatedAt: session.updatedAt,
                          messageCount: session.messages.length,
                          hasDiagram:
                              !!session.diagramXml &&
                              session.diagramXml.trim().length > 0,
                          thumbnailDataUrl: session.thumbnailDataUrl,
                          revision: session.revision,
                      }
                    : s,
            ),
        )
    }, [])

    // Save current session data (debounced externally by caller)
    // forSessionId: if provided, verify save targets correct session (prevents stale debounce writes)
    const saveCurrentSession = useCallback(
        async (
            data: SessionData,
            forSessionId?: string | null,
        ): Promise<SaveOutcome> => {
            // If forSessionId is provided, verify it matches current session
            // This prevents stale debounced saves from overwriting a newly switched session
            if (
                forSessionId !== undefined &&
                forSessionId !== currentSessionId
            ) {
                return { ok: false, error: "failed", message: "Stale session" }
            }
            if (!provider) {
                return { ok: false, error: "failed", message: "Not available" }
            }

            setSaveState("saving")

            try {
                let session = currentSession
                let justCreated = false

                if (!session) {
                    // Create a new session if none exists
                    session = await provider.create({
                        title: extractTitle(data.messages),
                        messages: data.messages,
                        xmlSnapshots: data.xmlSnapshots,
                        diagramXml: data.diagramXml,
                        thumbnailDataUrl: data.thumbnailDataUrl,
                    })
                    justCreated = true
                } else {
                    const existing = session
                    session = {
                        ...existing,
                        messages: data.messages,
                        xmlSnapshots: data.xmlSnapshots,
                        diagramXml: data.diagramXml,
                        thumbnailDataUrl:
                            data.thumbnailDataUrl ?? existing.thumbnailDataUrl,
                        diagramHistory:
                            data.diagramHistory ?? existing.diagramHistory,
                        updatedAt: Date.now(),
                        // Update title if it's still default and we have messages
                        title:
                            existing.title === "New Chat" &&
                            data.messages.length > 0
                                ? extractTitle(data.messages)
                                : existing.title,
                    }
                }

                const outcome: SaveOutcome = justCreated
                    ? { ok: true, revision: session.revision }
                    : await provider.save(session, {
                          createVersion: data.createVersion,
                          versionLabel: data.versionLabel,
                      })

                if (outcome.ok) {
                    const updatedSession: ChatSession = {
                        ...session,
                        revision: outcome.revision ?? session.revision,
                        updatedAt: outcome.updatedAt ?? session.updatedAt,
                        thumbnailDataUrl:
                            outcome.thumbnailUrl ?? session.thumbnailDataUrl,
                    }
                    setCurrentSession(updatedSession)
                    setCurrentSessionId(updatedSession.id)
                    setSaveState("saved")
                    if (justCreated) {
                        await refreshSessions()
                    } else {
                        updateMetadataList(updatedSession)
                    }
                    return outcome
                }

                if (outcome.error === "conflict") {
                    pendingSaveRef.current = { session }
                    setConflict({ serverSession: outcome.server })
                    setSaveState("conflict")
                    return outcome
                }

                setSaveState("error")
                return outcome
            } catch (error) {
                console.error("Failed to save session:", error)
                setSaveState("error")
                return {
                    ok: false,
                    error: "failed",
                    message: error instanceof Error ? error.message : undefined,
                }
            }
        },
        [
            currentSession,
            currentSessionId,
            provider,
            refreshSessions,
            updateMetadataList,
        ],
    )

    // Clear current session state (for starting fresh without loading another session)
    const clearCurrentSession = useCallback(() => {
        setCurrentSession(null)
        setCurrentSessionId(null)
        setConflict(null)
        setSaveState("idle")
    }, [])

    const renameSession = useCallback(
        async (id: string, title: string) => {
            if (!provider) return
            await provider.rename(id, title)
            if (id === currentSessionId && currentSession) {
                setCurrentSession({ ...currentSession, title })
            }
            await refreshSessions()
        },
        [provider, currentSessionId, currentSession, refreshSessions],
    )

    const duplicateSession = useCallback(
        async (id: string) => {
            if (!provider) return null
            const copy = await provider.duplicate(id)
            await refreshSessions()
            return copy
        },
        [provider, refreshSessions],
    )

    const resolveConflictReload = useCallback(async () => {
        const serverSession = conflict?.serverSession
        if (!serverSession) return null
        pendingSaveRef.current = null
        setCurrentSession(serverSession)
        setCurrentSessionId(serverSession.id)
        setConflict(null)
        setSaveState("idle")
        await refreshSessions()
        return toSessionData(serverSession)
    }, [conflict, refreshSessions])

    const resolveConflictSaveCopy = useCallback(async () => {
        const pending = pendingSaveRef.current
        if (!pending || !provider) return null
        const copy = await provider.create({
            title: `${pending.session.title} (conflict copy)`,
            messages: pending.session.messages,
            xmlSnapshots: pending.session.xmlSnapshots,
            diagramXml: pending.session.diagramXml,
            thumbnailDataUrl: pending.session.thumbnailDataUrl,
        })
        pendingSaveRef.current = null
        setCurrentSession(copy)
        setCurrentSessionId(copy.id)
        setConflict(null)
        setSaveState("saved")
        await refreshSessions()
        return toSessionData(copy)
    }, [provider, refreshSessions])

    return {
        sessions,
        currentSessionId,
        currentSession,
        isLoading,
        isAvailable,
        saveState,
        conflict,
        providerKind: provider?.kind ?? "indexeddb",
        switchSession,
        deleteSession,
        saveCurrentSession,
        refreshSessions,
        clearCurrentSession,
        renameSession,
        duplicateSession,
        resolveConflictReload,
        resolveConflictSaveCopy,
    }
}
