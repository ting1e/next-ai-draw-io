import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import {
    type SessionData,
    useSessionManager,
} from "@/hooks/use-session-manager"
import type { ChatSession } from "@/lib/session-storage"
import type { SaveOutcome, SessionStorageProvider } from "@/lib/storage/types"

const USER_MESSAGE = {
    id: "m1",
    role: "user" as const,
    parts: [{ type: "text" as const, text: "hi" }],
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
    return {
        id: "d1",
        title: "Test",
        createdAt: 1,
        updatedAt: 2,
        messages: [USER_MESSAGE],
        xmlSnapshots: [],
        diagramXml: "<mxfile/>",
        revision: 3,
        ...overrides,
    }
}

interface Deferred {
    resolve: (outcome: SaveOutcome) => void
    promise: Promise<SaveOutcome>
}

function deferred(): Deferred {
    let resolve!: Deferred["resolve"]
    const promise = new Promise<SaveOutcome>((r) => {
        resolve = r
    })
    return { resolve, promise }
}

/**
 * Provider mock whose `save` calls park on manually-resolved gates so tests
 * can hold a save "in flight" and observe how the queue behaves.
 */
function makeProvider() {
    const saveCalls: {
        revision?: number
        diagramXml: string
        createVersion?: boolean
    }[] = []
    const gates: Deferred[] = []
    const provider: SessionStorageProvider = {
        kind: "server",
        isAvailable: () => true,
        list: async () => [],
        get: async (id) => session({ id, revision: id === "d1" ? 3 : 7 }),
        create: async (input) =>
            session({
                id: "new-1",
                revision: 1,
                diagramXml: input?.diagramXml ?? "",
                messages: input?.messages ?? [],
            }),
        save: async (s, options) => {
            saveCalls.push({
                revision: s.revision,
                diagramXml: s.diagramXml,
                createVersion: options?.createVersion,
            })
            const gate = deferred()
            gates.push(gate)
            return gate.promise
        },
        delete: async () => {},
        rename: async () => {},
        duplicate: async () => null,
        restoreVersion: async () => ({
            diagramXml: "RESTORED",
            revision: 6,
        }),
    }
    return { provider, saveCalls, gates }
}

/**
 * Minimal in-memory server that enforces the same revision/conflict contract as
 * the real server storage, so tests can simulate two clients editing at once.
 */
function makeFakeServer(initial: {
    id: string
    revision: number
    diagramXml: string
}) {
    let revision = initial.revision
    let diagramXml = initial.diagramXml
    let lastCreatedXml: string | null = null

    const snapshot = (over: Partial<ChatSession> = {}): ChatSession =>
        session({ id: initial.id, revision, diagramXml, ...over })

    const provider: SessionStorageProvider = {
        kind: "server",
        isAvailable: () => true,
        list: async () => [],
        get: async (id) => (id === initial.id ? snapshot() : null),
        create: async (input) => {
            lastCreatedXml = input?.diagramXml ?? ""
            return session({
                id: "copy-1",
                revision: 1,
                diagramXml: lastCreatedXml,
                messages: input?.messages ?? [],
            })
        },
        save: async (s) => {
            if (s.revision !== revision) {
                return { ok: false, error: "conflict", server: snapshot() }
            }
            revision += 1
            diagramXml = s.diagramXml
            return { ok: true, revision }
        },
        delete: async () => {},
        rename: async () => {},
        duplicate: async () => null,
    }

    return {
        provider,
        revision: () => revision,
        setRevision: (next: number) => {
            revision = next
        },
        savedXml: () => diagramXml,
        createdXml: () => lastCreatedXml,
    }
}

const DATA_A = {
    messages: [],
    xmlSnapshots: [] as [number, string][],
    diagramXml: "A",
}
const DATA_B = {
    messages: [],
    xmlSnapshots: [] as [number, string][],
    diagramXml: "B",
}
const DATA_C = {
    messages: [],
    xmlSnapshots: [] as [number, string][],
    diagramXml: "C",
    createVersion: true,
}

afterEach(() => {
    document.body.innerHTML = ""
})

describe("useSessionManager save queue", () => {
    it("serializes saves: queued save PATCHes with the revision from the previous save", async () => {
        const { provider, saveCalls, gates } = makeProvider()
        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: "d1", provider }),
        )

        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.currentSession?.revision).toBe(3)

        let first!: Promise<SaveOutcome>
        let second!: Promise<SaveOutcome>
        act(() => {
            first = result.current.saveCurrentSession(DATA_A)
            // Requested while the first save is still in flight -> queued
            second = result.current.saveCurrentSession(DATA_B)
        })

        // Only one PATCH may be in flight
        expect(saveCalls).toHaveLength(1)
        expect(saveCalls[0]).toMatchObject({ revision: 3, diagramXml: "A" })

        // First save succeeds -> server revision becomes 4
        await act(async () => {
            gates[0].resolve({ ok: true, revision: 4, updatedAt: 10 })
        })
        await waitFor(() => expect(saveCalls).toHaveLength(2))

        // The queued save must use revision 4 (not the stale 3) -> no false 409
        expect(saveCalls[1]).toMatchObject({ revision: 4, diagramXml: "B" })

        await act(async () => {
            gates[1].resolve({ ok: true, revision: 5, updatedAt: 20 })
        })
        const outcome = await second
        await first
        expect(outcome).toMatchObject({ ok: true, revision: 5 })
        expect(result.current.currentSession?.revision).toBe(5)
    })

    it("coalesces saves requested during a save into one PATCH with the newest payload", async () => {
        const { provider, saveCalls, gates } = makeProvider()
        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: "d1", provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        let first!: Promise<SaveOutcome>
        let second!: Promise<SaveOutcome>
        let third!: Promise<SaveOutcome>
        act(() => {
            first = result.current.saveCurrentSession(DATA_A)
            second = result.current.saveCurrentSession(DATA_B)
            third = result.current.saveCurrentSession(DATA_C)
        })

        expect(saveCalls).toHaveLength(1)

        await act(async () => {
            gates[0].resolve({ ok: true, revision: 4, updatedAt: 10 })
        })
        await waitFor(() => expect(saveCalls).toHaveLength(2))

        // Requests 2 and 3 collapsed into ONE follow-up save carrying the
        // newest payload (C) and the OR-ed version-snapshot flag.
        expect(saveCalls[1]).toMatchObject({
            diagramXml: "C",
            createVersion: true,
        })

        await act(async () => {
            gates[1].resolve({ ok: true, revision: 5, updatedAt: 20 })
        })
        const [o2, o3] = await Promise.all([second, third])
        await first
        expect(o2).toEqual(o3)
        expect(o2).toMatchObject({ ok: true })
    })

    it("resolves coalesced waiters when the follow-up save fails", async () => {
        const { provider, saveCalls, gates } = makeProvider()
        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: "d1", provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        let first!: Promise<SaveOutcome>
        let second!: Promise<SaveOutcome>
        act(() => {
            first = result.current.saveCurrentSession(DATA_A)
            second = result.current.saveCurrentSession(DATA_B)
        })

        await act(async () => {
            gates[0].resolve({ ok: true, revision: 4, updatedAt: 10 })
        })
        await waitFor(() => expect(saveCalls).toHaveLength(2))
        await act(async () => {
            gates[1].resolve({ ok: false, error: "failed", message: "boom" })
        })

        const outcome = await second
        await first
        expect(outcome).toMatchObject({ ok: false })
    })

    it("rejects stale saves that target a session other than the current one", async () => {
        const { provider, saveCalls } = makeProvider()
        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: "d1", provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        const outcome = await result.current.saveCurrentSession(DATA_A, "other")
        expect(outcome).toMatchObject({ ok: false, message: "Stale session" })
        expect(saveCalls).toHaveLength(0)
    })

    it("drops queued saves whose target session is no longer current", async () => {
        const { provider, saveCalls, gates } = makeProvider()
        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: "d1", provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        let first!: Promise<SaveOutcome>
        let second!: Promise<SaveOutcome>
        act(() => {
            first = result.current.saveCurrentSession(DATA_A)
            second = result.current.saveCurrentSession(DATA_B)
        })

        // Switch away while the first save is in flight
        await act(async () => {
            await result.current.switchSession("d2")
        })

        await act(async () => {
            gates[0].resolve({ ok: true, revision: 4, updatedAt: 10 })
        })
        await first

        // The queued save for d1 must not run against d2
        expect(saveCalls).toHaveLength(1)
        const outcome = await second
        expect(outcome).toMatchObject({ ok: false })
        // d2's revision is untouched by d1's save
        expect(result.current.currentSession?.revision).toBe(7)
    })

    it("switchSession does not save the current session itself", async () => {
        const { provider, saveCalls } = makeProvider()
        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: "d1", provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.currentSession?.messages).toHaveLength(1)

        await act(async () => {
            await result.current.switchSession("d2")
        })

        expect(result.current.currentSession?.id).toBe("d2")
        expect(saveCalls).toHaveLength(0)
    })

    it("saves against the freshly loaded revision after switching sessions", async () => {
        const { provider, saveCalls, gates } = makeProvider()
        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: "d1", provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        await act(async () => {
            await result.current.switchSession("d2")
        })

        let save!: Promise<SaveOutcome>
        act(() => {
            save = result.current.saveCurrentSession(DATA_A)
        })
        expect(saveCalls[0]?.revision).toBe(7)

        await act(async () => {
            gates[0].resolve({ ok: true, revision: 8, updatedAt: 30 })
        })
        const outcome = await save
        expect(outcome).toMatchObject({ ok: true, revision: 8 })
    })

    it("still surfaces a genuine 409 instead of silently overwriting another client", async () => {
        const server = makeFakeServer({
            id: "d1",
            revision: 3,
            diagramXml: "BASE",
        })

        const clientA = renderHook(() =>
            useSessionManager({
                initialSessionId: "d1",
                provider: server.provider,
            }),
        )
        const clientB = renderHook(() =>
            useSessionManager({
                initialSessionId: "d1",
                provider: server.provider,
            }),
        )
        await waitFor(() =>
            expect(clientA.result.current.isLoading).toBe(false),
        )
        await waitFor(() =>
            expect(clientB.result.current.isLoading).toBe(false),
        )

        // Both clients loaded the same revision.
        expect(clientA.result.current.currentSession?.revision).toBe(3)
        expect(clientB.result.current.currentSession?.revision).toBe(3)

        let aOutcome!: SaveOutcome
        await act(async () => {
            aOutcome = await clientA.result.current.saveCurrentSession(DATA_A)
        })
        expect(aOutcome).toMatchObject({ ok: true, revision: 4 })
        expect(server.revision()).toBe(4)
        expect(server.savedXml()).toBe("A")

        // B is stale: its PATCH must be rejected, not merged.
        let bOutcome!: SaveOutcome
        await act(async () => {
            bOutcome = await clientB.result.current.saveCurrentSession(DATA_B)
        })
        expect(bOutcome).toMatchObject({ ok: false, error: "conflict" })
        await waitFor(() =>
            expect(clientB.result.current.saveState).toBe("conflict"),
        )
        expect(clientB.result.current.conflict?.serverSession.revision).toBe(4)

        // The server still holds A's edit - no silent overwrite.
        expect(server.revision()).toBe(4)
        expect(server.savedXml()).toBe("A")
    })

    it("preserves the local XML on conflict so it can be saved as a copy", async () => {
        const server = makeFakeServer({
            id: "d1",
            revision: 3,
            diagramXml: "BASE",
        })
        const { result } = renderHook(() =>
            useSessionManager({
                initialSessionId: "d1",
                provider: server.provider,
            }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        // Another device advances the revision behind our back.
        server.setRevision(4)

        let outcome!: SaveOutcome
        await act(async () => {
            outcome = await result.current.saveCurrentSession(DATA_B)
        })
        expect(outcome).toMatchObject({ ok: false, error: "conflict" })
        expect(result.current.saveState).toBe("conflict")

        // Save-as-copy must persist the *local* payload, not the server one.
        let copy: SessionData | null = null
        await act(async () => {
            copy = await result.current.resolveConflictSaveCopy()
        })
        expect((copy as SessionData | null)?.diagramXml).toBe("B")
        expect(server.createdXml()).toBe("B")
    })

    it("rebinds a save queued while the initial session is being created", async () => {
        let resolveCreate!: (session: ChatSession) => void
        const createPromise = new Promise<ChatSession>((resolve) => {
            resolveCreate = resolve
        })
        const createCalls: string[] = []
        const saveCalls: { diagramXml: string; revision?: number }[] = []
        let resolveSave!: (outcome: SaveOutcome) => void
        const savePromise = new Promise<SaveOutcome>((resolve) => {
            resolveSave = resolve
        })

        const provider: SessionStorageProvider = {
            kind: "server",
            isAvailable: () => true,
            list: async () => [],
            get: async () => null,
            create: async (input) => {
                createCalls.push(input?.diagramXml ?? "")
                return createPromise
            },
            save: async (s) => {
                saveCalls.push({
                    diagramXml: s.diagramXml,
                    revision: s.revision,
                })
                return savePromise
            },
            delete: async () => {},
            rename: async () => {},
            duplicate: async () => null,
        }

        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: null, provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        let first!: Promise<SaveOutcome>
        let second!: Promise<SaveOutcome>
        act(() => {
            first = result.current.saveCurrentSession(DATA_A)
            // The session ID does not exist yet, so this save is pinned to null.
            second = result.current.saveCurrentSession(DATA_B)
        })
        expect(createCalls).toEqual(["A"])

        await act(async () => {
            resolveCreate(
                session({
                    id: "new-1",
                    revision: 1,
                    diagramXml: "A",
                    messages: [],
                }),
            )
        })
        await first

        // The queued save must follow the newly created session and carry the
        // newest payload instead of being dropped as a stale save.
        await waitFor(() => expect(saveCalls).toHaveLength(1))
        expect(saveCalls[0]).toMatchObject({
            diagramXml: "B",
            revision: 1,
        })

        await act(async () => {
            resolveSave({ ok: true, revision: 2, updatedAt: 20 })
        })
        const outcome = await second
        expect(outcome).toMatchObject({ ok: true, revision: 2 })
        expect(result.current.currentSessionId).toBe("new-1")
        expect(result.current.currentSession?.diagramXml).toBe("B")
    })

    it("does not resurrect an old blank session after New Chat during creation", async () => {
        let resolveFirstCreate!: (session: ChatSession) => void
        let resolveSecondCreate!: (session: ChatSession) => void
        const firstCreate = new Promise<ChatSession>((resolve) => {
            resolveFirstCreate = resolve
        })
        const secondCreate = new Promise<ChatSession>((resolve) => {
            resolveSecondCreate = resolve
        })
        const createCalls: string[] = []

        const provider: SessionStorageProvider = {
            kind: "server",
            isAvailable: () => true,
            list: async () => [],
            get: async () => null,
            create: async (input) => {
                createCalls.push(input?.diagramXml ?? "")
                return createCalls.length === 1 ? firstCreate : secondCreate
            },
            save: async () => ({ ok: true, revision: 2 }),
            delete: async () => {},
            rename: async () => {},
            duplicate: async () => null,
        }

        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: null, provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        let oldSave!: Promise<SaveOutcome>
        act(() => {
            oldSave = result.current.saveCurrentSession(DATA_A)
        })
        expect(createCalls).toEqual(["A"])

        // Start a new blank conversation while A's create is still in flight,
        // then edit/save B before A returns.
        act(() => {
            result.current.clearCurrentSession()
        })
        let newSave!: Promise<SaveOutcome>
        act(() => {
            newSave = result.current.saveCurrentSession(DATA_B)
        })

        await act(async () => {
            resolveFirstCreate(
                session({
                    id: "old-a",
                    revision: 1,
                    diagramXml: "A",
                    messages: [],
                }),
            )
        })
        await oldSave

        // A must not become current again.
        expect(result.current.currentSessionId).toBeNull()

        // B gets its own session instead of being rebound to A.
        await waitFor(() => expect(createCalls).toEqual(["A", "B"]))
        await act(async () => {
            resolveSecondCreate(
                session({
                    id: "new-b",
                    revision: 1,
                    diagramXml: "B",
                    messages: [],
                }),
            )
        })
        const outcome = await newSave

        expect(outcome).toMatchObject({ ok: true, revision: 1 })
        expect(result.current.currentSessionId).toBe("new-b")
        expect(result.current.currentSession?.diagramXml).toBe("B")
    })

    it("applies the server revision returned by a version restore", async () => {
        const { provider, saveCalls, gates } = makeProvider()
        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: "d1", provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.currentSession?.revision).toBe(3)

        let restored!: SessionData | null
        await act(async () => {
            restored = await result.current.restoreVersion(1)
        })
        expect(restored?.diagramXml).toBe("RESTORED")
        expect(result.current.currentSession?.revision).toBe(6)
        expect(result.current.currentSession?.diagramXml).toBe("RESTORED")

        let save!: Promise<SaveOutcome>
        act(() => {
            save = result.current.saveCurrentSession({
                messages: [],
                xmlSnapshots: [],
                diagramXml: "EDITED",
            })
        })

        // The next autosave uses the restored revision, not the stale one.
        expect(saveCalls[0]).toMatchObject({
            revision: 6,
            diagramXml: "EDITED",
        })
        await act(async () => {
            gates[0].resolve({ ok: true, revision: 7, updatedAt: 30 })
        })
        await save
        expect(result.current.currentSession?.revision).toBe(7)
    })

    it("drops queued saves before restoring a version", async () => {
        const { provider, saveCalls, gates } = makeProvider()
        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: "d1", provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        let first!: Promise<SaveOutcome>
        let second!: Promise<SaveOutcome>
        act(() => {
            first = result.current.saveCurrentSession(DATA_A)
            second = result.current.saveCurrentSession(DATA_B)
        })
        expect(saveCalls).toHaveLength(1)

        let restorePromise!: Promise<SessionData | null>
        act(() => {
            restorePromise = result.current.restoreVersion(1)
        })

        // The restore waits for the active save, then discards the queued one.
        await act(async () => {
            gates[0].resolve({ ok: true, revision: 4, updatedAt: 10 })
        })
        await first
        const restored = await restorePromise

        expect(await second).toMatchObject({ ok: false })
        expect(saveCalls).toHaveLength(1)
        expect(restored?.diagramXml).toBe("RESTORED")
        expect(result.current.currentSession?.revision).toBe(6)
        expect(result.current.currentSession?.diagramXml).toBe("RESTORED")
    })

    it("restores from the latest session snapshot after an active save", async () => {
        const saveGate = deferred()
        const provider: SessionStorageProvider = {
            kind: "server",
            isAvailable: () => true,
            list: async () => [],
            get: async (id) =>
                session({
                    id,
                    revision: 3,
                    title: "New Chat",
                    messages: [USER_MESSAGE],
                }),
            create: async () => session({}),
            save: async () => saveGate.promise,
            delete: async () => {},
            rename: async () => {},
            duplicate: async () => null,
            restoreVersion: async () => ({
                diagramXml: "RESTORED",
                revision: 6,
            }),
        }
        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: "d1", provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        const updatedMessage = {
            id: "m2",
            role: "user" as const,
            parts: [{ type: "text" as const, text: "updated message" }],
        }
        let save!: Promise<SaveOutcome>
        act(() => {
            save = result.current.saveCurrentSession({
                messages: [updatedMessage],
                xmlSnapshots: [],
                diagramXml: "EDIT",
                thumbnailDataUrl: "data:image/png;base64,AAAA",
            })
        })

        let restore!: Promise<SessionData | null>
        act(() => {
            restore = result.current.restoreVersion(1)
        })

        await act(async () => {
            saveGate.resolve({ ok: true, revision: 4, updatedAt: 10 })
        })
        await save
        const restored = await restore

        // The restore result must be based on the post-save session, not the
        // stale snapshot captured before awaiting the active save.
        expect(restored?.diagramXml).toBe("RESTORED")
        expect(restored?.revision).toBe(6)
        expect(restored?.messages).toEqual([updatedMessage])
        expect(restored?.thumbnailDataUrl).toBe("data:image/png;base64,AAAA")
        expect(result.current.currentSession?.title).toBe("updated message")
    })

    it("only locks saves for the session being restored", async () => {
        let resolveRestore!: (value: {
            diagramXml: string
            revision: number
        }) => void
        const restoreGate = new Promise<{
            diagramXml: string
            revision: number
        }>((resolve) => {
            resolveRestore = resolve
        })
        const savedSessionIds: string[] = []
        const provider: SessionStorageProvider = {
            kind: "server",
            isAvailable: () => true,
            list: async () => [],
            get: async (id) =>
                session({
                    id,
                    revision: id === "d1" ? 3 : 7,
                    diagramXml: id === "d1" ? "A" : "B",
                }),
            create: async () => session({}),
            save: async (s) => {
                savedSessionIds.push(s.id)
                return { ok: true, revision: (s.revision ?? 0) + 1 }
            },
            delete: async () => {},
            rename: async () => {},
            duplicate: async () => null,
            restoreVersion: async () => restoreGate,
        }
        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: "d1", provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        let restore!: Promise<SessionData | null>
        act(() => {
            restore = result.current.restoreVersion(1)
        })
        await act(async () => {
            await result.current.switchSession("d2")
        })

        // d2 is not the session being restored, so its save must proceed.
        let otherSave!: Promise<SaveOutcome>
        act(() => {
            otherSave = result.current.saveCurrentSession(DATA_A)
        })
        await expect(otherSave).resolves.toMatchObject({ ok: true })
        expect(savedSessionIds).toEqual(["d2"])

        await act(async () => {
            resolveRestore({ diagramXml: "RESTORED", revision: 6 })
        })
        await expect(restore).resolves.toBeNull()
        expect(result.current.currentSessionId).toBe("d2")
        expect(result.current.currentSession?.diagramXml).toBe("A")
    })

    it("does not steal the current session when a conflict copy finishes late", async () => {
        let resolveCopy!: (value: ChatSession) => void
        const copyGate = new Promise<ChatSession>((resolve) => {
            resolveCopy = resolve
        })
        const provider: SessionStorageProvider = {
            kind: "server",
            isAvailable: () => true,
            list: async () => [],
            get: async (id) =>
                session({
                    id,
                    revision: id === "d1" ? 3 : 7,
                    diagramXml: id === "d1" ? "A" : "B",
                }),
            create: async () => copyGate,
            save: async () => ({
                ok: false,
                error: "conflict",
                server: session({ id: "d1", revision: 4 }),
            }),
            delete: async () => {},
            rename: async () => {},
            duplicate: async () => null,
            restoreVersion: async () => ({
                diagramXml: "RESTORED",
                revision: 6,
            }),
        }
        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: "d1", provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        await act(async () => {
            await result.current.saveCurrentSession(DATA_A)
        })
        expect(result.current.conflict).not.toBeNull()

        let copy!: Promise<SessionData | null>
        act(() => {
            copy = result.current.resolveConflictSaveCopy()
        })
        await act(async () => {
            await result.current.switchSession("d2")
        })
        await act(async () => {
            resolveCopy(
                session({
                    id: "copy-1",
                    revision: 1,
                    diagramXml: "COPY",
                }),
            )
        })

        await expect(copy).resolves.toBeNull()
        expect(result.current.currentSessionId).toBe("d2")
    })

    it("reports a failed save without clearing the session, then succeeds on retry", async () => {
        let attempts = 0
        const provider: SessionStorageProvider = {
            kind: "server",
            isAvailable: () => true,
            list: async () => [],
            get: async (id) => session({ id, revision: 3 }),
            create: async () => session({}),
            save: async () => {
                attempts++
                if (attempts === 1) {
                    return { ok: false, error: "failed", message: "boom" }
                }
                return { ok: true, revision: 4, updatedAt: 9 }
            },
            delete: async () => {},
            rename: async () => {},
            duplicate: async () => null,
        }
        const { result } = renderHook(() =>
            useSessionManager({ initialSessionId: "d1", provider }),
        )
        await waitFor(() => expect(result.current.isLoading).toBe(false))

        let failed!: SaveOutcome
        await act(async () => {
            failed = await result.current.saveCurrentSession(DATA_A)
        })
        expect(failed).toMatchObject({ ok: false })
        expect(result.current.saveState).toBe("error")
        // The session stays loaded so the editor's content is not discarded.
        expect(result.current.currentSession?.id).toBe("d1")

        let retry!: SaveOutcome
        await act(async () => {
            retry = await result.current.saveCurrentSession(DATA_A)
        })
        expect(retry).toMatchObject({ ok: true, revision: 4 })
        expect(attempts).toBe(2)
        expect(result.current.currentSession?.revision).toBe(4)
    })
})
