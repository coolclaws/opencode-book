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

其中 `packages/opencode` 是整个项目的核心，所有 AI 编程助手的业务逻辑都在这里实现。其 `package.json` 中的 `name` 字段为 `"opencode"`，版本为 `1.2.27`，采用 ES Module 格式（`"type": "module"`）。

`packages/app` 包在架构中扮演着重要的复用角色。它包含了基于 SolidJS 构建的 UI 组件，这些组件在 Desktop 应用和 Web 控制台之间共享。`packages/desktop`（Tauri 版）和 `packages/desktop-electron`（Electron 版）都通过引用 `packages/app` 中的组件来构建各自的界面，避免了跨平台 UI 代码的重复。这种分层方式意味着对 `app` 包中组件的修改会同时反映到桌面端和 Web 端，保持多端体验的一致性。`packages/ui` 则提供更底层的 UI 原语——按钮、输入框、布局容器等基础组件，被 `app` 和其他前端包依赖。

`packages/sdk` 和 `packages/plugin` 这两个包定义了 OpenCode 的外部接口契约。`@opencode-ai/sdk` 提供客户端 SDK，让第三方应用能够通过编程方式与 OpenCode Server 交互；`@opencode-ai/plugin` 定义了插件接口类型，包括 `ToolDefinition`、`ToolContext` 等关键类型，插件作者只需安装这个包就能获得完整的类型提示。这种将接口定义和实现分离到不同包中的做法，避免了插件依赖整个 `opencode` 核心包，保持了轻量级的开发体验。

`script/` 目录包含项目的构建和运维脚本，主要包括：编译独立可执行文件的 `build.ts`（支持 `--single` 参数生成单文件产物）、版本号管理脚本（配合 npm publish 流程）、以及 CI/CD 相关的辅助脚本。这些脚本直接用 TypeScript 编写并通过 Bun 执行，体现了项目全栈 TypeScript 的理念。

## 2.2 核心模块分布

`packages/opencode/src/` 目录下的模块按职责清晰划分，共包含约 40 个顶层模块：

```
src/
├── agent/        # Agent 定义与管理（build, plan, general, explore 等）
├── session/      # 会话管理、消息处理、System Prompt、LLM 调用
├── tool/         # 内置工具集（bash, read, edit, grep, glob, lsp 等）
├── skill/        # 技能系统（可复用的 Prompt + 工具组合）
├── acp/          # Agent Client Protocol 实现
├── mcp/          # Model Context Protocol 集成
├── server/       # Hono HTTP 服务端与路由
├── storage/      # JSON 文件存储引擎
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
├── pty/          # 伪终端管理
├── shell/        # Shell 集成
├── account/      # 账户管理
├── control-plane/ # 控制面板（多工作区管理）
├── effect/       # 副作用管理（实例注册表）
├── installation/ # 安装检测与升级
├── patch/        # 运行时补丁
├── bun/          # Bun 运行时工具
├── filesystem/   # 文件系统抽象
├── ide/          # IDE 集成
└── util/         # 通用工具（git, filesystem, log, context, lock 等）
```

每个模块通常包含一个主文件（如 `index.ts`）和相关的子文件。以 `tool/` 为例，它为每个内置工具都准备了一个 `.ts` 实现文件和一个 `.txt` 描述文件（用作 LLM 的工具描述）。工具的完整列表包括：`apply_patch.ts`、`bash.ts`、`batch.ts`、`codesearch.ts`、`edit.ts`、`glob.ts`、`grep.ts`、`ls.ts`、`lsp.ts`、`multiedit.ts`、`plan.ts`、`question.ts`、`read.ts`、`skill.ts`、`task.ts`、`todo.ts`、`webfetch.ts`、`websearch.ts`、`write.ts`。将工具描述放在独立的 `.txt` 文件中而非代码字符串中，使得非工程师（如 Prompt 工程师）也能方便地调整工具描述，无需修改 TypeScript 代码。

`tool/registry.ts` 是工具注册的核心枢纽，它负责汇总所有内置工具、自定义工具和插件工具：

```typescript
// 文件: packages/opencode/src/tool/registry.ts L99-126
async function all(): Promise<Tool.Info[]> {
  const custom = await state().then((x) => x.custom)
  const config = await Config.get()
  const question = ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT)
    || Flag.OPENCODE_ENABLE_QUESTION_TOOL

  return [
    InvalidTool,
    ...(question ? [QuestionTool] : []),
    BashTool, ReadTool, GlobTool, GrepTool,
    EditTool, WriteTool, TaskTool,
    WebFetchTool, TodoWriteTool,
    WebSearchTool, CodeSearchTool, SkillTool,
    ApplyPatchTool,
    ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
    ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
    ...custom,
  ]
}
```

这段代码揭示了几个有趣的设计选择：`InvalidTool` 始终排在第一位，用于处理 LLM 调用了不存在的工具的情况；`QuestionTool` 仅在交互式客户端（app、cli、desktop）中启用，因为在 `opencode run` 这类非交互场景中无法向用户提问；`LspTool` 和 `BatchTool` 通过功能标记（Feature Flag）控制是否启用，体现了渐进式发布策略。`ApplyPatchTool` 是为 GPT-5 等特定模型准备的替代编辑工具——当检测到使用 `gpt-` 系列模型时会自动切换到 patch 格式的编辑方式。

## 2.3 数据存储架构

OpenCode 使用基于 JSON 文件的存储引擎进行数据持久化，核心实现位于 `src/storage/storage.ts`。数据按以下目录层级组织：

```
~/.local/share/opencode/storage/
├── project/          # 项目元数据
│   └── {projectID}.json
├── session/          # 会话信息（按项目分组）
│   └── {projectID}/
│       └── {sessionID}.json
├── message/          # 消息记录（按会话分组）
│   └── {sessionID}/
│       └── {messageID}.json
├── part/             # 消息组成部分（按消息分组）
│   └── {messageID}/
│       └── {partID}.json
├── session_diff/     # 会话代码变更摘要
│   └── {sessionID}.json
└── migration         # 迁移版本号（纯文本）
```

`Storage` 模块提供了四个核心操作：`read`、`write`、`update` 和 `list`，所有操作都通过文件锁（`Lock.read` / `Lock.write`）保证并发安全：

```typescript
// 文件: packages/opencode/src/storage/storage.ts L162-191
export async function read<T>(key: string[]) {
  const dir = await state().then((x) => x.dir)
  const target = path.join(dir, ...key) + ".json"
  return withErrorHandling(async () => {
    using _ = await Lock.read(target)
    const result = await Filesystem.readJson<T>(target)
    return result as T
  })
}

export async function write<T>(key: string[], content: T) {
  const dir = await state().then((x) => x.dir)
  const target = path.join(dir, ...key) + ".json"
  return withErrorHandling(async () => {
    using _ = await Lock.write(target)
    await Filesystem.writeJson(target, content)
  })
}
```

值得注意的是代码中使用了 `using` 关键字（TC39 Explicit Resource Management 提案），配合 `Lock` 实现了 RAII 风格的锁管理——锁在作用域结束时自动释放，避免了手动 `try/finally` 的繁琐。`Storage` 模块还内置了数据迁移机制，`MIGRATIONS` 数组中的每个迁移函数按顺序执行，迁移进度记录在 `migration` 文件中，确保升级时不会重复执行已完成的迁移。

这种细粒度的数据模型使得 OpenCode 可以精确重建任意时刻的对话状态，包括中间的工具调用过程，为会话恢复、分享和调试提供了坚实的数据基础。

## 2.4 模块依赖关系

OpenCode 的模块依赖呈清晰的分层结构：

```text
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

- **`project/instance.ts`** 是核心的上下文管理器，几乎所有模块都依赖它来获取当前项目实例的信息。`Instance.state()` 方法用于创建与实例生命周期绑定的状态。从源码中可以看到，`Bus`、`Config`、`Agent`、`ToolRegistry` 的状态初始化都使用了 `Instance.state()`，形成了统一的生命周期管理模式。

- **`bus/`** 提供事件总线，模块间通过事件进行松耦合通信，而非直接调用。事件总线的实现基于 `Instance.state()` 创建实例级的订阅表，订阅通过 `BusEvent.define()` 定义的类型安全事件。每个事件发布时同时通过 `GlobalBus.emit()` 广播到全局，使得跨 Instance 的事件监听（如 Server 层的 SSE 推送）成为可能。

- **`agent/`** 依赖 `provider/`（获取模型）、`permission/`（权限规则）、`skill/`（技能目录）和 `config/`（用户自定义 Agent 配置）。Agent 的状态初始化过程中会合并内置定义与用户配置，通过 `Permission.merge()` 叠加多层权限规则。

- **`session/`** 是最复杂的模块之一，它编排 Agent、Tool 和 Provider 完成一次完整的对话流程。

从具体的 import 关系来看，依赖方向严格遵循从上到下的分层原则。以 `session/` 模块为例，它引用了 `agent/`（获取 Agent 定义）、`tool/`（解析工具调用）、`provider/`（发起 LLM 请求）、`storage/`（持久化消息）和 `bus/`（发布事件）。而 `storage/` 和 `bus/` 等底层模块则不会反向引用 `session/`——它们只依赖 `project/` 和 `util/` 这样更基础的模块。这种单向依赖保证了模块可以独立测试和替换。`tool/` 模块中的每个工具也遵循同样的原则：它们可以引用 `util/filesystem`、`util/git` 等工具函数，但不会引用 `session/` 或 `agent/`，保持了工具执行逻辑与对话编排逻辑的解耦。

`control-plane/` 是一个较新的模块，负责多工作区管理。当 OpenCode 以 Server 模式运行时，`WorkspaceContext` 和 `WorkspaceRouterMiddleware` 允许单个 Server 进程管理多个项目目录——每个 HTTP 请求通过 `WorkspaceID` 路由到对应的 Instance 上下文。这种设计使得企业部署场景（一个共享 Server 服务多个开发者和项目）成为可能。

## 2.5 入口文件与启动流程

OpenCode 的启动从 CLI 命令开始，经过以下关键步骤：

```text
opencode 命令
  → cli/cmd/run.ts（或 serve.ts）
    → cli/bootstrap.ts :: bootstrap(directory, callback)
      → Instance.provide({ directory, init: InstanceBootstrap })
        → project/bootstrap.ts :: InstanceBootstrap()
```

`InstanceBootstrap` 是实例初始化的核心函数，它按顺序启动所有子系统：

```typescript
// 文件: packages/opencode/src/project/bootstrap.ts L1-31
export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()        // 1. 加载插件（最先，因为插件可能注册工具和 Provider）
  ShareNext.init()           // 2. 初始化分享模块
  Format.init()              // 3. 初始化代码格式化
  await LSP.init()           // 4. 启动 Language Server（await 因为需等待进程握手）
  File.init()                // 5. 初始化文件系统
  FileWatcher.init()         // 6. 启动文件监听
  Vcs.init()                 // 7. 初始化版本控制（检测 Git 状态）
  Snapshot.init()            // 8. 初始化快照系统（注册编辑前自动保存）

  // 监听命令执行事件：首次 INIT 时标记项目已初始化
  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      Project.setInitialized(Instance.project.id)
    }
  })
}
```

> **源码位置**：packages/opencode/src/project/bootstrap.ts

初始化顺序经过精心设计。`Plugin.init()` 排在第一位且使用 `await`，因为插件可能注册新的工具或 Provider，后续的 LSP 初始化和文件监听都可能依赖插件提供的能力。`File.init()` 在 `FileWatcher.init()` 之前执行，因为文件系统模块的初始化需要建立基础索引，而 FileWatcher 在此基础上注册增量监听。`Snapshot.init()` 排在最后，它通过事件监听器在文件被编辑工具修改前自动保存快照——这依赖前面所有的文件和版本控制子系统就绪。

启动完成后，Hono Server 开始监听请求。从 `server.ts` 的导入列表可以看到路由的完整覆盖：

```typescript
// 文件: packages/opencode/src/server/server.ts L25-43
import { ProjectRoutes } from "./routes/project"
import { SessionRoutes } from "./routes/session"
import { PtyRoutes } from "./routes/pty"
import { McpRoutes } from "./routes/mcp"
import { FileRoutes } from "./routes/file"
import { ConfigRoutes } from "./routes/config"
import { ExperimentalRoutes } from "./routes/experimental"
import { ProviderRoutes } from "./routes/provider"
import { EventRoutes } from "./routes/event"
import { QuestionRoutes } from "./routes/question"
import { PermissionRoutes } from "./routes/permission"
import { GlobalRoutes } from "./routes/global"
```

> **源码位置**：packages/opencode/src/server/server.ts

每个路由模块对应一个功能域：`SessionRoutes` 处理会话的 CRUD 和消息流式推送，`PtyRoutes` 管理伪终端连接（用于 bash 工具的实时输出），`EventRoutes` 提供 SSE 端点供客户端订阅实时事件，`PermissionRoutes` 处理权限审批请求。Server 还集成了 CORS 支持（通过 `hono/cors`）和 WebSocket（通过 `hono/bun`），前者支持 Web 控制台的跨域请求，后者为桌面端提供低延迟的双向通信。

## 2.6 实战：从源码构建 OpenCode

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

开发模式下 `bun dev` 实际执行 `bun run --conditions=browser ./src/index.ts`，直接运行 TypeScript 源码（Bun 原生支持），无需编译步骤，修改代码后重启即可生效。`--conditions=browser` 这个标志的作用是在 `package.json` 的 `imports` 字段中选择正确的模块条件导出——例如 `#db` 在 `bun` 条件下解析到 `db.bun.ts`，在 `node` 条件下解析到 `db.node.ts`。

类型检查使用 `tsgo`（TypeScript Go 编译器的实验版本）而非标准的 `tsc`，从 `package.json` 中可以看到：`"typecheck": "tsgo --noEmit"`。这是一个值得关注的技术选型——tsgo 在大型 Monorepo 中的类型检查速度比 tsc 快数倍，对于 OpenCode 这样包含 40+ 模块的项目来说能显著缩短 CI 时间。

## 本章要点

- OpenCode 采用 Turborepo + Bun workspace 管理 Monorepo，核心包位于 `packages/opencode`，`packages/sdk` 和 `packages/plugin` 定义了外部接口契约。
- `packages/app` 提供跨平台共享 UI 组件，被 Desktop 和 Web 端复用，`packages/ui` 提供底层 UI 原语。
- `src/` 下约 40 个模块按职责清晰分层：CLI → Server → Session/Agent/Tool → Provider/Config → Storage/Bus/Util。
- 数据存储基于 JSON 文件，使用 `Lock` 实现并发安全读写，内置数据迁移机制（`MIGRATIONS`）支持自动升级。
- `ToolRegistry` 汇总内置工具、自定义工具和插件工具，通过 Feature Flag 控制实验性工具的启用。
- `Instance` 是核心上下文管理器，通过 `Instance.state()` 和 `Instance.provide()` 管理实例级状态和生命周期。
- 启动流程为 CLI → `bootstrap()` → `Instance.provide()` → `InstanceBootstrap()`，依次初始化 Plugin、LSP、FileWatcher 等子系统。
- 开发时使用 `bun install && bun dev` 即可启动，Bun 原生支持 TypeScript 无需额外编译。
