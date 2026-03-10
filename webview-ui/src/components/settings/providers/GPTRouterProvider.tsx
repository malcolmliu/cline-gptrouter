import { openAiModelInfoSaneDefaults } from "@shared/api"
import { OpenAiModelsRequest } from "@shared/proto/cline/models"
import { Mode } from "@shared/storage/types"
import { VSCodeButton, VSCodeCheckbox, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
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

export const GPTRouterProvider = ({ showModelOptions, isPopup, currentMode }: GPTRouterProviderProps) => {
	const { apiConfiguration, remoteConfigSettings } = useExtensionState()
	const { handleFieldChange, handleModeFieldChange } = useApiConfigurationHandlers()

	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)
	const showReasoningEffort = supportsReasoningEffortForModelId(selectedModelId, true)
	const { openAiModelInfo } = getModeSpecificFields(apiConfiguration, currentMode)

	const [modelConfigurationSelected, setModelConfigurationSelected] = useState(false)
	const [availableModels, setAvailableModels] = useState<string[]>([])

	const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

	useEffect(() => {
		return () => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current)
			}
		}
	}, [])

	const debouncedRefreshModels = useCallback((apiKey?: string) => {
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current)
		}

		if (apiKey) {
			debounceTimerRef.current = setTimeout(() => {
				ModelsServiceClient.refreshOpenAiModels(
					OpenAiModelsRequest.create({
						baseUrl: GPTR_OUTER_BASE_URL,
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
	}, [])

	// Ensure base URL is always set to GPTRouter in configuration
	useEffect(() => {
		if (apiConfiguration?.openAiBaseUrl !== GPTR_OUTER_BASE_URL) {
			handleFieldChange("openAiBaseUrl", GPTR_OUTER_BASE_URL)
		}
	}, [apiConfiguration?.openAiBaseUrl, handleFieldChange])

	// 初次挂载时，如果已经有 key，自动拉一次模型列表
	useEffect(() => {
		if (apiConfiguration?.openAiApiKey) {
			debouncedRefreshModels(apiConfiguration.openAiApiKey)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const sortedModels = useMemo(() => {
		return [...availableModels].sort((a, b) => a.localeCompare(b)).slice(0, 200)
	}, [availableModels])

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
					value={GPTR_OUTER_BASE_URL}
				/>
			</div>

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
					className="w-full"
					id="gptrouter-model-id"
					onChange={(e: any) => {
						const value = e.target?.value ?? ""
						handleModeFieldChange({ plan: "planModeOpenAiModelId", act: "actModeOpenAiModelId" }, value, currentMode)
					}}
					value={selectedModelId || ""}>
					<VSCodeOption value="">{availableModels.length ? "Select a model..." : "No models loaded"}</VSCodeOption>
					{sortedModels.map((id) => (
						<VSCodeOption key={id} value={id}>
							{id}
						</VSCodeOption>
					))}
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
