import { StringArray } from "@shared/proto/cline/common"
import { OpenAiModelsRequest } from "@shared/proto/cline/models"
import type { AxiosError, AxiosRequestConfig } from "axios"
import axios from "axios"
import { HostProvider } from "@/hosts/host-provider"
import { getAxiosSettings } from "@/shared/net"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Fetches available models from the OpenAI API
 * @param controller The controller instance
 * @param request Request containing the base URL and API key
 * @returns Array of model names
 */
export async function refreshOpenAiModels(_controller: Controller, request: OpenAiModelsRequest): Promise<StringArray> {
	try {
		if (!request.baseUrl) {
			return StringArray.create({ values: [] })
		}

		if (!URL.canParse(request.baseUrl)) {
			return StringArray.create({ values: [] })
		}

		const config: AxiosRequestConfig = {}
		if (request.apiKey) {
			config["headers"] = { Authorization: `Bearer ${request.apiKey}` }
		}

		const url = `${request.baseUrl}/models`
		Logger.log(`[GPTRouter] Fetching models from: ${url}`)

		const response = await axios.get(url, { ...config, ...getAxiosSettings() })
		Logger.log(
			`[GPTRouter] /models response status=${response.status} modelsCount=${
				Array.isArray(response.data?.data) ? response.data.data.length : "n/a"
			}`,
		)

		const modelsArray = response.data?.data?.map((model: any) => model.id) || []
		const models = [...new Set<string>(modelsArray)]

		Logger.log(`[GPTRouter] Parsed model ids: ${models.join(", ")}`)
		return StringArray.create({ values: models })
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
