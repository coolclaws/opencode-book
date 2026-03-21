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

### 字段详解

**id** 使用 `SessionID.descending()` 生成，降序前缀确保最新会话在数据库中自然排在前面，无需额外 ORDER BY。**slug** 由 `Slug.create()` 生成，是 URL 安全的短标识，用户可通过 `opencode resume <slug>` 快速恢复会话。

**projectID** 和 **workspaceID** 构成 Session 的"归属坐标"——projectID 是必填的项目绑定，workspaceID 可选，支持多工作区场景。**directory** 记录工作目录路径，工具执行都以此为基准。**parentID** 实现会话层级关系，Task 工具创建的子会话通过此字段指向父 Session，删除时递归清理所有子会话。

**time** 包含四个时间戳，其中 `compacting` 兼具互斥锁和恢复标记的双重功能——压缩启动时写入，完成后清除，异常中断可通过过期时间戳检测。`archived` 标记归档时间，`listGlobal` 默认过滤已归档会话。**permission** 允许会话级别覆盖全局权限规则。**revert** 记录回退元信息（messageID、partID、snapshot、diff），支持精确恢复到任意历史节点。

一个容易产生误解的地方：Session.Info 本身不包含 cost 或 tokens 字段。Token 用量追踪在更细粒度的层级——每条 Assistant 消息的 tokens 字段上。`getUsage` 函数使用 `Decimal` 精确计算成本（避免浮点误差），并处理了 provider 差异——Anthropic 的 inputTokens 不含缓存 token，而 OpenRouter 和 OpenAI 包含，代码通过检测 provider metadata 来决定是否扣除。需要统计会话总成本时，从 Assistant 消息中按需汇总即可。

## 5.2 Session CRUD 操作

**创建（create）**：`createNext` 函数生成带有降序 ID 的新 Session，自动关联当前项目。`Database.effect` 将事件发布推迟到事务成功提交后，避免"数据未写入但 UI 已更新"的不一致状态。

**Fork（分叉）**：创建会话副本，可从指定消息处截断。通过 `idMap` 重新映射消息 ID 以维护父子关系，标题自动递增（`"原标题 (fork #1)"` → `"原标题 (fork #2)"`）。

**删除（remove）**：递归删除会话及所有子会话，CASCADE 自动清理消息和 Part。

**列表（list）**：支持按目录、工作区、关键词、时间等多维度过滤。`listGlobal` 提供跨项目全局视图。

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

`SessionProcessor.create()` 接收会话上下文和一条空的 Assistant 消息。内部维护 `toolcalls`（进行中的工具调用）、`blocked`（权限阻断）、`attempt`（重试次数）、`needsCompaction`（溢出标记）四个状态变量。

`processor.process(streamInput)` 在 `while(true)` 内调用 `LLM.stream` 获取流，遍历 `fullStream` 中十多种事件：

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

`text-end` 事件不仅持久化文本，还触发 `Plugin.trigger("experimental.text.complete", ...)` 钩子允许插件后处理。`reasoning-end` 对文本执行 `trimEnd()` 去除尾部空白。

### finish-step：Cost、Token 与溢出检测

`finish-step` 事件中，Processor 调用 `Session.getUsage()` 提取 token 分量并计算成本，累加到 Assistant 消息的 `cost` 字段。同时检查文件变更（`Snapshot.patch()`）、异步计算变更摘要（`SessionSummary.summarize()`），以及调用 `isOverflow` 判断是否需要上下文压缩。

### 错误处理与返回值

`ContextOverflowError` 直接触发压缩。其他错误通过 `SessionRetry.retryable()` 判断是否可重试（退避延迟递增），不可重试的错误记录到消息并广播。循环结束后，所有未完成的工具调用被强制标记为 error，确保 Part 有明确终态。`process()` 返回 `"continue"`（正常）、`"compact"`（需压缩）或 `"stop"`（被阻断）驱动上层控制流。

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

## 5.8 完整生命周期概览

将上述组件串联，一次完整交互的关键阶段为：Session 创建（降序 ID + slug）→ 用户消息写入（upsert + 事件延迟发布）→ Agent 选择与步数检查（`step >= maxSteps` 时注入 `MAX_STEPS`）→ LLM 调用（并行准备 + 分层提示词 + 工具过滤）→ Processor 消费事件流（文本/推理/工具调用各自更新 Part）→ 工具执行（死循环检测 + 权限检查）→ Token 计算与溢出检测 → 状态清理（未完成工具调用标记 error、`SessionSummary.summarize()` 计算变更摘要）。

整个流程通过 Bus 事件驱动 UI 实时渲染。事件驱动架构使得 Processor 不需要知道有多少消费者在监听——TUI、Web UI、SSE 客户端都可以独立订阅自己关心的事件。

## 本章要点

- Session.Info 包含 id（降序排列）、slug（URL 友好）、项目/工作区绑定、parentID（子会话层级）、变更摘要、分享链接、时间追踪（含 compacting 互斥锁和 archived 归档标记）、权限覆盖、回退元信息等完整元数据，但不包含 cost/tokens——这些通过 `getUsage` 追踪在单条 Assistant 消息上，使用 `Decimal` 精确计算并处理不同 provider 的 token 计数差异
- Session 支持 create、fork、remove、list 等完整的 CRUD 操作，fork 通过 `idMap` 重新映射消息 ID 维护父子关系
- 消息采用 Message-Part 二级结构，通过 upsert 模式和 Bus 事件系统实现实时同步，`updatePartDelta` 仅发布事件不写库
- LLM.stream 通过 Promise.all 并行获取配置，分层构建系统提示词，经 Plugin 钩子转换后调用 Vercel AI SDK
- Processor 消费 fullStream 中的十多种事件类型，包括 reasoning 的 start/delta/end、text 的 start/delta/end、tool 的 input-start/call/result/error、step 的 start/finish 等
- 工具调用经历 pending → running → completed/error 状态机，死循环检测通过 `JSON.stringify` 比较参数
- 错误处理区分上下文溢出（触发压缩）、可重试错误（退避重试）和不可恢复错误（记录并停止），流中断后强制清理未完成的工具调用
- 整条调用链通过 Event Bus 驱动 UI 实时更新，数据持久化与事件发布在事务中保持一致
