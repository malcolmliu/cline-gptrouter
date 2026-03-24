# Webview UI translations

- **Source strings:** `messages/en.json` (also the fallback when a key is missing in other locales).
- **Locales:** `en`, `ja`, `ko`, `zh-CN` — add a file under `messages/` and register it in `createTranslator.ts` and `resolveLocale.ts`.
- **Runtime locale:** VS Code `env.language` is sent as `vscodeUiLocale` in extension state. If missing, the webview uses `navigator.language`. Unsupported codes fall back to **English**.

## TOML

This project uses **JSON** for nested keys and Vite bundling. To generate TOML for external tools, convert with a script (e.g. `json2toml`) or keep JSON as the source of truth.

## Adding strings

1. Add the key to `en.json`.
2. Mirror the key in `ja.json`, `ko.json`, `zh-CN.json` (or leave missing to fall back to English).
3. Use `const { t } = useI18n()` and `t("some.path")` or `t("some.path", { name: "x" })` for `{name}` placeholders.

Gradually replace hard-coded English in components with `t(...)`.
