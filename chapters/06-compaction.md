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

Token 计数逻辑优先使用 `tokens.total`（如果 provider 直接返回了总量），否则将 input、output、cache.read、cache.write 四个分量相加。缓存相关的 token 也被纳入计算，因为它们同样占据上下文窗口空间，即使在计费层面有折扣。这里使用 `||` 而非 `??`——当 `total` 为 0 时（未提供），会回退到分量相加。

可用空间的计算区分了两条路径。当模型定义了独立的 `input limit` 时，直接用输入限制减去预留空间；否则使用总上下文减去最大输出 token 数。`maxOutputTokens` 由 `ProviderTransform` 根据模型配置计算，它同时参与两个计算：reserved 取 `min(COMPACTION_BUFFER, maxOutputTokens)` 确保缓冲不超过输出上限，usable 取 `context - maxOutputTokens` 为输出留足空间。

`context === 0` 的特殊处理值得注意。某些本地模型或自定义 provider 可能不设定明确的上下文限制，此时将 context 设为 0 表示"无限制"，函数直接返回 `false` 跳过检测。用户也可以通过 `config.compaction.auto = false` 全局禁用自动压缩，适合那些对上下文管理有自定义需求的高级用户。

在 Processor 中，`isOverflow` 的调用还有一个额外条件：`!input.assistantMessage.summary`。如果当前处理的就是一条 compaction 摘要消息，即使 token 超限也不会再次触发压缩，避免了递归压缩的死循环。

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

算法从消息列表末尾（最新消息）开始向前遍历。首先通过 `turns` 计数器跳过最近 2 个 user turn——遍历过程中每遇到一条 `role === "user"` 的消息就递增 `turns`，当 `turns < 2` 时直接 `continue`，确保当前正在进行的对话上下文完全不受影响。

遍历的终止条件有两个：遇到已有 `summary` 标记的 assistant 消息（表明之前已执行过压缩，这条消息之前的内容已被摘要覆盖），或遇到已被标记为 `compacted` 的 Part（说明更早的内容已经在之前的裁剪轮次中处理过）。这两个边界条件以 `break loop` 跳出带标签的外层循环，防止了重复裁剪。

对于每条消息中的每个 Part，算法只处理满足以下条件的内容：

1. Part 类型为 `tool`（文本消息不裁剪）
2. 工具调用状态为 `completed`（pending、running 或 error 状态的调用不动）
3. 工具名称不在 `PRUNE_PROTECTED_TOOLS` 列表中

`PRUNE_PROTECTED_TOOLS` 目前只包含 `"skill"`。Skill 输出受到特殊保护，因为技能指令（如自定义编码规范、项目约定等）通常需要在整个会话生命周期内保持可见，裁剪它们会导致 Agent 偏离用户预期。

算法使用 `Token.estimate` 估算每个工具输出的 token 数，并维护一个累计计数器 `total`。当 `total` 超过 `PRUNE_PROTECT`（40,000 tokens）时，后续遇到的工具输出都会被加入待裁剪列表。换句话说，最近 40K tokens 的工具输出始终受到保护，只有更早的输出才会被裁剪。这个阈值确保了 Agent 在裁剪后仍然能看到足够多的最近工具结果来维持上下文连贯性。

最终的执行还有一道门槛：`pruned > PRUNE_MINIMUM`（20,000 tokens）。如果待裁剪的总量不足 20K，说明收益太小不值得执行，算法直接返回。这个阈值避免了频繁的小规模裁剪带来的 I/O 开销——每次裁剪需要逐个 `Session.updatePart`，批量操作才有效率。

裁剪动作本身很简单——在每个 Part 上设置 `time.compacted = Date.now()` 时间戳，然后持久化。当模型后续处理这些消息时，`MessageV2.toModelMessages` 会检查 `time.compacted` 标记，将被裁剪 Part 的输出替换为 `"[output compacted]"` 占位文本，大幅减少 token 消耗。

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

### 消息范围确定与回放发现

当压缩由 overflow 触发时，`process` 函数首先向前搜索最后一条未包含 compaction Part 的用户消息，将其保存为 `replay`，并将待压缩的消息范围截断到这条消息之前。这样做的目的是确保用户最近的请求不会在压缩中被吞掉。但这里还有一个边界情况处理：如果截断后的消息列表中不包含任何有效的用户消息（可能所有用户消息都是 compaction 标记），系统会放弃 replay 方案，回退到对完整消息列表进行压缩。

### Compaction Agent 的提示词设计

压缩的核心是使用 compaction Agent 生成摘要。这个 Agent 的关键特征在第 4 章已有介绍：没有任何工具可用（`tools: {}`），所有权限均被拒绝。`process` 函数创建一条 `summary: true` 的 assistant 消息作为摘要容器，然后调用 `SessionProcessor` 处理压缩请求。

提示词支持 Plugin 自定义——通过 `Plugin.trigger("experimental.session.compacting", ...)` 钩子，插件可以注入额外上下文或完全替换默认提示。默认提示要求 compaction Agent 按照固定模板生成摘要，包含五个结构化部分：

- **Goal**：用户的最终目标是什么
- **Instructions**：用户提供的重要指令和约束条件
- **Discoveries**：在对话过程中发现的关键信息（如代码结构、bug 根因、依赖关系等）
- **Accomplished**：已完成和待完成的工作清单
- **Relevant files/directories**：涉及的文件和目录路径列表

模板的核心指令是"创建一个用于继续对话的详细提示"（a detailed prompt for continuing the conversation）。这不是简单的对话摘要，而是一份面向下一轮 Agent 的工作交接文档。结构化格式确保信息不会在压缩过程中遗漏关键类别，例如用户可能在第 3 轮提到的编码规范约束，即使后续 20 轮都没有再提及，也会被保留在 Instructions 部分。

在调用模型之前，历史消息通过 `MessageV2.toModelMessages` 转换，并设置 `stripMedia: true` 去除图片等二进制内容，进一步减少输入 token 量。Plugin 还有机会通过 `experimental.chat.messages.transform` 钩子修改消息。

### 回放与续接机制

压缩完成后，系统根据触发方式决定后续行为。如果模型在压缩过程中本身就超出了上下文限制（返回 `"compact"`），说明会话实在太大，即使压缩也无法容纳，此时设置 `ContextOverflowError` 并返回 `"stop"`。

正常完成且为自动触发时，系统执行续接逻辑：

```typescript
// 文件: packages/opencode/src/session/compaction.ts L238-292
if (result === "continue" && input.auto) {
  if (replay) {
    // 重新创建用户消息，将媒体附件替换为文本占位符
    for (const part of replay.parts) {
      if (part.type === "compaction") continue
      const replayPart =
        part.type === "file" && MessageV2.isMedia(part.mime)
          ? { type: "text", text: `[Attached ${part.mime}: ${part.filename}]` }
          : part
      await Session.updatePart({ ...replayPart, ... })
    }
  } else {
    // 注入 Continue 合成消息
    const text = (input.overflow
      ? "The previous request exceeded the provider's size limit..."
      : "") +
      "Continue if you have next steps, or stop and ask for clarification..."
    await Session.updatePart({ type: "text", synthetic: true, text, ... })
  }
}
```

当存在 replay 消息时，系统重新创建这条消息的副本，但将其中的媒体附件（图片、截图等）替换为 `[Attached image/png: filename]` 格式的文本占位符——大体积的二进制内容是导致溢出的常见原因，简单回放可能再次触发溢出。compaction 类型的 Part 被跳过，只保留实际用户输入。

当没有 replay 消息时（例如手动触发压缩），系统注入一条 `synthetic: true` 的合成用户消息，包含 "Continue if you have next steps" 的引导文本。如果是因为大媒体文件导致的 overflow，还会额外添加说明，引导模型告知用户附件过大。

最后，如果压缩过程中没有产生错误，通过 `Bus.publish(Event.Compacted, ...)` 广播压缩完成事件，外部消费者可据此更新 UI 状态。

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

### SessionCompaction.create：压缩标记

在 `process` 被调用之前，`SessionPrompt` 通过 `SessionCompaction.create()` 在会话中插入一条标记消息：

```typescript
// 文件: packages/opencode/src/session/compaction.ts L299-330
export const create = fn(z.object({ ... }), async (input) => {
  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    model: input.model,
    sessionID: input.sessionID,
    agent: input.agent,
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: msg.sessionID,
    type: "compaction",
    auto: input.auto,
    overflow: input.overflow,
  })
})
```

这条消息包含一个 `type: "compaction"` 的 Part，记录了本次压缩是自动触发还是手动触发、是否因 overflow 引起。UI 可以据此显示压缩标记，`prune` 和 `process` 函数在搜索 replay 消息时也会跳过包含 compaction Part 的用户消息。

> **源码位置**：packages/opencode/src/session/system.ts

## 6.6 系统提示词生成

`SystemPrompt` 命名空间负责生成发送给模型的系统提示词，这直接影响 token 开销：

```typescript
// 文件: packages/opencode/src/session/system.ts L10-20
export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
  if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  return [PROMPT_ANTHROPIC_WITHOUT_TODO]  // 默认回退
}
```

不同模型使用不同的系统提示词模板——Claude 使用完整的 Anthropic 提示词，GPT 系列使用 Beast 或 Codex 提示词，Gemini 有专用提示词。不同模型对指令格式的偏好差异显著：Claude 对 XML 标签的理解更好，GPT 系列更适应 Markdown 风格的指令，针对性的模板选择能够在不增加 token 开销的前提下提升指令遵循率。

`environment` 函数注入运行时环境信息（工作目录、平台、日期等），使用 XML 标签包裹以便模型准确识别。`skills` 函数根据 Agent 权限检查是否启用 skill 工具，若启用则注入可用技能列表。这些动态内容每次对话都会重新生成，确保信息的时效性，但也意味着它们会在每轮交互中重复消耗 token。

## 6.7 与 Claude Code 的 Context 管理对比

| 特性 | OpenCode | Claude Code |
|------|----------|-------------|
| 压缩策略 | 两阶段：先 prune 后 summarize | 单阶段自动摘要 |
| 裁剪粒度 | Part 级别，保护最近 40K tokens | 消息级别 |
| LLM 调用 | prune 阶段零成本，可能避免 LLM 调用 | 每次压缩都需要 LLM 调用 |
| 摘要格式 | 结构化模板（Goal/Instructions/Discoveries/Accomplished/Files） | 自由格式摘要 |
| 用户控制 | 可配置 auto、prune、reserved 参数 | 有限控制 |
| 回放机制 | 自动回放被截断的用户消息，确保意图不丢失 | 无 |
| 压缩 Agent 权限 | 零工具、零权限，纯文本生成 | 摘要在主 Agent 内生成 |
| Plugin 支持 | 可通过钩子替换压缩提示或注入上下文 | 无 |

两者最本质的区别在于 OpenCode 的两阶段设计。Claude Code 采用单程方法——当接近上下文限制时触发自动摘要，直接调用 LLM 生成压缩后的上下文。OpenCode 则先执行零成本的 prune 操作，在很多场景下（尤其是工具输出占比较大的会话中），仅 prune 就能释放足够的空间，完全避免 LLM 调用的额外开销。

OpenCode 的结构化摘要模板也是一个显著优势。Claude Code 使用自由格式的摘要，摘要质量完全依赖于模型的自主判断。OpenCode 通过明确的五段式模板约束摘要内容，确保关键类别（特别是 Instructions 和 Discoveries）不会被遗漏。这在长对话中尤为重要——用户可能在早期提到的编码规范或项目约束，在自由格式摘要中容易被"自然遗忘"。

回放机制是 OpenCode 独有的设计。当因 overflow 触发压缩时，最后一条用户消息可能已经超出了上下文窗口。OpenCode 会将这条消息重新注入压缩后的上下文中（媒体附件替换为文本占位符），确保用户最近的意图不会因为压缩而丢失。

## 6.8 实战：观察压缩如何保留关键上下文

假设一次编码会话已进行 30 轮对话，token 总量达到 180K（接近 200K 限制）。会话中包含大量文件读取和 bash 命令输出，工具输出的 token 占比约 70%。以下是压缩触发的完整流程：

1. **溢出检测**：Processor 在 `finish-step` 事件中调用 `isOverflow`。首先确认 `config.compaction.auto` 不是 `false`，再确认 `context !== 0`。计算总 token 数——优先用 `total`，否则分量相加得 180K。`reserved = min(20K, 16K) = 16K`，`usable = 200K - 16K = 184K`。180K < 184K，本次不触发。假设下一轮 token 增长到 185K，`185K >= 184K`，函数返回 `true`。

2. **Processor 返回**：`process` 函数返回 `"compact"`，Prompt 层检测到需要压缩，调用 `SessionCompaction.create` 插入 compaction 标记消息。

3. **裁剪执行**：`prune` 从第 30 条消息开始往回扫描。前两个 user turn 被跳过（`turns < 2`），然后开始统计工具输出 token。保护最近 40K tokens 的工具输出。假设第 1-20 轮的工具输出共计 80K tokens，超过了 40K 保护线，其中 40K 被标记为待裁剪。40K > 20K（PRUNE_MINIMUM），执行裁剪——为这些 Part 设置 `time.compacted` 时间戳。`"skill"` 工具的输出在遍历中被 `continue` 跳过，不会被裁剪。

4. **摘要生成**：compaction Agent 接收全部历史消息（其中被裁剪的工具输出已替换为 `"[output compacted]"`），按照五段式模板生成结构化摘要。Plugin 有机会通过 `experimental.session.compacting` 钩子注入额外上下文。摘要被存储为带 `summary: true` 标记的 assistant 消息。典型的摘要长度在 500-2000 tokens 之间。

5. **自动续接**：由于本次是 overflow 触发且存在 replay 消息，系统将最后一条用户消息重新注入（媒体附件替换为文本占位符）。如果不是 overflow 触发，则创建一条 `synthetic: true` 的合成用户消息。

6. **后续对话**：主 Agent 基于摘要继续响应。此时上下文中只包含系统提示词（~3K tokens）+ 摘要（~1.5K tokens）+ 回放的用户消息（~500 tokens），总计约 5K tokens，从 180K 骤降到 5K，释放了约 97% 的空间。

整个过程对用户几乎透明，在 UI 上仅显示一条压缩标记（包含 `auto` 和 `overflow` 信息）。得益于结构化摘要的存在，Agent 在压缩后仍然知道用户的目标是什么、已经完成了哪些工作、涉及哪些文件，能够无缝继续工作。

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
