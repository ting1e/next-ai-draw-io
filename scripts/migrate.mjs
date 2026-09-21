import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"

const dbPath =
    process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite")
const migrationsFolder =
    process.env.DRIZZLE_MIGRATIONS_PATH || path.join(process.cwd(), "drizzle")

fs.mkdirSync(path.dirname(dbPath), { recursive: true })

if (!fs.existsSync(path.join(migrationsFolder, "meta", "_journal.json"))) {
    console.error(`[migrate] migrations folder not found: ${migrationsFolder}`)
    process.exit(1)
}

const sqlite = new Database(dbPath)
sqlite.pragma("journal_mode = WAL")
sqlite.pragma("foreign_keys = ON")
sqlite.pragma("busy_timeout = 5000")

try {
    migrate(drizzle(sqlite), { migrationsFolder })
    console.log(`[migrate] database is up to date: ${dbPath}`)
} catch (error) {
    console.error("[migrate] migration failed:", error)
    process.exit(1)
} finally {
    sqlite.close()
}
