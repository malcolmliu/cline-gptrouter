import { StringArray } from "@shared/proto/cline/common"
import { OpenAiModelsRequest } from "@shared/proto/cline/models"
import type { AxiosError } from "axios"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { fetchOpenAiCompatibleModelCatalog } from "./openAiCompatibleModelsCache"

/**
 * Fetches available models from the OpenAI-compatible API and caches {@link ModelInfo} (including GPTRouter-style /api/pricing when available).
 */
export async function refreshOpenAiModels(controller: Controller, request: OpenAiModelsRequest): Promise<StringArray> {
	try {
		if (!request.baseUrl) {
			return StringArray.create({ values: [] })
		}

		if (!URL.canParse(request.baseUrl)) {
			return StringArray.create({ values: [] })
		}

		const { modelIds, catalog } = await fetchOpenAiCompatibleModelCatalog(
			request.baseUrl,
			request.apiKey?.trim() || undefined,
		)

		if (Object.keys(catalog).length > 0) {
			controller.stateManager.setModelsCache("openAi", catalog)
		}

		Logger.log(`[GPTRouter] refreshOpenAiModels: ${modelIds.length} ids, catalog entries ${Object.keys(catalog).length}`)
		return StringArray.create({ values: modelIds })
	} catch (error) {
		const axiosError = error as AxiosError<any>
		const status = axiosError?.response?.status

		if (status === 401) {
			Logger.error("Error fetching OpenAI models (GPTRouter): unauthorized (401). Check API key.")
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "GPTRouter: 模型列表请求返回 401，请检查 API Key 是否正确。",
			})
		} else {
			Logger.error("Error fetching OpenAI models (GPTRouter):", error)
		}

		return StringArray.create({ values: [] })
	}
}
