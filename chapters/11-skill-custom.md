# 第 11 章　内置 Skill 与自定义扩展

上一章介绍了 Skill 的文件格式和加载机制。本章将深入 Skill 与 Agent 的交互方式、Skill 工具的执行流程，以及如何构建可在团队间共享的 Skill 库。

## 11.1 内置 Skill 示例

OpenCode 本身不硬编码任何内置 Skill——所有 Skill 均通过文件系统或远程 URL 动态加载。这与 Claude Code 将部分规则写死在代码中的做法形成鲜明对比。OpenCode 的设计哲学是：**Skill 完全由用户和社区驱动**。

不过，OpenCode 提供了完整的 Skill 工具（`SkillTool`）来管理 Skill 的发现和加载：

> **源码位置**：packages/opencode/src/tool/skill.ts

```typescript
export const SkillTool = Tool.define("skill", async (ctx) => {
  // 根据当前 Agent 权限过滤可用 Skill
  const list = await Skill.available(ctx?.agent)

  const description =
    list.length === 0
      ? "Load a specialized skill. No skills are currently available."
      : [
          "Load a specialized skill that provides domain-specific instructions.",
          "",
          "When you recognize that a task matches one of the available skills,",
          "use this tool to load the full skill instructions.",
          "",
          Skill.fmt(list),  // 格式化为 XML 列表
        ].join("\n")

  return {
    description,
    parameters,
    async execute(params, ctx) { /* ... */ },
  }
})
```

当没有任何 Skill 可用时，工具描述会明确告知模型"No skills are currently available"，避免不必要的调用尝试。

## 11.2 Skill 与 Agent 的交互

Skill 的可见性由 `Skill.fmt()` 函数控制。该函数将 Skill 列表格式化为 XML 结构，注入到 Skill 工具的描述中，从而让模型知道哪些技能可以调用：

```typescript
export function fmt(list: Info[]) {
  return [
    "<available_skills>",
    ...list.flatMap((skill) => [
      `  <skill>`,
      `    <name>${skill.name}</name>`,
      `    <description>${skill.description}</description>`,
      `    <location>${pathToFileURL(skill.location).href}</location>`,
      `  </skill>`,
    ]),
    "</available_skills>",
  ].join("\n")
}
```

当模型决定调用某个 Skill 时，`SkillTool.execute` 会完成以下工作：

**第一步：权限检查**。通过 `ctx.ask()` 向用户请求权限确认：

```typescript
await ctx.ask({
  permission: "skill",
  patterns: [params.name],
  always: [params.name],
  metadata: {},
})
```

**第二步：读取 Skill 内容**。从已解析的 Skill 注册表中获取完整内容。

**第三步：扫描关联文件**。使用 Ripgrep 列出 Skill 目录下的文件（最多 10 个），让模型知道有哪些脚本和参考资料可用：

```typescript
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
})
```

**第四步：组装输出**。将 Skill 内容、基目录路径和文件列表封装为结构化输出：

```typescript
return {
  title: `Loaded skill: ${skill.name}`,
  output: [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    skill.content.trim(),
    `Base directory for this skill: ${base}`,
    "<skill_files>",
    files,
    "</skill_files>",
    "</skill_content>",
  ].join("\n"),
}
```

## 11.3 URL 下载机制

Skill 目录也会被自动加入 Agent 的**白名单目录**。在 Agent 初始化时，Skill 所在的目录被注册为允许访问的外部路径：

> **源码位置**：packages/opencode/src/agent/agent.ts

```typescript
const skillDirs = await Skill.dirs()
const whitelistedDirs = [
  Truncate.GLOB,
  ...skillDirs.map((dir) => path.join(dir, "*"))
]
```

这意味着 Skill 可以引用自身目录下的脚本和模板文件，Agent 无需额外的权限确认即可读取这些文件。这是一个精妙的设计——Skill 作为受信任的知识包，其关联资源自动获得访问权限。

远程 Skill 的下载缓存在 `~/.cache/opencode/skills/` 目录。`Discovery.get` 函数实现了简单的缓存策略：

```typescript
async function get(url: string, dest: string): Promise<boolean> {
  if (await Filesystem.exists(dest)) return true  // 已存在则跳过
  return fetch(url)
    .then(async (response) => {
      if (!response.ok) return false
      if (response.body) await Filesystem.writeStream(dest, response.body)
      return true
    })
    .catch(() => false)
}
```

## 11.4 Skill 权限过滤

不同 Agent 有不同的能力范围。例如 `explore` Agent 被限制为只读操作，它不应该访问需要写入权限的 Skill。OpenCode 通过权限规则实现了这种过滤：

```typescript
export async function available(agent?: Agent.Info) {
  const list = await all()
  if (!agent) return list
  return list.filter((skill) =>
    PermissionNext.evaluate("skill", skill.name, agent.permission)
      .action !== "deny"
  )
}
```

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

这样，即使 `dangerous-deploy` Skill 存在于文件系统中，被限制的 Agent 也无法看到或使用它。

## 11.5 与 Claude Code 的 Skill 系统对比

| 特性 | OpenCode | Claude Code |
|------|----------|-------------|
| 技能文件 | `SKILL.md`（兼容 Claude Code） | `CLAUDE.md` + 自定义文件 |
| 发现目录 | `.claude/`, `.agents/`, `.opencode/` | `.claude/` |
| 远程加载 | 支持（`index.json` 索引） | 不支持 |
| 权限过滤 | Agent 级别精细控制 | 无细粒度过滤 |
| 加载方式 | 工具调用（按需加载） | 始终注入系统提示 |
| 关联文件 | 自动列出目录内容 | 需手动引用 |

OpenCode 的 Skill 系统相比 Claude Code 有两大优势：一是**按需加载**——Skill 内容只在模型主动调用时才注入上下文，节省了宝贵的上下文窗口空间；二是**远程共享**——团队可以搭建 Skill 服务器，统一维护和分发技能包。

## 11.6 实战：构建团队共享的 Skill 库

假设团队需要共享一组编码规范 Skill。以下是搭建远程 Skill 服务的完整流程。

**步骤一**：创建 Skill 仓库结构：

```
skills-repo/
├── index.json
├── code-style/
│   ├── SKILL.md
│   └── reference/eslint-config.json
└── git-workflow/
    ├── SKILL.md
    └── scripts/check-branch.sh
```

**步骤二**：编写 `index.json` 索引：

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
    }
  ]
}
```

**步骤三**：将仓库部署为静态文件服务（GitHub Pages、Nginx 等均可）。

**步骤四**：在项目配置中添加远程 URL：

```json
{
  "skills": {
    "urls": ["https://skills.example.com/team-skills/"]
  }
}
```

OpenCode 启动时会自动拉取索引、下载文件并缓存至本地。团队成员更新 Skill 后，删除本地缓存即可获取最新版本。

## 本章要点

- OpenCode 不硬编码内置 Skill，所有技能均通过文件系统或远程 URL 动态发现，完全由用户和社区驱动
- Skill 工具采用**按需加载**模式：模型看到 Skill 列表后主动调用，内容才注入上下文，避免浪费 token
- Skill 目录自动加入 Agent 白名单，关联的脚本和模板文件无需额外权限确认即可读取
- 权限过滤在 Agent 层面实现，可通过配置精确控制哪些 Agent 能使用哪些 Skill
- 远程 Skill 库可通过 `index.json` 索引 + 静态文件服务实现团队级共享
