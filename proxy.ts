import { match as matchLocale } from "@formatjs/intl-localematcher"
import Negotiator from "negotiator"
import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { i18n } from "./lib/i18n/config"

const SESSION_COOKIE_NAMES = [
    "better-auth.session_token",
    "__Secure-better-auth.session_token",
]

// Pages reachable without a session when auth is enabled.
const PUBLIC_PAGE_SEGMENTS = new Set(["login", "setup", "about"])

function isAuthEnabled(): boolean {
    return Boolean(process.env.AUTH_SECRET)
}

function hasSessionCookie(request: NextRequest): boolean {
    return request.cookies
        .getAll()
        .some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name))
}

function getLocale(request: NextRequest): string | undefined {
    // Negotiator expects plain object so we need to transform headers
    const negotiatorHeaders: Record<string, string> = {}
    request.headers.forEach((value, key) => {
        negotiatorHeaders[key] = value
    })

    // @ts-expect-error locales are readonly
    const locales: string[] = i18n.locales

    // Use negotiator and intl-localematcher to get best locale
    const languages = new Negotiator({ headers: negotiatorHeaders }).languages(
        locales,
    )

    const locale = matchLocale(languages, locales, i18n.defaultLocale)

    return locale
}

export function proxy(request: NextRequest) {
    const pathname = request.nextUrl.pathname

    // Skip API routes, static files, and Next.js internals
    if (
        pathname.startsWith("/api/") ||
        pathname.startsWith("/_next/") ||
        pathname.startsWith("/drawio") ||
        pathname.includes("/favicon") ||
        /\.(.*)$/.test(pathname)
    ) {
        return
    }

    // Check if there is any supported locale in the pathname
    const pathnameIsMissingLocale = i18n.locales.every(
        (locale) =>
            !pathname.startsWith(`/${locale}/`) && pathname !== `/${locale}`,
    )

    // Redirect if there is no locale
    if (pathnameIsMissingLocale) {
        const locale = getLocale(request)

        // Redirect to localized path
        return NextResponse.redirect(
            new URL(
                `/${locale}${pathname.startsWith("/") ? "" : "/"}${pathname}`,
                request.url,
            ),
        )
    }

    // When auth is enabled, gate all application pages behind a session.
    if (isAuthEnabled()) {
        const segments = pathname.split("/").filter(Boolean)
        const locale = segments[0]
        const firstSegment = segments[1] ?? ""
        const isPublicPage = PUBLIC_PAGE_SEGMENTS.has(firstSegment)

        if (!isPublicPage && !hasSessionCookie(request)) {
            const loginUrl = new URL(`/${locale}/login`, request.url)
            loginUrl.searchParams.set("next", pathname)
            return NextResponse.redirect(loginUrl)
        }
    }
}

export const config = {
    // Matcher ignoring `/_next/` and `/api/`
    matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
}
