# 第 14 章　HTTP Server 与 API 设计

OpenCode 采用前后端分离架构，核心逻辑运行在一个 HTTP Server 中，TUI、桌面应用和 Web 界面都通过 API 与之通信。本章深入分析 Server 的实现，理解其路由设计、认证机制和实时事件推送方案。

## 14.1 Hono 框架选择

> **源码位置**：packages/opencode/src/server/server.ts

OpenCode 选择了 [Hono](https://hono.dev/) 作为 HTTP 框架，而非 Express 或 Fastify。这个选择与其 Bun 运行时策略高度一致：

```typescript
// 文件: packages/opencode/src/server/server.ts L1-10
import { Hono } from "hono"
import { cors } from "hono/cors"
import { basicAuth } from "hono/basic-auth"
import { streamSSE } from "hono/streaming"
import { websocket } from "hono/bun"
import { proxy } from "hono/proxy"
import { describeRoute, generateSpecs, validator, resolver, openAPIRouteHandler } from "hono-openapi"
```

Hono 体积极小（不到 14KB），原生支持 Bun 运行时，中间件生态丰富——CORS、SSE、BasicAuth、WebSocket、proxy 均为内置或一级模块，且全部采用 TypeScript 优先设计。相比之下，Claude Code 使用自定义的 IPC 通道，Cursor 使用 Electron 的进程间通信——OpenCode 的 HTTP Server 方案使其天然支持远程访问和多客户端连接。

`createApp` 工厂函数创建 Hono 应用实例并链式注册所有中间件和路由。值得注意的是 `lazy` 包装的 `Default` 实例——它是一个延迟初始化的单例，供 OpenAPI 文档生成等内部用途使用：

```typescript
// 文件: packages/opencode/src/server/server.ts L53-55
export const Default = lazy(() => createApp({}))

export const createApp = (opts: { cors?: string[] }): Hono => {
  const app = new Hono()
  return app.onError((err, c) => { ... })
```

## 14.2 中间件链的分层设计

Server 的中间件链按照严格的顺序执行，每一层负责不同的职责：

```text
┌─────────────────────────────────────────────────────┐
│  请求到达                                            │
│  ↓                                                   │
│  1. onError        ─ 统一错误处理                     │
│  ↓                                                   │
│  2. BasicAuth      ─ 认证检查（OPTIONS 跳过）         │
│  ↓                                                   │
│  3. Logger         ─ 请求日志和计时（/log 跳过）       │
│  ↓                                                   │
│  4. CORS           ─ 跨域策略                         │
│  ↓                                                   │
│  5. GlobalRoutes   ─ 无需项目上下文的全局路由          │
│  ↓                                                   │
│  6. Auth routes    ─ 认证相关端点（/auth/:providerID） │
│  ↓                                                   │
│  7. Context        ─ workspace/directory 上下文建立    │
│  ↓                                                   │
│  8. WorkspaceRouter─ 工作区路由中间件                  │
│  ↓                                                   │
│  9. 业务路由       ─ session/mcp/config/pty/...        │
│  ↓                                                   │
│  10. Proxy fallback─ 未匹配路由代理到 app.opencode.ai  │
└─────────────────────────────────────────────────────┘
```

`onError` 统一将 `NamedError` 转换为结构化 JSON 响应。不同的错误类型映射到不同的 HTTP 状态码：`NotFoundError` 返回 404，`Provider.ModelNotFoundError` 和认证验证失败返回 400，其他错误返回 500。`HTTPException` 直接返回其内置响应，未知错误则包装为 `NamedError.Unknown`：

```typescript
// 文件: packages/opencode/src/server/server.ts L58-76
.onError((err, c) => {
  if (err instanceof NamedError) {
    let status: ContentfulStatusCode
    if (err instanceof NotFoundError) status = 404
    else if (err instanceof Provider.ModelNotFoundError) status = 400
    else if (err.name === "ProviderAuthValidationFailed") status = 400
    else if (err.name.startsWith("Worktree")) status = 400
    else status = 500
    return c.json(err.toObject(), { status })
  }
  if (err instanceof HTTPException) return err.getResponse()
  const message = err instanceof Error && err.stack ? err.stack : err.toString()
  return c.json(new NamedError.Unknown({ message }).toObject(), { status: 500 })
})
```

日志中间件跳过 `/log` 路径的记录——因为 `/log` 端点本身就是用来接收客户端日志的，记录它会产生无限递归式的日志膨胀。每个请求都启动一个 `log.time()` 计时器，在 `next()` 返回后自动记录请求耗时。

## 14.3 workspace/directory 上下文中间件

一个关键的中间件负责根据请求中的 `workspace` 和 `directory` 参数建立实例上下文：

```typescript
// 文件: packages/opencode/src/server/server.ts L192-218
.use(async (c, next) => {
  if (c.req.path === "/log") return next()
  const rawWorkspaceID = c.req.query("workspace") || c.req.header("x-opencode-workspace")
  const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
  const directory = Filesystem.resolve(
    (() => {
      try { return decodeURIComponent(raw) }
      catch { return raw }
    })(),
  )
  return WorkspaceContext.provide({
    workspaceID: rawWorkspaceID ? WorkspaceID.make(rawWorkspaceID) : undefined,
    async fn() {
      return Instance.provide({
        directory, init: InstanceBootstrap,
        async fn() { return next() },
      })
    },
  })
})
```

这套中间件的精妙之处在于双层上下文嵌套。外层 `WorkspaceContext.provide` 建立工作区级别的上下文，内层 `Instance.provide` 在该工作区内建立项目实例上下文。`directory` 参数决定了哪个项目目录被激活——不同的 directory 值会初始化不同的数据库、加载不同的配置文件、扫描不同的 Skill。`InstanceBootstrap` 作为初始化函数，负责创建或打开项目对应的 SQLite 数据库、加载 `.opencode/config.json` 配置、初始化 MCP 客户端等。

客户端有两种方式传递项目信息：查询参数（`?workspace=xxx&directory=/path/to/project`）或请求头（`x-opencode-workspace` 和 `x-opencode-directory`）。查询参数通过 `||` 短路运算优先。当两者都未提供时，`process.cwd()` 作为 fallback。`directory` 还经过了 `decodeURIComponent` 处理和 `try/catch` 保护——路径中包含中文或特殊字符时不会导致请求失败。

这种设计使得一个桌面应用可以同时打开多个项目标签页，每个标签页的请求携带不同的 `directory`，Server 端为每个请求独立地创建项目上下文。从架构角度看，这避免了为每个项目启动一个独立 Server 进程的资源浪费，同时通过上下文隔离保证了数据安全性。

## 14.4 认证与 CORS

OpenCode 支持可选的 HTTP Basic Auth 保护，通过环境变量配置：

```typescript
// 文件: packages/opencode/src/server/server.ts L77-85
.use((c, next) => {
  if (c.req.method === "OPTIONS") return next()
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return next()
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return basicAuth({ username, password })(c, next)
})
```

OPTIONS 预检请求跳过认证是 CORS 协议的必要支持——浏览器在发送带 `Authorization` 头的跨域请求前，会先发一个 OPTIONS 请求探测服务器是否允许。如果这个预检请求也要求认证，浏览器客户端将永远无法通过。

CORS 策略精确控制允许的来源，支持四种类型的 origin：localhost 开发服务器、`127.0.0.1` 本机回环、Tauri 桌面应用的三种 URI 形式（`tauri://localhost`、`http://tauri.localhost`、`https://tauri.localhost`），以及 `*.opencode.ai` 域名。此外还支持通过 `opts.cors` 传入自定义的额外允许来源。

## 14.5 路由模块化组织

OpenCode 的路由采用模块化组织，每个功能域独立封装为 Route 模块。上下文中间件将路由分为两组——上下文建立之前的全局路由和之后的业务路由：

```typescript
// 文件: packages/opencode/src/server/server.ts L129-254
// 全局路由（不需要项目上下文）
.route("/global", GlobalRoutes())

// 认证路由（不需要项目上下文）
.put("/auth/:providerID", ...)
.delete("/auth/:providerID", ...)

// --- 上下文中间件在此 ---

// 业务路由（需要项目上下文）
.route("/project", ProjectRoutes())
.route("/session", SessionRoutes())
.route("/pty", PtyRoutes())
.route("/mcp", McpRoutes())
.route("/config", ConfigRoutes())
.route("/provider", ProviderRoutes())
.route("/permission", PermissionRoutes())
.route("/question", QuestionRoutes())
.route("/experimental", ExperimentalRoutes())
.route("/", FileRoutes())
.route("/", EventRoutes())
.route("/tui", TuiRoutes())
```

Session 路由是其中最复杂的模块，位于 `routes/session.ts`，提供了近 20 个端点。以消息发送为例，`POST /:sessionID/message` 使用 Hono 的 `stream` API 实现长连接响应——客户端发送 prompt 后，服务端保持连接直到 AI 回复完成：

```typescript
// 文件: packages/opencode/src/server/routes/session.ts L811-821
.post("/:sessionID/message", ...,
  async (c) => {
    c.status(200)
    c.header("Content-Type", "application/json")
    return stream(c, async (stream) => {
      const sessionID = c.req.valid("param").sessionID
      const body = c.req.valid("json")
      const msg = await SessionPrompt.prompt({ ...body, sessionID })
      stream.write(JSON.stringify(msg))
    })
  },
)
```

与之对应的 `POST /:sessionID/prompt_async` 则使用 "fire and forget" 模式——立即返回 204，AI 处理在后台进行，客户端通过 SSE 事件流获取进度。Session 路由还包括 fork（分叉会话）、revert（撤销消息）、share/unshare（会话分享）、summarize（会话压缩）等高级操作，以及分页消息查询（支持 `limit` 和基于 cursor 的 `before` 参数）。

每个路由模块都用 `lazy()` 包装，确保路由定义在首次访问时才执行，避免启动时的不必要开销。

除了模块化路由，Server 还直接挂载了若干独立端点：`/agent`（Agent 列表）、`/skill`（技能列表）、`/command`（命令列表）、`/path`（路径信息）、`/vcs`（版本控制状态）、`/lsp`（LSP 状态）、`/formatter`（格式化器状态）等。

## 14.6 SSE 事件流

实时事件推送是 OpenCode 前后端通信的核心。Server 通过 `/event` 端点提供 Server-Sent Events 流，实现位于独立的 `EventRoutes` 模块中：

```typescript
// 文件: packages/opencode/src/server/routes/event.ts L14-85
export const EventRoutes = lazy(() =>
  new Hono().get("/event", ..., async (c) => {
    c.header("X-Accel-Buffering", "no")
    c.header("X-Content-Type-Options", "nosniff")
    return streamSSE(c, async (stream) => {
      const q = new AsyncQueue<string | null>()
      let done = false

      q.push(JSON.stringify({ type: "server.connected", properties: {} }))

      const heartbeat = setInterval(() => {
        q.push(JSON.stringify({ type: "server.heartbeat", properties: {} }))
      }, 10_000)

      const unsub = Bus.subscribeAll((event) => {
        q.push(JSON.stringify(event))
        if (event.type === Bus.InstanceDisposed.type) { stop() }
      })

      const stop = () => {
        if (done) return
        done = true
        clearInterval(heartbeat)
        unsub()
        q.push(null)  // null 作为终止信号
      }
      stream.onAbort(stop)

      try {
        for await (const data of q) {
          if (data === null) return
          await stream.writeSSE({ data })
        }
      } finally { stop() }
    })
  }),
)
```

这个实现使用了 `AsyncQueue` 作为事件的缓冲通道。Bus 事件订阅回调将事件 JSON 推入队列，SSE 写入循环从队列中逐条读取并发送。`AsyncQueue` 是一个异步可迭代队列，当队列为空时 `for await` 循环会挂起等待新数据，当收到 `null` 终止信号时循环退出。这种生产者-消费者模式将事件的生产（Bus 回调）和消费（SSE 写入）解耦，避免了在 Bus 回调中直接执行可能阻塞的 IO 操作。

10 秒的心跳间隔是在多种约束之间权衡的结果。大多数反向代理（Nginx、Cloudflare、AWS ALB）的默认读取超时在 60 到 120 秒之间，10 秒远低于这些阈值。`X-Accel-Buffering: no` 头部专门针对 Nginx，禁用其响应缓冲以确保事件实时到达客户端。

连接的生命周期管理通过 `stop()` 函数统一处理，它清理定时器、取消 Bus 订阅、向队列推送终止信号。`done` 标志位保证 `stop()` 的幂等性——无论是客户端主动断开（`stream.onAbort`）、实例被销毁（`InstanceDisposed` 事件）还是正常结束，清理逻辑只执行一次。`finally` 块确保即使 `writeSSE` 抛出异常，资源也能被正确释放。

## 14.7 WebSocket 与 PTY

除 SSE 外，Server 还集成了 Bun 原生 WebSocket 支持：

```typescript
// 文件: packages/opencode/src/server/server.ts L536-579
export function listen(opts: { port: number; hostname: string; mdns?: boolean }) {
  const app = createApp(opts)
  const args = {
    hostname: opts.hostname,
    idleTimeout: 0,
    fetch: app.fetch,
    websocket: websocket,
  } as const
  const tryServe = (port: number) => {
    try { return Bun.serve({ ...args, port }) }
    catch { return undefined }
  }
  const server = opts.port === 0
    ? (tryServe(4096) ?? tryServe(0))
    : tryServe(opts.port)
  if (!server) throw new Error(`Failed to start server on port ${opts.port}`)
}
```

端口选择逻辑中有一个有趣的细节：当 `opts.port === 0`（表示自动选择端口）时，Server 会先尝试 4096 端口，失败后才回退到系统分配。这让开发环境中的端口更加可预测，减少了客户端配置的麻烦。`idleTimeout: 0` 禁用了 Bun 的空闲超时，因为 PTY 会话可能在用户思考时长时间没有数据传输，但连接不应该被关闭。

WebSocket 在 OpenCode 中的主要用途是支持 PTY（pseudo-terminal）功能。SSE 是单向的（服务端到客户端），无法满足 PTY 的双向通信需求。Bun 的 WebSocket 实现直接构建在其底层的 IO 事件循环中，不需要额外的 WebSocket 库（如 `ws`），每个连接的内存开销和延迟都极低。

## 14.8 mDNS 服务发现

Server 启动时还支持 mDNS 发布，使用 `bonjour-service` 库实现：

```typescript
// 文件: packages/opencode/src/server/mdns.ts L10-44
export function publish(port: number, domain?: string) {
  if (currentPort === port) return     // 幂等保护
  if (bonjour) unpublish()             // 先清理旧服务

  const host = domain ?? "opencode.local"
  const name = `opencode-${port}`
  bonjour = new Bonjour()
  const service = bonjour.publish({
    name, type: "http", host, port,
    txt: { path: "/" },
  })
  service.on("up", () => { log.info("mDNS service published", { name, port }) })
  service.on("error", (err) => { log.error("mDNS service error", { error: err }) })
  currentPort = port
}
```

mDNS 发布的条件检查确保了行为与 Server 的实际可达性一致：当 hostname 为 `127.0.0.1`、`localhost` 或 `::1` 时不发布，因为外部设备无法访问。Server 停止时通过覆写 `server.stop` 方法确保 mDNS 服务被正确注销：

```typescript
// 文件: packages/opencode/src/server/server.ts L572-577
const originalStop = server.stop.bind(server)
server.stop = async (closeActiveConnections?: boolean) => {
  if (shouldPublishMDNS) MDNS.unpublish()
  return originalStop(closeActiveConnections)
}
```

## 14.9 OpenAPI 文档与 Proxy Fallback

OpenCode 使用 `hono-openapi` 自动生成 OpenAPI 3.1.1 规范文档。每个路由通过 `describeRoute` 声明元数据，`resolver` 函数将 Zod schema 转换为 JSON Schema，实现文档与运行时验证的统一。`operationId` 采用 `资源.操作` 的命名约定（如 `session.create`、`permission.respond`），为 SDK 代码生成提供标准化基础。

错误响应也通过 `errors()` 辅助函数标准化声明：

```typescript
// 文件: packages/opencode/src/server/error.ts L34-36
export function errors(...codes: number[]) {
  return Object.fromEntries(codes.map((code) => [code, ERRORS[code as keyof typeof ERRORS]]))
}
```

路由链的最后一环是 proxy fallback——所有未匹配的请求会被代理到 `app.opencode.ai`，并附加 Content-Security-Policy 头部。这使得 OpenCode Server 同时充当了 Web 应用的代理服务器，用户可以直接在浏览器中访问 Server 地址获取完整的 Web UI，无需额外部署前端资源。

## 14.10 本章要点

- OpenCode 选择 Hono 框架，获得轻量级、Bun 原生和丰富中间件的优势
- 中间件链严格分层：错误处理 → 认证 → 日志 → CORS → 全局路由 → 上下文建立 → 业务路由 → proxy fallback
- workspace/directory 中间件通过双层上下文嵌套支持单进程多项目并发，`directory` 参数支持查询参数和请求头两种传递方式
- SSE 事件流使用 `AsyncQueue` 作为缓冲通道，将 Bus 事件的生产和 SSE 写入的消费解耦，`stop()` 函数通过 `done` 标志位保证清理的幂等性
- Session 路由提供同步和异步两种 prompt 模式：`POST /message` 保持长连接直到回复完成，`POST /prompt_async` 立即返回 204
- WebSocket 为 PTY 伪终端提供全双工通信，端口选择优先尝试 4096 以提高可预测性
- mDNS 服务发现仅在非 loopback 监听时启用，Server 停止时通过覆写 `stop` 方法确保 mDNS 注销
- OpenAPI 文档自动生成，未匹配路由代理到 `app.opencode.ai` 实现 Web UI 的透明服务
