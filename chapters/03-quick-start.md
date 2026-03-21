# 第 3 章　快速上手与开发环境

前两章我们了解了 OpenCode 的设计哲学和项目结构。本章将进入实战环节：从安装到首次运行，从基本使用到搭建开发环境，最后通过一个完整的编程任务演示 OpenCode 的实际工作流程。

## 3.1 安装方式

OpenCode 提供了多种安装方式，覆盖主流操作系统和包管理器：

### 3.1.1 一键安装脚本

最快的方式是使用官方安装脚本：

```bash
curl -fsSL https://opencode.ai/install | bash
```

安装脚本会按以下优先级选择安装目录：`$OPENCODE_INSTALL_DIR` → `$XDG_BIN_DIR` → `$HOME/bin` → `$HOME/.opencode/bin`。你也可以通过环境变量自定义安装路径：

```bash
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
```

### 3.1.2 包管理器安装

```bash
# npm / bun / pnpm / yarn
npm i -g opencode-ai@latest

# macOS / Linux（推荐，保持最新）
brew install anomalyco/tap/opencode

# macOS / Linux（官方 brew formula）
brew install opencode

# Windows
scoop install opencode
choco install opencode

# Arch Linux
sudo pacman -S opencode

# Nix
nix run nixpkgs#opencode

# mise
mise use -g opencode
```

如果你同时安装了多个版本（比如通过 npm 全局安装和 brew 安装），确认 `which opencode` 指向期望的版本。使用 `opencode --version` 可以快速验证当前版本。

### 3.1.3 桌面应用

OpenCode 还提供了桌面应用（Beta），支持 macOS（Apple Silicon / Intel）、Windows 和 Linux：

```bash
# macOS
brew install --cask opencode-desktop

# Windows
scoop bucket add extras; scoop install extras/opencode-desktop
```

也可以直接从 [releases 页面](https://github.com/anomalyco/opencode/releases) 下载安装包。桌面应用内部使用 `packages/app` 中的共享 UI 组件，通过 Tauri（或 Electron）封装——与 TUI 共享同一个 Hono Server 后端，只是前端渲染层不同。

## 3.2 首次运行与配置

安装完成后，在任意项目目录下运行：

```bash
cd /path/to/your/project
opencode
```

OpenCode 会自动检测当前目录为工作区，启动 Instance 并初始化所有子系统。首次运行时需要配置 LLM 提供商。

### 3.2.1 配置文件

OpenCode 的配置采用多级合并策略，优先级从低到高。从 `config/config.ts` 的源码注释中可以看到完整的加载顺序：

```typescript
// 文件: packages/opencode/src/config/config.ts L80-88
// Config loading order (low -> high precedence):
// 1) Remote .well-known/opencode (org defaults)
// 2) Global config (~/.config/opencode/opencode.json{,c})
// 3) Custom config (OPENCODE_CONFIG)
// 4) Project config (opencode.json{,c})
// 5) .opencode directories (.opencode/agents/, .opencode/commands/,
//    .opencode/plugins/, .opencode/opencode.json{,c})
// 6) Inline config (OPENCODE_CONFIG_CONTENT)
```

> **源码位置**：packages/opencode/src/config/config.ts

配置文件使用 JSONC 格式（支持注释），典型配置如下：

```jsonc
{
  // 设置默认提供商和模型
  "provider": {
    "anthropic": {
      "api_key": "sk-ant-..."
    }
  },
  // 设置默认 Agent
  "default_agent": "build",
  // 自定义权限规则
  "permission": {
    "bash": "allow",
    "edit": "ask"
  }
}
```

企业部署场景还支持系统管理配置目录（Managed Config），位于平台特定路径（macOS: `/Library/Application Support/opencode`，Linux: `/etc/opencode`，Windows: `C:\ProgramData\opencode`），该层级拥有最高优先级，由系统管理员控制，适用于统一管理 API Key 和安全策略。

配置合并时对数组字段（如 `plugin` 和 `instructions`）使用拼接而非覆盖策略，这意味着全局配置中声明的插件不会被项目配置覆盖掉，而是两者合并：

```typescript
// 文件: packages/opencode/src/config/config.ts L67-76
function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeDeep(target, source)
  if (target.plugin && source.plugin) {
    merged.plugin = Array.from(new Set([...target.plugin, ...source.plugin]))
  }
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}
```

OpenCode 支持的提供商列表非常丰富，包括 Anthropic、OpenAI、Google、Azure、AWS Bedrock、xAI、Groq、Mistral、OpenRouter、DeepInfra、Cerebras、Cohere、Together AI、Perplexity、GitLab 等。配置好 API key 后即可使用对应的模型。

以下是各主要提供商的配置示例：

```jsonc
{
  "provider": {
    // Google Gemini
    "google": {
      "api_key": "AIza..."
    },
    // Azure OpenAI（需指定部署端点）
    "azure": {
      "api_key": "your-azure-key",
      "resource_name": "your-resource",
      "deployment": "gpt-4o"
    },
    // 本地模型（通过 Ollama 的 OpenAI 兼容 API）
    "openai": {
      "api_key": "ollama",
      "base_url": "http://localhost:11434/v1"
    },
    // OpenRouter（一个 key 访问多种模型）
    "openrouter": {
      "api_key": "sk-or-..."
    }
  }
}
```

对于本地模型场景，OpenCode 通过 OpenAI 兼容 API 支持 Ollama、LM Studio、vLLM 等本地推理引擎。只需将 `base_url` 指向本地服务地址，`api_key` 填入任意非空字符串即可。这使得在无法访问外部 API 的环境（如企业内网或离线开发）中也能正常使用 OpenCode。

环境变量 `OPENCODE_CONFIG` 允许指定自定义配置文件路径，而 `OPENCODE_CONFIG_CONTENT` 允许直接通过环境变量传入配置内容（JSON 格式），这在 CI/CD 和容器化部署中特别有用——无需在文件系统中写入配置文件。

### 3.2.2 OpenCode Zen

如果你不想自己配置 API key，OpenCode 官方提供了 [OpenCode Zen](https://opencode.ai/zen) 服务，一站式提供模型访问，开箱即用。

### 3.2.3 .opencode 项目目录

除了配置文件，OpenCode 还支持在项目根目录创建 `.opencode/` 目录来组织项目级的自定义内容：

```
.opencode/
├── opencode.jsonc    # 项目级配置
├── agents/           # 自定义 Agent 定义
├── commands/         # 自定义命令（快捷指令）
├── plugins/          # 项目专用插件
├── tools/            # 自定义工具（.ts 或 .js 文件）
└── plans/            # Plan Agent 输出的计划文件
```

自定义工具是 OpenCode 的一个强大特性。将 `.ts` 文件放在 `.opencode/tools/` 目录下，OpenCode 启动时会自动扫描并注册为可用工具。工具文件只需导出一个符合 `ToolDefinition` 接口的对象即可。

## 3.3 基本使用流程

OpenCode 启动后会进入 TUI 界面，基本工作流程如下：

**开始对话**：直接在输入框中输入问题或指令。例如："帮我阅读 src/main.ts 并解释它的功能"。

**Agent 切换**：使用 `Tab` 键在 `build`（构建模式）和 `plan`（计划模式）之间切换：
- **build Agent**：默认模式，拥有完整的工具权限，可以读写文件、执行命令。
- **plan Agent**：只读模式，禁止编辑操作，适合代码分析和方案规划。

**子 Agent 调用**：在消息中使用 `@general` 可以调用通用子 Agent 来执行复杂的多步骤任务。`@explore` 则可以快速搜索和浏览代码库，适合需要广泛探索的场景。

**工具授权**：根据权限配置，某些操作（如执行 bash 命令、访问外部目录）会弹出确认提示。你可以在配置文件中预设权限规则来简化工作流。从 Agent 的默认权限可以看到，`.env` 文件的读取默认需要确认（`"*.env": "ask"`），而 `.env.example` 则被豁免（`"*.env.example": "allow"`），体现了安全优先的设计理念。

**Session 管理**：每次对话都会自动持久化为 Session，下次启动时可以恢复之前的对话上下文。

### 3.3.1 TUI 快捷键

OpenCode 的 TUI 提供了丰富的键盘快捷键，支持 Leader Key 模式（类似 Vim 的组合键序列，默认 Leader 为 `Ctrl+X`）：

| 快捷键 | 功能 |
|--------|------|
| `Tab` | 在 build/plan Agent 之间切换 |
| `Enter` | 提交当前输入 |
| `Shift+Enter` 或 `Ctrl+Enter` | 输入换行（不提交） |
| `Ctrl+K` | 打开命令面板 |
| `Ctrl+C` | 中断当前 Agent 执行 |
| `PageUp` / `PageDown` | 滚动消息历史 |
| `Ctrl+L` | 清屏 |
| `Ctrl+X` → `n` | 新建 Session |
| `Ctrl+X` → `h` | 打开 Session 历史列表 |
| `Ctrl+X` → `s` | 分享当前 Session |

命令面板（`Ctrl+K`）提供了类似 VS Code 的模糊搜索体验，可以快速访问所有可用命令，包括切换模型、打开配置、管理 MCP 服务器等。所有快捷键都可以在配置文件的 `keybind` 字段中自定义，设置为 `"none"` 即可禁用某个快捷键。

### 3.3.2 非交互模式：opencode run

除了 TUI 交互模式，OpenCode 还支持通过 `opencode run` 命令以非交互方式执行任务，适合 CI/CD 流水线和脚本自动化场景：

```bash
# 基本用法：直接传入 prompt
opencode run "Review this codebase and list all TODO comments"

# 从 stdin 读取 prompt（配合管道使用）
echo "Explain the main function" | opencode run

# 在 CI/CD 中执行代码审查
opencode run "Review the changes in this PR and report any issues"
```

`opencode run` 模式下，OpenCode 会启动 Instance、执行 Agent 对话、输出结果到 stdout，然后自动退出。在这种模式下 `QuestionTool` 会被自动禁用（因为无法交互式提问），Agent 只能使用不需要用户确认的工具。这使得 OpenCode 可以嵌入到 GitHub Actions、GitLab CI 等自动化流程中，实现自动代码审查、文档生成、测试用例补充等任务。

## 3.4 调试与日志

开发和排查问题时，了解日志系统非常重要。OpenCode 使用结构化日志，通过环境变量控制日志级别和输出位置。

**日志级别控制**：通过 `OPENCODE_LOG_LEVEL` 环境变量设置，支持 `debug`、`info`、`warn`、`error` 四个级别：

```bash
# 启用 debug 级别日志（输出最详细的信息）
OPENCODE_LOG_LEVEL=debug opencode

# 只显示警告和错误
OPENCODE_LOG_LEVEL=warn opencode
```

**日志文件位置**：OpenCode 的日志文件存储在本地数据目录中，默认路径为 `~/.local/share/opencode/log/`。在 TUI 运行期间，日志不会干扰终端界面，而是写入文件。你可以在另一个终端窗口中实时跟踪日志：

```bash
tail -f ~/.local/share/opencode/log/opencode.log
```

在调试 LLM 调用问题时，`debug` 级别的日志会输出完整的请求和响应信息，包括发送给模型的 system prompt、工具调用参数、token 用量等，帮助你定位提示词或模型配置的问题。

**常见问题排查**：

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| 启动报错 "No context found" | 在 Instance 上下文外部调用了 Instance.current | 确保代码在 `Instance.provide()` 回调内执行 |
| 模型调用返回 401 | API key 无效或过期 | 检查配置文件中的 `api_key`，或重新设置环境变量 |
| 工具执行超时 | bash 命令运行时间过长 | 在 Agent 对话中指定超时参数，或手动中断（`Ctrl+C`） |
| SQLite 报错 | Bun 版本过低 | 升级到 Bun 1.3+，确认 `bun --version` |
| 文件权限被拒绝 | 访问了项目目录外的文件 | 在配置中添加 `external_directory` 权限规则 |

## 3.5 开发环境搭建

如果你想参与 OpenCode 的开发或调试源码，需要搭建本地开发环境。

### 3.5.1 前置要求

- **Bun 1.3+**：OpenCode 的运行时环境。安装方式参见 [bun.sh](https://bun.sh)。
- **Git**：版本控制。

### 3.5.2 克隆与启动

```bash
# 克隆仓库
git clone https://github.com/anomalyco/opencode.git
cd opencode

# 安装所有依赖
bun install

# 启动开发模式
bun dev
```

`bun dev` 实际执行的是 `bun run --conditions=browser ./src/index.ts`，直接运行 TypeScript 源码，无需编译步骤。默认工作目录为 `packages/opencode`。`--conditions=browser` 用于条件导入解析——`package.json` 中的 `imports` 字段定义了 `#db` 在不同运行时下的映射：Bun 环境使用 `db.bun.ts`（原生 SQLite），Node 环境使用 `db.node.ts`（通过 better-sqlite3）。

### 3.5.3 常用开发命令

```bash
# 在指定目录运行 OpenCode
bun dev /path/to/target/project

# 在 opencode 仓库根目录运行（用 OpenCode 开发 OpenCode）
bun dev .

# 运行测试（30 秒超时）
bun test

# 类型检查（使用 tsgo 加速）
bun run typecheck

# 编译独立可执行文件
./packages/opencode/script/build.ts --single

# 数据库相关操作（Drizzle Kit）
bun run db
```

### 3.5.4 项目结构快速导航

开发时最常接触的目录：

- `packages/opencode/src/agent/` — Agent 定义，修改或添加 Agent。每个 Agent 的 prompt 存放在 `agent/prompt/` 子目录的 `.txt` 文件中
- `packages/opencode/src/tool/` — 内置工具，每个工具一个 `.ts`（实现）+ `.txt`（描述）文件
- `packages/opencode/src/session/` — 对话管理核心逻辑，包括 System Prompt 构建和 LLM 调用编排
- `packages/opencode/src/cli/cmd/tui/` — TUI 界面代码（SolidJS + opentui），按 `component/`、`ui/`、`routes/` 组织
- `packages/opencode/src/provider/` — 添加或修改 LLM 提供商支持，`provider.ts` 中的 `BUNDLED_PROVIDERS` 是核心映射表
- `packages/opencode/src/config/` — 配置加载逻辑，理解多级合并策略的关键入口

## 3.6 实战：用 OpenCode 完成第一个编程任务

让我们通过一个具体的例子，体验 OpenCode 的完整工作流。假设你有一个 Node.js 项目，需要添加一个新的 API 端点。

### 3.6.1 plan 阶段：分析与设计

**第一步：启动 OpenCode**

```bash
cd ~/projects/my-api
opencode
```

**第二步：让 AI 了解项目结构**

在 TUI 中输入：

```
请阅读项目结构，了解现有的 API 路由组织方式
```

OpenCode 的 `build` Agent 会自动调用 `glob`、`read` 等工具扫描项目文件，然后给出分析报告。

**第三步：切换到 plan 模式进行方案设计**

按 `Tab` 键切换到 `plan` Agent：

```
我需要添加一个 GET /api/users/:id 端点，请分析现有代码并给出实现方案
```

`plan` Agent 会在只读模式下分析代码，输出详细的实现方案，而不会修改任何文件。这一步的价值在于，plan Agent 会综合考虑项目的现有架构风格——路由文件的组织方式、控制器的命名约定、数据验证的模式、错误处理的惯例——给出一个与既有代码风格一致的方案。plan Agent 可以将分析结论写入 `.opencode/plans/` 目录下的 Markdown 文件，方便后续 build Agent 引用。

### 3.6.2 build 阶段：执行实现

**第四步：切换回 build 模式执行实现**

再按 `Tab` 切换回 `build` Agent：

```
请按照刚才的方案实现 GET /api/users/:id 端点
```

`build` Agent 会调用 `edit`、`write` 等工具创建和修改文件，调用 `bash` 工具运行测试，确保实现正确。每个需要权限确认的操作都会提示你审批。

在实际执行过程中，`build` Agent 的工作方式是增量式的：它通常先用 `read` 工具读取需要修改的文件，然后用 `edit` 工具对特定代码段进行精确编辑（而不是重写整个文件），最后用 `bash` 工具运行 lint 和测试来验证修改。如果测试失败，Agent 会自动分析错误输出并尝试修复，形成一个"编辑 → 测试 → 修复"的反馈循环。每次文件编辑前，Snapshot 系统会自动保存原始内容，Agent 的每一步操作都是可回溯的。

**第五步：验证结果**

```
运行测试确认新端点工作正常
```

Agent 会执行项目的测试命令并报告结果。

整个过程中，所有对话历史和文件变更都被记录在 Session 中，你可以随时回顾和恢复。如果对 Agent 的修改不满意，可以通过快照回滚到任意编辑之前的状态。

### 3.6.3 plan 和 build 的协作模式

两阶段工作流的核心理念是"先想清楚，再动手"。在实践中，你可能会在两个 Agent 之间多次切换：

```text
┌────────────────────────────────────────────────────────┐
│                    工作流循环                            │
│                                                        │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐       │
│  │  plan     │────→│  build   │────→│  plan    │──→ …  │
│  │ 分析结构  │     │ 实现模块  │     │ 评估方案  │       │
│  └──────────┘     └──────────┘     └──────────┘       │
│       │                │                │              │
│       ▼                ▼                ▼              │
│  只读分析         文件编辑+测试      只读审查           │
│  不修改文件       自动快照保护      重新规划            │
└────────────────────────────────────────────────────────┘
```

两个 Agent 共享同一个 Session 上下文，所以 build Agent 能看到 plan Agent 之前的分析结论，反之亦然。这种设计让"规划"和"执行"自然衔接，而不是割裂的两个独立过程。与 Claude Code 的单 Agent 模式相比，这种双 Agent 架构提供了更安全的工作流——在 plan 模式下你可以放心让 Agent 大量探索代码而不用担心意外修改，确认方案后再切换到 build 模式精确执行。

## 本章要点

- OpenCode 支持多种安装方式：curl 脚本一键安装、npm/brew/scoop 等包管理器安装，以及桌面应用。
- 配置采用 6 级合并策略（远程 → 全局 → 自定义 → 项目 → .opencode 目录 → 内联），使用 JSONC 格式，数组字段使用拼接而非覆盖。
- 支持 20+ 提供商配置，包括 Google、Azure、OpenRouter 及本地模型（Ollama），环境变量 `OPENCODE_CONFIG_CONTENT` 支持无文件配置。
- `.opencode/` 项目目录支持自定义 Agent、命令、插件和工具，工具文件（`.ts`）放入 `tools/` 目录即可自动注册。
- `opencode run` 命令支持非交互模式，自动禁用 QuestionTool，适用于 CI/CD 流水线的自动化场景。
- TUI 提供丰富的快捷键（`Tab` 切换 Agent、`Ctrl+K` 命令面板、Leader Key 序列等），全部可自定义。
- 通过 `OPENCODE_LOG_LEVEL` 环境变量控制日志级别，日志文件存储在 `~/.local/share/opencode/log/`。
- 基本工作流：`Tab` 切换 Agent（build/plan），直接对话发起任务，Agent 自动调用工具完成编码。
- 开发环境仅需 Bun 1.3+，`bun install && bun dev` 即可启动，Bun 原生执行 TypeScript 无需编译。
- 推荐使用 plan → build 的两阶段工作流：先用只读 Agent 分析和规划，再用全功能 Agent 执行实现，两者共享 Session 上下文可反复切换。
