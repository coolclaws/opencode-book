# 第 1 章　项目概览与设计哲学

OpenCode 是一个 100% 开源的 AI 编程助手，定位为 Claude Code 的开源替代方案。它基于 TypeScript 和 Bun 运行时构建，采用 CLI-first 的交互方式，支持多种 LLM 提供商，并通过灵活的工具和技能系统实现可扩展性。本章将从宏观视角介绍 OpenCode 的核心定位、设计哲学和技术架构。

## 1.1 OpenCode 是什么：开源 AI 编程智能体

OpenCode 的官方定义非常简洁："The open source AI coding agent"——一个开源的 AI 编程智能体。它的核心能力与 Claude Code 高度相似：在终端中与 LLM 对话，让 AI 阅读代码、编辑文件、执行命令，从而辅助开发者完成编程任务。

与同类工具的关键区别在于，OpenCode 从第一行代码开始就是开源的（MIT 协议），并且不绑定任何特定的 AI 提供商。它的核心包位于 `packages/opencode`，使用 TypeScript 编写，运行在 Bun 之上。当前版本为 1.2.27，已经具备完整的生产级功能。

从代码入口可以看到 OpenCode 的启动非常简洁：

```typescript
// 文件: packages/opencode/src/cli/bootstrap.ts L1-15
import { InstanceBootstrap } from "../project/bootstrap"
import { Instance } from "../project/instance"

export async function bootstrap<T>(directory: string, cb: () => Promise<T>) {
  return Instance.provide({
    directory,
    init: InstanceBootstrap,
    fn: async () => {
      try {
        const result = await cb()
        return result
      } finally {
        await Instance.dispose()
      }
    },
  })
}
```

> **源码位置**：packages/opencode/src/cli/bootstrap.ts

`bootstrap` 函数接收一个工作目录和回调函数，通过 `Instance.provide` 创建项目实例上下文，执行 `InstanceBootstrap` 初始化流程，最后在回调结束时自动清理资源。这种基于上下文的生命周期管理贯穿整个项目。

`Instance.provide()` 的底层实现揭示了 OpenCode 对状态管理的独特思考。它使用一个精简的 `Context` 工具类，仅用 25 行代码就封装了 Node.js 的 `AsyncLocalStorage`：

```typescript
// 文件: packages/opencode/src/util/context.ts L1-25
import { AsyncLocalStorage } from "async_hooks"

export namespace Context {
  export class NotFound extends Error {
    constructor(public override readonly name: string) {
      super(`No context found for ${name}`)
    }
  }

  export function create<T>(name: string) {
    const storage = new AsyncLocalStorage<T>()
    return {
      use() {
        const result = storage.getStore()
        if (!result) {
          throw new NotFound(name)
        }
        return result
      },
      provide<R>(value: T, fn: () => R) {
        return storage.run(value, fn)
      },
    }
  }
}
```

每次调用 `Instance.provide()` 时，会创建一个新的异步上下文，在这个上下文内执行的所有代码——无论经历多少层 `async/await` 调用——都能通过 `Instance.current` 获取到同一个实例对象。`Instance` 还维护了一个 `cache: Map<string, Promise<Shape>>` 来缓存已启动的实例，相同目录的多次 `provide` 调用会复用同一个实例。这意味着在同一进程中可以同时服务多个项目目录（比如 Hono Server 同时处理不同 workspace 的请求），每个请求都有独立的 Instance 上下文，彼此不会互相干扰。

`Instance.state()` 方法更进一步，允许模块创建与 Instance 生命周期绑定的状态——当 Instance 被释放时，这些状态会自动清理，从而避免内存泄漏和资源悬挂。几乎所有核心模块（Bus、Config、Agent、ToolRegistry）都通过 `Instance.state()` 管理自己的状态。这套机制本质上是对依赖注入容器的轻量级替代，利用 JavaScript 运行时原生的异步上下文传播能力，省去了显式传递上下文对象的繁琐。相比 Spring 或 NestJS 那样的重量级 DI 框架，OpenCode 的方案更符合 TypeScript 社区"函数优先"的编程哲学。

## 1.2 设计哲学：CLI-first、Provider 无关、可扩展

OpenCode 的设计哲学可以归纳为三个核心原则：

### 1.2.1 CLI-first / TUI 原生

OpenCode 由 Neovim 用户和 [terminal.shop](https://terminal.shop) 的创建者打造。官方表述是："We are going to push the limits of what's possible in the terminal"。TUI（Terminal User Interface）不是降级体验，而是一等公民。项目使用 SolidJS 配合 [opentui](https://github.com/sst/opentui) 框架构建终端界面，代码位于 `packages/opencode/src/cli/cmd/tui/`，内部按 `component/`、`ui/`、`routes/`、`context/` 等子目录组织，完全采用组件化架构。

terminal.shop 团队在终端界面设计方面有着深厚积累——他们的 terminal.shop 咖啡购物网站本身就运行在终端中，以精美的 TUI 闻名于开发者社区。这种基因直接影响了 OpenCode 的设计取向：终端不是 Web 界面的简化版，而是经过精心设计的原生交互体验。OpenCode 的 TUI 支持 Vim 风格的键绑定、Leader Key 快捷键序列、实时流式渲染 Markdown，甚至包含一个类似 VS Code 的命令面板（通过 `Ctrl+K` 唤出）。选择 SolidJS 而非 React 来渲染终端界面，是因为 SolidJS 的细粒度响应式更新避免了虚拟 DOM diffing 的开销——在终端这种逐字符渲染的环境中，精确控制哪些区域需要重绘至关重要。

与此同时，OpenCode 的客户端/服务端分离架构确保了 TUI 只是众多客户端之一。桌面应用（基于 Tauri 和 Electron 双版本）、Web 控制台、甚至未来的移动端，都可以通过同一套 Hono HTTP API 与后端交互。CLI-first 并不意味着 CLI-only。

### 1.2.2 Provider 无关

OpenCode 采用 Vercel AI SDK 作为 LLM 调用层，通过统一的抽象支持几乎所有主流提供商。从 `provider/provider.ts` 中的 `BUNDLED_PROVIDERS` 映射表可以看到完整的内置适配器清单：

```typescript
// 文件: packages/opencode/src/provider/provider.ts L112-135
const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
  "@ai-sdk/amazon-bedrock": createAmazonBedrock,
  "@ai-sdk/anthropic": createAnthropic,
  "@ai-sdk/azure": createAzure,
  "@ai-sdk/google": createGoogleGenerativeAI,
  "@ai-sdk/google-vertex": createVertex,
  "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
  "@ai-sdk/openai": createOpenAI,
  "@ai-sdk/openai-compatible": createOpenAICompatible,
  "@openrouter/ai-sdk-provider": createOpenRouter,
  "@ai-sdk/xai": createXai,
  "@ai-sdk/mistral": createMistral,
  "@ai-sdk/groq": createGroq,
  "@ai-sdk/deepinfra": createDeepInfra,
  "@ai-sdk/cerebras": createCerebras,
  "@ai-sdk/cohere": createCohere,
  "@ai-sdk/togetherai": createTogetherAI,
  "@ai-sdk/perplexity": createPerplexity,
  "@ai-sdk/vercel": createVercel,
  "gitlab-ai-provider": createGitLab,
}
```

这意味着用户可以自由切换 Claude、GPT、Gemini、Groq、Mistral、DeepInfra、Cerebras 甚至本地模型。比较而言，Claude Code 只支持 Anthropic 模型，GitHub Copilot 绑定 OpenAI/GitHub 模型，而 Cursor 虽然支持多提供商但作为闭源产品无法自由扩展。OpenCode 的 Provider 体系还支持通过配置文件注册自定义 SDK 包，用户只需指定 npm 包名和模型 ID 即可接入任何兼容 Vercel AI SDK 的提供商。正如官方所说："As models evolve, the gaps between them will close and pricing will drop, so being provider-agnostic is important."

### 1.2.3 可扩展的工具与技能系统

OpenCode 通过 `Tool.define` 注册工具，每个工具都遵循统一的接口规范——包含 `id`、`description`、`parameters`（Zod schema）和 `execute` 方法。`Tool.define` 的实现中内置了两个重要的横切关注点：参数校验和输出截断。

```typescript
// 文件: packages/opencode/src/tool/tool.ts L49-89
export function define<Parameters extends z.ZodType, Result extends Metadata>(
  id: string,
  init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
): Info<Parameters, Result> {
  return {
    id,
    init: async (initCtx) => {
      const toolInfo = init instanceof Function ? await init(initCtx) : init
      const execute = toolInfo.execute
      toolInfo.execute = async (args, ctx) => {
        try {
          toolInfo.parameters.parse(args)
        } catch (error) {
          if (error instanceof z.ZodError && toolInfo.formatValidationError) {
            throw new Error(toolInfo.formatValidationError(error), { cause: error })
          }
          throw new Error(
            `The ${id} tool was called with invalid arguments: ${error}.`,
            { cause: error },
          )
        }
        const result = await execute(args, ctx)
        const truncated = await Truncate.output(result.output, {}, initCtx?.agent)
        return { ...result, output: truncated.content,
          metadata: { ...result.metadata, truncated: truncated.truncated },
        }
      }
      return toolInfo
    },
  }
}
```

每次工具被调用时，`define` 内部的装饰器逻辑会先用 Zod schema 校验 LLM 返回的参数，再在执行完成后对输出结果进行截断处理——避免超长的工具输出占满模型的上下文窗口。这种 AOP（面向切面）式的设计使得新增工具的门槛极低——开发者只需关注参数定义和执行逻辑，校验和截断由框架统一处理。

当前内置的工具集非常丰富，从 `ToolRegistry` 的注册列表中可以看到完整清单：`bash`、`read`、`glob`、`grep`、`edit`、`write`、`task`（子 Agent 调度）、`webfetch`、`websearch`、`codesearch`、`skill`、`apply_patch`、`question` 等。`ToolRegistry` 还会扫描项目的 `.opencode/tools/` 目录加载用户自定义工具，以及通过 Plugin 系统注册插件提供的工具，实现了"内置 + 自定义 + 插件"三层工具生态。

## 1.3 核心价值：四大支柱

OpenCode 的架构围绕四大核心模块构建：

**Agent 系统**：内置 `build`（默认，全功能）和 `plan`（只读，用于分析）两个主要 Agent，以及 `general`（通用子 Agent，支持并行任务）、`explore`（快速代码探索，只拥有读取和搜索权限）等子 Agent。还有三个隐藏的辅助 Agent：`compaction`（上下文压缩）、`title`（自动生成会话标题）和 `summary`（生成会话摘要）。用户可以通过 `Tab` 键在主 Agent 之间切换，也可以用 `@general` 调用子 Agent。每个 Agent 拥有独立的权限规则集（Permission Ruleset），由 Zod schema 严格定义。`build` Agent 拥有文件读写和 bash 执行权限，而 `plan` Agent 的权限配置中对 `edit` 工具设置了 `"*": "deny"`，仅允许向 `.opencode/plans/` 目录写入计划文件，从架构层面保证只读分析的安全性。用户还可以在配置文件中自定义 Agent——添加新的 Agent、修改现有 Agent 的权限、指定专用模型，甚至通过 `disable: true` 禁用内置 Agent。

**Session 持久化**：所有对话历史通过 JSON 文件持久化存储，支持 Session 的创建、恢复、导出和分享。数据存储在本地的 `~/.local/share/opencode/storage/` 目录下，按 project → session → message → part 的层级组织。Session 中不仅保存了消息文本，还包括工具调用记录、代码快照引用和 token 用量统计，为对话回溯和成本分析提供了完整的数据基础。`Storage` 模块内置了数据迁移机制（`MIGRATIONS` 数组），确保数据格式升级时自动迁移旧数据。

**工具生态**：位于 `src/tool/` 目录下，涵盖文件操作、代码搜索、命令执行、Web 访问等，并支持通过 MCP（Model Context Protocol）扩展外部工具。MCP 允许用户在配置文件中声明外部工具服务器，OpenCode 启动时会自动连接这些服务器并将其提供的工具注册到 Agent 的工具列表中，实现了"即插即用"的工具扩展。

**ACP 协议**：Agent Client Protocol（`@agentclientprotocol/sdk`）提供了标准化的智能体通信接口，使 OpenCode 能够与更广泛的 AI 工具生态集成。ACP 的意义在于为多客户端架构提供统一的通信标准——不同的前端（TUI、桌面端、Web 端）通过 ACP 协议与同一个 Agent 后端通信，获得一致的对话体验。

## 1.4 与 Claude Code / Cursor / GitHub Copilot 对比

| 特性 | OpenCode | Claude Code | Cursor | GitHub Copilot |
|------|----------|-------------|--------|----------------|
| 开源协议 | MIT，100% 开源 | 闭源 | 闭源 | 闭源 |
| 交互方式 | CLI/TUI + 桌面端 + Web | CLI/TUI | IDE（VS Code fork） | IDE 插件 |
| LLM 支持 | 20+ 提供商（Anthropic, OpenAI, Google, xAI 等） | 仅 Claude | 多提供商 | 仅 OpenAI/GitHub 模型 |
| 扩展机制 | MCP + ACP + Plugin + 自定义工具 | MCP | 内置 | 有限 |
| LSP 支持 | 开箱即用 | 无 | IDE 原生 | IDE 原生 |
| 客户端/服务端架构 | 有（Hono server） | 无 | 无 | 云端 |
| 运行时 | Bun | Node.js | Electron | 云端/IDE |
| 本地模型 | 支持（通过 Ollama/OpenRouter） | 不支持 | 支持 | 不支持 |
| 代码快照/回滚 | 内置 snapshot 机制 | Git 集成 | IDE 本地历史 | 无 |
| 会话持久化 | 本地 JSON 存储 | 项目级 | 云端同步 | 无 |
| 多工作区支持 | 原生支持（Instance 隔离） | 单目录 | IDE 原生 | IDE 原生 |
| 自定义 Agent | 支持（配置文件定义） | 不支持 | 不支持 | 不支持 |

OpenCode 最显著的优势在于 Provider 无关性和客户端/服务端分离架构。后者使得 OpenCode 可以在本地运行服务端，同时从桌面应用或 Web 控制台远程控制，TUI 只是众多客户端之一。Aider 是另一个值得对比的开源 AI 编程工具，同样支持多提供商，但 Aider 采用 Python 实现且没有 TUI 交互界面，更偏向命令行管道式的工作方式，缺少 OpenCode 提供的丰富交互体验和客户端/服务端分离架构。

## 1.5 技术栈概览

OpenCode 的技术栈选择体现了现代 TypeScript 生态的最佳实践：

| 层次 | 技术选型 | 用途 |
|------|---------|------|
| 运行时 | **Bun** 1.3+ | JavaScript/TypeScript 执行环境 |
| 语言 | **TypeScript** | 全栈类型安全 |
| TUI 框架 | **SolidJS + opentui** | 终端用户界面渲染 |
| HTTP 服务 | **Hono** | 轻量级 Web 框架，提供 API Server |
| 数据持久化 | **JSON 文件存储 + Lock** | 本地持久化（Session、消息、配置） |
| Schema 验证 | **Zod** | 运行时类型校验和 OpenAPI 生成 |
| AI 调用 | **Vercel AI SDK** | 统一的 LLM 调用抽象 |
| 构建/包管理 | **Turborepo + Bun workspace** | Monorepo 管理 |
| 桌面端 | **Tauri + Electron** | 原生桌面应用封装（双版本） |

选择 Bun 而非 Node.js 不仅是为了性能——Bun 原生支持 TypeScript 执行（无需 tsc 编译步骤），使得 `bun dev` 可以直接运行 `.ts` 源码进行开发，极大缩短了开发反馈循环。从 `package.json` 中的 `dev` 脚本可以看到：`"dev": "bun run --conditions=browser ./src/index.ts"`，直接指向 TypeScript 入口文件，零编译延迟。此外，Bun 更快的启动速度对于 CLI 工具来说至关重要——用户每次输入 `opencode` 命令时都能感受到即时响应。

Hono 作为 HTTP 框架的选择也很巧妙——它足够轻量（核心不到 14KB），同时支持 SSE 流式传输和 WebSocket，完美适配 AI 应用的流式响应需求。OpenCode 的 Server 还集成了 OpenAPI 规范生成（通过 `hono-openapi`），使得 API 文档自动化。

选择 SolidJS 构建 TUI 而非 React，除了性能考量外，还有生态契合度的因素。SolidJS 的创建者 Ryan Carniato 与 SST/terminal.shop 团队有密切合作，opentui 框架本身就是为 SolidJS 设计的终端渲染引擎。这种"量身定制"的技术选型避免了在 React 终端渲染（如 ink）中常见的性能和兼容性问题。

## 本章要点

- OpenCode 是一个基于 TypeScript/Bun 的开源 AI 编程助手，定位为 Claude Code 的开源替代品，采用 MIT 协议。
- 三大设计哲学：CLI-first 的 TUI 原生体验、Provider 无关的多模型支持、基于 Tool/Skill/MCP 的可扩展架构。
- `Context.create()` 封装 `AsyncLocalStorage` 仅 25 行代码，`Instance.provide()` 在此基础上实现请求作用域的状态隔离和实例缓存。
- 核心架构围绕 Agent 系统（含 7 个内置 Agent）、Session 持久化、工具生态和 ACP 协议四大支柱构建。
- 相比 Claude Code、Cursor 和 Aider，OpenCode 的独特优势在于完全开源、20+ Provider 支持和客户端/服务端分离架构。
- 技术栈涵盖 Bun 运行时、SolidJS + opentui TUI、Hono HTTP 服务、JSON 文件存储和 Vercel AI SDK。
