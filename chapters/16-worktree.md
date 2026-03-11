# 第 16 章　Git Worktree 隔离执行

AI 编码助手在修改代码时面临一个根本性挑战：如何在不破坏用户当前工作的情况下进行实验？OpenCode 通过 Git Worktree 机制实现了隔离执行环境，让 AI 可以在独立的工作副本中自由修改代码。本章分析这一机制的完整实现。

## 16.1 为什么需要 Worktree 隔离

> **源码位置**：packages/opencode/src/worktree/index.ts

在日常开发中，用户可能正在编写代码、运行测试，此时如果 AI 直接修改文件，会造成冲突和困扰。Git Worktree 提供了优雅的解决方案：

- **并行开发**：AI 在独立的 worktree 中修改代码，用户继续在主工作区开发
- **安全实验**：修改可以随时丢弃，不影响主分支
- **独立环境**：每个 worktree 有自己的分支、文件状态和启动脚本

OpenCode 的 Worktree 模块封装了完整的创建、启动、重置和清理流程，通过事件总线通知状态变化：

```typescript
export namespace Worktree {
  export const Event = {
    Ready: BusEvent.define("worktree.ready",
      z.object({ name: z.string(), branch: z.string() })),
    Failed: BusEvent.define("worktree.failed",
      z.object({ message: z.string() })),
  }
}
```

## 16.2 Worktree 创建流程

### 趣味命名生成

每个 worktree 都有一个人类可读的唯一名称，由形容词+名词组合生成：

```typescript
const ADJECTIVES = [
  "brave", "calm", "clever", "cosmic", "crisp", "curious",
  "eager", "gentle", "glowing", "happy", "hidden", "jolly",
  // ... 共 29 个
] as const

const NOUNS = [
  "cabin", "cactus", "canyon", "circuit", "comet", "eagle",
  "engine", "falcon", "forest", "garden", "harbor", "island",
  // ... 共 31 个
] as const

function randomName() {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`
  // 如 "cosmic-falcon"、"brave-wizard"
}
```

这种命名方式比 UUID 更易于辨识，29 × 31 = 899 种组合足以避免日常使用中的冲突。

### 候选名称验证

生成名称后，系统会验证目录和分支是否已存在：

```typescript
async function candidate(root: string, base?: string) {
  for (const attempt of Array.from({ length: 26 }, (_, i) => i)) {
    const name = base
      ? (attempt === 0 ? base : `${base}-${randomName()}`)
      : randomName()
    const branch = `opencode/${name}`
    const directory = path.join(root, name)

    if (await exists(directory)) continue  // 目录已存在，跳过

    // 检查分支是否已存在
    const ref = `refs/heads/${branch}`
    const branchCheck = await git(
      ["show-ref", "--verify", "--quiet", ref],
      { cwd: Instance.worktree }
    )
    if (branchCheck.exitCode === 0) continue  // 分支已存在，跳过

    return Info.parse({ name, branch, directory })
  }
  throw new NameGenerationFailedError({
    message: "Failed to generate a unique worktree name"
  })
}
```

最多尝试 26 次，每个分支名称都带有 `opencode/` 前缀以避免与用户分支冲突。如果用户指定了自定义名称，第一次直接使用，之后追加随机后缀。

### 路径规范化

为了处理符号链接和跨平台路径差异，所有路径都经过规范化处理：

```typescript
async function canonical(input: string) {
  const abs = path.resolve(input)
  const real = await fs.realpath(abs).catch(() => abs)
  const normalized = path.normalize(real)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}
```

## 16.3 启动命令执行

Worktree 创建后，需要初始化运行环境。OpenCode 支持两级启动命令：

```typescript
async function runStartScripts(
  directory: string,
  input: { projectID: string; extra?: string }
) {
  // 第一级：项目配置中的 start 命令（如 npm install）
  const row = Database.use((db) =>
    db.select().from(ProjectTable).where(eq(ProjectTable.id, input.projectID)).get()
  )
  const project = row ? Project.fromRow(row) : undefined
  const startup = project?.commands?.start?.trim() ?? ""
  const ok = await runStartScript(directory, startup, "project")
  if (!ok) return false

  // 第二级：用户请求时指定的额外命令
  const extra = input.extra ?? ""
  await runStartScript(directory, extra, "worktree")
  return true
}
```

启动命令在 worktree 目录中通过 `bash -lc`（或 Windows 的 `cmd /c`）执行，使用登录 shell 确保加载完整的环境变量。整个创建流程通过异步方式执行，不阻塞主线程：

```typescript
export async function createFromInfo(info: Info, startCommand?: string) {
  // 1. 创建 git worktree（不检出文件）
  const created = await git(
    ["worktree", "add", "--no-checkout", "-b", info.branch, info.directory],
    { cwd: Instance.worktree }
  )
  // 2. 返回一个启动函数，稍后异步执行
  return () => {
    const start = async () => {
      // 检出文件
      await git(["reset", "--hard"], { cwd: info.directory })
      // 引导 Instance
      await Instance.provide({ directory: info.directory, init: InstanceBootstrap, fn: () => undefined })
      // 发布就绪事件
      GlobalBus.emit("event", {
        directory: info.directory,
        payload: { type: Event.Ready.type, properties: { name: info.name, branch: info.branch } },
      })
      // 执行启动脚本
      await runStartScripts(info.directory, { projectID, extra })
    }
    return start()
  }
}
```

## 16.4 清理与重置

### 删除 Worktree

删除操作处理了多种边界情况：停止 fsmonitor 守护进程、强制移除 worktree、清理分支：

```typescript
export const remove = fn(RemoveInput, async (input) => {
  const directory = await canonical(input.directory)
  // 1. 列出所有 worktree，定位目标
  const list = await git(["worktree", "list", "--porcelain"], { cwd: Instance.worktree })
  const entry = await locate(list.stdout)

  // 2. 停止 fsmonitor 守护进程
  await git(["fsmonitor--daemon", "stop"], { cwd: entry.path })

  // 3. 强制移除 worktree
  await git(["worktree", "remove", "--force", entry.path], { cwd: Instance.worktree })

  // 4. 清理残留文件
  await fs.rm(entry.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

  // 5. 删除对应分支
  const branch = entry.branch?.replace(/^refs\/heads\//, "")
  if (branch) await git(["branch", "-D", branch], { cwd: Instance.worktree })
  return true
})
```

### 重置 Worktree

重置操作将 worktree 恢复到远程默认分支的状态，包括完整的子模块处理：

```typescript
export const reset = fn(ResetInput, async (input) => {
  // 确定重置目标：优先使用远程 HEAD，回退到 main/master
  const target = remoteBranch ? `${remote}/${remoteBranch}` : localBranch

  // 拉取最新代码
  if (remoteBranch) await git(["fetch", remote, remoteBranch], { cwd: Instance.worktree })

  // 硬重置到目标
  await git(["reset", "--hard", target], { cwd: worktreePath })

  // 深度清理（处理顽固文件）
  const clean = await sweep(worktreePath)

  // 子模块更新和清理
  await git(["submodule", "update", "--init", "--recursive", "--force"], { cwd: worktreePath })
  await git(["submodule", "foreach", "--recursive", "git", "reset", "--hard"], { cwd: worktreePath })
  await git(["submodule", "foreach", "--recursive", "git", "clean", "-fdx"], { cwd: worktreePath })

  // 验证工作区干净
  const status = await git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: worktreePath })
  if (outputText(status.stdout)) throw new ResetFailedError({ message: "Worktree reset left local changes" })
})
```

`sweep` 函数是一个智能清理工具：如果第一次 `git clean` 失败，它会解析输出找到无法删除的文件，手动删除后重试。

## 16.5 与 Claude Code 的 Worktree 方案对比

Claude Code 同样支持在隔离分支中工作，但实现方式不同：

| 特性 | OpenCode | Claude Code |
|------|----------|-------------|
| 命名方式 | 形容词+名词组合（如 cosmic-falcon） | 基于任务描述 |
| 启动脚本 | 支持项目级和请求级双层命令 | 无内置支持 |
| 子模块处理 | 完整的 recursive 更新和清理 | 基础支持 |
| 事件通知 | 通过 Bus 发布 Ready/Failed 事件 | 无事件系统 |
| 路径处理 | 跨平台 canonical 规范化 | Linux/macOS 优先 |

OpenCode 的实现更注重工业级的健壮性，特别是在清理和重置流程中对边界情况的处理。

## 16.6 实战：使用 Worktree 进行隔离实验

用户可以通过 API 创建一个隔离的工作环境来测试 AI 的代码修改：

```typescript
// 创建 worktree（可选自定义名称和启动命令）
const info = await Worktree.create({
  name: "refactor-auth",            // 可选：自定义名称
  startCommand: "npm install",       // 可选：创建后运行的命令
})
// 返回 { name: "refactor-auth", branch: "opencode/refactor-auth", directory: "/path/to/worktree" }

// AI 在 worktree 中进行修改...

// 如果满意，合并修改；如果不满意，重置或删除
await Worktree.reset({ directory: info.directory })  // 重置到默认分支
await Worktree.remove({ directory: info.directory })  // 彻底删除
```

整个过程用户的主工作区不受影响，可以继续编写代码和运行测试。

## 16.7 本章要点

- Git Worktree 提供隔离执行环境，AI 修改代码不影响用户当前工作
- 趣味命名（形容词+名词）生成可读的唯一标识，最多 26 次重试避免冲突
- 支持双层启动命令（项目级 + 请求级），确保 worktree 环境就绪
- 清理和重置流程处理了 fsmonitor、子模块、符号链接等边界情况
- 通过事件总线发布 Ready/Failed 事件，UI 层可实时响应 worktree 状态变化
