"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { type FormEvent, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useDictionary } from "@/hooks/use-dictionary"
import { authClient } from "@/lib/auth/auth-client"

export function LoginForm({
    lang,
    allowRegistration = false,
}: {
    lang: string
    allowRegistration?: boolean
}) {
    const dict = useDictionary()
    const router = useRouter()
    const searchParams = useSearchParams()
    const [mode, setMode] = useState<"signin" | "signup">("signin")
    const [name, setName] = useState("")
    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault()
        setLoading(true)
        setError(null)

        const { error: authError } =
            mode === "signup"
                ? await authClient.signUp.email({ name, email, password })
                : await authClient.signIn.email({ email, password })

        if (authError) {
            setError(
                authError.status === 401
                    ? dict.auth.invalidCredentials
                    : authError.message || dict.auth.genericError,
            )
            setLoading(false)
            return
        }

        const next = searchParams.get("next")
        const target = next?.startsWith("/") ? next : `/${lang}`
        router.replace(target)
        router.refresh()
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "signup" && (
                <div className="space-y-2">
                    <Label htmlFor="name">{dict.auth.name}</Label>
                    <Input
                        id="name"
                        autoComplete="name"
                        required
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                </div>
            )}
            <div className="space-y-2">
                <Label htmlFor="email">{dict.auth.email}</Label>
                <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                />
            </div>
            <div className="space-y-2">
                <Label htmlFor="password">{dict.auth.password}</Label>
                <Input
                    id="password"
                    type="password"
                    autoComplete={
                        mode === "signup" ? "new-password" : "current-password"
                    }
                    required
                    minLength={mode === "signup" ? 8 : undefined}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                />
            </div>
            {error && (
                <p className="text-sm text-destructive" role="alert">
                    {error}
                </p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
                {mode === "signup"
                    ? loading
                        ? dict.auth.creatingAccount
                        : dict.auth.createAccount
                    : loading
                      ? dict.auth.signingIn
                      : dict.auth.signIn}
            </Button>
            {allowRegistration && (
                <button
                    type="button"
                    className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => {
                        setMode(mode === "signin" ? "signup" : "signin")
                        setError(null)
                    }}
                >
                    {mode === "signin"
                        ? dict.auth.createAccount
                        : dict.auth.signIn}
                </button>
            )}
        </form>
    )
}
