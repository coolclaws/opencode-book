# 第 8 章　执行与集成工具：Bash / Task / LSP

文件操作之外，AI 编程助手还需要执行 Shell 命令、委派子任务、以及与语言服务器交互。OpenCode 为这三类能力分别设计了 Bash、Task 和 LSP 工具。本章分析它们的实现，重点探讨 Bash 工具的安全边界和 Task 工具的子 Agent 委派机制。

## 8.1 Bash 工具：Shell 命令执行

> **源码位置**：packages/opencode/src/tool/bash.ts

Bash 工具是 OpenCode 中最强大也最危险的工具。它允许模型在用户机器上执行任意 Shell 命令，因此内置了多层安全防护。

### 8.1.1 参数定义

```typescript
parameters: z.object({
  command: z.string().describe("The command to execute"),
  timeout: z.number().describe("Optional timeout in milliseconds").optional(),
  workdir: z.string().describe("The working directory to run the command in").optional(),
  description: z.string().describe(
    "Clear, concise description of what this command does in 5-10 words."
  ),
})
```

`description` 参数是一个巧妙设计——强制模型用自然语言描述命令意图，既便于用户审批，也便于 UI 展示。

### 8.1.2 Tree-sitter 命令解析

Bash 工具不是简单地将命令丢给 Shell 执行。它首先使用 Tree-sitter 解析器对 Bash 命令进行语法分析：

```typescript
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  // 加载 tree-sitter-bash WASM 语法
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})
```

解析后遍历 AST 中所有 `command` 节点，提取命令名和参数。对于文件操作命令（`cd`、`rm`、`cp`、`mv`、`mkdir` 等），Bash 工具会解析路径参数并检查是否在项目目录之外：

```typescript
if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"].includes(command[0])) {
  for (const arg of command.slice(1)) {
    if (arg.startsWith("-")) continue
    const resolved = await fs.realpath(path.resolve(cwd, arg)).catch(() => "")
    if (resolved && !Instance.containsPath(normalized)) {
      directories.add(dir) // 标记为外部目录，需要额外权限
    }
  }
}
```

### 8.1.3 权限请求

命令解析后，Bash 工具会发起两类权限请求：

1. **外部目录权限**（`external_directory`）：当命令涉及项目目录之外的路径时触发
2. **命令执行权限**（`bash`）：每个非 `cd` 命令都需要用户授权

权限模式支持通配符记忆。例如用户批准 `git *` 后，后续所有 `git` 子命令自动放行。

### 8.1.4 超时与中止

```typescript
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
```

默认超时 2 分钟。超时或用户中止时，Bash 工具通过 `Shell.killTree()` 杀掉整个进程树（而非仅杀主进程），避免僵尸进程残留。

### 8.1.5 实时输出流

Bash 工具的输出不是等待命令结束后一次性返回，而是通过 `ctx.metadata()` 实时流式推送：

```typescript
const append = (chunk: Buffer) => {
  output += chunk.toString()
  ctx.metadata({
    metadata: {
      output: output.length > MAX_METADATA_LENGTH
        ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
      description: params.description,
    },
  })
}
proc.stdout?.on("data", append)
proc.stderr?.on("data", append)
```

元数据输出上限为 `MAX_METADATA_LENGTH = 30000` 字符，但这仅限制 UI 展示——完整输出仍会传递给模型（经过 Truncate 模块处理）。

## 8.2 Task 工具：子 Agent 委派

> **源码位置**：packages/opencode/src/tool/task.ts

Task 工具实现了多 Agent 协作。主 Agent 可以将子任务委派给专门的子 Agent 执行，每个子 Agent 运行在独立的 Session 中。

### 8.2.1 参数与 Agent 发现

```typescript
const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use"),
  task_id: z.string().describe("Pass a prior task_id to resume a previous task").optional(),
})
```

Task 工具在初始化时动态发现所有可用的子 Agent，并根据调用者的权限过滤不可访问的 Agent：

```typescript
const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))
const accessibleAgents = caller
  ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
  : agents
```

### 8.2.2 Session 创建与权限委派

每个子 Agent 任务运行在独立 Session 中。Task 工具在创建 Session 时会注入特定的权限规则：

```typescript
return await Session.create({
  parentID: ctx.sessionID,
  title: params.description + ` (@${agent.name} subagent)`,
  permission: [
    { permission: "todowrite", pattern: "*", action: "deny" },
    { permission: "todoread", pattern: "*", action: "deny" },
    // 如果子 Agent 没有 task 权限，禁止其递归创建子任务
    ...(hasTaskPermission ? [] : [
      { permission: "task", pattern: "*", action: "deny" },
    ]),
  ],
})
```

关键设计：子 Agent 默认被禁止使用 Todo 工具（防止污染主 Agent 的任务列表），也默认不能递归创建子任务（除非显式授权），避免无限递归。

### 8.2.3 任务恢复

通过 `task_id` 参数，Task 工具支持恢复之前的子 Agent 会话。这使得主 Agent 可以让子 Agent 继续未完成的工作，而非每次从头开始：

```typescript
if (params.task_id) {
  const found = await Session.get(params.task_id).catch(() => {})
  if (found) return found
}
```

## 8.3 LSP 工具：语言服务协议集成

> **源码位置**：packages/opencode/src/tool/lsp.ts

LSP 工具将语言服务器的能力暴露给 AI 模型，支持九种操作：

```typescript
const operations = [
  "goToDefinition",       // 跳转到定义
  "findReferences",       // 查找引用
  "hover",                // 悬停信息
  "documentSymbol",       // 文档符号
  "workspaceSymbol",      // 工作区符号
  "goToImplementation",   // 跳转到实现
  "prepareCallHierarchy", // 调用层次准备
  "incomingCalls",        // 入站调用
  "outgoingCalls",        // 出站调用
] as const
```

参数采用编辑器风格的 1-based 行号和列号，内部转换为 LSP 协议的 0-based 位置：

```typescript
const position = {
  file,
  line: args.line - 1,      // 转为 0-based
  character: args.character - 1,
}
```

LSP 工具目前是实验性功能，需要通过 `OPENCODE_EXPERIMENTAL_LSP_TOOL` 标志启用。相比之下，Claude Code 和 Cursor 都没有直接将 LSP 操作暴露为工具——它们在内部使用 LSP 但不允许模型主动调用。OpenCode 的做法让模型能够主动进行代码导航，更适合复杂的代码理解任务。

## 8.4 工具输出截断策略

> **源码位置**：packages/opencode/src/tool/truncation.ts

所有工具的输出都经过 `Truncate` 模块统一处理：

```typescript
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024 // 50 KB
```

截断支持两种方向：`head`（保留开头，默认）和 `tail`（保留末尾）。当输出被截断时，完整内容会保存到磁盘文件，并附上智能提示：

```typescript
const hint = hasTaskTool(agent)
  ? `Full output saved to: ${filepath}\nUse the Task tool to have explore agent process this file...`
  : `Full output saved to: ${filepath}\nUse Grep to search the full content or Read with offset/limit...`
```

如果当前 Agent 有权使用 Task 工具，提示会建议委派给探索型子 Agent 处理大输出，而非自己逐段读取。截断文件保留 7 天，由定时任务自动清理。

Bash 工具的元数据（用于 UI 展示）有独立的截断上限 `MAX_METADATA_LENGTH = 30000` 字符，与模型看到的输出截断相互独立。

## 8.5 实战：Bash 工具的安全边界分析

考虑以下命令：

```bash
cp /etc/passwd ~/backup/ && rm -rf /tmp/test
```

Bash 工具的 Tree-sitter 解析器会提取两个命令节点：

1. `cp /etc/passwd ~/backup/` — 解析出 `/etc/passwd`（外部路径）和 `~/backup/`（外部路径），触发 `external_directory` 权限请求
2. `rm -rf /tmp/test` — `-rf` 被识别为选项而跳过，`/tmp/test` 被解析为外部路径

安全流程：
1. 首先弹出外部目录权限请求，列出涉及的目录 `/etc`、`~/backup`、`/tmp`
2. 用户批准后，弹出命令执行权限请求，展示完整命令文本
3. 用户可以选择"一次允许"或"总是允许 cp *"

这种两阶段权限检查确保了：即使模型生成了危险命令，用户也能在执行前完整审查。与 Claude Code 的简单命令白名单相比，OpenCode 基于 AST 的分析更加精细——它能识别具体的路径参数，而非仅判断命令名是否安全。

## 8.6 本章要点

- **Bash 工具**使用 Tree-sitter 解析命令 AST，逐个识别命令名、参数和路径，实现细粒度的权限控制
- **Task 工具**实现了多 Agent 委派机制，子 Agent 运行在独立 Session 中，默认禁止递归创建子任务和操作 Todo
- **LSP 工具**将九种语言服务操作暴露给模型，支持代码导航和符号查找，是 OpenCode 相比竞品的差异化能力
- 所有工具输出经过统一截断处理（2000 行 / 50 KB），截断后的完整输出保存到磁盘供后续检索
- Bash 工具的安全模型包含命令解析、路径检测、两阶段权限请求、超时控制和进程树清理五个层次
