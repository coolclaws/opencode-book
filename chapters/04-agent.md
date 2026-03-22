# 第 4 章　Agent 架构与内置角色

> "The key to artificial intelligence has always been the representation." —— Jeff Hawkins

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

### Subagent 调用的完整链路

理解 subagent 的委派机制，需要追踪一次完整的调用链路。当 build Agent 决定将一个子任务委派给 general 或 explore 时，它会调用 Task 工具。Task 工具是 OpenCode 中的一个特殊内置工具，其核心职责是在独立的子会话中启动一个子 Agent。

调用链路如下：build Agent 在当前会话中生成一个 `tool_call`，指定工具名为 `task`，输入参数中包含子 Agent 名称（如 `"explore"`）和任务描述。Processor 接收到这个 tool_call 后，Task 工具的 `execute` 函数创建一条新的子会话——这条子会话拥有独立的消息历史和上下文窗口，不与父会话共享对话内容。子会话以 `explore` 作为 Agent 身份启动一轮新的 `prompt` 调用，传入任务描述作为用户消息。explore Agent 在自己的上下文中执行搜索操作，可能多次调用 grep、glob、read 等工具，每次调用都在子会话内独立进行权限评估。子 Agent 完成后，其最终的文本回复被提取出来，作为 Task 工具的 `result` 返回给父会话的 Processor。build Agent 看到的是 Task 工具的输出——一段文本摘要，它不知道子会话内部经历了多少轮工具调用。

这种设计的优势在于上下文隔离。子 Agent 执行大量搜索操作产生的中间结果（文件内容、grep 输出等）只存在于子会话的上下文窗口中，不会污染父会话有限的上下文空间。父会话只接收最终结论，保持了上下文的精简。同时，build Agent 可以并行启动多个 Task 工具调用，每个在独立的子会话中运行，实现真正的并行研究。

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

## 4.3 Permission.ask() 的挂起机制

当一个工具调用的权限评估结果为 `"ask"` 时，执行流需要暂停等待用户决策。这个挂起机制的实现依赖 Effect 框架的 `Deferred` 原语，其工作过程值得详细展开。

`Permission.ask()` 函数首先遍历请求中的所有 patterns，逐一调用 `evaluate` 函数匹配规则集。如果任何 pattern 匹配到 `"deny"` 规则，立即返回 `DeniedError`；如果所有 pattern 都匹配到 `"allow"`，直接放行。只有当至少一个 pattern 匹配到 `"ask"` 时，流程才进入挂起状态。

进入挂起后，函数创建一个 `Deferred` 对象——这是 Effect 框架中的异步等待原语，类似于一个可以在外部 resolve 或 reject 的 Promise。请求信息被存入 `pending` Map，同时通过 `Bus.publish(Event.Asked, info)` 将权限请求事件广播出去。TUI 层的 SyncProvider 接收到 `permission.asked` 事件后，在界面上展示权限确认对话框，显示工具名称、操作类型和涉及的文件路径，等待用户选择 allow（本次允许）、always（永久允许）或 reject（拒绝）。

此时 `Permission.ask()` 的调用方——通常是 `prompt.ts` 中的工具执行链路——处于 `Deferred.await(deferred)` 的等待状态，整个 Processor 的处理循环被暂停。当用户做出选择后，TUI 通过 SDK 调用 `Permission.reply()`，后者从 `pending` Map 中取出对应的 Deferred 并 resolve 或 reject 它。如果用户选择 `"always"`，系统还会将新的 allow 规则追加到 `approved` 规则集中并持久化到数据库，后续相同的权限请求将直接放行不再打扰用户。如果用户选择 `"reject"`，`Deferred.fail` 触发 `RejectedError`，Processor 捕获这个错误后不仅中断当前工具调用，还会级联取消同一会话中所有待处理的权限请求——因为用户拒绝了一个操作，通常意味着他希望中断整个操作链路，而非逐一审批后续请求。

## 4.4 权限隔离机制

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

## 4.5 Agent.generate()：AI 生成 Agent 配置

`generate` 函数提供了一种独特的扩展方式——用户描述想要的 Agent 行为，由 LLM 自动生成结构化的 Agent 配置。整个过程经过精心设计以确保输出质量。

```typescript
// 文件: packages/opencode/src/agent/agent.ts L287-342
export async function generate(input: { description: string; model?: ... }) {
  const cfg = await Config.get()
  const defaultModel = input.model ?? (await Provider.defaultModel())
  const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
  const language = await Provider.getLanguage(model)
  const system = [PROMPT_GENERATE]
  await Plugin.trigger("experimental.chat.system.transform", { model }, { system })
  const existing = await list()
  const params = {
    temperature: 0.3,
    messages: [
      ...system.map((item): ModelMessage => ({ role: "system", content: item })),
      {
        role: "user",
        content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object...`,
      },
    ],
    model: language,
    schema: z.object({
      identifier: z.string(),
      whenToUse: z.string(),
      systemPrompt: z.string(),
    }),
  }
  // ...
}
```

函数使用 `temperature: 0.3` 调用 LLM——生成配置需要可预测性和结构化输出，但也不能完全抹杀创造性，0.3 比默认值低但不至于过于死板。生成前将已有 Agent 名称列表注入提示词，明确要求 LLM 不能使用已有名称，避免重名覆盖内置 Agent。输出 schema 约束为三个字段：`identifier`（唯一标识）、`whenToUse`（使用场景描述，作为 description 注入工具提示）和 `systemPrompt`（系统提示词）。生成过程还会经过 Plugin 系统的 `experimental.chat.system.transform` 钩子，允许插件修改系统提示词以注入额外的生成指导。对于 OpenAI 的 OAuth 认证场景，函数退化为 `streamObject` 模式以兼容 API 限制。

## 4.6 自定义 Agent 与 Truncate 保障

OpenCode 支持通过配置文件和 AI 自动生成两种方式自定义 Agent。`state()` 函数后半段遍历 `cfg.agent` 中的自定义配置，支持覆盖现有 Agent 的模型、提示词、温度等参数，也支持通过 `disable: true` 禁用内置 Agent。对于不存在的 key，系统会创建全新的 Agent，默认 mode 为 `"all"`，权限继承全局默认值和用户配置。配置覆盖的粒度非常细——用户可以只修改某个内置 Agent 的 temperature 而保留其余所有设置不变，也可以为自定义 Agent 指定专用模型（如用 Claude 做编码、用 GPT-4o 做文件探索）。`mergeDeep` 用于合并 `options` 字段，确保 Provider 扩展选项能被增量修改而非整体替换。

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
- Subagent 通过 Task 工具在独立子会话中运行，上下文隔离避免污染父会话，结果以文本摘要形式返回
- `defaultAgent()` 包含三层验证（存在性、非 subagent、非 hidden），确保默认 Agent 选择的安全性
- `steps` 字段与 `DOOM_LOOP_THRESHOLD` 构成两层循环防御：前者限制总步数，后者通过 JSON 级别的参数比较检测重复模式
- 七大内置 Agent 分三个层次：build/plan 面向用户，general/explore 为子 Agent，compaction/title/summary 为隐藏基础设施
- 隐藏 Agent 的 `hidden: true` 是一种"负空间"设计——mode 虽为 `primary`，但 hidden 标志使其从 UI 和默认选择中被彻底排除
- `Permission.ask()` 通过 Effect 的 `Deferred` 原语实现执行流挂起，Bus 事件驱动 TUI 显示确认对话框，用户 reject 时级联取消同会话所有待处理请求
- 权限隔离采用三层合并策略（默认 → Agent 特有 → 用户覆盖），三种权限值对应三种运行时行为
- explore Agent 使用"先拒绝再白名单"的最小权限原则，天然兼容未来新增工具
- `Agent.generate()` 使用 `temperature: 0.3` 调用 LLM 生成结构化配置，注入已有名称列表防止重名
- 系统对所有 Agent 强制注入 Truncate.GLOB 访问权限，确保核心功能不因权限配置缺失而中断
