# 第 4 章　Agent 架构与内置角色

在 AI 编程助手中，Agent 是连接用户意图与工具执行的核心抽象。OpenCode 通过一套精巧的 Agent 体系，将不同场景下的能力需求映射为不同的角色配置。本章将深入分析 Agent 的类型定义、七大内置角色的设计思路，以及权限隔离与自定义扩展机制。

> **源码位置**：packages/opencode/src/agent/agent.ts

## 4.1 Agent.Info 类型定义

OpenCode 使用 Zod schema 定义 Agent 的完整配置结构：

```typescript
export const Info = z
  .object({
    name: z.string(),                          // Agent 唯一标识
    description: z.string().optional(),        // 描述信息，用于 UI 展示和子 Agent 选择
    mode: z.enum(["subagent", "primary", "all"]), // 运行模式
    native: z.boolean().optional(),            // 是否为内置 Agent
    hidden: z.boolean().optional(),            // 是否在 UI 中隐藏
    topP: z.number().optional(),               // 采样参数 top_p
    temperature: z.number().optional(),        // 温度参数
    color: z.string().optional(),              // UI 显示颜色
    permission: PermissionNext.Ruleset,        // 权限规则集
    model: z.object({                          // 可选的专用模型
      modelID: z.string(),
      providerID: z.string(),
    }).optional(),
    variant: z.string().optional(),            // 模型变体
    prompt: z.string().optional(),             // 自定义系统提示词
    options: z.record(z.string(), z.any()),    // Provider 扩展选项
    steps: z.number().int().positive().optional(), // 最大步骤数
  })
```

其中 `mode` 字段决定了 Agent 的角色定位：`"primary"` 表示可作为主 Agent 直接与用户交互；`"subagent"` 表示只能被其他 Agent 调用；`"all"` 则两种模式皆可。`permission` 字段是整个权限隔离机制的基础，它控制每个 Agent 可以访问哪些工具。

## 4.2 七大内置 Agent

OpenCode 预定义了七个内置 Agent，各有其明确的职责边界：

**build** —— 默认主 Agent，拥有最完整的工具权限。它允许使用 `question`（向用户提问）和 `plan_enter`（进入计划模式），是日常编码的主力角色。

**plan** —— 计划模式 Agent。禁止所有编辑操作，仅允许在 `.opencode/plans/` 目录下创建 Markdown 计划文件。这确保了在规划阶段不会意外修改代码。

**general** —— 通用子 Agent，用于并行执行多步骤研究任务。禁用了 `todoread` 和 `todowrite`，避免与主 Agent 的任务管理冲突。

**explore** —— 快速代码探索子 Agent，专注于只读操作。仅允许 `grep`、`glob`、`list`、`bash`、`read`、`webfetch`、`websearch`、`codesearch` 等搜索类工具，拥有独立的系统提示词引导高效搜索。

**compaction** —— 上下文压缩 Agent（隐藏）。禁止所有工具调用，专职将冗长的对话历史压缩为精炼摘要，详见第 6 章。

**title** —— 标题生成 Agent（隐藏）。设置 `temperature: 0.5` 以产生适度多样性，为会话自动生成简洁标题。

**summary** —— 摘要生成 Agent（隐藏）。负责对代码变更进行概要总结，帮助用户快速了解会话中发生的修改。

三个隐藏 Agent（compaction、title、summary）设置 `hidden: true`，不在用户界面中出现，它们是系统内部自动触发的辅助角色。

## 4.3 权限隔离机制

OpenCode 的权限系统采用三层合并策略。以 build Agent 为例：

```typescript
build: {
  permission: PermissionNext.merge(
    defaults,                    // 第一层：全局默认权限
    PermissionNext.fromConfig({  // 第二层：Agent 特有覆盖
      question: "allow",
      plan_enter: "allow",
    }),
    user,                        // 第三层：用户自定义配置
  ),
}
```

全局默认权限（`defaults`）的核心规则如下：大多数工具设为 `"allow"`，`doom_loop` 检测设为 `"ask"`（需要用户确认），`external_directory` 默认 `"ask"` 但白名单目录自动放行，`.env` 文件读取需要确认。

不同 Agent 通过第二层覆盖实现差异化。explore Agent 采用"先拒绝再白名单"的策略——先将所有权限设为 `"deny"`，再逐一开放只读工具：

```typescript
explore: {
  permission: PermissionNext.merge(
    defaults,
    PermissionNext.fromConfig({
      "*": "deny",        // 先禁止一切
      grep: "allow",      // 再逐一开放只读工具
      glob: "allow",
      read: "allow",
      // ...
    }),
    user,
  ),
}
```

这种设计确保了即使新增工具，explore Agent 也不会获得意外的写入权限。在 LLM 调用层面，`resolveTools` 函数会根据权限规则过滤工具集，被 `deny` 的工具不会出现在模型可调用列表中。

## 4.4 自定义 Agent 生成

OpenCode 支持通过 AI 自动生成新 Agent 配置。`generate` 函数接收用户的自然语言描述，调用 LLM 生成结构化配置：

```typescript
export async function generate(input: {
  description: string
  model?: { providerID: string; modelID: string }
}) {
  // ...构建提示词，注入已存在的 Agent 名称列表避免重名
  const result = await generateObject({
    temperature: 0.3,
    schema: z.object({
      identifier: z.string(),    // Agent 标识符
      whenToUse: z.string(),     // 使用场景描述
      systemPrompt: z.string(),  // 系统提示词
    }),
    // ...
  })
  return result.object
}
```

用户还可以通过配置文件手动定义 Agent。在初始化阶段，系统会遍历 `cfg.agent` 中的自定义配置，支持覆盖现有 Agent 的模型、提示词、温度等参数，也支持通过 `disable: true` 禁用内置 Agent。

与 Claude Code 相比，后者采用固定的角色体系，没有提供用户自定义 Agent 的能力。Cursor 的 Agent 模式也是单一角色设计。OpenCode 的多 Agent 架构提供了更灵活的可扩展性。

## 4.5 实战：理解 build Agent 的完整配置

让我们追踪 build Agent 从定义到生效的完整过程：

1. **初始化**：系统启动时，`state()` 函数构建所有 Agent 的配置对象。build 被设为 `mode: "primary"`、`native: true`。

2. **权限合成**：全局默认权限允许大部分工具，build 额外开放 `question` 和 `plan_enter`，最后叠加用户自定义权限。

3. **默认 Agent 选择**：`defaultAgent()` 函数优先检查 `cfg.default_agent` 配置，若未设置则选择第一个非隐藏的 primary Agent——通常就是 build。

4. **工具注册**：当用户发起对话时，系统将所有已注册工具传入 `LLM.stream`，由 `resolveTools` 根据 build 的权限规则进行过滤。

5. **Truncate 保障**：系统确保所有 Agent 对 `Truncate.GLOB` 目录有访问权限，除非被显式配置为 `deny`——这保证了截断文件的临时存储始终可用。

通过 `Agent.list()` 获取的 Agent 列表会按默认 Agent 优先排序，确保 UI 中展示顺序的合理性。

## 本章要点

- Agent.Info 通过 Zod schema 定义了包含名称、模式、权限、模型、提示词等字段的完整配置结构
- 七大内置 Agent 各司其职：build/plan 面向用户交互，general/explore 作为子 Agent 并行执行，compaction/title/summary 作为隐藏辅助角色
- 权限隔离采用三层合并策略（默认 → Agent 特有 → 用户覆盖），explore Agent 使用"先拒绝再白名单"的最小权限原则
- 支持通过 AI 生成或配置文件自定义 Agent，可覆盖、扩展甚至禁用内置角色
- 与 Claude Code / Cursor 的单一 Agent 设计相比，OpenCode 的多角色架构提供了更细粒度的能力控制
