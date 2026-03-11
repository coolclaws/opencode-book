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

### 3.1.3 桌面应用

OpenCode 还提供了桌面应用（Beta），支持 macOS（Apple Silicon / Intel）、Windows 和 Linux：

```bash
# macOS
brew install --cask opencode-desktop

# Windows
scoop bucket add extras; scoop install extras/opencode-desktop
```

也可以直接从 [releases 页面](https://github.com/anomalyco/opencode/releases) 下载安装包。

## 3.2 首次运行与配置

安装完成后，在任意项目目录下运行：

```bash
cd /path/to/your/project
opencode
```

OpenCode 会自动检测当前目录为工作区，启动 Instance 并初始化所有子系统。首次运行时需要配置 LLM 提供商。

### 3.2.1 配置文件

OpenCode 的配置采用多级合并策略，优先级从低到高：

1. 远程 `.well-known/opencode`（组织默认配置）
2. 全局配置 `~/.config/opencode/config.json`
3. 项目配置 `.opencode/config.json`
4. 系统管理配置（企业部署用）

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

OpenCode 支持的提供商列表非常丰富，包括 Anthropic、OpenAI、Google、Azure、AWS Bedrock、xAI、Groq、Mistral、OpenRouter 等。配置好 API key 后即可使用对应的模型。

### 3.2.2 OpenCode Zen

如果你不想自己配置 API key，OpenCode 官方提供了 [OpenCode Zen](https://opencode.ai/zen) 服务，一站式提供模型访问，开箱即用。

## 3.3 基本使用流程

OpenCode 启动后会进入 TUI 界面，基本工作流程如下：

**开始对话**：直接在输入框中输入问题或指令。例如："帮我阅读 src/main.ts 并解释它的功能"。

**Agent 切换**：使用 `Tab` 键在 `build`（构建模式）和 `plan`（计划模式）之间切换：
- **build Agent**：默认模式，拥有完整的工具权限，可以读写文件、执行命令。
- **plan Agent**：只读模式，禁止编辑操作，适合代码分析和方案规划。

**子 Agent 调用**：在消息中使用 `@general` 可以调用通用子 Agent 来执行复杂的多步骤任务。

**工具授权**：根据权限配置，某些操作（如执行 bash 命令、访问外部目录）会弹出确认提示。你可以在配置文件中预设权限规则来简化工作流。

**Session 管理**：每次对话都会自动持久化为 Session，下次启动时可以恢复之前的对话上下文。

## 3.4 开发环境搭建

如果你想参与 OpenCode 的开发或调试源码，需要搭建本地开发环境。

### 3.4.1 前置要求

- **Bun 1.3+**：OpenCode 的运行时环境。安装方式参见 [bun.sh](https://bun.sh)。
- **Git**：版本控制。

### 3.4.2 克隆与启动

```bash
# 克隆仓库
git clone https://github.com/anomalyco/opencode.git
cd opencode

# 安装所有依赖
bun install

# 启动开发模式
bun dev
```

`bun dev` 实际执行的是 `bun run --conditions=browser ./src/index.ts`，直接运行 TypeScript 源码，无需编译步骤。默认工作目录为 `packages/opencode`。

### 3.4.3 常用开发命令

```bash
# 在指定目录运行 OpenCode
bun dev /path/to/target/project

# 在 opencode 仓库根目录运行（用 OpenCode 开发 OpenCode）
bun dev .

# 运行测试
bun test

# 类型检查
bun run typecheck

# 编译独立可执行文件
./packages/opencode/script/build.ts --single

# 数据库迁移（Drizzle）
bun run db
```

### 3.4.4 项目结构快速导航

开发时最常接触的目录：

- `packages/opencode/src/agent/` — Agent 定义，修改或添加 Agent
- `packages/opencode/src/tool/` — 内置工具，每个工具一个 `.ts` + `.txt` 文件
- `packages/opencode/src/session/` — 对话管理核心逻辑
- `packages/opencode/src/cli/cmd/tui/` — TUI 界面代码（SolidJS + opentui）
- `packages/opencode/src/provider/` — 添加或修改 LLM 提供商支持

## 3.5 实战：用 OpenCode 完成第一个编程任务

让我们通过一个具体的例子，体验 OpenCode 的完整工作流。假设你有一个 Node.js 项目，需要添加一个新的 API 端点。

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

`plan` Agent 会在只读模式下分析代码，输出详细的实现方案，而不会修改任何文件。

**第四步：切换回 build 模式执行实现**

再按 `Tab` 切换回 `build` Agent：

```
请按照刚才的方案实现 GET /api/users/:id 端点
```

`build` Agent 会调用 `edit`、`write` 等工具创建和修改文件，调用 `bash` 工具运行测试，确保实现正确。每个需要权限确认的操作都会提示你审批。

**第五步：验证结果**

```
运行测试确认新端点工作正常
```

Agent 会执行项目的测试命令并报告结果。

整个过程中，所有对话历史和文件变更都被记录在 Session 中，你可以随时回顾和恢复。

## 本章要点

- OpenCode 支持多种安装方式：curl 脚本一键安装、npm/brew/scoop 等包管理器安装，以及桌面应用。
- 配置采用多级合并策略（远程 → 全局 → 项目 → 系统管理），使用 JSONC 格式，核心是配置 LLM 提供商的 API key。
- 基本工作流：`Tab` 切换 Agent（build/plan），直接对话发起任务，Agent 自动调用工具完成编码。
- 开发环境仅需 Bun 1.3+，`bun install && bun dev` 即可启动，Bun 原生执行 TypeScript 无需编译。
- 推荐使用 plan → build 的两阶段工作流：先用只读 Agent 分析和规划，再用全功能 Agent 执行实现。
