# 第 17 章　MCP 集成与扩展

Model Context Protocol（MCP）是 Anthropic 推出的开放协议，旨在标准化 AI 应用与外部工具/数据源的连接方式。OpenCode 内置了完整的 MCP 客户端实现，用户可以通过配置接入任意 MCP Server，为 AI 扩展无限的能力边界。

## 17.1 MCP 协议简介

MCP 定义了一套标准的 JSON-RPC 通信协议，包含三个核心概念：

- **Tools**：可执行的工具（如搜索文件、查询数据库、调用 API）
- **Prompts**：可复用的提示词模板
- **Resources**：可读取的数据资源（如文件、数据库记录）

协议支持多种传输方式：标准输入/输出（Stdio）、Server-Sent Events（SSE）和 Streamable HTTP。OpenCode 作为 MCP 客户端，同时支持本地（Stdio）和远程（HTTP）两种 MCP Server 连接方式。

### 17.1.1 三种传输方式详解

OpenCode 从官方 SDK 引入了三种传输实现，每种适用于不同的部署场景：

```typescript
// 文件: packages/opencode/src/mcp/index.ts L1-5
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
```

**Stdio 传输** 用于本地 MCP Server。OpenCode 以子进程方式启动命令行程序，通过标准输入输出进行 JSON-RPC 通信。这种方式延迟最低，无需网络开销，适合本地工具如文件系统操作、Git 集成等。

**SSE 传输** 是 MCP 协议最早支持的远程传输方式，通过 HTTP GET 建立持久连接接收推送，通过 POST 发送消息。**Streamable HTTP 传输** 是新一代推荐方案，将请求和响应统一到单个 HTTP 端点。OpenCode 在连接远程 Server 时，按顺序尝试两种传输方式：

```typescript
// 文件: packages/opencode/src/mcp/index.ts L362-377
const transports: Array<{ name: string; transport: TransportWithAuth }> = [
  {
    name: "StreamableHTTP",
    transport: new StreamableHTTPClientTransport(new URL(mcp.url), {
      authProvider,
      requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
    }),
  },
  {
    name: "SSE",
    transport: new SSEClientTransport(new URL(mcp.url), {
      authProvider,
      requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
    }),
  },
]
```

`create()` 函数在 for 循环中依次尝试每种传输，连接成功即 break。这种降级策略确保了向后兼容——即使目标 Server 只实现了旧版 SSE 协议，OpenCode 也能正常连接。

## 17.2 连接生命周期与状态管理

> **源码位置**：packages/opencode/src/mcp/index.ts

MCP 连接的完整生命周期包含四个阶段。状态通过 `Instance.state()` 管理，确保每个项目有独立的 MCP 连接池。

**创建阶段**：启动时，`state` 初始化函数遍历配置中的所有 MCP 条目，对禁用的标记 `disabled`，其余并行调用 `create()` 建立连接。对于本地 Server，`StdioClientTransport` 接收 `command`、`args`、`cwd` 和环境变量参数来启动子进程，并通过 pipe 捕获 stderr 输出用于调试日志：

```typescript
// 文件: packages/opencode/src/mcp/index.ts L448-462
const [cmd, ...args] = mcp.command
const transport = new StdioClientTransport({
  stderr: "pipe",
  command: cmd,
  args,
  cwd,
  env: {
    ...process.env,
    ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
    ...mcp.environment,
  },
})
transport.stderr?.on("data", (chunk: Buffer) => {
  log.info(`mcp stderr: ${chunk.toString()}`, { key })
})
```

每次连接都使用 `withTimeout()` 包装，默认 30 秒超时，可通过配置自定义。

**发现阶段**：连接建立后立即调用 `client.listTools()` 验证工具可用性。如果获取失败，客户端会被关闭并标记 `failed`，避免保留无用连接。

**使用阶段**：LLM 调用 MCP 工具时，通过 `client.callTool()` 发起 JSON-RPC 请求，支持 `resetTimeoutOnProgress` 选项——长时间操作不会被误判超时。

**清理阶段**：Instance 释放时，清理函数遍历所有连接。对 Stdio 传输，`descendants()` 函数通过 `pgrep -P` 递归找到整棵进程树，逐一发送 SIGTERM。这一设计解决了 MCP Server 可能启动子进程（如 Chrome、Node.js 工具链）导致的僵尸进程问题：

```typescript
// 文件: packages/opencode/src/mcp/index.ts L164-180
async function descendants(pid: number): Promise<number[]> {
  const pids: number[] = []
  const queue = [pid]
  while (queue.length > 0) {
    const current = queue.shift()!
    const lines = await Process.lines(["pgrep", "-P", String(current)], { nothrow: true })
    for (const tok of lines) {
      const cpid = parseInt(tok, 10)
      if (!isNaN(cpid) && !pids.includes(cpid)) {
        pids.push(cpid)
        queue.push(cpid)
      }
    }
  }
  return pids
}
```

连接状态用 discriminated union 精确描述五种可能状态，包括 `needs_auth` 和 `needs_client_registration` 两种 OAuth 相关状态：

```typescript
// 文件: packages/opencode/src/mcp/index.ts L67-110
export const Status = z.discriminatedUnion("status", [
  z.object({ status: z.literal("connected") }),
  z.object({ status: z.literal("disabled") }),
  z.object({ status: z.literal("failed"), error: z.string() }),
  z.object({ status: z.literal("needs_auth") }),
  z.object({ status: z.literal("needs_client_registration"), error: z.string() }),
])
```

## 17.3 错误处理与连接降级策略

MCP 连接过程中的错误处理是系统健壮性的关键。`create()` 函数中，远程 Server 的连接尝试分为三层错误处理：传输层错误、OAuth 认证错误和工具发现错误。

对于远程 Server，`create()` 遍历 transports 数组时，每个传输的连接都包裹在 try-catch 中。当捕获到错误时，首先判断是否为 OAuth 相关错误。判断逻辑不仅检查 SDK 的 `UnauthorizedError` 类型，还通过消息内容匹配更广泛的 OAuth 失败场景：

```typescript
// 文件: packages/opencode/src/mcp/index.ts L401-402
const isAuthError =
  error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))
```

这种双重检测的原因在于 SDK 的行为并不统一——有时 `auth()` 回调内部发现、注册或 state 生成失败时会抛出普通 Error 而非 `UnauthorizedError`。进一步地，代码还区分了两种 OAuth 错误子类型。如果错误消息包含 "registration" 或 "client_id"，意味着 Server 不支持动态客户端注册（RFC 7591），此时状态设为 `needs_client_registration` 并通过 Toast 提示用户在配置中添加 `clientId`：

```typescript
// 文件: packages/opencode/src/mcp/index.ts L407-418
if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
  status = {
    status: "needs_client_registration" as const,
    error: "Server does not support dynamic client registration. Please provide clientId in config.",
  }
  Bus.publish(TuiEvent.ToastShow, {
    title: "MCP Authentication Required",
    message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
    variant: "warning",
    duration: 8000,
  }).catch((e) => log.debug("failed to show toast", { error: e }))
```

否则，将当前 transport 存入 `pendingOAuthTransports` Map，留待后续 `finishAuth()` 调用完成令牌交换。这个 Map 是连接远程 Server 的 OAuth 状态机的核心数据结构——它将 MCP Server 名称映射到尚未完成认证的传输实例。

对于本地 Server，错误处理更直接：`StdioClientTransport` 连接失败时记录详细的 command、cwd 和错误消息，然后标记为 `failed`。

连接成功后还有一道验证关卡——`listTools()` 调用。这确保不仅传输层连通，Server 的工具能力也正常可用：

```typescript
// 文件: packages/opencode/src/mcp/index.ts L506-527
const result = await withTimeout(mcpClient.listTools(), mcp.timeout ?? DEFAULT_TIMEOUT).catch((err) => {
  log.error("failed to get tools from client", { key, error: err })
  return undefined
})
if (!result) {
  await mcpClient.close().catch((error) => {
    log.error("Failed to close MCP client", { error })
  })
  status = {
    status: "failed",
    error: "Failed to get tools",
  }
  return {
    mcpClient: undefined,
    status: { status: "failed" as const, error: "Failed to get tools" },
  }
}
```

如果 `listTools()` 在超时内未返回有效结果，客户端会被主动关闭并标记失败。注意这里关闭客户端时的 `.catch()` 链——即使关闭操作本身也可能失败（例如传输层已经断开），但不应影响外层状态的正确设置。

## 17.4 工具转换管道

### 17.4.1 Schema 标准化

`convertMcpTool()` 函数将 MCP 工具定义转换为 AI SDK 的 `dynamicTool` 对象。转换过程中最关键的一步是 JSON Schema 的标准化。MCP 协议中 `inputSchema` 的格式可能不完全符合 AI SDK 的预期，因此需要强制覆盖几个字段：

```typescript
// 文件: packages/opencode/src/mcp/index.ts L122-149
async function convertMcpTool(mcpTool: MCPToolDef, client: MCPClient, timeout?: number): Promise<Tool> {
  const inputSchema = mcpTool.inputSchema
  const schema: JSONSchema7 = {
    ...(inputSchema as JSONSchema7),
    type: "object",
    properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }
  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),
    execute: async (args: unknown) => {
      return client.callTool(
        { name: mcpTool.name, arguments: (args || {}) as Record<string, unknown> },
        CallToolResultSchema,
        { resetTimeoutOnProgress: true, timeout },
      )
    },
  })
}
```

这里有三个关键的标准化决策。第一，`type` 强制设为 `"object"`，因为 LLM 工具调用总是期望对象类型的参数。第二，`properties` 使用空对象作为默认值，防止某些 MCP Server 省略此字段导致的 undefined 错误。第三，`additionalProperties: false` 告诉 LLM 不要生成 schema 中未定义的参数——这对于确保工具调用的精确性至关重要。

`execute` 回调中 `resetTimeoutOnProgress: true` 的设置值得关注。长时间运行的 MCP 工具（如数据库迁移、大规模文件搜索）可能需要数分钟才能完成，但只要 Server 持续发送进度通知，超时计时器就会重置。这避免了活跃但耗时的操作被误杀。

### 17.4.2 工具名称全局唯一化

## 17.5 工具发现与注册

连接成功后，`tools()` 函数从所有已连接的客户端并行收集工具列表。`convertMcpTool()` 将 MCP 工具定义转换为 AI SDK 的 `dynamicTool` 对象，包装 `inputSchema` 为标准 JSON Schema 格式（强制 `type: "object"` 和 `additionalProperties: false`），并将 `execute` 回调指向 `client.callTool()`。工具名称经过 sanitize 处理确保全局唯一：

```typescript
// 文件: packages/opencode/src/mcp/index.ts L639-642
const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
const sanitizedToolName = mcpTool.name.replace(/[^a-zA-Z0-9_-]/g, "_")
result[sanitizedClientName + "_" + sanitizedToolName] = await convertMcpTool(mcpTool, client, timeout)
```

当某个客户端的 `listTools()` 失败时，OpenCode 将其标记为 `failed` 并从活跃列表移除，但不影响其他正常工作的 Server。这种隔离策略意味着一个不稳定的 MCP Server 不会拖垮整个工具生态。

MCP Server 还可以动态通知工具列表变更。`registerNotificationHandlers()` 注册了 `ToolListChangedNotification` 处理器，收到通知后通过 Bus 广播 `ToolsChanged` 事件，触发工具列表重新加载。

除了 Tools，OpenCode 同样支持 MCP 的 Prompts 和 Resources 概念。`fetchPromptsForClient()` 和 `fetchResourcesForClient()` 分别获取各个 Server 提供的提示词模板和数据资源，命名方式与工具相同——`clientName:promptName`。

## 17.6 OAuth 认证流程

远程 MCP Server 通常需要身份验证。OpenCode 实现了完整的 OAuth 2.0 Authorization Code + PKCE 流程。远程 Server 默认启用 OAuth（除非显式设为 `false`）。

`McpOAuthProvider` 类实现了 SDK 的 `OAuthClientProvider` 接口，管理客户端信息、令牌存储和 PKCE 验证器。当用户未提供 `clientId` 时，`clientInformation()` 返回 `undefined`，触发动态客户端注册（RFC 7591）。注册成功后，客户端凭据通过 `McpAuth` 持久化到本地文件系统，并绑定 Server URL——当用户修改 URL 后，旧凭据自动失效：

```typescript
// 文件: packages/opencode/src/mcp/oauth-provider.ts L49-75
async clientInformation(): Promise<OAuthClientInformation | undefined> {
  if (this.config.clientId) {
    return { client_id: this.config.clientId, client_secret: this.config.clientSecret }
  }
  const entry = await McpAuth.getForUrl(this.mcpName, this.serverUrl)
  if (entry?.clientInfo) {
    if (entry.clientInfo.clientSecretExpiresAt &&
        entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
      return undefined  // 过期触发重新注册
    }
    return { client_id: entry.clientInfo.clientId, client_secret: entry.clientInfo.clientSecret }
  }
  return undefined  // 触发动态注册
}
```

`startAuth()` 函数首先启动本地回调服务器 `McpOAuthCallback`（端口 19876），然后生成 32 字节随机 state 参数防止 CSRF 攻击。回调服务器使用 `state` 作为 key 来匹配挂起的认证请求，每个请求有 5 分钟超时限制。`ensureRunning()` 会先检测端口是否被其他 OpenCode 实例占用，避免冲突。

`authenticate()` 函数协调整个流程：先注册回调 Promise 再打开浏览器（避免 SSO 快速重定向导致的竞态条件），等待用户完成授权后验证 state 参数一致性，最后调用 `finishAuth()` 用授权码换取令牌。如果浏览器打开失败（如 SSH/devcontainer 环境），通过 `BrowserOpenFailed` 事件通知 TUI 显示 URL 供手动复制。

## 17.7 OAuth 回调服务器与凭据持久化

### 17.7.1 本地回调服务器的实现

`McpOAuthCallback` 命名空间实现了一个基于 Bun 原生 HTTP 服务器的 OAuth 回调接收端。它监听 `127.0.0.1:19876` 端口的 `/mcp/oauth/callback` 路径，处理授权服务器的重定向回调。

回调处理的安全检查非常严格。首先验证 `state` 参数必须存在——缺失 state 被视为潜在的 CSRF 攻击并返回 400 错误。然后检查 `state` 是否在 `pendingAuths` Map 中注册过——未注册的 state 同样被拒绝：

```typescript
// 文件: packages/opencode/src/mcp/oauth-callback.ts L86-123
if (!state) {
  const errorMsg = "Missing required state parameter - potential CSRF attack"
  log.error("oauth callback missing state parameter", { url: url.toString() })
  return new Response(HTML_ERROR(errorMsg), {
    status: 400,
    headers: { "Content-Type": "text/html" },
  })
}
// ...
if (!pendingAuths.has(state)) {
  const errorMsg = "Invalid or expired state parameter - potential CSRF attack"
  log.error("oauth callback with invalid state", { state, pendingStates: Array.from(pendingAuths.keys()) })
  return new Response(HTML_ERROR(errorMsg), {
    status: 400,
    headers: { "Content-Type": "text/html" },
  })
}
```

`waitForCallback()` 函数为每个 OAuth 流程注册一个带超时的 Promise。超时时间为 5 分钟——考虑到用户需要在浏览器中完成登录和授权，这个时长是合理的。超时后 pending entry 被清除并 reject，避免内存泄漏：

```typescript
// 文件: packages/opencode/src/mcp/oauth-callback.ts L140-151
export function waitForCallback(oauthState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuths.has(oauthState)) {
        pendingAuths.delete(oauthState)
        reject(new Error("OAuth callback timeout - authorization took too long"))
      }
    }, CALLBACK_TIMEOUT_MS)
    pendingAuths.set(oauthState, { resolve, reject, timeout })
  })
}
```

`ensureRunning()` 在启动服务器前通过 `isPortInUse()` 检测端口是否被占用。这个检测使用原生 TCP 连接探测——尝试连接目标端口，如果 `connect` 事件触发说明端口已被其他 OpenCode 实例占用，此时跳过启动：

```typescript
// 文件: packages/opencode/src/mcp/oauth-callback.ts L162-173
export async function isPortInUse(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(OAUTH_CALLBACK_PORT, "127.0.0.1")
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => {
      resolve(false)
    })
  })
}
```

### 17.7.2 凭据持久化与 URL 绑定

`McpAuth` 命名空间管理 OAuth 凭据的持久化存储。凭据以 JSON 格式存储在 `$DATA_DIR/mcp-auth.json` 文件中，文件权限设置为 `0o600`（仅所有者可读写），保护敏感的 token 数据。

每个 MCP Server 的凭据条目包含四个可选字段：`tokens`（访问令牌和刷新令牌）、`clientInfo`（动态注册的客户端信息）、`codeVerifier`（PKCE 验证码）和 `oauthState`（防 CSRF 的 state 值）。最重要的是 `serverUrl` 字段——它将凭据绑定到特定的 Server URL：

```typescript
// 文件: packages/opencode/src/mcp/auth.ts L43-54
export async function getForUrl(mcpName: string, serverUrl: string): Promise<Entry | undefined> {
  const entry = await get(mcpName)
  if (!entry) return undefined
  if (!entry.serverUrl) return undefined
  if (entry.serverUrl !== serverUrl) return undefined
  return entry
}
```

`getForUrl()` 的三重检查确保：如果用户修改了 MCP Server 的 URL，旧的凭据会自动失效。没有 `serverUrl` 的条目被视为旧版本数据，同样返回 undefined。这个设计防止了一个微妙的安全风险——用户将 Server URL 从可信的 `api.company.com` 改为 `api.evil.com` 后，旧的 access token 不会被自动发送给新的目标。

`McpOAuthProvider` 类的 `tokens()` 和 `clientInformation()` 方法都调用 `getForUrl()` 而非普通的 `get()`，确保 URL 验证贯穿整个 OAuth 生命周期。`saveTokens()` 和 `saveClientInformation()` 则在保存时同步更新 `serverUrl`，建立新的绑定关系。

令牌过期检测也在持久化层实现。`isTokenExpired()` 对比 `expiresAt` 时间戳与当前时间，`clientInformation()` 同样检查 `clientSecretExpiresAt`。过期的客户端信息返回 undefined，触发重新动态注册流程。

## 17.8 与原生工具的融合

MCP 工具与 OpenCode 的原生工具在 LLM 调用层面完全平等。在 `LLM.stream()` 中，所有工具被合并为统一的 `tools` 字典传给 AI SDK。LLM 看到的工具列表中不区分来源——它可以自由组合使用原生的 `file_read` 工具和 MCP 提供的 `database_query` 工具。

OpenCode 还支持运行时动态管理 MCP 连接：`connect()` 和 `disconnect()` 函数允许用户在不重启应用的情况下启用或禁用特定 Server。`add()` 函数在添加新客户端时会先关闭同名的已有连接，防止内存泄漏。

## 17.9 运行时动态管理

OpenCode 允许在不重启应用的情况下管理 MCP 连接。`connect()` 和 `disconnect()` 函数提供了运行时热插拔能力。

`connect()` 函数读取配置后调用 `create()`，如果存在同名的已有连接会先将其关闭，防止客户端对象泄漏。`disconnect()` 则关闭指定客户端并将其状态设为 `disabled`：

```typescript
// 文件: packages/opencode/src/mcp/index.ts L594-604
export async function disconnect(name: string) {
  const s = await state()
  const client = s.clients[name]
  if (client) {
    await client.close().catch((error) => {
      log.error("Failed to close MCP client", { name, error })
    })
    delete s.clients[name]
  }
  s.status[name] = { status: "disabled" }
}
```

`status()` 函数提供全局视图，遍历配置中所有 MCP 条目，将每个条目的实际连接状态与配置状态合并。未在 state 中找到的条目默认显示为 `disabled`。

认证管理同样支持运行时操作。`removeAuth()` 清除指定 Server 的所有 OAuth 凭据，取消挂起的回调，并从 `pendingOAuthTransports` 中移除。`getAuthStatus()` 提供三态查询——`"authenticated"`（有效令牌）、`"expired"`（令牌过期）和 `"not_authenticated"`（无令牌）。`supportsOAuth()` 判断一个 MCP Server 是否支持 OAuth——条件是 `type` 为 `"remote"` 且 `oauth` 不为 `false`。

## 17.10 本章要点

- OpenCode 内置完整的 MCP 客户端，支持 Stdio（本地）和 HTTP/SSE（远程）两种传输
- 远程连接优先使用 Streamable HTTP，自动降级到 SSE，保证向后兼容
- 错误处理分三层：传输层错误触发降级，OAuth 错误区分 needs_auth 和 needs_client_registration，工具发现失败则关闭连接
- 工具转换管道强制标准化 JSON Schema（type: "object"、additionalProperties: false），`resetTimeoutOnProgress` 支持长时间操作
- 清理阶段通过 `pgrep` 递归杀死整棵进程树，避免僵尸进程
- OAuth 回调服务器使用 Bun 原生 HTTP，端口占用检测避免多实例冲突，state 参数严格校验防 CSRF
- 凭据持久化绑定 Server URL，修改 URL 后旧凭据自动失效，文件权限 0o600 保护敏感数据
- 运行时支持 connect/disconnect 热插拔，OAuth 状态三态查询（authenticated/expired/not_authenticated）
