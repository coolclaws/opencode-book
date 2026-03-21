# 第 13 章　ACP Agent 实战

上一章分析了 ACP 的类型体系和设计动机。本章将深入 `ACP.Agent` 类的实现细节，探索会话建立流程、事件处理、工具执行追踪、会话恢复与重连、以及 Plan/Todo 同步等核心机制。

## 13.1 ACPAgent 核心接口

> **源码位置**：packages/opencode/src/acp/agent.ts

`ACP.Agent` 类实现了 `@agentclientprotocol/sdk` 定义的 `Agent` 接口，是 OpenCode 引擎面向 ACP 客户端的全部能力入口。它管理着多个关键的内部状态：

```typescript
// 文件: packages/opencode/src/acp/agent.ts L134-148
export class Agent implements ACPAgent {
  private connection: AgentSideConnection     // ACP 双向连接
  private config: ACPConfig                   // 配置信息
  private sdk: OpencodeClient                 // OpenCode SDK
  private sessionManager: ACPSessionManager   // 会话状态管理器
  private eventAbort = new AbortController()  // 事件订阅的中止控制
  private eventStarted = false                // 事件循环是否已启动
  private bashSnapshots = new Map<string, string>()  // bash 输出快照（去重）
  private toolStarts = new Set<string>()      // 已发送 pending 的工具调用集合
  private permissionQueues = new Map<string, Promise<void>>()  // 权限请求队列
  private permissionOptions: PermissionOption[] = [
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ]
}
```

这些字段各有分工。`connection` 是 ACP 双向连接的句柄，所有发往客户端的消息都通过它发送。`sessionManager` 维护着一个内存中的 `Map<string, ACPSessionState>`，用于跟踪所有活跃会话的状态。`eventAbort` 提供了优雅关闭事件循环的能力——当连接断开时，调用 `abort()` 即可终止所有挂起的事件监听。`bashSnapshots` 和 `toolStarts` 是两个去重机制的数据结构，前者防止 bash 工具输出的重复推送，后者确保每个工具调用只发送一次 `pending` 状态通知。`permissionQueues` 则是第 12 章提到的权限队列化机制的实现载体，每个 sessionId 对应一个 Promise 链。

构造函数在连接建立时即启动事件订阅循环：

```typescript
// 文件: packages/opencode/src/acp/agent.ts L150-156
constructor(connection: AgentSideConnection, config: ACPConfig) {
  this.connection = connection
  this.config = config
  this.sdk = config.sdk
  this.sessionManager = new ACPSessionManager(this.sdk)
  this.startEventSubscription()  // 立即开始监听引擎事件
}
```

立即调用 `startEventSubscription()` 确保了从 Agent 实例创建的那一刻起，就不会遗漏引擎发出的任何事件。如果延迟到第一次 `prompt` 调用时才启动监听，那么会话创建和模型加载期间产生的事件就可能丢失。`startEventSubscription()` 内部通过 `eventStarted` 标志位做幂等保护，防止重复启动。

`ACP.init` 是入口工厂函数，返回一个 `create` 方法用于为每个 ACP 连接创建 Agent 实例：

```typescript
// 文件: packages/opencode/src/acp/agent.ts L126-132
export async function init({ sdk: _sdk }: { sdk: OpencodeClient }) {
  return {
    create: (connection: AgentSideConnection, fullConfig: ACPConfig) => {
      return new Agent(connection, fullConfig)
    },
  }
}
```

## 13.2 ACPSessionManager：会话状态管理

在分析会话建立流程之前，需要理解 `ACPSessionManager` 的内部结构。它是一个纯内存的状态容器，封装了 `Map<string, ACPSessionState>` 的操作：

```typescript
// 文件: packages/opencode/src/acp/session.ts L8-14
export class ACPSessionManager {
  private sessions = new Map<string, ACPSessionState>()
  private sdk: OpencodeClient

  constructor(sdk: OpencodeClient) {
    this.sdk = sdk
  }
}
```

`ACPSessionState` 的类型定义揭示了 ACP 会话与引擎会话之间的关系：

```typescript
// 文件: packages/opencode/src/acp/types.ts L5-16
export interface ACPSessionState {
  id: string
  cwd: string
  mcpServers: McpServer[]
  createdAt: Date
  model?: { providerID: ProviderID; modelID: ModelID }
  variant?: string
  modeId?: string
}
```

ACP 会话状态包含的是连接级别的上下文信息——项目目录、客户端携带的 MCP 服务器列表、当前选中的模型和模式。这些信息不持久化到磁盘，因为它们只在连接存续期间有意义。真正需要持久化的对话历史由引擎层管理。

`ACPSessionManager` 的 `create` 方法先通过 SDK 在引擎层创建会话，再将 ACP 级别的状态存入内存 Map：

```typescript
// 文件: packages/opencode/src/acp/session.ts L20-44
async create(cwd: string, mcpServers: McpServer[], model?: ACPSessionState["model"]) {
  const session = await this.sdk.session
    .create({ directory: cwd }, { throwOnError: true })
    .then((x) => x.data!)

  const state: ACPSessionState = {
    id: session.id, cwd, mcpServers,
    createdAt: new Date(), model,
  }
  this.sessions.set(session.id, state)
  return state
}
```

`load` 方法用于恢复已有会话，通过 `sdk.session.get` 验证会话在引擎层确实存在后，再建立 ACP 状态。`get` 和 `tryGet` 是两种获取方式——前者在找不到会话时抛出 `RequestError.invalidParams`，后者返回 `undefined`。事件处理代码使用 `tryGet`，因为收到的事件可能来自不属于当前 ACP 连接的会话；而 `prompt`、`setModel` 等主动操作使用 `get`，因为操作一个不存在的会话是客户端错误。

## 13.3 会话建立的完整流程

ACP 的会话建立不是简单的 "创建一个对象"。它是一个多步协商过程，涉及能力发现、状态初始化和模型/模式加载三个阶段。

### 初始化握手

客户端与 ACP Agent 的交互始于 `initialize()` 调用。这一步完成双方的能力协商，Agent 返回自己的能力集和认证方式：

```typescript
// 文件: packages/opencode/src/acp/agent.ts L520-564
async initialize(params: InitializeRequest): Promise<InitializeResponse> {
  const authMethod: AuthMethod = {
    description: "Run `opencode auth login` in the terminal",
    name: "Login with opencode", id: "opencode-login",
  }
  // 如果客户端支持 terminal-auth 能力，则附加终端认证元数据
  if (params.clientCapabilities?._meta?.["terminal-auth"] === true) {
    authMethod._meta = {
      "terminal-auth": {
        command: "opencode", args: ["auth", "login"],
        label: "OpenCode Login",
      },
    }
  }
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      mcpCapabilities: { http: true, sse: true },
      promptCapabilities: { embeddedContext: true, image: true },
      sessionCapabilities: { fork: {}, list: {}, resume: {} },
    },
    authMethods: [authMethod],
    agentInfo: { name: "OpenCode", version: Installation.VERSION },
  }
}
```

`agentCapabilities` 中声明的能力决定了客户端可以使用哪些功能。`loadSession: true` 表示支持会话恢复；`sessionCapabilities` 中的 `fork`、`list`、`resume` 声明了会话管理的完整能力集。`mcpCapabilities` 告知客户端可以传递 HTTP 和 SSE 类型的 MCP 服务器。`promptCapabilities.image` 表示支持图片附件，`embeddedContext` 表示支持嵌入式上下文引用。

### 创建新会话

`newSession` 的实现涉及三个关键步骤：创建 ACP 会话状态、加载可用模型和 Agent 模式、以及注册客户端携带的 MCP 服务器。

```typescript
// 文件: packages/opencode/src/acp/agent.ts L570-602
async newSession(params: NewSessionRequest) {
  const directory = params.cwd
  const model = await defaultModel(this.config, directory)
  const state = await this.sessionManager.create(params.cwd, params.mcpServers, model)
  const sessionId = state.id

  const load = await this.loadSessionMode({
    cwd: directory, mcpServers: params.mcpServers, sessionId,
  })
  return {
    sessionId, models: load.models,
    modes: load.modes, _meta: load._meta,
  }
}
```

`loadSessionMode()` 是会话初始化中最复杂的环节。它从引擎获取所有已配置的 Provider 及其模型列表，构建 `availableModels` 数组；然后调用 `resolveModeState()` 获取可用的 Agent 模式列表——这一步会过滤掉 `subagent` 模式和标记为 `hidden` 的模式，只返回用户可直接选择的顶层模式。此外它还会加载可用的 slash command 列表和客户端传入的 MCP 服务器配置。

### 加载历史会话

`loadSession` 用于恢复已有会话，需要回放所有历史消息以还原客户端状态：

```typescript
// 文件: packages/opencode/src/acp/agent.ts L604-667
async loadSession(params: LoadSessionRequest) {
  const directory = params.cwd
  const sessionId = params.sessionId
  const model = await defaultModel(this.config, directory)
  await this.sessionManager.load(sessionId, params.cwd, params.mcpServers, model)

  const result = await this.loadSessionMode({
    cwd: directory, mcpServers: params.mcpServers, sessionId,
  })

  const messages = await this.sdk.session.messages({
    sessionID: sessionId, directory,
  }, { throwOnError: true }).then((x) => x.data)

  // 从最后一条用户消息还原模型和模式设置
  const lastUser = messages?.findLast((m) => m.info.role === "user")?.info
  if (lastUser?.role === "user") {
    result.models.currentModelId =
      `${lastUser.model.providerID}/${lastUser.model.modelID}`
    this.sessionManager.setModel(sessionId, { ... })
    // 同时恢复 Agent 模式
    if (result.modes?.availableModes.some((m) => m.id === lastUser.agent)) {
      result.modes.currentModeId = lastUser.agent
      this.sessionManager.setMode(sessionId, lastUser.agent)
    }
  }

  // 逐条回放消息
  for (const msg of messages ?? []) {
    await this.processMessage(msg)
  }
  await sendUsageUpdate(this.connection, this.sdk, sessionId, directory)
  return result
}
```

回放机制的核心是 `processMessage()` 方法。它将每条历史消息转换为 ACP 协议的事件序列——用户消息变成 `user_message_chunk`，助手回复变成 `agent_message_chunk`，工具调用变成对应状态的 `tool_call_update`，推理内容变成 `agent_thought_chunk`，文件附件则根据 URL 模式和 MIME 类型转换为 `resource_link`、`image` 或 `resource` 块。从最后一条用户消息中恢复模型和模式设置解决了一个微妙的问题：用户可能在对话过程中切换了模型或模式，从最后一条用户消息恢复确保了 "所见即所得"。

`sendUsageUpdate()` 在回放完成后汇总所有助手消息的 token 用量和费用。它计算 `used = input tokens + cache read tokens`，并从 Provider 配置获取模型的上下文窗口大小 `size`，以 `usage_update` 事件发给客户端，让 UI 能准确显示上下文使用率。

## 13.4 重连、分叉与会话列表

### 重连恢复

ACP Agent 层是无状态可恢复的。Agent 进程可以被完全销毁和重建，只要引擎层的持久化数据完好，所有会话都能通过 `loadSession()` 恢复。`unstable_resumeSession` 提供了更轻量的恢复方式——它不回放历史消息，只重新建立 ACP 状态并发送用量更新，适用于客户端已经有本地缓存的场景。

### 分叉会话

`unstable_forkSession` 基于已有会话创建分支——这是 AI 编码中 "尝试不同方案" 的核心能力。实现流程是：通过 SDK 在引擎层 fork 会话，获取新的 sessionId，然后加载 ACP 状态并回放分叉后的完整消息历史。

### 会话列表

`unstable_listSessions` 实现了基于游标的分页查询。所有会话按更新时间倒序排列，每页最多返回 100 条。游标使用 `time.updated` 时间戳，下一页的查询条件是 `updated < cursor`，确保了分页的稳定性——即使有新会话被创建，已返回的结果也不会重复。

```typescript
// 文件: packages/opencode/src/acp/agent.ts L669-712
async unstable_listSessions(params: ListSessionsRequest) {
  const cursor = params.cursor ? Number(params.cursor) : undefined
  const limit = 100
  const sessions = await this.sdk.session.list({
    directory: params.cwd ?? undefined, roots: true,
  }, { throwOnError: true }).then((x) => x.data ?? [])

  const sorted = sessions.toSorted((a, b) => b.time.updated - a.time.updated)
  const filtered = cursor ? sorted.filter((s) => s.time.updated < cursor) : sorted
  const page = filtered.slice(0, limit)
  // ...构建 SessionInfo 数组和 nextCursor
}
```

## 13.5 事件处理管线

ACP Agent 在构造时启动一个长轮询事件循环，持续监听 OpenCode 引擎发出的事件：

```typescript
// 文件: packages/opencode/src/acp/agent.ts L167-182
private async runEventSubscription() {
  while (true) {
    if (this.eventAbort.signal.aborted) return
    const events = await this.sdk.global.event({
      signal: this.eventAbort.signal,
    })
    for await (const event of events.stream) {
      if (this.eventAbort.signal.aborted) return
      const payload = (event as any)?.payload
      if (!payload) continue
      await this.handleEvent(payload as Event).catch((error) => {
        log.error("failed to handle event", { error, type: payload.type })
      })
    }
  }
}
```

外层 `while(true)` 保证了即使一次 SSE 连接断开，循环也会自动重连。每个事件处理都有独立的 `.catch()`，单个事件的失败不会中断整个循环。`handleEvent` 根据事件类型分发处理，核心是三种事件：

**权限请求事件（`permission.asked`）** 使用每会话队列化策略。新的权限请求被追加到该会话 Promise 链的末尾，确保同一会话的权限请求按序处理。当客户端批准 `edit` 类型的权限后，Agent 还会通过 `applyPatch` 计算文件新内容并推送给客户端，让 Desktop 应用实时显示 diff。如果权限请求发送失败（例如客户端断线），Agent 会自动 reject 该请求，避免引擎无限等待。Promise 链的 `finally` 回调在处理完成后清理队列条目，防止内存泄漏。

**消息增量事件（`message.part.delta`）** 区分文本和推理内容。对于 `text` 类型的 part，通过 `agent_message_chunk` 发送增量文本；对于 `reasoning` 类型，通过 `agent_thought_chunk` 发送。值得注意的是，delta 处理中会检查 `part.ignored !== true`——被标记为 ignored 的文本 part（如系统内部的合成消息）不会推送给客户端。

**工具状态更新事件（`message.part.updated`）** 覆盖工具调用的完整生命周期，从 pending 到 running 到 completed/error，详见下一节。

## 13.6 工具执行追踪

工具调用的生命周期通过 `message.part.updated` 事件追踪。`toolStart` 方法确保每个工具调用只发送一次 `pending` 状态：

```typescript
// 文件: packages/opencode/src/acp/agent.ts L1091-1110
private async toolStart(sessionId: string, part: ToolPart) {
  if (this.toolStarts.has(part.callID)) return  // 幂等保护
  this.toolStarts.add(part.callID)
  await this.connection.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: part.callID,
      title: part.tool,
      kind: toToolKind(part.tool),
      status: "pending", locations: [], rawInput: {},
    },
  })
}
```

引擎在工具执行过程中可能多次发出 `message.part.updated` 事件（比如 bash 工具的输出在持续增长），每次事件处理都会先调用 `toolStart`。没有 `toolStarts` Set 的保护，客户端会收到重复的 `pending` 通知。

对于 `bash` 工具，实现了输出快照去重——只有当输出内容的哈希值变化时才推送更新内容：

```typescript
// 文件: packages/opencode/src/acp/agent.ts L288-309
if (part.tool === "bash") {
  if (this.bashSnapshots.get(part.callID) === hash) {
    // 输出未变化，发送 in_progress 但不附带内容
    return
  }
  this.bashSnapshots.set(part.callID, hash)
}
```

对于 `edit` 类型的工具，completed 状态会额外附带 `diff` 内容块，包含 `path`、`oldText` 和 `newText` 字段。这让客户端能直接渲染出可视化的文件差异，而不需要自己计算 diff。对于 `todowrite` 工具，completed 时会解析输出中的 Todo 列表，以 `plan` 类型的 `sessionUpdate` 全量同步给客户端。`cancelled` 状态被映射为 `completed`——ACP 协议的 plan 视图只需要区分 "还需关注" 和 "已处理完毕"。

工具类型映射由 `toToolKind` 函数完成，将 OpenCode 内部的工具名称转换为五种 ACP 标准类型：`execute`（bash）、`edit`（edit/patch/write）、`search`（grep/glob）、`read`（list/read）和 `fetch`（webfetch），其他工具归类为 `other`。客户端根据这五种类型展示不同的 UI 组件——终端面板、diff 视图、搜索结果或文件预览。

## 13.7 processMessage：回放的核心

`processMessage` 在历史消息回放中扮演核心角色。它遍历消息的所有 part，根据类型转换为对应的 ACP 事件：

```text
┌─────────────────────────────────────────────────────────────────┐
│                     processMessage(msg)                         │
│                                                                 │
│  msg.parts.forEach ─→ ┌─ type: "tool"                          │
│                        │    → toolStart() + tool_call_update    │
│                        │                                        │
│                        ├─ type: "text"                          │
│                        │    → user_message_chunk 或             │
│                        │      agent_message_chunk               │
│                        │    (synthetic → audience: assistant)   │
│                        │    (ignored → audience: user)          │
│                        │                                        │
│                        ├─ type: "file"                          │
│                        │    → file:// → resource_link           │
│                        │    → data:image/* → image              │
│                        │    → data:text/* → resource(text)      │
│                        │    → data:other → resource(blob)       │
│                        │                                        │
│                        └─ type: "reasoning"                     │
│                             → agent_thought_chunk               │
└─────────────────────────────────────────────────────────────────┘
```

文件附件的处理尤其精细。`file://` URL 转换为 `resource_link` 引用；`data:` URL 按 MIME 类型分流——`image/*` 成为 `image` 块并提取 base64 数据，`text/*` 和 `application/json` 被解码为 UTF-8 文本嵌入 `resource` 块，其他二进制类型保留 base64 编码作为 `blob`。这种分类确保了客户端能以最优方式渲染不同类型的附件内容。

## 13.8 实战：Desktop 客户端完整交互流程

让我们还原一个完整的 Desktop 客户端与 OpenCode 引擎通过 ACP 交互的流程。

**场景**：用户在 Desktop 应用中打开一个 React 项目，要求 AI "重构 UserList 组件"。

```text
时间线 →

Desktop                        ACP Agent                      OpenCode Engine
  │                               │                               │
  ├──initialize()────────────────►│                               │
  │◄─────agentInfo/capabilities──┤                               │
  │                               │                               │
  ├──newSession(cwd, mcpServers)─►│──sessionManager.create()────►│
  │                               │──loadSessionMode()────────────►│
  │◄─────sessionId, models, modes─┤                               │
  │                               │                               │
  ├──prompt("重构 UserList")──────►│──sdk.session.prompt()────────►│
  │                               │                               │
  │                               │◄──event: message.part.delta──┤
  │◄─agent_message_chunk("我来")──┤                               │
  │                               │                               │
  │                               │◄──event: message.part.updated│
  │◄─tool_call(read, pending)─────┤     (tool: read, pending)     │
  │◄─tool_call(read, completed)───┤     (tool: read, completed)   │
  │                               │                               │
  │                               │◄──event: permission.asked────┤
  │◄─requestPermission(edit)──────┤     (permission: edit)        │
  │──"Allow once"────────────────►│──permission.reply("once")────►│
  │◄─writeTextFile(new content)───┤                               │
  │                               │                               │
  │                               │◄──event: message.part.updated│
  │◄─tool_call(edit, completed)───┤     (tool: edit, completed)   │
  │                               │                               │
  │◄─usage_update(tokens, cost)───┤                               │
  │◄─────stopReason: "end_turn"───┤                               │
```

整个流程中，Desktop 客户端不需要了解 OpenCode 引擎的内部实现。它只需要实现 ACP 的客户端接口，就能获得完整的 AI 编码助手能力。假设用户此时关闭了 Desktop 应用，第二天重新打开，Desktop 从本地存储读取上次的 `sessionId`，调用 `loadSession(sessionId)`。ACP Agent 逐条回放历史消息，Desktop 收到一连串事件重建出完整的对话界面，`usage_update` 恢复累计的 token 用量。用户看到的界面与关闭前完全一致。

与 Cursor 将引擎嵌入 VS Code 扩展不同，OpenCode 的 ACP 架构让引擎和客户端可以独立演进。更新引擎不影响客户端，添加新客户端（如 Web 版、移动版）也不需要修改引擎。

## 本章要点

- `ACP.Agent` 通过事件订阅循环实现实时推送，覆盖文本增量、工具状态和权限请求三大事件类型
- `ACPSessionManager` 是纯内存状态容器，提供 `create`/`load`/`get`/`tryGet` 等操作，会话状态不持久化——ACP 层无状态可恢复
- 会话建立是多步协商过程：`initialize()` 完成能力协商并声明支持的认证方式，`newSession()` 创建状态，`loadSessionMode()` 返回可用模型、Agent 模式和 slash command 列表
- `loadSession` 通过 `processMessage` 回放历史消息还原客户端状态，支持 text、tool、file、reasoning 四种 part 类型的精确转换
- 权限请求采用每会话 Promise 链队列化，失败时自动 reject 避免引擎阻塞，`finally` 回调清理队列防止内存泄漏
- bash 工具使用输出快照哈希去重，`toolStarts` Set 保证 pending 通知幂等
- `unstable_listSessions` 基于 `time.updated` 游标分页，`unstable_forkSession` 支持会话分叉后完整回放
