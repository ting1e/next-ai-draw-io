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

    // Refs mirroring the current session state so saves always observe the
    // latest values without depending on React render timing.
    const currentSessionRef = useRef<ChatSession | null>(null)
    const currentSessionIdRef = useRef<string | null>(null)
    // Latest known server revision for the current session. Updated
    // immediately after every successful load/save so queued saves never
    // PATCH against a stale revision (which would cause false 409 conflicts).
    const revisionRef = useRef<number | undefined>(undefined)

    // Single-flight save queue. Only one provider.save runs at a time; saves
    // requested while another is in flight are coalesced into one follow-up
    // save that uses the latest data. This prevents concurrent PATCHes that
    // would race on `revision` and produce false 409 conflicts.
    const activeSaveRef = useRef<Promise<SaveOutcome> | null>(null)
    const queuedSaveRef = useRef<{
        data: SessionData
        targetSessionId: string | null
        promise: Promise<SaveOutcome>
        resolve: (outcome: SaveOutcome) => void
    } | null>(null)

    const isInitializedRef = useRef(false)
    // Sequence guard for URL changes - prevents out-of-order async resolution
    const urlChangeSequenceRef = useRef(0)

    // Central helper: update current-session state and all mirrors/refs in
    // one place so the save queue can read fresh values.
    const applyCurrentSession = useCallback((session: ChatSession | null) => {
        currentSessionRef.current = session
        currentSessionIdRef.current = session?.id ?? null
        revisionRef.current = session?.revision
        setCurrentSession(session)
        setCurrentSessionId(session?.id ?? null)
    }, [])

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
                        applyCurrentSession(session)
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
    }, [initialSessionId, provider, applyCurrentSession])

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
                            applyCurrentSession(session)
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
    }, [initialSessionId, isAvailable, provider, applyCurrentSession])

    // Refresh sessions on window focus (multi-tab sync)
    useEffect(() => {
        const handleFocus = () => {
            refreshSessions()
        }
        window.addEventListener("focus", handleFocus)
        return () => window.removeEventListener("focus", handleFocus)
    }, [refreshSessions])

    // Switch to a different session
    // Note: no save happens here. The caller (e.g. handleSelectSession) is
    // responsible for saving the current session exactly once, routed through
    // the save queue. Saving again here would re-send the same revision while
    // React state is still stale and trigger a false 409 conflict.
    const switchSession = useCallback(
        async (id: string): Promise<SessionData | null> => {
            if (id === currentSessionId) return null
            if (!provider) return null

            // Load the target session
            const session = await provider.get(id)
            if (!session) {
                console.error("Session not found:", id)
                return null
            }

            // Update state
            applyCurrentSession(session)
            setSaveState("idle")
            setConflict(null)

            return toSessionData(session)
        },
        [currentSessionId, provider, applyCurrentSession],
    )

    // Delete a session
    const deleteSession = useCallback(
        async (id: string): Promise<{ wasCurrentSession: boolean }> => {
            if (!provider) return { wasCurrentSession: false }
            const wasCurrentSession = id === currentSessionIdRef.current
            await provider.delete(id)

            // If deleting current session, clear state (caller will show new empty session)
            if (wasCurrentSession) {
                applyCurrentSession(null)
            }

            await refreshSessions()

            return { wasCurrentSession }
        },
        [provider, applyCurrentSession, refreshSessions],
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

    // Single-flight save used by every save entry point (debounced autosave,
    // session switch, page hidden, manual/AI-edit saves). See activeSaveRef.
    const performSave = useCallback(
        async (
            data: SessionData,
            targetSessionId: string | null,
        ): Promise<SaveOutcome> => {
            if (!provider) {
                return { ok: false, error: "failed", message: "Not available" }
            }

            // Drop saves whose target is no longer the current session
            // (the user switched away while this save was queued).
            if (targetSessionId !== currentSessionIdRef.current) {
                return { ok: false, error: "failed", message: "Stale session" }
            }

            setSaveState("saving")

            try {
                let session = currentSessionRef.current
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
                        // Always PATCH against the newest known revision -
                        // the React state copy may be stale when saves queue up.
                        revision: revisionRef.current ?? existing.revision,
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
                    // Update the latest revision immediately (before React
                    // state catches up) so a queued follow-up save uses it.
                    // Only repoint the current session if this save still
                    // belongs to it - the user may have switched away while
                    // the save was in flight.
                    if (
                        justCreated
                            ? currentSessionIdRef.current == null
                            : currentSessionIdRef.current === session.id
                    ) {
                        applyCurrentSession(updatedSession)
                    }
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
        [provider, applyCurrentSession, refreshSessions, updateMetadataList],
    )

    // Save current session data. Every entry point goes through here:
    // - At most one provider.save (PATCH) is ever in flight.
    // - Saves requested while one is in flight are coalesced: the queued
    //   save keeps the newest payload (version-snapshot flags are OR-ed) and
    //   runs once, with the latest revision, after the active save settles.
    // forSessionId: if provided, verify save targets correct session (prevents stale debounce writes)
    const saveCurrentSession = useCallback(
        (
            data: SessionData,
            forSessionId?: string | null,
        ): Promise<SaveOutcome> => {
            if (
                forSessionId !== undefined &&
                forSessionId !== currentSessionIdRef.current
            ) {
                return Promise.resolve({
                    ok: false,
                    error: "failed",
                    message: "Stale session",
                })
            }
            if (!provider) {
                return Promise.resolve({
                    ok: false,
                    error: "failed",
                    message: "Not available",
                })
            }

            // Pin the target at enqueue time so a queued save can be
            // dropped if the user switches sessions before it runs.
            const targetSessionId = currentSessionIdRef.current

            const startSave = (
                payload: SessionData,
                sessionId: string | null,
                resolve?: (outcome: SaveOutcome) => void,
            ): Promise<SaveOutcome> => {
                const run = performSave(payload, sessionId)
                    .then((outcome) => {
                        resolve?.(outcome)
                        return outcome
                    })
                    .finally(() => {
                        if (activeSaveRef.current === run) {
                            activeSaveRef.current = null
                        }
                        const next = queuedSaveRef.current
                        if (next) {
                            queuedSaveRef.current = null
                            startSave(
                                next.data,
                                next.targetSessionId,
                                next.resolve,
                            )
                        }
                    })
                activeSaveRef.current = run
                return run
            }

            if (activeSaveRef.current) {
                const queued = queuedSaveRef.current
                if (queued && queued.targetSessionId === targetSessionId) {
                    // Coalesce into the pending save: newest content wins,
                    // version snapshots survive either request.
                    queuedSaveRef.current = {
                        ...queued,
                        data: {
                            ...data,
                            createVersion:
                                data.createVersion || queued.data.createVersion,
                            versionLabel:
                                data.versionLabel ?? queued.data.versionLabel,
                        },
                    }
                    return queued.promise
                }
                if (queued) {
                    // Pending save targets a session that is no longer
                    // current - replace it and resolve its waiters as stale.
                    queued.resolve({
                        ok: false,
                        error: "failed",
                        message: "Stale session",
                    })
                }
                let resolve!: (outcome: SaveOutcome) => void
                const promise = new Promise<SaveOutcome>((r) => {
                    resolve = r
                })
                queuedSaveRef.current = {
                    data,
                    targetSessionId,
                    promise,
                    resolve,
                }
                return promise
            }

            return startSave(data, targetSessionId)
        },
        [provider, performSave],
    )

    // Clear current session state (for starting fresh without loading another session)
    const clearCurrentSession = useCallback(() => {
        applyCurrentSession(null)
        setConflict(null)
        setSaveState("idle")
    }, [applyCurrentSession])

    const renameSession = useCallback(
        async (id: string, title: string) => {
            if (!provider) return
            await provider.rename(id, title)
            if (
                id === currentSessionIdRef.current &&
                currentSessionRef.current
            ) {
                applyCurrentSession({
                    ...currentSessionRef.current,
                    title,
                })
            }
            await refreshSessions()
        },
        [provider, applyCurrentSession, refreshSessions],
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
        applyCurrentSession(serverSession)
        setConflict(null)
        setSaveState("idle")
        await refreshSessions()
        return toSessionData(serverSession)
    }, [conflict, applyCurrentSession, refreshSessions])

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
        applyCurrentSession(copy)
        setConflict(null)
        setSaveState("saved")
        await refreshSessions()
        return toSessionData(copy)
    }, [provider, applyCurrentSession, refreshSessions])

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
