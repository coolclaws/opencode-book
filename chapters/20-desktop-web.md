# 第 20 章　Desktop 与 Web 客户端

OpenCode 不仅提供终端界面，还拥有完整的 Desktop 桌面客户端和 Web 客户端。本章将分析这两种客户端的架构设计、与后端的通信机制，以及 ACP 协议如何统一不同客户端的连接方式。

## 20.1 Desktop App 架构

### 20.1.1 基于 Tauri 的桌面应用

OpenCode Desktop 采用 **Tauri 2.0** 构建，而非更常见的 Electron。Tauri 使用系统原生 WebView 而非捆绑 Chromium，显著减小了应用体积。

> **源码位置**：`packages/desktop/src/index.tsx`

```typescript
import { getCurrentWindow } from "@tauri-apps/api/window"
import { readImage } from "@tauri-apps/plugin-clipboard-manager"
import { open, save } from "@tauri-apps/plugin-dialog"
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"
import { open as shellOpen } from "@tauri-apps/plugin-shell"
import { Store } from "@tauri-apps/plugin-store"
import { check, type Update } from "@tauri-apps/plugin-updater"
import { render } from "solid-js/web"
```

Desktop 应用同样使用 SolidJS 作为前端框架，与 TUI 共享相同的响应式理念，但渲染目标是浏览器 DOM 而非终端。

### 20.1.2 Platform 抽象层

Desktop 客户端通过 `Platform` 接口抽象平台相关操作，使上层 UI 代码无需关心运行环境差异：

```typescript
const createPlatform = (): Platform => {
  return {
    platform: "desktop",
    os,                           // "macos" | "windows" | "linux"
    version: pkg.version,

    // 文件系统对话框
    async openDirectoryPickerDialog(opts) {
      return await open({ directory: true, multiple: opts?.multiple ?? false })
    },

    // 外部链接
    openLink(url: string) {
      void shellOpen(url)
    },

    // 持久化存储（基于 Tauri Store 插件）
    storage: (name = "default.dat") => createStorage(name),

    // 自动更新
    checkUpdate: async () => {
      const next = await check()
      if (!next) return { updateAvailable: false }
      await next.download()
      return { updateAvailable: true, version: next.version }
    },

    // 系统通知
    notify: async (title, description, href) => {
      const notification = new Notification(title, { body: description })
      notification.onclick = () => {
        getCurrentWindow().setFocus()
        handleNotificationClick(href)
      }
    },

    // 使用 Tauri 的 HTTP 插件绕过浏览器 CORS 限制
    fetch: (input, init) => tauriFetch(input, init),
  }
}
```

### 20.1.3 Sidecar 服务管理

Desktop 应用内嵌了 OpenCode 服务端作为 **Sidecar** 进程。应用启动时等待 Sidecar 就绪：

```typescript
function ServerGate(props: { children: (data: ServerReadyData) => JSX.Element }) {
  const [serverData] = createResource(() =>
    commands.awaitInitialization(new Channel<InitStep>() as any)
  )

  return (
    <Show
      when={serverData.state !== "pending" && serverData()}
      fallback={
        <div class="h-screen flex items-center justify-center">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      {(data) => props.children(data())}
    </Show>
  )
}
```

启动流程：

```
Tauri 应用启动
  → 启动 Sidecar（OpenCode 服务端进程）
  → awaitInitialization 等待服务就绪
  → 获取 ServerReadyData（URL、认证信息）
  → 渲染 AppInterface
```

### 20.1.4 Electron 版本

OpenCode 还维护了一个 Electron 版本作为备选方案：

> **源码位置**：`packages/desktop-electron/src/`

```
packages/desktop-electron/src/
├── main/          # Electron 主进程
├── preload/       # 预加载脚本（安全桥接）
└── renderer/      # 渲染进程（共享 UI 组件）
```

Electron 版本复用了相同的 `@opencode-ai/app` UI 组件包，仅替换了平台层实现。

### 20.1.5 WSL 支持

在 Windows 平台，Desktop 客户端还支持 WSL（Windows Subsystem for Linux）环境。文件路径在 Windows 和 Linux 之间自动转换：

```typescript
const handleWslPicker = async <T extends string | string[]>(
  result: T | null,
): Promise<T | null> => {
  if (!result || !window.__OPENCODE__?.wsl) return result
  if (Array.isArray(result)) {
    return Promise.all(
      result.map((path) => commands.wslPath(path, "linux"))
    ) as any
  }
  return commands.wslPath(result, "linux") as any
}
```

## 20.2 Web 客户端

### 20.2.1 Web 包架构

Web 客户端独立于 Desktop，拥有自己的包结构：

> **源码位置**：`packages/web/src/`

```
packages/web/src/
├── assets/         # 静态资源
├── components/     # Web 专用组件
├── content/        # 内容管理
├── middleware.ts   # 请求中间件
├── pages/          # 页面路由
├── styles/         # 样式文件
└── types/          # 类型定义
```

### 20.2.2 共享 UI 组件

Desktop 和 Web 客户端共享 `@opencode-ai/app` 和 `@opencode-ai/ui` 两个 UI 包：

```
packages/app/       # 应用级组件（会话、侧边栏、设置）
packages/ui/        # 基础 UI 组件（Logo、按钮、表单）
```

这种分层确保了跨平台的视觉一致性。核心交互逻辑在 `packages/app` 中，平台差异通过 `PlatformProvider` 注入。

### 20.2.3 服务端代理

Web 客户端通过 OpenCode 服务端提供的 HTTP API 进行通信。服务端基于 Hono 框架构建：

> **源码位置**：`packages/opencode/src/server/server.ts`

```typescript
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { cors } from "hono/cors"
import { basicAuth } from "hono/basic-auth"
import { websocket } from "hono/bun"

export namespace Server {
  export const createApp = (opts: { cors?: string[] }): Hono => {
    const app = new Hono()
    return app
      .use((c, next) => {
        // Basic Auth 保护
        const password = Flag.OPENCODE_SERVER_PASSWORD
        if (!password) return next()
        return basicAuth({ username, password })(c, next)
      })
      // ... 路由注册
  }
}
```

## 20.3 ACP 协议连接

### 20.3.1 连接模式

Desktop 和 Web 客户端通过统一的连接模式与后端通信：

```typescript
// Desktop：Sidecar 模式（本地进程通信）
const server: ServerConnection.Any = data.is_sidecar
  ? {
      displayName: "Local",
      type: "sidecar",
      variant: "base",
      http,
    }
  : { type: "http", http }
```

三种连接模式：

| 模式 | 场景 | 特点 |
|------|------|------|
| **Sidecar** | Desktop 内嵌 | 自动管理生命周期，无需手动配置 |
| **HTTP** | 远程服务器 | 通过 URL 连接，支持 Basic Auth |
| **Default** | 默认连接 | 用户可配置默认服务器地址 |

### 20.3.2 多服务器管理

Desktop 客户端支持连接多个 OpenCode 服务实例：

```typescript
<AppInterface
  defaultServer={defaultServer.latest ?? ServerConnection.key(server)}
  servers={[server]}
>
  <Inner />
</AppInterface>
```

用户可以在不同项目的服务实例之间切换，每个实例维护独立的 session、配置和 MCP 连接。

## 20.4 前后端通信

### 20.4.1 HTTP API

OpenCode 服务端提供完整的 REST API，路由按功能模块划分：

```
packages/opencode/src/server/routes/
├── session.ts       # 会话管理 CRUD
├── provider.ts      # Provider 与模型管理
├── config.ts        # 配置读写
├── file.ts          # 文件操作
├── mcp.ts           # MCP 服务器管理
├── pty.ts           # 伪终端（Web 终端）
├── permission.ts    # 权限请求处理
├── question.ts      # 用户交互问答
├── project.ts       # 项目管理
├── workspace.ts     # 工作区管理
├── tui.ts           # TUI 专用路由
└── experimental.ts  # 实验性功能
```

### 20.4.2 SSE 实时推送

界面状态的实时更新依赖 SSE（Server-Sent Events）：

```typescript
// 服务端使用 Hono 的 streamSSE 推送事件
import { streamSSE } from "hono/streaming"

// 客户端 SyncProvider 订阅事件流
// 事件类型包括：
// - session.created / session.updated / session.deleted
// - message.created / message.updated
// - part.created / part.updated
// - permission.requested / permission.resolved
// - mcp.status / lsp.status
```

### 20.4.3 WebSocket 支持

对于需要双向实时通信的场景（如 PTY 终端），使用 WebSocket：

```typescript
import { websocket } from "hono/bun"

// PTY 路由提供 WebSocket 端点
// 用于 Web 客户端的内嵌终端功能
```

### 20.4.4 数据同步架构

```
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

所有客户端（TUI、Desktop、Web）共享同一个后端服务，通过相同的 HTTP API 和 SSE 事件流通信，确保状态一致性。

## 20.5 实战：本地启动 Desktop 客户端

### 步骤一：克隆项目

```bash
git clone https://github.com/anomalyco/opencode.git
cd opencode
```

### 步骤二：安装依赖

```bash
# 安装所有包的依赖
bun install

# Desktop 需要 Tauri CLI
cargo install tauri-cli
```

### 步骤三：启动开发模式

```bash
# 方式一：启动 Desktop（Tauri）
cd packages/desktop
bun run dev

# 方式二：启动 Web 客户端
cd packages/web
bun run dev

# 方式三：仅启动服务端
opencode serve --port 4096
```

### 步骤四：连接远程服务器

如果服务端运行在远程机器上：

```bash
# 远程机器启动服务
opencode serve --port 4096 --hostname 0.0.0.0

# 设置 Basic Auth 保护
OPENCODE_SERVER_PASSWORD=mysecret opencode serve
```

Desktop 客户端可通过设置添加远程服务器连接。

### 步骤五：多项目管理

Desktop 客户端支持同时管理多个项目目录。通过侧边栏的项目切换功能，可以在不同工作区之间无缝切换，每个工作区维护独立的会话历史和配置。

## 20.6 本章要点

- **Desktop 客户端基于 Tauri 2.0** 构建，使用系统原生 WebView，应用体积远小于 Electron 方案；同时保留 Electron 版本作为备选
- **Platform 抽象层** 统一了文件对话框、存储、通知、更新等平台 API，上层 UI 代码通过 `PlatformProvider` 注入实现跨平台
- **Sidecar 模式** 让 Desktop 内嵌 OpenCode 服务端进程，启动时自动初始化，用户无需手动管理后端服务
- **所有客户端共享同一 HTTP API + SSE 事件流**，TUI、Desktop、Web 三端的数据同步机制完全一致
- **服务端路由模块化设计**，按功能域划分为 session、provider、config、mcp 等独立路由文件，便于维护和扩展
