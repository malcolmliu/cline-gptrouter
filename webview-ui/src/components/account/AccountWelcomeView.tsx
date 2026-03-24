import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AccountServiceClient } from "@/services/grpc-client"
import ClineLogoVariable from "../../assets/ClineLogoVariable"

// export const AccountWelcomeView = () => (
// 	<div className="flex flex-col items-center pr-3 gap-2.5">
// 		<ClineLogoWhite className="size-16 mb-4" />
export const AccountWelcomeView = () => {
	const { environment } = useExtensionState()
	const [isLoginLoading, setIsLoginLoading] = useState(false)

	const handleSignIn = async () => {
		try {
			setIsLoginLoading(true)
			await AccountServiceClient.gptrouterOauthLoginClicked({})
		} finally {
			setIsLoginLoading(false)
		}
	}

	return (
		<div className="flex flex-col items-center gap-2.5">
			<ClineLogoVariable className="size-16 mb-4" environment={environment} />

			<p>Log in with GPTRouter to access the latest models and enable account-based features.</p>

			<VSCodeButton className="w-full mb-4" disabled={isLoginLoading} onClick={handleSignIn}>
				Login with GPTRouter
				{isLoginLoading && (
					<span className="ml-1 animate-spin">
						<span className="codicon codicon-refresh" />
					</span>
				)}
			</VSCodeButton>

			<p className="text-(--vscode-descriptionForeground) text-xs text-center m-0">
				By continuing, you agree to GPTRouter <VSCodeLink href="https://gptrouter.cn/terms">Terms of Service</VSCodeLink>{" "}
				and <VSCodeLink href="https://gptrouter.cn/privacy">Privacy Policy.</VSCodeLink>
			</p>
		</div>
	)
}
