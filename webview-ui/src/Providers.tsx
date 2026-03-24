import { HeroUIProvider } from "@heroui/react"
import { type ReactNode } from "react"
import { CustomPostHogProvider } from "./CustomPostHogProvider"
import { ClineAuthProvider } from "./context/ClineAuthContext"
import { ExtensionStateContextProvider } from "./context/ExtensionStateContext"
import { PlatformProvider } from "./context/PlatformContext"
import { I18nProvider } from "./i18n/I18nContext"

export function Providers({ children }: { children: ReactNode }) {
	return (
		<PlatformProvider>
			<ExtensionStateContextProvider>
				<I18nProvider>
					<CustomPostHogProvider>
						<ClineAuthProvider>
							<HeroUIProvider>{children}</HeroUIProvider>
						</ClineAuthProvider>
					</CustomPostHogProvider>
				</I18nProvider>
			</ExtensionStateContextProvider>
		</PlatformProvider>
	)
}
