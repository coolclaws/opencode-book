# 第 1 章　项目概览与设计哲学

OpenCode 是一个 100% 开源的 AI 编程助手，定位为 Claude Code 的开源替代方案。它基于 TypeScript 和 Bun 运行时构建，采用 CLI-first 的交互方式，支持多种 LLM 提供商，并通过灵活的工具和技能系统实现可扩展性。本章将从宏观视角介绍 OpenCode 的核心定位、设计哲学和技术架构。

## 1.1 OpenCode 是什么：开源 AI 编程助手

OpenCode 的官方定义非常简洁："The open source AI coding agent"——一个开源的 AI 编程智能体。它的核心能力与 Claude Code 高度相似：在终端中与 LLM 对话，让 AI 阅读代码、编辑文件、执行命令，从而辅助开发者完成编程任务。

与同类工具的关键区别在于，OpenCode 从第一行代码开始就是开源的（MIT 协议），并且不绑定任何特定的 AI 提供商。它的核心包位于 `packages/opencode`，使用 TypeScript 编写，运行在 Bun 之上。

从代码入口可以看到 OpenCode 的启动非常简洁：

```typescript
// packages/opencode/src/cli/bootstrap.ts
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

## 1.2 设计哲学：CLI-first、Provider 无关、可扩展

OpenCode 的设计哲学可以归纳为三个核心原则：

### 1.2.1 CLI-first / TUI 原生

OpenCode 由 Neovim 用户和 [terminal.shop](https://terminal.shop) 的创建者打造。官方表述是："We are going to push the limits of what's possible in the terminal"。TUI（Terminal User Interface）不是降级体验，而是一等公民。项目使用 SolidJS 配合 [opentui](https://github.com/sst/opentui) 框架构建终端界面，代码位于 `packages/opencode/src/cli/cmd/tui/`。

### 1.2.2 Provider 无关

OpenCode 采用 Vercel AI SDK 作为 LLM 调用层，通过统一的抽象支持几乎所有主流提供商。从 `package.json` 的依赖列表可以看到完整的提供商适配器：

```typescript
// 从 package.json 提取的 AI 提供商依赖（部分）
"@ai-sdk/anthropic": "2.0.65",
"@ai-sdk/openai": "2.0.89",
"@ai-sdk/google": "2.0.54",
"@ai-sdk/amazon-bedrock": "3.0.82",
"@ai-sdk/azure": "2.0.91",
"@ai-sdk/xai": "2.0.51",
"@ai-sdk/groq": "2.0.34",
"@ai-sdk/mistral": "2.0.27",
"@openrouter/ai-sdk-provider": "1.5.4",
```

这意味着用户可以自由切换 Claude、GPT、Gemini、Groq、Mistral 甚至本地模型。正如官方所说："As models evolve, the gaps between them will close and pricing will drop, so being provider-agnostic is important."

### 1.2.3 可扩展的工具与技能系统

OpenCode 通过 `Tool.define` 注册工具，每个工具都遵循统一的接口规范——包含 `id`、`description`、`parameters`（Zod schema）和 `execute` 方法。目前内置了丰富的工具集：`bash`、`read`、`edit`、`write`、`grep`、`glob`、`webfetch`、`websearch`、`lsp` 等。

## 1.3 核心价值：四大支柱

OpenCode 的架构围绕四大核心模块构建：

**Agent 系统**：内置 `build`（默认，全功能）和 `plan`（只读，用于分析）两个主要 Agent，以及 `general`、`explore` 等子 Agent。用户可以通过 `Tab` 键在主 Agent 之间切换，也可以用 `@general` 调用子 Agent。每个 Agent 拥有独立的权限规则集（Permission Ruleset），由 Zod schema 严格定义。

**Session 持久化**：所有对话历史通过 SQLite（配合 Drizzle ORM）持久化存储，支持 Session 的创建、恢复、导出和分享。

**工具生态**：位于 `src/tool/` 目录下，涵盖文件操作、代码搜索、命令执行、Web 访问等，并支持通过 MCP（Model Context Protocol）扩展外部工具。

**ACP 协议**：Agent Client Protocol（`@agentclientprotocol/sdk`）提供了标准化的智能体通信接口，使 OpenCode 能够与更广泛的 AI 工具生态集成。

## 1.4 与 Claude Code / Cursor / GitHub Copilot 对比

| 特性 | OpenCode | Claude Code | Cursor | GitHub Copilot |
|------|----------|-------------|--------|----------------|
| 开源协议 | MIT，100% 开源 | 闭源 | 闭源 | 闭源 |
| 交互方式 | CLI/TUI + 桌面端 + Web | CLI/TUI | IDE（VS Code fork） | IDE 插件 |
| LLM 支持 | 多提供商（Anthropic, OpenAI, Google 等） | 仅 Claude | 多提供商 | 仅 OpenAI/GitHub 模型 |
| 扩展机制 | MCP + ACP + Plugin | MCP | 内置 | 有限 |
| LSP 支持 | 开箱即用 | 无 | IDE 原生 | IDE 原生 |
| 客户端/服务端架构 | 有（Hono server） | 无 | 无 | 云端 |
| 运行时 | Bun | Node.js | Electron | 云端/IDE |
| 本地模型 | 支持 | 不支持 | 支持 | 不支持 |

OpenCode 最显著的优势在于 Provider 无关性和客户端/服务端分离架构。后者使得 OpenCode 可以在本地运行服务端，同时从移动端或桌面应用远程控制，TUI 只是众多客户端之一。

## 1.5 技术栈概览

OpenCode 的技术栈选择体现了现代 TypeScript 生态的最佳实践：

| 层次 | 技术选型 | 用途 |
|------|---------|------|
| 运行时 | **Bun** 1.3+ | JavaScript/TypeScript 执行环境，内置 SQLite |
| 语言 | **TypeScript** | 全栈类型安全 |
| TUI 框架 | **SolidJS + opentui** | 终端用户界面渲染 |
| HTTP 服务 | **Hono** | 轻量级 Web 框架，提供 API Server |
| 数据库 | **SQLite + Drizzle ORM** | 本地持久化（Session、配置、消息） |
| Schema 验证 | **Zod** | 运行时类型校验和 OpenAPI 生成 |
| AI 调用 | **Vercel AI SDK** | 统一的 LLM 调用抽象 |
| 构建/包管理 | **Turborepo + Bun workspace** | Monorepo 管理 |
| 桌面端 | **Tauri** | 原生桌面应用封装 |

值得注意的是，OpenCode 选择 Bun 而非 Node.js 不仅是为了性能，更因为 Bun 内置了 SQLite 支持，省去了 `better-sqlite3` 等原生依赖的编译问题。Hono 作为 HTTP 框架的选择也很巧妙——它足够轻量，同时支持 SSE 流式传输和 WebSocket，完美适配 AI 应用的流式响应需求。

## 本章要点

- OpenCode 是一个基于 TypeScript/Bun 的开源 AI 编程助手，定位为 Claude Code 的开源替代品，采用 MIT 协议。
- 三大设计哲学：CLI-first 的 TUI 原生体验、Provider 无关的多模型支持、基于 Tool/Skill/MCP 的可扩展架构。
- 核心架构围绕 Agent 系统、Session 持久化、工具生态和 ACP 协议四大支柱构建。
- 相比 Claude Code 和 Cursor，OpenCode 的独特优势在于完全开源、Provider 无关和客户端/服务端分离架构。
- 技术栈涵盖 Bun 运行时、SolidJS + opentui TUI、Hono HTTP 服务、SQLite + Drizzle 存储和 Vercel AI SDK。
