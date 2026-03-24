import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity"
import { azureOpenAiDefaultApiVersion, ModelInfo, OpenAiCompatibleModelInfo, openAiModelInfoSaneDefaults } from "@shared/api"
import { normalizeOpenaiReasoningEffort } from "@shared/storage/types"
import { calculateApiCostOpenAI } from "@utils/cost"
import OpenAI, { AzureOpenAI } from "openai"
import type {
	ChatCompletionFunctionTool,
	ChatCompletionReasoningEffort,
	ChatCompletionTool,
} from "openai/resources/chat/completions"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { ClineStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient, fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { ApiHandler, CommonApiHandlerOptions } from "../index"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToOpenAIResponsesInput } from "../transform/openai-response-format"
import { convertToR1Format } from "../transform/r1-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"
import { handleResponsesApiStreamResponse } from "../utils/responses_api_support"

/**
 * GPT-5.x Codex：在 GPTRouter 网关上需走 Responses API（`instructions` + 结构化 `input`）。
 */
function isOpenAiCodexResponsesModel(modelId: string): boolean {
	return modelId.toLowerCase().includes("codex")
}

function mapChatToolsToResponsesTools(tools?: ChatCompletionTool[]): OpenAI.Responses.Tool[] | undefined {
	const mapped = (tools ?? [])
		.filter((tool): tool is ChatCompletionFunctionTool => tool?.type === "function")
		.map((tool) => ({
			type: "function" as const,
			name: tool.function.name,
			description: tool.function.description,
			parameters: tool.function.parameters ?? null,
			strict: tool.function.strict ?? true,
		}))
	return mapped.length ? mapped : undefined
}

interface OpenAiHandlerOptions extends CommonApiHandlerOptions {
	openAiApiKey?: string
	openAiBaseUrl?: string
	azureApiVersion?: string
	azureIdentity?: boolean
	openAiHeaders?: Record<string, string>
	openAiModelId?: string
	openAiModelInfo?: OpenAiCompatibleModelInfo
	reasoningEffort?: string
	/** 仅 GPTRouter provider：Codex 模型走 Responses API（与网关文档一致）；普通 OpenAI 兼容 provider 仍用 chat.completions */
	isGptrouterProvider?: boolean
}

export class OpenAiHandler implements ApiHandler {
	private options: OpenAiHandlerOptions
	private client: OpenAI | undefined

	constructor(options: OpenAiHandlerOptions) {
		this.options = options
	}

	private getAzureAudienceScope(baseUrl?: string): string {
		const url = baseUrl?.toLowerCase() ?? ""
		if (url.includes("azure.us")) return "https://cognitiveservices.azure.us/.default"
		if (url.includes("azure.com")) return "https://cognitiveservices.azure.com/.default"
		return "https://cognitiveservices.azure.com/.default"
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.options.openAiApiKey && !this.options.azureIdentity) {
				throw new Error("OpenAI API key or Azure Identity Authentication is required")
			}
			try {
				const baseUrl = this.options.openAiBaseUrl?.toLowerCase() ?? ""
				const isAzureDomain = baseUrl.includes("azure.com") || baseUrl.includes("azure.us")
				const externalHeaders = buildExternalBasicHeaders()
				// Azure API shape slightly differs from the core API shape...
				if (
					this.options.azureApiVersion ||
					(isAzureDomain && !this.options.openAiModelId?.toLowerCase().includes("deepseek"))
				) {
					if (this.options.azureIdentity) {
						this.client = new AzureOpenAI({
							baseURL: this.options.openAiBaseUrl,
							azureADTokenProvider: getBearerTokenProvider(
								new DefaultAzureCredential(),
								this.getAzureAudienceScope(this.options.openAiBaseUrl),
							),
							apiVersion: this.options.azureApiVersion || azureOpenAiDefaultApiVersion,
							defaultHeaders: {
								...externalHeaders,
								...this.options.openAiHeaders,
							},
							fetch,
						})
					} else {
						this.client = new AzureOpenAI({
							baseURL: this.options.openAiBaseUrl,
							apiKey: this.options.openAiApiKey,
							apiVersion: this.options.azureApiVersion || azureOpenAiDefaultApiVersion,
							defaultHeaders: {
								...externalHeaders,
								...this.options.openAiHeaders,
							},
							fetch,
						})
					}
				} else {
					this.client = createOpenAIClient({
						baseURL: this.options.openAiBaseUrl,
						apiKey: this.options.openAiApiKey,
						defaultHeaders: this.options.openAiHeaders,
					})
				}
			} catch (error: any) {
				throw new Error(`Error creating OpenAI client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: ChatCompletionTool[]): ApiStream {
		const modelId = this.options.openAiModelId ?? ""
		if (this.options.isGptrouterProvider && isOpenAiCodexResponsesModel(modelId)) {
			yield* this.createMessageViaResponsesApi(systemPrompt, messages, tools)
			return
		}

		const client = this.ensureClient()
		const isDeepseekReasoner = modelId.includes("deepseek-reasoner")
		const isR1FormatRequired = this.options.openAiModelInfo?.isR1FormatRequired ?? false
		const isReasoningModelFamily =
			["o1", "o3", "o4", "gpt-5"].some((prefix) => modelId.includes(prefix)) && !modelId.includes("chat")

		let openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]
		let temperature: number | undefined
		if (this.options.openAiModelInfo?.temperature !== undefined) {
			const tempValue = Number(this.options.openAiModelInfo.temperature)
			temperature = tempValue === 0 ? undefined : tempValue
		} else {
			temperature = openAiModelInfoSaneDefaults.temperature
		}
		let reasoningEffort: ChatCompletionReasoningEffort | undefined
		let maxTokens: number | undefined

		if (this.options.openAiModelInfo?.maxTokens && this.options.openAiModelInfo.maxTokens > 0) {
			maxTokens = Number(this.options.openAiModelInfo.maxTokens)
		} else {
			maxTokens = undefined
		}

		if (isDeepseekReasoner || isR1FormatRequired) {
			openAiMessages = convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
		}

		if (isReasoningModelFamily) {
			openAiMessages = [{ role: "developer", content: systemPrompt }, ...convertToOpenAiMessages(messages)]
			temperature = undefined // does not support temperature
			const requestedEffort = normalizeOpenaiReasoningEffort(this.options.reasoningEffort)
			reasoningEffort = requestedEffort === "none" ? undefined : (requestedEffort as ChatCompletionReasoningEffort)
		}

		const requestPayload = {
			model: modelId,
			messages: openAiMessages,
			temperature,
			max_tokens: maxTokens,
			reasoning_effort: reasoningEffort,
			stream: true,
			stream_options: { include_usage: true },
			...getOpenAIToolParams(tools),
		} as const

		// GPTRouter 调试日志（不包含 API Key）
		const baseUrlForLog = this.options.openAiBaseUrl || ""
		if (baseUrlForLog.includes("gptrouter.cn")) {
			Logger.log(
				`[GPTRouter] chat.completions request: baseURL=${baseUrlForLog} model=${modelId} hasTools=${!!tools?.length}`,
			)
			Logger.log(
				`[GPTRouter] first user message: ${messages.find((m) => m.role === "user")?.content?.slice(0, 200) || "<none>"}`,
			)
		}

		const stream = await client.chat.completions.create(requestPayload)

		const toolCallProcessor = new ToolCallProcessor()

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			if (delta && "reasoning_content" in delta && delta.reasoning_content) {
				yield {
					type: "reasoning",
					reasoning: (delta.reasoning_content as string | undefined) || "",
				}
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			if (chunk.usage) {
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
					cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
					// @ts-expect-error-next-line
					cacheWriteTokens: chunk.usage.prompt_cache_miss_tokens || 0,
				}
			}
		}
	}

	/**
	 * Codex（模型 id 含 `codex`）：使用 Responses API，与网关文档中的「结构化 input + instructions」一致。
	 */
	private async *createMessageViaResponsesApi(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: ChatCompletionTool[],
	): ApiStream {
		const client = this.ensureClient()
		const modelId = this.options.openAiModelId ?? ""
		const modelInfo = this.options.openAiModelInfo ?? openAiModelInfoSaneDefaults

		// store:false → 服务端不保留 rs_*；历史里若带回上一轮 reasoning id 会 400「Item … not found」
		const { input } = convertToOpenAIResponsesInput(messages, {
			usePreviousResponseId: false,
			omitAssistantReasoningItems: true,
		})
		const responseTools = mapChatToolsToResponsesTools(tools)

		// GPTRouter Codex：始终走 Responses API；首请求即用网关最兼容的负载（store:false、不传 reasoning），
		// 避免「先 chat/满参再降级」的体验；仅在仍失败时在同一 API 内去掉 tools 重试。
		const minimalParams: OpenAI.Responses.ResponseCreateParamsStreaming = {
			model: modelId,
			instructions: systemPrompt,
			input,
			stream: true,
			store: false,
			...(responseTools ? { tools: responseTools } : {}),
		}

		const baseUrlForLog = this.options.openAiBaseUrl || ""
		if (baseUrlForLog.includes("gptrouter.cn")) {
			Logger.log(
				`[GPTRouter] responses.create (Codex): baseURL=${baseUrlForLog} model=${modelId} hasTools=${!!tools?.length}`,
			)
			Logger.log(`[GPTRouter] responses.create (Codex) params: store=false reasoning=omitted (primary path)`)
		}

		const isRetryableResponsesError = (err: unknown) => {
			const message = String((err as any)?.message || err)
			return (
				/OperationNotSupported/i.test(message) ||
				/chatCompletion operation/i.test(message) ||
				/does not work with the specified model/i.test(message) ||
				/required following item/i.test(message)
			)
		}

		try {
			const stream = await client.responses.create(minimalParams)
			yield* handleResponsesApiStreamResponse(stream, modelInfo, async (mi, a, b, c, d) =>
				Promise.resolve(calculateApiCostOpenAI(mi, a, b, c, d)),
			)
		} catch (error: any) {
			if (!responseTools?.length || !isRetryableResponsesError(error)) {
				throw error
			}

			const message = String(error?.message || error)
			if (baseUrlForLog.includes("gptrouter.cn")) {
				Logger.warn(`[GPTRouter] Codex responses.create failed, retrying without tools.`, message)
			}

			const minimalParamsNoTools: OpenAI.Responses.ResponseCreateParamsStreaming = {
				model: modelId,
				instructions: systemPrompt,
				input,
				stream: true,
				store: false,
			}

			const stream = await client.responses.create(minimalParamsNoTools)
			yield* handleResponsesApiStreamResponse(stream, modelInfo, async (mi, a, b, c, d) =>
				Promise.resolve(calculateApiCostOpenAI(mi, a, b, c, d)),
			)
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.options.openAiModelId ?? "",
			info: this.options.openAiModelInfo ?? openAiModelInfoSaneDefaults,
		}
	}
}
