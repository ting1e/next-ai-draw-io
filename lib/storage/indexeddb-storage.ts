"use client"

import { nanoid } from "nanoid"
import {
    type ChatSession,
    createEmptySession,
    deleteSession as deleteSessionFromDB,
    enforceSessionLimit,
    getAllSessionMetadata,
    getSession,
    isIndexedDBAvailable,
    type SessionMetadata,
    saveSession,
} from "@/lib/session-storage"
import type {
    CreateSessionInput,
    SaveOutcome,
    SessionStorageProvider,
} from "./types"

/**
 * Wraps the existing IndexedDB implementation. IndexedDB remains available
 * for local-only deployments and as the legacy import source.
 */
export function createIndexedDbProvider(): SessionStorageProvider {
    return {
        kind: "indexeddb",
        isAvailable: () => isIndexedDBAvailable(),
        async list(): Promise<SessionMetadata[]> {
            return getAllSessionMetadata()
        },
        async get(id: string): Promise<ChatSession | null> {
            return getSession(id)
        },
        async create(input: CreateSessionInput = {}): Promise<ChatSession> {
            const session: ChatSession = {
                ...createEmptySession(),
                ...input,
                title: input.title || "New Chat",
            }
            await saveSession(session)
            await enforceSessionLimit()
            return session
        },
        async save(session: ChatSession): Promise<SaveOutcome> {
            const saved = await saveSession(session)
            if (!saved) {
                return { ok: false, error: "failed", message: "Quota exceeded" }
            }
            await enforceSessionLimit()
            return { ok: true, updatedAt: session.updatedAt }
        },
        async delete(id: string): Promise<void> {
            await deleteSessionFromDB(id)
        },
        async rename(id: string, title: string): Promise<void> {
            const session = await getSession(id)
            if (!session) return
            await saveSession({ ...session, title, updatedAt: Date.now() })
        },
        async duplicate(id: string): Promise<ChatSession | null> {
            const session = await getSession(id)
            if (!session) return null
            const copy: ChatSession = {
                ...session,
                id: nanoid(),
                title: `${session.title} (copy)`,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }
            await saveSession(copy)
            await enforceSessionLimit()
            return copy
        },
    }
}
