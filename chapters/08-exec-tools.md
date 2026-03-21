# 第 8 章　执行与集成工具：Bash / Task / LSP

文件操作之外，AI 编程助手还需要执行 Shell 命令、委派子任务、以及与语言服务器交互。OpenCode 为这三类能力分别设计了 Bash、Task 和 LSP 工具。本章分析它们的实现，重点探讨 Bash 工具的安全边界和 Task 工具的子 Agent 委派机制。

## 8.1 Bash 工具：Shell 命令执行

> **源码位置**：packages/opencode/src/tool/bash.ts

Bash 工具是 OpenCode 中最强大也最危险的工具。它允许模型在用户机器上执行任意 Shell 命令，因此内置了多层安全防护。

### 8.1.1 参数定义

```typescript
// 文件: packages/opencode/src/tool/bash.ts L63-77
parameters: z.object({
  command: z.string().describe("The command to execute"),
  timeout: z.number().describe("Optional timeout in milliseconds").optional(),
  workdir: z.string().describe(
    `The working directory to run the command in. Defaults to ${Instance.directory}.`
  ).optional(),
  description: z.string().describe(
    "Clear, concise description of what this command does in 5-10 words."
  ),
})
```

`description` 参数是一个巧妙设计——强制模型用自然语言描述命令意图，既便于用户审批，也便于 UI 展示。

### 8.1.2 Shell 选择与黑名单

Bash 工具在初始化时通过 `Shell.acceptable()` 选择合适的 Shell。Shell 模块维护了一个不兼容 Shell 的黑名单：

```typescript
// 文件: packages/opencode/src/shell/shell.ts L42-72
const BLACKLIST = new Set(["fish", "nu"])

function fallback() {
  if (process.platform === "win32") {
    if (Flag.OPENCODE_GIT_BASH_PATH) return Flag.OPENCODE_GIT_BASH_PATH
    const git = which("git")
    if (git) {
      const bash = path.join(git, "..", "..", "bin", "bash.exe")
      if (Filesystem.stat(bash)?.size) return bash
    }
    return process.env.COMSPEC || "cmd.exe"
  }
  if (process.platform === "darwin") return "/bin/zsh"
  const bash = which("bash")
  if (bash) return bash
  return "/bin/sh"
}

export const acceptable = lazy(() => {
  const s = process.env.SHELL
  if (s && !BLACKLIST.has(process.platform === "win32" ? path.win32.basename(s) : path.basename(s))) return s
  return fallback()
})
```

Fish shell 和 Nushell 被列入黑名单，因为它们的语法与 POSIX sh 不兼容——模型生成的 Bash 命令在这些 Shell 中可能产生意外行为。Windows 平台上的回退逻辑尤其值得关注：它会尝试从 Git 安装目录中寻找 `bash.exe`，这是 Windows 上获取类 Unix Shell 的最可靠途径。

### 8.1.3 Tree-sitter 命令解析

Bash 工具不是简单地将命令丢给 Shell 执行。它首先使用 Tree-sitter 解析器对 Bash 命令进行语法分析：

```typescript
// 文件: packages/opencode/src/tool/bash.ts L33-52
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() { return treePath },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})
```

Tree-sitter 的加载采用了 WASM（WebAssembly）方式。`web-tree-sitter` 包本身是 Tree-sitter 的 C 实现编译到 WASM 的产物，而 `tree-sitter-bash` 语法也被编译为独立的 `.wasm` 文件。整个过程通过 `lazy()` 包装器确保只执行一次——首次调用 Bash 工具时完成初始化，后续调用直接复用已加载的解析器实例。

解析后遍历 AST 中所有 `command` 节点，提取命令名和参数。对于文件操作命令，Bash 工具会解析路径参数并检查是否在项目目录之外：

```typescript
// 文件: packages/opencode/src/tool/bash.ts L93-130
for (const node of tree.rootNode.descendantsOfType("command")) {
  if (!node) continue
  let commandText = node.parent?.type === "redirected_statement" ? node.parent.text : node.text
  const command = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type !== "command_name" && child.type !== "word" &&
        child.type !== "string" && child.type !== "raw_string" &&
        child.type !== "concatenation") continue
    command.push(child.text)
  }
  if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"].includes(command[0])) {
    for (const arg of command.slice(1)) {
      if (arg.startsWith("-") || (command[0] === "chmod" && arg.startsWith("+"))) continue
      const resolved = await fs.realpath(path.resolve(cwd, arg)).catch(() => "")
      if (resolved) {
        const normalized = process.platform === "win32"
          ? Filesystem.windowsPath(resolved).replace(/\//g, "\\") : resolved
        if (!Instance.containsPath(normalized)) {
          const dir = (await Filesystem.isDir(normalized)) ? normalized : path.dirname(normalized)
          directories.add(dir)
        }
      }
    }
  }
}
```

注意 `redirected_statement` 的处理——当命令包含重定向时（如 `echo "hello" > file.txt`），工具会取父节点的文本作为命令描述，确保权限请求中包含重定向信息。

### 8.1.4 命令前缀与权限粒度

权限请求的 `always` 字段使用 `BashArity.prefix()` 来确定命令前缀：

```typescript
// 文件: packages/opencode/src/permission/arity.ts L2-10
export function prefix(tokens: string[]) {
  for (let len = tokens.length; len > 0; len--) {
    const prefix = tokens.slice(0, len).join(" ")
    const arity = ARITY[prefix]
    if (arity !== undefined) return tokens.slice(0, arity)
  }
  if (tokens.length === 0) return []
  return tokens.slice(0, 1)
}
```

`ARITY` 字典定义了上百个常见命令的"人类可理解命令"粒度。例如 `git` 的 arity 是 2，所以 `git checkout main` 的前缀是 `git checkout`；`npm run` 的 arity 是 3，所以 `npm run dev` 的前缀是 `npm run dev`。用户批准 `git checkout *` 后，所有 `git checkout` 子命令自动放行，但 `git push` 仍需单独审批。

### 8.1.5 进程管理与超时

```typescript
// 文件: packages/opencode/src/tool/bash.ts L22
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
```

默认超时 2 分钟。进程通过 `detached: true`（非 Windows）创建，使其成为进程组的领导者。超时或用户中止时，`Shell.killTree()` 杀掉整个进程树：

```typescript
// 文件: packages/opencode/src/shell/shell.ts L12-41
export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
  const pid = proc.pid
  if (!pid || opts?.exited?.()) return
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore", windowsHide: true,
      })
      killer.once("exit", () => resolve())
      killer.once("error", () => resolve())
    })
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      process.kill(-pid, "SIGKILL")
    }
  } catch (_e) {
    proc.kill("SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) { proc.kill("SIGKILL") }
  }
}
```

Unix 上先发 `SIGTERM` 到进程组（`-pid`），等待 200ms 后若仍未退出则发 `SIGKILL`。Windows 上使用 `taskkill /f /t` 强制终止进程树。

### 8.1.6 实时输出流

Bash 工具的输出不是等待命令结束后一次性返回，而是通过 `ctx.metadata()` 实时流式推送：

```typescript
// 文件: packages/opencode/src/tool/bash.ts L189-198
const append = (chunk: Buffer) => {
  output += chunk.toString()
  ctx.metadata({
    metadata: {
      output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
      description: params.description,
    },
  })
}
proc.stdout?.on("data", append)
proc.stderr?.on("data", append)
```

元数据输出上限为 `MAX_METADATA_LENGTH = 30000` 字符，但这仅限制 UI 展示——完整输出仍会传递给模型（经过 Truncate 模块处理）。stdout 和 stderr 被合并到同一个 `output` 字符串中，顺序取决于操作系统的缓冲策略。

### 8.1.7 插件环境变量注入

执行命令前，Bash 工具通过 Plugin 系统的 `shell.env` 钩子允许插件注入自定义环境变量：

```typescript
// 文件: packages/opencode/src/tool/bash.ts L162-166
const shellEnv = await Plugin.trigger(
  "shell.env",
  { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
  { env: {} },
)
```

这使得插件可以为 Shell 命令设置认证 token、代理配置等环境变量，而不需要修改用户的全局环境。

## 8.2 Task 工具：子 Agent 委派

> **源码位置**：packages/opencode/src/tool/task.ts

Task 工具实现了多 Agent 协作。主 Agent 可以将子任务委派给专门的子 Agent 执行，每个子 Agent 运行在独立的 Session 中。

### 8.2.1 Agent 发现与权限过滤

Task 工具在初始化时动态发现所有可用的子 Agent，并根据调用者的权限过滤不可访问的 Agent：

```typescript
// 文件: packages/opencode/src/tool/task.ts L28-36
export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => Permission.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents
  const list = accessibleAgents.toSorted((a, b) => a.name.localeCompare(b.name))
  // ...
})
```

### 8.2.2 Session 创建与权限委派

每个子 Agent 任务运行在独立 Session 中，通过 `parentID` 字段与主 Session 建立父子关系。Task 工具在创建 Session 时注入特定的权限限制：

```typescript
// 文件: packages/opencode/src/tool/task.ts L74-103
return await Session.create({
  parentID: ctx.sessionID,
  title: params.description + ` (@${agent.name} subagent)`,
  permission: [
    { permission: "todowrite", pattern: "*", action: "deny" },
    { permission: "todoread", pattern: "*", action: "deny" },
    ...(hasTaskPermission ? [] : [
      { permission: "task" as const, pattern: "*" as const, action: "deny" as const },
    ]),
    ...(config.experimental?.primary_tools?.map((t) => ({
      pattern: "*", action: "allow" as const, permission: t,
    })) ?? []),
  ],
})
```

关键设计：子 Agent 默认被禁止使用 Todo 工具（防止污染主 Agent 的任务列表），也默认不能递归创建子任务（除非 Agent 定义中显式声明了 `task` 权限），避免无限递归。`config.experimental?.primary_tools` 允许配置文件指定某些工具在子 Agent 中自动授权，减少用户审批次数。

`parentID` 的链接不仅是元数据标记。Session 系统通过 `parentID` 构建完整的任务树结构。当主 Session 被终止时，`ctx.abort` 信号通过事件监听器传播到子 Session：

```typescript
// 文件: packages/opencode/src/tool/task.ts L123-127
function cancel() {
  SessionPrompt.cancel(session.id)
}
ctx.abort.addEventListener("abort", cancel)
using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
```

这里使用了 TC39 的 `using` 声明语法配合 `defer()` 工具，确保 abort 事件监听器在函数退出时被正确清理——即使函数因异常退出也不会泄漏监听器。

### 8.2.3 任务恢复

通过 `task_id` 参数，Task 工具支持恢复之前的子 Agent 会话：

```typescript
// 文件: packages/opencode/src/tool/task.ts L69-72
if (params.task_id) {
  const found = await Session.get(SessionID.make(params.task_id)).catch(() => {})
  if (found) return found
}
```

恢复机制对于长时间运行的任务尤为重要。子 Agent 可以在原有上下文基础上继续工作，无需重复之前的搜索过程。

## 8.3 LSP 工具：语言服务协议集成

> **源码位置**：packages/opencode/src/tool/lsp.ts

LSP 工具将语言服务器的能力暴露给 AI 模型，支持九种操作：

```typescript
// 文件: packages/opencode/src/tool/lsp.ts L11-21
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
// 文件: packages/opencode/src/tool/lsp.ts L42-46
const position = {
  file,
  line: args.line - 1,
  character: args.character - 1,
}
```

LSP 工具目前是实验性功能，需要通过 `OPENCODE_EXPERIMENTAL_LSP_TOOL` 标志启用。Claude Code 和 Cursor 都没有直接将 LSP 操作暴露为工具——它们在内部使用 LSP 来提供自动补全和错误诊断，但不允许模型主动调用。OpenCode 的做法让模型能够主动进行代码导航，调用层次分析（`incomingCalls` / `outgoingCalls`）更是纯文本搜索无法替代的能力。

## 8.4 工具输出截断策略

> **源码位置**：packages/opencode/src/tool/truncate.ts

所有工具的输出都经过 `Truncate` 模块统一处理。截断支持两种方向：`head`（保留开头，默认）和 `tail`（保留末尾）：

```typescript
// 文件: packages/opencode/src/tool/truncate.ts L17-18
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
```

当输出被截断时，完整内容会保存到磁盘文件，并附上智能提示。提示内容根据当前 Agent 是否有权使用 Task 工具而不同：

```typescript
// 文件: packages/opencode/src/tool/truncate.ts L109-111
const hint = hasTaskTool(agent)
  ? `Full output saved to: ${file}\nUse the Task tool to have explore agent process this file...`
  : `Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit...`
```

截断文件保存在系统临时目录下，通过 Effect 框架的 `Schedule.spaced(Duration.hours(1))` 每小时触发清理，删除超过 7 天（`Duration.days(7)`）的文件。

## 8.5 本章要点

- **Bash 工具**使用 Tree-sitter WASM 解析命令 AST，逐个识别命令名、参数和路径，实现细粒度的权限控制；Shell 选择通过黑名单机制排除 Fish/Nushell 等不兼容 Shell
- **BashArity** 字典定义了上百个命令的前缀粒度，使权限通配符能在合理的命令层级上工作（如 `git checkout *` 而非过于宽泛的 `git *`）
- **Task 工具**实现了多 Agent 委派机制，子 Agent 运行在通过 `parentID` 链接的独立 Session 中，默认禁止递归创建子任务和操作 Todo，支持通过 `task_id` 恢复先前会话
- **LSP 工具**将九种语言服务操作暴露给模型，是 OpenCode 相比竞品的差异化能力，目前标记为实验性
- 所有工具输出经过统一截断处理（2000 行 / 50 KB），截断后的完整输出保存到磁盘供后续检索，7 天后自动清理
