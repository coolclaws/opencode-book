# 第 6 章　Context 压缩与 Token 管理

随着对话轮次增加，上下文长度不可避免地逼近模型限制。如何在保留关键信息的前提下控制 token 用量，是 AI 编程助手面临的核心挑战之一。OpenCode 设计了一套包含溢出检测、消息裁剪和摘要压缩的三层防护体系。

> **源码位置**：packages/opencode/src/session/compaction.ts

## 6.1 为什么需要 Context 压缩

大语言模型的上下文窗口是有限的资源。Claude 系列模型通常支持 200K tokens，GPT-4 系列为 128K tokens。在长时间编码会话中，工具调用的输入输出会迅速消耗上下文空间——一次文件读取可能产生数千 tokens，多轮工具交互后总量很容易突破限制。

超出上下文限制会导致两个问题：一是 API 调用直接报错；二是即使未报错，过长的上下文也会增加成本并降低模型对关键信息的注意力。Claude Code 通过自动摘要和上下文窗口管理来应对，Cursor 则依赖其内置的索引系统减少上下文需求。OpenCode 的方案更加精细，结合了裁剪和压缩两种策略。

## 6.2 溢出检测：isOverflow

`isOverflow` 函数判断当前 token 用量是否已超过安全阈值：

```typescript
const COMPACTION_BUFFER = 20_000  // 预留缓冲区

export async function isOverflow(input: {
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
}) {
  const config = await Config.get()
  if (config.compaction?.auto === false) return false  // 用户可禁用自动压缩
  const context = input.model.limit.context
  if (context === 0) return false  // context 为 0 表示无限制

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

计算逻辑有两个关键设计：首先，`reserved` 参数支持用户自定义预留空间，默认为 20,000 tokens 与最大输出 token 数的较小值；其次，可用空间的计算区分了 `input limit`（部分模型单独定义输入限制）和 `context limit`（总上下文限制减去输出预留）。这种差异化处理确保了在不同模型间的准确性。

## 6.3 消息裁剪：prune

在触发完整压缩之前，OpenCode 先尝试一种更轻量的优化——裁剪旧的工具调用输出：

```typescript
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

  loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = msgs[msgIndex]
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

裁剪算法从最新消息往回遍历，跳过最近 2 轮对话以保护当前上下文。它统计所有已完成工具调用的输出 token 数，保留最近 40K tokens 的输出不动，仅标记更早的输出为 `compacted`。`skill` 类型的工具受特殊保护，因为技能指令通常需要在整个会话中保持可见。

如果遇到已有 summary 的 assistant 消息或已被 compacted 的 Part，则停止遍历——这表明之前已经执行过压缩，避免重复处理。

## 6.4 压缩流程：process

当裁剪不足以解决问题时，系统会触发完整的压缩流程：

```typescript
export async function process(input: {
  parentID: string
  messages: MessageV2.WithParts[]
  sessionID: string
  abort: AbortSignal
  auto: boolean
  overflow?: boolean
}) {
  // 1. 确定要压缩的消息范围
  let messages = input.messages
  let replay: MessageV2.WithParts | undefined
  if (input.overflow) {
    // 溢出时找到最后一条非压缩用户消息用于回放
    for (let i = idx - 1; i >= 0; i--) {
      if (msg.info.role === "user" && !hasCompactionPart) {
        replay = msg
        messages = input.messages.slice(0, i)
        break
      }
    }
  }

  // 2. 使用 compaction Agent 生成摘要
  const agent = await Agent.get("compaction")
  const processor = SessionProcessor.create({ ... })
  await processor.process({
    tools: {},           // 压缩 Agent 不使用任何工具
    messages: [...modelMessages, {
      role: "user",
      content: [{ type: "text", text: promptText }],
    }],
  })

  // 3. 如果是自动触发，回放被截断的用户消息
  if (result === "continue" && input.auto && replay) {
    // 重新创建用户消息，替换媒体附件为文本占位符
  }
}
```

压缩的提示词要求 compaction Agent 按照固定模板生成摘要，包含五个部分：Goal（用户目标）、Instructions（重要指令）、Discoveries（发现的信息）、Accomplished（已完成的工作）、Relevant files（相关文件列表）。这种结构化摘要确保了下一轮对话能够无缝衔接。

当因 overflow 触发压缩时，系统会"回放"被截断的用户消息——创建新的用户消息副本，但将媒体附件替换为文本占位符，避免再次超出限制。

> **源码位置**：packages/opencode/src/session/system.ts

## 6.5 系统提示词生成

`SystemPrompt` 命名空间负责生成发送给模型的系统提示词，这直接影响 token 开销：

```typescript
export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
  if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  return [PROMPT_ANTHROPIC_WITHOUT_TODO]  // 默认回退
}
```

不同模型使用不同的系统提示词模板——Claude 使用完整的 Anthropic 提示词，GPT 系列使用 Beast 或 Codex 提示词，Gemini 有专用提示词。这种差异化设计是因为不同模型对指令的理解方式和最佳实践各不相同。

`environment` 函数注入运行时环境信息（工作目录、平台、日期等），使用 XML 标签包裹以便模型准确识别。`skills` 函数根据 Agent 权限检查是否启用 skill 工具，若启用则注入可用技能列表。

## 6.6 与 Claude Code 的 Context 管理对比

| 特性 | OpenCode | Claude Code | Cursor |
|------|----------|-------------|--------|
| 自动压缩 | 三层策略（溢出检测→裁剪→摘要） | 自动摘要 | 依赖索引减少上下文 |
| 裁剪粒度 | Part 级别，保护最近 40K tokens | 消息级别 | 不透明 |
| 用户控制 | 可配置 auto、prune、reserved 参数 | 有限控制 | 无直接控制 |
| 压缩格式 | 结构化模板（Goal/Instructions/Discoveries/Accomplished/Files） | 自由摘要 | 不适用 |
| 回放机制 | 自动回放被截断的用户消息 | 无 | 无 |

OpenCode 的优势在于精细的分层控制和可配置性。裁剪在不调用 LLM 的前提下释放空间（零额外成本），而摘要压缩则在必要时调用 compaction Agent 生成高质量总结。

## 6.7 实战：观察压缩如何保留关键上下文

假设一次编码会话已进行 30 轮对话，token 总量达到 180K（接近 200K 限制）。以下是压缩触发的完整流程：

1. **溢出检测**：Processor 在 `finish-step` 事件中调用 `isOverflow`，发现 180K >= 200K - 20K（预留），返回 `true`。

2. **Processor 返回**：`process` 函数返回 `"compact"`，Prompt 层检测到需要压缩。

3. **裁剪执行**：`prune` 从第 28 轮开始往回扫描，跳过最近 2 轮，保护最近 40K tokens 的工具输出，将更早的工具输出标记为 `compacted`。

4. **压缩消息创建**：`SessionCompaction.create` 插入一条 compaction 类型的用户消息作为触发标记。

5. **摘要生成**：compaction Agent 读取全部历史消息，生成结构化摘要。摘要被存储为带 `summary: true` 标记的 assistant 消息。

6. **自动续接**：系统创建一条包含 "Continue if you have next steps" 的合成用户消息，让主 Agent 基于摘要继续工作。

7. **后续对话**：当主 Agent 继续响应时，历史消息中包含摘要 Part，旧的工具输出已被清理，总 token 量回到安全范围。

整个过程对用户几乎透明，在 UI 上仅显示一条压缩标记。

## 本章要点

- Token 溢出检测通过对比当前用量与模型可用空间（上下文限制减去输出预留和缓冲区）实现
- 裁剪（prune）是零成本的轻量优化，保护最近 40K tokens 的工具输出，仅清理更早的历史数据
- 压缩（process）调用 compaction Agent 生成结构化摘要，按 Goal/Instructions/Discoveries/Accomplished/Files 模板组织
- 系统提示词根据模型类型（Claude/GPT/Gemini）选择不同模板，并注入环境信息和技能列表
- 与 Claude Code 相比，OpenCode 提供更精细的分层控制和可配置性，裁剪 + 摘要的组合策略在成本和效果之间取得了平衡
