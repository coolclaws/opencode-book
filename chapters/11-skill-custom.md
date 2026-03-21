# 第 11 章　内置 Skill 与自定义扩展

上一章介绍了 Skill 的文件格式和加载机制。本章将深入 Skill 与 Agent 的交互方式、Skill 工具的执行流程，以及如何构建可在团队间共享的 Skill 库。

## 11.1 SkillTool：Skill 的运行时入口

OpenCode 本身不硬编码任何内置 Skill——所有 Skill 均通过文件系统或远程 URL 动态加载。这与 Claude Code 将部分规则写死在代码中的做法形成对比。OpenCode 提供了 `SkillTool` 作为 Skill 系统的运行时入口：

> **源码位置**：packages/opencode/src/tool/skill.ts

```typescript
// 文件: packages/opencode/src/tool/skill.ts L9-28
export const SkillTool = Tool.define("skill", async (ctx) => {
  const list = await Skill.available(ctx?.agent)

  const description =
    list.length === 0
      ? "Load a specialized skill that provides domain-specific " +
        "instructions and workflows. No skills are currently available."
      : [
          "Load a specialized skill that provides domain-specific " +
            "instructions and workflows.",
          "",
          "When you recognize that a task matches one of the available " +
            "skills listed below, use this tool to load the full " +
            "skill instructions.",
          "",
          Skill.fmt(list, { verbose: false }),
        ].join("\n")

  return { description, parameters, async execute(params, ctx) { /* ... */ } }
})
```

`SkillTool` 的定义函数是异步的——它在 Agent 初始化时被调用，此时会根据当前 Agent 的权限过滤可用 Skill 列表，并将列表嵌入到工具描述中。当没有任何 Skill 可用时，工具描述会明确告知模型 "No skills are currently available"，避免不必要的调用尝试。

工具的参数定义也值得注意：`name` 参数的描述中嵌入了最多 3 个 Skill 名称作为示例，帮助模型理解参数格式：

```typescript
// 文件: packages/opencode/src/tool/skill.ts L30-38
const examples = list
  .map((skill) => `'${skill.name}'`)
  .slice(0, 3)
  .join(", ")
const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ""

const parameters = z.object({
  name: z.string().describe(`The name of the skill from available_skills${hint}`),
})
```

## 11.2 Skill 列表的双模式格式化

Skill 列表的展示由 `Skill.fmt()` 函数控制，它支持两种输出模式：

```typescript
// 文件: packages/opencode/src/skill/index.ts L225-243
export function fmt(list: Info[], opts: { verbose: boolean }) {
  if (list.length === 0) return "No skills are currently available."

  if (opts.verbose) {
    return [
      "<available_skills>",
      ...list.flatMap((skill) => [
        "  <skill>",
        `    <name>${skill.name}</name>`,
        `    <description>${skill.description}</description>`,
        `    <location>${pathToFileURL(skill.location).href}</location>`,
        "  </skill>",
      ]),
      "</available_skills>",
    ].join("\n")
  }

  return ["## Available Skills",
    ...list.map((skill) => `- **${skill.name}**: ${skill.description}`)
  ].join("\n")
}
```

`verbose: true` 输出 XML 格式，包含名称、描述和文件位置。XML 的开闭标签提供明确边界，LLM 对这类结构化标签的识别非常稳定。`verbose: false` 输出简洁的 Markdown 列表，每个 Skill 一行。SkillTool 当前使用非详细模式——工具描述空间有限，Markdown 比 XML 更紧凑。

## 11.3 SkillTool 的执行生命周期

当模型决定调用某个 Skill 时，`execute` 函数启动一个四阶段的执行流程：

```text
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  名称查找     │ →  │  权限确认     │ →  │  文件扫描     │ →  │  组装输出     │
│  Skill.get() │    │  ctx.ask()   │    │  Ripgrep     │    │  XML 封装     │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

**第一步：名称查找**。从已解析的 Skill 注册表中查找目标 Skill。如果找不到，抛出错误并列出所有可用 Skill 名称，帮助模型纠正：

```typescript
// 文件: packages/opencode/src/tool/skill.ts L44-49
const skill = await Skill.get(params.name)
if (!skill) {
  const available = await Skill.all()
    .then((x) => x.map((skill) => skill.name).join(", "))
  throw new Error(
    `Skill "${params.name}" not found. Available skills: ${available || "none"}`)
}
```

**第二步：权限确认**。通过 `ctx.ask()` 向用户请求权限：

```typescript
// 文件: packages/opencode/src/tool/skill.ts L51-56
await ctx.ask({
  permission: "skill",
  patterns: [params.name],
  always: [params.name],
  metadata: {},
})
```

`patterns` 和 `always` 字段都设为 `[params.name]`，意味着用户一旦对某个 Skill 点击"始终允许"，后续调用同名 Skill 时不会再弹出确认对话框。这种持久化授权存储在用户的权限配置中，跨 Session 有效。

**第三步：文件扫描**。使用 Ripgrep 列出 Skill 目录下的关联文件（最多 10 个），让模型知道有哪些脚本和参考资料可用：

```typescript
// 文件: packages/opencode/src/tool/skill.ts L62-79
const limit = 10
const files = await iife(async () => {
  const arr = []
  for await (const file of Ripgrep.files({
    cwd: dir,
    follow: false,
    hidden: true,
    signal: ctx.abort,
  })) {
    if (file.includes("SKILL.md")) continue  // 排除 SKILL.md 本身
    arr.push(path.resolve(dir, file))
    if (arr.length >= limit) break           // 最多 10 个文件
  }
  return arr
}).then((f) => f.map((file) => `<file>${file}</file>`).join("\n"))
```

选择 Ripgrep 而非 `fs.readdir` 来列举文件，因为 Ripgrep 内置了对 `.gitignore` 规则的尊重——自动跳过 `node_modules/` 等被忽略的文件。`follow: false` 防止跟随符号链接避免循环，`hidden: true` 允许列出隐藏配置文件。10 个文件的上限防止 Skill 目录意外包含大量文件时注入过多信息。每个文件路径用 `<file>` 标签包裹，模型可以直接引用来读取内容。

**第四步：组装输出**。将 Skill 内容、基目录路径和文件列表封装为结构化输出：

```typescript
// 文件: packages/opencode/src/tool/skill.ts L81-98
return {
  title: `Loaded skill: ${skill.name}`,
  output: [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    `Base directory for this skill: ${base}`,
    "Relative paths in this skill (e.g., scripts/, reference/) " +
      "are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    files,
    "</skill_files>",
    "</skill_content>",
  ].join("\n"),
  metadata: { name: skill.name, dir },
}
```

输出采用 XML 包裹，`<skill_content>` 标签的 `name` 属性让模型可以在多次 Skill 调用后区分不同来源的内容。`Base directory` 提示让模型理解 Skill 中提及的相对路径应如何解析。`metadata` 字段中的 `dir` 路径可供 UI 层展示 Skill 的来源位置。

## 11.4 Skill 目录白名单机制

Skill 目录会被自动加入 Agent 的**白名单目录**。在 Agent 初始化时，所有已加载 Skill 的目录被注册为允许访问的外部路径：

> **源码位置**：packages/opencode/src/agent/agent.ts

```typescript
// 文件: packages/opencode/src/agent/agent.ts L55-56
const skillDirs = await Skill.dirs()
const whitelistedDirs = [Truncate.GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]
```

`Skill.dirs()` 返回所有已加载 Skill 的目录路径。拼接 `*` 通配符后加入白名单，Agent 可以读取 Skill 目录下的文件，但不能穿越到外部路径。这对远程 Skill 尤为重要——缓存在 `~/.cache/opencode/skills/` 下的远程 Skill 不在项目目录内，没有白名单机制 Agent 将无法读取其辅助文件。

## 11.5 Skill 权限过滤

不同 Agent 有不同的能力范围。例如 `explore` Agent 被限制为只读操作，它不应该访问需要写入权限的 Skill。OpenCode 通过权限规则实现了这种过滤：

```typescript
// 文件: packages/opencode/src/skill/index.ts L212-217
const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
  const cache = yield* ensure()
  const list = Object.values(cache.skills)
    .toSorted((a, b) => a.name.localeCompare(b.name))
  if (!agent) return list
  return list.filter((skill) =>
    Permission.evaluate("skill", skill.name, agent.permission)
      .action !== "deny")
})
```

注意 `available` 函数先按名称排序再过滤——排序保证了 Skill 列表在不同调用间的顺序一致性，避免因 JavaScript 对象属性枚举顺序的不确定性导致模型看到不同顺序的列表。

权限规则可以在配置中精确控制：

```json
{
  "permission": {
    "skill": {
      "*": "allow",
      "dangerous-deploy": "deny"
    }
  }
}
```

`Permission.evaluate` 先精确匹配 Skill 名称，找不到再匹配通配符 `*`，返回 `"allow"`、`"deny"` 或 `"ask"` 之一。过滤条件 `action !== "deny"` 意味着 allow 和 ask 状态的 Skill 都出现在列表中——ask 状态的 Skill 可见但调用时需用户确认，形成 deny/ask/allow 三级权限梯度。

## 11.6 Skill 与系统提示词的交互路径

Skill 内容并不直接拼接到系统提示词中，而是通过 SkillTool 的工具描述间接进入模型视野。完整的交互路径如下：

```text
┌───────────────────────────────────────────────────┐
│  Agent 初始化                                     │
│  ┌─────────────┐    ┌──────────────────────────┐  │
│  │ Skill.fmt() │ →  │ SkillTool.description    │  │
│  │ 名称+描述   │    │ 嵌入工具定义发送给模型    │  │
│  └─────────────┘    └──────────────────────────┘  │
└───────────────────────────────────────────────────┘
                        ↓ 模型判断任务匹配某个 Skill
┌───────────────────────────────────────────────────┐
│  工具调用阶段                                     │
│  ┌─────────────┐    ┌──────────────────────────┐  │
│  │ execute()   │ →  │ Skill.content 注入上下文  │  │
│  │ 权限+扫描   │    │ 完整 Markdown body 返回   │  │
│  └─────────────┘    └──────────────────────────┘  │
└───────────────────────────────────────────────────┘
```

即使项目配置了 50 个 Skill，系统提示词中也只会多出一小段列表，上下文窗口的空间得以保留。模型判断某个 Skill 与当前任务相关时，主动调用 SkillTool 加载完整内容，Markdown body 才作为工具返回值进入对话上下文。

## 11.7 与 Claude Code 的 Skill 系统对比

| 特性 | OpenCode | Claude Code |
|------|----------|-------------|
| 技能文件 | `SKILL.md`（兼容 Claude Code） | `CLAUDE.md` + 自定义文件 |
| 发现目录 | `.claude/`, `.agents/`, `.opencode/` | `.claude/` |
| 远程加载 | 支持（`index.json` 索引） | 不支持 |
| 权限过滤 | Agent 级别精细控制 | 无细粒度过滤 |
| 加载方式 | 工具调用（按需加载） | 始终注入系统提示 |
| 关联文件 | 自动列出目录内容 | 需手动引用 |

OpenCode 的核心优势在于**按需加载**节省上下文空间，以及**远程共享**支持团队级 Skill 分发。

## 11.8 实战：构建团队共享的 Skill 库

假设团队需要共享一组编码规范 Skill。以下是搭建远程 Skill 服务的完整流程。

**步骤一**：创建 Skill 仓库结构：

```text
skills-repo/
├── index.json
├── code-style/
│   ├── SKILL.md
│   └── reference/eslint-config.json
├── git-workflow/
│   ├── SKILL.md
│   └── scripts/check-branch.sh
└── db-migration/
    ├── SKILL.md
    └── templates/migration-template.sql
```

**步骤二**：编写 `index.json` 索引。注意每个 Skill 的 `files` 数组必须包含 `SKILL.md`，否则 Discovery 服务会在校验阶段过滤掉该条目并发出警告：

```json
{
  "skills": [
    {
      "name": "code-style",
      "description": "团队代码风格规范",
      "files": ["SKILL.md", "reference/eslint-config.json"]
    },
    {
      "name": "git-workflow",
      "description": "Git 分支与 PR 工作流",
      "files": ["SKILL.md", "scripts/check-branch.sh"]
    },
    {
      "name": "db-migration",
      "description": "数据库迁移脚本编写规范",
      "files": ["SKILL.md", "templates/migration-template.sql"]
    }
  ]
}
```

**步骤三**：将仓库部署为静态文件服务（GitHub Pages、Nginx 等均可）。Discovery 服务通过标准 HTTP GET 请求下载文件，URL 拼接规则为 `{base_url}/{skill_name}/{file_path}`。例如对于 `code-style` Skill 的 `reference/eslint-config.json` 文件，完整 URL 为 `https://skills.example.com/code-style/reference/eslint-config.json`。

**步骤四**：在项目配置中添加远程 URL：

```json
{
  "skills": {
    "urls": ["https://skills.example.com/"]
  }
}
```

OpenCode 启动时会自动拉取索引、以 4 个 Skill 并发 + 每 Skill 8 个文件并发的速率下载所有文件，并缓存至 `~/.cache/opencode/skills/`。团队成员更新 Skill 后，删除本地缓存即可获取最新版本：

```bash
# 清除所有远程 Skill 缓存
rm -rf ~/.cache/opencode/skills/

# 或只清除特定 Skill
rm -rf ~/.cache/opencode/skills/code-style/
```

对于需要频繁更新的团队，可以在 CI/CD 流水线中加入一个步骤来自动同步 Skill 仓库，确保所有成员使用最新的规范。

## 本章要点

- OpenCode 不硬编码内置 Skill，所有技能均通过文件系统或远程 URL 动态发现，完全由用户和社区驱动
- `SkillTool` 在 Agent 初始化时异步构建，将过滤后的 Skill 列表嵌入工具描述，参数定义中嵌入示例名称辅助模型理解
- `Skill.fmt()` 支持 verbose（XML）和简洁（Markdown）双模式，SkillTool 当前使用简洁模式节省 token
- 执行生命周期四阶段：名称查找 → 权限确认 → Ripgrep 文件扫描 → XML 封装输出
- Ripgrep 文件扫描自动尊重 `.gitignore` 规则，10 个文件的上限防止过多信息注入上下文
- Skill 目录自动加入 Agent 白名单，远程 Skill 的辅助文件无需额外权限确认即可读取
- `available()` 先按名称排序保证列表一致性，再通过 `Permission.evaluate` 实现 deny/ask/allow 三级权限梯度
- 远程 Skill 库可通过 `index.json` 索引 + 静态文件服务实现团队级共享，下载 URL 按 `{base}/{name}/{file}` 规则拼接
