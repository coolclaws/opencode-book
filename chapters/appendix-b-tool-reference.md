# 附录 B：工具速查表

本附录列出 OpenCode 内置的所有工具（Tool），包括名称、功能描述、关键参数和权限级别。这些工具在 Agent 执行任务时被调用，是 OpenCode 与代码交互的核心能力。

## 文件操作类

| 工具名称 | 描述 | 关键参数 | 默认权限 |
|---------|------|---------|---------|
| **Read** | 读取文件内容，支持行范围、图片、PDF | `file_path`（必填）、`offset`、`limit`、`pages` | `allow` |
| **Edit** | 精确字符串替换编辑文件 | `file_path`、`old_string`、`new_string`、`replace_all` | `ask` |
| **Write** | 创建新文件或完整覆写 | `file_path`、`content` | `ask` |
| **MultiEdit** | 批量编辑，一次调用修改多处 | `file_path`、`edits[]` | `ask` |
| **Glob** | 按模式搜索文件路径 | `pattern`（必填）、`path` | `allow` |
| **Grep** | 基于 ripgrep 的内容搜索 | `pattern`（必填）、`path`、`glob`、`type`、`output_mode` | `allow` |
| **LS** / **List** | 列出目录内容 | `path` | `allow` |

## 命令执行类

| 工具名称 | 描述 | 关键参数 | 默认权限 |
|---------|------|---------|---------|
| **Bash** | 执行 Shell 命令 | `command`（必填）、`timeout`、`description` | `ask` |
| **Task** | 启动子 Agent 执行独立任务 | `description`（必填）、`agent` | `ask` |

## 知识管理类

| 工具名称 | 描述 | 关键参数 | 默认权限 |
|---------|------|---------|---------|
| **TodoWrite** | 管理任务清单 | `todos[]`（id、content、status） | `allow` |
| **TodoRead** | 读取当前任务清单 | 无参数 | `allow` |

## 网络类

| 工具名称 | 描述 | 关键参数 | 默认权限 |
|---------|------|---------|---------|
| **WebFetch** | 获取网页内容 | `url`（必填）、`format` | `ask` |
| **WebSearch** | 网络搜索 | `query`（必填） | `ask` |
| **CodeSearch** | 代码搜索 | `query`（必填） | `ask` |

## 语言服务类

| 工具名称 | 描述 | 关键参数 | 默认权限 |
|---------|------|---------|---------|
| **LSP** | 调用语言服务器能力 | `action`（diagnostics、references 等）、`file_path`、`position` | `allow` |

## 交互类

| 工具名称 | 描述 | 关键参数 | 默认权限 |
|---------|------|---------|---------|
| **Question** | 向用户提问获取输入 | `question`（必填） | `allow` |
| **Skill** | 调用已注册的 Skill | `name`（必填）、`args` | `ask` |

## 参数详解

### Read 工具

Read 工具是最常被调用的工具之一。源码中定义了几个关键的限制常量：

```typescript
// 文件: packages/opencode/src/tool/read.ts L15-19
const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
```

参数结构：

```typescript
// 文件: packages/opencode/src/tool/read.ts L23-27
parameters: z.object({
  filePath: z.string().describe("The absolute path to the file or directory to read"),
  offset: z.coerce.number().describe("The line number to start reading from (1-indexed)").optional(),
  limit: z.coerce.number().describe("The maximum number of lines to read (defaults to 2000)").optional(),
})
```

**特殊能力**：
- 支持读取图片文件（PNG、JPG 等），以多模态方式呈现给 LLM
- 支持读取 PDF 文件，大文件需指定 `pages` 参数
- 支持读取 Jupyter Notebook（`.ipynb`），返回所有 cell 及输出
- 超过 2000 字符的行自动截断
- 对 `.env` 文件的读取默认需要用户确认（`ask` 权限），防止意外泄露敏感信息
- 如果路径是目录，会自动退化为目录列表操作

### Edit 工具

```typescript
{
  file_path: string     // 绝对路径（必填）
  old_string: string    // 要替换的原始文本（必须在文件中唯一）
  new_string: string    // 替换后的文本
  replace_all?: boolean // 替换所有匹配项（默认 false）
}
```

**注意事项**：
- `old_string` 必须在文件中唯一匹配，否则失败
- 使用 `replace_all: true` 进行全局替换（如变量重命名）
- 编辑前需先使用 Read 工具读取文件
- 编辑操作会触发 Snapshot 创建，支持后续 undo/redo
- 编辑完成后会通过 `FileWatcher` 触发 LSP 诊断更新

### MultiEdit 工具

MultiEdit 是 Edit 的批量版本，允许在单次调用中对同一文件执行多处修改。参数为 `edits[]` 数组，每个元素包含 `old_string` 和 `new_string`。适用于需要同时修改多处相关代码的场景（如重构函数签名及其所有调用点）。

### ApplyPatch 工具

ApplyPatch 是一种替代 Edit/Write 的编辑方式，专为 GPT 系列模型设计。源码中的条件判断揭示了这一设计：

```typescript
// 文件: packages/opencode/src/tool/registry.ts L149-152
const usePatch =
  model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
if (t.id === "apply_patch") return usePatch
if (t.id === "edit" || t.id === "write") return !usePatch
```

当模型为 GPT 系列（非 GPT-4）时，系统自动启用 ApplyPatch 并禁用 Edit/Write，因为这些模型更适合生成 unified diff 格式的补丁。

### Grep 工具

```typescript
// 文件: packages/opencode/src/tool/grep.ts
{
  pattern: string          // 正则表达式（ripgrep 语法）
  path?: string            // 搜索路径（默认当前目录）
  glob?: string            // 文件模式过滤（如 "*.ts"）
  type?: string            // 文件类型（如 "js"、"py"）
  output_mode?: string     // "content" | "files_with_matches" | "count"
  context?: number         // 上下文行数（-C 参数）
  head_limit?: number      // 限制输出条目数
  multiline?: boolean      // 多行匹配模式
}
```

底层基于 ripgrep 实现，支持完整的正则表达式语法。`output_mode` 决定输出形式：`files_with_matches` 仅返回文件路径（默认），`content` 返回匹配行内容，`count` 返回匹配计数。

### Bash 工具

```typescript
// 文件: packages/opencode/src/tool/bash.ts L22
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
```

参数结构：

```typescript
{
  command: string          // Shell 命令（必填）
  timeout?: number         // 超时毫秒数（最大 600000，默认 120000）
  description?: string     // 命令描述（用于权限审核）
}
```

**安全限制**：
- 不支持交互式命令（`-i` 标志）
- 工作目录在调用之间会重置
- 可通过权限配置限制特定命令模式
- Bash 工具内置 Tree-sitter 解析器，用于从命令中提取可执行文件名称以进行更精确的权限匹配

### Task 工具

Task 工具是 Agent 协作的核心，它启动子 Agent 在独立环境中执行任务：

```typescript
// 文件: packages/opencode/src/tool/task.ts L15-26
const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z.string().describe(
    "This should only be set if you mean to resume a previous task"
  ).optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})
```

**行为**：
- 启动独立的子 Agent 会话，可指定 Agent 类型（explore、general 等）
- 子 Agent 的可用类型由父 Agent 的权限决定——通过 `Permission.evaluate("task", agentName)` 过滤
- 支持通过 `task_id` 恢复之前的 Task 会话
- 当配置启用 Worktree 时，每个 Task 在隔离的 Git worktree 中操作

### WebFetch 工具

```typescript
// 文件: packages/opencode/src/tool/webfetch.ts L7-9
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes
```

支持三种返回格式：`text`、`markdown`（默认）、`html`。使用 Turndown 库将 HTML 转换为 Markdown，便于 LLM 理解网页内容。URL 必须以 `http://` 或 `https://` 开头。

### WebSearch 与 CodeSearch 工具

两者底层均调用 Exa 的 MCP 接口（`https://mcp.exa.ai/mcp`）。WebSearch 执行通用网络搜索，CodeSearch 专注于代码搜索。这两个工具仅在 OpenCode 官方 Provider 或显式启用 `OPENCODE_ENABLE_EXA` 标志时可用。

### LSP 工具

LSP 工具是实验性功能（需设置 `OPENCODE_EXPERIMENTAL_LSP_TOOL` 标志），支持以下操作：

```typescript
// 文件: packages/opencode/src/tool/lsp.ts L11-21
const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const
```

### Batch 工具

Batch 工具也是实验性功能（需在配置中设置 `experimental.batch_tool: true`），允许在单次调用中并行执行多个工具。最多支持 25 个并行调用，超出部分会被丢弃。不允许嵌套调用自身。

### Question 工具

Question 工具允许 Agent 向用户提出结构化问题。仅在 `app`、`cli`、`desktop` 客户端或显式启用 `OPENCODE_ENABLE_QUESTION_TOOL` 时可用。Agent 的默认权限配置中，Question 的权限为 `deny`，需要显式开启。

### Skill 工具

Skill 工具加载预定义的指令集（Skill），为 Agent 注入领域特定的知识和工作流：

```typescript
// 文件: packages/opencode/src/tool/skill.ts L9-10
export const SkillTool = Tool.define("skill", async (ctx) => {
  const list = await Skill.available(ctx?.agent)
```

加载后的 Skill 内容以 `<skill_content name="...">` 标签注入对话上下文。

## 工具注册机制

所有内置工具通过 `ToolRegistry` 统一管理。注册表在 `registry.ts` 中定义了工具的加载顺序和条件过滤逻辑。自定义工具可以通过两种方式注册：

1. **文件约定**：将 `.js` 或 `.ts` 文件放置在项目的 `tool/` 或 `tools/` 目录下，系统自动扫描加载
2. **Plugin API**：通过 `@opencode-ai/plugin` 包的 `ToolDefinition` 接口注册

所有工具的输出都经过 `Truncate.output()` 处理，防止超长输出消耗过多 Token。

## 权限级别说明

| 级别 | 行为 | 适用场景 |
|------|------|---------|
| `allow` | 自动执行，无需确认 | 只读操作（Read、Glob、Grep） |
| `ask` | 每次执行前请求用户确认 | 写操作（Edit、Write、Bash） |
| `deny` | 完全禁止执行 | 安全限制（如禁止 rm） |

权限可在多个层级配置：

```
全局配置 < 项目配置 < Agent 配置 < 环境变量覆盖 < 企业管理配置
```

## 工具对比：OpenCode vs Claude Code vs Cursor

| 工具能力 | OpenCode | Claude Code | Cursor |
|---------|----------|-------------|--------|
| 文件读取 | Read（支持图片、PDF） | Read | 内置 |
| 文件编辑 | Edit + Write + MultiEdit | Edit + Write | 内置 |
| 搜索 | Glob + Grep（ripgrep） | Glob + Grep | 内置 |
| 命令执行 | Bash | Bash | 终端集成 |
| 子任务 | Task（子 Agent） | Task | 不支持 |
| 任务管理 | TodoWrite / TodoRead | TodoWrite / TodoRead | 不支持 |
| 网络获取 | WebFetch + WebSearch | WebFetch | 不支持 |
| LSP 集成 | LSP 工具 | 不支持 | IDE 原生 |
| MCP 工具 | 动态加载 | 动态加载 | 部分支持 |
| 权限粒度 | 路径模式匹配 | 会话级 | IDE 级 |
