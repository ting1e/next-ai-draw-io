#!/usr/bin/env node
// Runs `docker compose <args>` while automatically forwarding a locally
// configured proxy to the build (npm/apt/wget downloads).
//
// Detection order:
//   1. http_proxy / https_proxy from the current environment
//   2. Docker daemon systemd drop-in proxy configuration (Linux)
//   3. Docker CLI config (~/.docker/config.json -> proxies.default)
//
// Image pulls are handled by the Docker daemon itself and are not touched.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function fromEnv() {
    return (
        process.env.https_proxy ||
        process.env.HTTPS_PROXY ||
        process.env.http_proxy ||
        process.env.HTTP_PROXY ||
        null
    )
}

function fromSystemd() {
    const dir = "/etc/systemd/system/docker.service.d"
    if (!fs.existsSync(dir)) return null
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".conf")) continue
        try {
            const content = fs.readFileSync(path.join(dir, file), "utf8")
            const match = content.match(/HTTPS?_PROXY=["']?([^\s"']+)/i)
            if (match?.[1]) return match[1]
        } catch {
            // ignore unreadable files
        }
    }
    return null
}

function fromDockerConfig() {
    try {
        const configPath = path.join(os.homedir(), ".docker", "config.json")
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
        const defaults = config?.proxies?.default
        return defaults?.httpsProxy || defaults?.httpProxy || null
    } catch {
        return null
    }
}

const proxy = fromEnv() || fromSystemd() || fromDockerConfig()

const env = { ...process.env }
if (proxy) {
    env.http_proxy = proxy
    env.https_proxy = proxy
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
    console.log(`[docker-compose] forwarding build downloads through ${proxy}`)
} else {
    console.log(
        "[docker-compose] no local proxy detected; build downloads use a direct connection",
    )
}

const result = spawnSync("docker", ["compose", ...process.argv.slice(2)], {
    stdio: "inherit",
    env,
})

process.exit(result.status ?? 1)
