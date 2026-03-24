# GPTRouter OAuth — 与 cline-gptrouter 扩展对接说明

本文供 **后端工程师** 与扩展侧对齐：浏览器授权、重定向回 IDE、以及 **用授权码换 token**。

## 1. 授权入口（浏览器）

扩展会打开：

`GET {oauth_base}/oauth/authorize?client_id=...&redirect_uri=...&response_type=code&state=...&scope=openid%20profile`

- **`oauth_base`**：生产默认 `https://gptrouter.cn`；用户可在设置里改为 `http://localhost:3000` 等用于联调。
- **`client_id`**：默认 `cline-gptrouter-vscode`，可在设置里覆盖；须在后端注册为合法客户端。
- **`state`**：扩展生成的随机串，与回调带回的 `state` 必须一致。
- **`redirect_uri`**：须与注册客户端时填写的回调完全一致（见下节）。

## 2. 授权完成 — 重定向回 VS Code / Cursor

桌面端扩展使用的回调由宿主生成，形如：

`{scheme}://cline-gptrouter.claude-dev/auth/gptrouter`

- **`scheme`**：`vscode` 或 `cursor` 等（`vscode.env.uriScheme`）。
- **路径**：固定 **`/auth/gptrouter`**。
- **Query**：
  - `code`：授权码（一次性）
  - `state`：与授权请求一致

示例：

```http
302 Location: vscode://cline-gptrouter.claude-dev/auth/gptrouter?code=AUTH_CODE&state=RANDOM_STATE
```

VS Code Web / Codespaces 下，`redirect_uri` 可能为 HTTPS（`asExternalUri` 转换结果），后端按实际回调 URL 白名单校验即可。

## 3. 换票接口（扩展 → 你的后端）

扩展在收到 deep link 后，会 **服务端直连**（扩展进程内 HTTPS/HTTP，非 webview）请求 token 端点：

**默认 URL**：`POST {oauth_base}/oauth/token`  
若单独部署 token 服务，用户可在设置中填写 **`gptrouterOAuthTokenUrl`** 覆盖完整 URL。

### 请求

- **Content-Type**：`application/x-www-form-urlencoded`
- **Body**（表单）：

| 字段 | 说明 |
|------|------|
| `grant_type` | 固定 `authorization_code` |
| `code` | 回调中的 `code` |
| `redirect_uri` | 必须与授权步骤使用的一致 |
| `client_id` | 与授权请求一致 |

可选（若你方启用 PKCE，后续可扩展）：`code_verifier`。

### 成功响应（建议 JSON）

扩展会解析以下字段（**至少要有可用的 API 凭证**）：

| 字段 | 说明 |
|------|------|
| `api_key` | **优先**：若存在，将直接写入扩展的 OpenAI 兼容 `api_key`，用于请求 `{oauth_base}/v1` |
| `access_token` | 若无 `api_key`，则用 `access_token` 作为 Bearer/API Key 使用 |
| `refresh_token` | 可选，存入 secret（JSON），便于后续刷新 |
| `expires_in` | 可选，秒；用于本地过期时间推算 |
| `user` | 可选，展示用，例如：`{ "id", "sub", "email", "name", "display_name" }` |

### 错误

非 2xx 或 JSON 中无 `api_key`/`access_token` 时，扩展会提示登录失败；**不要**在重定向 URL 中长期暴露 refresh token。

## 4. 与 OpenAI 兼容网关的关系

登录成功后扩展会将 **`openAiBaseUrl`** 设为 **`{oauth_base}/v1`**（与 `oauth_base` 同源），便于本地后端联调。

## 5. 联调检查清单

- [ ] 客户端注册：`client_id`、`redirect_uri`（含 `vscode://cline-gptrouter.claude-dev/auth/gptrouter` 或 Web 版 HTTPS 回调）
- [ ] `GET /oauth/authorize` 接受上述 query 并回 `code` + `state`
- [ ] `POST /oauth/token` 接受表单并返回 JSON（含 `api_key` 或 `access_token`）
- [ ] 网关 `GET /v1/models` 可用返回的 key 访问

如有路径与本文不一致，只要 **授权 URL / token URL** 可通过设置 `gptrouterOAuthBaseUrl` / `gptrouterOAuthTokenUrl` 指到你的实现即可。
