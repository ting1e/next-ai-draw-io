# Self-Hosted Accounts & Diagram Library

This guide covers the self-hosted mode that turns Next AI Draw.io into a
private, multi-user draw.io document system:

- self-hosted draw.io editor (no `embed.diagrams.net`)
- email + password accounts with per-user data isolation
- server-side SQLite persistence (cross-device, cross-browser)
- diagram library with thumbnails, search, rename, duplicate, delete
- revision-based autosave with conflict protection
- version history (XML + PNG preview)
- `.drawio`, SVG and PNG export from the draw.io editor

Setting `AUTH_SECRET` enables this mode. Without it the application keeps the
original local-only (IndexedDB) behavior.

## Architecture

```text
Browser
   │
   └── http://host:19860 ──> Next.js app ──┬──> SQLite (/app/data/app.sqlite)
                                           └──> /drawio/* ──> jgraph/drawio
```

Only the app port (`19860`) is published. The `drawio` container is
reachable only by the app on an internal Docker network: the app proxies
`/drawio/*` so the browser loads the editor from the app's own origin. It is
never exposed directly.

## Quick start

All required variables are set directly in `docker-compose.yml`. At minimum
change `AUTH_SECRET` (generate with `openssl rand -hex 32`) and add your AI
provider variables:

```yaml
    app:
        environment:
            AUTH_SECRET: <long random string>
            AUTH_BASE_URL: http://localhost:19860
            AI_PROVIDER: openai
            OPENAI_API_KEY: sk-...
```

Then:

```bash
npm run docker:up          # recommended; auto-detects a local build proxy
# or
docker compose up -d --build
```

Open `http://localhost:19860/setup` and create the first account. It becomes
the administrator, and `/setup` returns 404 afterwards.

### Build downloads and proxies

`npm run docker:up` (and `npm run docker:build`) run
`scripts/docker-compose.mjs`, which forwards a locally configured proxy to
the image build so npm/apt/wget downloads use it. It detects the proxy from
(in order):

1. `http_proxy` / `https_proxy` in the environment
2. the Docker daemon systemd drop-in (`/etc/systemd/system/docker.service.d/*.conf`)
3. `~/.docker/config.json` → `proxies.default`

Image pulls (`docker pull`) are handled by the Docker daemon and are not
affected. If you invoke `docker compose` directly and need the proxy, export
it first:

```bash
export https_proxy=http://localhost:20172
docker compose build
```

Sign in at `/login`. Diagrams are stored server-side and appear in
**My Diagrams** in the chat panel.

### HTTPS / domain

Terminate TLS at a reverse proxy in front of the app only, then set
`AUTH_BASE_URL=https://draw.example.com`. Because `/drawio/*` is served
through the app, draw.io needs no separate DNS name or port. If users access
the app from another machine over plain HTTP, set `AUTH_BASE_URL` to the
server host or IP (e.g. `http://192.168.1.10:19860`) and rebuild nothing -
only restart the app after editing the compose file.

## Environment variables

See the `environment` block in `docker-compose.yml`. The most important ones:

| Variable | Default | Description |
| --- | --- | --- |
| `AUTH_SECRET` | – | Enables accounts when set. Use a long random string. |
| `AUTH_BASE_URL` | – | Public origin, e.g. `https://draw.example.com`. |
| `ALLOW_REGISTRATION` | `false` | Allow sign-up after the first user exists. |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | Reserved for SMTP support (not implemented in V1). |
| `DATABASE_PATH` | `/app/data/app.sqlite` | SQLite file location. |
| `MAX_DIAGRAM_XML_MB` | `10` | Maximum diagram XML size. |
| `MAX_MESSAGE_DATA_MB` | `10` | Maximum chat message payload size. |
| `MAX_REQUEST_BODY_MB` | `20` | Maximum API request body size. |
| `MAX_CHAT_BODY_MB` | `25` | Maximum `/api/chat` request body size. |
| `MAX_DIAGRAM_VERSIONS` | `50` | Version snapshots kept per diagram. |
| `AUTH_TRUSTED_ORIGINS` | – | Extra comma-separated trusted origins. |
| `ALLOW_PRIVATE_URLS` | `true` | Set to `false` to block client-supplied AI base URLs that resolve to private/internal addresses (SSRF). The compose file sets `false`. |
| `ENABLE_URL_FETCH` | `false` | Enables authenticated web-page import (`POST /api/parse-url`). Disabled by default; enabling adds a server-side fetch surface. |
| `DRAWIO_INTERNAL_URL` | `http://drawio:8080` | Build-time target the app proxies `/drawio/*` to. |

Add any other variables the same way. `env.example` lists the full AI
provider configuration; copy the ones you use into the compose
`environment` block.

## Data isolation

Every diagram API derives the user from the verified session cookie and
queries with `WHERE id = ? AND user_id = ?`. Client-supplied user or owner
identifiers are never trusted. Requests without a valid session receive
`401`; another user's diagram is indistinguishable from a missing one
(`404`).

## Autosave and conflicts

- Edits are debounced (1.2 s) and saved with the revision last seen.
- If the server revision changed (another device/tab), the API returns
  `409 Conflict` with the server document.
- The UI offers **Reload server version** or **Save my version as a copy**.
  Last-write-wins is intentionally not used.

## Security regression baseline

A repeatable P0 check suite lives in `scripts/security-check.mjs`. It assumes
an isolated staging stack (`docker-compose.security.yml`) with two seeded
accounts and verifies the invariants that must survive every upstream merge:
anonymous 401s, cross-user 404s on every diagram/version/thumbnail/export
route, list-ownership fuzzing, 413 body limits, cookie attributes, `/setup`
closure, disabled registration, the `parse-url` gate and a browser check that
HTML-bearing titles are rendered as text. Set `SECURITY_RUN_XSS=1` (requires
Playwright chromium) to enable the browser check.

```bash
docker compose -p next-ai-draw-io-security -f docker-compose.security.yml up -d
SECURITY_BASE_URL=http://127.0.0.1:19870 \
SECURITY_EMAIL_A=... SECURITY_PASSWORD_A=... \
SECURITY_EMAIL_B=... SECURITY_PASSWORD_B=... \
npm run security:check
```

Two known warnings are expected on a plain-HTTP LAN deployment:

- `Secure` is omitted from session cookies unless `AUTH_BASE_URL` is
  `https://...` (Better Auth sets it automatically over HTTPS).
- Login rate limiting keys on `X-Forwarded-For`, which a direct client can
  spoof. Run the app behind a reverse proxy that overwrites that header when
  brute-force exposure matters; never expose the container directly to the
  internet without it.

Production builds also send a phase-1 Content-Security-Policy
(`object-src 'none'`, `connect-src 'self'`, `frame-src 'self'`) on app pages.
It is intentionally skipped on the `/drawio/*` proxy path, because the editor
is a separate same-origin document that needs its own inline scripts and
workers. `'unsafe-inline'` is still required for Next.js hydration; tightening
that to nonces is a future step. If you enable Google Analytics
(`NEXT_PUBLIC_GA_ID`), the GA origins are added to `script-src`/`connect-src`
automatically at build time.

Never bake local data into images: `data/`, `data-security/` and `backups/`
are excluded via `.dockerignore` (the authoritative guard, since Turbopack
traces the whole project into `.next/standalone`). `next.config.ts` lists the
same paths in `outputFileTracingExcludes` as defense-in-depth. Keep both in
sync if you add data directories, and never commit a `.dockerignore` change
that removes them.

The runtime image ships without the npm CLI and with patched OpenSSL
packages; use `node scripts/db-backup.mjs` instead of `npm run db:backup`
inside the container.

## Version history

Snapshots are created when an AI edit finishes, when you press **Save
version**, and otherwise at most every 5 minutes when the XML changed. Raw
SVG is never stored; previews are rasterized PNGs. Restoring a version first
snapshots the current revision, so a restore is itself undoable.

## PDF

PDF export is provided by draw.io itself, inside the editor. This app does
not ship a server-side PDF renderer, a PDF API, or a PDF download action in
the diagram library. See the upstream FAQ if draw.io's PDF export does not
work in your environment (PNG + print is the fallback).

## Backup and restore

Create a consistent online backup (WAL-safe):

```bash
docker compose exec app node scripts/db-backup.mjs
```

Backups are written to `./data/backups/`. To restore, stop the stack, copy
the chosen backup over `data/app.sqlite` (remove `app.sqlite-wal` and
`app.sqlite-shm` first), then start the stack again:

```bash
docker compose down
cp data/backups/app-YYYY-MM-DD-HHMMSS.sqlite data/app.sqlite
rm -f data/app.sqlite-wal data/app.sqlite-shm
docker compose up -d
```

Migrations run automatically before the app starts; a failed migration
aborts startup instead of serving a broken database.

## Upgrading and syncing with upstream

- The self-hosted feature set is additive: `lib/auth`, `lib/db`,
  `lib/storage`, `app/api/diagrams`, `components/diagrams`,
  `components/auth`, `drizzle`.
- Upstream changes to the AI provider core, draw.io renderer and chat flow
  are intentionally untouched, so merges stay small.
- After pulling upstream changes:

    ```bash
    npm install
    npm run db:generate   # only if you changed lib/db/schema.ts
    npm run db:migrate
    npm test -- --run
    npm run build
    ```

## Local (non-Docker) development

```bash
cp env.example .env.local          # set AUTH_SECRET and AUTH_BASE_URL
npm install
npm run db:migrate
npm run dev                        # http://localhost:6002
```

Open `http://localhost:6002/setup` to create the first account.

To use a self-hosted draw.io editor in dev, run the drawio container locally
and point the app at it:

```bash
docker run -d --name drawio -p 8080:8080 jgraph/drawio:31.4.5
# in .env.local:
#   NEXT_PUBLIC_DRAWIO_BASE_URL=/drawio
#   DRAWIO_INTERNAL_URL=http://localhost:8080
```

Restart `npm run dev` after changing these (both are read when the config is
loaded). Without them the app keeps using `https://embed.diagrams.net`.
