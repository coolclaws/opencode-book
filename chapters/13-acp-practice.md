# 第 13 章　ACP Agent 实战

上一章分析了 ACP 的类型体系和设计动机。本章将深入 `ACP.Agent` 类的实现细节，探索会话管理、事件处理、工具执行追踪和 Plan/Todo 同步等核心机制。

## 13.1 ACPAgent 核心接口

> **源码位置**：packages/opencode/src/acp/agent.ts

`ACP.Agent` 类实现了 `@agentclientprotocol/sdk` 定义的 `Agent` 接口，是 OpenCode 引擎面向 ACP 客户端的全部能力入口。它管理着多个关键的内部状态：

```typescript
export class Agent implements ACPAgent {
  private connection: AgentSideConnection     // ACP 双向连接
  private config: ACPConfig                   // 配置信息
  private sdk: OpencodeClient                 // OpenCode SDK
  private sessionManager: ACPSessionManager   // 会话状态管理器
  private eventAbort = new AbortController()  // 事件订阅的中止控制
  private bashSnapshots = new Map<string, string>()  // bash 输出快照（去重）
  private toolStarts = new Set<string>()      // 已发送 pending 的工具调用集合
  private permissionQueues = new Map<string, Promise<void>>()  // 权限请求队列

  // 预定义的权限选项
  private permissionOptions: PermissionOption[] = [
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ]
}
```

`Agent` 的构造函数在连接建立时即启动事件订阅循环：

```typescript
constructor(connection: AgentSideConnection, config: ACPConfig) {
  this.connection = connection
  this.config = config
  this.sdk = config.sdk
  this.sessionManager = new ACPSessionManager(this.sdk)
  this.startEventSubscription()  // 立即开始监听引擎事件
}
```

`ACP.init` 是入口工厂函数，返回一个 `create` 方法用于为每个 ACP 连接创建 Agent 实例：

```typescript
export async function init({ sdk: _sdk }: { sdk: OpencodeClient }) {
  return {
    create: (connection: AgentSideConnection, fullConfig: ACPConfig) => {
      return new Agent(connection, fullConfig)
    },
  }
}
```

## 13.2 Session 管理

ACP Agent 提供了完整的会话生命周期管理，覆盖创建、加载、列表、分叉和恢复五个操作。

### 创建新会话

```typescript
async newSession(params: NewSessionRequest) {
  const directory = params.cwd
  const model = await defaultModel(this.config, directory)

  // 创建 ACP 会话状态
  const state = await this.sessionManager.create(
    params.cwd, params.mcpServers, model
  )
  const sessionId = state.id

  // 加载模式信息（可用 Agent、模型列表等）
  const load = await this.loadSessionMode({
    cwd: directory,
    mcpServers: params.mcpServers,
    sessionId,
  })

  return {
    sessionId,
    models: load.models,   // 可用模型列表和当前模型
    modes: load.modes,     // 可用 Agent 模式列表
    _meta: load._meta,     // 变体元数据
  }
}
```

### 加载历史会话

`loadSession` 用于恢复已有会话，需要**回放所有历史消息**以还原客户端状态：

```typescript
async loadSession(params: LoadSessionRequest) {
  // ... 初始化省略

  // 获取会话的所有历史消息
  const messages = await this.sdk.session.messages({
    sessionID: sessionId, directory,
  }).then((x) => x.data)

  // 从最后一条用户消息还原模型和模式设置
  const lastUser = messages?.findLast((m) => m.info.role === "user")?.info
  if (lastUser?.role === "user") {
    result.models.currentModelId =
      `${lastUser.model.providerID}/${lastUser.model.modelID}`
    this.sessionManager.setModel(sessionId, { ... })
  }

  // 逐条回放消息，让客户端恢复完整的对话界面
  for (const msg of messages ?? []) {
    await this.processMessage(msg)
  }

  // 发送用量更新
  await sendUsageUpdate(this.connection, this.sdk, sessionId, directory)
  return result
}
```

### 分叉会话

`unstable_forkSession` 基于已有会话创建分支——这是 AI 编码中"尝试不同方案"的核心能力：

```typescript
async unstable_forkSession(params: ForkSessionRequest) {
  const forked = await this.sdk.session.fork({
    sessionID: params.sessionId,
    directory,
  }).then((x) => x.data)

  const sessionId = forked.id
  await this.sessionManager.load(sessionId, directory, mcpServers, model)

  // 回放分叉后的会话历史
  for (const msg of messages ?? []) {
    await this.processMessage(msg)
  }
  return mode
}
```

### 会话列表

`unstable_listSessions` 支持分页查询，按更新时间倒序排列：

```typescript
async unstable_listSessions(params: ListSessionsRequest) {
  const sessions = await this.sdk.session.list({
    directory: params.cwd ?? undefined,
    roots: true,
  }).then((x) => x.data ?? [])

  const sorted = sessions.toSorted((a, b) => b.time.updated - a.time.updated)
  // 基于游标的分页实现...
}
```

## 13.3 事件处理管线

ACP Agent 在构造时启动一个**长轮询事件循环**，持续监听 OpenCode 引擎发出的事件：

```typescript
private async runEventSubscription() {
  while (true) {
    if (this.eventAbort.signal.aborted) return
    const events = await this.sdk.global.event({
      signal: this.eventAbort.signal,
    })
    for await (const event of events.stream) {
      if (this.eventAbort.signal.aborted) return
      await this.handleEvent(payload as Event)
    }
  }
}
```

`handleEvent` 根据事件类型分发处理：

**权限请求事件（`permission.asked`）**：

权限请求使用**每会话队列化**策略，确保同一会话的权限请求按序处理，避免并发冲突：

```typescript
case "permission.asked": {
  const session = this.sessionManager.tryGet(permission.sessionID)
  if (!session) return

  // 队列化：将新请求追加到该会话的权限队列末尾
  const prev = this.permissionQueues.get(permission.sessionID)
    ?? Promise.resolve()
  const next = prev.then(async () => {
    const res = await this.connection.requestPermission({
      sessionId: permission.sessionID,
      toolCall: {
        toolCallId: permission.tool?.callID ?? permission.id,
        status: "pending",
        title: permission.permission,
        rawInput: permission.metadata,
        kind: toToolKind(permission.permission),
      },
      options: this.permissionOptions,
    })
    // 将用户选择回传给引擎
    await this.sdk.permission.reply({
      requestID: permission.id,
      reply: res.outcome.optionId as "once" | "always" | "reject",
      directory,
    })
  })
  this.permissionQueues.set(permission.sessionID, next)
}
```

特别地，当用户批准了 `edit` 类型的权限后，Agent 还会将文件的新内容推送给客户端，让 Desktop 应用实时显示 diff：

```typescript
if (res.outcome.optionId !== "reject" && permission.permission == "edit") {
  const filepath = metadata["filepath"]
  const diff = metadata["diff"]
  const content = await Filesystem.readText(filepath)
  const newContent = getNewContent(content, diff)
  if (newContent) {
    this.connection.writeTextFile({
      sessionId: session.id,
      path: filepath,
      content: newContent,
    })
  }
}
```

**消息增量事件（`message.part.delta`）**：

文本和推理内容的增量通过不同的更新类型推送：

```typescript
case "message.part.delta": {
  if (part.type === "text" && props.field === "text") {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: props.delta },
      },
    })
  }
  if (part.type === "reasoning" && props.field === "text") {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: props.delta },
      },
    })
  }
}
```

## 13.4 工具执行追踪

工具调用的生命周期通过 `message.part.updated` 事件追踪，状态从 `pending → running → completed/error` 逐步推进。

`toolStart` 方法确保每个工具调用只发送一次 `pending` 状态：

```typescript
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
      status: "pending",
    },
  })
}
```

对于 `bash` 工具，OpenCode 实现了**输出快照去重**：只有当输出内容的哈希值变化时才推送更新，避免长时间运行的命令产生大量重复推送：

```typescript
if (part.tool === "bash") {
  if (this.bashSnapshots.get(part.callID) === hash) {
    // 输出未变化，发送 in_progress 但不附带内容
    return
  }
  this.bashSnapshots.set(part.callID, hash)
}
```

工具类型映射由 `toToolKind` 函数完成，将 OpenCode 内部的工具名称转换为 ACP 标准类型：

```typescript
function toToolKind(toolName: string): ToolKind {
  switch (toolName.toLocaleLowerCase()) {
    case "bash":     return "execute"
    case "webfetch": return "fetch"
    case "edit":
    case "patch":
    case "write":    return "edit"
    case "grep":
    case "glob":     return "search"
    case "list":
    case "read":     return "read"
    default:         return "other"
  }
}
```

## 13.5 Plan/Todo 同步

当 Agent 在执行过程中使用 `todowrite` 工具更新任务列表时，ACP 会将 Todo 状态同步给客户端的 Plan 视图：

```typescript
if (part.tool === "todowrite") {
  const parsedTodos = z.array(Todo.Info)
    .safeParse(JSON.parse(part.state.output))

  if (parsedTodos.success) {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "plan",
        entries: parsedTodos.data.map((todo) => {
          // 将 OpenCode 的 "cancelled" 映射为 ACP 的 "completed"
          const status: PlanEntry["status"] =
            todo.status === "cancelled"
              ? "completed"
              : (todo.status as PlanEntry["status"])
          return {
            priority: "medium",
            status,
            content: todo.content,
          }
        }),
      },
    })
  }
}
```

这种同步让 Desktop 客户端可以实时展示任务进度面板——用户能看到哪些步骤已完成、哪些正在进行、哪些还在排队。

## 13.6 实战：Desktop 客户端如何通过 ACP 控制引擎

让我们还原一个完整的 Desktop 客户端与 OpenCode 引擎通过 ACP 交互的流程。

**场景**：用户在 Desktop 应用中打开一个 React 项目，要求 AI "重构 UserList 组件"。

```
时间线 →

Desktop                        ACP Agent                      OpenCode Engine
  │                               │                               │
  ├──initialize()────────────────►│                               │
  │◄─────agentInfo/capabilities──┤                               │
  │                               │                               │
  ├──newSession(cwd, mcpServers)─►│──sessionManager.create()────►│
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

整个流程中，Desktop 客户端不需要了解 OpenCode 引擎的内部实现。它只需要实现 ACP 的客户端接口，就能获得完整的 AI 编码助手能力。

与 Cursor 将引擎嵌入 VS Code 扩展不同，OpenCode 的 ACP 架构让引擎和客户端可以独立演进。更新引擎不影响客户端，添加新客户端（如 Web 版、移动版）也不需要修改引擎。

## 本章要点

- `ACP.Agent` 通过事件订阅循环实现实时推送，覆盖文本增量、工具状态和权限请求三大事件类型
- 会话管理提供 create、load、fork、resume、list 五个操作，`loadSession` 通过回放历史消息还原客户端状态
- 权限请求采用每会话队列化策略，确保同一会话的多个权限请求按序处理，`edit` 权限批准后还会推送文件新内容
- bash 工具使用输出快照哈希去重，避免长时间运行命令产生大量重复推送
- Todo 状态通过 `plan` 类型的 `sessionUpdate` 同步，让 Desktop 客户端可以展示实时任务进度面板
