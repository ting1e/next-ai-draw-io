import "server-only"
import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import * as schema from "./schema"

export type Db = BetterSQLite3Database<typeof schema>

interface DbState {
    sqlite: Database.Database
    db: Db
}

// Cache across dev HMR reloads so we don't open multiple connections.
const globalForDb = globalThis as unknown as { __nextAiDrawioDb?: DbState }

export function getDatabasePath(): string {
    return (
        process.env.DATABASE_PATH ||
        path.join(process.cwd(), "data", "app.sqlite")
    )
}

function resolveMigrationsFolder(): string | null {
    const candidates = [
        process.env.DRIZZLE_MIGRATIONS_PATH,
        path.join(process.cwd(), "drizzle"),
    ].filter((candidate): candidate is string => !!candidate)

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, "meta", "_journal.json"))) {
            return candidate
        }
    }
    return null
}

function createState(): DbState {
    const dbPath = getDatabasePath()
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })

    const sqlite = new Database(dbPath)
    sqlite.pragma("journal_mode = WAL")
    sqlite.pragma("foreign_keys = ON")
    sqlite.pragma("busy_timeout = 5000")
    sqlite.pragma("synchronous = NORMAL")

    const db = drizzle(sqlite, { schema })

    const migrationsFolder = resolveMigrationsFolder()
    if (migrationsFolder) {
        migrate(db, { migrationsFolder })
    } else {
        console.warn(
            "[db] Drizzle migrations folder not found; skipping migrations",
        )
    }

    return { sqlite, db }
}

export function getDbState(): DbState {
    if (!globalForDb.__nextAiDrawioDb) {
        globalForDb.__nextAiDrawioDb = createState()
    }
    return globalForDb.__nextAiDrawioDb
}

export function getDb(): Db {
    return getDbState().db
}

export function getSqlite(): Database.Database {
    return getDbState().sqlite
}
