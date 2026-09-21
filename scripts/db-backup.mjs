import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"

const dbPath =
    process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite")
const backupDir =
    process.env.BACKUP_DIR || path.join(path.dirname(dbPath), "backups")
const keep = Number(process.env.BACKUP_KEEP || 0)

if (!fs.existsSync(dbPath)) {
    console.error(`[backup] database not found: ${dbPath}`)
    process.exit(1)
}

fs.mkdirSync(backupDir, { recursive: true })

const stamp = new Date()
    .toISOString()
    .replace("T", "-")
    .replace(/[:.]/g, "")
    .slice(0, 15)
const target = path.join(backupDir, `app-${stamp}.sqlite`)

const sqlite = new Database(dbPath, { readonly: true })

try {
    // Uses SQLite's online backup API so WAL state is captured consistently.
    await sqlite.backup(target)
    console.log(`[backup] wrote ${target}`)
} catch (error) {
    console.error("[backup] failed:", error)
    process.exit(1)
} finally {
    sqlite.close()
}

if (keep > 0) {
    const backups = fs
        .readdirSync(backupDir)
        .filter((name) => name.startsWith("app-") && name.endsWith(".sqlite"))
        .sort()
    for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
        fs.rmSync(path.join(backupDir, name), { force: true })
        console.log(`[backup] pruned ${name}`)
    }
}
