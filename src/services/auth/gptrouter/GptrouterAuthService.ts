import crypto from "node:crypto"
import { buildApiHandler } from "@core/api"
import type { ApiProvider } from "@shared/api"
import axios from "axios"
import type { Controller } from "@/core/controller"
import { HostProvider } from "@/hosts/host-provider"
import { getAxiosSettings } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { openExternal } from "@/utils/env"

const DEFAULT_OAUTH_BASE = "https://gptrouter.cn"
const DEFAULT_CLIENT_ID = "cline-gptrouter-vscode"
const AUTHORIZE_PATH = "/oauth/authorize"
const TOKEN_PATH = "/oauth/token"

/** Keys whose values must not appear verbatim in logs (tokens, codes, secrets). */
const SENSITIVE_LOG_KEYS = new Set(["access_token", "refresh_token", "api_key", "id_token", "client_secret", "code", "password"])

function isSensitiveKey(key: string): boolean {
	const k = key.toLowerCase()
	if (SENSITIVE_LOG_KEYS.has(k)) {
		return true
	}
	return k.includes("token") || k.includes("secret") || k === "authorization"
}

/**
 * Deep-clone JSON-like values for logs: secrets replaced with length hints (structure preserved).
 */
function sanitizeOAuthPayloadForLog(value: unknown, depth = 0): unknown {
	if (depth > 10) {
		return "[max depth]"
	}
	if (value === null || value === undefined) {
		return value
	}
	if (typeof value === "string") {
		return value.length > 800 ? `${value.slice(0, 800)}…(truncated, len=${value.length})` : value
	}
	if (typeof value !== "object") {
		return value
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeOAuthPayloadForLog(item, depth + 1))
	}
	const out: Record<string, unknown> = {}
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		if (isSensitiveKey(key)) {
			if (typeof v === "string") {
				out[key] = `<redacted len=${v.length}>`
			} else if (v !== null && v !== undefined) {
				out[key] = "<redacted>"
			} else {
				out[key] = v
			}
		} else {
			out[key] = sanitizeOAuthPayloadForLog(v, depth + 1)
		}
	}
	return out
}

function headersObjectForLog(headers: unknown): Record<string, string> {
	if (!headers || typeof headers !== "object") {
		return {}
	}
	try {
		const h = headers as Record<string, unknown>
		if (typeof (headers as { toJSON?: () => unknown }).toJSON === "function") {
			const j = (headers as { toJSON: () => unknown }).toJSON()
			if (j && typeof j === "object") {
				return Object.fromEntries(Object.entries(j as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]))
			}
		}
		return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, String(v ?? "")]))
	} catch {
		return { _error: "could not serialize headers" }
	}
}

export type GptrouterOAuthSessionStored = {
	accessToken?: string
	refreshToken?: string
	expiresAt?: number
}

type TokenEndpointResponse = {
	access_token?: string
	refresh_token?: string
	expires_in?: number
	api_key?: string
	user?: {
		id?: string
		sub?: string
		email?: string
		name?: string
		display_name?: string
		displayName?: string
	}
}

/**
 * GPTRouter browser OAuth: authorize on the web, deep-link back to the extension, exchange code for API credentials.
 */
export class GptrouterAuthService {
	private static instance: GptrouterAuthService | null = null
	private _controller: Controller | null = null

	private constructor() {}

	public static initialize(controller: Controller): GptrouterAuthService {
		if (!GptrouterAuthService.instance) {
			GptrouterAuthService.instance = new GptrouterAuthService()
		}
		GptrouterAuthService.instance._controller = controller
		return GptrouterAuthService.instance
	}

	public static getInstance(): GptrouterAuthService {
		if (!GptrouterAuthService.instance?._controller) {
			throw new Error("GptrouterAuthService not initialized")
		}
		return GptrouterAuthService.instance
	}

	private requireController(): Controller {
		if (!this._controller) {
			throw new Error("Controller not set")
		}
		return this._controller
	}

	private getOAuthBase(): string {
		const ctrl = this.requireController()
		const raw = ctrl.stateManager.getGlobalSettingsKey("gptrouterOAuthBaseUrl")?.trim()
		const base = (raw || DEFAULT_OAUTH_BASE).replace(/\/$/, "")
		return base
	}

	private getTokenUrl(): string {
		const ctrl = this.requireController()
		const override = ctrl.stateManager.getGlobalSettingsKey("gptrouterOAuthTokenUrl")?.trim()
		if (override) {
			return override
		}
		return `${this.getOAuthBase()}${TOKEN_PATH}`
	}

	private getClientId(): string {
		const ctrl = this.requireController()
		return ctrl.stateManager.getGlobalSettingsKey("gptrouterOAuthClientId")?.trim() || DEFAULT_CLIENT_ID
	}

	private async getRedirectUri(): Promise<string> {
		const ctrl = this.requireController()
		const override = ctrl.stateManager.getGlobalSettingsKey("gptrouterOAuthRedirectUri")?.trim()
		if (override) {
			return override
		}
		return HostProvider.get().getCallbackUrl("/auth/gptrouter")
	}

	private getAuthorizeUrlBase(): string {
		const ctrl = this.requireController()
		const override = ctrl.stateManager.getGlobalSettingsKey("gptrouterOAuthAuthorizeUrl")?.trim()
		if (override) {
			return override
		}
		return `${this.getOAuthBase()}${AUTHORIZE_PATH}`
	}

	/**
	 * Opens the authorize URL in the system browser. Returns the URL (for debugging).
	 */
	async createAuthRequest(): Promise<string> {
		const ctrl = this.requireController()
		const state = crypto.randomBytes(16).toString("hex")
		ctrl.stateManager.setGlobalState("gptrouterOAuthPendingState", state)

		const redirectUri = await this.getRedirectUri()
		const clientId = this.getClientId()

		const authorizeUrl = new URL(this.getAuthorizeUrlBase())
		authorizeUrl.searchParams.set("client_id", clientId)
		authorizeUrl.searchParams.set("redirect_uri", redirectUri)
		authorizeUrl.searchParams.set("response_type", "code")
		authorizeUrl.searchParams.set("state", state)
		authorizeUrl.searchParams.set("scope", "openid profile")

		const url = authorizeUrl.toString()
		Logger.info(
			`[GPTRouter OAuth] Opening authorize URL: ${url} (oauthBase=${this.getOAuthBase()} client_id=${clientId} redirect_uri=${redirectUri})`,
		)
		await openExternal(url)
		return url
	}

	async handleCallback(code: string, state: string): Promise<void> {
		const ctrl = this.requireController()
		const pending = ctrl.stateManager.getGlobalStateKey("gptrouterOAuthPendingState")
		if (!pending || pending !== state) {
			Logger.warn(
				`[GPTRouter OAuth] State mismatch or missing: pending=${pending ? `<len=${pending.length}>` : "none"} received_state=<len=${state.length}>`,
			)
			throw new Error("Invalid or expired OAuth state. Please start login again from the extension.")
		}

		const redirectUri = await this.getRedirectUri()
		const tokenUrl = this.getTokenUrl()
		const clientId = this.getClientId()

		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: clientId,
		})

		Logger.info(
			`[GPTRouter OAuth] Token exchange request: POST ${tokenUrl} grant_type=authorization_code redirect_uri=${redirectUri} client_id=${clientId} code=<redacted len=${code.length}>`,
		)

		let data: TokenEndpointResponse
		try {
			const resp = await axios.post<TokenEndpointResponse | string>(tokenUrl, body.toString(), {
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				...getAxiosSettings(),
				validateStatus: () => true,
			})

			const headerDump = JSON.stringify(headersObjectForLog(resp.headers))
			const rawData = resp.data
			let parsedForLog: unknown = rawData
			if (typeof rawData === "string") {
				parsedForLog = { _rawBody: rawData.length > 2000 ? `${rawData.slice(0, 2000)}…(len=${rawData.length})` : rawData }
				try {
					parsedForLog = { ...JSON.parse(rawData) }
				} catch {
					// keep _rawBody wrapper
				}
			}
			const safeBody = sanitizeOAuthPayloadForLog(parsedForLog)

			Logger.info(
				`[GPTRouter OAuth] Token endpoint response: status=${resp.status} statusText=${resp.statusText ?? ""} headers=${headerDump} body=${JSON.stringify(safeBody)}`,
			)

			if (resp.status < 200 || resp.status >= 300) {
				Logger.error(`[GPTRouter OAuth] Token endpoint HTTP error status=${resp.status} body=${JSON.stringify(safeBody)}`)
				throw new Error(`Token exchange failed (${resp.status})`)
			}
			if (typeof rawData === "string") {
				try {
					data = JSON.parse(rawData) as TokenEndpointResponse
				} catch {
					throw new Error("Token response was not valid JSON")
				}
			} else if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
				data = rawData as TokenEndpointResponse
			} else {
				throw new Error("Token response body missing or invalid")
			}
		} catch (e) {
			const msg = e instanceof Error ? `${e.message}${e.stack ? `\n${e.stack}` : ""}` : String(e)
			Logger.error(`[GPTRouter OAuth] Token request failed: ${msg}`)
			throw e instanceof Error ? e : new Error(String(e))
		}

		const apiKey = data.api_key || data.access_token
		if (!apiKey) {
			throw new Error("Token response missing api_key and access_token")
		}

		const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined
		const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : undefined

		const session: GptrouterOAuthSessionStored = {
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expiresAt,
		}
		ctrl.stateManager.setSecret("gptrouterOAuthSession", JSON.stringify(session))
		ctrl.stateManager.setSecret("openAiApiKey", apiKey)

		const u = data.user
		const displayName = u?.display_name || u?.displayName || u?.name
		const email = u?.email
		const userId = u?.id || u?.sub
		ctrl.stateManager.setGlobalState("gptrouterAccountProfile", {
			userId,
			email,
			displayName,
		})
		ctrl.stateManager.setGlobalState("gptrouterOAuthPendingState", undefined)

		const gptrouterProvider: ApiProvider = "gptrouter"
		const planActSeparateModelsSetting = ctrl.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
		const currentMode = ctrl.stateManager.getGlobalSettingsKey("mode")
		const currentApiConfiguration = ctrl.stateManager.getApiConfiguration()
		const updatedConfig = { ...currentApiConfiguration }

		// Point OpenAI-compatible client at the same deployment as OAuth (works for local backend debug).
		updatedConfig.openAiBaseUrl = `${this.getOAuthBase()}/v1`

		Logger.info(
			`[GPTRouter OAuth] Login applied: userId=${userId ?? "none"} email=${email ?? "none"} displayName=${displayName ?? "none"} expiresIn=${expiresIn ?? "n/a"} openAiBaseUrl=${updatedConfig.openAiBaseUrl}`,
		)

		if (planActSeparateModelsSetting) {
			if (currentMode === "plan") {
				updatedConfig.planModeApiProvider = gptrouterProvider
			} else {
				updatedConfig.actModeApiProvider = gptrouterProvider
			}
		} else {
			updatedConfig.planModeApiProvider = gptrouterProvider
			updatedConfig.actModeApiProvider = gptrouterProvider
		}
		ctrl.stateManager.setApiConfiguration(updatedConfig)
		ctrl.stateManager.setGlobalState("welcomeViewCompleted", true)

		if (ctrl.task) {
			ctrl.task.api = buildApiHandler({ ...updatedConfig, ulid: ctrl.task.ulid }, currentMode)
		}
	}

	async logout(): Promise<void> {
		const ctrl = this.requireController()
		const hadSession = !!ctrl.stateManager.getSecretKey("gptrouterOAuthSession")
		ctrl.stateManager.setSecret("gptrouterOAuthSession", undefined)
		ctrl.stateManager.setGlobalState("gptrouterAccountProfile", undefined)
		ctrl.stateManager.setGlobalState("gptrouterOAuthPendingState", undefined)
		if (hadSession) {
			ctrl.stateManager.setSecret("openAiApiKey", undefined)
		}
	}
}
