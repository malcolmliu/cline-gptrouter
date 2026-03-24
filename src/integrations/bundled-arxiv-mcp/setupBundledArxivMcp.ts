/**
 * One-time / idempotent registration of the bundled arxiv-mcp-server into cline_mcp_settings.json.
 * Upstream: https://github.com/blazickjp/arxiv-mcp-server (MIT)
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { ensureSettingsDirectoryExists, getMcpSettingsFilePath } from "@core/storage/disk"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { fileExistsAtPath } from "@/utils/fs"

export const BUNDLED_ARXIV_MCP_SERVER_ID = "gptrouter-arxiv-mcp"

/** Clear this global state key (or run command `cline-gptrouter.setupBundledArxivMcp`) to force re-write of MCP entry. */
export const BUNDLED_ARXIV_MCP_FINGERPRINT_KEY = "gptrouter.bundledArxivMcp.fingerprint"

const UV_WARNED_KEY = "gptrouter.bundledArxivMcp.uvWarned"

function bundledArxivRoot(extensionPath: string): string {
	return path.join(extensionPath, "bundled", "arxiv-mcp-server")
}

function isUvOnPath(): boolean {
	try {
		const r = spawnSync("uv", ["--version"], {
			encoding: "utf8",
			shell: process.platform === "win32",
			timeout: 8000,
		})
		return r.status === 0
	} catch {
		return false
	}
}

function buildFingerprint(extensionPath: string, paperStoragePath: string): string {
	return JSON.stringify({ extensionPath, paperStoragePath })
}

/**
 * Merge bundled ArXiv MCP into user MCP settings if the repo is present and `uv` is available.
 */
export async function setupBundledArxivMcp(context: vscode.ExtensionContext, options?: { force?: boolean }): Promise<void> {
	const extensionPath = context.extensionPath
	const root = bundledArxivRoot(extensionPath)
	const pyproject = path.join(root, "pyproject.toml")

	if (!(await fileExistsAtPath(pyproject))) {
		Logger.warn("[gptrouter] Bundled arxiv-mcp-server not found (skip MCP auto-setup). See bundled/README.md")
		void vscode.window.showWarningMessage(
			"cline-gptrouter: 当前安装的扩展里未包含 bundled/arxiv-mcp-server（打包前需执行 npm run vendor:arxiv-mcp）。因此不会出现 ArXiv MCP 条目。",
		)
		return
	}

	const paperStoragePath = path.join(context.globalStorageUri.fsPath, "arxiv-mcp-server", "papers")
	await fs.mkdir(paperStoragePath, { recursive: true })

	const uvOk = isUvOnPath()
	if (!uvOk) {
		const warned = context.globalState.get<boolean>(UV_WARNED_KEY)
		if (!warned) {
			await context.globalState.update(UV_WARNED_KEY, true)
			void vscode.window.showInformationMessage(
				"cline-gptrouter: 已在 MCP 列表加入「gptrouter-arxiv-mcp」（无 uv 时显示为禁用）。请先安装 uv：https://github.com/astral-sh/uv — 安装后执行命令「Cline: Refresh bundled ArXiv MCP configuration」或重载窗口。",
			)
		}
		Logger.warn("[gptrouter] «uv» not found on PATH; registering ArXiv MCP as disabled until uv is available")
	}

	const args = ["--directory", root, "run", "arxiv-mcp-server", "--storage-path", paperStoragePath]
	const desiredEntry = {
		type: "stdio" as const,
		command: "uv",
		args,
		// Still write the entry so it appears in MCP settings; keep disabled until uv is on PATH.
		disabled: !uvOk,
	}

	const fingerprint = buildFingerprint(extensionPath, paperStoragePath)
	if (!options?.force) {
		const prev = context.globalState.get<string>(BUNDLED_ARXIV_MCP_FINGERPRINT_KEY)
		if (prev === fingerprint) {
			const settingsDir = await ensureSettingsDirectoryExists()
			const mcpPath = await getMcpSettingsFilePath(settingsDir)
			if (await fileExistsAtPath(mcpPath)) {
				try {
					const raw = JSON.parse(await fs.readFile(mcpPath, "utf8")) as { mcpServers?: Record<string, any> }
					const cur = raw.mcpServers?.[BUNDLED_ARXIV_MCP_SERVER_ID]
					if (cur && JSON.stringify(stableMcpEntry(cur)) === JSON.stringify(stableMcpEntry(desiredEntry))) {
						return
					}
				} catch {
					// fall through to rewrite
				}
			}
		}
	}

	const settingsDir = await ensureSettingsDirectoryExists()
	const mcpPath = await getMcpSettingsFilePath(settingsDir)

	let config: { mcpServers: Record<string, any> }
	try {
		const text = await fs.readFile(mcpPath, "utf8")
		const parsed = JSON.parse(text) as { mcpServers?: Record<string, any> }
		config = { mcpServers: { ...(parsed.mcpServers ?? {}) } }
	} catch {
		config = { mcpServers: {} }
	}

	const existing = config.mcpServers[BUNDLED_ARXIV_MCP_SERVER_ID]
	if (
		existing &&
		!options?.force &&
		JSON.stringify(stableMcpEntry(existing)) === JSON.stringify(stableMcpEntry(desiredEntry))
	) {
		await context.globalState.update(BUNDLED_ARXIV_MCP_FINGERPRINT_KEY, fingerprint)
		return
	}

	config.mcpServers[BUNDLED_ARXIV_MCP_SERVER_ID] = desiredEntry
	await fs.writeFile(mcpPath, JSON.stringify(config, null, 2), "utf8")
	await context.globalState.update(BUNDLED_ARXIV_MCP_FINGERPRINT_KEY, fingerprint)

	Logger.log(`[gptrouter] Registered bundled ArXiv MCP as «${BUNDLED_ARXIV_MCP_SERVER_ID}» in ${mcpPath}`)
}

function stableMcpEntry(e: { type?: string; command?: string; args?: string[]; disabled?: boolean }): {
	type: string
	command: string
	args: string[]
	disabled: boolean
} {
	return {
		type: e.type ?? "stdio",
		command: e.command ?? "",
		args: e.args ?? [],
		disabled: e.disabled ?? false,
	}
}
