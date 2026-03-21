# 第 5 章　Session 生命周期

Session 是 OpenCode 中管理对话状态的核心实体。从创建到归档，从消息存储到 LLM 流式调用，Session 贯穿了整个交互流程。本章将剖析 Session 的数据结构、CRUD 操作、消息管理机制，以及驱动 AI 响应的 Processor 架构。

> **源码位置**：packages/opencode/src/session/index.ts

## 5.1 Session.Info 数据结构

Session 的核心数据结构使用 Zod schema 定义，每个字段都承载着明确的领域语义。理解这些字段是掌握 Session 生命周期的基础。

```typescript
// 文件: packages/opencode/src/session/index.ts L122-163
export const Info = z.object({
  id: SessionID.zod,                        // 唯一标识，降序前缀
  slug: z.string(),                         // URL 友好的短标识
  projectID: ProjectID.zod,                 // 所属项目 ID
  workspaceID: WorkspaceID.zod.optional(),  // 工作区 ID（多工作区支持）
  directory: z.string(),                    // 工作目录路径
  parentID: SessionID.zod.optional(),       // 父会话（子会话机制）
  title: z.string(),                        // 会话标题
  version: z.string(),                      // OpenCode 版本号
  summary: z.object({                       // 代码变更摘要
    additions: z.number(),
    deletions: z.number(),
    files: z.number(),
    diffs: Snapshot.FileDiff.array().optional(),
  }).optional(),
  share: z.object({ url: z.string() }).optional(),  // 分享链接
  time: z.object({                          // 时间追踪
    created: z.number(),
    updated: z.number(),
    compacting: z.number().optional(),      // 正在压缩的时间戳
    archived: z.number().optional(),        // 归档时间戳
  }),
  permission: Permission.Ruleset.optional(),  // 会话级权限覆盖
  revert: z.object({                        // 回退信息
    messageID: MessageID.zod,
    partID: PartID.zod.optional(),
    snapshot: z.string().optional(),
    diff: z.string().optional(),
  }).optional(),
})
```

### 字段完整详解

**id** 使用 `SessionID.descending()` 生成。降序前缀确保在数据库中按 ID 排序时，最新的会话自然排在前面，无需额外的 ORDER BY 子句即可实现"最近优先"的列表效果。这是一种在 SQLite 这类嵌入式数据库中常见的性能优化手段——通过数据本身的排列顺序避免排序开销。

**slug** 由 `Slug.create()` 生成，是一个简短的、URL 安全的标识符。与冗长的 ID 不同，slug 适合出现在分享链接和命令行参数中。用户执行 `opencode resume <slug>` 即可快速恢复会话，不必记忆完整的 Session ID。

**projectID** 和 **workspaceID** 将 Session 绑定到特定的项目和工作区。projectID 是必填字段——每个 Session 必须归属于某个项目。workspaceID 是可选的，支持多工作区场景下的会话隔离。这两个字段共同构成了 Session 的"归属坐标"，使得 list 操作能够按项目和工作区精确筛选。在 `listGlobal` 中还可以跨项目查询，此时会关联 `ProjectTable` 获取项目元信息（名称、worktree 路径），为全局会话视图提供完整上下文。

**directory** 记录会话的工作目录路径。工具执行（如文件读写、终端命令）都以此目录为基准。当用户在不同目录启动 OpenCode 时，每个 Session 都忠实地记录下自己的工作上下文。

**parentID** 是实现会话层级关系的关键。当 Task 工具创建子会话时，子 Session 的 parentID 指向父 Session。删除父会话时，`remove` 函数会递归调用 `children()` 获取所有子会话并逐一删除，避免孤立数据残留。

**summary** 追踪整个会话期间的代码变更统计：新增行数（additions）、删除行数（deletions）、涉及的文件数（files），以及可选的详细差异数组（diffs）。`SessionSummary.summarize()` 在 Processor 的每个 `finish-step` 事件后异步计算这些指标。

**time** 包含四个时间戳，其中 `compacting` 特别值得关注。它兼具互斥锁和恢复标记的双重功能——当上下文压缩启动时写入当前时间戳，压缩完成后清除。如果某次压缩异常中断（例如进程崩溃），系统可以通过检测过期的 compacting 时间戳来判断是否需要恢复。`archived` 标记会话归档时间，`listGlobal` 默认过滤掉已归档的会话（`isNull(SessionTable.time_archived)`），但数据仍然保留，用户可以通过参数 `archived: true` 查看历史。

**permission** 允许在会话级别覆盖全局权限规则。某些 Session 可能需要更宽松或更严格的工具权限，而不影响其他会话。`setPermission` 函数可以在运行时动态修改这个字段。

**revert** 记录回退操作的元信息。`messageID` 指向触发回退的消息，`partID` 精确到具体的 Part。`snapshot` 和 `diff` 保存文件系统状态的快照标识和差异内容，使回退操作可以精确地将代码恢复到任意历史节点。`setRevert` 和 `clearRevert` 分别设置和清除回退状态。

一个容易产生误解的地方值得澄清：Session.Info 本身不包含 cost 或 tokens 字段。Token 用量和成本追踪在更细粒度的层级——每条 Assistant 消息的 tokens 字段上。`getUsage` 函数负责从 SDK 返回的 `LanguageModelV2Usage` 中提取输入/输出/缓存 token 数，并使用 `Decimal` 精确计算成本（避免浮点误差）。它还处理了不同 provider 的 token 计数差异——Anthropic 的 inputTokens 不含缓存 token，而 OpenRouter 和 OpenAI 的 inputTokens 包含缓存 token，代码通过检测 provider metadata 来决定是否需要扣除。需要统计会话总成本时，按需从所有 Assistant 消息中汇总即可，避免了在 Session 层面维护聚合计数器的一致性问题。

## 5.2 Session CRUD 操作

**创建（create）**：`createNext` 函数生成带有降序 ID 的新 Session，自动关联当前项目并设置默认标题。如果配置了自动分享（`Flag.OPENCODE_AUTO_SHARE` 或 `cfg.share === "auto"`），创建后会异步触发分享流程，失败时静默忽略以不影响主流程：

```typescript
// 文件: packages/opencode/src/session/index.ts L297-338
export async function createNext(input: { ... }) {
  const result: Info = {
    id: SessionID.descending(input.id),
    slug: Slug.create(),
    version: Installation.VERSION,
    projectID: Instance.project.id,
    title: input.title ?? createDefaultTitle(!!input.parentID),
    time: { created: Date.now(), updated: Date.now() },
    // ...
  }
  Database.use((db) => {
    db.insert(SessionTable).values(toRow(result)).run()
    Database.effect(() => Bus.publish(Event.Created, { info: result }))
  })
  return result
}
```

`Database.effect` 的使用值得注意——它将事件发布推迟到数据库事务成功提交之后。如果事务因任何原因回滚，事件不会被发布，从而避免了"数据未写入但 UI 已更新"的不一致状态。默认标题由 `createDefaultTitle` 生成，根据是否为子会话添加不同前缀（`"New session - "` 或 `"Child session - "`），后接 ISO 时间戳。

**Fork（分叉）**：`fork` 函数创建一个会话的副本，可以指定从哪条消息截断。它逐条复制消息和 Part，同时通过 `idMap` 重新映射消息 ID 以维护父子关系：

```typescript
// 文件: packages/opencode/src/session/index.ts L239-280
export const fork = fn(z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod.optional(),
}), async (input) => {
  const session = await createNext({ title: getForkedTitle(original.title) })
  const idMap = new Map<string, MessageID>()
  for (const msg of msgs) {
    if (input.messageID && msg.info.id >= input.messageID) break
    const newID = MessageID.ascending()
    idMap.set(msg.info.id, newID)
    // 复制消息和 Part，重新映射 parentID
  }
  return session
})
```

Fork 的标题通过 `getForkedTitle` 生成，支持递增编号（`"原标题 (fork #1)"` → `"原标题 (fork #2)"`）。消息截断使用 ID 比较——因为 Session 中消息按 ID 排序，`>=` 比较天然实现了"从指定消息处截断"的语义。

**删除（remove）**：递归删除会话及其所有子会话，同时取消分享。数据库通过 CASCADE 自动清理关联的消息和 Part。

**列表（list）**：支持按目录、工作区、搜索关键词、时间范围等多维度过滤，默认按更新时间降序排列。`listGlobal` 提供跨项目的全局会话视图，额外支持 `cursor` 分页和 `archived` 过滤。

## 5.3 消息与 Part 管理

OpenCode 采用二级结构管理对话内容：Message 包含 Part，Part 是实际的内容单元。

**updateMessage** 使用 upsert 模式（`onConflictDoUpdate`），同一消息 ID 重复写入时自动更新。每次操作都通过 `Database.effect` 延迟发布 `MessageV2.Event.Updated` 事件，确保事务一致性。

**updatePart** 同样采用 upsert 模式，支持 text、tool、reasoning、step-start、step-finish、patch、compaction 等多种 Part 类型。持久化完成后发布 `PartUpdated` 事件，传递的是 `structuredClone(part)` 深拷贝，避免后续修改影响事件消费者。

**updatePartDelta** 用于流式增量更新，只发送文本增量而非完整内容。它直接通过 Bus 发布 `PartDelta` 事件，不写入数据库——增量数据是瞬态的，完整文本会在 `text-end` 或 `reasoning-end` 时通过 `updatePart` 一次性持久化。

**removePart** 和 **removeMessage** 支持精确删除，CASCADE 机制确保删除消息时自动清理其下的所有 Part。

> **源码位置**：packages/opencode/src/session/llm.ts

## 5.4 LLM 流式调用链

`LLM.stream` 是 OpenCode 调用大模型的核心入口。它接收 `StreamInput` 参数，包含用户消息、模型配置、Agent 信息和工具集：

```typescript
// 文件: packages/opencode/src/session/llm.ts L25-45
export type StreamInput = {
  user: MessageV2.User        // 用户消息
  sessionID: string            // 会话 ID
  model: Provider.Model        // 模型配置
  agent: Agent.Info            // Agent 配置
  system: string[]             // 系统提示词数组
  abort: AbortSignal           // 中断信号
  messages: ModelMessage[]     // 历史消息
  tools: Record<string, Tool>  // 可用工具
  // ...
}
```

### 并行准备阶段

`LLM.stream` 内部的第一步是通过 `Promise.all` 并行获取三类信息：Provider 配置（确定 API 端点和认证）、LanguageModel 实例（封装了具体的模型能力）、Auth 信息（用户认证状态）。三者互不依赖，并行获取将冷启动延迟降到最低。

```typescript
// 文件: packages/opencode/src/session/llm.ts L60-65
const [provider, languageModel, auth] = await Promise.all([
  Provider.fromModel(input.model),
  Provider.languageModel(input.model),
  Auth.get(),
])
```

### 系统提示词构建

系统提示词的组装遵循严格的优先级链。首先检查 Agent 是否定义了自定义 prompt——如果有，它作为最高优先级的系统指令。否则退回到 Provider 级别的默认 prompt。在此基础上，叠加 `StreamInput.system` 数组中的额外提示词（通常包含工具描述、项目上下文等），以及用户消息 `user.system` 字段中携带的会话级系统指令。

```typescript
// 文件: packages/opencode/src/session/llm.ts L70-85
const systemPrompts: string[] = []
if (input.agent.systemPrompt) {
  systemPrompts.push(input.agent.systemPrompt)
} else if (provider.defaultPrompt) {
  systemPrompts.push(provider.defaultPrompt)
}
systemPrompts.push(...input.system)
if (input.user.system) {
  systemPrompts.push(input.user.system)
}
```

这个分层设计让不同层级各司其职：Agent 定义角色行为，Provider 处理模型特性，system 数组注入运行时上下文，user.system 传递用户的即时指令。组装完成后，Plugin 系统通过 `experimental.chat.system.transform` 钩子获得修改提示词的机会。

### 工具过滤与模型调用

`resolveTools()` 负责根据权限配置过滤可用工具集。它调用 `Permission.disabled()` 计算出当前被禁用的工具名称集合，然后从完整工具列表中剔除这些工具。此外，用户消息中可能携带单独的工具开关设置（`user.tools`），`resolveTools` 会合并这些设置。一切就绪后，`LLM.stream` 调用 Vercel AI SDK 的 `streamText()` 发起流式请求，返回 `StreamTextResult`，其中的 `fullStream` 异步可迭代对象是后续 Processor 消费的核心数据源。

## 5.5 Processor 执行链

> **源码位置**：packages/opencode/src/session/processor.ts

`SessionProcessor` 是 LLM 响应到可视化消息之间的桥梁。它消费 `fullStream` 中的事件流，将每个事件转化为数据库中的 Message Part，同时驱动工具执行和状态管理。

### 初始化与状态变量

`SessionProcessor.create()` 接收会话上下文和一条空的 Assistant 消息作为容器。Processor 内部维护四个关键状态变量：`toolcalls` 记录进行中的工具调用（按 toolCallID 索引），`blocked` 标记是否被权限拒绝阻断，`attempt` 追踪重试次数，`needsCompaction` 标记是否触发了上下文溢出。

### 事件处理循环

`processor.process(streamInput)` 启动主处理循环。它在 `while(true)` 内调用 `LLM.stream` 获取流，然后遍历 `fullStream` 中的每个事件。完整的事件类型远不止六种——源码中实际处理了十多种事件：

```typescript
// 文件: packages/opencode/src/session/processor.ts L56-351
for await (const value of stream.fullStream) {
  input.abort.throwIfAborted()
  switch (value.type) {
    case "start":              // 会话开始，设置状态为 busy
    case "reasoning-start":    // 推理链开始，创建 reasoning Part
    case "reasoning-delta":    // 推理链增量文本
    case "reasoning-end":      // 推理链结束，trimEnd 并持久化
    case "text-start":         // 文本回复开始，创建 text Part
    case "text-delta":         // 文本增量
    case "text-end":           // 文本结束，触发 Plugin 钩子
    case "tool-input-start":   // 工具参数流式开始，创建 pending Part
    case "tool-call":          // 工具参数完整，转为 running
    case "tool-result":        // 工具执行完成 → completed
    case "tool-error":         // 工具执行失败 → error
    case "start-step":         // 步骤开始，创建快照
    case "finish-step":        // 步骤结束，计算 token/cost
    case "error":              // 流级别错误
  }
}
```

每种事件类型对应一个明确的处理逻辑。特别值得注意的是 `text-end` 事件——它不仅持久化文本，还会触发 `Plugin.trigger("experimental.text.complete", ...)` 钩子，允许插件对模型输出进行后处理。`reasoning-end` 则会对文本执行 `trimEnd()` 去除尾部空白。

### finish-step：Cost 与 Token 累计

Token 用量和成本计算集中在 `finish-step` 事件中。Processor 调用 `Session.getUsage()` 从 SDK 的 `usage` 对象中提取各分量：

```typescript
// 文件: packages/opencode/src/session/processor.ts L246-264
case "finish-step":
  const usage = Session.getUsage({
    model: input.model,
    usage: value.usage,
    metadata: value.providerMetadata,
  })
  input.assistantMessage.finish = value.finishReason
  input.assistantMessage.cost += usage.cost
  input.assistantMessage.tokens = usage.tokens
  await Session.updateMessage(input.assistantMessage)
```

成本累加到 Assistant 消息的 `cost` 字段上（跨步骤累加），tokens 则每次覆盖为最新值。紧接着，Processor 检查是否产生了文件变更——如果 `snapshot` 存在，调用 `Snapshot.patch()` 计算差异并存储为 patch 类型的 Part。最后调用 `SessionSummary.summarize()` 异步计算变更摘要，并检查上下文是否溢出。

### 错误处理与重试

主循环外的 `catch` 块处理两类错误。`ContextOverflowError` 表示上下文超限，直接设置 `needsCompaction = true`，交由上层处理。其他错误通过 `SessionRetry.retryable()` 判断是否可重试——如果可以，递增 `attempt` 计数器，计算退避延迟后休眠，然后 `continue` 重新进入循环。不可重试的错误记录在 Assistant 消息的 `error` 字段中并广播。

循环结束后，还有一段清理逻辑：遍历所有仍在进行中的工具调用（status 不是 completed 或 error 的），将它们标记为 error 状态并写入 "Tool execution aborted" 错误信息。这确保了即使流被中断，所有 Part 都有明确的终态。

### 返回值语义

`process()` 的返回值驱动上层的控制流：`"continue"` 表示正常完成；`"compact"` 表示 token 溢出，需要先压缩上下文再继续；`"stop"` 表示被阻断（用户取消、权限拒绝、不可恢复错误），应终止处理。

## 5.6 Tool Call 状态机

工具调用是 Processor 中最复杂的状态转换流程。每个工具调用经历四个明确的状态：

```text
  ┌─────────┐      ┌─────────┐      ┌───────────┐
  │ pending │ ───→ │ running │ ───→ │ completed │
  └─────────┘      └─────────┘      └───────────┘
                        │
                        └──────────→ ┌───────────┐
                                     │   error   │
                                     └───────────┘
```

**tool-input-start**：当模型开始生成工具调用的参数时，Processor 创建一个 `pending` 状态的 tool Part。此时参数可能尚未完整——流式传输中参数是逐步到达的。Part 的 state 包含一个空的 `input` 对象和空的 `raw` 字符串。

**tool-call**：参数完整后触发此事件。Processor 将 Part 状态从 `pending` 转为 `running`，写入完整的 `input` 参数和 `time.start` 时间戳。在实际执行之前，死循环检测机制介入——取最近 `DOOM_LOOP_THRESHOLD`（3）条 tool Part，检查是否为相同工具、相同参数（通过 `JSON.stringify` 比较）。如果检测到循环，触发 `Permission.ask()` 请求用户确认。

**tool-result**：工具执行成功，结果写入 Part 的 `output` 字段，同时记录 `metadata`、`title`、`attachments` 等附加信息，状态转为 `completed`，`time.end` 记录完成时间。完成后从 `toolcalls` 映射中删除该条目。

**tool-error**：工具执行失败。Processor 区分两类错误：`Permission.RejectedError` 或 `Question.RejectedError` 表示用户主动拒绝，此时 `blocked` 标记会被设置（除非配置了 `continue_loop_on_deny`），处理循环将在当前步骤结束后停止；其他错误被视为工具本身的异常，错误信息写入 Part 的 `error` 字段反馈给模型，让它决定后续行动。

## 5.7 完整对话调用链

下面的时序图展示了一次完整用户交互从输入到响应的全链路流转：

```text
  用户        SessionPrompt    Processor     LLM.stream    Vercel SDK    Tool     Event Bus
   │               │              │              │             │          │          │
   │──输入消息────→│              │              │             │          │          │
   │               │──创建 User──→│              │             │          │          │
   │               │  Message     │              │             │          │          │
   │               │──create()───→│              │             │          │          │
   │               │              │──stream()───→│             │          │          │
   │               │              │              │──构建提示词──│          │          │
   │               │              │              │──resolveTools│          │          │
   │               │              │              │──streamText→│          │          │
   │               │              │              │             │          │          │
   │               │              │←──fullStream 事件流────────│          │          │
   │               │              │                            │          │          │
   │               │              │──text → 更新 Text Part─────│──────────│─publish→│
   │               │              │                            │          │          │──→UI
   │               │              │──tool-call → Tool Part─────│──────────│          │
   │               │              │    (pending → running)     │          │          │
   │               │              │──────────────执行工具──────→│──────────│          │
   │               │              │←─────────────tool-result───│──────────│          │
   │               │              │    (running → completed)   │          │──publish→│
   │               │              │                            │          │          │──→UI
   │               │              │──finish-step───────────────│          │          │
   │               │              │    计算 tokens/cost        │          │          │
   │               │              │    isOverflow? ────────────│          │          │
   │               │              │                            │          │          │
   │               │←─返回 compact/continue/stop───────────────│          │          │
   │←──UI 实时更新─│              │              │             │          │          │
```

从用户输入到 UI 更新，数据流经六个组件。`SessionPrompt` 将用户输入结构化为 Message 和 Part，交给 `Processor` 处理。Processor 通过 `LLM.stream` 调用模型，后者完成提示词构建、工具过滤等准备工作后委托 Vercel AI SDK 发起实际的 API 请求。SDK 返回的事件流逐个被 Processor 消费，文本事件直接更新 Part，工具调用事件触发工具执行并将结果反馈。每个 Part 更新都通过 Event Bus 广播，UI 层订阅这些事件实现实时渲染。

整个链路中，数据始终"向前流动"：用户消息 → 模型 → 事件流 → Part 更新 → UI。唯一的"回流"发生在工具调用场景——工具结果需要反馈给模型以生成后续响应，这通过 Processor 的 while 循环实现：当一个步骤包含工具调用时，模型会在下一个步骤继续生成，直到不再需要工具为止。

## 5.8 实战：追踪一次完整对话的生命周期

将上述组件串联起来，一次完整的用户交互经历以下阶段：

1. **Session 创建**：`Session.create()` 在数据库中插入新记录，发布 `session.created` 事件。降序 ID 确保新会话在列表顶部，slug 为后续分享和恢复提供简短标识。

2. **用户消息写入**：`SessionPrompt.command()` 接收用户输入，创建 User 类型的 Message 和对应的 Text Part。消息通过 upsert 写入数据库，事件延迟到事务提交后发布。

3. **Agent 选择与步数检查**：根据当前会话状态选择合适的 Agent（默认为 build），加载其权限配置和系统提示词。`prompt.ts` 读取 `agent.steps` 并检查是否到达步数上限——如果 `step >= maxSteps`，注入 `MAX_STEPS` 消息并清空工具列表，迫使模型纯文本回复。

4. **LLM 调用**：`LLM.stream()` 并行获取 Provider、LanguageModel、Auth 信息，构建分层系统提示词，通过 `resolveTools()` 过滤工具集，最终调用 Vercel AI SDK 的 `streamText` 发起流式请求。

5. **响应处理**：`SessionProcessor` 消费流事件，将文本、推理过程、工具调用分别存储为不同类型的 Part。每个 Part 的状态变化都实时持久化并广播。text-end 触发 Plugin 后处理钩子。

6. **工具执行**：模型请求调用工具时，Processor 先进行死循环检测（连续 3 次相同调用触发 `Permission.ask`），再执行工具，将结果作为 tool-result 反馈给模型。`Permission.RejectedError` 和 `Question.RejectedError` 导致 `blocked` 标记被设置。

7. **Token 检查与重试**：每个 step 完成后，`getUsage` 从各 provider 的不同 token 计数方式中统一提取数据，使用 `Decimal` 精确计算成本。同时检查累积 token 是否超出上下文窗口。流级别错误会尝试重试（退避延迟递增），不可重试错误记录到消息上。

8. **状态更新与清理**：`SessionSummary.summarize()` 异步计算代码变更摘要，`Session.touch()` 更新时间戳。所有未完成的工具调用被强制标记为 error 状态，确保 Part 都有明确终态。

整个流程通过 Bus 事件驱动，UI 层监听 `MessageV2.Event.PartUpdated` 和 `MessageV2.Event.PartDelta` 实现实时渲染。事件驱动架构使得 Processor 不需要知道有多少消费者在监听——TUI、Web UI、SSE 客户端都可以独立订阅自己关心的事件。

## 本章要点

- Session.Info 包含 id（降序排列）、slug（URL 友好）、项目/工作区绑定、parentID（子会话层级）、变更摘要、分享链接、时间追踪（含 compacting 互斥锁和 archived 归档标记）、权限覆盖、回退元信息等完整元数据，但不包含 cost/tokens——这些通过 `getUsage` 追踪在单条 Assistant 消息上，使用 `Decimal` 精确计算并处理不同 provider 的 token 计数差异
- Session 支持 create、fork、remove、list 等完整的 CRUD 操作，fork 通过 `idMap` 重新映射消息 ID 维护父子关系
- 消息采用 Message-Part 二级结构，通过 upsert 模式和 Bus 事件系统实现实时同步，`updatePartDelta` 仅发布事件不写库
- LLM.stream 通过 Promise.all 并行获取配置，分层构建系统提示词，经 Plugin 钩子转换后调用 Vercel AI SDK
- Processor 消费 fullStream 中的十多种事件类型，包括 reasoning 的 start/delta/end、text 的 start/delta/end、tool 的 input-start/call/result/error、step 的 start/finish 等
- 工具调用经历 pending → running → completed/error 状态机，死循环检测通过 `JSON.stringify` 比较参数
- 错误处理区分上下文溢出（触发压缩）、可重试错误（退避重试）和不可恢复错误（记录并停止），流中断后强制清理未完成的工具调用
- 整条调用链通过 Event Bus 驱动 UI 实时更新，数据持久化与事件发布在事务中保持一致
