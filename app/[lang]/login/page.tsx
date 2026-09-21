import { notFound, redirect } from "next/navigation"
import { Suspense } from "react"
import { LoginForm } from "@/components/auth/LoginForm"
import {
    countUsers,
    isAuthEnabled,
    isRegistrationAllowed,
} from "@/lib/auth/auth"
import { hasLocale } from "@/lib/i18n/dictionaries"

export const dynamic = "force-dynamic"

export default async function LoginPage({
    params,
}: {
    params: Promise<{ lang: string }>
}) {
    const { lang } = await params
    if (!hasLocale(lang)) notFound()
    if (!isAuthEnabled()) redirect(`/${lang}`)
    if (countUsers() === 0) redirect(`/${lang}/setup`)

    return (
        <main className="min-h-screen flex items-center justify-center bg-background p-4">
            <div className="w-full max-w-sm rounded-xl border border-border/60 bg-card p-6 shadow-soft">
                <h1 className="text-lg font-semibold mb-1">Next AI Draw.io</h1>
                <Suspense fallback={null}>
                    <LoginForm
                        lang={lang}
                        allowRegistration={isRegistrationAllowed()}
                    />
                </Suspense>
            </div>
        </main>
    )
}
