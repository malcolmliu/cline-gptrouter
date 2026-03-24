import type { ModelInfo } from "@shared/api"
import { openAiModelInfoSaneDefaults } from "@shared/api"
import axios from "axios"
import type { StateManager } from "@/core/storage/StateManager"
import { getAxiosSettings } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"

/** Align with webview GPTRouterProvider pricing formula */
const USD_TO_CNY = 7.3
const BASE_PROMPT_CNY_PER_1M = 14.6
const PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const pricingCache = new Map<
	string,
	{ timestamp: number; data: Record<string, { inputUsdPer1M: number; outputUsdPer1M: number }> }
>()

type GptrouterPricingRow = {
	model_name?: string
	model_ratio?: number
	completion_ratio?: number
}

type PricingResponse = {
	success?: boolean
	group_ratio?: Record<string, number>
	data?: GptrouterPricingRow[]
}

function toNumberOrUndefined(v: unknown): number | undefined {
	const n = typeof v === "number" ? v : Number(v)
	return Number.isFinite(n) ? n : undefined
}

function cnyToUsdPer1M(cnyPer1M: number): number {
	return cnyPer1M / USD_TO_CNY
}

function normalizePricingLookupKey(name: string): string {
	return name.trim().toLowerCase()
}

/**
 * `https://host/v1` or `https://host/v1/` → `https://host/api/pricing`
 */
export function openAiV1BaseToPricingUrl(v1Base: string): string | undefined {
	try {
		const trimmed = v1Base.trim().replace(/\/$/, "")
		const root = trimmed.replace(/\/v1$/i, "")
		if (!root || root === trimmed) {
			return undefined
		}
		return `${root}/api/pricing`
	} catch {
		return undefined
	}
}

async function fetchGptrouterStylePricingMap(
	pricingUrl: string,
): Promise<Record<string, { inputUsdPer1M: number; outputUsdPer1M: number }>> {
	const map: Record<string, { inputUsdPer1M: number; outputUsdPer1M: number }> = {}
	try {
		const resp = await axios.get<PricingResponse>(pricingUrl, {
			headers: { Accept: "application/json" },
			...getAxiosSettings(),
			validateStatus: (s) => s === 200,
		})
		const rows = resp.data?.data ?? []
		const ratio = resp.data?.group_ratio?.default ?? 1

		for (const row of rows) {
			const modelName = row.model_name
			if (!modelName) {
				continue
			}
			const modelRatio = toNumberOrUndefined(row.model_ratio) ?? 1
			const completionRatio = toNumberOrUndefined(row.completion_ratio) ?? 1

			const promptCnyPer1M = ratio * modelRatio * BASE_PROMPT_CNY_PER_1M
			const completionCnyPer1M = ratio * modelRatio * completionRatio * BASE_PROMPT_CNY_PER_1M

			const key = normalizePricingLookupKey(modelName)
			map[key] = {
				inputUsdPer1M: cnyToUsdPer1M(promptCnyPer1M),
				outputUsdPer1M: cnyToUsdPer1M(completionCnyPer1M),
			}
		}
	} catch (e) {
		Logger.log(`[OpenAI-compatible models] Optional pricing fetch failed (${pricingUrl}): ${e}`)
	}
	return map
}

async function getPricingMapDailyCached(
	pricingUrl: string,
): Promise<Record<string, { inputUsdPer1M: number; outputUsdPer1M: number }>> {
	const cached = pricingCache.get(pricingUrl)
	if (cached && Date.now() - cached.timestamp < PRICING_CACHE_TTL_MS) {
		Logger.log(`[OpenAI-compatible models] Reusing cached pricing map (${pricingUrl})`)
		return cached.data
	}

	const fetched = await fetchGptrouterStylePricingMap(pricingUrl)
	pricingCache.set(pricingUrl, { timestamp: Date.now(), data: fetched })
	Logger.log(
		`[OpenAI-compatible models] Refreshed pricing map (${pricingUrl}), rows=${Object.keys(fetched).length}, ttlHours=24`,
	)
	return fetched
}

function pickInlineModelPricing(m: Record<string, unknown>): { input?: number; output?: number } {
	const inp =
		toNumberOrUndefined(m.input_price) ??
		toNumberOrUndefined(m.input_cost_per_million) ??
		toNumberOrUndefined(m.prompt_cost_per_million)
	const out =
		toNumberOrUndefined(m.output_price) ??
		toNumberOrUndefined(m.output_cost_per_million) ??
		toNumberOrUndefined(m.completion_cost_per_million)
	return { input: inp, output: out }
}

/**
 * Fetches GET {baseUrl}/models (OpenAI-compatible), optionally merges GPTRouter-style /api/pricing and inline model prices.
 */
export async function fetchOpenAiCompatibleModelCatalog(
	baseUrl: string,
	apiKey: string | undefined,
): Promise<{ modelIds: string[]; catalog: Record<string, ModelInfo> }> {
	if (!baseUrl?.trim() || !URL.canParse(baseUrl.trim())) {
		return { modelIds: [], catalog: {} }
	}

	const trimmedBase = baseUrl.trim().replace(/\/$/, "")

	const url = `${trimmedBase}/models`
	const response = await axios.get<{ data?: Array<Record<string, unknown> & { id?: string }> }>(url, {
		...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
		...getAxiosSettings(),
	})

	const rawList = Array.isArray(response.data?.data) ? response.data!.data! : []
	const modelIds = [...new Set(rawList.map((m) => (typeof m.id === "string" ? m.id : "")).filter(Boolean))]

	const pricingUrl = openAiV1BaseToPricingUrl(trimmedBase)
	const pricingMap = pricingUrl ? await getPricingMapDailyCached(pricingUrl) : {}

	const catalog: Record<string, ModelInfo> = {}
	for (const m of rawList) {
		const id = typeof m.id === "string" ? m.id : ""
		if (!id) {
			continue
		}
		const fromRow = pickInlineModelPricing(m)
		const fromTable = pricingMap[normalizePricingLookupKey(id)]
		const inputPrice = fromRow.input ?? fromTable?.inputUsdPer1M
		const outputPrice = fromRow.output ?? fromTable?.outputUsdPer1M

		catalog[id] = {
			...openAiModelInfoSaneDefaults,
			inputPrice: inputPrice ?? openAiModelInfoSaneDefaults.inputPrice,
			outputPrice: outputPrice ?? openAiModelInfoSaneDefaults.outputPrice,
			supportsReasoning: /r1|reasoning|o1|o3|o4|think/i.test(id),
		}
	}

	Logger.log(
		`[OpenAI-compatible models] Cached ${modelIds.length} models (pricing rows from API: ${Object.keys(pricingMap).length})`,
	)
	return { modelIds, catalog }
}

/**
 * Refreshes in-memory openAi model cache when empty/expired (Plan mode catalog, etc.).
 */
export async function ensureOpenAiCompatibleModelsCached(stateManager: StateManager): Promise<void> {
	const cached = stateManager.getModelsCache("openAi")
	if (cached && Object.keys(cached).length > 0) {
		return
	}

	const config = stateManager.getApiConfiguration()
	const baseUrl = config.openAiBaseUrl?.trim()
	if (!baseUrl) {
		return
	}

	const apiKey = stateManager.getSecretKey("openAiApiKey")?.trim()
	try {
		const { catalog } = await fetchOpenAiCompatibleModelCatalog(baseUrl, apiKey)
		if (Object.keys(catalog).length > 0) {
			stateManager.setModelsCache("openAi", catalog)
		}
	} catch (e) {
		Logger.log(`[OpenAI-compatible models] ensureOpenAiCompatibleModelsCached failed: ${e}`)
	}
}
