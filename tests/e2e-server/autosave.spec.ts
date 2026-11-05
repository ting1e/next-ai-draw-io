import {
    type BrowserContext,
    expect,
    type Page,
    request as playwrightRequest,
    test,
} from "@playwright/test"

const BASE_URL = `http://127.0.0.1:${Number(
    process.env.E2E_SERVER_PORT || 6003,
)}`
const PASSWORD = "E2E-Passw0rd!"
const VERSION_TWO_MARKER = "Second revision"
const POST_RESTORE_MARKER = "Edit after restore"

let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>

/**
 * Full mxfile (not a bare mxCell list) so the app treats it as a real diagram
 * as soon as the session is restored.
 */
function diagramXml(label: string, x = 120): string {
    return `<mxfile host="app.diagrams.net"><diagram name="Page-1" id="page-1"><mxGraphModel dx="1434" dy="782" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node-a" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1"><mxGeometry x="${x}" y="120" width="180" height="80" as="geometry"/></mxCell><mxCell id="fixture-note" value="Server storage autosave E2E fixture" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;" vertex="1" parent="1"><mxGeometry x="80" y="240" width="280" height="30" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`
}

async function createDiagram(
    context: BrowserContext,
    baseURL: string,
    xml: string,
    messages?: Array<Record<string, unknown>>,
): Promise<{ id: string; revision: number }> {
    const response = await context.request.post(`${baseURL}/api/diagrams`, {
        headers: { Origin: baseURL },
        data: {
            title: `Autosave E2E ${Date.now()}`,
            diagramXml: xml,
            ...(messages ? { messages } : {}),
        },
    })
    expect(response.ok()).toBeTruthy()
    return (await response.json()) as { id: string; revision: number }
}

async function getDiagram(
    context: BrowserContext,
    baseURL: string,
    id: string,
): Promise<{ diagramXml: string; revision: number }> {
    const response = await context.request.get(`${baseURL}/api/diagrams/${id}`)
    expect(response.ok()).toBeTruthy()
    return (await response.json()) as {
        diagramXml: string
        revision: number
    }
}

/**
 * Dispatch a Draw.io embed message from the iframe's origin. This exercises
 * the same parent-window listeners as the real editor while keeping the test
 * independent of canvas coordinates and of the external embed being reachable.
 */
async function emitDrawioEvent(
    page: Page,
    event: "load" | "autosave",
    xml?: string,
) {
    await page.evaluate(
        ({ eventName, nextXml }) => {
            const iframe = document.querySelector<HTMLIFrameElement>("iframe")
            const origin = iframe
                ? new URL(iframe.src).origin
                : window.location.origin
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: JSON.stringify({ event: eventName, xml: nextXml }),
                    origin,
                }),
            )
        },
        { eventName: event, nextXml: xml },
    )
}

async function openSession(page: Page, id: string) {
    await page.goto(`/en?session=${id}`, { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("versions-button")).toBeVisible({
        timeout: 30_000,
    })
    await page.locator("iframe").waitFor({ state: "attached" })
    // Mark the editor ready even when the external Draw.io origin is blocked
    // (for example when running against a build without a frame-src entry).
    await emitDrawioEvent(page, "load")
    await expect(page.locator("iframe")).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(500)
}

test.beforeAll(async () => {
    const email = `e2e-server-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}@example.test`
    const request = await playwrightRequest.newContext({ baseURL: BASE_URL })
    const response = await request.post("/api/auth/sign-up/email", {
        headers: { Origin: BASE_URL },
        data: {
            name: "Server E2E User",
            email,
            password: PASSWORD,
        },
    })
    expect(response.ok()).toBeTruthy()
    storageState = await request.storageState()
    await request.dispose()
})

test.beforeEach(async ({ context }) => {
    await context.addCookies(storageState.cookies)
})

test.describe("server-storage autosave", () => {
    test("persists a Draw.io autosave edit and keeps it after reload", async ({
        context,
        page,
    }) => {
        const initial = diagramXml("Before manual edit")
        const created = await createDiagram(context, BASE_URL, initial)

        await openSession(page, created.id)

        const edited = diagramXml("Manual edit persisted", 220)
        await emitDrawioEvent(page, "autosave", edited)

        await expect
            .poll(
                async () =>
                    (await getDiagram(context, BASE_URL, created.id))
                        .diagramXml,
                { timeout: 20_000 },
            )
            .toContain("Manual edit persisted")

        await page.reload({ waitUntil: "domcontentloaded" })
        await expect(page.getByTestId("versions-button")).toBeVisible({
            timeout: 30_000,
        })

        const reloaded = await getDiagram(context, BASE_URL, created.id)
        expect(reloaded.diagramXml).toContain("Manual edit persisted")
    })

    test("continues autosaving after restoring a version without a conflict", async ({
        context,
        page,
    }) => {
        test.setTimeout(60_000)
        const initial = diagramXml("Original version")
        const created = await createDiagram(context, BASE_URL, initial)

        const versionResponse = await context.request.post(
            `${BASE_URL}/api/diagrams/${created.id}/versions`,
            {
                headers: { Origin: BASE_URL },
                data: {
                    diagramXml: initial,
                    label: "E2E base version",
                },
            },
        )
        expect(versionResponse.ok()).toBeTruthy()

        await openSession(page, created.id)

        // Advance the server revision to 2 with a normal autosave.
        await emitDrawioEvent(
            page,
            "autosave",
            diagramXml(VERSION_TWO_MARKER, 180),
        )
        await expect
            .poll(
                async () =>
                    (await getDiagram(context, BASE_URL, created.id)).revision,
                { timeout: 20_000 },
            )
            .toBe(2)

        // Restore version 1 through the UI so the client must adopt the new
        // server revision returned by the restore endpoint.
        await page.getByTestId("versions-button").click()
        await expect(page.getByTestId("version-1")).toBeVisible({
            timeout: 10_000,
        })
        await page.getByTestId("version-1").click()
        await page.getByTestId("restore-version-button").click()
        await expect(page.locator('[role="dialog"]')).toBeHidden({
            timeout: 15_000,
        })

        // The restore itself reloads Draw.io and triggers an autosave of the
        // restored XML. A thumbnail export may time out while the external
        // embed is unreachable, which recreates the iframe and pauses the
        // export queue. Mark the fresh instance ready, then let that restore
        // save settle before simulating a user edit on the stable channel.
        await page.waitForTimeout(2000)
        await emitDrawioEvent(page, "load")
        await expect
            .poll(
                async () =>
                    (await getDiagram(context, BASE_URL, created.id)).revision,
                { timeout: 20_000 },
            )
            .toBeGreaterThanOrEqual(4)

        await emitDrawioEvent(page, "load")
        // Let the ready-state render commit before simulating the edit.
        await page.waitForTimeout(200)

        await emitDrawioEvent(
            page,
            "autosave",
            diagramXml(POST_RESTORE_MARKER, 280),
        )
        await expect
            .poll(
                async () =>
                    (await getDiagram(context, BASE_URL, created.id))
                        .diagramXml,
                { timeout: 20_000 },
            )
            .toContain(POST_RESTORE_MARKER)

        await expect(
            page.getByText("This diagram was updated on another device"),
        ).toHaveCount(0)
    })

    test("keeps the current conversation when the pre-new-chat save fails", async ({
        context,
        page,
    }) => {
        const conversationMarker = "Keep this conversation visible"
        const created = await createDiagram(
            context,
            BASE_URL,
            diagramXml("New chat failure fixture"),
            [
                {
                    id: "m1",
                    role: "user",
                    parts: [{ type: "text", text: conversationMarker }],
                },
            ],
        )

        await openSession(page, created.id)
        await expect(page.getByText(conversationMarker)).toBeVisible({
            timeout: 15_000,
        })

        let failSaves = false
        await page.route(`**/api/diagrams/${created.id}`, async (route) => {
            if (failSaves && route.request().method() === "PATCH") {
                await route.fulfill({
                    status: 500,
                    contentType: "application/json",
                    body: JSON.stringify({ error: "forced save failure" }),
                })
                return
            }
            await route.fallback()
        })
        failSaves = true

        await page.getByTestId("new-chat-button").click()

        await expect(page.getByText("Save failed").first()).toBeVisible({
            timeout: 20_000,
        })
        // The failed save aborts New Chat: the conversation and its URL stay.
        await expect(page.getByText(conversationMarker)).toBeVisible()
        await expect(page).toHaveURL(new RegExp(`[?&]session=${created.id}`))
    })
})
