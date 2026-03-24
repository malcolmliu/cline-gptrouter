import { createContext, type ReactNode, useContext, useMemo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { createTranslator, type TranslateFn } from "./createTranslator"
import { DEFAULT_UI_LOCALE, resolveUiLocale, type UiLocale } from "./resolveLocale"

export type I18nContextValue = {
	t: TranslateFn
	locale: UiLocale
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined)

/**
 * UI strings for the webview. Locale order:
 * 1. Extension state `vscodeUiLocale` (from VS Code `env.language` when available)
 * 2. `navigator.language` in the webview
 * 3. English for any unsupported language code
 */
export function I18nProvider({ children }: { children: ReactNode }) {
	const { vscodeUiLocale } = useExtensionState()

	const locale = useMemo(() => {
		const raw =
			vscodeUiLocale?.trim() || (typeof navigator !== "undefined" && navigator.language ? navigator.language : undefined)
		return resolveUiLocale(raw)
	}, [vscodeUiLocale])

	const value = useMemo((): I18nContextValue => {
		return {
			t: createTranslator(locale),
			locale,
		}
	}, [locale])

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
	const ctx = useContext(I18nContext)
	if (!ctx) {
		// Safe fallback if a component renders outside the provider (e.g. isolated test)
		return {
			t: createTranslator(DEFAULT_UI_LOCALE),
			locale: DEFAULT_UI_LOCALE,
		}
	}
	return ctx
}
