# 第 9 章　工具注册机制与权限模型

前两章分析了 OpenCode 的具体工具实现。本章向上一层，剖析工具系统的基础架构：`Tool.define()` 定义 API、类型体系、执行上下文、权限模型，以及工具注册表。理解这些机制后，你将能够编写自定义工具来扩展 OpenCode 的能力。

## 9.1 Tool.define()：工具定义 API

> **源码位置**：packages/opencode/src/tool/tool.ts

`Tool.define()` 是所有工具的入口点。它的签名支持两种初始化模式：

```typescript
// 文件: packages/opencode/src/tool/tool.ts L49-52
export function define<Parameters extends z.ZodType, Result extends Metadata>(
  id: string,
  init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
): Info<Parameters, Result>
```

第二个参数 `init` 既可以是一个异步工厂函数（延迟初始化），也可以直接传入工具配置对象（立即初始化）。例如 Read 工具使用立即模式：

```typescript
// 文件: packages/opencode/src/tool/read.ts L21-27
export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file or directory to read"),
    offset: z.coerce.number().describe("The line number to start reading from").optional(),
    limit: z.coerce.number().describe("The maximum number of lines to read").optional(),
  }),
  async execute(params, ctx) { ... },
})
```

而 Bash 工具使用工厂模式，因为它需要在初始化时检测可用的 Shell：

```typescript
// 文件: packages/opencode/src/tool/bash.ts L55-60
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  return {
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    parameters: z.object({ ... }),
    async execute(params, ctx) { ... },
  }
})
```

### 9.1.1 自动参数验证

`Tool.define()` 在 `execute` 外层包装了一层 Zod 参数验证。当模型传入的参数不合法时，自动生成清晰的错误消息：

```typescript
// 文件: packages/opencode/src/tool/tool.ts L58-69
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

工具可以通过 `formatValidationError` 钩子自定义验证错误格式。错误消息中包含了 `cause` 属性，将原始的 `ZodError` 保留在错误链中，便于上层代码在需要时提取详细的字段级验证信息。

### 9.1.2 自动输出截断

参数验证之后，`define()` 还包装了输出截断逻辑：

```typescript
// 文件: packages/opencode/src/tool/tool.ts L70-85
const result = await execute(args, ctx)
// skip truncation for tools that handle it themselves
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

当工具的 `metadata` 中已包含 `truncated` 字段时，框架不会再次截断，避免双重处理。Read 工具就是自行处理截断的例子——它有更精细的按行截断逻辑。

## 9.2 Tool.Info 类型体系

`Tool.Info` 是工具的类型定义核心：

```typescript
// 文件: packages/opencode/src/tool/tool.ts L28-44
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
- **InitContext**：初始化时可以访问当前 Agent 信息（L13-15），用于条件化工具行为

## 9.3 Tool.Context：执行上下文

每次工具调用都会收到一个 `Context` 对象：

```typescript
// 文件: packages/opencode/src/tool/tool.ts L17-27
export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: any }
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: M }): void
  ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Promise<void>
}
```

两个最重要的方法：

**`ctx.metadata()`**：允许工具在执行过程中实时推送状态更新。Bash 工具用它来流式展示命令输出，Task 工具用它来更新子任务的 Session ID 和模型信息。

**`ctx.ask()`**：发起权限请求。这是一个异步阻塞操作——调用后工具会暂停执行，等待用户在 UI 中批准或拒绝。权限请求包含 `permission`（权限类型）、`patterns`（匹配模式）、`always`（记忆模式）三个关键字段。`extra` 字段用于传递特殊标记——例如 Read 工具设置 `bypassCwdCheck` 来跳过外部目录检查。

## 9.4 工具注册表：ToolRegistry

> **源码位置**：packages/opencode/src/tool/registry.ts

ToolRegistry 是连接工具定义与 LLM 调用的中枢。它负责在运行时收集所有可用工具，将它们转换为 LLM 能理解的格式，并在工具调用时路由到正确的实现。

### 9.4.1 工具来源与自动发现

ToolRegistry 从四个来源收集工具。其中内置工具通过 `all()` 函数硬编码注册：

```typescript
// 文件: packages/opencode/src/tool/registry.ts L99-126
async function all(): Promise<Tool.Info[]> {
  const custom = await state().then((x) => x.custom)
  const config = await Config.get()
  return [
    InvalidTool,
    ...(question ? [QuestionTool] : []),
    BashTool, ReadTool, GlobTool, GrepTool,
    EditTool, WriteTool, TaskTool,
    WebFetchTool, TodoWriteTool, WebSearchTool,
    CodeSearchTool, SkillTool, ApplyPatchTool,
    ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
    ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
    ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [PlanExitTool] : []),
    ...custom,
  ]
}
```

注意工具列表中 `InvalidTool` 排在第一位——这是一个特殊工具，当 LLM 调用了不存在的工具 ID 时作为兜底处理。`ApplyPatchTool` 是为 OpenAI GPT 系列模型准备的替代编辑工具，使用 diff patch 格式而非 search-replace 格式。

自定义工具通过扫描配置目录发现：

```typescript
// 文件: packages/opencode/src/tool/registry.ts L38-53
export const state = Instance.state(async () => {
  const custom = [] as Tool.Info[]
  const matches = await Config.directories().then((dirs) =>
    dirs.flatMap((dir) =>
      Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
    ),
  )
  if (matches.length) await Config.waitForDependencies()
  for (const match of matches) {
    const namespace = path.basename(match, path.extname(match))
    const mod = await import(process.platform === "win32" ? match : pathToFileURL(match).href)
    for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
      custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
    }
  }
  // ...加载 Plugin 工具
})
```

`Config.directories()` 返回多个配置目录——包括项目级目录（如 `.opencode/`）和用户级目录（如 `~/.config/opencode/`）。文件名决定了工具的命名空间：`tools/loc.ts` 的默认导出注册为 `loc`，命名导出 `foo` 则注册为 `loc_foo`。Windows 平台上使用路径字符串直接 import，其他平台则转换为 `file://` URL，这是 Node.js ESM 加载器的跨平台兼容性要求。

### 9.4.2 Plugin 工具的 fromPlugin() 转换

插件工具的定义格式（`ToolDefinition`）与内部工具格式（`Tool.Info`）不同。`fromPlugin()` 函数负责桥接：

```typescript
// 文件: packages/opencode/src/tool/registry.ts L65-87
function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
  return {
    id,
    init: async (initCtx) => ({
      parameters: z.object(def.args),
      description: def.description,
      execute: async (args, ctx) => {
        const pluginCtx = {
          ...ctx,
          directory: Instance.directory,
          worktree: Instance.worktree,
        } as unknown as PluginToolContext
        const result = await def.execute(args as any, pluginCtx)
        const out = await Truncate.output(result, {}, initCtx?.agent)
        return {
          title: "",
          output: out.truncated ? out.content : result,
          metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
        }
      },
    }),
  }
}
```

插件定义中的 `args` 字段是一个扁平的 Zod schema 字典，`fromPlugin()` 将其包装为 `z.object()` 以符合内部格式。插件的 `execute` 函数返回简单字符串，`fromPlugin()` 将其包装为标准的 `{ title, output, metadata }` 格式并自动处理截断。

### 9.4.3 LLM 调用时的工具解析

当 LLM Provider 需要构建工具列表时，`ToolRegistry.tools()` 执行模型特定的过滤和初始化：

```typescript
// 文件: packages/opencode/src/tool/registry.ts L132-173
export async function tools(model: { providerID: ProviderID; modelID: ModelID }, agent?: Agent.Info) {
  const tools = await all()
  const result = await Promise.all(
    tools.filter((t) => {
      // GPT 模型使用 apply_patch 而非 edit/write
      const usePatch = model.modelID.includes("gpt-") && !model.modelID.includes("oss")
        && !model.modelID.includes("gpt-4")
      if (t.id === "apply_patch") return usePatch
      if (t.id === "edit" || t.id === "write") return !usePatch
      return true
    }).map(async (t) => {
      const tool = await t.init({ agent })
      const output = { description: tool.description, parameters: tool.parameters }
      await Plugin.trigger("tool.definition", { toolID: t.id }, output)
      return { id: t.id, ...tool, description: output.description, parameters: output.parameters }
    }),
  )
  return result
}
```

这里有两个值得关注的设计。第一，工具列表根据模型进行动态过滤——GPT 模型使用 `apply_patch`（diff 格式）替代 `edit`/`write`（search-replace 格式），因为 OpenAI 的 Codex 模型对 diff 格式有更好的训练优化。第二，每个工具初始化后都会触发 `tool.definition` 插件钩子，允许插件修改工具的描述和参数 schema——这使得第三方插件可以增强内置工具的行为。

### 9.4.4 动态注册

`ToolRegistry.register()` 支持运行时动态注册和替换工具：

```typescript
// 文件: packages/opencode/src/tool/registry.ts L89-97
export async function register(tool: Tool.Info) {
  const { custom } = await state()
  const idx = custom.findIndex((t) => t.id === tool.id)
  if (idx >= 0) {
    custom.splice(idx, 1, tool)
    return
  }
  custom.push(tool)
}
```

当注册的工具 ID 已存在时，新工具会替换旧工具（`splice`），而非追加。这使得插件可以在运行时覆盖自定义工具的行为。

## 9.5 权限模型：三级权限控制

> **源码位置**：packages/opencode/src/permission/evaluate.ts

### 9.5.1 规则求值

OpenCode 的权限求值核心是一个简洁的 15 行函数：

```typescript
// 文件: packages/opencode/src/permission/evaluate.ts L1-15
import { Wildcard } from "@/util/wildcard"

type Rule = {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const rules = rulesets.flat()
  const match = rules.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}
```

多个 Ruleset 通过 `flat()` 拼接为一个数组。由于 `findLast` 从数组末尾向前搜索，后传入的 Ruleset 优先级更高。调用方按 Config -> Agent -> Session 的顺序传入规则集，使得 Session 级规则（最具体的上下文）优先于 Config 级规则（最通用的配置）。

默认行为是 `ask`——当没有任何规则匹配时，工具会请求用户授权。

### 9.5.2 Wildcard.match() 实现

```typescript
// 文件: packages/opencode/src/util/wildcard.ts L4-20
export function match(str: string, pattern: string) {
  if (str) str = str.replaceAll("\\", "/")
  if (pattern) pattern = pattern.replaceAll("\\", "/")
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  // If pattern ends with " *" (space + wildcard), make the trailing part optional
  if (escaped.endsWith(" .*")) {
    escaped = escaped.slice(0, -3) + "( .*)?"
  }
  const flags = process.platform === "win32" ? "si" : "s"
  return new RegExp("^" + escaped + "$", flags).test(str)
}
```

实现基于正则表达式而非手写的双指针算法。`*` 被转换为 `.*`，`?` 转换为 `.`，其他特殊字符被转义。一个巧妙的细节：当模式以 ` *`（空格加星号）结尾时，尾部被转换为可选匹配 `( .*)?`。这意味着 `ls *` 不仅匹配 `ls -la`，还匹配不带参数的 `ls`。Windows 上使用大小写不敏感匹配（`i` 标志），兼容文件系统的大小写不敏感特性。

### 9.5.3 三级规则来源

1. **配置文件级**（Config）：项目的 `opencode.json` 中定义的全局权限规则
2. **Agent 级**（Agent.permission）：每个 Agent 定义中携带的权限规则集
3. **Session 级**（Session.permission）：创建 Session 时注入的临时规则，Task 工具用它来限制子 Agent 的能力

### 9.5.4 与 Claude Code / Cursor 的工具系统对比

| 维度 | OpenCode | Claude Code | Cursor |
|------|----------|-------------|--------|
| 工具定义 | `Tool.define()` + Zod schema | 内部硬编码 | 内部硬编码 |
| 自定义工具 | 支持（文件/插件） | 不支持 | 不支持 |
| 参数验证 | Zod 自动验证 | 内部验证 | 内部验证 |
| 权限模型 | 三级规则 + 通配符 | 二级（配置 + 运行时） | 简单确认 |
| 输出截断 | 统一 Truncate 模块 | 工具各自处理 | 内部处理 |
| 子 Agent | Task 工具 + 独立 Session | 不支持 | 不支持 |
| LSP 集成 | 暴露为工具 | 内部使用 | 内部使用 |
| 模型适配 | 按 modelID 切换工具集 | 固定工具集 | 固定工具集 |

OpenCode 的关键优势在于开放性：工具系统完全可扩展，用户可以通过在项目的 `tools/` 目录下放置 TypeScript 文件来注册自定义工具，也可以通过插件系统或 MCP 协议注册。`Plugin.trigger("tool.definition", ...)` 钩子更是允许插件在不修改源码的情况下增强内置工具。

## 9.6 实战：编写一个自定义 Tool

假设我们要为 OpenCode 添加一个统计代码行数的工具。在项目根目录创建 `tools/loc.ts`：

```typescript
// 文件: tools/loc.ts（用户自定义工具示例）
import { z } from "zod"
import type { ToolDefinition } from "@opencode-ai/plugin"

const tool: ToolDefinition = {
  description: "Count lines of code in the specified directory",
  args: {
    directory: z.string().describe("The directory to count lines in"),
    extension: z.string().optional().describe("File extension filter, e.g. '.ts'"),
  },
  async execute(args, ctx) {
    const { directory, extension } = args
    const { execSync } = await import("child_process")
    const ext = extension ? `-name '*${extension}'` : ""
    const cmd = `find ${directory} ${ext} -type f | xargs wc -l 2>/dev/null | tail -1`
    const result = execSync(cmd, { cwd: ctx.directory, encoding: "utf-8" }).trim()
    return `Lines of code: ${result}`
  },
}

export default tool
```

这个工具会被 ToolRegistry 自动发现，注册为 `loc` 工具（取自文件名）。框架会通过 `fromPlugin()` 自动将 `args` 包装为 `z.object()`，输出经过自动截断处理，权限按照默认的 `ask` 规则弹出用户确认。

## 9.7 本章要点

- **Tool.define()** 支持立即初始化和工厂函数两种模式，自动包装参数验证（Zod）和输出截断（Truncate），工具可通过 `metadata.truncated` 标记来跳过框架截断
- **Tool.Info** 使用双泛型（Parameters + Metadata）实现端到端类型安全，`init` 的异步设计支持运行时动态配置
- **Tool.Context** 提供 `metadata()` 实时推送和 `ask()` 权限请求两个核心方法，是工具与框架交互的唯一通道
- **ToolRegistry** 从四个来源（内置、自定义文件、Plugin、MCP）收集工具，根据模型 ID 动态过滤工具集（GPT 用 apply_patch，其他用 edit/write），通过 `tool.definition` 钩子支持插件增强
- **三级权限模型**通过 `Wildcard.match()` 正则转换和 `findLast` 的"最后匹配胜出"规则实现灵活的权限控制，默认行为是 `ask`
