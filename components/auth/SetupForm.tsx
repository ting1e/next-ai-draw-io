"use client"

import { useRouter } from "next/navigation"
import { type FormEvent, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useDictionary } from "@/hooks/use-dictionary"
import { getApiEndpoint } from "@/lib/base-path"

export function SetupForm({ lang }: { lang: string }) {
    const dict = useDictionary()
    const router = useRouter()
    const [name, setName] = useState("")
    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault()
        if (password.length < 8) {
            setError(dict.auth.passwordTooShort)
            return
        }
        setLoading(true)
        setError(null)

        try {
            const response = await fetch(getApiEndpoint("/api/setup"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, email, password }),
            })
            if (!response.ok) {
                const data = await response.json().catch(() => null)
                setError(data?.error || dict.auth.genericError)
                setLoading(false)
                return
            }
            router.replace(`/${lang}`)
            router.refresh()
        } catch {
            setError(dict.auth.genericError)
            setLoading(false)
        }
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
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
                    autoComplete="new-password"
                    required
                    minLength={8}
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
                {loading ? dict.auth.creatingAccount : dict.auth.createAccount}
            </Button>
        </form>
    )
}
