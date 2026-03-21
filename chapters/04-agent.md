# 第 4 章　Agent 架构与内置角色

在 AI 编程助手中，Agent 是连接用户意图与工具执行的核心抽象。OpenCode 通过一套精巧的 Agent 体系，将不同场景下的能力需求映射为不同的角色配置。本章将深入分析 Agent 的类型定义、七大内置角色的设计思路，以及权限隔离与自定义扩展机制。

> **源码位置**：packages/opencode/src/agent/agent.ts

## 4.1 Agent.Info 类型定义

OpenCode 使用 Zod schema 定义 Agent 的完整配置结构：

```typescript
// 文件: packages/opencode/src/agent/agent.ts L25-49
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
    permission: Permission.Ruleset,            // 权限规则集
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

这个 schema 看似简单，但每个字段的组合方式蕴含着深层的架构思考。下面我们逐一分析几个关键字段。

### mode 字段：Agent 的角色边界与调度逻辑

`mode` 字段有三个合法值，它们定义了一个 Agent 在系统中可以扮演的角色：

- **`"primary"`**：主 Agent，可以直接与用户交互。build、plan 以及三个隐藏 Agent（compaction、title、summary）都属于此类。
- **`"subagent"`**：子 Agent，只能被其他 Agent 通过 Task 工具调用。general 和 explore 属于此类。
- **`"all"`**：两种模式皆可，既能作为主 Agent 直接与用户交互，也能被其他 Agent 调用。用户通过配置文件自定义的 Agent 默认使用此模式。

子 Agent 的存在是为了让主 Agent 拥有"委派"能力——当 build Agent 面对一个需要大量文件搜索的子任务时，它可以把这项工作交给 explore，后者带有专门优化过的只读工具集和系统提示词。这种委派机制让每个 Agent 都保持职责单一，而不是把所有能力堆砌在一个 Agent 上。

### Agent 选择的决策路径

当用户发送一条消息时，系统如何决定使用哪个 Agent？这个过程由 `defaultAgent()` 函数控制，它包含三层验证：

```typescript
// 文件: packages/opencode/src/agent/agent.ts L270-285
export async function defaultAgent() {
  const cfg = await Config.get()
  const agents = await state()
  if (cfg.default_agent) {
    const agent = agents[cfg.default_agent]
    if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
    if (agent.mode === "subagent") throw new Error(...)
    if (agent.hidden === true) throw new Error(...)
    return agent.name
  }
  const primaryVisible = Object.values(agents)
    .find((a) => a.mode !== "subagent" && a.hidden !== true)
  return primaryVisible.name
}
```

三道防线确保安全：不存在则抛错、subagent 不能当默认、hidden Agent 不能当默认。如果用户没有指定 `default_agent`，系统查找第一个非 subagent 且非 hidden 的角色——通常就是 build。

以下是 Agent 选择的完整决策路径：

```text
                 ┌─────────────────────┐
                 │  用户发送消息        │
                 └─────────┬───────────┘
                           ↓
                 ┌─────────────────────┐
                 │ cfg.default_agent   │
                 │ 是否已配置?          │
                 └────┬───────────┬────┘
                   是 ↓           ↓ 否
          ┌────────────────┐  ┌──────────────────────┐
          │ 查找对应 Agent  │  │ 遍历所有 Agent        │
          └───┬────────────┘  │ 找第一个非 subagent    │
              ↓               │ 且非 hidden 的角色     │
          ┌────────────────┐  └──────────┬─────────────┘
          │ 存在? 非 sub?  │             ↓
          │ 非 hidden?     │     ┌───────────────┐
          └──┬──────┬──────┘     │ 返回该 Agent   │
          通过↓     ↓ 失败       │ (通常是 build) │
     ┌──────────┐  抛出错误      └───────────────┘
     │ 返回该   │
     │ Agent    │
     └──────────┘
```

### steps 字段：防止无限循环的第一道防线

`steps` 字段控制 Agent 在单次对话轮次中可以执行的最大工具调用步数：

```typescript
// 文件: packages/opencode/src/session/prompt.ts L563
const maxSteps = agent.steps ?? Infinity
const isLastStep = step >= maxSteps
```

当 `step >= maxSteps` 时，系统注入 `MAX_STEPS` 系统消息并清空工具列表，迫使模型纯文本回复。第二道防线是 `processor.ts` 中的 `DOOM_LOOP_THRESHOLD = 3`——连续三次完全相同的工具调用（通过 `JSON.stringify` 比较参数）触发 `doom_loop` 权限检查：

```typescript
// 文件: packages/opencode/src/session/processor.ts L153-177
const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)
if (
  lastThree.length === DOOM_LOOP_THRESHOLD &&
  lastThree.every(
    (p) => p.type === "tool" && p.tool === value.toolName &&
      p.state.status !== "pending" &&
      JSON.stringify(p.state.input) === JSON.stringify(value.input),
  )
) {
  await Permission.ask({ permission: "doom_loop", ... })
}
```

两层保护各有侧重：`steps` 限制总迭代次数，`doom_loop` 检测重复模式。两者互补，共同构成循环防御体系（详见第 5 章）。

## 4.2 七大内置 Agent

OpenCode 预定义了七个内置 Agent，分为三个层次。

### 面向用户的主 Agent

**build** —— 默认主 Agent，拥有最完整的工具权限。它额外允许使用 `question`（向用户提问）和 `plan_enter`（进入计划模式），是日常编码的主力角色。build 未设置 `steps` 字段，因此 `maxSteps` 默认为 `Infinity`——它不受步数限制，但 `doom_loop` 检测仍然生效。这反映了一个判断：全功能 Agent 限制总步数会影响处理复杂任务的能力，但重复检测仍然是必要的安全网。

**plan** —— 计划模式 Agent。禁止所有编辑操作，仅允许在 `.opencode/plans/` 目录下创建 Markdown 计划文件。将 plan 设为独立 Agent 而非 build 的一个模式，使得它可以拥有完全不同的权限集和系统提示词。它额外开放了 `plan_exit` 权限——两个 Agent 各持一把"模式切换钥匙"，plan 能退出计划模式，build 能进入，形成了对称的模式切换机制。

### 面向委派的子 Agent

**general** —— 通用子 Agent（`mode: "subagent"`），用于并行执行多步骤研究任务。禁用了 `todoread` 和 `todowrite`，避免子任务与主 Agent 的任务管理产生冲突。当 build Agent 需要同时调查多个问题时，它可以启动多个 general 子任务并行运行，每个子任务在独立的子会话中拥有自己的上下文窗口。

**explore** —— 快速代码探索子 Agent，专注只读操作。它拥有独立的系统提示词（`PROMPT_EXPLORE`），引导模型进行高效搜索。其 description 字段特别详细，包含深度级别说明（"quick"/"medium"/"very thorough"），这些描述会被注入调用方的工具提示中，帮助主 Agent 正确使用 explore。工具集采用"白名单"策略（先 deny 所有，再逐一开放），意味着即使系统新增写入类工具，explore 也不会意外获得使用权。

### 隐藏的基础设施 Agent：负空间设计

**compaction** —— 上下文压缩 Agent。通过 `"*": "deny"` 禁止所有工具，唯一职责是接收冗长的对话历史并生成结构化摘要。禁止工具调用是刻意为之——压缩过程必须是纯粹的文本生成，任何副作用都可能引入不可预测的行为。详见第 6 章。

**title** —— 标题生成 Agent。设置 `temperature: 0.5`，这是一个经过权衡的值：太低（如 0.1）会导致标题千篇一律，太高（如 1.0）则可能生成古怪的标题。0.5 在"一致性"和"多样性"之间取得了平衡。

**summary** —— 摘要生成 Agent。面向用户的代码变更概览，区别于面向系统内部上下文管理的 compaction。

这三个隐藏 Agent 共享一个关键决策：`hidden: true`。虽然它们的 mode 都设为 `"primary"`，但 hidden 标志使其只能被系统内部代码通过 `Agent.get("compaction")` 等方式直接获取。在源码中，`defaultAgent()` 函数显式排除 `hidden === true` 的 Agent，UI 层渲染时也会过滤掉隐藏角色。这种"负空间"设计消除了用户误操作的可能——想象一下，如果用户不小心切换到 compaction Agent 然后尝试编写代码，所有工具都被禁用，体验将非常糟糕。`hidden: true` 从 UI 层面消除了这种可能。

## 4.3 权限隔离机制

### 三层合并的工作原理

权限构建发生在 `state()` 函数内部，以 build 为例：

```typescript
// 文件: packages/opencode/src/agent/agent.ts L78-92
build: {
  permission: Permission.merge(
    defaults,                    // 第一层：全局默认权限
    Permission.fromConfig({      // 第二层：Agent 特有覆盖
      question: "allow",
      plan_enter: "allow",
    }),
    user,                        // 第三层：用户自定义配置
  ),
}
```

`Permission.merge` 的语义是后者覆盖前者。全局默认权限（`defaults`）提供了一个合理的安全基线：大多数工具设为 `"allow"`，因为频繁的权限确认会严重影响工作流；`doom_loop` 检测设为 `"ask"`，因为连续重复调用可能意味着模型出了问题；`.env` 文件读取需要确认——这些敏感操作的默认态度是谨慎的。Agent 特有配置在此基础上进行微调，用户自定义配置拥有最终决定权。

### 权限三层合并流程

```text
  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │ 全局默认权限      │  │ Agent 特有权限    │  │ 用户自定义权限    │
  │ defaults         │  │ 覆盖             │  │ user             │
  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
           │                     │                     │
           └─────────┬───────────┘                     │
                     ↓                                 │
              Permission.merge ←───────────────────────┘
                     │
                     ↓
              ┌──────────────┐
              │ 评估工具权限  │
              └──┬───┬───┬───┘
                 │   │   │
         allow ──┘   │   └── deny
                     │
                    ask
                     │
           ┌─────────┴─────────┐
           │ 弹出用户确认对话框 │
           └──┬──────┬─────┬───┘
              │      │     │
          once ↓  always ↓  ↓ reject
         ┌──────┐ ┌───────┐ ┌──────────────┐
         │ 执行 │ │ 记录  │ │ 拒绝并反馈   │
         │ 工具 │ │ 规则  │ │ 给模型       │
         └──────┘ │ 并执行│ └──────────────┘
                  └───────┘
```

`allow` 让工具静默可用；`deny` 让工具从模型可见列表中消失；`ask` 保留可见性但需用户确认。

### explore Agent 的最小权限实践

```typescript
// 文件: packages/opencode/src/agent/agent.ts L132-150
explore: {
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      "*": "deny",        // 先禁止一切
      grep: "allow",      // 再逐一开放只读工具
      glob: "allow",
      list: "allow",
      bash: "allow",
      read: "allow",
      webfetch: "allow",
      websearch: "allow",
      codesearch: "allow",
      external_directory: { "*": "ask", ...whitelistedDirs },
    }),
    user,
  ),
}
```

"先拒绝再白名单"模式天然兼容未来新增工具。explore 还单独声明了 `external_directory` 规则，白名单目录（`Truncate.GLOB` 和 skill 目录）设为 allow，其他外部目录设为 ask。

## 4.4 自定义 Agent 与 Truncate 保障

OpenCode 支持通过配置文件和 AI 自动生成两种方式自定义 Agent。`state()` 函数后半段遍历 `cfg.agent` 中的自定义配置，支持覆盖现有 Agent 的模型、提示词、温度等参数，也支持通过 `disable: true` 禁用内置 Agent。对于不存在的 key，系统会创建全新的 Agent，默认 mode 为 `"all"`，权限继承全局默认值和用户配置。`generate` 函数使用 `temperature: 0.3` 调用 LLM 生成结构化配置——生成配置需要可预测性和结构化输出，但也不能完全抹杀创造性。生成前会将已有 Agent 名称列表注入提示词，避免重名冲突。

无论内置还是自定义 Agent，系统最后都执行 Truncate 保障检查：

```typescript
// 文件: packages/opencode/src/agent/agent.ts L236-249
for (const name in result) {
  const explicit = agent.permission.some((r) =>
    r.permission === "external_directory" &&
    r.action === "deny" && r.pattern === Truncate.GLOB)
  if (explicit) continue
  result[name].permission = Permission.merge(
    result[name].permission,
    Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
  )
}
```

除非显式 deny，所有 Agent 都会获得 `Truncate.GLOB` 目录的访问权限——大文件截断功能不能因权限缺失而中断。

`Agent.list()` 使用 remeda 的 `pipe` + `sortBy`，默认 Agent 排最前，再按名称字母序排列。与 Claude Code 的固定角色体系和 Cursor 的单一 Agent 设计相比，OpenCode 的多角色架构提供了更灵活的可扩展性。

## 本章要点

- Agent.Info 通过 Zod schema 定义了包含名称、模式、权限、模型、提示词等字段的完整配置结构
- `mode` 字段划分三种角色：`primary` 直接与用户交互，`subagent` 只能被委派调用，`all` 兼具两种能力
- `defaultAgent()` 包含三层验证（存在性、非 subagent、非 hidden），确保默认 Agent 选择的安全性
- `steps` 字段与 `DOOM_LOOP_THRESHOLD` 构成两层循环防御：前者限制总步数，后者通过 JSON 级别的参数比较检测重复模式
- 七大内置 Agent 分三个层次：build/plan 面向用户，general/explore 为子 Agent，compaction/title/summary 为隐藏基础设施
- 隐藏 Agent 的 `hidden: true` 是一种"负空间"设计——mode 虽为 `primary`，但 hidden 标志使其从 UI 和默认选择中被彻底排除
- 权限隔离采用三层合并策略（默认 → Agent 特有 → 用户覆盖），三种权限值对应三种运行时行为
- explore Agent 使用"先拒绝再白名单"的最小权限原则，天然兼容未来新增工具
- 系统对所有 Agent 强制注入 Truncate.GLOB 访问权限，确保核心功能不因权限配置缺失而中断
