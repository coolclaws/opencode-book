# 第 6 章　Context 压缩与 Token 管理

随着对话轮次增加，上下文长度不可避免地逼近模型限制。如何在保留关键信息的前提下控制 token 用量，是 AI 编程助手面临的核心挑战之一。OpenCode 设计了一套包含溢出检测、消息裁剪和摘要压缩的三层防护体系。

> **源码位置**：packages/opencode/src/session/compaction.ts

## 6.1 为什么需要 Context 压缩

大语言模型的上下文窗口是有限的资源。Claude 系列模型通常支持 200K tokens，GPT-4 系列为 128K tokens。在长时间编码会话中，工具调用的输入输出会迅速消耗上下文空间——一次文件读取可能产生 2K-10K tokens，bash 命令的输出在截断前可以达到 50KB，多轮工具交互后总量很容易突破限制。

超出上下文限制会导致两个问题：一是 API 调用直接报错；二是即使未报错，过长的上下文也会增加成本并降低模型对关键信息的注意力。Claude Code 通过自动摘要和上下文窗口管理来应对，Cursor 则依赖其内置的索引系统减少上下文需求。OpenCode 的方案更加精细，结合了裁剪和压缩两种策略。

### Token 预算量化

理解压缩机制之前，需要先弄清 token 预算的具体数字。OpenCode 在 compaction.ts 第 31 行定义了核心常量 `COMPACTION_BUFFER = 20_000`，这个 20K tokens 的缓冲区是整个溢出检测逻辑的基石。预留空间的计算公式为：

```text
reserved = config.compaction.reserved ?? min(COMPACTION_BUFFER, maxOutputTokens(model))
```

用户也可以通过 `config.compaction.reserved` 覆盖这个默认值。以 Claude 的 200K 上下文窗口为例，假设 `maxOutputTokens` 为 16K：

- 总上下文：200,000 tokens
- 输出预留：16,000 tokens
- 缓冲区：min(20,000, 16,000) = 16,000 tokens
- 可用空间：约 200,000 - 16,000 = 184,000 tokens（使用 context - maxOutput 路径）

对于定义了独立输入限制（`model.limit.input`）的模型，计算更为直接：可用空间 = 输入限制 - reserved。这种区分处理覆盖了不同 provider 对 token 限制的不同表达方式——某些 Anthropic 模型的 context 和 input limit 可能不同，而大多数 OpenAI 模型只定义一个 context 限制。

实际可用空间还要扣除系统提示词的开销。不同模型的系统提示词模板长度不同，通常消耗 2K-5K tokens。每个注册的工具描述还会额外占用约 500-1000 tokens。当一个 session 注册了 10 个工具时，仅工具描述就可能消耗 5K-10K tokens。这意味着在 184K 的理论可用空间中，真正留给对话历史的可能只有 170K-175K。

## 6.2 溢出检测：isOverflow

`isOverflow` 函数判断当前 token 用量是否已超过安全阈值。它在 Processor 的 `finish-step` 事件中被调用，是触发整个压缩流程的入口。

```typescript
// 文件: packages/opencode/src/session/compaction.ts L31-49
const COMPACTION_BUFFER = 20_000

export async function isOverflow(input: {
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
}) {
  const config = await Config.get()
  if (config.compaction?.auto === false) return false
  const context = input.model.limit.context
  if (context === 0) return false

  const count = input.tokens.total ||
    input.tokens.input + input.tokens.output +
    input.tokens.cache.read + input.tokens.cache.write

  const reserved = config.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  const usable = input.model.limit.input
    ? input.model.limit.input - reserved
    : context - ProviderTransform.maxOutputTokens(input.model)
  return count >= usable
}
```

Token 计数优先使用 `tokens.total`（provider 直接返回的总量），否则将 input、output、cache.read、cache.write 四分量相加——缓存 token 也占上下文空间，必须纳入。可用空间区分两条路径：有独立 `input limit` 时直接减去 reserved，否则用 `context - maxOutputTokens`。

两个特殊处理值得注意：`context === 0` 表示"无限制"（本地模型等），直接返回 `false`；Processor 中还检查 `!input.assistantMessage.summary`，避免 compaction 摘要消息自身触发递归压缩。用户可通过 `config.compaction.auto = false` 全局禁用自动压缩。

## 6.3 消息裁剪：prune

在触发完整压缩之前，OpenCode 先尝试一种更轻量的优化——裁剪旧的工具调用输出。这一步是纯本地操作，不需要调用 LLM，因此是零成本的。

```typescript
// 文件: packages/opencode/src/session/compaction.ts L51-100
export const PRUNE_MINIMUM = 20_000   // 最少裁剪 20K tokens 才执行
export const PRUNE_PROTECT = 40_000   // 保护最近 40K tokens 的工具输出

const PRUNE_PROTECTED_TOOLS = ["skill"]  // 受保护的工具类型

export async function prune(input: { sessionID: string }) {
  const config = await Config.get()
  if (config.compaction?.prune === false) return
  const msgs = await Session.messages({ sessionID: input.sessionID })
  let total = 0
  let pruned = 0
  const toPrune = []
  let turns = 0

  loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = msgs[msgIndex]
    if (msg.info.role === "user") turns++
    if (turns < 2) continue
    if (msg.info.role === "assistant" && msg.info.summary) break loop
    for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = msg.parts[partIndex]
      if (part.type === "tool" && part.state.status === "completed") {
        if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
        if (part.state.time.compacted) break loop
        const estimate = Token.estimate(part.state.output)
        total += estimate
        if (total > PRUNE_PROTECT) {
          pruned += estimate
          toPrune.push(part)
        }
      }
    }
  }
  if (pruned > PRUNE_MINIMUM) {
    for (const part of toPrune) {
      part.state.time.compacted = Date.now()
      await Session.updatePart(part)
    }
  }
}
```

### 裁剪算法详解

算法从消息列表末尾向前遍历，通过 `turns` 计数器跳过最近 2 个 user turn，确保当前对话上下文不受影响。遍历终止条件有两个：遇到带 `summary` 标记的 assistant 消息（之前已压缩），或遇到已标记 `compacted` 的 Part（之前已裁剪），通过 `break loop` 跳出带标签的外层循环。

算法只处理满足三个条件的 Part：类型为 `tool`、状态为 `completed`、工具名不在 `PRUNE_PROTECTED_TOOLS`（目前仅 `"skill"`）中。Skill 输出受保护是因为技能指令需要在整个会话中保持可见。

`Token.estimate` 估算每个工具输出的 token 数，累计超过 `PRUNE_PROTECT`（40K）后的工具输出加入待裁剪列表——最近 40K 始终受保护。最终门槛：`pruned > PRUNE_MINIMUM`（20K）才执行，避免频繁小规模裁剪的 I/O 开销。裁剪动作是在 Part 上设置 `time.compacted = Date.now()`，模型后续处理时替换为 `"[output compacted]"` 占位文本。

## 6.4 压缩流程：process

当裁剪不足以解决问题时，系统会触发完整的压缩流程。这一步需要调用 LLM 生成摘要，因此有额外的 API 开销，但它能在保留关键信息的前提下将上下文压缩到原来的一小部分。

```typescript
// 文件: packages/opencode/src/session/compaction.ts L102-130
export async function process(input: {
  parentID: MessageID
  messages: MessageV2.WithParts[]
  sessionID: SessionID
  abort: AbortSignal
  auto: boolean
  overflow?: boolean
}) {
  let messages = input.messages
  let replay: MessageV2.WithParts | undefined
  if (input.overflow) {
    const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
    for (let i = idx - 1; i >= 0; i--) {
      const msg = input.messages[i]
      if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
        replay = msg
        messages = input.messages.slice(0, i)
        break
      }
    }
    // 如果截断后没有有效内容，回退到完整消息列表
    const hasContent = replay && messages.some(
      (m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction")
    )
    if (!hasContent) {
      replay = undefined
      messages = input.messages
    }
  }
```

### 回放发现与摘要生成

overflow 触发时，`process` 函数向前搜索最后一条非 compaction 用户消息保存为 `replay`，将压缩范围截断到该消息之前，确保用户最近请求不被吞掉。如果截断后无有效用户消息，回退到完整列表。

compaction Agent 没有任何工具可用（`tools: {}`），只能生成纯文本摘要。提示词支持 Plugin 自定义（`experimental.session.compacting` 钩子）。默认提示要求按固定模板生成五个结构化部分：

- **Goal**：用户的最终目标是什么
- **Instructions**：用户提供的重要指令和约束条件
- **Discoveries**：在对话过程中发现的关键信息（如代码结构、bug 根因、依赖关系等）
- **Accomplished**：已完成和待完成的工作清单
- **Relevant files/directories**：涉及的文件和目录路径列表

这不是简单的对话摘要，而是面向下一轮 Agent 的工作交接文档。结构化格式确保关键类别不会被遗漏——用户在第 3 轮提到的编码规范约束，即使后续 20 轮未再提及，也会保留在 Instructions 部分。历史消息通过 `stripMedia: true` 去除图片等二进制内容后传入。

### 回放与续接机制

压缩完成后的续接逻辑：当存在 replay 消息时，重新创建副本但将媒体附件替换为 `[Attached image/png: filename]` 占位符（避免再次溢出）；当没有 replay 时，注入 `synthetic: true` 的 "Continue if you have next steps" 合成消息。如果压缩本身也超限（返回 `"compact"`），设置 `ContextOverflowError` 并返回 `"stop"`。

## 6.5 压缩决策全流程

下面的流程图展示了从溢出检测到摘要生成的完整决策路径：

```text
  ┌──────────────────────┐
  │ Processor finish-step│
  └──────────┬───────────┘
             ↓
  ┌──────────────────────┐
  │ isOverflow?          │
  └────┬────────────┬────┘
    否 ↓            ↓ 是
  ┌────────┐  ┌─────────────┐
  │ 继续   │  │ 返回 compact│
  │ 正常   │  └──────┬──────┘
  │ 对话   │         ↓
  └────────┘  ┌─────────────┐
              │ 执行 prune  │
              │ 裁剪        │
              └──────┬──────┘
                     ↓
              ┌─────────────────┐
              │ 裁剪量 >= 20K?  │
              └──┬──────────┬───┘
              是 ↓          ↓ 否
        ┌────────────┐ ┌──────────┐
        │ 标记旧工具 │ │ 跳过裁剪 │
        │ 输出为     │ └────┬─────┘
        │ compacted  │      │
        └─────┬──────┘      │
              └──────┬──────┘
                     ↓
              ┌─────────────────┐
              │ 创建 compaction │
              │ 标记消息        │
              └──────┬──────────┘
                     ↓
              ┌─────────────────┐
              │ compaction Agent │
              │ 生成结构化摘要   │
              └──────┬──────────┘
                     ↓
              ┌─────────────────┐
              │ 摘要存储为      │
              │ summary 消息    │
              └──────┬──────────┘
                     ↓
              ┌─────────────────┐
              │ overflow 触发?  │
              └──┬──────────┬───┘
              是 ↓          ↓ 否
        ┌────────────┐ ┌───────────────┐
        │ 回放被截断 │ │ 注入 Continue │
        │ 的用户消息 │ │ 合成消息      │
        │ (媒体→占位)│ └──────┬────────┘
        └─────┬──────┘        │
              └──────┬────────┘
                     ↓
              ┌─────────────────┐
              │ 主 Agent 基于   │
              │ 摘要继续工作    │
              └─────────────────┘
```

注意图中裁剪和摘要是串行执行的。即使裁剪量不足 20K 而被跳过，摘要生成仍然会执行——裁剪只是一个尽力而为的优化步骤，不是摘要的前置条件。两者的关系是"能裁剪就先裁剪以减少摘要 Agent 需要处理的 token 量，然后无论如何都生成摘要"。

在 `process` 被调用之前，`SessionCompaction.create()` 会在会话中插入一条包含 `type: "compaction"` Part 的标记消息，记录本次压缩是自动触发还是手动触发、是否因 overflow 引起。UI 据此显示压缩标记，`process` 函数搜索 replay 消息时也会跳过包含此 Part 的用户消息。

> **源码位置**：packages/opencode/src/session/system.ts

## 6.6 系统提示词与 Token 开销

`SystemPrompt.provider()` 根据模型类型选择不同的系统提示词模板——Claude 使用 Anthropic 提示词（偏好 XML 标签），GPT 系列使用 Beast 或 Codex 提示词（偏好 Markdown），Gemini 有专用模板。`environment` 函数注入运行时环境信息，`skills` 函数注入可用技能列表。这些动态内容每次对话都会重新生成，确保时效性，但也意味着它们在每轮交互中重复消耗 token。

## 6.7 与 Claude Code 的对比

与 Claude Code 最本质的区别在于两阶段设计。Claude Code 采用单程方法——接近上下文限制时直接调用 LLM 生成摘要。OpenCode 先执行零成本的 prune，在工具输出占比较大的会话中，仅 prune 就能释放足够空间，完全避免 LLM 调用。结构化摘要模板（五段式而非自由格式）确保 Instructions 和 Discoveries 等关键类别不会被遗漏。回放机制确保用户最近的意图不因压缩而丢失。

## 6.8 实战：压缩流程完整示例

假设一次 30 轮会话，token 达 185K（200K 限制），工具输出占 70%：

1. **溢出检测**：`isOverflow` 计算 `usable = 200K - 16K = 184K`，`185K >= 184K`，返回 `true`
2. **裁剪**：`prune` 跳过最近 2 个 user turn，保护最近 40K 工具输出，裁剪更早的 40K（> 20K 门槛），设置 `time.compacted` 时间戳
3. **摘要生成**：compaction Agent 读取历史（裁剪部分已替换为 `"[output compacted]"`），生成 ~1.5K tokens 的结构化摘要
4. **续接**：overflow 触发时回放用户消息（媒体→占位符），否则注入 Continue 合成消息
5. **效果**：上下文从 185K 降至 ~5K（提示词 + 摘要 + 回放），释放 97% 空间

整个过程对用户几乎透明，Agent 在压缩后仍然知道目标、进度和涉及文件，无缝继续工作。

## 本章要点

- Token 预算由多个因素决定：上下文限制、输出预留、缓冲区（`COMPACTION_BUFFER = 20_000`）、系统提示词（2K-5K）、工具描述（每个 500-1000 tokens）共同约束了实际可用空间
- `isOverflow` 通过累加 input/output/cache token 并与可用空间比较来判断溢出，支持两种计算路径（input limit 和 context limit），compaction 摘要消息自身不会再触发溢出
- 裁剪（prune）是零成本的轻量优化：反向遍历消息，跳过最近 2 个 user turn，保护最近 `PRUNE_PROTECT`（40K）tokens 的工具输出和 `PRUNE_PROTECTED_TOOLS`（skill）类型输出，仅在裁剪量超过 `PRUNE_MINIMUM`（20K）时执行
- 被裁剪的工具输出通过 `time.compacted` 时间戳标记，模型处理时替换为 `"[output compacted]"` 占位文本
- 压缩（process）调用无工具、无权限的 compaction Agent 生成结构化摘要，按 Goal/Instructions/Discoveries/Accomplished/Files 模板组织，支持 Plugin 自定义提示词
- overflow 触发时系统会回放被截断的用户消息（媒体附件替换为文本占位符），非 overflow 触发时注入 `synthetic: true` 的 Continue 合成消息
- `SessionCompaction.create` 在会话中插入 compaction 标记消息，记录触发方式和原因
- 系统提示词根据模型类型（Claude/GPT/Gemini）选择不同模板，并注入环境信息和技能列表
- 与 Claude Code 相比，OpenCode 的两阶段策略（prune + summarize）在成本和效果之间取得了更好的平衡，结构化模板、Plugin 钩子和回放机制是其独有优势
