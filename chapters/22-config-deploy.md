# 第 22 章　配置体系与生产部署

OpenCode 拥有一套精心设计的多层配置体系，支持从个人开发到企业级部署的各种场景。本章将全面解析配置文件的加载优先级、环境变量、权限系统、数据存储以及生产环境部署方案。

## 22.1 配置文件体系

### 22.1.1 核心配置文件

OpenCode 使用 JSONC（带注释的 JSON）格式，主配置文件为 `opencode.json` 或 `opencode.jsonc`。

> **源码位置**：`packages/opencode/src/config/config.ts`

```typescript
export const Info = z.object({
  $schema: z.string().optional(),
  logLevel: Log.Level.optional(),
  server: Server.optional(),
  command: z.record(z.string(), Command).optional(),
  skills: Skills.optional(),
  plugin: z.string().array().optional(),
  model: ModelId.optional(),
  small_model: ModelId.optional(),
  default_agent: z.string().optional(),
  username: z.string().optional(),
  agent: z.object({
    plan: Agent.optional(),
    build: Agent.optional(),
    general: Agent.optional(),
    explore: Agent.optional(),
    title: Agent.optional(),
    summary: Agent.optional(),
    compaction: Agent.optional(),
  }).catchall(Agent).optional(),
  provider: z.record(z.string(), Provider).optional(),
  mcp: z.record(z.string(), Mcp).optional(),
  permission: Permission.optional(),
  compaction: z.object({
    auto: z.boolean().optional(),
    prune: z.boolean().optional(),
    reserved: z.number().int().min(0).optional(),
  }).optional(),
  // ... 更多字段
})
```

### 22.1.2 配置加载优先级

OpenCode 的配置来源有严格的优先级顺序（低 → 高）：

> **源码位置**：`packages/opencode/src/config/config.ts`

```typescript
// Config loading order (low -> high precedence):
// 1) Remote .well-known/opencode (org defaults)
// 2) Global config (~/.config/opencode/opencode.json{,c})
// 3) Custom config (OPENCODE_CONFIG)
// 4) Project config (opencode.json{,c})
// 5) .opencode directories
// 6) Inline config (OPENCODE_CONFIG_CONTENT)
// Managed config directory is enterprise-only (highest priority)
```

层级解析：

| 优先级 | 来源 | 路径 | 用途 |
|-------|------|------|------|
| 1 (最低) | 远程配置 | `.well-known/opencode` | 组织级默认值 |
| 2 | 全局配置 | `~/.config/opencode/opencode.json` | 个人偏好 |
| 3 | 自定义路径 | `OPENCODE_CONFIG` 环境变量 | 特殊场景 |
| 4 | 项目配置 | `./opencode.json` | 项目级设置 |
| 5 | .opencode 目录 | `.opencode/opencode.json` | Agent、Command、Plugin |
| 6 | 内联配置 | `OPENCODE_CONFIG_CONTENT` | CI/CD 注入 |
| 7 (最高) | 企业管理 | `/etc/opencode/` 或 `/Library/Application Support/opencode/` | 管理员强制 |

数组类型字段（`plugin`、`instructions`）在合并时**追加**而非替换：

```typescript
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

### 22.1.3 .opencode 目录结构

`.opencode/` 目录是项目级扩展的核心：

```
.opencode/
├── opencode.json       # 项目配置（合并到主配置）
├── tui.json            # TUI 界面配置
├── agents/             # 自定义 Agent
│   ├── build.md
│   └── review.md
├── commands/           # 自定义命令
│   ├── deploy.md
│   └── test.md
├── skills/             # 技能文件
│   └── react/
│       └── SKILL.md
├── plugins/            # 本地插件
│   └── my-plugin.ts
├── node_modules/       # 自动安装的依赖
├── package.json        # 自动生成
└── .gitignore          # 自动生成
```

OpenCode 会自动管理 `.opencode/` 目录的依赖安装：

```typescript
export async function installDependencies(dir: string) {
  const json = await Filesystem.readJson<{ dependencies?: Record<string, string> }>(pkg)
  json.dependencies = {
    ...json.dependencies,
    "@opencode-ai/plugin": targetVersion,  // 自动注入 Plugin SDK
  }
  await Filesystem.writeJson(pkg, json)
  await BunProc.run(["install"], { cwd: dir })
}
```

### 22.1.4 TUI 专用配置

TUI 界面有独立的配置文件 `tui.json`：

> **源码位置**：`packages/opencode/src/config/tui-schema.ts`

```typescript
export const TuiInfo = z.object({
  $schema: z.string().optional(),
  theme: z.string().optional(),           // 主题名称
  keybinds: KeybindOverride.optional(),   // 快捷键覆盖
  scroll_speed: z.number().min(0.001).optional(),
  scroll_acceleration: z.object({
    enabled: z.boolean(),
  }).optional(),
  diff_style: z.enum(["auto", "stacked"]).optional(),
})
```

### 22.1.5 配置中的变量替换

配置文件支持 `{env:VAR}` 和 `{file:path}` 两种变量替换：

> **源码位置**：`packages/opencode/src/config/paths.ts`

```typescript
async function substitute(text: string, input: ParseSource) {
  // 环境变量替换：{env:GITHUB_TOKEN} → 实际值
  text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
    return process.env[varName] || ""
  })

  // 文件内容替换：{file:./secret.txt} → 文件内容
  const fileMatches = Array.from(text.matchAll(/\{file:[^}]+\}/g))
  for (const match of fileMatches) {
    let filePath = match[0].replace(/^\{file:/, "").replace(/\}$/, "")
    if (filePath.startsWith("~/")) {
      filePath = path.join(os.homedir(), filePath.slice(2))
    }
    const content = await Filesystem.readText(path.resolve(configDir, filePath))
    // 替换为文件内容
  }
}
```

配置示例：

```jsonc
{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "{env:ANTHROPIC_API_KEY}"       // 从环境变量读取
      }
    },
    "custom": {
      "options": {
        "apiKey": "{file:~/.secrets/custom.key}"  // 从文件读取
      }
    }
  }
}
```

## 22.2 环境变量

### 22.2.1 核心环境变量

OpenCode 通过 `Flag` 模块统一管理环境变量：

| 环境变量 | 作用 | 默认值 |
|---------|------|-------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | - |
| `OPENAI_API_KEY` | OpenAI API 密钥 | - |
| `OPENCODE_CONFIG` | 自定义配置文件路径 | - |
| `OPENCODE_CONFIG_CONTENT` | 内联配置 JSON | - |
| `OPENCODE_CONFIG_DIR` | 额外配置目录 | - |
| `OPENCODE_TUI_CONFIG` | TUI 配置文件路径 | - |
| `OPENCODE_SERVER_PASSWORD` | HTTP API 密码 | - |
| `OPENCODE_SERVER_USERNAME` | HTTP API 用户名 | `opencode` |
| `OPENCODE_PERMISSION` | 权限配置 JSON | - |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | 禁用项目配置 | `false` |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS` | 禁用内置插件 | `false` |
| `OPENCODE_DISABLE_AUTOCOMPACT` | 禁用自动压缩 | `false` |
| `OPENCODE_DISABLE_PRUNE` | 禁用消息裁剪 | `false` |
| `OPENCODE_DISABLE_TERMINAL_TITLE` | 禁用终端标题设置 | `false` |

### 22.2.2 企业管理目录

企业部署可通过系统级目录强制配置：

```typescript
function systemManagedConfigDir(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/opencode"
    case "win32":
      return path.join(
        process.env.ProgramData || "C:\\ProgramData",
        "opencode",
      )
    default:
      return "/etc/opencode"
  }
}
```

管理员在此目录放置的 `opencode.json` 具有**最高优先级**，覆盖所有用户和项目配置。

## 22.3 权限配置

### 22.3.1 权限模型

OpenCode 的权限系统细粒度地控制每个工具的行为：

```typescript
export const Permission = z.preprocess(
  permissionPreprocess,
  z.object({
    read: PermissionRule.optional(),
    edit: PermissionRule.optional(),
    glob: PermissionRule.optional(),
    grep: PermissionRule.optional(),
    list: PermissionRule.optional(),
    bash: PermissionRule.optional(),
    task: PermissionRule.optional(),
    external_directory: PermissionRule.optional(),
    todowrite: PermissionAction.optional(),
    webfetch: PermissionAction.optional(),
    websearch: PermissionAction.optional(),
    lsp: PermissionRule.optional(),
    doom_loop: PermissionAction.optional(),
    skill: PermissionRule.optional(),
  }).catchall(PermissionRule).or(PermissionAction),
)

// 三种权限动作
export const PermissionAction = z.enum(["ask", "allow", "deny"])
```

### 22.3.2 权限配置示例

```jsonc
{
  "permission": {
    // 全局默认：需要确认
    "*": "ask",

    // 文件读取：允许项目内文件，其他需确认
    "read": {
      "*": "allow",
      "/etc/**": "deny"
    },

    // 文件编辑：src 目录允许，其他确认
    "edit": {
      "src/**": "allow",
      "*": "ask"
    },

    // Bash 命令：测试命令允许，其他确认
    "bash": {
      "bun test*": "allow",
      "git *": "allow",
      "rm *": "deny",
      "*": "ask"
    },

    // 完全禁用某些工具
    "webfetch": "deny",
    "doom_loop": "deny"
  }
}
```

### 22.3.3 Agent 级别权限

每个 Agent 可以有独立的权限配置：

```jsonc
{
  "agent": {
    "build": {
      "prompt": "You are a build agent...",
      "permission": {
        "bash": "allow",
        "edit": "allow"
      }
    },
    "plan": {
      "prompt": "You are a planning agent...",
      "permission": {
        "bash": "deny",
        "edit": "deny",
        "read": "allow"
      }
    }
  }
}
```

## 22.4 数据存储位置

### 22.4.1 目录结构

OpenCode 的运行时数据存储在平台标准目录：

```
~/.local/share/opencode/        # Linux/macOS（XDG_DATA_HOME）
├── data.db                     # SQLite 数据库（会话、消息）
├── data.db-wal                 # WAL 日志
├── skills/                     # 缓存的远程 Skill
└── log/                        # 日志文件

~/.config/opencode/             # 配置目录（XDG_CONFIG_HOME）
├── opencode.json               # 全局配置
├── tui.json                    # TUI 配置
├── agents/                     # 全局 Agent
├── commands/                   # 全局 Command
├── skills/                     # 全局 Skill
└── plugins/                    # 全局 Plugin

~/.cache/opencode/              # 缓存目录（XDG_CACHE_HOME）
└── skills/                     # 远程 Skill 下载缓存
```

### 22.4.2 SQLite 数据库

OpenCode 使用 SQLite 存储所有持久化数据，通过 Drizzle ORM 进行数据库操作和迁移管理。主要表结构包括：

- **session**：会话元数据（标题、创建时间、模型信息）
- **message**：消息记录（用户消息、助手回复）
- **part**：消息的子部件（文本、工具调用、推理过程）
- **snapshot**：文件快照（用于 undo/redo）

### 22.4.3 配置文件搜索算法

OpenCode 使用向上遍历算法搜索配置文件：

> **源码位置**：`packages/opencode/src/config/paths.ts`

```typescript
export async function directories(directory: string, worktree: string) {
  return [
    Global.Path.config,                      // ~/.config/opencode
    ...await Array.fromAsync(
      Filesystem.up({                        // 从当前目录向上搜索 .opencode
        targets: [".opencode"],
        start: directory,
        stop: worktree,                      // 到 Git 根目录停止
      }),
    ),
    ...await Array.fromAsync(
      Filesystem.up({                        // 从 HOME 搜索 .opencode
        targets: [".opencode"],
        start: Global.Path.home,
        stop: Global.Path.home,
      }),
    ),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ]
}
```

## 22.5 生产环境部署考量

### 22.5.1 服务端模式

OpenCode 支持以独立服务端模式运行，供多客户端连接：

```bash
# 基本启动
opencode serve --port 4096

# 带认证保护
OPENCODE_SERVER_PASSWORD=secure123 opencode serve --port 4096 --hostname 0.0.0.0

# 配置 CORS
# opencode.json
{
  "server": {
    "port": 4096,
    "hostname": "0.0.0.0",
    "cors": ["https://myapp.example.com"],
    "mdns": true,
    "mdnsDomain": "opencode.local"
  }
}
```

### 22.5.2 Docker 部署

```dockerfile
FROM oven/bun:latest

# 安装 OpenCode
RUN bun install -g opencode

# 安装运行时依赖
RUN apt-get update && apt-get install -y \
    git \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# 配置目录
WORKDIR /workspace

# 复制项目配置
COPY opencode.json ./
COPY .opencode/ ./.opencode/

# 环境变量
ENV OPENCODE_SERVER_PASSWORD=${OPENCODE_SERVER_PASSWORD}
ENV ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}

# 启动服务
EXPOSE 4096
CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
```

### 22.5.3 CI/CD 集成

OpenCode 可以在 CI 流水线中以非交互模式运行：

```yaml
# GitHub Actions 示例
name: OpenCode Review
on: [pull_request]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install OpenCode
        run: |
          curl -fsSL https://get.opencode.ai | bash

      - name: Run Code Review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENCODE_CONFIG_CONTENT: |
            {
              "permission": "allow",
              "agent": {
                "build": {
                  "prompt": "Review the PR changes and provide feedback."
                }
              }
            }
        run: |
          opencode run "Review the changes in this PR and report any issues"
```

### 22.5.4 mDNS 服务发现

OpenCode 服务端支持 mDNS（Bonjour）服务发现，Desktop 客户端可以自动发现局域网内的 OpenCode 实例：

```json
{
  "server": {
    "mdns": true,
    "mdnsDomain": "opencode.local"
  }
}
```

## 22.6 实战：企业级 OpenCode 部署方案

### 场景：为 50 人开发团队部署 OpenCode

### 步骤一：管理员配置

在系统管理目录放置强制配置：

```bash
# macOS
sudo mkdir -p "/Library/Application Support/opencode"
sudo cat > "/Library/Application Support/opencode/opencode.json" << 'EOF'
{
  "permission": {
    "bash": {
      "rm -rf *": "deny",
      "sudo *": "deny",
      "*": "ask"
    },
    "webfetch": "deny"
  },
  "disabled_providers": ["openrouter"],
  "compaction": {
    "auto": true,
    "prune": true
  }
}
EOF
```

### 步骤二：项目级配置

在代码仓库中提交 `.opencode/` 目录：

```jsonc
// .opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-20250514",
  "agent": {
    "build": {
      "prompt": "Follow our team coding standards in CONVENTIONS.md"
    }
  },
  "mcp": {
    "jira": {
      "type": "remote",
      "url": "https://mcp.internal.example.com/jira"
    }
  },
  "skills": {
    "urls": ["https://skills.internal.example.com/.well-known/skills/"]
  }
}
```

### 步骤三：远程配置分发

通过 `.well-known/opencode` 端点分发组织默认配置：

```json
// https://internal.example.com/.well-known/opencode
{
  "config": {
    "provider": {
      "anthropic": {
        "options": {
          "baseURL": "https://api-proxy.internal.example.com/anthropic"
        }
      }
    }
  }
}
```

### 步骤四：监控与日志

```bash
# 设置日志级别
export OPENCODE_LOG_LEVEL=info

# 日志输出位置
# ~/.local/share/opencode/log/

# 启用 OpenTelemetry（实验性）
{
  "experimental": {
    "openTelemetry": true
  }
}
```

### 配置优先级汇总

```
管理员强制配置（最高）
  ↓ 覆盖
内联配置（OPENCODE_CONFIG_CONTENT）
  ↓ 覆盖
.opencode 目录配置
  ↓ 覆盖
项目 opencode.json
  ↓ 覆盖
自定义路径（OPENCODE_CONFIG）
  ↓ 覆盖
全局 ~/.config/opencode/opencode.json
  ↓ 覆盖
远程 .well-known/opencode（最低）
```

## 22.7 本章要点

- **七层配置优先级**：从远程 `.well-known` 到企业管理目录，层层覆盖，既支持组织级默认又允许个人自定义
- **JSONC 格式 + 变量替换**：配置文件支持注释，`{env:VAR}` 读取环境变量，`{file:path}` 内联文件内容，避免在配置中硬编码敏感信息
- **细粒度权限系统**：每个工具可按路径模式配置 `allow`/`ask`/`deny`，Agent 级别可独立覆盖权限，企业管理员可通过系统目录强制安全策略
- **`.opencode/` 目录是项目级扩展的核心**：Agent、Command、Skill、Plugin 均可通过文件系统组织，依赖自动安装，可提交到版本控制
- **生产部署支持多种模式**：Docker 容器化、CI/CD 非交互运行、mDNS 局域网发现、HTTP Basic Auth 保护，满足从个人到企业的部署需求
