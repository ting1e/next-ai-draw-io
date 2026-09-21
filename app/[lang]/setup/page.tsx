import { notFound, redirect } from "next/navigation"
import { SetupForm } from "@/components/auth/SetupForm"
import { countUsers, isAuthEnabled } from "@/lib/auth/auth"
import { hasLocale } from "@/lib/i18n/dictionaries"

export const dynamic = "force-dynamic"

export default async function SetupPage({
    params,
}: {
    params: Promise<{ lang: string }>
}) {
    const { lang } = await params
    if (!hasLocale(lang)) notFound()
    if (!isAuthEnabled()) redirect(`/${lang}`)
    if (countUsers() > 0) notFound()

    return (
        <main className="min-h-screen flex items-center justify-center bg-background p-4">
            <div className="w-full max-w-sm rounded-xl border border-border/60 bg-card p-6 shadow-soft">
                <h1 className="text-lg font-semibold mb-1">Next AI Draw.io</h1>
                <p className="text-sm text-muted-foreground mb-4">
                    Create the first administrator account to get started.
                </p>
                <SetupForm lang={lang} />
            </div>
        </main>
    )
}
