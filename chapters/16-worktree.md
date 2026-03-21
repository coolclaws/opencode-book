# 第 16 章　Git Worktree 隔离执行

AI 编码助手在修改代码时面临一个根本性挑战：如何在不破坏用户当前工作的情况下进行实验？OpenCode 通过 Git Worktree 机制实现了隔离执行环境，让 AI 可以在独立的工作副本中自由修改代码。本章分析这一机制的完整实现。

## 16.1 Git Worktree 技术原理

> **源码位置**：packages/opencode/src/worktree/index.ts

在深入 OpenCode 的实现之前，有必要理解 Git Worktree 本身的技术原理，以及它与更常见的 `git clone` 之间的关键差异。

`git clone` 会创建完整的仓库副本，包括整个 `.git` 目录。`git worktree add` 则采用完全不同的策略——创建的新工作目录**链接**到同一个 `.git` 仓库，所有 Git objects、reflog、分支引用都是共享的，几乎不消耗额外磁盘空间：

| 特性 | git clone | git worktree add |
|------|-----------|------------------|
| .git 数据 | 完整复制 | 共享，零拷贝 |
| 磁盘占用 | 仓库大小 x2 | 仅工作文件 |
| 创建速度 | 取决于仓库大小 | 几乎瞬时 |
| 分支同步 | 需要 push/pull | 实时共享 |

每个 worktree 拥有独立的 HEAD 指针、index（暂存区）和工作树，不同 worktree 之间的操作互不干扰。

Git 有一个重要的约束：不能在两个 worktree 中同时检出同一个分支。这是因为如果两个工作区同时修改同一个分支，提交历史会变得混乱。OpenCode 通过为每个 worktree 创建带有 `opencode/` 前缀的独立分支来规避这个限制，例如 `opencode/cosmic-falcon`。这个前缀不仅避免了与用户自己的分支冲突，也让 OpenCode 创建的分支在 `git branch` 列表中一目了然。

在日常开发中，用户可能正在编写代码、运行测试，此时如果 AI 直接修改文件，会造成冲突和困扰。Git Worktree 提供了优雅的解决方案：

- **并行开发**：AI 在独立的 worktree 中修改代码，用户继续在主工作区开发
- **安全实验**：修改可以随时丢弃，不影响主分支
- **独立环境**：每个 worktree 有自己的分支、文件状态和启动脚本

OpenCode 的 Worktree 模块封装了完整的创建、启动、重置和清理流程，通过事件总线通知状态变化：

```typescript
// 文件: packages/opencode/src/worktree/index.ts L22-36
export namespace Worktree {
  export const Event = {
    Ready: BusEvent.define("worktree.ready",
      z.object({ name: z.string(), branch: z.string() })),
    Failed: BusEvent.define("worktree.failed",
      z.object({ message: z.string() })),
  }
}
```

## 16.2 Worktree 的创建时机

OpenCode 并不会为每个会话自动创建 worktree。Worktree 的创建发生在明确的场景中：用户通过 `Worktree.create()` API 显式请求创建，或者控制平面（Control Plane）调用 `WorktreeAdaptor.configure()` 后触发 `create()`。

创建流程有一个前提条件：项目必须使用 Git 作为版本控制系统。如果 VCS 检测结果不是 Git，系统会抛出 `NotGitError`。这是一个合理的限制——worktree 是 Git 的原生特性，无法在 Mercurial 或 SVN 项目中使用。

值得注意的是，worktree 的 bootstrap 过程是异步执行的。`createFromInfo()` 函数立即返回 `Worktree.Info`（包含名称、分支和目录路径），然后在后台异步执行文件检出、Instance 初始化和启动脚本。这样设计是为了不阻塞调用者——用户或 AI 可以立即获得 worktree 的元信息，而耗时的初始化工作在后台完成，完成后通过 `Event.Ready` 事件通知。

## 16.3 Worktree 创建流程

### 趣味命名生成

每个 worktree 都有一个人类可读的唯一名称，由形容词+名词组合生成：

```typescript
// 文件: packages/opencode/src/worktree/index.ts L126-207
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

这种命名方式比 UUID 更易于辨识，29 x 31 = 899 种组合足以避免日常使用中的冲突。

### 候选名称验证

生成名称后，系统会验证目录和分支是否已存在：

```typescript
// 文件: packages/opencode/src/worktree/index.ts L270-288
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
// 文件: packages/opencode/src/worktree/index.ts L263-268
async function canonical(input: string) {
  const abs = path.resolve(input)
  const real = await fs.realpath(abs).catch(() => abs)
  const normalized = path.normalize(real)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}
```

Windows 上路径统一转为小写是为了避免大小写不敏感的文件系统上出现路径比较不一致的问题。macOS 虽然默认也是大小写不敏感的（APFS case-insensitive），但 OpenCode 在这里只对 Windows 做了处理，可能是考虑到 macOS 上用户极少遇到路径大小写混淆的问题。

## 16.4 Worktree 生命周期管理

Worktree 的完整生命周期包括五个阶段：创建、初始化（Bootstrap）、使用、重置和删除。理解这个生命周期有助于把握整个隔离执行机制的运作方式。

以下流程图展示了从用户请求到 AI 工作完成的完整流程：

```text
┌──────────────────────────────────────────────────────────────┐
│                   Worktree 完整生命周期                       │
└──────────────────────────────────────────────────────────────┘

用户请求创建 Worktree
     │
     ▼
┌─────────────────────┐
│ 生成唯一名称         │
│ adjective-noun       │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐     ┌──────────────────────┐
│ 验证目录和分支不存在  │────→│ 冲突？重试（最多 26 次）│
└─────────┬───────────┘     └──────────────────────┘
          │
          ▼
┌─────────────────────┐
│ git worktree add    │
│ --no-checkout       │
│ -b opencode/name    │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 返回 Worktree.Info  │← ─ ─ ─ 调用者立即获得元信息
└─────────┬───────────┘
          │ (异步 Bootstrap)
          ▼
┌─────────────────────┐
│ git reset --hard    │
│ 检出文件到工作目录    │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Instance.provide    │
│ 初始化项目实例       │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 发布 Event.Ready    │
│ 通知所有监听者       │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 执行启动脚本         │
│ 项目级 + 请求级      │
└─────────┬───────────┘
          │
          ▼
     AI 在隔离环境中工作
          │
     ┌────┴────┐
     ▼         ▼
  满意       不满意
     │         │
     ▼         ▼
  合并到     重置或删除
  主分支     worktree
```

### 创建阶段

创建阶段由 `makeWorktreeInfo()` 开始，调用 `candidate()` 生成唯一的名称、分支和目录路径，返回 `Worktree.Info` 对象。随后 `createFromInfo()` 执行实际的 Git 操作：

```typescript
// 文件: packages/opencode/src/worktree/index.ts L350-421
export async function createFromInfo(info: Info, startCommand?: string) {
  // 1. 创建 git worktree（不检出文件）
  const created = await git(
    ["worktree", "add", "--no-checkout", "-b", info.branch, info.directory],
    { cwd: Instance.worktree }
  )
  // 2. 注册沙箱目录
  await Project.addSandbox(Instance.project.id, info.directory)
  // 3. 返回一个启动函数，稍后异步执行
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

`--no-checkout` 标志避免了创建和 bootstrap 之间出现不完整的文件状态。`createFromInfo()` 返回启动函数而非直接执行，调用方可选择立即或延迟执行（通过 `setTimeout`），这种惰性求值给予上层更大灵活性。

### Bootstrap 阶段

Bootstrap 按顺序执行：`git reset --hard` 检出文件、`Instance.provide()` 初始化项目实例、发布 `Event.Ready` 事件、执行启动脚本。每个步骤都有独立的错误处理——失败时发布 `Event.Failed` 事件并提前返回，确保上层总能知道 worktree 状态。

### 使用阶段

一旦 worktree 就绪，AI 就在这个隔离目录中工作。它可以自由地创建、修改和删除文件，运行测试，甚至执行破坏性操作——所有这些都不会影响用户的主工作区。每个 worktree 拥有自己的 Git 分支，AI 的所有提交都记录在这个独立的分支上。

## 16.5 启动命令执行

Worktree 创建后，需要初始化运行环境。OpenCode 支持两级启动命令：

```typescript
// 文件: packages/opencode/src/worktree/index.ts L314-324
async function runStartScripts(
  directory: string,
  input: { projectID: ProjectID; extra?: string }
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

启动命令在 worktree 目录中通过 `bash -lc`（或 Windows 的 `cmd /c`）执行，使用登录 shell 确保加载完整的环境变量（如 `nvm`、`pyenv` 等版本管理器的路径配置）。第一级命令来自项目配置，通常是依赖安装类的命令（如 `npm install` 或 `pip install -r requirements.txt`）；第二级命令由用户在创建 worktree 时指定，可以是任何额外的初始化逻辑。如果第一级命令执行失败，第二级命令不会执行——这是一个有意为之的设计，因为如果依赖安装都失败了，后续的初始化大概率也无法成功。

## 16.6 并行任务与冲突避免

Worktree 隔离机制的核心价值在于支持并行任务而不产生冲突。理解这一点需要从三个层次分析：

**跨 worktree 隔离**：每个 worktree 拥有独立分支，多个 AI 任务可同时在不同 worktree 中修改同一个文件，各自在自己的分支上提交互不干扰。

**worktree 内部安全**：在单个 worktree 内部，文件级别的写锁（`FileTime.withLock`）防止了并发写入同一文件的竞态条件。这一层保护确保即使 worktree 内部有多个异步操作同时运行，文件系统操作也是安全的。

**延迟冲突策略**：冲突只会在合并时才可能出现——当用户决定将某个 worktree 的修改合并回主分支时，Git 的标准合并机制会处理可能的冲突。这个时机是用户明确控制的，不会在 AI 工作过程中突然出现令人困惑的冲突提示。这种"延迟冲突"策略是隔离执行的核心设计理念：让 AI 在完全自由的环境中工作，将冲突解决推迟到用户审查阶段。

## 16.7 清理与重置

### 删除 Worktree

删除操作处理了多种边界情况：停止 fsmonitor 守护进程、强制移除 worktree、清理分支：

```typescript
// 文件: packages/opencode/src/worktree/index.ts L434-530
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

删除顺序经过精心设计：先停止 fsmonitor（避免文件占用导致删除失败），再 `--force` 移除 worktree（处理未提交修改），然后删除残留目录（配置 5 次重试处理暂时性锁定），最后清理 Git 分支。

### 重置 Worktree

重置操作将 worktree 恢复到远程默认分支的状态，包括完整的子模块处理：

```typescript
// 文件: packages/opencode/src/worktree/index.ts L532-671
export const reset = fn(ResetInput, async (input) => {
  // 安全检查：不允许重置主工作区
  const directory = await canonical(input.directory)
  const primary = await canonical(Instance.worktree)
  if (directory === primary) {
    throw new ResetFailedError({ message: "Cannot reset the primary workspace" })
  }

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

安全检查首先验证目标不是主工作区。重置目标选择有优先级链：远程 HEAD（通常 `origin/main`）→ 本地 main/master。`sweep` 函数实现智能两阶段清理：第一次 `git clean -ffdx` 失败后，解析输出找到无法删除的文件，手动删除再重试。最后通过 `git status --porcelain=v1`（显式禁用 fsmonitor 避免缓存不一致）验证工作区干净，有残留则抛出 `ResetFailedError`。

## 16.8 与 Claude Code 的 Worktree 方案对比

Claude Code 同样支持在隔离分支中工作，但实现方式不同：

| 特性 | OpenCode | Claude Code |
|------|----------|-------------|
| 命名方式 | 形容词+名词组合（如 cosmic-falcon） | 基于任务描述 |
| 启动脚本 | 支持项目级和请求级双层命令 | 无内置支持 |
| 子模块处理 | 完整的 recursive 更新和清理 | 基础支持 |
| 事件通知 | 通过 Bus 发布 Ready/Failed 事件 | 无事件系统 |
| 路径处理 | 跨平台 canonical 规范化 | Linux/macOS 优先 |

OpenCode 的实现更注重工业级的健壮性，特别是在清理和重置流程中对边界情况的处理。

## 16.9 实战：使用 Worktree 进行隔离实验

用户可以通过 API 创建一个隔离的工作环境来测试 AI 的代码修改：

```typescript
// 文件: packages/opencode/src/worktree/index.ts L423-432
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

## 16.10 本章要点

- Git Worktree 与 clone 的本质区别在于共享 vs 复制 `.git` 数据库，worktree 创建几乎零开销且分支信息实时共享
- 每个 worktree 有独立的 HEAD、index 和工作树，通过 `opencode/` 前缀的独立分支规避 Git 的同分支检出限制
- OpenCode 在显式请求时创建 worktree，仅支持 Git 项目，bootstrap 异步执行不阻塞调用者
- 趣味命名（形容词+名词）生成可读的唯一标识，分支使用 `opencode/` 前缀避免冲突，最多 26 次重试
- 生命周期五阶段：创建 → bootstrap → 使用 → 重置/删除，每个阶段都有细粒度的错误处理和事件通知
- 支持双层启动命令（项目级 + 请求级），确保 worktree 环境就绪
- 并行任务通过分支隔离避免冲突，文件级写锁保证 worktree 内部安全，冲突延迟到合并时处理
- 清理和重置流程处理了 fsmonitor、子模块、符号链接、只读文件等边界情况，重置后强制验证工作区干净
- 通过事件总线发布 Ready/Failed 事件，UI 层可实时响应 worktree 状态变化
