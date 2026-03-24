#!/usr/bin/env node
import { spawnSync } from "node:child_process"
/**
 * Clone blazickjp/arxiv-mcp-server into bundled/arxiv-mcp-server if missing.
 * Run before `vsce package` when not using git submodule.
 */
import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")
const target = join(root, "bundled", "arxiv-mcp-server")
const marker = join(target, "pyproject.toml")

if (existsSync(marker)) {
	console.log("[vendor:arxiv-mcp] Already present:", target)
	process.exit(0)
}

console.log("[vendor:arxiv-mcp] Cloning into", target)
await rm(target, { recursive: true, force: true }).catch(() => {})
await mkdir(join(root, "bundled"), { recursive: true })

const r = spawnSync("git", ["clone", "--depth", "1", "https://github.com/blazickjp/arxiv-mcp-server.git", target], {
	stdio: "inherit",
	cwd: root,
})
if (r.status !== 0) {
	console.error("[vendor:arxiv-mcp] git clone failed")
	process.exit(r.status ?? 1)
}
console.log("[vendor:arxiv-mcp] Done.")
