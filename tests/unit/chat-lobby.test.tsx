import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ChatLobby } from "@/components/chat/ChatLobby"
import { DictionaryProvider } from "@/hooks/use-dictionary"
import en from "@/lib/i18n/dictionaries/en.json"
import { STORAGE_KEYS } from "@/lib/storage"

const sessions = [
    {
        id: "s1",
        title: "Architecture Diagram",
        updatedAt: Date.now(),
        messageCount: 2,
        hasDiagram: true,
    },
    {
        id: "s2",
        title: "Pipeline Flow",
        updatedAt: Date.now(),
        messageCount: 1,
        hasDiagram: false,
    },
]

const lobbyDict = {
    sessionHistory: {
        recentChats: "Recent Chats",
        searchPlaceholder: "Search chats...",
        noResults: "No chats found",
        justNow: "Just now",
        deleteTitle: "Delete this chat?",
        deleteDescription: "Cannot be undone",
    },
    diagrams: { title: "My Diagrams" },
    common: { delete: "Delete", cancel: "Cancel" },
}

function renderLobby() {
    return render(
        <DictionaryProvider dictionary={en}>
            <ChatLobby
                sessions={sessions}
                onSelectSession={() => {}}
                onDeleteSession={() => {}}
                setInput={() => {}}
                setFiles={() => {}}
                dict={lobbyDict}
            />
        </DictionaryProvider>,
    )
}

function recentChatsHeader() {
    return screen.getByRole("button", { name: /my diagrams|recent chats/i })
}

describe("ChatLobby recent chats section", () => {
    beforeEach(() => {
        // Keep only the recent chats section visible so the test stays focused.
        localStorage.setItem(STORAGE_KEYS.showRecentChats, "true")
        localStorage.setItem(STORAGE_KEYS.showMyTemplates, "false")
        localStorage.setItem(STORAGE_KEYS.showQuickExamples, "false")
    })

    afterEach(() => {
        cleanup()
        localStorage.clear()
    })

    it("expands by default", () => {
        renderLobby()
        expect(screen.getByPlaceholderText("Search chats...")).toBeTruthy()
        expect(screen.getByText("Architecture Diagram")).toBeTruthy()
        expect(screen.getByText("Pipeline Flow")).toBeTruthy()
    })

    it("collapses and expands the section including the search box", () => {
        renderLobby()
        const header = recentChatsHeader()

        fireEvent.click(header)
        expect(screen.queryByPlaceholderText("Search chats...")).toBeNull()
        expect(screen.queryByText("Architecture Diagram")).toBeNull()

        fireEvent.click(header)
        expect(screen.getByPlaceholderText("Search chats...")).toBeTruthy()
        expect(screen.getByText("Architecture Diagram")).toBeTruthy()
    })

    it("keeps the search query when collapsing and expanding", () => {
        renderLobby()
        const input = screen.getByPlaceholderText(
            "Search chats...",
        ) as HTMLInputElement
        fireEvent.change(input, { target: { value: "architecture" } })
        expect(screen.getByText("Architecture Diagram")).toBeTruthy()
        expect(screen.queryByText("Pipeline Flow")).toBeNull()

        const header = recentChatsHeader()
        fireEvent.click(header)
        fireEvent.click(header)

        const reopened = screen.getByPlaceholderText(
            "Search chats...",
        ) as HTMLInputElement
        expect(reopened.value).toBe("architecture")
        expect(screen.getByText("Architecture Diagram")).toBeTruthy()
        expect(screen.queryByText("Pipeline Flow")).toBeNull()
    })
})
