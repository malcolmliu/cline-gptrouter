import en from "./messages/en.json"
import ja from "./messages/ja.json"
import ko from "./messages/ko.json"
import zhCN from "./messages/zh-CN.json"
import type { UiLocale } from "./resolveLocale"

const bundles = {
	en: en as Record<string, unknown>,
	ja: ja as Record<string, unknown>,
	ko: ko as Record<string, unknown>,
	"zh-CN": zhCN as Record<string, unknown>,
} satisfies Record<UiLocale, Record<string, unknown>>

function getByPath(obj: unknown, path: string): string | undefined {
	const parts = path.split(".")
	let cur: unknown = obj
	for (const p of parts) {
		if (cur == null || typeof cur !== "object") {
			return undefined
		}
		cur = (cur as Record<string, unknown>)[p]
	}
	return typeof cur === "string" ? cur : undefined
}

function applyVars(template: string, vars?: Record<string, string | number>): string {
	if (!vars) {
		return template
	}
	return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
}

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string

export function createTranslator(locale: UiLocale): TranslateFn {
	const primary = bundles[locale]
	const fallback = bundles.en
	return (key: string, vars?: Record<string, string | number>) => {
		const raw = getByPath(primary, key) ?? getByPath(fallback, key) ?? key
		return applyVars(raw, vars)
	}
}
