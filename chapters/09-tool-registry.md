# 第 9 章　工具注册机制与权限模型

前两章分析了 OpenCode 的具体工具实现。本章向上一层，剖析工具系统的基础架构：`Tool.define()` 定义 API、类型体系、执行上下文、权限模型，以及工具注册表。理解这些机制后，你将能够编写自定义工具来扩展 OpenCode 的能力。

## 9.1 Tool.define()：工具定义 API

> **源码位置**：packages/opencode/src/tool/tool.ts

`Tool.define()` 是所有工具的入口点。它的签名支持两种初始化模式：

```typescript
export function define<Parameters extends z.ZodType, Result extends Metadata>(
  id: string,
  init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
): Info<Parameters, Result>
```

第二个参数 `init` 既可以是一个异步工厂函数（延迟初始化），也可以直接传入工具配置对象（立即初始化）。例如 Read 工具使用立即模式：

```typescript
export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({ ... }),
  async execute(params, ctx) { ... },
})
```

而 Bash 工具使用工厂模式，因为它需要在初始化时检测可用的 Shell：

```typescript
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  return {
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory),
    parameters: z.object({ ... }),
    async execute(params, ctx) { ... },
  }
})
```

### 9.1.1 自动参数验证

`Tool.define()` 在 `execute` 外层包装了一层 Zod 参数验证。当模型传入的参数不合法时，自动生成清晰的错误消息：

```typescript
toolInfo.execute = async (args, ctx) => {
  try {
    toolInfo.parameters.parse(args)
  } catch (error) {
    if (error instanceof z.ZodError && toolInfo.formatValidationError) {
      throw new Error(toolInfo.formatValidationError(error), { cause: error })
    }
    throw new Error(
      `The ${id} tool was called with invalid arguments: ${error}.\n` +
      `Please rewrite the input so it satisfies the expected schema.`,
      { cause: error },
    )
  }
  // ...执行实际逻辑
}
```

工具可以通过 `formatValidationError` 钩子自定义验证错误格式。

## 9.2 Tool.Info 类型体系

`Tool.Info` 是工具的类型定义核心：

```typescript
export interface Info<
  Parameters extends z.ZodType = z.ZodType,
  M extends Metadata = Metadata
> {
  id: string
  init: (ctx?: InitContext) => Promise<{
    description: string
    parameters: Parameters
    execute(
      args: z.infer<Parameters>,
      ctx: Context,
    ): Promise<{
      title: string
      metadata: M
      output: string
      attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
    }>
    formatValidationError?(error: z.ZodError): string
  }>
}
```

几个关键设计点：

- **双泛型参数**：`Parameters` 控制输入类型，`M` 控制元数据类型，确保端到端类型安全
- **延迟初始化**：`init` 是异步函数，工具的 `description` 和 `parameters` 可以根据运行时环境动态生成
- **结构化返回**：`execute` 返回的 `title` 用于 UI 展示，`output` 传给模型，`metadata` 传给前端，`attachments` 支持文件附件
- **InitContext**：初始化时可以访问当前 Agent 信息，用于条件化工具行为

辅助类型 `InferParameters` 和 `InferMetadata` 用于从 `Tool.Info` 实例中提取参数和元数据类型：

```typescript
export type InferParameters<T extends Info> = T extends Info<infer P> ? z.infer<P> : never
export type InferMetadata<T extends Info> = T extends Info<any, infer M> ? M : never
```

## 9.3 Tool.Context：执行上下文

每次工具调用都会收到一个 `Context` 对象：

```typescript
export type Context<M extends Metadata = Metadata> = {
  sessionID: string       // 当前会话 ID
  messageID: string       // 当前消息 ID
  agent: string           // 调用工具的 Agent 名称
  abort: AbortSignal      // 中止信号
  callID?: string         // 工具调用 ID
  extra?: { [key: string]: any }  // 扩展数据
  messages: MessageV2.WithParts[] // 对话历史
  metadata(input: { title?: string; metadata?: M }): void  // 实时元数据推送
  ask(input: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">): Promise<void>
}
```

两个最重要的方法：

**`ctx.metadata()`**：允许工具在执行过程中实时推送状态更新。Bash 工具用它来流式展示命令输出，Task 工具用它来更新子任务状态。

**`ctx.ask()`**：发起权限请求。这是一个异步阻塞操作——调用后工具会暂停执行，等待用户在 UI 中批准或拒绝。权限请求包含 `permission`（权限类型）、`patterns`（匹配模式）、`always`（记忆模式）三个关键字段。

## 9.4 权限模型：三级权限控制

> **源码位置**：packages/opencode/src/permission/next.ts

OpenCode 实现了三级权限控制体系。

### 9.4.1 规则定义

```typescript
export const Rule = z.object({
  permission: z.string(),  // 权限类型：bash, edit, read, task, glob, grep, lsp...
  pattern: z.string(),     // 匹配模式，支持通配符
  action: Action,          // allow | deny | ask
})
```

### 9.4.2 三级规则来源

1. **配置文件级**（Config）：项目的 `opencode.json` 中定义的全局权限规则
2. **Agent 级**（Agent.permission）：每个 Agent 定义中携带的权限规则集，Task 工具在过滤可用子 Agent 时使用
3. **Session 级**（Session.permission）：创建 Session 时注入的临时规则，Task 工具用它来限制子 Agent 的能力

### 9.4.3 规则求值

`evaluate()` 函数合并所有规则集，取最后一条匹配规则的 action（后定义的规则优先）：

```typescript
export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  const merged = merge(...rulesets)
  const match = merged.findLast(
    (rule) => Wildcard.match(permission, rule.permission) &&
              Wildcard.match(pattern, rule.pattern),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}
```

默认行为是 `ask`——当没有任何规则匹配时，工具会请求用户授权。

### 9.4.4 权限审批流程

用户可以选择三种回复：`once`（仅本次允许）、`always`（记住并总是允许同类操作）、`reject`（拒绝）。选择 `reject` 时，同一 Session 中所有待审批的权限请求会一并被拒绝：

```typescript
if (input.reply === "reject") {
  existing.reject(input.message ? new CorrectedError(input.message) : new RejectedError())
  for (const [id, pending] of Object.entries(s.pending)) {
    if (pending.info.sessionID === sessionID) {
      delete s.pending[id]
      pending.reject(new RejectedError())
    }
  }
}
```

用户拒绝时还可以附带反馈消息（`CorrectedError`），模型会收到这条反馈并据此调整行为。

## 9.5 输出自动截断

`Tool.define()` 在 `execute` 包装层中集成了自动截断逻辑：

```typescript
const result = await execute(args, ctx)
// 如果工具已自行处理截断，跳过
if (result.metadata.truncated !== undefined) {
  return result
}
const truncated = await Truncate.output(result.output, {}, initCtx?.agent)
return {
  ...result,
  output: truncated.content,
  metadata: {
    ...result.metadata,
    truncated: truncated.truncated,
    ...(truncated.truncated && { outputPath: truncated.outputPath }),
  },
}
```

设计要点：当工具的 `metadata` 中已包含 `truncated` 字段时，框架不会再次截断，避免双重处理。Read 工具就是自行处理截断的例子——它有更精细的按行截断逻辑。

## 9.6 与 Claude Code / Cursor 的工具系统对比

| 维度 | OpenCode | Claude Code | Cursor |
|------|----------|-------------|--------|
| 工具定义 | `Tool.define()` + Zod schema | 内部硬编码 | 内部硬编码 |
| 自定义工具 | 支持（文件/插件） | 不支持 | 不支持 |
| 参数验证 | Zod 自动验证 | 内部验证 | 内部验证 |
| 权限模型 | 三级规则 + 通配符 | 二级（配置 + 运行时） | 简单确认 |
| 输出截断 | 统一 Truncate 模块 | 工具各自处理 | 内部处理 |
| 子 Agent | Task 工具 + 独立 Session | 不支持 | 不支持 |
| LSP 集成 | 暴露为工具 | 内部使用 | 内部使用 |

OpenCode 的关键优势在于开放性：工具系统完全可扩展，用户可以通过在项目的 `tools/` 目录下放置 TypeScript 文件来注册自定义工具，也可以通过插件系统注册。注册表（`ToolRegistry`）会自动扫描这些文件：

```typescript
const matches = await Config.directories().then((dirs) =>
  dirs.flatMap((dir) =>
    Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true }),
  ),
)
for (const match of matches) {
  const mod = await import(pathToFileURL(match).href)
  for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
    custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
  }
}
```

## 9.7 实战：编写一个自定义 Tool

假设我们要为 OpenCode 添加一个统计代码行数的工具。在项目根目录创建 `tools/loc.ts`：

```typescript
import { z } from "zod"
import type { ToolDefinition } from "@opencode-ai/plugin"

// 默认导出即为工具定义
const tool: ToolDefinition = {
  description: "Count lines of code in the specified directory",
  args: {
    directory: z.string().describe("The directory to count lines in"),
    extension: z.string().optional().describe("File extension filter, e.g. '.ts'"),
  },
  async execute(args, ctx) {
    const { directory, extension } = args
    const { execSync } = await import("child_process")

    // 构建 find + wc 命令
    const ext = extension ? `-name '*${extension}'` : ""
    const cmd = `find ${directory} ${ext} -type f | xargs wc -l 2>/dev/null | tail -1`

    const result = execSync(cmd, {
      cwd: ctx.directory,
      encoding: "utf-8",
    }).trim()

    return `Lines of code: ${result}`
  },
}

export default tool
```

这个工具会被 `ToolRegistry` 自动发现，注册为 `loc` 工具（取自文件名）。它的输出会经过框架的自动截断处理，权限会按照默认的 `ask` 规则弹出用户确认。

工具定义中的 `args` 对应 Zod schema，框架会自动将其包装为 `z.object()`。`execute` 函数接收解析后的参数和插件上下文（包含 `directory`、`worktree` 等项目信息）。

## 9.8 本章要点

- **Tool.define()** 支持立即初始化和工厂函数两种模式，自动包装参数验证和输出截断
- **Tool.Info** 使用双泛型（Parameters + Metadata）实现端到端类型安全，`init` 的异步设计支持运行时动态配置
- **Tool.Context** 提供 `metadata()` 实时推送和 `ask()` 权限请求两个核心方法，是工具与框架交互的唯一通道
- **三级权限模型**（配置文件级、Agent 级、Session 级）通过通配符匹配和"最后匹配胜出"规则实现灵活的权限控制
- OpenCode 的工具系统完全可扩展——在项目的 `tools/` 目录下放置 TypeScript 文件即可注册自定义工具，无需修改框架源码
