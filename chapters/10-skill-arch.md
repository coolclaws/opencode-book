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

> **源码位置**：packages/opencode/src/skill/skill.ts

```typescript
// Skill 信息的核心类型定义
export const Info = z.object({
  name: z.string(),          // 技能名称，全局唯一标识
  description: z.string(),   // 技能描述，展示给用户和模型
  location: z.string(),      // SKILL.md 文件的绝对路径
  content: z.string(),       // Markdown body 内容（不含 frontmatter）
})
```

frontmatter 的解析由 `ConfigMarkdown.parse` 完成，底层使用 `gray-matter` 库。值得注意的是，OpenCode 为兼容其他工具（如 Claude Code）的非标准 YAML，还实现了 `fallbackSanitization` 降级解析逻辑——当 YAML 中出现未转义的冒号时，自动转换为块标量语法：

```typescript
// 处理包含冒号的值：转为 YAML 块标量
if (value.includes(":")) {
  result.push(`${key}: |-`)
  result.push(`  ${value}`)
  continue
}
```

## 10.2 多路径扫描机制

OpenCode 的 Skill 加载采用**多层级扫描**策略，从全局到项目逐层覆盖。扫描顺序决定了优先级：后加载的同名 Skill 会覆盖先加载的。

```typescript
// 扫描的外部目录和匹配模式
const EXTERNAL_DIRS = [".claude", ".agents"]
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"
```

具体的扫描层级如下：

**第一层：全局目录（优先级最低）**

扫描 `~/.claude/skills/` 和 `~/.agents/skills/` 下的 SKILL.md 文件。这些是用户级别的全局技能，适用于所有项目。

**第二层：项目级外部目录**

从当前项目目录向上遍历，在每一级查找 `.claude/` 和 `.agents/` 目录。通过 `Filesystem.up()` 实现向上递归，止步于 worktree 根目录：

```typescript
for await (const root of Filesystem.up({
  targets: EXTERNAL_DIRS,
  start: Instance.directory,  // 当前项目目录
  stop: Instance.worktree,    // git worktree 根目录
})) {
  await scanExternal(root, "project")
}
```

**第三层：OpenCode 配置目录**

扫描 `.opencode/skill/` 和 `.opencode/skills/` 目录。这是 OpenCode 原生的技能存放位置。

**第四层：自定义路径**

通过配置文件的 `skills.paths` 字段指定额外的扫描路径，支持 `~/` 家目录展开和相对路径解析：

```typescript
for (const skillPath of config.skills?.paths ?? []) {
  const expanded = skillPath.startsWith("~/")
    ? path.join(os.homedir(), skillPath.slice(2))
    : skillPath
  const resolved = path.isAbsolute(expanded)
    ? expanded
    : path.join(Instance.directory, expanded)
  // 扫描该目录下所有 SKILL.md
}
```

**第五层：远程 URL（优先级最高）**

通过 `skills.urls` 配置从远程服务器下载技能包。

## 10.3 Skill 加载与解析

每个扫描到的 SKILL.md 文件都经过 `addSkill` 函数处理。核心流程包括：解析 frontmatter、验证必填字段、处理重名冲突：

```typescript
const addSkill = async (match: string) => {
  // 1. 解析 Markdown frontmatter
  const md = await ConfigMarkdown.parse(match).catch((err) => {
    // 解析失败时通过 Bus 发布错误事件
    Bus.publish(Session.Event.Error, { error: ... })
    return undefined
  })
  if (!md) return

  // 2. 验证 name 和 description 字段
  const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
  if (!parsed.success) return

  // 3. 重名检测与警告
  if (skills[parsed.data.name]) {
    log.warn("duplicate skill name", {
      name: parsed.data.name,
      existing: skills[parsed.data.name].location,
      duplicate: match,
    })
  }

  // 4. 注册 Skill（后加载覆盖先加载）
  skills[parsed.data.name] = {
    name: parsed.data.name,
    description: parsed.data.description,
    location: match,
    content: md.content,
  }
}
```

加载完成后，Skill 可通过 `available()` 函数按 Agent 权限过滤。权限系统使用 `PermissionNext.evaluate` 判断某个 Agent 是否有权使用特定 Skill：

```typescript
export async function available(agent?: Agent.Info) {
  const list = await all()
  if (!agent) return list
  return list.filter((skill) =>
    PermissionNext.evaluate("skill", skill.name, agent.permission).action !== "deny"
  )
}
```

## 10.4 远程 Skill 发现

> **源码位置**：packages/opencode/src/skill/discovery.ts

远程 Skill 通过 `Discovery.pull` 函数从 URL 下载。远程服务器需要提供一个 `index.json` 索引文件，描述可用的技能及其文件清单：

```typescript
type Index = {
  skills: Array<{
    name: string        // 技能名称
    description: string // 技能描述
    files: string[]     // 技能包含的文件列表
  }>
}
```

下载流程分三步：首先获取 `index.json`；然后为每个 Skill 创建缓存目录并下载所有文件；最后验证目录中存在 `SKILL.md` 后返回路径：

```typescript
export async function pull(url: string): Promise<string[]> {
  const base = url.endsWith("/") ? url : `${url}/`
  const index = new URL("index.json", base).href
  const cache = dir()  // ~/.cache/opencode/skills/

  // 获取并解析索引
  const data = await fetch(index).then(r => r.json())

  // 并行下载所有 Skill 的文件
  await Promise.all(
    list.map(async (skill) => {
      const root = path.join(cache, skill.name)
      await Promise.all(
        skill.files.map(async (file) => {
          const link = new URL(file, `${host}/${skill.name}/`).href
          const dest = path.join(root, file)
          await mkdir(path.dirname(dest), { recursive: true })
          await get(link, dest)  // 下载文件，已存在则跳过
        }),
      )
    }),
  )
  return result
}
```

缓存机制是"存在即跳过"——如果文件已下载过，不会重复下载。缓存目录位于 `~/.cache/opencode/skills/`。

## 10.5 实战：创建第一个自定义 Skill

假设我们的团队需要一个"API 接口审查"技能。创建步骤如下：

**步骤一**：在项目根目录创建 Skill 目录结构：

```bash
mkdir -p .opencode/skills/api-review
```

**步骤二**：编写 SKILL.md 文件：

```markdown
---
name: api-review
description: 审查 REST API 接口设计，检查命名规范、错误处理和版本管理
---

## 审查清单

1. **URL 设计**：使用复数名词，避免动词（如 `/users` 而非 `/getUsers`）
2. **HTTP 方法**：GET 读取、POST 创建、PUT 更新、DELETE 删除
3. **错误响应**：统一 `{ code, message, details }` 格式
4. **版本管理**：URL 前缀 `/api/v1/` 或 Header `Accept-Version`

## 参考脚本

运行 `scripts/check-api.sh` 可自动扫描 OpenAPI 定义文件。
```

**步骤三**：可选地在 Skill 目录下添加辅助文件：

```bash
.opencode/skills/api-review/
├── SKILL.md
├── scripts/
│   └── check-api.sh
└── reference/
    └── openapi-template.yaml
```

当 AI 助手加载该 Skill 时，会自动列出目录下的关联文件供参考。

## 本章要点

- Skill 以 `SKILL.md` 文件为载体，使用 YAML frontmatter 定义 `name` 和 `description`，Markdown body 承载具体指令
- 多路径扫描遵循 **全局 → 项目级 → OpenCode 原生 → 自定义路径 → 远程 URL** 的加载顺序，后加载的同名 Skill 覆盖先加载的
- 远程 Skill 通过 `index.json` 索引发现，下载后缓存至 `~/.cache/opencode/skills/`，实现"下载一次，持久可用"
- Skill 加载受 Agent 权限系统约束，`PermissionNext.evaluate` 可阻止特定 Agent 访问某些 Skill
- OpenCode 兼容 `.claude/skills/` 目录结构，方便从 Claude Code 生态迁移
