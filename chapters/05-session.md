# 第 5 章　Session 生命周期

Session 是 OpenCode 中管理对话状态的核心实体。从创建到归档，从消息存储到 LLM 流式调用，Session 贯穿了整个交互流程。本章将剖析 Session 的数据结构、CRUD 操作、消息管理机制，以及驱动 AI 响应的 Processor 架构。

> **源码位置**：packages/opencode/src/session/index.ts

## 5.1 Session.Info 数据结构

Session 的核心数据结构同样使用 Zod schema 定义：

```typescript
export const Info = z.object({
  id: Identifier.schema("session"),       // 唯一标识，带 "session" 前缀
  slug: z.string(),                       // URL 友好的短标识
  projectID: z.string(),                  // 所属项目 ID
  workspaceID: z.string().optional(),     // 工作区 ID（多工作区支持）
  directory: z.string(),                  // 工作目录路径
  parentID: Identifier.schema("session").optional(), // 父会话（子会话机制）
  title: z.string(),                      // 会话标题
  version: z.string(),                    // OpenCode 版本号
  summary: z.object({                     // 代码变更摘要
    additions: z.number(),
    deletions: z.number(),
    files: z.number(),
    diffs: Snapshot.FileDiff.array().optional(),
  }).optional(),
  share: z.object({ url: z.string() }).optional(),  // 分享链接
  time: z.object({                        // 时间追踪
    created: z.number(),
    updated: z.number(),
    compacting: z.number().optional(),    // 正在压缩的时间戳
    archived: z.number().optional(),      // 归档时间戳
  }),
  permission: PermissionNext.Ruleset.optional(),  // 会话级权限覆盖
  revert: z.object({                      // 回退信息
    messageID: z.string(),
    partID: z.string().optional(),
    snapshot: z.string().optional(),
    diff: z.string().optional(),
  }).optional(),
})
```

值得注意的是 `time` 字段中的 `compacting` 和 `archived` 两个可选时间戳。`compacting` 标记会话正在进行上下文压缩（防止并发压缩），`archived` 标记会话已归档（不再出现在活跃列表中）。`revert` 字段记录了回退操作的元信息，支持将代码变更恢复到指定快照。

## 5.2 Session CRUD 操作

**创建（create）**：`createNext` 函数生成带有降序 ID 的新 Session（确保最新会话排在前面），自动关联当前项目并设置默认标题。如果配置了自动分享，创建后会异步触发分享流程：

```typescript
export async function createNext(input: { ... }) {
  const result: Info = {
    id: Identifier.descending("session", input.id),
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

**Fork（分叉）**：`fork` 函数创建一个会话的副本，可以指定从哪条消息截断。它会逐条复制消息和 Part，同时重新映射消息 ID 以维护父子关系：

```typescript
export const fork = fn(z.object({
  sessionID: Identifier.schema("session"),
  messageID: Identifier.schema("message").optional(),
}), async (input) => {
  const session = await createNext({ title: getForkedTitle(original.title) })
  for (const msg of msgs) {
    if (input.messageID && msg.info.id >= input.messageID) break
    // 复制消息和 Part，重新映射 ID
  }
  return session
})
```

**删除（remove）**：递归删除会话及其所有子会话，同时取消分享。数据库通过 CASCADE 自动清理关联的消息和 Part。

**列表（list）**：支持按目录、工作区、搜索关键词、时间范围等多维度过滤，默认按更新时间降序排列。`listGlobal` 提供跨项目的全局会话视图。

## 5.3 消息与 Part 管理

OpenCode 采用二级结构管理对话内容：Message 包含 Part，Part 是实际的内容单元。

**updateMessage** 使用 upsert 模式（`onConflictDoUpdate`），同一消息 ID 重复写入时自动更新。每次操作都通过 `Bus.publish` 发布事件，驱动 UI 实时刷新。

**updatePart** 同样采用 upsert 模式，支持 text、tool、reasoning、step-start/step-finish、patch 等多种 Part 类型。`updatePartDelta` 用于流式增量更新，只发送文本增量而非完整内容，减少数据传输量。

**removePart** 支持精确删除单个 Part。所有操作都在 `Database.use` 事务内执行，通过 `Database.effect` 将事件发布延迟到事务提交后。

> **源码位置**：packages/opencode/src/session/llm.ts

## 5.4 LLM 流式调用

`LLM.stream` 是 OpenCode 调用大模型的核心函数。它接收 `StreamInput` 参数，包含用户消息、模型配置、Agent 信息和工具集：

```typescript
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

系统提示词的构建遵循优先级规则：Agent 自定义 prompt 优先于 Provider 默认 prompt。随后叠加传入的 system 参数和用户消息中的 system 字段。Plugin 系统可通过 `experimental.chat.system.transform` 钩子进一步修改提示词。

工具过滤通过 `resolveTools` 实现，它利用 `PermissionNext.disabled` 计算被禁用的工具集，同时检查用户消息中是否有单独的工具开关设置。

模型中间件机制值得关注：OpenCode 使用 `wrapLanguageModel` 包装语言模型，注入 `ProviderTransform.message` 对消息格式进行 Provider 特定的转换。针对 LiteLLM 代理，系统会自动注入占位工具以满足其验证要求。

## 5.5 Processor：响应处理与工具执行

> **源码位置**：packages/opencode/src/session/processor.ts

`SessionProcessor` 负责处理 LLM 的流式响应。它的核心是一个 while 循环，持续消费流中的事件直到完成或中断：

```typescript
const DOOM_LOOP_THRESHOLD = 3  // 死循环检测阈值

export function create(input: { ... }) {
  let blocked = false
  let needsCompaction = false

  return {
    async process(streamInput) {
      while (true) {
        const stream = await LLM.stream(streamInput)
        for await (const value of stream.fullStream) {
          switch (value.type) {
            case "tool-call":
              // 死循环检测：最近 3 次调用相同工具且参数相同
              const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)
              if (lastThree.every(p => /* 相同工具和参数 */)) {
                await PermissionNext.ask({ permission: "doom_loop" })
              }
              break
            case "finish-step":
              // 计算 token 用量和成本
              // 检查是否需要上下文压缩
              if (await SessionCompaction.isOverflow({ tokens, model })) {
                needsCompaction = true
              }
              break
          }
        }
        if (needsCompaction) return "compact"
        if (blocked) return "stop"
        return "continue"
      }
    }
  }
}
```

**死循环检测**：当连续 3 次工具调用的名称和参数完全相同时，Processor 会触发 `doom_loop` 权限检查，要求用户确认是否继续。这是防止 AI 陷入无效重复操作的重要保护。

**快照追踪**：每个 step 开始时记录文件快照（`Snapshot.track()`），step 结束时计算差异并生成 patch Part，实现精确的代码变更追踪。

**返回值语义**：`"continue"` 表示正常完成需要继续对话，`"compact"` 表示触发了 token 溢出需要执行压缩，`"stop"` 表示被阻断或出错需要停止。

## 5.6 实战：追踪一次完整对话的生命周期

一次完整的用户交互经历以下阶段：

1. **Session 创建**：`Session.create()` 在数据库中插入新记录，发布 `session.created` 事件。

2. **用户消息写入**：`SessionPrompt.command()` 接收用户输入，创建 User 类型的 Message 和对应的 Text Part。

3. **Agent 选择**：根据当前会话状态选择合适的 Agent（默认为 build），加载其权限配置。

4. **LLM 调用**：`LLM.stream()` 构建系统提示词，过滤工具集，通过 Vercel AI SDK 的 `streamText` 发起流式请求。

5. **响应处理**：`SessionProcessor` 消费流事件，将文本、推理过程、工具调用分别存储为不同类型的 Part。

6. **工具执行**：模型请求调用工具时，系统检查权限，执行工具，将结果作为 tool-result 反馈给模型。

7. **Token 检查**：每个 step 完成后检查 token 用量，若超过模型上下文限制则标记需要压缩。

8. **状态更新**：`SessionSummary.summarize()` 异步更新变更摘要，`Session.touch()` 更新时间戳。

整个流程通过 Bus 事件驱动，UI 层监听 `MessageV2.Event.PartUpdated` 和 `MessageV2.Event.PartDelta` 实现实时渲染。

## 本章要点

- Session.Info 包含 id、项目关联、时间追踪、变更摘要、分享链接、回退信息等丰富的元数据
- Session 支持 create、fork、remove、list 等完整的 CRUD 操作，fork 操作可从指定消息处截断复制
- 消息采用 Message-Part 二级结构，通过 upsert 模式和 Bus 事件系统实现实时同步
- LLM.stream 封装了提示词构建、工具过滤、Provider 适配和中间件注入的完整流程
- Processor 实现了死循环检测（连续 3 次相同调用触发确认）、快照追踪和自动压缩触发等保护机制
