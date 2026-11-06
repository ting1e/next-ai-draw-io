import {
    type BrowserContext,
    expect,
    type Page,
    request as playwrightRequest,
    test,
} from "@playwright/test"
import { diagramXmlFingerprint } from "@/lib/diagram-fingerprint"

const BASE_URL = `http://127.0.0.1:${Number(
    process.env.E2E_SERVER_PORT || 6003,
)}`
const PASSWORD = "E2E-Passw0rd!"

/**
 * Tiny single-pixel PNGs. The app downsizes version previews through a
 * canvas, so the stored bytes differ from these inputs but keep their colour.
 */
const RED_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO4Iyf3HwAFCgIYQBnpagAAAABJRU5ErkJggg=="
const BLUE_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mOQs7nzHwAD6AI2S5g8fQAAAABJRU5ErkJggg=="

interface VersionItem {
    revision: number
    label: string | null
    hasPreview: boolean
    previewUrl?: string
}

let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>

function diagramXml(label: string, x = 120): string {
    return `<mxfile host="app.diagrams.net"><diagram name="Page-1" id="page-1"><mxGraphModel dx="1434" dy="782" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node-a" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1"><mxGeometry x="${x}" y="120" width="180" height="80" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`
}

async function createDiagram(
    context: BrowserContext,
    xml: string,
): Promise<{ id: string; revision: number }> {
    const response = await context.request.post(`${BASE_URL}/api/diagrams`, {
        headers: { Origin: BASE_URL },
        data: { title: `Version preview E2E ${Date.now()}`, diagramXml: xml },
    })
    expect(response.ok()).toBeTruthy()
    return (await response.json()) as { id: string; revision: number }
}

async function getDiagram(
    context: BrowserContext,
    id: string,
): Promise<{ diagramXml: string; revision: number }> {
    const response = await context.request.get(`${BASE_URL}/api/diagrams/${id}`)
    expect(response.ok()).toBeTruthy()
    return (await response.json()) as {
        diagramXml: string
        revision: number
    }
}

async function getVersions(
    context: BrowserContext,
    id: string,
): Promise<VersionItem[]> {
    const response = await context.request.get(
        `${BASE_URL}/api/diagrams/${id}/versions`,
    )
    expect(response.ok()).toBeTruthy()
    const data = (await response.json()) as { versions: VersionItem[] }
    return data.versions
}

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

/**
 * Answer every Draw.io PNG export request with a synthetic image. The app
 * serializes exports and only accepts a response matching the active format,
 * so replying on a short interval is enough to satisfy the version preview
 * request without depending on the external editor being reachable.
 */
async function startPngResponder(page: Page, png: string) {
    await page.evaluate((previewPng) => {
        const scope = window as typeof window & {
            __versionPngTimer?: number
        }
        if (scope.__versionPngTimer) {
            window.clearInterval(scope.__versionPngTimer)
        }
        const dispatch = () => {
            const iframe = document.querySelector<HTMLIFrameElement>("iframe")
            const origin = iframe
                ? new URL(iframe.src).origin
                : window.location.origin
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: JSON.stringify({
                        event: "export",
                        format: "png",
                        data: previewPng,
                        xml: "",
                        message: {},
                    }),
                    origin,
                }),
            )
        }
        scope.__versionPngTimer = window.setInterval(dispatch, 25)
    }, png)
}

async function stopPngResponder(page: Page) {
    await page.evaluate(() => {
        const scope = window as typeof window & {
            __versionPngTimer?: number
        }
        if (scope.__versionPngTimer) {
            window.clearInterval(scope.__versionPngTimer)
            scope.__versionPngTimer = undefined
        }
    })
}

async function openSession(page: Page, id: string) {
    await page.goto(`/en?session=${id}`, { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("versions-button")).toBeVisible({
        timeout: 30_000,
    })
    await page.locator("iframe").waitFor({ state: "attached" })
    await emitDrawioEvent(page, "load")
    await expect(page.locator("iframe")).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(500)
}

async function findManualVersion(
    context: BrowserContext,
    id: string,
    afterRevision = -1,
): Promise<VersionItem | undefined> {
    const versions = await getVersions(context, id)
    return versions
        .filter(
            (version) =>
                version.label === "Manual save" &&
                version.revision > afterRevision,
        )
        .sort((left, right) => right.revision - left.revision)[0]
}

async function saveVersion(
    page: Page,
    context: BrowserContext,
    id: string,
    afterRevision = -1,
): Promise<VersionItem> {
    await page.getByTestId("versions-button").click()
    const saveButton = page.getByRole("button", { name: "Save version" })
    await expect(saveButton).toBeVisible({ timeout: 10_000 })
    await saveButton.click()

    await expect
        .poll(async () => findManualVersion(context, id, afterRevision), {
            timeout: 40_000,
        })
        .toBeTruthy()

    const manual = await findManualVersion(context, id, afterRevision)
    if (!manual) throw new Error("manual version was not created")
    return manual
}

test.beforeAll(async () => {
    const email = `e2e-versions-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}@example.test`
    const request = await playwrightRequest.newContext({ baseURL: BASE_URL })
    const response = await request.post("/api/auth/sign-up/email", {
        headers: { Origin: BASE_URL },
        data: { name: "Version Preview E2E", email, password: PASSWORD },
    })
    if (!response.ok()) {
        throw new Error(
            `sign-up failed: ${response.status()} ${await response.text()}`,
        )
    }
    storageState = await request.storageState()
    await request.dispose()
})

test.beforeEach(async ({ context }) => {
    await context.addCookies(storageState.cookies)
})

test.describe("historical version previews", () => {
    test("stores a preview generated for a manual version save", async ({
        context,
        page,
    }) => {
        const created = await createDiagram(
            context,
            diagramXml("Manual preview base"),
        )
        await openSession(page, created.id)

        const xml = diagramXml("Manual preview")
        await emitDrawioEvent(page, "autosave", xml)
        await expect
            .poll(
                async () => (await getDiagram(context, created.id)).revision,
                { timeout: 20_000 },
            )
            .toBeGreaterThanOrEqual(2)

        await startPngResponder(page, RED_PNG)
        try {
            const manual = await saveVersion(page, context, created.id)
            expect(manual.hasPreview).toBe(true)
            expect(manual.previewUrl).toBeTruthy()
        } finally {
            await stopPngResponder(page)
        }
    })

    test("keeps separate previews for consecutive diagram versions", async ({
        context,
        page,
    }) => {
        test.setTimeout(90_000)
        const created = await createDiagram(
            context,
            diagramXml("Version pair base"),
        )
        await openSession(page, created.id)

        const firstXml = diagramXml("Version pair first")
        await emitDrawioEvent(page, "autosave", firstXml)
        await expect
            .poll(
                async () => (await getDiagram(context, created.id)).revision,
                { timeout: 20_000 },
            )
            .toBeGreaterThanOrEqual(2)

        await startPngResponder(page, RED_PNG)
        const first = await saveVersion(page, context, created.id)
        await stopPngResponder(page)
        expect(first.hasPreview).toBe(true)

        await page.getByRole("button", { name: "Close" }).first().click()

        const secondXml = diagramXml("Version pair second", 240)
        await emitDrawioEvent(page, "autosave", secondXml)
        await expect
            .poll(
                async () => (await getDiagram(context, created.id)).diagramXml,
                { timeout: 20_000 },
            )
            .toContain("Version pair second")

        await startPngResponder(page, BLUE_PNG)
        const second = await saveVersion(
            page,
            context,
            created.id,
            first.revision,
        )
        await stopPngResponder(page)
        expect(second.hasPreview).toBe(true)
        expect(second.revision).not.toBe(first.revision)

        const [firstPreview, secondPreview] = await Promise.all(
            [first, second].map(async (version) => {
                const response = await context.request.get(
                    `${BASE_URL}${version.previewUrl}`,
                )
                expect(response.ok()).toBeTruthy()
                return (await response.body()).toString("base64")
            }),
        )
        expect(firstPreview).not.toBe(secondPreview)
    })

    test("rejects a thumbnail captured for an older XML revision", async ({
        context,
    }) => {
        const created = await createDiagram(
            context,
            diagramXml("Stale thumbnail base"),
        )
        const staleFingerprint = diagramXmlFingerprint(
            diagramXml("Stale thumbnail base"),
        )
        const nextXml = diagramXml("Changed before the save finished", 260)

        const response = await context.request.patch(
            `${BASE_URL}/api/diagrams/${created.id}`,
            {
                headers: { Origin: BASE_URL },
                data: {
                    baseRevision: created.revision,
                    diagramXml: nextXml,
                    thumbnailDataUrl: RED_PNG,
                    thumbnailXmlFingerprint: staleFingerprint,
                    createVersion: true,
                    versionLabel: "Rapid edit",
                },
            },
        )
        expect(response.ok()).toBeTruthy()

        // The XML saves successfully, but the mismatched image is not used as
        // the historical preview: the version gets a placeholder instead.
        const saved = await getDiagram(context, created.id)
        expect(saved.diagramXml).toContain("Changed before the save finished")
        const versions = await getVersions(context, created.id)
        const rapid = versions.find((version) => version.label === "Rapid edit")
        expect(rapid).toBeTruthy()
        expect(rapid?.hasPreview).toBe(false)
    })

    test("saves the XML without a preview when the PNG export fails", async ({
        context,
        page,
    }) => {
        test.setTimeout(90_000)
        // Make the failure deterministic: the real embed must never answer
        // the PNG export, otherwise this test would depend on network access.
        await page.route("https://embed.diagrams.net/**", (route) =>
            route.abort(),
        )
        const created = await createDiagram(
            context,
            diagramXml("PNG export failure base"),
        )
        await openSession(page, created.id)

        const xml = diagramXml("PNG export failure")
        await emitDrawioEvent(page, "autosave", xml)
        await expect
            .poll(
                async () => (await getDiagram(context, created.id)).diagramXml,
                { timeout: 20_000 },
            )
            .toContain("PNG export failure")

        // Let the autosave thumbnail export time out so the version preview
        // request starts on a clean channel and hits its own 10s timeout.
        await page.waitForTimeout(4_000)

        const manual = await saveVersion(page, context, created.id)
        expect(manual.hasPreview).toBe(false)
        expect(manual.previewUrl).toBeUndefined()

        const saved = await getDiagram(context, created.id)
        expect(saved.diagramXml).toContain("PNG export failure")
    })
})
