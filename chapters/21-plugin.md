# 第 21 章　Plugin 系统与社区生态

可扩展性是优秀开发工具的核心特质。OpenCode 提供了多层次的扩展机制——从简单的自定义工具到完整的插件系统，再到 MCP 生态集成。本章将深入分析这些扩展点的设计与实现。

## 21.1 扩展点概览

OpenCode 的扩展体系由四个层次构成：

```text
┌─────────────────────────────────────┐
│  Layer 4: MCP 服务器生态            │  标准协议，跨工具复用
├─────────────────────────────────────┤
│  Layer 3: Plugin 插件系统           │  npm 包，完整生命周期钩子
├─────────────────────────────────────┤
│  Layer 2: Skill 技能文件            │  Markdown 文件，可共享
├─────────────────────────────────────┤
│  Layer 1: Agent / Command 配置      │  配置文件，零代码
└─────────────────────────────────────┘
```

| 扩展方式 | 复杂度 | 能力范围 | 分发方式 |
|---------|-------|---------|---------|
| Agent 配置 | 低 | 自定义角色和提示词 | `.opencode/agents/*.md` |
| Command 命令 | 低 | 预定义提示词模板 | `.opencode/commands/*.md` |
| Skill 技能 | 中 | 可复用的复合能力 | URL / 本地目录 |
| Plugin 插件 | 高 | 工具、认证、钩子 | npm 包 / 本地文件 |
| MCP 服务器 | 高 | 外部工具和资源 | 独立进程 |

## 21.2 Plugin SDK 核心 API

### 21.2.1 工具定义函数

OpenCode 提供了独立的 `@opencode-ai/plugin` SDK 包，核心是 `tool` 函数和 `ToolContext` 类型。

> **源码位置**：`packages/plugin/src/tool.ts`

```typescript
// 文件: packages/plugin/src/tool.ts L1-38
import { z } from "zod"

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string       // 当前项目目录
  worktree: string        // Git worktree 根目录
  abort: AbortSignal      // 取消信号
  metadata(input: {       // 更新工具元数据
    title?: string
    metadata?: { [key: string]: any }
  }): void
  ask(input: AskInput): Promise<void>  // 请求用户权限
}

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(
    args: z.infer<z.ZodObject<Args>>,
    context: ToolContext,
  ): Promise<string>
}) {
  return input
}
tool.schema = z  // 导出 Zod 供参数定义使用

export type ToolDefinition = ReturnType<typeof tool>
```

`tool` 函数的设计极为简洁——它接收一个包含 `description`、`args`、`execute` 三个字段的对象，直接返回这个对象本身而不做任何包装。参数 schema 复用 Zod，所以 `tool.schema` 直接等于 `z`，插件开发者不需要额外安装 Zod 就可以定义参数类型。`ToolContext` 中的 `directory` 和 `worktree` 区分了当前工作目录和 Git 仓库根目录，便于工具在解析相对路径时选择正确的基准路径。

### 21.2.2 PluginInput 与 Hooks 接口

完整的插件接口通过 `Plugin` 类型和 `Hooks` 接口定义：

> **源码位置**：`packages/plugin/src/index.ts`

```typescript
// 文件: packages/plugin/src/index.ts L26-35
export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>  // SDK 客户端
  project: Project       // 项目信息
  directory: string      // 工作目录
  worktree: string       // Git worktree 路径
  serverUrl: URL         // 服务端 URL
  $: BunShell            // Bun shell 工具
}

export type Plugin = (input: PluginInput) => Promise<Hooks>
```

`PluginInput` 中的 `$: BunShell` 值得特别关注。BunShell 是 Bun 运行时提供的 shell 脚本执行工具，语法类似模板字面量：`await ctx.$\`ls -la\`` 会在子进程中执行 shell 命令并返回结果。在插件上下文中，`$` 的工作目录默认设置为当前项目的 `directory`，这意味着插件中执行的 shell 命令天然以项目根目录为起点。`serverUrl` 字段通过 getter 延迟获取，确保在服务端尚未启动时也能初始化插件。

### 21.2.3 20+ 生命周期钩子

`Hooks` 接口定义了覆盖 OpenCode 全流程的钩子：

```typescript
// 文件: packages/plugin/src/index.ts L162-248
export interface Hooks {
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: { [key: string]: ToolDefinition }
  auth?: AuthHook

  // 消息处理
  "chat.message"?: (input, output) => Promise<void>
  "chat.params"?: (input, output) => Promise<void>
  "chat.headers"?: (input, output) => Promise<void>

  // 权限与工具
  "permission.ask"?: (input, output) => Promise<void>
  "tool.execute.before"?: (input, output) => Promise<void>
  "tool.execute.after"?: (input, output) => Promise<void>
  "tool.definition"?: (input, output) => Promise<void>

  // 环境与命令
  "shell.env"?: (input, output) => Promise<void>
  "command.execute.before"?: (input, output) => Promise<void>

  // 实验性钩子
  "experimental.chat.system.transform"?: (input, output) => Promise<void>
  "experimental.chat.messages.transform"?: (input, output) => Promise<void>
  "experimental.session.compacting"?: (input, output) => Promise<void>
  "experimental.text.complete"?: (input, output) => Promise<void>
}
```

每个钩子都遵循统一的 `(input, output) => Promise<void>` 签名模式。`input` 是只读的上下文信息，`output` 是可变的结果对象——钩子通过修改 `output` 来影响 OpenCode 的行为。例如 `chat.params` 钩子的 `output` 包含 `{ temperature, topP, topK, options }` 四个字段，插件可以根据当前模型和会话状态动态调整这些参数。`chat.headers` 允许注入自定义 HTTP 头部，适用于需要额外认证信息的企业代理场景。

## 21.3 插件加载与执行机制

### 21.3.1 内部插件与外部插件

OpenCode 的插件分为两类：直接编译到代码中的内部插件和通过 npm 安装的外部插件。

> **源码位置**：`packages/opencode/src/plugin/index.ts`

```typescript
// 文件: packages/opencode/src/plugin/index.ts L10-20
import { CodexAuthPlugin } from "./codex"
import { CopilotAuthPlugin } from "./copilot"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"

export namespace Plugin {
  const INTERNAL_PLUGINS: PluginInstance[] = [
    CodexAuthPlugin,      // OpenAI Codex 认证
    CopilotAuthPlugin,    // GitHub Copilot 认证
    GitlabAuthPlugin,     // GitLab 认证
  ]
}
```

内部插件在启动时直接调用，无需安装步骤。三个认证插件分别负责 OpenAI Codex、GitHub Copilot 和 GitLab 的认证流程——当用户没有配置对应的 API Key 时，这些插件提供交互式的 OAuth 或设备授权引导。CopilotAuthPlugin 使用设备授权流程（Device Authorization Grant），先请求一个设备码，展示给用户 URL 和验证码，用户在浏览器中完成授权后，插件轮询获取 access token。

### 21.3.2 外部插件安装流程

外部插件的加载包含安装和动态导入两个阶段：

```typescript
// 文件: packages/opencode/src/plugin/index.ts L57-99
for (let plugin of plugins) {
  if (plugin.includes("opencode-openai-codex-auth") ||
      plugin.includes("opencode-copilot-auth")) continue

  if (!plugin.startsWith("file://")) {
    const lastAtIndex = plugin.lastIndexOf("@")
    const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
    const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"
    plugin = await BunProc.install(pkg, version).catch((err) => {
      Bus.publish(Session.Event.Error, {
        error: new NamedError.Unknown({
          message: `Failed to install plugin ${pkg}@${version}: ${detail}`,
        }).toObject(),
      })
      return ""
    })
    if (!plugin) continue
  }

  await import(plugin).then(async (mod) => {
    const seen = new Set<PluginInstance>()
    for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
      if (seen.has(fn)) continue  // 去重：同一函数的 named + default export
      seen.add(fn)
      hooks.push(await fn(input))
    }
  })
}
```

版本号从插件标识符中按最后一个 `@` 符号分割提取，例如 `opencode-anthropic-auth@0.0.13` 被拆分为包名 `opencode-anthropic-auth` 和版本 `0.0.13`。如果标识符以 `file://` 开头，则跳过安装步骤，直接将本地文件路径传给 `import()`——这是本地开发和调试插件的快捷方式。安装完成后，动态 `import()` 加载模块，遍历其所有导出成员，使用 `Set` 对函数引用进行去重，避免同时有 named export 和 default export 指向同一个函数时重复初始化。安装失败不会中断整个加载流程，而是通过 `Bus.publish` 将错误事件发送到 UI 层展示给用户。

### 21.3.3 钩子触发机制

插件的钩子按注册顺序依次执行，形成链式调用管道：

```typescript
// 文件: packages/opencode/src/plugin/index.ts L107-122
export async function trigger<
  Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool">,
>(name: Name, input: Input, output: Output): Promise<Output> {
  if (!name) return output
  for (const hook of await state().then((x) => x.hooks)) {
    const fn = hook[name]
    if (!fn) continue
    await fn(input, output)  // 链式调用，output 可被修改
  }
  return output
}
```

`trigger` 函数的类型签名使用 `Exclude` 排除了 `auth`、`event` 和 `tool` 三种钩子——这些钩子有专门的调用路径，不走通用的 `trigger` 管道。链式调用意味着后加载的插件可以看到前一个插件修改后的 `output`，从而实现组合效果。例如两个插件都实现了 `chat.headers` 钩子，第一个添加了 `X-Team-ID` 头部，第二个添加了 `X-Request-Source` 头部，最终的请求会同时携带两个头部。

### 21.3.4 插件初始化与事件分发

插件系统在初始化阶段完成 config 钩子调用和 Bus 事件订阅：

```typescript
// 文件: packages/opencode/src/plugin/index.ts L128-143
export async function init() {
  const hooks = await state().then((x) => x.hooks)
  const config = await Config.get()
  for (const hook of hooks) {
    await hook.config?.(config)
  }
  Bus.subscribeAll(async (input) => {
    const hooks = await state().then((x) => x.hooks)
    for (const hook of hooks) {
      hook["event"]?.({ event: input })
    }
  })
}
```

`config` 钩子在启动时调用一次，允许插件根据配置信息初始化内部状态。`event` 钩子通过 `Bus.subscribeAll` 订阅全局事件总线的所有事件，这意味着插件可以监听到 session 创建、消息更新、MCP 状态变化等任何系统事件。需要注意 `event` 钩子的调用没有 `await`——这是有意为之，避免慢速插件的事件处理阻塞事件分发管道。

## 21.4 实验性钩子详解

### 21.4.1 系统提示词与消息变换

`experimental.chat.system.transform` 允许插件在系统提示词发送给 LLM 之前对其进行修改。`input` 包含 `sessionID` 和 `model` 信息，`output` 的 `system` 字段是字符串数组，插件可以追加、替换或过滤提示词片段。这个钩子的典型用途包括注入团队编码规范、根据当前文件类型动态调整行为、或添加项目上下文信息。

`experimental.chat.messages.transform` 在消息数组发送给 LLM 之前触发，允许插件修改、过滤或重排消息历史。`output.messages` 是 `{ info: Message, parts: Part[] }` 数组，插件可以删除包含敏感信息的消息、将代码片段替换为摘要以节省 token、或在消息序列中插入额外上下文。

### 21.4.2 会话压缩自定义

`experimental.session.compacting` 介入会话压缩过程。当会话历史超过 token 限制时，OpenCode 触发压缩。插件通过 `output.context` 数组追加额外的上下文信息供压缩参考，或设置 `output.prompt` 完全替换默认的压缩提示词。例如，一个插件可以实现"保留所有包含代码修改的消息，只压缩纯文本讨论"的自定义策略。

## 21.5 认证插件开发

认证插件是 OpenCode 生态的重要组成部分，支持 OAuth 和 API Key 两种模式：

```typescript
// 文件: packages/plugin/src/index.ts L43-117
export type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<Auth>, provider: Provider) =>
    Promise<Record<string, any>>
  methods: (
    | {
        type: "oauth"
        label: string
        prompts?: Array<
          | { type: "text"; key: string; message: string; validate?: ... }
          | { type: "select"; key: string; message: string; options: ... }
        >
        authorize(inputs?: Record<string, string>): Promise<AuthOuathResult>
      }
    | {
        type: "api"
        label: string
        authorize?(inputs?: Record<string, string>): Promise<
          { type: "success"; key: string; provider?: string }
          | { type: "failed" }
        >
      }
  )[]
}
```

OAuth 方法支持两种回调模式：`"auto"` 模式下插件自动轮询认证服务器等待用户完成授权；`"code"` 模式下用户需要手动输入验证码。`prompts` 数组允许认证流程中展示交互式表单——例如让用户选择 API 端点（`type: "select"`）或输入自定义域名（`type: "text"`）。`loader` 函数在认证成功后调用，用于从 token 加载额外的 Provider 配置信息。`when` 规则实现条件显示：只有当前面某个 prompt 的值满足 `{ key, op, value }` 条件时，当前 prompt 才会展示。

## 21.6 错误处理与隔离

插件钩子中抛出的异常不会导致 OpenCode 主进程崩溃。`trigger` 函数内部的钩子调用被 try-catch 包裹——当某个插件抛出错误时，该错误会被记录到日志中并通过 `Bus.publish(Session.Event.Error, ...)` 通知 UI 层，然后继续执行下一个插件的同名钩子。对于工具执行（`tool.execute`）中的错误，OpenCode 会将错误信息格式化为工具调用的失败结果返回给 LLM，让 LLM 决定下一步操作。`abort` 信号的处理也在此范围内：当用户取消操作时，`AbortSignal` 被触发，正在执行的工具应该检查这个信号并及时终止。

## 21.7 Skill 发现与远程共享

### 21.7.1 Skill 搜索机制

Skill 是以 Markdown 文件定义的可复用能力单元，OpenCode 从多个位置搜索 Skill：

> **源码位置**：`packages/opencode/src/skill/skill.ts`

```text
搜索优先级（低 → 高）：
1. ~/.config/opencode/skills/      （全局 Skill）
2. .claude/skills/                 （兼容 Claude Code）
3. .agents/skills/                 （通用 Agent 目录）
4. .opencode/skills/               （项目级 Skill）
5. opencode.json 中 skills.paths   （自定义路径）
6. opencode.json 中 skills.urls    （远程 URL）
```

兼容 `.claude/skills/` 和 `.agents/skills/` 目录是一个务实的决定，让已有的 Claude Code 用户可以无缝迁移自己积累的 Skill 文件。

### 21.7.2 URL 远程 Skill

OpenCode 支持从远程 URL 拉取 Skill，通过 `index.json` 索引文件发现可用的 Skill 列表：

> **源码位置**：`packages/opencode/src/skill/discovery.ts`

```typescript
// 文件: packages/opencode/src/skill/discovery.ts L10-30
export async function pull(url: string): Promise<string[]> {
  const base = url.endsWith("/") ? url : `${url}/`
  const index = new URL("index.json", base).href
  const data = await fetch(index).then((r) => r.json() as Promise<Index>)

  for (const skill of data.skills) {
    for (const file of skill.files) {
      await get(new URL(file, base).href, path.join(cache, file))
    }
  }
  return result
}
```

在 `opencode.json` 中配置远程 Skill 源后，团队成员可以共享统一的 Skill 集合。

## 21.8 MCP 生态集成

OpenCode 同时支持本地和远程两种 MCP 服务器配置。本地 MCP 通过子进程启动，远程 MCP 通过 HTTP/SSE 连接，支持 OAuth 2.0 认证和动态客户端注册（RFC 7591）。

| 维度 | MCP 服务器 | Plugin 插件 |
|------|-----------|------------|
| 运行方式 | 独立进程 | 同进程加载 |
| 协议 | 标准 MCP 协议 | OpenCode Plugin API |
| 跨工具复用 | 可用于任何 MCP 客户端 | 仅限 OpenCode |
| 能力范围 | 工具 + 资源 | 工具 + 钩子 + 认证 |
| 语言限制 | 任何语言 | TypeScript/JavaScript |

选择 MCP 还是 Plugin 取决于使用场景：如果工具需要跨多个 AI 客户端复用，选择 MCP；如果需要深度集成 OpenCode 的生命周期钩子（如修改系统提示词、拦截权限请求），则选择 Plugin。

## 21.9 实战：发布一个 OpenCode 插件

### 步骤一：创建插件

```bash
mkdir my-opencode-plugin && cd my-opencode-plugin
bun init && bun add @opencode-ai/plugin
```

### 步骤二：本地测试

```json
// opencode.json
{ "plugin": ["file:///path/to/my-opencode-plugin/src/index.ts"] }
```

### 步骤三：发布到 npm

```bash
npm publish
```

用户安装时只需在 `opencode.json` 中添加 `"plugin": ["opencode-style-checker@1.0.0"]`，插件依赖会自动通过 Bun 安装到 `.opencode/node_modules/` 目录。

## 21.10 本章要点

- **四层扩展体系**：Agent/Command 配置（零代码）→ Skill 技能（Markdown）→ Plugin 插件（TypeScript）→ MCP 服务器（标准协议），覆盖从简单到复杂的所有扩展需求
- **Plugin SDK 设计简洁**：`tool()` 函数 + Zod schema 定义参数，`ToolContext` 提供 session、directory、abort 等上下文信息，支持权限请求
- **20+ 生命周期钩子**：涵盖消息处理、LLM 参数调整、工具执行前后、Shell 环境注入、权限拦截等，钩子按注册顺序链式执行
- **插件加载支持 npm 和 file:// 两种来源**，动态 `import()` 加载后使用 `Set` 对函数引用去重，安装失败不阻断其他插件
- **插件错误隔离**：钩子异常不会阻断其他插件执行，工具执行失败会将错误信息返回给 LLM 而非导致进程崩溃
- **Skill 发现机制**兼容 Claude Code 的 `.claude/skills/` 目录，支持 URL 远程拉取和 `index.json` 索引，实现团队级共享
