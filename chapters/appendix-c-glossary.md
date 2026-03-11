# 附录 C：术语表

本术语表收录了 OpenCode 源码及本书中频繁出现的核心概念，按英文字母顺序排列，附中文解释和在 OpenCode 中的具体含义。

---

### ACP（Agent Communication Protocol）

Agent 通信协议。OpenCode 定义的客户端与服务端之间的通信协议，基于 HTTP + SSE 实现。Desktop、Web 和 TUI 三种客户端通过相同的 ACP 接口与后端交互，确保行为一致性。

### Agent

智能体。OpenCode 中的 Agent 是具有特定角色和能力的 LLM 配置单元。内置 Agent 包括 `build`（构建，主 Agent）、`plan`（规划）、`general`（通用子 Agent）、`explore`（探索子 Agent）等。每个 Agent 可配置独立的 prompt、模型、权限和步数限制。

### BusEvent

总线事件。OpenCode 事件驱动架构的基础单元，通过 `BusEvent.define()` 定义，包含类型标识和 Zod schema 验证。所有模块间通信均通过 Bus 发布/订阅事件完成，实现松耦合。

### Compaction（上下文压缩）

当对话上下文接近模型的 Token 上限时，OpenCode 自动触发压缩流程。Compaction 使用一个专门的 Agent 将历史对话摘要为简短的上下文，然后替换原始消息，从而释放 Token 空间继续对话。

### Command（命令）

用户可定义的提示词模板，存放在 `.opencode/commands/` 目录中，以 Markdown 格式编写，支持 frontmatter 配置。在 TUI 中通过 `/命令名` 或 `Ctrl+P` 命令面板触发。

### Doom Loop（死循环检测）

当 Agent 反复执行相似操作但无法取得进展时，OpenCode 的安全机制会检测到这种"死循环"模式并请求用户确认是否继续，防止无意义的 Token 消耗。

### Drizzle ORM

OpenCode 使用的 TypeScript ORM 框架，用于操作 SQLite 数据库。Drizzle 以类型安全和轻量著称，支持迁移管理。OpenCode 的 session、message、part、snapshot 等数据表均通过 Drizzle 定义和查询。

### Hono

OpenCode 服务端使用的轻量级 Web 框架。Hono 运行在 Bun 上，提供路由、中间件、SSE 流、CORS、BasicAuth 等能力。OpenCode 的所有 HTTP API 和 SSE 端点均基于 Hono 构建。

### Ink

React 的终端渲染器，被 Claude Code 等工具采用。OpenCode 选择了 OpenTUI + SolidJS 替代 Ink + React，以获得更高的渲染性能和更丰富的终端能力。本书中 Ink 主要出现在对比分析中。

### LSP（Language Server Protocol）

语言服务器协议。OpenCode 内置 LSP 客户端，可连接 TypeScript、Python 等语言的 LSP 服务器，获取诊断信息、符号引用、类型定义等能力。LSP 数据作为上下文增强 Agent 的代码理解能力。

### MCP（Model Context Protocol）

模型上下文协议。由 Anthropic 提出的开放协议，定义了 AI 应用与外部工具/资源的标准通信方式。OpenCode 同时作为 MCP 客户端（连接外部 MCP 服务器）使用。支持本地进程（stdio）和远程（HTTP + SSE）两种连接方式。

### OpenTUI

OpenCode 自研的终端 UI 渲染框架，替代 Ink。基于 SolidJS 响应式系统，支持 60fps 渲染、Kitty 键盘协议、鼠标事件、Tree-sitter 语法高亮等高级终端特性。

### Part

消息部件。OpenCode 中一条 Message 由多个 Part 组成，类型包括：`text`（文本）、`tool-invocation`（工具调用）、`tool-result`（工具结果）、`reasoning`（推理过程）、`source`（引用来源）等。Part 是消息的最小组成单元。

### Permission（权限）

OpenCode 的安全控制机制。每个工具操作在执行前需要通过权限检查。权限有三个级别：`allow`（允许）、`ask`（询问用户）、`deny`（拒绝）。权限可按工具类型和路径模式（glob pattern）细粒度配置。

### Processor（处理器）

消息处理器。OpenCode 中 Processor 负责协调一次完整的 Agent 执行循环：接收用户消息 → 调用 LLM → 处理工具调用 → 循环直到完成。Processor 管理 Token 计数、自动压缩触发、错误重试等逻辑。

### Provider

模型提供商。OpenCode 通过 Provider 层抽象不同 LLM 服务商（Anthropic、OpenAI、Google、AWS Bedrock 等）的差异。每个 Provider 定义了认证方式、模型列表、API 参数转换等。Provider 的加载和配置通过 `opencode.json` 的 `provider` 字段管理。

### Session（会话）

一次完整的对话交互。Session 包含用户和 Agent 之间的所有消息记录、Tool 调用历史、Token 用量统计等。Session 支持 fork（分支）、compact（压缩）、share（分享）等操作。数据持久化在 SQLite 数据库中。

### Skill（技能）

可复用的能力描述文件，以 Markdown 格式定义（`SKILL.md`）。Skill 包含 Agent 在特定场景下应遵循的指令和最佳实践。支持从本地目录和远程 URL 加载，兼容 Claude Code 的 `.claude/skills/` 目录结构。

### Snapshot（快照）

文件状态快照。OpenCode 在 Agent 修改文件前自动创建快照，记录修改前后的文件内容差异。快照支持 undo（撤销）和 redo（重做）操作，确保用户可以安全回滚 Agent 的所有修改。

### SolidJS

OpenCode TUI 和 Desktop/Web 客户端使用的响应式 UI 框架。SolidJS 采用细粒度响应式（fine-grained reactivity）模型，通过 `createSignal`、`createEffect`、`createStore` 等原语实现高效的状态管理和 UI 更新。

### Tool（工具）

Agent 可调用的能力单元。每个 Tool 有明确的描述、参数 schema（Zod 定义）和执行函数。内置工具包括文件操作（Read、Edit、Write）、搜索（Glob、Grep）、命令执行（Bash）等。第三方工具通过 Plugin 或 MCP 扩展。

### Worktree

Git 工作树。OpenCode 利用 Git worktree 机制为子 Agent（Task Tool）创建隔离的工作环境。每个 Task 在独立的 worktree 中操作，完成后将变更合并回主分支，避免并发文件冲突。

### Zod

TypeScript 的运行时类型验证库。OpenCode 广泛使用 Zod 定义配置 schema、工具参数、API 请求/响应类型等。Zod schema 同时用于编译期类型推断和运行时数据验证，是 OpenCode 类型安全的基石。
