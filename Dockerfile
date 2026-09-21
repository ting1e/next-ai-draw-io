# Multi-stage Dockerfile for Next.js

# Stage 1: Install dependencies
FROM node:24-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
ARG ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm install

# Stage 2: Build application
FROM node:24-alpine AS builder
WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Disable Next.js telemetry during build
ENV NEXT_TELEMETRY_DISABLED=1

# Build-time argument for self-hosted draw.io URL
ARG NEXT_PUBLIC_DRAWIO_BASE_URL=https://embed.diagrams.net
ENV NEXT_PUBLIC_DRAWIO_BASE_URL=${NEXT_PUBLIC_DRAWIO_BASE_URL}

# Build-time argument to show About link and Notice icon
ARG NEXT_PUBLIC_SHOW_ABOUT_AND_NOTICE=false
ENV NEXT_PUBLIC_SHOW_ABOUT_AND_NOTICE=${NEXT_PUBLIC_SHOW_ABOUT_AND_NOTICE}

# Build-time argument for subdirectory deployment (e.g., /nextaidrawio)
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=${NEXT_PUBLIC_BASE_PATH}

# Control sponsorship and self-hosting messaging in quota notifications.
# Set NEXT_PUBLIC_SELFHOSTED="true" in self-hosted deployments to hide sponsorship/self-host links and related text in quota popups.
ARG NEXT_PUBLIC_SELFHOSTED=""
ENV NEXT_PUBLIC_SELFHOSTED="${NEXT_PUBLIC_SELFHOSTED}"

# Build Next.js application (standalone mode)
RUN npm run build

# Stage 3: Production runtime
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# su-exec lets the entrypoint drop root privileges. Also patch the base
# image's OpenSSL packages and remove the npm CLI: npm is only needed while
# building and its bundled dependency tree keeps collecting advisories that
# are unreachable at runtime.
RUN apk add --no-cache su-exec \
    && apk upgrade --no-cache libcrypto3 libssl3 \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Copy necessary files
COPY --from=builder /app/public ./public

# Copy standalone build output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Drizzle migrations + migration/backup scripts (run before Next.js starts)
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
# drizzle-orm is bundled into the Next.js server chunks but the standalone
# migration script imports it directly, so keep a copy on disk.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/drizzle-orm ./node_modules/drizzle-orm

# Writable dir for SQLite database and admin panel settings (data/settings.json)
RUN mkdir -p /app/data && chown nextjs:nodejs /app/data \
    && chmod +x /app/scripts/docker-entrypoint.sh

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# The entrypoint fixes ownership of the mounted /app/data, runs migrations
# (aborting startup on failure), then drops privileges and starts the server.
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]

