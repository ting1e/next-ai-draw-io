import {
    blob,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core"

/**
 * Better Auth core tables.
 * Field names must match what the Better Auth Drizzle adapter expects.
 * https://better-auth.com/docs/adapters/drizzle
 */
export const user = sqliteTable("user", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" })
        .default(false)
        .notNull(),
    image: text("image"),
    role: text("role").default("user"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
})

export const session = sqliteTable(
    "session",
    {
        id: text("id").primaryKey(),
        expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
        token: text("token").notNull().unique(),
        createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
        ipAddress: text("ip_address"),
        userAgent: text("user_agent"),
        userId: text("user_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
    },
    (table) => [index("idx_session_user_id").on(table.userId)],
)

export const account = sqliteTable(
    "account",
    {
        id: text("id").primaryKey(),
        accountId: text("account_id").notNull(),
        providerId: text("provider_id").notNull(),
        userId: text("user_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        accessToken: text("access_token"),
        refreshToken: text("refresh_token"),
        idToken: text("id_token"),
        accessTokenExpiresAt: integer("access_token_expires_at", {
            mode: "timestamp",
        }),
        refreshTokenExpiresAt: integer("refresh_token_expires_at", {
            mode: "timestamp",
        }),
        scope: text("scope"),
        password: text("password"),
        createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    },
    (table) => [index("idx_account_user_id").on(table.userId)],
)

export const verification = sqliteTable(
    "verification",
    {
        id: text("id").primaryKey(),
        identifier: text("identifier").notNull(),
        value: text("value").notNull(),
        expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
        createdAt: integer("created_at", { mode: "timestamp" }),
        updatedAt: integer("updated_at", { mode: "timestamp" }),
    },
    (table) => [index("idx_verification_identifier").on(table.identifier)],
)

/**
 * A diagram document = draw.io XML + AI conversation + snapshots + metadata.
 * This intentionally mirrors the client-side ChatSession shape so the storage
 * adapter can map between them with minimal translation.
 */
export const diagrams = sqliteTable(
    "diagrams",
    {
        id: text("id").primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        title: text("title").notNull(),
        diagramXml: text("diagram_xml").notNull().default(""),
        messagesJson: text("messages_json").notNull().default("[]"),
        xmlSnapshotsJson: text("xml_snapshots_json").notNull().default("[]"),
        revision: integer("revision").notNull().default(1),
        thumbnailMime: text("thumbnail_mime"),
        thumbnailBlob: blob("thumbnail_blob", { mode: "buffer" }),
        thumbnailRevision: integer("thumbnail_revision"),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
        deletedAt: integer("deleted_at"),
    },
    (table) => [
        index("idx_diagrams_user_updated").on(table.userId, table.updatedAt),
        index("idx_diagrams_user_title").on(table.userId, table.title),
    ],
)

/**
 * Immutable history snapshots. Only XML + optional PNG preview are stored,
 * never raw SVG, to avoid stored-XSS through preview rendering.
 */
export const diagramVersions = sqliteTable(
    "diagram_versions",
    {
        id: text("id").primaryKey(),
        diagramId: text("diagram_id")
            .notNull()
            .references(() => diagrams.id, { onDelete: "cascade" }),
        revision: integer("revision").notNull(),
        diagramXml: text("diagram_xml").notNull(),
        previewMime: text("preview_mime"),
        previewBlob: blob("preview_blob", { mode: "buffer" }),
        label: text("label"),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [
        uniqueIndex("idx_versions_diagram_revision").on(
            table.diagramId,
            table.revision,
        ),
    ],
)

export type UserRow = typeof user.$inferSelect
export type DiagramRow = typeof diagrams.$inferSelect
export type DiagramVersionRow = typeof diagramVersions.$inferSelect
