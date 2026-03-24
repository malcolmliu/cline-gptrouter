/**
 * Bundled UI locales. Add a new JSON under `messages/` and extend this union + `bundles` in `createTranslator.ts`.
 */
export type UiLocale = "en" | "ja" | "ko" | "zh-CN"

export const DEFAULT_UI_LOCALE: UiLocale = "en"

/**
 * Map VS Code / browser BCP-47 tags (e.g. zh-cn, ja, ko-kr) to a bundled locale.
 * Unknown languages fall back to English.
 */
export function resolveUiLocale(raw?: string): UiLocale {
	if (!raw || typeof raw !== "string") {
		return DEFAULT_UI_LOCALE
	}
	const tag = raw.toLowerCase().replace(/_/g, "-")

	if (tag.startsWith("zh")) {
		return "zh-CN"
	}
	if (tag.startsWith("ja")) {
		return "ja"
	}
	if (tag.startsWith("ko")) {
		return "ko"
	}
	if (tag.startsWith("en")) {
		return "en"
	}
	return DEFAULT_UI_LOCALE
}
