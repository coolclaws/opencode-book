# 第 21 章　Plugin 系统与社区生态

可扩展性是优秀开发工具的核心特质。OpenCode 提供了多层次的扩展机制——从简单的自定义工具到完整的插件系统，再到 MCP 生态集成。本章将深入分析这些扩展点的设计与实现。

## 21.1 扩展点概览

OpenCode 的扩展体系由四个层次构成：

```
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

## 21.2 自定义工具开发

### 21.2.1 Plugin SDK

OpenCode 提供了独立的 `@opencode-ai/plugin` SDK 包，核心 API 简洁明了。

> **源码位置**：`packages/plugin/src/tool.ts`

```typescript
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

// 工具定义函数
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
```

### 21.2.2 编写第一个自定义工具

> **源码位置**：`packages/plugin/src/example.ts`

```typescript
import { Plugin } from "./index.js"
import { tool } from "./tool.js"

export const ExamplePlugin: Plugin = async (ctx) => {
  return {
    tool: {
      // 工具名称作为 key
      mytool: tool({
        description: "This is a custom tool",
        args: {
          foo: tool.schema.string().describe("foo"),
        },
        async execute(args) {
          return `Hello ${args.foo}!`
        },
      }),
    },
  }
}
```

### 21.2.3 Plugin 类型定义

完整的插件接口支持丰富的生命周期钩子：

> **源码位置**：`packages/plugin/src/index.ts`

```typescript
export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>  // SDK 客户端
  project: Project       // 项目信息
  directory: string      // 工作目录
  worktree: string       // Git worktree 路径
  $: BunShell            // Bun shell 工具
}

export type Plugin = (input: PluginInput) => Promise<Hooks>

export interface Hooks {
  // 事件监听
  event?: (input: { event: Event }) => Promise<void>

  // 配置修改
  config?: (input: Config) => Promise<void>

  // 自定义工具
  tool?: { [key: string]: ToolDefinition }

  // 认证钩子
  auth?: AuthHook

  // 消息钩子
  "chat.message"?: (input, output) => Promise<void>

  // LLM 参数修改
  "chat.params"?: (input, output) => Promise<void>

  // 请求头修改
  "chat.headers"?: (input, output) => Promise<void>

  // 权限拦截
  "permission.ask"?: (input, output) => Promise<void>

  // 工具执行前后钩子
  "tool.execute.before"?: (input, output) => Promise<void>
  "tool.execute.after"?: (input, output) => Promise<void>

  // Shell 环境变量注入
  "shell.env"?: (input, output) => Promise<void>

  // 命令执行前钩子
  "command.execute.before"?: (input, output) => Promise<void>

  // 实验性：系统提示词变换
  "experimental.chat.system.transform"?: (input, output) => Promise<void>

  // 实验性：消息变换
  "experimental.chat.messages.transform"?: (input, output) => Promise<void>

  // 实验性：压缩自定义
  "experimental.session.compacting"?: (input, output) => Promise<void>

  // 工具定义修改
  "tool.definition"?: (input, output) => Promise<void>
}
```

### 21.2.4 高级工具示例：带权限请求的工具

```typescript
import { tool } from "@opencode-ai/plugin"

export const DeployPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      deploy: tool({
        description: "Deploy the application to production",
        args: {
          environment: tool.schema
            .enum(["staging", "production"])
            .describe("Target environment"),
          version: tool.schema.string().describe("Version to deploy"),
        },
        async execute(args, context) {
          // 请求用户确认
          await context.ask({
            permission: "deploy",
            patterns: [args.environment],
            always: [],
            metadata: {
              environment: args.environment,
              version: args.version,
            },
          })

          // 更新工具状态显示
          context.metadata({
            title: `Deploying v${args.version} to ${args.environment}`,
          })

          // 执行部署逻辑
          const result = await ctx.$`deploy --env ${args.environment} --version ${args.version}`
          return `Deployed v${args.version} to ${args.environment} successfully`
        },
      }),
    },
  }
}
```

## 21.3 Skill 市场与分享

### 21.3.1 Skill 定义

Skill 是 OpenCode 中可复用的复合能力单元，以 Markdown 文件定义：

> **源码位置**：`packages/opencode/src/skill/skill.ts`

```typescript
export namespace Skill {
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
  })

  // Skill 搜索路径
  const EXTERNAL_DIRS = [".claude", ".agents"]     // 兼容 Claude Code
  const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
  const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
}
```

一个典型的 Skill 文件结构：

```markdown
---
name: react-component
description: Generate React components with TypeScript and tests
---

When creating a React component, follow these steps:

1. Create the component file with proper TypeScript types
2. Add unit tests using @testing-library/react
3. Export from the index file
4. Add Storybook story if applicable

Use functional components with hooks. Prefer composition over inheritance.
```

### 21.3.2 Skill 发现机制

OpenCode 从多个位置搜索 Skill：

```
搜索优先级（低 → 高）：
1. ~/.config/opencode/skills/      （全局 Skill）
2. .claude/skills/                 （兼容 Claude Code）
3. .agents/skills/                 （通用 Agent 目录）
4. .opencode/skills/               （项目级 Skill）
5. opencode.json 中 skills.paths   （自定义路径）
6. opencode.json 中 skills.urls    （远程 URL）
```

### 21.3.3 URL 远程 Skill

OpenCode 支持从远程 URL 拉取 Skill，实现团队级共享：

> **源码位置**：`packages/opencode/src/skill/discovery.ts`

```typescript
export namespace Discovery {
  type Index = {
    skills: Array<{
      name: string
      description: string
      files: string[]
    }>
  }

  export async function pull(url: string): Promise<string[]> {
    const base = url.endsWith("/") ? url : `${url}/`
    const index = new URL("index.json", base).href

    // 拉取 index.json 获取 Skill 列表
    const data = await fetch(index).then((r) => r.json() as Promise<Index>)

    // 下载每个 Skill 的文件到本地缓存
    for (const skill of data.skills) {
      for (const file of skill.files) {
        await get(new URL(file, base).href, path.join(cache, file))
      }
    }
    return result
  }
}
```

在 `opencode.json` 中配置远程 Skill 源：

```json
{
  "skills": {
    "urls": [
      "https://example.com/.well-known/skills/"
    ],
    "paths": [
      "~/shared-skills"
    ]
  }
}
```

## 21.4 MCP 生态集成

### 21.4.1 MCP 服务器配置

OpenCode 支持本地和远程两种 MCP 服务器配置：

> **源码位置**：`packages/opencode/src/config/config.ts`

```typescript
// 本地 MCP 服务器
export const McpLocal = z.object({
  type: z.literal("local"),
  command: z.string().array(),         // 启动命令
  environment: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
})

// 远程 MCP 服务器
export const McpRemote = z.object({
  type: z.literal("remote"),
  url: z.string(),                     // 服务器 URL
  enabled: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: z.union([McpOAuth, z.literal(false)]).optional(),
  timeout: z.number().int().positive().optional(),
})
```

配置示例：

```json
{
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "@modelcontextprotocol/server-github"],
      "environment": {
        "GITHUB_TOKEN": "{env:GITHUB_TOKEN}"
      }
    },
    "remote-db": {
      "type": "remote",
      "url": "https://mcp.example.com/db",
      "oauth": {
        "clientId": "my-client-id",
        "scope": "read write"
      }
    }
  }
}
```

### 21.4.2 MCP 与 Plugin 的区别

| 维度 | MCP 服务器 | Plugin 插件 |
|------|-----------|------------|
| 运行方式 | 独立进程 | 同进程加载 |
| 协议 | 标准 MCP 协议 | OpenCode Plugin API |
| 跨工具复用 | 可用于任何 MCP 客户端 | 仅限 OpenCode |
| 能力范围 | 工具 + 资源 | 工具 + 钩子 + 认证 |
| 生命周期 | 独立管理 | 随 OpenCode 启停 |
| 语言限制 | 任何语言 | TypeScript/JavaScript |

### 21.4.3 OAuth 认证支持

远程 MCP 服务器支持 OAuth 2.0 认证，包括动态客户端注册（RFC 7591）：

```typescript
export const McpOAuth = z.object({
  clientId: z.string().optional(),      // 可选，支持动态注册
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
})
```

## 21.5 社区贡献指南

### 21.5.1 Plugin 开发流程

```bash
# 1. 初始化插件项目
mkdir my-opencode-plugin && cd my-opencode-plugin
bun init

# 2. 安装 Plugin SDK
bun add @opencode-ai/plugin

# 3. 创建插件入口
cat > src/index.ts << 'EOF'
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      my_tool: tool({
        description: "My custom tool",
        args: {
          input: tool.schema.string().describe("Input text"),
        },
        async execute(args) {
          return `Processed: ${args.input}`
        },
      }),
    },
  }
}
EOF

# 4. 本地测试
# 在 opencode.json 中添加：
# { "plugin": ["file:///path/to/my-opencode-plugin/src/index.ts"] }
```

### 21.5.2 插件加载机制

OpenCode 的插件加载支持两种来源：npm 包和本地文件。

> **源码位置**：`packages/opencode/src/plugin/index.ts`

```typescript
export namespace Plugin {
  const BUILTIN = ["opencode-anthropic-auth@0.0.13"]

  // 内置插件（直接 import）
  const INTERNAL_PLUGINS: PluginInstance[] = [
    CodexAuthPlugin,      // OpenAI Codex 认证
    CopilotAuthPlugin,    // GitHub Copilot 认证
    GitlabAuthPlugin,     // GitLab 认证
  ]

  // 加载外部插件
  for (let plugin of plugins) {
    if (!plugin.startsWith("file://")) {
      // npm 包：通过 BunProc.install 安装
      const pkg = plugin.substring(0, plugin.lastIndexOf("@"))
      const version = plugin.substring(plugin.lastIndexOf("@") + 1)
      plugin = await BunProc.install(pkg, version)
    }
    // 动态 import 加载
    const mod = await import(plugin)
    const seen = new Set<PluginInstance>()
    for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
      if (seen.has(fn)) continue  // 去重：同一函数的 named + default export
      seen.add(fn)
      hooks.push(await fn(input))
    }
  }
}
```

### 21.5.3 钩子触发机制

插件的钩子按注册顺序依次执行，后加载的插件可以修改前一个插件的输出：

```typescript
export async function trigger<Name extends keyof Hooks>(
  name: Name,
  input: Input,
  output: Output,
): Promise<Output> {
  for (const hook of await state().then((x) => x.hooks)) {
    const fn = hook[name]
    if (!fn) continue
    await fn(input, output)  // 链式调用，output 可被修改
  }
  return output
}
```

### 21.5.4 认证插件开发

认证插件是 OpenCode 生态的重要组成部分，支持 OAuth 和 API Key 两种模式：

```typescript
export type AuthHook = {
  provider: string
  methods: (
    | {
        type: "oauth"
        label: string
        prompts?: Array<{ type: "text"; key: string; message: string }>
        authorize(inputs?: Record<string, string>): Promise<AuthOauthResult>
      }
    | {
        type: "api"
        label: string
        authorize?(inputs?: Record<string, string>): Promise<{
          type: "success"; key: string
        } | { type: "failed" }>
      }
  )[]
}
```

## 21.6 实战：发布一个 OpenCode 插件

### 步骤一：创建带钩子的完整插件

```typescript
// my-plugin/src/index.ts
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async (ctx) => {
  console.log(`Plugin loaded for project: ${ctx.project.name}`)

  return {
    // 自定义工具
    tool: {
      check_style: tool({
        description: "Check code style against team conventions",
        args: {
          file: tool.schema.string().describe("File path to check"),
        },
        async execute(args, context) {
          const result = await ctx.$`eslint ${args.file} --format json`
          return result.text()
        },
      }),
    },

    // Shell 环境变量注入
    "shell.env": async (input, output) => {
      output.env.MY_CUSTOM_VAR = "hello"
    },

    // 工具执行后日志
    "tool.execute.after": async (input, output) => {
      console.log(`Tool ${input.tool} completed: ${output.title}`)
    },
  }
}
```

### 步骤二：配置 package.json

```json
{
  "name": "opencode-style-checker",
  "version": "1.0.0",
  "main": "src/index.ts",
  "dependencies": {
    "@opencode-ai/plugin": "latest"
  }
}
```

### 步骤三：本地测试

```json
// opencode.json
{
  "plugin": ["file:///home/user/my-plugin/src/index.ts"]
}
```

### 步骤四：发布到 npm

```bash
npm publish
```

### 步骤五：用户安装

```json
// opencode.json
{
  "plugin": ["opencode-style-checker@1.0.0"]
}
```

插件依赖会自动通过 Bun 安装到 `.opencode/node_modules/` 目录。

## 21.7 本章要点

- **四层扩展体系**：Agent/Command 配置（零代码）→ Skill 技能（Markdown）→ Plugin 插件（TypeScript）→ MCP 服务器（标准协议），覆盖从简单到复杂的所有扩展需求
- **Plugin SDK 设计简洁**：`tool()` 函数 + Zod schema 定义参数，`ToolContext` 提供 session、directory、abort 等上下文信息，支持权限请求
- **20+ 生命周期钩子**：涵盖消息处理、LLM 参数调整、工具执行前后、Shell 环境注入、权限拦截等，钩子按注册顺序链式执行
- **Skill 发现机制**兼容 Claude Code 的 `.claude/skills/` 目录，支持 URL 远程拉取和 `index.json` 索引，实现团队级共享
- **MCP 集成同时支持本地和远程模式**，远程模式支持 OAuth 2.0 认证和动态客户端注册，插件与 MCP 的选择取决于是否需要跨工具复用
