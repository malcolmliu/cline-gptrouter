import { openAiModelInfoSaneDefaults } from "@shared/api"
import { OpenAiModelsRequest } from "@shared/proto/cline/models"
import { Mode } from "@shared/storage/types"
import { VSCodeButton, VSCodeCheckbox, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AccountServiceClient, ModelsServiceClient } from "@/services/grpc-client"
import { getAsVar, VSC_DESCRIPTION_FOREGROUND } from "@/utils/vscStyles"
import { ApiKeyField } from "../common/ApiKeyField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelInfoView } from "../common/ModelInfoView"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import { getModeSpecificFields, normalizeApiConfiguration, supportsReasoningEffortForModelId } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

interface GPTRouterProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

const GPTR_OUTER_BASE_URL = "https://gptrouter.cn/v1"
const GPTR_PRICING_URL = "https://gptrouter.cn/api/pricing"
const USD_TO_CNY = 7.3
const BASE_PROMPT_CNY_PER_1M = 14.6 // 按 pricing 页面公式：ratio=1, model_ratio=1 时 Prompt ¥14.6 / 1M tokens

type GptrouterPricingRow = {
	model_name: string
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

/** 定价表 model_name 与 /v1/models 的 id 大小写常不一致，统一用小写做 key */
function normalizePricingLookupKey(name: string): string {
	return name.trim().toLowerCase()
}

export const GPTRouterProvider = ({ showModelOptions, isPopup, currentMode }: GPTRouterProviderProps) => {
	const { apiConfiguration, remoteConfigSettings, gptrouterAccountProfile } = useExtensionState()
	const { handleFieldChange, handleModeFieldChange, handleModeFieldsChange } = useApiConfigurationHandlers()

	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)
	const showReasoningEffort = supportsReasoningEffortForModelId(selectedModelId, true)
	const { openAiModelInfo } = getModeSpecificFields(apiConfiguration, currentMode)

	const [modelConfigurationSelected, setModelConfigurationSelected] = useState(false)
	const [availableModels, setAvailableModels] = useState<string[]>([])
	/** key 为 normalizePricingLookupKey(model_name)，与 models 列表里的 id 用小写对齐 */
	const [pricingMap, setPricingMap] = useState<Record<string, { inputUsdPer1M: number; outputUsdPer1M: number }>>({})
	const [pricingError, setPricingError] = useState<string | null>(null)
	const [oauthBusy, setOauthBusy] = useState(false)
	const [showOAuthDebug, setShowOAuthDebug] = useState(false)

	const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

	const openAiV1Base = useMemo(() => {
		const oauthBase = apiConfiguration?.gptrouterOAuthBaseUrl?.trim().replace(/\/$/, "")
		return oauthBase ? `${oauthBase}/v1` : GPTR_OUTER_BASE_URL
	}, [apiConfiguration?.gptrouterOAuthBaseUrl])

	useEffect(() => {
		return () => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current)
			}
		}
	}, [])

	const debouncedRefreshModels = useCallback(
		(apiKey?: string) => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current)
			}

			if (apiKey) {
				debounceTimerRef.current = setTimeout(() => {
					ModelsServiceClient.refreshOpenAiModels(
						OpenAiModelsRequest.create({
							baseUrl: openAiV1Base,
							apiKey,
						}),
					)
						.then((resp) => {
							setAvailableModels(resp.values ?? [])
						})
						.catch((error) => {
							console.error("Failed to refresh GPTRouter models:", error)
							setAvailableModels([])
						})
				}, 500)
			} else {
				setAvailableModels([])
			}
		},
		[openAiV1Base],
	)

	// 读取 gptrouter 价格表（公开 JSON）
	const fetchPricing = useCallback(async () => {
		try {
			setPricingError(null)
			const resp = await fetch(GPTR_PRICING_URL, {
				method: "GET",
				headers: { Accept: "application/json" },
			})
			if (!resp.ok) {
				setPricingError(`Pricing fetch failed (${resp.status})`)
				setPricingMap({})
				return
			}
			const json = (await resp.json()) as PricingResponse
			const rows = json.data ?? []
			const ratio = json.group_ratio?.default ?? 1

			const map: Record<string, { inputUsdPer1M: number; outputUsdPer1M: number }> = {}
			for (const row of rows) {
				const modelName = row.model_name
				if (!modelName) continue
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

			setPricingMap(map)
		} catch (e) {
			console.error("Failed to fetch GPTRouter pricing:", e)
			setPricingError("Pricing fetch failed")
			setPricingMap({})
		}
	}, [])

	// OpenAI-compatible API base: production default, or `{gptrouterOAuthBaseUrl}/v1` when debugging local backend
	useEffect(() => {
		if (apiConfiguration?.openAiBaseUrl !== openAiV1Base) {
			void handleFieldChange("openAiBaseUrl", openAiV1Base)
		}
	}, [apiConfiguration?.openAiBaseUrl, openAiV1Base, handleFieldChange])

	// 启动/切换 GPTRouter key 时，拉一次 pricing + models
	useEffect(() => {
		void fetchPricing()
		if (apiConfiguration?.openAiApiKey) {
			debouncedRefreshModels(apiConfiguration.openAiApiKey)
		}
	}, [apiConfiguration?.openAiApiKey, fetchPricing, debouncedRefreshModels, openAiV1Base])

	// 每 4 小时刷新一次 pricing + model list，避免用户一直不关 VS Code 导致数据过期
	useEffect(() => {
		const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
		const timer = setInterval(() => {
			void fetchPricing()
			if (apiConfiguration?.openAiApiKey) {
				debouncedRefreshModels(apiConfiguration.openAiApiKey)
			}
		}, FOUR_HOURS_MS)
		return () => clearInterval(timer)
	}, [apiConfiguration?.openAiApiKey, fetchPricing, debouncedRefreshModels, openAiV1Base])

	const sortedModels = useMemo(() => {
		return [...availableModels].sort((a, b) => a.localeCompare(b)).slice(0, 200)
	}, [availableModels])

	// pricingMap 是异步加载的：如果模型已选中但价格晚于模型加载到达，需要自动把当前模型价格回填到 openAiModelInfo
	// 否则会沿用默认单价，导致成本显示偏高。
	useEffect(() => {
		if (!selectedModelId) {
			return
		}
		const price = pricingMap[normalizePricingLookupKey(selectedModelId)]
		if (!price) {
			return
		}

		const currentInputPrice = openAiModelInfo?.inputPrice
		const currentOutputPrice = openAiModelInfo?.outputPrice
		if (currentInputPrice === price.inputUsdPer1M && currentOutputPrice === price.outputUsdPer1M) {
			return
		}

		const nextInfo = openAiModelInfo ? { ...openAiModelInfo } : { ...openAiModelInfoSaneDefaults }
		nextInfo.inputPrice = price.inputUsdPer1M
		nextInfo.outputPrice = price.outputUsdPer1M
		void handleModeFieldChange({ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" }, nextInfo, currentMode)
	}, [selectedModelId, pricingMap, openAiModelInfo, currentMode, handleModeFieldChange])

	const onGptrouterLogin = useCallback(async () => {
		setOauthBusy(true)
		try {
			await AccountServiceClient.gptrouterOauthLoginClicked({})
		} catch (e) {
			console.error("GPTRouter OAuth login failed:", e)
		} finally {
			setOauthBusy(false)
		}
	}, [])

	const onGptrouterLogout = useCallback(async () => {
		setOauthBusy(true)
		try {
			await AccountServiceClient.gptrouterOauthLogoutClicked({})
		} catch (e) {
			console.error("GPTRouter OAuth logout failed:", e)
		} finally {
			setOauthBusy(false)
		}
	}, [])

	return (
		<div>
			<div className="mb-2.5">
				<div className="flex items-center gap-2 mb-1">
					<span style={{ fontWeight: 500 }}>Base URL</span>
					<i className="codicon codicon-lock text-description text-sm" />
				</div>
				<VSCodeTextField
					placeholder={GPTR_OUTER_BASE_URL}
					readOnly
					style={{ width: "100%", marginBottom: 10 }}
					value={openAiV1Base}
				/>
			</div>

			<div className="mb-3 rounded border border-[var(--vscode-widget-border)] p-3 space-y-2">
				<div style={{ fontWeight: 600 }}>GPTRouter 账号（浏览器登录）</div>
				{gptrouterAccountProfile?.displayName || gptrouterAccountProfile?.email ? (
					<p className="text-sm m-0 text-[var(--vscode-descriptionForeground)]">
						{gptrouterAccountProfile.displayName && (
							<span>
								用户：<strong>{gptrouterAccountProfile.displayName}</strong>
								<br />
							</span>
						)}
						{gptrouterAccountProfile.email && (
							<span>
								邮箱：{gptrouterAccountProfile.email}
								<br />
							</span>
						)}
						{gptrouterAccountProfile.userId && <span>ID：{gptrouterAccountProfile.userId}</span>}
					</p>
				) : (
					<p className="text-sm m-0 text-[var(--vscode-descriptionForeground)]">尚未通过 OAuth 登录</p>
				)}
				<div className="flex flex-wrap gap-2">
					<VSCodeButton disabled={oauthBusy} onClick={() => void onGptrouterLogin()}>
						{oauthBusy ? "处理中…" : "在浏览器登录"}
					</VSCodeButton>
					<VSCodeButton appearance="secondary" disabled={oauthBusy} onClick={() => void onGptrouterLogout()}>
						退出 OAuth 会话
					</VSCodeButton>
				</div>
				<p className="text-xs m-0 text-[var(--vscode-descriptionForeground)]">
					登录成功后扩展会用授权码向你的后端换 token，并写入 API Key；调试用可在下方填写自建 OAuth 根地址与 token URL。
				</p>
			</div>

			<div
				className="mb-2 cursor-pointer select-none text-[var(--vscode-descriptionForeground)] text-sm"
				onClick={() => setShowOAuthDebug((v) => !v)}
				onKeyDown={(e) => e.key === "Enter" && setShowOAuthDebug((v) => !v)}
				role="button"
				tabIndex={0}>
				<span className={`codicon ${showOAuthDebug ? "codicon-chevron-down" : "codicon-chevron-right"} mr-1`} />
				OAuth / 本地后端调试（可选）
			</div>
			{showOAuthDebug ? (
				<div className="mb-3 space-y-2">
					<DebouncedTextField
						initialValue={apiConfiguration?.gptrouterOAuthBaseUrl ?? ""}
						key={`gptrouter-oauth-base-${apiConfiguration?.gptrouterOAuthBaseUrl ?? ""}`}
						onChange={(v) => void handleFieldChange("gptrouterOAuthBaseUrl", v || undefined)}
						placeholder="https://gptrouter.cn 或 http://localhost:3000"
						style={{ width: "100%" }}
						type="text">
						<span className="text-sm font-medium">OAuth 根地址（空则 https://gptrouter.cn）</span>
					</DebouncedTextField>
					<DebouncedTextField
						initialValue={apiConfiguration?.gptrouterOAuthTokenUrl ?? ""}
						key={`gptrouter-oauth-token-${apiConfiguration?.gptrouterOAuthTokenUrl ?? ""}`}
						onChange={(v) => void handleFieldChange("gptrouterOAuthTokenUrl", v || undefined)}
						placeholder="http://localhost:3000/oauth/token"
						style={{ width: "100%" }}
						type="text">
						<span className="text-sm font-medium">Token URL（空则 {"{根地址}/oauth/token"}）</span>
					</DebouncedTextField>
					<DebouncedTextField
						initialValue={apiConfiguration?.gptrouterOAuthClientId ?? ""}
						key={`gptrouter-oauth-client-${apiConfiguration?.gptrouterOAuthClientId ?? ""}`}
						onChange={(v) => void handleFieldChange("gptrouterOAuthClientId", v || undefined)}
						placeholder="与后端注册的 client_id 一致"
						style={{ width: "100%" }}
						type="text">
						<span className="text-sm font-medium">client_id（空则扩展默认值）</span>
					</DebouncedTextField>
					<DebouncedTextField
						initialValue={apiConfiguration?.gptrouterOAuthAuthorizeUrl ?? ""}
						key={`gptrouter-oauth-authorize-${apiConfiguration?.gptrouterOAuthAuthorizeUrl ?? ""}`}
						onChange={(v) => void handleFieldChange("gptrouterOAuthAuthorizeUrl", v || undefined)}
						placeholder="http://localhost:3000/oauth/authorize"
						style={{ width: "100%" }}
						type="text">
						<span className="text-sm font-medium">Login URL 覆盖（空则 {"{根地址}/oauth/authorize"}）</span>
					</DebouncedTextField>
					<DebouncedTextField
						initialValue={apiConfiguration?.gptrouterOAuthRedirectUri ?? ""}
						key={`gptrouter-oauth-redirect-${apiConfiguration?.gptrouterOAuthRedirectUri ?? ""}`}
						onChange={(v) => void handleFieldChange("gptrouterOAuthRedirectUri", v || undefined)}
						placeholder="vscode://cline-gptrouter.claude-dev/auth/gptrouter"
						style={{ width: "100%" }}
						type="text">
						<span className="text-sm font-medium">Callback redirect_uri 覆盖（debug）</span>
					</DebouncedTextField>
				</div>
			) : null}

			<ApiKeyField
				initialValue={apiConfiguration?.openAiApiKey || ""}
				onChange={(value) => {
					handleFieldChange("openAiApiKey", value)
					debouncedRefreshModels(value)
				}}
				providerName="GPTRouter"
			/>

			<div style={{ marginBottom: 10 }}>
				<label htmlFor="gptrouter-model-id">
					<span style={{ fontWeight: 500 }}>Model ID</span>
				</label>
				<VSCodeDropdown
					// 仅随 Plan/Act 切换挂载实例；不要把 selectedModelId 放进 key，否则每次选择都会 remount，选中会闪回默认。
					className="w-full"
					id="gptrouter-model-id"
					key={`gptrouter-model-dropdown-${currentMode}`}
					onChange={(e: any) => {
						const value = e.target?.value ?? ""
						const nextInfo = openAiModelInfo ? { ...openAiModelInfo } : { ...openAiModelInfoSaneDefaults }
						if (value) {
							const price = pricingMap[normalizePricingLookupKey(value)]
							if (price) {
								nextInfo.inputPrice = price.inputUsdPer1M
								nextInfo.outputPrice = price.outputUsdPer1M
							} else {
								nextInfo.inputPrice = undefined
								nextInfo.outputPrice = undefined
							}
						} else {
							nextInfo.inputPrice = undefined
							nextInfo.outputPrice = undefined
						}
						// 必须一次更新 modelId + modelInfo：连续两次 handleModeFieldChange 会基于旧 apiConfiguration 互相覆盖，导致 modelId 被刷掉
						void handleModeFieldsChange(
							{
								openAiModelId: { plan: "planModeOpenAiModelId", act: "actModeOpenAiModelId" },
								openAiModelInfo: { plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
							},
							{ openAiModelId: value, openAiModelInfo: nextInfo },
							currentMode,
						)
					}}
					value={selectedModelId || ""}>
					<VSCodeOption value="">
						{availableModels.length
							? "Select a model..."
							: pricingError
								? `No models loaded (${pricingError})`
								: "No models loaded"}
					</VSCodeOption>
					{sortedModels.map((id) => {
						const price = pricingMap[normalizePricingLookupKey(id)]
						return (
							<VSCodeOption key={id} value={id}>
								{price
									? `${id} (in $${price.inputUsdPer1M.toFixed(2)}/1M, out $${price.outputUsdPer1M.toFixed(2)}/1M)`
									: id}
							</VSCodeOption>
						)
					})}
				</VSCodeDropdown>
			</div>

			{remoteConfigSettings?.openAiHeaders !== undefined ? (
				<Tooltip>
					<TooltipTrigger>
						<VSCodeButton disabled style={{ width: "100%", marginBottom: 10 }}>
							Custom Headers managed by remote config
						</VSCodeButton>
					</TooltipTrigger>
					<TooltipContent>This setting is managed by your organization's remote configuration</TooltipContent>
				</Tooltip>
			) : null}

			<div
				onClick={() => setModelConfigurationSelected((val) => !val)}
				style={{
					color: getAsVar(VSC_DESCRIPTION_FOREGROUND),
					display: "flex",
					margin: "10px 0",
					cursor: "pointer",
					alignItems: "center",
				}}>
				<span
					className={`codicon ${modelConfigurationSelected ? "codicon-chevron-down" : "codicon-chevron-right"}`}
					style={{
						marginRight: "4px",
					}}
				/>
				<span
					style={{
						fontWeight: 700,
						textTransform: "uppercase",
					}}>
					Model Configuration
				</span>
			</div>

			{modelConfigurationSelected && (
				<>
					<VSCodeCheckbox
						checked={!!openAiModelInfo?.supportsImages}
						onChange={(e: any) => {
							const isChecked = e.target.checked === true
							const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
							modelInfo.supportsImages = isChecked
							handleModeFieldChange(
								{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
								modelInfo,
								currentMode,
							)
						}}>
						Supports Images
					</VSCodeCheckbox>

					<div style={{ display: "flex", gap: 10, marginTop: "5px" }}>
						<DebouncedTextField
							initialValue={
								openAiModelInfo?.contextWindow
									? openAiModelInfo.contextWindow.toString()
									: (openAiModelInfoSaneDefaults.contextWindow?.toString() ?? "")
							}
							onChange={(value) => {
								const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
								modelInfo.contextWindow = Number(value)
								handleModeFieldChange(
									{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
									modelInfo,
									currentMode,
								)
							}}
							style={{ flex: 1 }}>
							<span style={{ fontWeight: 500 }}>Context Window Size</span>
						</DebouncedTextField>

						<DebouncedTextField
							initialValue={
								openAiModelInfo?.maxTokens
									? openAiModelInfo.maxTokens.toString()
									: (openAiModelInfoSaneDefaults.maxTokens?.toString() ?? "")
							}
							onChange={(value) => {
								const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
								modelInfo.maxTokens = Number(value)
								handleModeFieldChange(
									{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
									modelInfo,
									currentMode,
								)
							}}
							style={{ flex: 1 }}>
							<span style={{ fontWeight: 500 }}>Max Output Tokens</span>
						</DebouncedTextField>
					</div>
				</>
			)}

			{showModelOptions && (
				<>
					{showReasoningEffort && <ReasoningEffortSelector currentMode={currentMode} />}
					<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo} selectedModelId={selectedModelId} />
				</>
			)}
		</div>
	)
}
