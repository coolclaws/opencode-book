# 第 12 章　ACP 协议设计与类型体系

当 AI 编码助手从命令行走向桌面应用，一个关键问题浮出水面：**前端客户端如何与 AI 引擎通信？** MCP（Model Context Protocol）解决了工具和上下文的接入问题，但缺少会话管理、权限交互、模型选择等高层抽象。OpenCode 引入了 **ACP（Agent Client Protocol）**，为"客户端-Agent"交互定义了完整的协议层。

## 12.1 什么是 ACP（Agent Client Protocol）

ACP 是一套标准化的客户端与 AI Agent 之间的通信协议。它由 `@agentclientprotocol/sdk` 包提供类型定义和连接管理。ACP 的核心理念是：**将 AI 引擎视为一个可远程控制的服务**，客户端通过标准化的请求/响应接口与之交互。

在 OpenCode 的架构中，ACP 处于 MCP 和前端 UI 之间：

```
┌─────────────┐     ACP      ┌──────────────┐     MCP      ┌─────────────┐
│  Desktop App │ ◄──────────► │  OpenCode    │ ◄──────────► │  Tool Server │
│  (客户端)    │   会话/权限   │  Engine      │   工具/上下文  │  (MCP)       │
└─────────────┘              └──────────────┘              └─────────────┘
```

ACP 处理的核心交互包括：会话的创建与恢复、模型和模式的切换、权限请求与审批、消息流的实时推送、工具执行状态的追踪。

## 12.2 ACPSessionState 类型

> **源码位置**：packages/opencode/src/acp/types.ts

`ACPSessionState` 定义了 ACP 层面维护的会话状态：

```typescript
export interface ACPSessionState {
  id: string                  // 会话唯一标识
  cwd: string                 // 工作目录（项目路径）
  mcpServers: McpServer[]     // 客户端注册的 MCP 服务器列表
  createdAt: Date             // 会话创建时间
  model?: {                   // 当前使用的模型
    providerID: string        // 提供商标识（如 "anthropic"）
    modelID: string           // 模型标识（如 "claude-sonnet-4-20250514"）
  }
  variant?: string            // 模型变体（如速度/质量偏好）
  modeId?: string             // 当前 Agent 模式（如 "build"、"plan"）
}
```

这个类型的设计体现了几个关键决策：

**工作目录绑定**：每个 ACP 会话都绑定到一个具体的 `cwd`。这与 OpenCode 的项目感知能力一致——不同项目的配置、权限规则和 MCP 服务器可能完全不同。

**MCP 服务器传递**：客户端可以向引擎注册自己的 MCP 服务器。例如，Desktop 应用可能提供了本地文件系统工具或 IDE 集成工具，通过 ACP 传递给引擎使用。

**模型与模式分离**：`model` 决定使用哪个 LLM，`modeId` 决定使用哪个 Agent（如 build、plan、explore）。这种分离让用户可以在同一模型下切换工作模式，或在同一模式下切换模型。

## 12.3 ACPConfig 配置

```typescript
export interface ACPConfig {
  sdk: OpencodeClient          // OpenCode SDK 客户端实例
  defaultModel?: {             // 默认模型配置
    providerID: string
    modelID: string
  }
}
```

`ACPConfig` 极其精简，只包含两个字段：

- **`sdk`**：OpenCode 的 SDK 客户端，提供对引擎所有功能的 API 访问。这是 ACP Agent 与 OpenCode 核心交互的唯一通道。
- **`defaultModel`**：可选的默认模型。如果未指定，Agent 会从项目配置中读取默认模型设置。

这种设计将 ACP 层定位为一个**薄适配层**——它不重复 OpenCode 引擎的配置，而是通过 SDK 代理所有操作。

## 12.4 消息格式转换

ACP 协议定义了自己的消息格式，与 OpenCode 内部的消息格式不同。`ACP.Agent` 类负责在两者之间转换。

**输入方向（客户端 → 引擎）**：ACP 的 `PromptRequest` 包含多种内容类型，需要转换为 OpenCode 的内部格式：

```typescript
// ACP prompt 中的内容部分
for (const part of params.prompt) {
  switch (part.type) {
    case "text":
      // 处理 audience 注解：synthetic/ignored 映射
      const audience = part.annotations?.audience
      const forAssistant = audience?.length === 1 && audience[0] === "assistant"
      const forUser = audience?.length === 1 && audience[0] === "user"
      parts.push({
        type: "text",
        text: part.text,
        ...(forAssistant && { synthetic: true }),
        ...(forUser && { ignored: true }),
      })
      break

    case "image":
      // 图片转为 data URL 格式的文件部分
      parts.push({
        type: "file",
        url: `data:${part.mimeType};base64,${part.data}`,
        filename,
        mime: part.mimeType,
      })
      break

    case "resource_link":
      // 资源链接解析为文件路径
      parts.push(parseUri(part.uri))
      break
  }
}
```

**输出方向（引擎 → 客户端）**：引擎的事件流通过 `sessionUpdate` 推送给客户端，包括文本增量（`agent_message_chunk`）、思考过程（`agent_thought_chunk`）、工具调用状态（`tool_call_update`）等。

一个重要的细节是 **audience 注解** 的处理。ACP 使用 `audience: ["assistant"]` 表示合成内容（仅供模型参考），`audience: ["user"]` 表示被忽略的内容。OpenCode 内部则使用 `synthetic` 和 `ignored` 布尔标志。这种映射保证了语义的完整传递。

## 12.5 与 MCP 协议的关系

ACP 和 MCP 是互补的两个协议，各有分工：

| 维度 | MCP | ACP |
|------|-----|-----|
| 抽象层级 | 工具与上下文 | 会话与控制 |
| 主要交互 | 调用工具、读取资源 | 管理会话、权限审批 |
| 消息方向 | Agent → 工具服务器 | 客户端 → Agent |
| 状态管理 | 无状态 | 有状态（会话） |
| 标准化程度 | 行业标准 | OpenCode 定义 |

在 OpenCode 中，ACP 可以透传客户端的 MCP 服务器配置。当 Desktop 应用通过 ACP 创建会话时，可以携带自己的 MCP 服务器列表：

```typescript
async newSession(params: NewSessionRequest) {
  // params.mcpServers 包含客户端注册的 MCP 服务器
  const state = await this.sessionManager.create(
    params.cwd,
    params.mcpServers,  // 透传给引擎
    model
  )
  // ...
}
```

引擎收到后，将这些 MCP 服务器添加到自身的配置中：

```typescript
await Promise.all(
  Object.entries(mcpServers).map(async ([key, mcp]) => {
    await this.sdk.mcp.add({
      directory, name: key, config: mcp,
    })
  }),
)
```

这种设计让 Desktop 应用可以扩展引擎的工具能力——例如提供 IDE 级别的代码导航工具或调试器集成。

## 12.6 实战：理解 ACP 的设计动机

为什么需要 ACP？让我们通过一个具体场景来理解。

假设你在使用 OpenCode Desktop 应用。你打开一个项目，开始与 AI 对话。这个看似简单的过程涉及大量交互：

1. **会话初始化**：Desktop 调用 `newSession`，传入项目路径和 MCP 服务器
2. **模型发现**：引擎返回可用模型列表和当前默认模型
3. **模式选择**：引擎返回可用 Agent（build/plan）列表
4. **用户输入**：Desktop 将用户消息（可能包含图片、文件引用）通过 `prompt` 发送
5. **实时反馈**：引擎通过事件流推送文本增量、工具调用状态
6. **权限询问**：当 Agent 需要写文件时，通过 ACP 向 Desktop 请求用户授权
7. **会话恢复**：用户关闭再打开应用，通过 `loadSession` 恢复历史对话

没有 ACP，这些交互需要各客户端自行实现，导致行为不一致。ACP 将这些模式标准化，任何实现了 ACP 的客户端（TUI、Desktop、Web）都能获得一致的体验。

与 Cursor 和 GitHub Copilot 相比，它们将 UI 和引擎紧耦合在同一进程中，不存在客户端-引擎分离的概念。OpenCode 的 ACP 设计使其天然支持"一个引擎，多个前端"的架构。

## 本章要点

- ACP（Agent Client Protocol）定义了客户端与 AI Agent 之间的标准化通信协议，处于 MCP 之上、UI 之下的中间层
- `ACPSessionState` 将会话与工作目录、MCP 服务器、模型和模式绑定，实现完整的上下文隔离
- `ACPConfig` 采用薄适配层设计，通过 SDK 代理所有操作，避免配置重复
- 消息格式转换处理了 audience 注解、图片编码、资源链接等多种内容类型的双向映射
- ACP 可透传客户端的 MCP 服务器，让前端应用能够扩展引擎的工具能力
