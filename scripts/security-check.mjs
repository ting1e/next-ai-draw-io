#!/usr/bin/env node
/**
 * Repeatable security regression baseline for a running deployment.
 *
 * Runs the P0 checks that must keep holding after every upstream sync:
 *   1. authentication on diagram APIs
 *   2. IDOR / cross-user isolation (needs two test accounts)
 *   3. list-ownership query fuzzing
 *   4. request body size limits (413)
 *   5. session cookie attributes
 *   6. brute-force rate limiting and X-Forwarded-For spoofing
 *   7. /setup closure and disabled registration
 *   8. parse-url feature gate
 *
 * Usage (against the isolated staging stack):
 *   SECURITY_BASE_URL=http://127.0.0.1:19870 \
 *   SECURITY_EMAIL_A=user-a@example.test  SECURITY_PASSWORD_A='...' \
 *   SECURITY_EMAIL_B=user-b@example.test  SECURITY_PASSWORD_B='...' \
 *   SECURITY_ALLOW_REGISTRATION=false \
 *   node scripts/security-check.mjs
 *
 * Never point this at a production instance with real user data: the script
 * creates and deletes diagrams for the provided test accounts.
 */

const BASE = process.env.SECURITY_BASE_URL || "http://127.0.0.1:19870"
const EMAIL_A = process.env.SECURITY_EMAIL_A
const PASSWORD_A = process.env.SECURITY_PASSWORD_A
const EMAIL_B = process.env.SECURITY_EMAIL_B
const PASSWORD_B = process.env.SECURITY_PASSWORD_B
const ALLOW_REGISTRATION = process.env.SECURITY_ALLOW_REGISTRATION === "true"
const EXPECT_URL_FETCH = process.env.SECURITY_EXPECT_URL_FETCH || "disabled"

const results = []
let failed = 0
let warned = 0

function record(status, name, detail) {
    results.push({ status, name, detail })
    if (status === "FAIL") failed++
    if (status === "WARN") warned++
    const icon = status === "PASS" ? "PASS" : status
    console.log(`[${icon}] ${name}${detail ? ` — ${detail}` : ""}`)
}

async function request(
    path,
    { cookie, method = "GET", body, headers = {} } = {},
) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            Origin: BASE,
            ...(body !== undefined
                ? { "Content-Type": "application/json" }
                : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
        },
        body: body !== undefined ? body : undefined,
        redirect: "manual",
    })
    return res
}

function cookiesFrom(res) {
    const setCookies = res.headers.getSetCookie?.() ?? []
    return setCookies.map((c) => c.split(";")[0]).join("; ")
}

async function signIn(email, password, extraHeaders = {}) {
    const res = await request("/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email, password }),
        headers: extraHeaders,
    })
    return { status: res.status, cookie: cookiesFrom(res) }
}

async function createDiagram(cookie, title, xml = "<mxGraphModel/>") {
    const res = await request("/api/diagrams", {
        method: "POST",
        cookie,
        body: JSON.stringify({ title, diagramXml: xml }),
    })
    const data = await res.json().catch(() => ({}))
    return data.id
}

const XSS_PAYLOADS = [
    'XSS1 <img src=x onerror="window.__xss=1">',
    'XSS2 "><svg/onload="window.__xss=2">',
]

/**
 * Seeds diagrams with HTML/JS-bearing titles, then renders the diagram list
 * in a real browser and asserts nothing executed and the titles are plain
 * text. Requires `SECURITY_RUN_XSS=1` and installed Playwright chromium.
 */
async function runBrowserXssCheck(cookie) {
    let chromium
    try {
        ;({ chromium } = await import("playwright"))
    } catch (error) {
        record("FAIL", "browser XSS check", `playwright unavailable: ${error}`)
        return
    }

    const created = []
    try {
        for (const title of XSS_PAYLOADS) {
            const res = await request("/api/diagrams", {
                method: "POST",
                cookie,
                body: JSON.stringify({ title, diagramXml: "<mxGraphModel/>" }),
            })
            const data = await res.json().catch(() => ({}))
            if (data.id) created.push(data.id)
        }

        const browser = await chromium.launch()
        const context = await browser.newContext()
        await context.addInitScript(() => {
            window.__xss = 0
        })
        for (const pair of cookie.split("; ")) {
            const [name, ...rest] = pair.split("=")
            if (!name || rest.length === 0) continue
            await context.addCookies([
                { name, value: rest.join("="), url: BASE },
            ])
        }
        const page = await context.newPage()
        const pageErrors = []
        const cspViolations = []
        page.on("pageerror", (error) => pageErrors.push(String(error)))
        page.on("console", (message) => {
            if (/Content Security Policy|Refused to/i.test(message.text())) {
                cspViolations.push(message.text())
            }
        })
        await page.goto(`${BASE}/en/`, { waitUntil: "domcontentloaded" })
        await page.waitForTimeout(5000)

        const xssValue = await page.evaluate(() => window.__xss)
        const injected = await page.locator('img[src="x"]').count()
        const text = await page.locator("body").innerText()
        const shownAsText = XSS_PAYLOADS.some((p) => text.includes(p))
        await browser.close()

        record(
            xssValue === 0 &&
                injected === 0 &&
                pageErrors.length === 0 &&
                cspViolations.length === 0 &&
                shownAsText
                ? "PASS"
                : "FAIL",
            "stored XSS payloads render as text (no DOM/JS execution)",
            `xss=${xssValue} injected=${injected} errors=${pageErrors.length} cspViolations=${cspViolations.length} shownAsText=${shownAsText}`,
        )
    } catch (error) {
        record("FAIL", "browser XSS check crashed", String(error))
    } finally {
        for (const id of created) {
            await request(`/api/diagrams/${id}`, { method: "DELETE", cookie })
        }
    }
}

async function main() {
    console.log(`Security baseline against ${BASE}\n`)

    // 1. anonymous access ------------------------------------------------
    const anonList = await request("/api/diagrams")
    record(
        anonList.status === 401 ? "PASS" : "FAIL",
        "anonymous GET /api/diagrams returns 401",
        `status=${anonList.status}`,
    )
    const anonCreate = await request("/api/diagrams", {
        method: "POST",
        body: JSON.stringify({ title: "anon" }),
    })
    record(
        anonCreate.status === 401 ? "PASS" : "FAIL",
        "anonymous POST /api/diagrams returns 401",
        `status=${anonCreate.status}`,
    )

    // 7. setup closure ---------------------------------------------------
    const setupPost = await request("/api/setup", {
        method: "POST",
        body: JSON.stringify({
            name: "evil",
            email: "evil-security-check@example.test",
            password: "Passw0rd-Evil!",
        }),
    })
    record(
        setupPost.status === 404 ? "PASS" : "FAIL",
        "POST /api/setup is closed once users exist",
        `status=${setupPost.status}`,
    )

    // 7b. registration ---------------------------------------------------
    if (!ALLOW_REGISTRATION) {
        const signup = await request("/api/auth/sign-up/email", {
            method: "POST",
            body: JSON.stringify({
                name: "security-check",
                email: `security-check-${Date.now()}@example.test`,
                password: "Passw0rd-Check!",
            }),
        })
        record(
            signup.ok ? "FAIL" : "PASS",
            "sign-up endpoint rejects registration while disabled",
            `status=${signup.status}`,
        )
    } else {
        record(
            "WARN",
            "registration disabled check skipped",
            "ALLOW_REGISTRATION=true",
        )
    }

    // 8. parse-url gate --------------------------------------------------
    if (EXPECT_URL_FETCH === "disabled") {
        const parseUrl = await request("/api/parse-url", {
            method: "POST",
            body: JSON.stringify({ url: "https://example.com/" }),
        })
        record(
            parseUrl.status === 404 ? "PASS" : "FAIL",
            "POST /api/parse-url disabled returns 404",
            `status=${parseUrl.status}`,
        )
    }

    if (!EMAIL_A || !PASSWORD_A || !EMAIL_B || !PASSWORD_B) {
        record(
            "WARN",
            "authenticated checks skipped",
            "set SECURITY_EMAIL_A/B and SECURITY_PASSWORD_A/B",
        )
        return
    }

    // 5. cookie attributes ----------------------------------------------
    const loginA = await signIn(EMAIL_A, PASSWORD_A)
    record(
        loginA.status === 200 && loginA.cookie ? "PASS" : "FAIL",
        "user A can sign in",
        `status=${loginA.status}`,
    )
    if (loginA.status !== 200) return

    const loginHeaders = await request("/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email: EMAIL_A, password: PASSWORD_A }),
    })
    const rawCookie = (loginHeaders.headers.getSetCookie?.() ?? []).join("\n")
    const hasHttpOnly = /HttpOnly/i.test(rawCookie)
    const hasSameSite = /SameSite=(Lax|Strict)/i.test(rawCookie)
    const secure = /Secure/i.test(rawCookie)
    const https = BASE.startsWith("https://")
    record(
        hasHttpOnly && hasSameSite ? "PASS" : "FAIL",
        "session cookie is HttpOnly and SameSite",
        `HttpOnly=${hasHttpOnly} SameSite=${hasSameSite} Secure=${secure}`,
    )
    if (https && !secure) {
        record("FAIL", "session cookie missing Secure on HTTPS", "")
    }
    if (!https) {
        record(
            "WARN",
            "cookie Secure not set (non-HTTPS base URL)",
            "expected for local HTTP",
        )
    }
    const cookieA = loginA.cookie

    // 2. IDOR ------------------------------------------------------------
    const a1 = await createDiagram(cookieA, "security-check A1")
    const a2 = await createDiagram(cookieA, "security-check A2")
    await request(`/api/diagrams/${a1}/versions`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({ diagramXml: "<mxGraphModel/>", label: "v1" }),
    })

    const loginB = await signIn(EMAIL_B, PASSWORD_B)
    if (loginB.status !== 200) {
        record("FAIL", "user B can sign in", `status=${loginB.status}`)
        return
    }
    const cookieB = loginB.cookie

    const idorChecks = [
        ["GET", `/api/diagrams/${a1}`, undefined],
        ["GET", `/api/diagrams/${a1}/thumbnail`, undefined],
        ["GET", `/api/diagrams/${a1}/versions`, undefined],
        ["GET", `/api/diagrams/${a1}/versions/1`, undefined],
        ["GET", `/api/diagrams/${a1}/versions/1/preview`, undefined],
        ["GET", `/api/diagrams/${a1}/export/drawio`, undefined],
        ["PATCH", `/api/diagrams/${a1}`, JSON.stringify({ title: "pwned" })],
        ["DELETE", `/api/diagrams/${a1}`, undefined],
        ["POST", `/api/diagrams/${a1}/versions/1`, undefined],
        [
            "POST",
            `/api/diagrams/${a1}/versions`,
            JSON.stringify({ diagramXml: "<x/>" }),
        ],
        ["POST", "/api/diagrams", JSON.stringify({ sourceId: a1 })],
    ]
    for (const [method, path, body] of idorChecks) {
        const res = await request(path, { method, cookie: cookieB, body })
        record(
            res.status === 404 ? "PASS" : "FAIL",
            `B -> A ${method} ${path} returns 404`,
            `status=${res.status}`,
        )
    }

    const intact = await request(`/api/diagrams/${a1}`, { cookie: cookieA })
    const intactJson = await intact.json().catch(() => ({}))
    record(
        intact.status === 200 && intactJson.title === "security-check A1"
            ? "PASS"
            : "FAIL",
        "A's diagram is unchanged after B's attempts",
        `title=${intactJson.title} revision=${intactJson.revision}`,
    )

    // 3. list ownership fuzz --------------------------------------------
    const aUserId = (
        await (async () => {
            const res = await fetch(`${BASE}/api/auth/get-session`, {
                headers: { Cookie: cookieA },
            })
            const data = await res.json().catch(() => null)
            return data?.user?.id
        })()
    )?.toString()
    const fuzzParams = [
        "userId",
        "ownerId",
        "owner",
        "uid",
        "email",
        "user_id",
    ].map((p) => `${p}=${aUserId || "someone-else"}`)
    let listLeak = false
    for (const param of fuzzParams) {
        const res = await request(`/api/diagrams?limit=50&${param}`, {
            cookie: cookieB,
        })
        const data = await res.json().catch(() => ({}))
        if ((data.items || []).some((i) => i.id === a1 || i.id === a2)) {
            listLeak = true
        }
    }
    record(
        listLeak ? "FAIL" : "PASS",
        "list ignores client-supplied owner parameters",
        listLeak ? "leaked another user's diagram" : "no leak",
    )

    // 4. body size limit -------------------------------------------------
    const bigBody = JSON.stringify({
        baseRevision: 1,
        title: "oversized",
        messages: [{ pad: "A".repeat(25 * 1024 * 1024) }],
    })
    const bigRes = await request(`/api/diagrams/${a2}`, {
        method: "PATCH",
        cookie: cookieA,
        body: bigBody,
    })
    record(
        bigRes.status === 413 ? "PASS" : "FAIL",
        "oversized diagram PATCH rejected with 413",
        `status=${bigRes.status}`,
    )

    const bigChat = JSON.stringify({
        messages: [
            {
                role: "user",
                parts: [{ type: "text", text: "A".repeat(26 * 1024 * 1024) }],
            },
        ],
    })
    const bigChatRes = await request("/api/chat", {
        method: "POST",
        cookie: cookieA,
        body: bigChat,
    })
    record(
        bigChatRes.status === 413 ? "PASS" : "FAIL",
        "oversized chat POST rejected with 413",
        `status=${bigChatRes.status}`,
    )

    const bigValidate = JSON.stringify({
        imageData: `data:image/png;base64,${"A".repeat(11 * 1024 * 1024)}`,
    })
    const bigValidateRes = await request("/api/validate-diagram", {
        method: "POST",
        cookie: cookieA,
        body: bigValidate,
    })
    record(
        bigValidateRes.status === 413 ? "PASS" : "FAIL",
        "oversized validate-diagram POST rejected with 413",
        `status=${bigValidateRes.status}`,
    )

    // 9. stored-XSS rendering (browser) ----------------------------------
    if (process.env.SECURITY_RUN_XSS === "1") {
        await runBrowserXssCheck(cookieA)
    } else {
        record(
            "WARN",
            "browser XSS check skipped",
            "set SECURITY_RUN_XSS=1 (requires Playwright + chromium)",
        )
    }

    // cleanup ------------------------------------------------------------
    await request(`/api/diagrams/${a1}`, { method: "DELETE", cookie: cookieA })
    await request(`/api/diagrams/${a2}`, { method: "DELETE", cookie: cookieA })

    // 6. rate limiting / XFF spoofing -----------------------------------
    const badEmail = `nobody-${Date.now()}@example.test`
    const statuses = []
    for (let i = 0; i < 7; i++) {
        const res = await request("/api/auth/sign-in/email", {
            method: "POST",
            body: JSON.stringify({
                email: badEmail,
                password: "wrong-password",
            }),
            headers: { "X-Forwarded-For": "198.51.100.200" },
        })
        statuses.push(res.status)
    }
    const limited = statuses.includes(429)
    record(
        limited ? "PASS" : "FAIL",
        "brute-force attempts are rate limited",
        `statuses=${statuses.join(",")}`,
    )

    const spoofStatuses = []
    for (let i = 1; i <= 7; i++) {
        const res = await request("/api/auth/sign-in/email", {
            method: "POST",
            body: JSON.stringify({
                email: badEmail,
                password: "wrong-password",
            }),
            headers: { "X-Forwarded-For": `203.0.113.${i}` },
        })
        spoofStatuses.push(res.status)
    }
    const spoofLimited = spoofStatuses.includes(429)
    record(
        spoofLimited ? "PASS" : "WARN",
        "rate limit cannot be bypassed by rotating X-Forwarded-For",
        spoofLimited
            ? "rotating spoofed IPs still limited"
            : "bypassed: deploy behind a proxy that overwrites X-Forwarded-For",
    )
}

main()
    .catch((error) => {
        record("FAIL", "security-check crashed", String(error))
    })
    .finally(() => {
        console.log(
            `\n${results.length} checks: ${results.filter((r) => r.status === "PASS").length} pass, ${failed} fail, ${warned} warn`,
        )
        process.exit(failed > 0 ? 1 : 0)
    })
