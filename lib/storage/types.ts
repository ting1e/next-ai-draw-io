import type {
    ChatSession,
    SessionMetadata,
    StoredMessage,
} from "@/lib/session-storage"

export type SaveOutcome =
    | {
          ok: true
          revision?: number
          updatedAt?: number
          thumbnailUrl?: string
      }
    | { ok: false; error: "conflict"; server: ChatSession }
    | { ok: false; error: "failed"; message?: string }

export interface CreateSessionInput {
    title?: string
    messages?: StoredMessage[]
    xmlSnapshots?: [number, string][]
    diagramXml?: string
    thumbnailDataUrl?: string
    createdAt?: number
    updatedAt?: number
}

export interface SaveOptions {
    /** Force creation of a version snapshot (AI edit finished / explicit save). */
    createVersion?: boolean
    versionLabel?: string
}

export interface SessionStorageProvider {
    readonly kind: "indexeddb" | "server"
    isAvailable(): boolean
    list(options?: { search?: string }): Promise<SessionMetadata[]>
    get(id: string): Promise<ChatSession | null>
    create(input?: CreateSessionInput): Promise<ChatSession>
    save(session: ChatSession, options?: SaveOptions): Promise<SaveOutcome>
    delete(id: string): Promise<void>
    rename(id: string, title: string): Promise<void>
    duplicate(id: string): Promise<ChatSession | null>
}

export function toSessionData(session: ChatSession) {
    return {
        messages: session.messages,
        xmlSnapshots: session.xmlSnapshots,
        diagramXml: session.diagramXml,
        thumbnailDataUrl: session.thumbnailDataUrl,
        diagramHistory: session.diagramHistory,
        revision: session.revision,
    }
}
