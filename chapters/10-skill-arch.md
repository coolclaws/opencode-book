# 第 10 章　Skill 架构与加载机制

在 AI 编码助手中，如何让模型获得特定领域的专业知识？Claude Code 引入了 CLAUDE.md 机制，而 OpenCode 则设计了更灵活的 **Skill 系统**——通过标准化的 `SKILL.md` 文件，将领域知识封装为可复用的"技能包"。本章将深入分析 Skill 的文件格式、多路径扫描机制和远程发现流程。

## 10.1 Skill 概念：SKILL.md 文件格式

Skill 的载体是一个名为 `SKILL.md` 的 Markdown 文件，它采用 YAML frontmatter + Markdown body 的结构：

```markdown
---
name: react-component
description: React 组件开发最佳实践
---

## 组件规范

- 使用函数式组件和 Hooks
- Props 必须定义 TypeScript 类型
- 文件命名采用 PascalCase
```

OpenCode 使用 Zod 定义了 Skill 的类型结构：

> **源码位置**：packages/opencode/src/skill/index.ts

```typescript
// 文件: packages/opencode/src/skill/index.ts L28-34
export const Info = z.object({
  name: z.string(),          // 技能名称，全局唯一标识
  description: z.string(),   // 技能描述，展示给用户和模型
  location: z.string(),      // SKILL.md 文件的绝对路径
  content: z.string(),       // Markdown body 内容（不含 frontmatter）
})
```

模块还定义了 `InvalidError` 和 `NameMismatchError` 两个错误类型，分别在缺少必填字段和名称不一致时触发。

### frontmatter 解析：gray-matter 与降级处理

frontmatter 的解析由 `ConfigMarkdown.parse` 完成，底层使用 `gray-matter` 库。gray-matter 是 Node.js 生态中最流行的 frontmatter 解析器，它将 Markdown 文件拆分为 `data`（YAML 对象）和 `content`（正文字符串）两部分。

然而在实际使用中，不同工具生成的 Markdown 文件常包含不符合严格 YAML 规范的内容。Claude Code 的 CLAUDE.md 文件中，description 字段有时包含未加引号的冒号，这在 YAML 中会被误解为键值对分隔符，导致解析失败。为此，OpenCode 实现了两阶段解析策略：

```typescript
// 文件: packages/opencode/src/config/markdown.ts L71-90
export async function parse(filePath: string) {
  const template = await Filesystem.readText(filePath)
  try {
    const md = matter(template)
    return md
  } catch {
    try {
      return matter(fallbackSanitization(template))
    } catch (err) {
      throw new FrontmatterError({
        path: filePath,
        message: `${filePath}: Failed to parse YAML frontmatter: ${...}`,
      }, { cause: err })
    }
  }
}
```

先尝试严格解析，失败后调用 `fallbackSanitization` 进行降级处理。降级逻辑逐行扫描 frontmatter，检测每个值中是否包含冒号，如果包含则将其改写为 YAML 的块标量语法（`|-`），将整个值视为纯文本：

```typescript
// 文件: packages/opencode/src/config/markdown.ts L58-60
if (value.includes(":")) {
  result.push(`${key}: |-`)
  result.push(`  ${value}`)
  continue
}
```

这段降级逻辑还会跳过注释行、空行、缩进的续行以及已经使用引号或块标量语法的值，避免对已经合法的 YAML 做不必要的改写。这使得 OpenCode 能够无缝读取 Claude Code 生态中已有的 SKILL.md 文件，大大降低了迁移成本。

## 10.2 多路径扫描机制

OpenCode 的 Skill 加载采用**多层级扫描**策略，从全局到项目逐层覆盖。整个扫描由 `load` 函数编排，通过 `scan` 辅助函数执行具体的 glob 匹配：

```typescript
// 文件: packages/opencode/src/skill/index.ts L23-26
const EXTERNAL_DIRS = [".claude", ".agents"]
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"
```

`EXTERNAL_DIRS` 兼容 Claude Code 和通用 Agent 生态的目录约定；`OPENCODE_SKILL_PATTERN` 同时支持单数 `skill` 和复数 `skills` 两种命名，减少因拼写差异导致加载失败的困惑。

`scan` 函数封装了 glob 匹配和错误处理逻辑：

```typescript
// 文件: packages/opencode/src/skill/index.ts L104-117
const scan = async (state: State, root: string, pattern: string,
    opts?: { dot?: boolean; scope?: string }) => {
  return Glob.scan(pattern, {
    cwd: root,
    absolute: true,
    include: "file",
    symlink: true,     // 跟随符号链接
    dot: opts?.dot,    // 是否匹配点号开头的目录
  })
    .then((matches) => Promise.all(matches.map((match) => add(state, match))))
    .catch((error) => {
      if (!opts?.scope) throw error
      log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
    })
}
```

`symlink: true` 允许通过符号链接引用 Skill 文件，方便团队共享。`scope` 参数决定错误处理行为：有 scope 的扫描错误只记录日志不中断流程，保证一个目录的失败不影响其他层级。

具体的扫描层级如下：

**第一层：全局目录（优先级最低）**

扫描 `~/.claude/skills/` 和 `~/.agents/skills/` 下的 SKILL.md 文件。这些是用户级别的全局技能。扫描前会通过 `Filesystem.isDir` 检查目录是否存在，避免对不存在的目录发起 glob 操作。整个外部 Skill 扫描受 `Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS` 环境变量控制——该标志继承自 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` 和 `OPENCODE_DISABLE_CLAUDE_CODE`，形成一个三级开关链，用户可以在不同粒度上禁用外部 Skill。

**第二层：项目级外部目录**

从当前项目目录向上遍历，在每一级查找 `.claude/` 和 `.agents/` 目录。通过 `Filesystem.up()` 实现向上递归：

```typescript
// 文件: packages/opencode/src/util/filesystem.ts L166-179
export async function* up(options: {
    targets: string[]; start: string; stop?: string }) {
  const { targets, start, stop } = options
  let current = start
  while (true) {
    for (const target of targets) {
      const search = join(current, target)
      if (await exists(search)) yield search
    }
    if (stop === current) break
    const parent = dirname(current)
    if (parent === current) break  // 到达文件系统根目录
    current = parent
  }
}
```

这个异步生成器有两个退出条件：到达 `stop` 指定的 worktree 边界，或到达文件系统根目录。止步于 worktree 根目录确保了 monorepo 中不同子项目的 Skill 相互隔离。

**第三层：OpenCode 配置目录**

通过 `Config.directories()` 获取 OpenCode 配置路径列表，然后扫描每个路径下的 `{skill,skills}/**/SKILL.md`。配置路径的搜集本身也使用 `Filesystem.up()` 向上遍历查找 `.opencode` 目录，加上全局配置目录 `Global.Path.config`，形成从全局到本地的配置链。

**第四层：自定义路径**

通过配置文件的 `skills.paths` 字段指定额外的扫描路径，支持 `~/` 家目录展开和相对路径解析。路径解析前会检查目录是否存在，不存在则输出警告日志并跳过：

```typescript
// 文件: packages/opencode/src/skill/index.ts L148-157
for (const item of cfg.skills?.paths ?? []) {
  const expanded = item.startsWith("~/")
    ? path.join(os.homedir(), item.slice(2)) : item
  const dir = path.isAbsolute(expanded)
    ? expanded : path.join(directory, expanded)
  if (!(await Filesystem.isDir(dir))) {
    log.warn("skill path not found", { path: dir })
    continue
  }
  await scan(state, dir, SKILL_PATTERN)
}
```

**第五层：远程 URL（优先级最高）**

通过 `skills.urls` 配置从远程服务器下载技能包。后加载的同名 Skill 覆盖先加载的，因此远程 Skill 拥有最高优先级。

完整的扫描优先级可用下图表示：

```text
┌─────────────────────────────────┐
│  远程 URL（优先级最高）          │
├─────────────────────────────────┤
│  自定义路径 skills.paths        │
├─────────────────────────────────┤
│  .opencode/{skill,skills}/      │
├─────────────────────────────────┤
│  项目级 .claude/.agents 向上遍历 │
├─────────────────────────────────┤
│  全局 ~/.claude/ ~/.agents/     │
│          （优先级最低）          │
└─────────────────────────────────┘
         ↓ 同名 Skill 后加载覆盖先加载
```

## 10.3 Skill 加载与解析

每个扫描到的 SKILL.md 文件都经过 `add` 函数处理。该函数完成解析、验证、重名检测和注册四个步骤：

```typescript
// 文件: packages/opencode/src/skill/index.ts L71-102
const add = async (state: State, match: string) => {
  const md = await ConfigMarkdown.parse(match).catch(async (err) => {
    const message = ConfigMarkdown.FrontmatterError.isInstance(err)
      ? err.data.message
      : `Failed to parse skill ${match}`
    const { Session } = await import("@/session")
    Bus.publish(Session.Event.Error, {
      error: new NamedError.Unknown({ message }).toObject()
    })
    log.error("failed to load skill", { skill: match, err })
    return undefined
  })
  if (!md) return

  const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
  if (!parsed.success) return

  if (state.skills[parsed.data.name]) {
    log.warn("duplicate skill name", {
      name: parsed.data.name,
      existing: state.skills[parsed.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[parsed.data.name] = {
    name: parsed.data.name,
    description: parsed.data.description,
    location: match,
    content: md.content,
  }
}
```

解析失败时的处理值得关注：错误通过 `Bus.publish` 发布到事件总线，UI 层可以捕获这些事件并展示给用户。同时 `Session` 模块通过动态 `import()` 延迟加载，避免在 Skill 模块初始化时引入循环依赖。验证阶段使用 Zod 的 `safeParse` 而非 `parse`，不合法的文件被静默跳过而不会抛出异常中断整个扫描流程。

`add` 函数还会将每个 SKILL.md 所在目录添加到 `state.dirs` 集合中。这个目录集合在后续的白名单机制中发挥关键作用——Agent 可以读取这些目录下的辅助文件（脚本、模板等）。

## 10.4 Effect 服务层与缓存机制

Skill 模块采用 Effect 框架的 `ServiceMap` 模式，通过 `InstanceState.make` 将 Skill 状态与当前 OpenCode 实例绑定——当用户切换项目目录时，实例状态重建，Skill 缓存自动失效并重新扫描。

缓存的核心是 `ensure` 函数，它实现了"惰性单例"模式：

```typescript
// 文件: packages/opencode/src/skill/index.ts L169-177
const ensure = () => {
  if (state.task) return state.task
  state.task = load().catch((err) => {
    state.task = undefined
    throw err
  })
  return state.task
}
```

首次调用 `ensure` 时触发 `load` 执行完整扫描，将返回的 Promise 缓存在 `state.task` 中。后续调用直接返回同一个 Promise，无需重复扫描。加载失败时 `task` 被重置为 `undefined`，下次调用会重新尝试。对于远程 Skill，`Discovery` 服务采用"存在即跳过"策略——文件一旦下载到 `~/.cache/opencode/skills/` 就不会重新下载，用户需手动删除缓存目录来获取最新版本。

## 10.5 远程 Skill 发现

> **源码位置**：packages/opencode/src/skill/discovery.ts

远程 Skill 通过 `Discovery.pull` 函数下载。Discovery 服务使用 Effect 的 `HttpClient` 抽象，并配置了 `withTransientReadRetry` 自动重试瞬时网络错误。远程服务器需提供 `index.json` 索引文件，其 Schema 定义如下：

```typescript
// 文件: packages/opencode/src/skill/discovery.ts L13-20
class IndexSkill extends Schema.Class<IndexSkill>("IndexSkill")({
  name: Schema.String,
  files: Schema.Array(Schema.String),
}) {}

class Index extends Schema.Class<Index>("Index")({
  skills: Schema.Array(IndexSkill),
}) {}
```

下载流程经过严格校验：首先过滤掉 `files` 列表中不包含 `SKILL.md` 的条目并发出警告；然后以 4 个 Skill 并发、每个 Skill 8 个文件并发的速率下载所有文件；最后验证本地目录中确实存在 `SKILL.md` 后才返回路径：

```typescript
// 文件: packages/opencode/src/skill/discovery.ts L76-80
const list = data.skills.filter((skill) => {
  if (!skill.files.includes("SKILL.md")) {
    log.warn("skill entry missing SKILL.md", { url: index, skill: skill.name })
    return false
  }
  return true
})
```

`download` 函数在目标文件已存在时直接返回 `true`，这就是"存在即跳过"的缓存策略。下载失败不会中断整个流程——单个文件的失败只记录错误日志，其余文件继续下载。

## 10.6 与 Claude Code CLAUDE.md 的对比

Claude Code 的 CLAUDE.md 采用 "always-injected" 模式：文件内容完整拼接到系统提示词中。OpenCode 则采用 "on-demand loading" 模式：仅 name 和 description 注入工具定义，完整内容只在模型主动请求时加载，节省上下文空间。OpenCode 通过兼容 `.claude/skills/` 目录结构，让用户可以同时享受两种生态的资源。

## 本章要点

- Skill 以 `SKILL.md` 文件为载体，使用 YAML frontmatter 定义 `name` 和 `description`，Markdown body 承载具体指令
- frontmatter 解析基于 gray-matter 库，配合 `fallbackSanitization` 降级逻辑兼容 Claude Code 等工具生成的非标准 YAML
- `Filesystem.up()` 异步生成器向上遍历止步于 worktree 根目录，确保 monorepo 和 git worktree 场景下的 Skill 隔离
- 多路径扫描遵循 **全局 → 项目级 → OpenCode 原生 → 自定义路径 → 远程 URL** 的加载顺序，后加载的同名 Skill 覆盖先加载的
- `scan` 函数通过 `symlink: true` 支持符号链接引用，`scope` 参数控制错误隔离级别
- Effect 的 `InstanceState` 将缓存与实例绑定，切换项目时自动失效；`ensure` 函数实现惰性单例加载
- 远程 Discovery 服务以 4+8 的并发度下载 Skill 文件，采用"存在即跳过"的缓存策略
- `OPENCODE_DISABLE_EXTERNAL_SKILLS` 环境变量提供三级开关链，可在不同粒度上禁用外部 Skill
