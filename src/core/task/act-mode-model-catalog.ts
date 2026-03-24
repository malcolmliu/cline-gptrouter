import type { ApiConfiguration, ApiProvider, ModelInfo } from "@shared/api"
import {
	anthropicModels,
	askSageModels,
	basetenModels,
	bedrockModels,
	cerebrasModels,
	claudeCodeModels,
	deepSeekModels,
	doubaoModels,
	fireworksModels,
	geminiModels,
	groqModels,
	huaweiCloudMaasModels,
	huggingFaceModels,
	internationalQwenModels,
	internationalZAiModels,
	mainlandQwenModels,
	mainlandZAiModels,
	minimaxModels,
	mistralModels,
	moonshotModels,
	nebiusModels,
	nousResearchModels,
	openAiCodexModels,
	openAiNativeModels,
	qwenCodeModels,
	sambanovaModels,
	sapAiCoreModels,
	vertexModels,
	xaiModels,
} from "@shared/api"
import { ensureOpenAiCompatibleModelsCached } from "@/core/controller/models/openAiCompatibleModelsCache"
import type { StateManager } from "@/core/storage/StateManager"

const CATALOG_MAX_ROWS = 85

function getStaticModelsForProvider(provider: ApiProvider, config: ApiConfiguration): Record<string, ModelInfo> | undefined {
	switch (provider) {
		case "anthropic":
			return anthropicModels
		case "claude-code":
			return claudeCodeModels
		case "bedrock":
			return bedrockModels
		case "vertex":
			return vertexModels
		case "gemini":
			return geminiModels
		case "openai-native":
			return openAiNativeModels
		case "openai-codex":
			return openAiCodexModels
		case "deepseek":
			return deepSeekModels
		case "qwen":
			return config.qwenApiLine === "china" ? mainlandQwenModels : internationalQwenModels
		case "qwen-code":
			return qwenCodeModels
		case "doubao":
			return doubaoModels
		case "mistral":
			return mistralModels
		case "asksage":
			return askSageModels
		case "xai":
			return xaiModels
		case "moonshot":
			return moonshotModels
		case "nebius":
			return nebiusModels
		case "sambanova":
			return sambanovaModels
		case "cerebras":
			return cerebrasModels
		case "groq":
			return groqModels
		case "baseten":
			return basetenModels
		case "sapaicore":
			return sapAiCoreModels
		case "huawei-cloud-maas":
			return huaweiCloudMaasModels
		case "zai":
			return config.zaiApiLine === "china" ? mainlandZAiModels : internationalZAiModels
		case "fireworks":
			return fireworksModels
		case "minimax":
			return minimaxModels
		case "huggingface":
			return huggingFaceModels
		case "nousResearch":
			return nousResearchModels
		default:
			return undefined
	}
}

function getCachedModelsForProvider(stateManager: StateManager, provider: ApiProvider): Record<string, ModelInfo> | undefined {
	switch (provider) {
		case "openrouter":
			return stateManager.getModelsCache("openRouter") ?? undefined
		case "cline":
			return stateManager.getModelsCache("cline") ?? undefined
		case "groq":
			return stateManager.getModelsCache("groq") ?? undefined
		case "baseten":
			return stateManager.getModelsCache("baseten") ?? undefined
		case "huggingface":
			return stateManager.getModelsCache("huggingFace") ?? undefined
		case "requesty":
			return stateManager.getModelsCache("requesty") ?? undefined
		case "huawei-cloud-maas":
			return stateManager.getModelsCache("huaweiCloudMaas") ?? undefined
		case "hicap":
			return stateManager.getModelsCache("hicap") ?? undefined
		case "aihubmix":
			return stateManager.getModelsCache("aihubmix") ?? undefined
		case "litellm":
			return stateManager.getModelsCache("liteLlm") ?? undefined
		case "vercel-ai-gateway":
			return stateManager.getModelsCache("vercel") ?? undefined
		case "openai":
		case "gptrouter":
			return stateManager.getModelsCache("openAi") ?? undefined
		default:
			return undefined
	}
}

function mergeModelRecords(
	staticModels: Record<string, ModelInfo> | undefined,
	cached: Record<string, ModelInfo> | undefined,
): Record<string, ModelInfo> {
	const out: Record<string, ModelInfo> = { ...staticModels, ...cached }
	return out
}

function formatModelTable(models: Record<string, ModelInfo>): string {
	const entries = Object.entries(models).map(([id, info]) => {
		const inP = info.inputPrice
		const outP = info.outputPrice
		const score =
			inP !== undefined && outP !== undefined
				? inP + outP
				: inP !== undefined
					? inP * 2
					: outP !== undefined
						? outP * 2
						: Number.POSITIVE_INFINITY
		return { id, info, score }
	})
	entries.sort((a, b) => (a.score === b.score ? a.id.localeCompare(b.id) : a.score - b.score))

	const lines: string[] = [
		"Sorted by approximate cost when pricing is known (input+output USD per 1M tokens; lower ≈ better value for light tasks).",
		"",
	]
	const slice = entries.slice(0, CATALOG_MAX_ROWS)
	for (const { id, info } of slice) {
		const inP = info.inputPrice != null ? String(info.inputPrice) : "?"
		const outP = info.outputPrice != null ? String(info.outputPrice) : "?"
		const ctx = info.contextWindow != null ? `${Math.round(info.contextWindow / 1000)}k` : "?"
		const r = info.supportsReasoning ? "yes" : "no"
		lines.push(`- \`${id}\` — $in ${inP} / $out ${outP} per 1M | ctx ~${ctx} | reasoning ${r}`)
	}
	if (entries.length > CATALOG_MAX_ROWS) {
		lines.push("")
		lines.push(
			`… ${entries.length - CATALOG_MAX_ROWS} additional models omitted; prefer lower-listed ids for easier/cheaper work.`,
		)
	}
	return lines.join("\n")
}

function formatOpenAiCompatibleFallback(config: ApiConfiguration, label: string): string {
	const id = config.actModeOpenAiModelId?.trim() || "(none selected)"
	const info = config.actModeOpenAiModelInfo
	let pricing = ""
	if (info?.inputPrice != null || info?.outputPrice != null) {
		pricing = ` Known pricing for current selection: in ${info.inputPrice ?? "?"} / out ${info.outputPrice ?? "?"} per 1M tokens.`
	}
	return [
		`${label}: model list is fetched from the gateway and is not fully expanded here.`,
		`Current Act model id: \`${id}\`.${pricing}`,
		"Model recommendation rule for planner: only recommend ids explicitly listed in this catalog block. If only current id is visible, use only that id and ask user to refresh models in Settings.",
	].join("\n")
}

/**
 * Markdown/plain text block for PLAN MODE environment_details: models the user can run in Act mode,
 * with pricing when known, so the planner can recommend cost-effective ids.
 */
export async function buildActModeModelCatalogForPlan(stateManager: StateManager): Promise<string> {
	const config = stateManager.getApiConfiguration()
	const provider = (config.actModeApiProvider ?? config.planModeApiProvider) as ApiProvider | undefined
	if (!provider) {
		return "Act mode provider is not configured; skip model recommendations until the user selects a provider."
	}

	if (provider === "openai" || provider === "gptrouter") {
		await ensureOpenAiCompatibleModelsCached(stateManager)
	}

	const staticPart = getStaticModelsForProvider(provider, config)
	const cachedPart = getCachedModelsForProvider(stateManager, provider)
	const merged = mergeModelRecords(staticPart, cachedPart)

	if (Object.keys(merged).length > 0) {
		return [`**Act execution provider:** \`${provider}\``, "", formatModelTable(merged)].join("\n")
	}

	switch (provider) {
		case "openai":
		case "gptrouter":
			return formatOpenAiCompatibleFallback(config, `**Act execution provider:** \`${provider}\` (OpenAI-compatible)`)
		case "ollama":
		case "lmstudio":
		case "vscode-lm":
		case "dify":
		case "oca":
		case "together":
			return [
				`**Act execution provider:** \`${provider}\``,
				"Local or gateway-specific catalog without bundled pricing in the extension.",
				"Label each step with **Difficulty** and recommend **recommended_model_id** only from ids explicitly listed in this section. If ids are missing, use current selected id only and ask user to refresh/select models in Settings.",
			].join("\n")
		default:
			return [
				`**Act execution provider:** \`${provider}\``,
				"No model catalog is available in-context (refresh models in Settings or use a provider with a static list).",
				"Still use **Difficulty** tags, but do not invent model ids. Ask user to refresh/select models first, then recommend from listed ids only.",
			].join("\n")
	}
}

export async function getAvailableActModeModelIds(stateManager: StateManager): Promise<Set<string>> {
	const config = stateManager.getApiConfiguration()
	const provider = (config.actModeApiProvider ?? config.planModeApiProvider) as ApiProvider | undefined
	if (!provider) {
		return new Set()
	}

	if (provider === "openai" || provider === "gptrouter") {
		await ensureOpenAiCompatibleModelsCached(stateManager)
	}

	const staticPart = getStaticModelsForProvider(provider, config)
	const cachedPart = getCachedModelsForProvider(stateManager, provider)
	const merged = mergeModelRecords(staticPart, cachedPart)
	return new Set(Object.keys(merged))
}
