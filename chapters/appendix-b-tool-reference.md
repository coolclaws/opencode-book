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

```typescript
{
  file_path: string     // 绝对路径（必填）
  offset?: number       // 起始行号
  limit?: number        // 读取行数
  pages?: string        // PDF 页码范围（如 "1-5"）
}
```

**特殊能力**：
- 支持读取图片文件（PNG、JPG 等），以多模态方式呈现给 LLM
- 支持读取 PDF 文件，大文件需指定 `pages` 参数
- 支持读取 Jupyter Notebook（`.ipynb`），返回所有 cell 及输出
- 超过 2000 字符的行自动截断

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

### Grep 工具

```typescript
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

### Bash 工具

```typescript
{
  command: string          // Shell 命令（必填）
  timeout?: number         // 超时毫秒数（最大 600000）
  description?: string     // 命令描述（用于权限审核）
}
```

**安全限制**：
- 不支持交互式命令（`-i` 标志）
- 工作目录在调用之间会重置
- 可通过权限配置限制特定命令模式

### Task 工具

```typescript
{
  description: string      // 任务描述（必填）
  agent?: string           // 指定子 Agent
}
```

**行为**：
- 启动独立的子 Agent 会话
- 子 Agent 继承父会话的工具和权限
- 适合并行处理独立子任务

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
