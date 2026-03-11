# 第 17 章　MCP 集成与扩展

Model Context Protocol（MCP）是 Anthropic 推出的开放协议，旨在标准化 AI 应用与外部工具/数据源的连接方式。OpenCode 内置了完整的 MCP 客户端实现，用户可以通过配置接入任意 MCP Server，为 AI 扩展无限的能力边界。

## 17.1 MCP 协议简介

MCP 定义了一套标准的 JSON-RPC 通信协议，包含三个核心概念：

- **Tools**：可执行的工具（如搜索文件、查询数据库、调用 API）
- **Prompts**：可复用的提示词模板
- **Resources**：可读取的数据资源（如文件、数据库记录）

协议支持多种传输方式：标准输入/输出（Stdio）、Server-Sent Events（SSE）和 Streamable HTTP。OpenCode 作为 MCP 客户端，同时支持本地（Stdio）和远程（HTTP）两种 MCP Server 连接方式。

## 17.2 OpenCode 的 MCP 客户端实现

> **源码位置**：packages/opencode/src/mcp/index.ts

MCP 模块使用官方的 `@modelcontextprotocol/sdk` 构建客户端，支持自动发现和连接：

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

export namespace MCP {
  const DEFAULT_TIMEOUT = 30_000

  // MCP 状态管理：与 Instance 生命周期绑定
  const state = Instance.state(
    async () => {
      const cfg = await Config.get()
      const config = cfg.mcp ?? {}
      const clients: Record<string, MCPClient> = {}
      const status: Record<string, Status> = {}

      await Promise.all(
        Object.entries(config).map(async ([key, mcp]) => {
          if (mcp.enabled === false) {
            status[key] = { status: "disabled" }
            return
          }
          const result = await create(key, mcp).catch(() => undefined)
          if (result?.mcpClient) clients[key] = result.mcpClient
          if (result) status[key] = result.status
        }),
      )
      return { status, clients }
    },
    async (state) => {
      // 清理时杀死所有子进程树，避免僵尸进程
      for (const client of Object.values(state.clients)) {
        const pid = (client.transport as any)?.pid
        if (typeof pid === "number") {
          for (const dpid of await descendants(pid)) {
            try { process.kill(dpid, "SIGTERM") } catch {}
          }
        }
      }
      await Promise.all(
        Object.values(state.clients).map((c) => c.close().catch(() => {}))
      )
    },
  )
}
```

状态通过 `Instance.state()` 管理，确保每个项目有独立的 MCP 连接池，当 Instance 释放时自动清理所有连接和子进程。

## 17.3 MCP Server 配置

用户通过 `opencode.json` 配置 MCP Server，支持本地和远程两种类型：

```json
{
  "mcp": {
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      "environment": { "NODE_ENV": "production" },
      "enabled": true,
      "timeout": 10000
    },
    "remote-api": {
      "type": "remote",
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer xxx" },
      "oauth": { "clientId": "my-app", "scope": "read write" }
    }
  }
}
```

配置的 Zod schema 定义了严格的类型约束：

```typescript
// 本地 MCP Server
export const McpLocal = z.object({
  type: z.literal("local"),
  command: z.string().array(),      // 命令和参数
  environment: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
}).strict()

// 远程 MCP Server
export const McpRemote = z.object({
  type: z.literal("remote"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: z.union([McpOAuth, z.literal(false)]).optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
}).strict()
```

对于远程 Server，OAuth 认证默认启用（除非显式设为 `false`）。OpenCode 实现了完整的 OAuth 2.0 流程，包括 PKCE、动态客户端注册和浏览器回调处理。

## 17.4 工具发现与注册

连接成功后，OpenCode 自动发现 MCP Server 提供的所有工具，并转换为 AI SDK 的 Tool 格式：

```typescript
async function convertMcpTool(
  mcpTool: MCPToolDef,
  client: MCPClient,
  timeout?: number
): Promise<Tool> {
  // 确保 schema 符合 JSON Schema object 类型
  const schema: JSONSchema7 = {
    ...(mcpTool.inputSchema as JSONSchema7),
    type: "object",
    properties: (mcpTool.inputSchema.properties ?? {}) as JSONSchema7["properties"],
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

工具名称经过 sanitize 处理，格式为 `{clientName}_{toolName}`，确保全局唯一且符合标识符规范。MCP Server 还可以动态通知工具列表变更：

```typescript
function registerNotificationHandlers(client: MCPClient, serverName: string) {
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    log.info("tools list changed notification received", { server: serverName })
    Bus.publish(ToolsChanged, { server: serverName })
  })
}
```

## 17.5 与原生工具的融合

MCP 工具与 OpenCode 的原生工具（如文件读写、终端执行、搜索等）在 LLM 调用层面完全平等。在 `LLM.stream()` 中，所有工具被合并为统一的 `tools` 字典传给 AI SDK：

```typescript
// MCP 工具获取
export async function tools() {
  const result: Record<string, Tool> = {}
  const clientsSnapshot = await clients()

  const toolsResults = await Promise.all(
    connectedClients.map(async ([clientName, client]) => {
      const toolsResult = await client.listTools().catch((e) => {
        // 连接失败时标记状态，下次不再尝试
        s.status[clientName] = { status: "failed", error: e.message }
        delete s.clients[clientName]
        return undefined
      })
      return { clientName, client, toolsResult }
    }),
  )

  for (const { clientName, client, toolsResult } of toolsResults) {
    if (!toolsResult) continue
    for (const mcpTool of toolsResult.tools) {
      const key = sanitizedClientName + "_" + sanitizedToolName
      result[key] = await convertMcpTool(mcpTool, client, timeout)
    }
  }
  return result
}
```

LLM 看到的工具列表中不区分来源——它可以自由组合使用原生的 `file_read` 工具和 MCP 提供的 `database_query` 工具。这种无缝融合是 OpenCode 相比 Cursor（需要独立的 MCP 面板）的架构优势。

## 17.6 实战：接入一个自定义 MCP Server

假设你有一个提供 Jira 查询功能的 MCP Server，接入步骤如下：

**步骤 1**：在 `opencode.json` 中添加配置：

```json
{
  "mcp": {
    "jira": {
      "type": "local",
      "command": ["npx", "-y", "mcp-server-jira"],
      "environment": {
        "JIRA_URL": "https://myteam.atlassian.net",
        "JIRA_TOKEN": "xxx"
      }
    }
  }
}
```

**步骤 2**：重启 OpenCode，MCP 模块自动连接并发现工具。

**步骤 3**：在对话中直接使用——AI 会自动识别并调用 Jira 工具：

```
用户：查看当前 Sprint 中分配给我的未完成 Jira 任务

AI：[调用 jira_search_issues 工具]
找到 3 个未完成任务：
- PROJ-123: 修复登录页面样式问题
- PROJ-145: 添加单元测试覆盖
- PROJ-167: 更新 API 文档
```

对于需要 OAuth 认证的远程 MCP Server，OpenCode 会自动弹出浏览器进行授权，完成后通过回调 URL 获取令牌并安全存储。

## 17.7 本章要点

- OpenCode 内置完整的 MCP 客户端，支持 Stdio（本地）和 HTTP/SSE（远程）两种传输
- MCP Server 配置通过 `opencode.json` 管理，支持环境变量、超时和 OAuth 认证
- MCP 工具自动转换为 AI SDK Tool 格式，与原生工具无缝融合
- 工具列表变更通过事件总线实时通知，MCP 连接池与 Instance 生命周期绑定
- OAuth 2.0 流程完整实现，包括 PKCE、动态注册和浏览器回调
