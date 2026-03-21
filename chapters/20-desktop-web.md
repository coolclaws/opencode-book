# 第 20 章　Desktop 与 Web 客户端

OpenCode 不仅提供终端界面，还拥有完整的 Desktop 桌面客户端和 Web 客户端。本章将分析这两种客户端的架构设计、与后端的通信机制，以及如何通过 Platform 抽象层统一不同客户端的连接方式。

## 20.1 Desktop App 架构

### 20.1.1 基于 Tauri 的桌面应用

OpenCode Desktop 采用 **Tauri 2.0** 构建，而非更常见的 Electron。Tauri 使用系统原生 WebView 而非捆绑 Chromium，显著减小了应用体积。

> **源码位置**：`packages/desktop/src/index.tsx`

```typescript
// 文件: packages/desktop/src/index.tsx L15-31
import { getCurrentWindow } from "@tauri-apps/api/window"
import { readImage } from "@tauri-apps/plugin-clipboard-manager"
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link"
import { open, save } from "@tauri-apps/plugin-dialog"
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification"
import { type as ostype } from "@tauri-apps/plugin-os"
import { open as shellOpen } from "@tauri-apps/plugin-shell"
import { Store } from "@tauri-apps/plugin-store"
import { check, type Update } from "@tauri-apps/plugin-updater"
import { createResource, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
```

Desktop 应用同样使用 SolidJS 作为前端框架，与 TUI 共享相同的响应式理念，但渲染目标是浏览器 DOM 而非终端。

选择 Tauri 而非 Electron 带来了几项关键优势。首先是内存占用：Electron 应用捆绑了完整的 Chromium 渲染引擎和 Node.js 运行时，一个空白窗口通常占用 80-150MB 内存；Tauri 利用操作系统自带的 WebView（macOS 上是 WebKit，Windows 上是 WebView2，Linux 上是 WebKitGTK），空白窗口内存占用通常在 20-40MB 范围内。其次是二进制体积：典型的 Electron 应用打包后至少 150MB 起步，而 Tauri 应用可以压缩到 10MB 以下。第三是安全模型：Tauri 采用基于权限的安全架构，每个插件都需要在 `tauri.conf.json` 中显式声明权限，未授权的 API 调用会被运行时拒绝。

### 20.1.2 Platform 抽象层

Desktop 客户端通过 `Platform` 接口抽象平台相关操作，使上层 UI 代码无需关心运行环境差异：

```typescript
// 文件: packages/desktop/src/index.tsx L62-96
const createPlatform = (): Platform => {
  const os = (() => {
    const type = ostype()
    if (type === "macos" || type === "windows" || type === "linux") return type
    return undefined
  })()

  return {
    platform: "desktop",
    os,
    version: pkg.version,

    async openDirectoryPickerDialog(opts) {
      const defaultPath = await wslHome()
      const result = await open({
        directory: true,
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
        defaultPath,
      })
      return await handleWslPicker(result)
    },

    openLink(url: string) {
      void shellOpen(url).catch(() => undefined)
    },

    fetch: (input, init) => {
      if (input instanceof Request) return tauriFetch(input)
      else return tauriFetch(input, init)
    },
  }
}
```

`Platform` 接口的关键设计在于它将所有平台差异收敛到一个对象上。上层的 `@opencode-ai/app` 组件通过 `PlatformProvider` 获取这个对象，之后所有操作——打开文件对话框、发起网络请求、读取剪贴板——都不再关心自己运行在 Tauri、Electron 还是浏览器中。`fetch` 方法尤其值得注意：浏览器的原生 `fetch` 受 CORS 策略限制，无法直接访问任意 API 端点，而 Tauri 的 HTTP 插件在 Rust 侧发起请求，完全绕过了浏览器沙箱的限制。

### 20.1.3 存储层：防抖批量写入

Desktop 客户端的持久化存储基于 Tauri Store 插件，但上层封装了一套带防抖的批量写入机制，避免高频写入导致磁盘 I/O 抖动：

```typescript
// 文件: packages/desktop/src/index.tsx L131-230
const WRITE_DEBOUNCE_MS = 250

const storeCache = new Map<string, Promise<StoreLike>>()
const apiCache = new Map<string, AsyncStorage & { flush: () => Promise<void> }>()

const flush = async () => {
  const store = await getStore(name)
  while (pending.size > 0) {
    const batch = Array.from(pending.entries())
    pending.clear()
    for (const [key, value] of batch) {
      if (value === null) await store.delete(key).catch(() => undefined)
      else await store.set(key, value).catch(() => undefined)
    }
  }
}
```

写入操作先缓存在内存中的 `pending` Map 里，每 250ms 执行一次批量刷盘。当页面即将隐藏（`visibilitychange` 事件）或卸载（`pagehide` 事件）时，立即触发 `flushAll` 确保数据不丢失。如果 Tauri Store 加载失败（例如文件损坏），系统自动降级到内存存储 `createMemoryStore`，保证应用仍可正常运行。

### 20.1.4 Sidecar 启动与加载窗口

Desktop 应用内嵌了 OpenCode 服务端作为 **Sidecar** 进程。应用启动分为两个阶段：先展示加载窗口，再切换到主界面。Tauri 通过 Specta 自动生成的 TypeScript 绑定与 Rust 侧通信：

```typescript
// 文件: packages/desktop/src/bindings.ts L7-11
export const commands = {
  killSidecar: () => __TAURI_INVOKE<void>("kill_sidecar"),
  installCli: () => __TAURI_INVOKE<string>("install_cli"),
  awaitInitialization: (events: Channel) =>
    __TAURI_INVOKE<ServerReadyData>("await_initialization", { events }),
}

export type InitStep =
  | { phase: "server_waiting" }
  | { phase: "sqlite_waiting" }
  | { phase: "done" }
```

加载窗口 `loading.tsx` 在 Sidecar 启动期间展示进度条，监听 SQLite 迁移进度事件实时更新百分比：

```typescript
// 文件: packages/desktop/src/loading.tsx L39-48
onMount(() => {
  const listener = events.sqliteMigrationProgress.listen((e) => {
    if (e.payload.type === "InProgress")
      setPercent(Math.max(0, Math.min(100, e.payload.value)))
    if (e.payload.type === "Done") setPercent(100)
  })
})
```

当 Sidecar 完全就绪后，`InitStep` 的 `phase` 变为 `"done"`，加载窗口通过 `loadingWindowComplete` 事件通知 Rust 侧关闭自己，主窗口接管渲染。`ServerReadyData` 包含 `url`、`username`、`password` 三个字段，主窗口据此建立与 Sidecar 的 HTTP 连接。

启动流程：

```text
┌────────────────┐    IPC     ┌──────────────────┐
│  Loading 窗口   │ ←────────→ │   Rust Sidecar    │
│  (loading.tsx)  │            │   管理进程         │
└───────┬────────┘            └────────┬─────────┘
        │ phase: done                  │ 启动 OpenCode
        ↓                             ↓ 服务端进程
┌────────────────┐    HTTP    ┌──────────────────┐
│   主窗口        │ ←────────→ │   OpenCode        │
│  (index.tsx)   │            │   Server          │
└────────────────┘            └──────────────────┘
```

### 20.1.5 Deep Link 与菜单系统

Desktop 客户端支持 Deep Link 协议，允许外部应用通过 URL scheme 触发 OpenCode 操作：

```typescript
// 文件: packages/desktop/src/index.tsx L48-60
const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  const pending = window.__OPENCODE__.deepLinks ?? []
  window.__OPENCODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}
```

应用启动时先检查是否有待处理的 Deep Link（`getCurrent()`），随后持续监听新的 Deep Link 事件。菜单系统通过 `createMenu` 在 Rust 侧创建原生菜单，菜单项点击后通过 `menuTrigger` 回调桥接到 SolidJS 的命令系统 `useCommand`。

### 20.1.6 WSL 支持与 Electron 备选

在 Windows 平台，Desktop 客户端支持 WSL（Windows Subsystem for Linux）环境。文件路径在 Windows 和 Linux 之间自动转换：

```typescript
// 文件: packages/desktop/src/index.tsx L74-80
const handleWslPicker = async <T extends string | string[]>(
  result: T | null,
): Promise<T | null> => {
  if (!result || !window.__OPENCODE__?.wsl) return result
  if (Array.isArray(result)) {
    return Promise.all(
      result.map((path) => commands.wslPath(path, "linux").catch(() => path))
    ) as any
  }
  return commands.wslPath(result, "linux").catch(() => result) as any
}
```

`commands.wslPath` 调用 Rust 侧的路径转换逻辑，将 `C:\Users\dev\project` 转换为 `/mnt/c/Users/dev/project`。`window.__OPENCODE__?.wsl` 标志位在 Tauri 初始化时设置，用于检测当前是否运行在 WSL 模式下。

OpenCode 还维护了一个 Electron 版本作为备选方案（`packages/desktop-electron/`），复用相同的 `@opencode-ai/app` UI 组件包，仅替换平台层实现。某些 Linux 发行版上 WebKitGTK 版本较旧，此时 Electron 自带的 Chromium 能确保一致的渲染行为。

## 20.2 Web 客户端与共享组件

### 20.2.1 共享 UI 架构

Desktop 和 Web 客户端共享两个核心 UI 包：

```text
┌──────────────────────────────────────────┐
│          packages/desktop (Tauri)         │
│          packages/web (Astro)             │
├──────────────────────────────────────────┤
│     packages/app (业务组件层)              │
│     SessionList, MessageStream,           │
│     Sidebar, Settings, DiffView           │
├──────────────────────────────────────────┤
│     packages/ui (基础 UI 组件)            │
│     Button, Input, Dialog, Toast          │
└──────────────────────────────────────────┘
```

`@opencode-ai/app` 包含所有与业务逻辑紧密相关的组件，内部调用 `usePlatform()` hook 获取当前平台的能力接口。`@opencode-ai/ui` 则是纯粹的 UI 基础组件库，与 OpenCode 业务完全解耦。平台特定代码集中在各自的入口包中——Desktop 版本实现 Tauri 相关的平台层，Web 版本实现浏览器原生的平台层（文件对话框使用 `<input type="file">`，存储使用 `localStorage`）。Web 版本不提供自动更新和系统通知功能。

## 20.3 服务端与通信协议

### 20.3.1 Hono 服务端架构

OpenCode 服务端基于 Hono 框架构建，提供完整的 REST API 并通过 hono-openapi 自动生成 OpenAPI 文档：

```typescript
// 文件: packages/opencode/src/server/server.ts L55-86
export const createApp = (opts: { cors?: string[] }): Hono => {
  const app = new Hono()
  return app
    .onError((err, c) => {
      if (err instanceof NamedError) {
        let status: ContentfulStatusCode
        if (err instanceof NotFoundError) status = 404
        else if (err instanceof Provider.ModelNotFoundError) status = 400
        else status = 500
        return c.json(err.toObject(), { status })
      }
    })
    .use((c, next) => {
      if (c.req.method === "OPTIONS") return next()
      const password = Flag.OPENCODE_SERVER_PASSWORD
      if (!password) return next()
      const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
      return basicAuth({ username, password })(c, next)
    })
    .route("/session", SessionRoutes())
    .route("/config", ConfigRoutes())
    .route("/provider", ProviderRoutes())
    .route("/mcp", McpRoutes())
    .route("/pty", PtyRoutes())
}
```

路由按功能域划分为独立模块，CORS 配置默认允许 `localhost`、Tauri 来源和 `*.opencode.ai` 域名。未匹配的路径会被代理到 `app.opencode.ai`，返回时注入 CSP 安全头。

### 20.3.2 SSE 实时事件流

界面状态的实时更新依赖 SSE（Server-Sent Events），通过 `/event` 端点提供：

```typescript
// 文件: packages/opencode/src/server/routes/event.ts L31-84
return streamSSE(c, async (stream) => {
  const q = new AsyncQueue<string | null>()

  q.push(JSON.stringify({ type: "server.connected", properties: {} }))

  // 每 10 秒发送心跳防止代理超时
  const heartbeat = setInterval(() => {
    q.push(JSON.stringify({ type: "server.heartbeat", properties: {} }))
  }, 10_000)

  const unsub = Bus.subscribeAll((event) => {
    q.push(JSON.stringify(event))
    if (event.type === Bus.InstanceDisposed.type) stop()
  })

  for await (const data of q) {
    if (data === null) return
    await stream.writeSSE({ data })
  }
})
```

事件流采用 `AsyncQueue` 实现背压控制——当客户端消费速度跟不上事件产生速度时，事件会在队列中缓存而非丢弃。心跳机制每 10 秒发送一次 `server.heartbeat`，防止 Nginx 等反向代理因空闲超时断开连接。`Bus.subscribeAll` 订阅系统总线的所有事件，包括 `session.created`、`message.updated`、`part.created`、`permission.requested` 等。

### 20.3.3 连接模式与多服务器

Desktop 客户端支持 Sidecar 和远程 HTTP 两种连接模式：

```typescript
// 文件: packages/desktop/src/index.tsx L428-443
const servers = () => {
  const data = sidecar()
  if (!data) return []
  const http = {
    url: data.url,
    username: data.username ?? undefined,
    password: data.password ?? undefined,
  }
  const server: ServerConnection.Sidecar = {
    displayName: t("desktop.server.local"),
    type: "sidecar",
    variant: "base",
    http,
  }
  return [server] as ServerConnection.Any[]
}
```

用户可以通过 `getDefaultServer` / `setDefaultServer` 切换默认连接的服务实例，每个实例维护独立的 session、配置和 MCP 连接。

### 20.3.4 数据同步架构

```text
┌──────────────┐     HTTP/SSE     ┌──────────────┐
│  Desktop App │ ←────────────→  │   OpenCode    │
│  (Tauri)     │                  │   Server      │
└──────────────┘                  │   (Hono)      │
                                  │               │
┌──────────────┐     HTTP/SSE     │  ┌──────────┐ │
│   Web Client │ ←────────────→  │  │  SQLite   │ │
│  (Browser)   │                  │  └──────────┘ │
└──────────────┘                  │               │
                                  │  ┌──────────┐ │
┌──────────────┐     HTTP/SSE     │  │  Bus      │ │
│   TUI        │ ←────────────→  │  │  Events   │ │
│  (Terminal)  │                  │  └──────────┘ │
└──────────────┘                  └──────────────┘
```

所有客户端（TUI、Desktop、Web）共享同一个后端服务，通过相同的 HTTP API 和 SSE 事件流通信，确保状态一致性。PTY 终端场景使用 WebSocket 实现双向实时通信。

## 20.4 实战：本地启动 Desktop 客户端

### 步骤一：克隆与安装

```bash
git clone https://github.com/anomalyco/opencode.git
cd opencode
bun install
cargo install tauri-cli
```

### 步骤二：启动开发模式

```bash
# 启动 Desktop（Tauri）
cd packages/desktop && bun run dev

# 启动 Web 客户端
cd packages/web && bun run dev

# 仅启动服务端
opencode serve --port 4096
```

### 步骤三：连接远程服务器

```bash
# 远程机器启动服务
OPENCODE_SERVER_PASSWORD=mysecret opencode serve --port 4096 --hostname 0.0.0.0
```

Desktop 客户端可通过设置添加远程服务器连接，同时管理多个项目目录。

## 20.5 本章要点

- **Desktop 客户端基于 Tauri 2.0** 构建，使用系统原生 WebView，应用体积远小于 Electron 方案；同时保留 Electron 版本作为备选
- **Platform 抽象层** 统一了文件对话框、存储、通知、更新等平台 API，上层 UI 代码通过 `PlatformProvider` 注入实现跨平台
- **存储层采用防抖批量写入**，250ms 间隔刷盘，支持 Tauri Store 到内存存储的自动降级
- **Sidecar 启动分两阶段**：加载窗口监听 SQLite 迁移进度，主窗口等待 `ServerReadyData` 后渲染
- **SSE 事件流使用 AsyncQueue 背压控制** 和 10 秒心跳机制，所有客户端共享同一通信协议
