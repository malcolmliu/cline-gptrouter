# Bundled third-party components

## ArXiv MCP Server ([blazickjp/arxiv-mcp-server](https://github.com/blazickjp/arxiv-mcp-server))

License: MIT (see upstream `LICENSE` when vendored).

### Populate this folder before packaging a VSIX

**Option A — git submodule (recommended)**

```bash
git submodule add https://github.com/blazickjp/arxiv-mcp-server.git bundled/arxiv-mcp-server
git submodule update --init --recursive
```

**Option B — npm script (clone)**

```bash
npm run vendor:arxiv-mcp
```

### Runtime requirement

The bundled server is started with **`uv`** (see [astral-sh/uv](https://github.com/astral-sh/uv)). Users must have `uv` on `PATH`. On first activation, cline-gptrouter registers an MCP entry that runs:

`uv --directory <extension>/bundled/arxiv-mcp-server run arxiv-mcp-server --storage-path <globalStorage>/arxiv-mcp-server/papers`

### VSIX contents

Do not commit `.venv` inside `bundled/arxiv-mcp-server`. `.vscodeignore` excludes tests and venv from the package.

### 一键打出带 ArXiv MCP 的 VSIX（发给同事调试）

前提：

- 已 `npm install` 与 `cd webview-ui && npm install`
- 本机可跑通 `npm run protos`（需可用的 `protoc` / grpc-tools；Apple Silicon 无 Rosetta 时见主仓库 README）
- 已安装 **VS Code 扩展打包工具**：`npm i -g @vscode/vsce`（或用项目里的 `npx vsce`）

命令（仓库根目录）：

```bash
npm run package:vsix
```

产出：`dist/cline-gptrouter.vsix`。其中已包含 `bundled/arxiv-mcp-server` 源码（由脚本自动 `git clone`）；**同事机器上仍需安装 [`uv`](https://github.com/astral-sh/uv)** 才能实际跑起该 MCP。
