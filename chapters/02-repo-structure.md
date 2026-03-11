# 第 2 章　仓库结构与模块依赖

理解一个项目的目录结构是深入阅读源码的第一步。OpenCode 采用 Monorepo 架构，包含近 20 个子包，核心业务逻辑集中在 `packages/opencode` 中。本章将详细梳理仓库的目录布局、核心模块的职责划分以及模块间的依赖关系。

## 2.1 Monorepo 总览

OpenCode 使用 Turborepo + Bun workspace 管理 Monorepo，顶层目录结构如下：

```
opencode/
├── packages/           # 所有子包
│   ├── opencode/       # 核心包：业务逻辑、Agent、Server
│   ├── app/            # Web UI 共享组件（SolidJS）
│   ├── console/        # 控制台前端
│   ├── desktop/        # Tauri 桌面应用（封装 app）
│   ├── desktop-electron/  # Electron 桌面应用
│   ├── sdk/            # @opencode-ai/sdk 客户端 SDK
│   ├── plugin/         # @opencode-ai/plugin 插件接口
│   ├── util/           # @opencode-ai/util 通用工具
│   ├── web/            # 官网前端
│   ├── docs/           # 文档站点
│   ├── ui/             # UI 组件库
│   ├── enterprise/     # 企业版功能
│   ├── extensions/     # 编辑器扩展
│   ├── identity/       # 身份认证服务
│   ├── function/       # 云函数
│   ├── slack/          # Slack 集成
│   └── ...
├── script/             # 构建和部署脚本
├── infra/              # 基础设施配置
├── github/             # GitHub 相关配置
├── sst.config.ts       # SST 部署配置
├── turbo.json          # Turborepo 配置
└── package.json        # 根 package.json
```

其中 `packages/opencode` 是整个项目的核心，所有 AI 编程助手的业务逻辑都在这里实现。其 `package.json` 中的 `name` 字段为 `"opencode"`，版本为 `1.2.24`。

## 2.2 核心模块分布

`packages/opencode/src/` 目录下的模块按职责清晰划分，共包含约 30 个顶层模块：

```
src/
├── agent/        # Agent 定义与管理（build, plan, general, explore 等）
├── session/      # 会话管理、消息处理、System Prompt、LLM 调用
├── tool/         # 内置工具集（bash, read, edit, grep, glob, lsp 等）
├── skill/        # 技能系统（可复用的 Prompt + 工具组合）
├── acp/          # Agent Client Protocol 实现
├── mcp/          # Model Context Protocol 集成
├── server/       # Hono HTTP 服务端与路由
├── storage/      # SQLite 数据库与 Drizzle ORM
├── bus/          # 事件总线系统
├── worktree/     # Git worktree 管理
├── cli/          # 命令行入口与 TUI 界面
├── config/       # 配置加载与合并（支持多级配置）
├── provider/     # LLM 提供商抽象与适配
├── permission/   # 权限控制系统
├── project/      # 项目实例管理与生命周期
├── plugin/       # 插件系统
├── lsp/          # Language Server Protocol 集成
├── file/         # 文件监控与管理
├── snapshot/     # 代码快照
├── share/        # 会话分享功能
├── format/       # 代码格式化
├── auth/         # 认证管理
├── env/          # 环境变量处理
├── flag/         # 功能标记（Feature Flags）
├── global/       # 全局路径与状态
├── command/      # 命令注册与执行
├── question/     # 用户交互问答
├── scheduler/    # 任务调度器
├── pty/          # 伪终端管理
└── util/         # 通用工具（git, filesystem, log, context 等）
```

每个模块通常包含一个主文件（如 `index.ts`）和相关的子文件。以 `tool/` 为例，它为每个内置工具都准备了一个 `.ts` 实现文件和一个 `.txt` 描述文件（用作 LLM 的工具描述）。

## 2.3 模块依赖关系

OpenCode 的模块依赖呈清晰的分层结构：

```
                      ┌─────────┐
                      │   cli   │  ← 用户交互层
                      └────┬────┘
                           │
                      ┌────▼────┐
                      │  server │  ← HTTP API 层（Hono）
                      └────┬────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         ┌────▼───┐  ┌────▼────┐  ┌────▼────┐
         │ session │  │  agent  │  │  tool   │  ← 业务逻辑层
         └────┬────┘  └────┬────┘  └────┬────┘
              │            │            │
         ┌────▼────────────▼────────────▼────┐
         │         provider / config          │  ← 基础设施层
         └────────────────┬──────────────────┘
                          │
         ┌────────────────▼──────────────────┐
         │   storage / bus / project / util   │  ← 底层服务层
         └───────────────────────────────────┘
```

几个关键的依赖关系值得注意：

- **`project/instance.ts`** 是核心的上下文管理器，几乎所有模块都依赖它来获取当前项目实例的信息。`Instance.state()` 方法用于创建与实例生命周期绑定的状态。
- **`bus/`** 提供事件总线，模块间通过事件进行松耦合通信，而非直接调用。
- **`agent/`** 依赖 `provider/`（获取模型）、`permission/`（权限规则）和 `skill/`（技能目录）。
- **`session/`** 是最复杂的模块之一，它编排 Agent、Tool 和 Provider 完成一次完整的对话流程。

## 2.4 入口文件与启动流程

OpenCode 的启动从 CLI 命令开始，经过以下关键步骤：

```
opencode 命令
  → cli/cmd/run.ts（或 serve.ts）
    → cli/bootstrap.ts :: bootstrap(directory, callback)
      → Instance.provide({ directory, init: InstanceBootstrap })
        → project/bootstrap.ts :: InstanceBootstrap()
```

`InstanceBootstrap` 是实例初始化的核心函数，它按顺序启动所有子系统：

```typescript
// packages/opencode/src/project/bootstrap.ts
export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()        // 1. 加载插件
  ShareNext.init()           // 2. 初始化分享模块
  Format.init()              // 3. 初始化代码格式化
  await LSP.init()           // 4. 启动 Language Server
  FileWatcher.init()         // 5. 启动文件监听
  File.init()                // 6. 初始化文件系统
  Vcs.init()                 // 7. 初始化版本控制
  Snapshot.init()            // 8. 初始化快照系统
  Truncate.init()            // 9. 初始化截断工具

  // 监听命令执行事件
  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })
}
```

> **源码位置**：packages/opencode/src/project/bootstrap.ts

启动完成后，Hono Server 开始监听请求。服务端导入了大量路由模块，提供 Session、Config、Provider、File、MCP 等 RESTful API：

```typescript
// packages/opencode/src/server/server.ts（部分导入）
import { SessionRoutes } from "./routes/session"
import { ConfigRoutes } from "./routes/config"
import { ProviderRoutes } from "./routes/provider"
import { McpRoutes } from "./routes/mcp"
import { FileRoutes } from "./routes/file"
import { PtyRoutes } from "./routes/pty"
// ...
```

> **源码位置**：packages/opencode/src/server/server.ts

这种 Client/Server 分离的架构意味着 TUI 只是一个客户端，未来可以有 Web、桌面、移动端等多种客户端连接同一个 Server。

## 2.5 实战：从源码构建 OpenCode

以下是从零开始构建 OpenCode 的完整步骤：

```bash
# 1. 克隆仓库
git clone https://github.com/anomalyco/opencode.git
cd opencode

# 2. 安装依赖（需要 Bun 1.3+）
bun install

# 3. 启动开发模式（默认在 packages/opencode 目录运行）
bun dev

# 4. 针对指定目录运行
bun dev /path/to/your/project

# 5. 针对 opencode 仓库本身运行
bun dev .

# 6. 编译独立可执行文件
./packages/opencode/script/build.ts --single

# 7. 运行编译产物
./packages/opencode/dist/opencode-darwin-arm64/bin/opencode
```

开发模式下 `bun dev` 会直接执行 TypeScript 源码（Bun 原生支持），无需编译步骤，修改代码后重启即可生效。

## 本章要点

- OpenCode 采用 Turborepo + Bun workspace 管理 Monorepo，核心包位于 `packages/opencode`。
- `src/` 下约 30 个模块按职责清晰分层：CLI → Server → Session/Agent/Tool → Provider/Config → Storage/Bus/Util。
- `Instance` 是核心上下文管理器，通过 `Instance.state()` 和 `Instance.provide()` 管理实例级状态和生命周期。
- 启动流程为 CLI → `bootstrap()` → `Instance.provide()` → `InstanceBootstrap()`，依次初始化 Plugin、LSP、FileWatcher 等子系统。
- 开发时使用 `bun install && bun dev` 即可启动，Bun 原生支持 TypeScript 无需额外编译。
