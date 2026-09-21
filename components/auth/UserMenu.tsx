"use client"

import { KeyRound, LogOut, User as UserIcon } from "lucide-react"
import { usePathname, useRouter } from "next/navigation"
import { type FormEvent, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"
import { useDictionary } from "@/hooks/use-dictionary"
import { authClient } from "@/lib/auth/auth-client"

interface UserMenuProps {
    name: string
    email: string
}

export function UserMenu({ name, email }: UserMenuProps) {
    const dict = useDictionary()
    const router = useRouter()
    const pathname = usePathname()
    const lang = pathname.split("/")[1] || "en"
    const [showChangePassword, setShowChangePassword] = useState(false)
    const [signingOut, setSigningOut] = useState(false)

    const handleSignOut = async () => {
        setSigningOut(true)
        await authClient.signOut()
        router.replace(`/${lang}/login`)
        router.refresh()
    }

    const initial = (name || email || "?").trim().charAt(0).toUpperCase()

    return (
        <>
            <Popover>
                <PopoverTrigger asChild>
                    <button
                        type="button"
                        className="h-8 w-8 rounded-full bg-primary/10 text-primary text-sm font-semibold flex items-center justify-center hover:bg-primary/20 transition-colors"
                        aria-label={name || email}
                        data-testid="user-menu-button"
                    >
                        {initial || <UserIcon className="h-4 w-4" />}
                    </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-60 p-1">
                    <div className="px-2 py-1.5 border-b border-border/50 mb-1">
                        <p className="text-sm font-medium truncate">{name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                            {email}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowChangePassword(true)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-accent transition-colors"
                    >
                        <KeyRound className="h-4 w-4 text-muted-foreground" />
                        {dict.auth.changePassword}
                    </button>
                    <button
                        type="button"
                        onClick={handleSignOut}
                        disabled={signingOut}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-accent transition-colors disabled:opacity-50"
                    >
                        <LogOut className="h-4 w-4 text-muted-foreground" />
                        {dict.auth.signOut}
                    </button>
                </PopoverContent>
            </Popover>

            <ChangePasswordDialog
                open={showChangePassword}
                onOpenChange={setShowChangePassword}
            />
        </>
    )
}

function ChangePasswordDialog({
    open,
    onOpenChange,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
}) {
    const dict = useDictionary()
    const [currentPassword, setCurrentPassword] = useState("")
    const [newPassword, setNewPassword] = useState("")
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault()
        if (newPassword.length < 8) {
            setError(dict.auth.passwordTooShort)
            return
        }
        setLoading(true)
        setError(null)
        const { error: changeError } = await authClient.changePassword({
            currentPassword,
            newPassword,
            revokeOtherSessions: true,
        })
        setLoading(false)
        if (changeError) {
            setError(changeError.message || dict.auth.genericError)
            return
        }
        toast.success(dict.auth.changePasswordSuccess)
        setCurrentPassword("")
        setNewPassword("")
        onOpenChange(false)
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{dict.auth.changePassword}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="current-password">
                            {dict.auth.currentPassword}
                        </Label>
                        <Input
                            id="current-password"
                            type="password"
                            autoComplete="current-password"
                            required
                            value={currentPassword}
                            onChange={(event) =>
                                setCurrentPassword(event.target.value)
                            }
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="new-password">
                            {dict.auth.newPassword}
                        </Label>
                        <Input
                            id="new-password"
                            type="password"
                            autoComplete="new-password"
                            required
                            minLength={8}
                            value={newPassword}
                            onChange={(event) =>
                                setNewPassword(event.target.value)
                            }
                        />
                    </div>
                    {error && (
                        <p className="text-sm text-destructive" role="alert">
                            {error}
                        </p>
                    )}
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                        >
                            {dict.common.cancel}
                        </Button>
                        <Button type="submit" disabled={loading}>
                            {dict.common.confirm}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
