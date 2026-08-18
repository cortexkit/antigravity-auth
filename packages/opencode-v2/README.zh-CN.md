# opencode-v2-antigravity

面向 **OpenCode 2.x** 的 Google Antigravity provider，基于
[`@cortexkit/antigravity-auth-core`](https://www.npmjs.com/package/@cortexkit/antigravity-auth-core) 实现。

`@cortexkit/opencode-antigravity-auth` 面向 OpenCode 1.x 宿主
（`engines.opencode: ">=1.17.13 <2"`）：它通过劫持 `fetch()` 并注册 TUI 侧边栏来工作。
OpenCode 2.x 用新的插件 API 取代了这些接口（`session.hook`、`integration.transform`、
`tool.transform`、原生 provider 包），因此 1.x 插件无法在 2.x 中加载。本包补上了这层宿主适配：
OAuth、传输、账号池、配额与模型注册表仍然全部复用共享 core。

> **服务条款警告。** 本项目调用 Antigravity 的非公开内部 API，未获 Google 认可，可能违反
> Google 服务条款；已有账号因类似用法被限制的报告。请自行评估风险，不要使用重要账号。

## 设计

```
OpenCode 2.x                          本插件                        Antigravity
────────────                          ──────                        ───────────
原生 @opencode-ai/ai/providers/google
  构造 Gemini 请求      ──▶  session.hook("http.request")
                                将 URL 改写为 127.0.0.1 回环地址
                                       │
                                       ▼
                             回环 HTTP 服务
                                · 选择账号（hybrid 策略）
                                · 刷新 OAuth token
                                · ensureProjectContext()
                                · agent 信封 + labels/sessionId
                                · fetchWithAgyCliTransport()  ──▶  daily-cloudcode-pa
                                                                    （回退 cloudcode-pa）
                                       │
  解析 Gemini SSE       ◀───────  解包并规范化后的 SSE
```

保留原生 `@opencode-ai/ai/providers/google` 作为编解码器，意味着图片、PDF 和 tool call
都交由宿主处理，不需要手写 adapter。

为什么使用回环服务，而不是在 hook 里直接返回 `Response`：OpenCode 2.x 会把 hook 留下的
`event.request` 交给自己的 HTTP 客户端发送，而 `http.response` hook 只在该请求成功之后才会执行。
回环端点既保留了 core 的原始 HTTP/1.1 传输（agy 的 header 顺序、代理支持），又让宿主看到一个
可以正常流式读取与取消的 SSE 响应。

## 安装

```bash
# 包发布后：
npm install @cortexkit/opencode-v2-antigravity-auth
# 或从本仓库（Bun workspace）：
bun install
```

插件的入口是包内的 `src/plugin.mjs`。在 `opencode.json` 中，把 `plugins[].package` 指向该文件：
npm 安装时用 `node_modules/@cortexkit/opencode-v2-antigravity-auth/src/plugin.mjs`
（相对于项目目录），从仓库检出时用绝对路径
`/path/to/antigravity-auth/packages/opencode-v2/src/plugin.mjs`。下面示例使用检出路径。

然后在 `opencode.json` 中注册插件与模型（完整示例见
[`example/opencode.json`](example/opencode.json)）：

```jsonc
{
  "plugins": [
    {
      "package": "/绝对路径/antigravity-auth/packages/opencode-v2/src/plugin.mjs",
      "options": {
        // 可选：限定 antigravity_read_document 可读取的目录。
        // 默认：用户主目录下的任意位置（凭据/密钥路径始终被拦截）。
        "readDocumentRoots": ["/绝对路径/project/docs"]
      }
    }
  ],
  "providers": {
    "google": {
      "models": {
        "gemini-3.7-flash": {
          "name": "Gemini 3.7 Flash",
          "modelID": "gemini-3.7-flash",
          "package": "@opencode-ai/ai/providers/google",
          "capabilities": { "tools": true, "input": ["text", "image", "pdf"], "output": ["text"] },
          "limit": { "context": 1048576, "output": 65536 },
          "variants": [{ "id": "low" }, { "id": "medium" }, { "id": "high" }]
        }
      }
    }
  }
}
```

## 账号

- 账号池文件：OpenCode 配置目录下的 `antigravity-accounts.json`
  （`$OPENCODE_CONFIG_DIR`、`$XDG_CONFIG_HOME/opencode`、`%APPDATA%\opencode`
  或 `~/.config/opencode`），可用 `ANTIGRAVITY_ACCOUNTS_FILE` 覆盖。
  存储结构为 v4，并使用 core 的文件锁，因此与 1.x 插件、独立 CLI 共享同一份数据。
- 添加账号：连接 `google` integration，选择
  **“Google Antigravity (add account)”**。每次登录都是**追加**，不会覆盖已有账号。
  回调监听 `127.0.0.1:51121/oauth-callback`。
- 停用账号：把该条目设为 `"enabled": false`。
- 账号选择使用 core 的 `hybrid` 策略；遇到 `429`/`403` 会让该账号冷却并切换到下一个，
  `401` 会强制刷新 token，返回空候选的 `STOP` 最多重试三次。

## 模型

| 选择器 | 变体 | 实际下发模型 |
| --- | --- | --- |
| `google/gemini-3.7-flash` | low, medium, high | `gemini-3.7-flash-{tier}` |
| `google/gemini-3.6-flash` | low, medium, high | `gemini-3.6-flash-{tier}` |
| `google/gemini-3.5-flash` | low, medium, high | `gemini-3.5-flash-extra-low` / `gemini-3.5-flash-low` / `gemini-3-flash-agent` |
| `google/gemini-3.1-pro` | low, high | `gemini-3.1-pro-low` / `gemini-pro-agent` |
| `google/gemini-3.1-flash-image` | — | `gemini-3.1-flash-image` |
| `google/claude-sonnet-4-6-thinking` | — | `claude-sonnet-4-6` |
| `google/claude-opus-4-6-thinking` | — | `claude-opus-4-6-thinking` |
| `google/gpt-oss-120b-medium` | — | `gpt-oss-120b-medium` |

模型 id 与推理档位来自 `resolveModelForHeaderStyle()`，注册表仍是唯一事实来源。

## 已绕过的宿主/上游问题

1. **GPT-OSS 的工具 schema**：AGY 的 GPT 桥接会把 protobuf 数值约束重新编码为字符串，
   于是 `minLength: 1` 在 OpenAI JSON-Schema 校验中失败，返回 `400 INVALID_ARGUMENT`。
   对 `gpt-*` 下发模型调用
   `normalizeGeminiTools(request, { moveNumericConstraintsToDescription: true })` 即可解决。
2. **原生事件 schema 很严格**：GPT-OSS 的首帧只有 `content` 而没有 `parts`，Claude 有时使用
   `assistant` 角色，两者都会触发 `Invalid google/gemini stream event`。
   因此每一帧在转发前都会被规范化。
3. **响应编码**：core 传输层已经解压 gzip，因此上游的 `content-encoding` 头不能复制到
   回环响应上。
4. **PDF 附件**：OpenCode 2.x CLI 在请求到达 provider 之前就丢弃了 PDF 附件
   （请求中没有任何 `inlineData`）。因此插件额外注册了 `antigravity_read_document` 工具，
   由插件自己读取文件：`antigravity_read_document({ path, question?, model? })`，
   支持 `.pdf`、`.png`、`.jpg`、`.webp`、`.gif`、`.heic`。聊天中粘贴的图片无需该工具即可工作。
   **安全说明**：该工具会读取本地文件并发送到 Antigravity 服务器 —— 不可信的 PDF/图片是
   prompt-injection 的载体，可能诱导模型读取敏感文件。因此路径经过检查：
   常见的凭据/密钥位置（`~/.ssh`、`~/.config`、`~/.local`、`AppData`、`.env`、`*.key`、
   `*.pem`、`*.p12`、`*.pfx`、`id_rsa`、`credentials`、`auth.json`、
   `antigravity-accounts.json` 等）始终被拒绝；默认只允许读取用户主目录下的文件。如需
   进一步收窄可读范围，请设置插件选项 `readDocumentRoots`（绝对路径数组）。尽量在聊天中
   附带文档，宿主会保留附件。
5. **图片输出**：原生解析器只渲染文本与 tool call，因此生成的图片会写入
   `<data dir>/antigravity-images/`，并以文本形式告知路径。

## 日志与隐私

`<state dir>/antigravity-v2.log` 只记录路由、`#<账号序号>`、上游状态码、账号轮换与已保存图片路径；
不写入任何 prompt、token、邮箱或 refresh token。凭据只保存在由 core 管理的账号池文件中。

## 实测

Windows 11、Node 24、OpenCode `0.0.0-beta-17595`、两账号池：

- 上表 8 个选择器全部通过真实请求（包含每个推理档位）；
- tool call 端到端可用（模型调用 `read` 并返回目录列表）；
- PNG 附件识别正确（纯红色方块 → “Red”）；
- 通过 `antigravity_read_document` 读取 PDF，返回了其中的精确文本；
- 图片生成得到两个 JPEG 文件；
- 强制故障转移：停用 `#0` 账号后，下一次请求走到了 `#1` 账号。

## 许可证

MIT。
