# 第 14 章　HTTP Server 与 API 设计

OpenCode 采用前后端分离架构，核心逻辑运行在一个 HTTP Server 中，TUI、桌面应用和 Web 界面都通过 API 与之通信。本章深入分析 Server 的实现，理解其路由设计、认证机制和实时事件推送方案。

## 14.1 Hono 框架选择

> **源码位置**：packages/opencode/src/server/server.ts

OpenCode 选择了 [Hono](https://hono.dev/) 作为 HTTP 框架，而非 Express 或 Fastify。这个选择与其 Bun 运行时策略高度一致：

```typescript
import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { basicAuth } from "hono/basic-auth"
import { websocket } from "hono/bun"

export namespace Server {
  export const createApp = (opts: { cors?: string[] }): Hono => {
    const app = new Hono()
    return app
      .onError((err, c) => {
        // 统一错误处理：NamedError → 结构化 JSON 响应
        if (err instanceof NamedError) {
          let status: ContentfulStatusCode
          if (err instanceof NotFoundError) status = 404
          else if (err instanceof Provider.ModelNotFoundError) status = 400
          else status = 500
          return c.json(err.toObject(), { status })
        }
        // ...
      })
  }
}
```

选择 Hono 的理由包括：体积极小（不到 14KB），原生支持 Bun 运行时，中间件生态丰富（CORS、SSE、BasicAuth、WebSocket 均为内置模块），以及 TypeScript 优先的类型设计。相比之下，Claude Code 使用自定义的 IPC 通道，Cursor 使用 Electron 的进程间通信——OpenCode 的 HTTP Server 方案使其天然支持远程访问和多客户端连接。

## 14.2 路由设计

OpenCode 的路由采用模块化组织，每个功能域独立封装为 Route 模块：

```typescript
// 核心业务路由
.route("/project", ProjectRoutes())     // 项目管理
.route("/session", SessionRoutes())     // 会话管理
.route("/pty", PtyRoutes())             // 伪终端
.route("/mcp", McpRoutes())             // MCP 协议
.route("/config", ConfigRoutes())       // 配置管理
.route("/provider", ProviderRoutes())   // 模型提供商
.route("/permission", PermissionRoutes()) // 权限控制
.route("/question", QuestionRoutes())   // 用户交互问答
.route("/global", GlobalRoutes())       // 全局状态
.route("/experimental", ExperimentalRoutes()) // 实验功能
.route("/", FileRoutes())               // 文件操作
.route("/tui", TuiRoutes())            // TUI 专用接口
```

除了模块化路由，Server 还直接挂载了若干独立端点：`/agent`（Agent 列表）、`/skill`（技能列表）、`/command`（命令列表）、`/path`（路径信息）、`/vcs`（版本控制状态）、`/lsp`（LSP 状态）、`/formatter`（格式化器状态）等。

一个关键的中间件负责根据请求中的 `workspace` 和 `directory` 参数建立实例上下文：

```typescript
.use(async (c, next) => {
  const workspaceID = c.req.query("workspace") || c.req.header("x-opencode-workspace")
  const directory = Filesystem.resolve(decodeURIComponent(
    c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
  ))
  return WorkspaceContext.provide({
    workspaceID,
    async fn() {
      return Instance.provide({ directory, init: InstanceBootstrap, async fn() { return next() } })
    },
  })
})
```

这使得单个 Server 进程能同时服务多个项目目录，每个请求都在正确的 Instance 上下文中执行。

## 14.3 认证机制

OpenCode 支持可选的 HTTP Basic Auth 保护，通过环境变量配置：

```typescript
.use((c, next) => {
  // OPTIONS 预检请求跳过认证，支持 CORS 浏览器客户端
  if (c.req.method === "OPTIONS") return next()
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return next()  // 未设密码则跳过认证
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return basicAuth({ username, password })(c, next)
})
```

CORS 策略也经过精心设计，允许 localhost、Tauri 桌面应用和 `*.opencode.ai` 域名访问：

```typescript
cors({
  origin(input) {
    if (input.startsWith("http://localhost:")) return input
    if (input === "tauri://localhost") return input
    if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) return input
    return
  },
})
```

## 14.4 SSE 事件流

实时事件推送是 OpenCode 前后端通信的核心。Server 通过 `/event` 端点提供 Server-Sent Events 流：

```typescript
.get("/event", async (c) => {
  c.header("X-Accel-Buffering", "no")    // 禁用 Nginx 缓冲
  c.header("X-Content-Type-Options", "nosniff")
  return streamSSE(c, async (stream) => {
    // 连接建立后立即发送确认事件
    stream.writeSSE({
      data: JSON.stringify({ type: "server.connected", properties: {} }),
    })
    // 订阅所有总线事件并转发
    const unsub = Bus.subscribeAll(async (event) => {
      await stream.writeSSE({ data: JSON.stringify(event) })
      if (event.type === Bus.InstanceDisposed.type) stream.close()
    })
    // 每 10 秒发送心跳，防止代理超时
    const heartbeat = setInterval(() => {
      stream.writeSSE({
        data: JSON.stringify({ type: "server.heartbeat", properties: {} }),
      })
    }, 10_000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => { clearInterval(heartbeat); unsub(); resolve() })
    })
  })
})
```

这个设计将内部事件总线（Bus）与 HTTP 层桥接，客户端只需监听一个 SSE 连接即可获得所有实时更新——Session 状态变化、消息流、MCP 工具变更等。

## 14.5 WebSocket 支持

除 SSE 外，Server 还集成了 Bun 原生 WebSocket 支持：

```typescript
import { websocket } from "hono/bun"

export function listen(opts: { port: number; hostname: string }) {
  const app = createApp(opts)
  const server = Bun.serve({
    hostname: opts.hostname,
    idleTimeout: 0,
    fetch: app.fetch,
    websocket: websocket,  // Bun 原生 WebSocket 处理
  })
}
```

Server 启动时还支持 mDNS 发布，方便局域网内的设备发现：当 hostname 不是 loopback 地址且开启了 mdns 选项时，自动通过 `MDNS.publish()` 广播服务。

## 14.6 OpenAPI 文档生成

OpenCode 使用 `hono-openapi` 自动生成 OpenAPI 3.1.1 规范文档，每个路由都通过 `describeRoute` 声明元数据：

```typescript
import { describeRoute, generateSpecs, validator, resolver } from "hono-openapi"

.get("/doc", openAPIRouteHandler(app, {
  documentation: {
    info: { title: "opencode", version: "0.0.3", description: "opencode api" },
    openapi: "3.1.1",
  },
}))

// 每个端点声明 summary、operationId 和 Zod schema
.get("/path", describeRoute({
  summary: "Get paths",
  operationId: "path.get",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: resolver(z.object({
            home: z.string(), state: z.string(), config: z.string(),
            worktree: z.string(), directory: z.string(),
          })),
        },
      },
    },
  },
}))
```

访问 `/doc` 即可获取完整的 API 文档，这为第三方集成和 SDK 生成提供了标准化基础。

## 14.7 实战：理解 Server 的请求处理流程

以一个 Session 创建请求为例，完整的处理流程如下：

1. **请求到达**：客户端发送 `POST /session`，附带 `x-opencode-directory` 头
2. **认证检查**：BasicAuth 中间件验证凭据（若已配置）
3. **日志记录**：请求方法和路径被记录，同时启动计时器
4. **CORS 处理**：检查 Origin 是否在允许列表中
5. **上下文建立**：根据 directory 头创建 Instance 上下文，加载对应项目的数据库和配置
6. **路由分发**：请求进入 `SessionRoutes()` 模块处理
7. **事件广播**：Session 创建后，通过 Bus 发布 `session.created` 事件
8. **SSE 推送**：所有连接的 SSE 客户端收到该事件

这种架构使得多个 UI 客户端能同时连接同一个 Server，共享相同的会话状态——当 TUI 中创建了一个会话，桌面应用也能实时看到。

## 14.8 本章要点

- OpenCode 选择 Hono 框架，获得轻量级、Bun 原生和丰富中间件的优势
- 路由采用模块化设计，每个功能域独立封装，通过 workspace/directory 中间件支持多项目并发
- 认证支持可选的 BasicAuth，CORS 策略精确控制允许的来源
- SSE 事件流将内部事件总线桥接到 HTTP 层，实现多客户端实时同步
- OpenAPI 文档自动生成，为 API 集成提供标准化支持
