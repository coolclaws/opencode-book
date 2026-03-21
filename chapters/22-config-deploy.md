# 第 22 章　配置体系与生产部署

OpenCode 拥有一套精心设计的多层配置体系，支持从个人开发到企业级部署的各种场景。本章将全面解析配置文件的加载优先级、变量替换机制、权限系统、依赖管理以及生产环境部署方案。

## 22.1 配置文件体系

### 22.1.1 核心配置 Schema

OpenCode 使用 JSONC（带注释的 JSON）格式，主配置文件为 `opencode.json` 或 `opencode.jsonc`。配置 schema 使用 Zod 定义，所有字段都是可选的：

> **源码位置**：`packages/opencode/src/config/config.ts`

```typescript
// 文件: packages/opencode/src/config/config.ts L43-76
export namespace Config {
  const ModelId = z.string().meta({
    $ref: "https://models.dev/model-schema.json#/$defs/Model"
  })

  export const Agent = z.object({
    model: ModelId.optional(),
    variant: z.string().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    prompt: z.string().optional(),
    disable: z.boolean().optional(),
    description: z.string().optional(),
    mode: z.enum(["subagent", "primary", "all"]).optional(),
    hidden: z.boolean().optional(),
    options: z.record(z.string(), z.any()).optional(),
    color: z.union([
      z.string().regex(/^#[0-9a-fA-F]{6}$/),
      z.enum(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
    ]).optional(),
  })
}
```

`ModelId` 通过 `z.string().meta()` 引用了 `models.dev` 的 JSON Schema 定义，使得编辑器可以提供模型名称的自动补全。Agent 配置中的 `mode` 字段决定 Agent 的运行模式：`"primary"` 是主 Agent，`"subagent"` 是可被主 Agent 调用的子 Agent，`"all"` 则两者皆可。`color` 字段支持十六进制色值或语义化的主题色名称，用于在 UI 中区分不同的 Agent。

### 22.1.2 七层配置加载优先级

OpenCode 的配置来源有严格的优先级顺序，实现在 `Config.state` 的初始化函数中：

> **源码位置**：`packages/opencode/src/config/config.ts`

```typescript
// 文件: packages/opencode/src/config/config.ts L81-88
// Config loading order (low -> high precedence):
// 1) Remote .well-known/opencode (org defaults)
// 2) Global config (~/.config/opencode/opencode.json{,c})
// 3) Custom config (OPENCODE_CONFIG)
// 4) Project config (opencode.json{,c})
// 5) .opencode directories
// 6) Inline config (OPENCODE_CONFIG_CONTENT)
// Managed config directory is enterprise-only (highest priority)
```

| 优先级 | 来源 | 路径 | 用途 |
|-------|------|------|------|
| 1 (最低) | 远程配置 | `.well-known/opencode` | 组织级默认值 |
| 2 | 全局配置 | `~/.config/opencode/opencode.json` | 个人偏好 |
| 3 | 自定义路径 | `OPENCODE_CONFIG` 环境变量 | 特殊场景 |
| 4 | 项目配置 | `./opencode.json` | 项目级设置 |
| 5 | .opencode 目录 | `.opencode/opencode.json` | Agent、Command、Plugin |
| 6 | 内联配置 | `OPENCODE_CONFIG_CONTENT` | CI/CD 注入 |
| 7 (最高) | 企业管理 | 系统级目录 | 管理员强制 |

数组类型字段在合并时追加而非替换，通过 `mergeConfigConcatArrays` 实现：

```typescript
// 文件: packages/opencode/src/config/config.ts L67-76
function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeDeep(target, source)
  if (target.plugin && source.plugin) {
    merged.plugin = Array.from(new Set([...target.plugin, ...source.plugin]))
  }
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(
      new Set([...target.instructions, ...source.instructions])
    )
  }
  return merged
}
```

使用 `Set` 去重确保同一个插件不会被重复加载。对于对象类型字段（如 `agent`、`provider`、`mcp`），使用 `mergeDeep` 进行深度合并——低优先级源的字段被保留，高优先级源的同名字段覆盖。

### 22.1.3 变量替换系统

配置文件支持 `{env:VAR}` 和 `{file:path}` 两种变量替换，在 JSONC 解析前执行：

> **源码位置**：`packages/opencode/src/config/paths.ts`

```typescript
// 文件: packages/opencode/src/config/paths.ts L85-141
async function substitute(text: string, input: ParseSource,
    missing: "error" | "empty" = "error") {
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
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(configDir, filePath)
    const fileContent = await Filesystem.readText(resolvedPath)
    out += JSON.stringify(fileContent).slice(1, -1)  // 转义特殊字符
  }
  return out
}
```

`substitute` 函数有几个值得注意的细节。`{file:}` 引用的内容通过 `JSON.stringify().slice(1, -1)` 处理，自动转义换行符和引号等 JSON 特殊字符，确保嵌入后不破坏 JSON 结构。JSONC 注释中的变量引用会被跳过——通过检测 `prefix.startsWith("//")` 判断当前行是否为注释行。`missing` 参数控制文件不存在时的行为：`"error"` 模式抛出 `InvalidError`（默认），`"empty"` 模式返回空字符串（用于可选的密钥文件）。路径解析支持 `~/` 前缀（展开为 home 目录）和相对路径（相对于配置文件所在目录解析）。

### 22.1.4 .opencode 目录与依赖管理

`.opencode/` 目录是项目级扩展的核心。OpenCode 会自动管理该目录的依赖安装：

```typescript
// 文件: packages/opencode/src/config/config.ts L273-324
export async function installDependencies(dir: string) {
  const pkg = path.join(dir, "package.json")
  const targetVersion = Installation.isLocal() ? "*" : Installation.VERSION

  const json = await Filesystem.readJson<{
    dependencies?: Record<string, string>
  }>(pkg).catch(() => ({ dependencies: {} }))
  json.dependencies = {
    ...json.dependencies,
    "@opencode-ai/plugin": targetVersion,  // 自动注入 Plugin SDK
  }
  await Filesystem.writeJson(pkg, json)

  const gitignore = path.join(dir, ".gitignore")
  const hasGitIgnore = await Filesystem.exists(gitignore)
  if (!hasGitIgnore)
    await Filesystem.write(gitignore,
      ["node_modules", "package.json", "bun.lock", ".gitignore"].join("\n"))

  using _ = await Lock.write("bun-install")
  await BunProc.run(["install"], { cwd: dir })
}
```

依赖安装有几个精巧的设计。`targetVersion` 在本地开发环境下使用 `"*"`（通配符），在正式安装中使用 `Installation.VERSION`（当前 OpenCode 版本号），确保 Plugin SDK 版本与 OpenCode 运行时匹配。自动生成的 `.gitignore` 排除了 `node_modules`、`package.json` 和 `bun.lock`——这些都是自动生成的文件，不应提交到版本控制。`Lock.write("bun-install")` 获取写锁防止多个实例同时执行 `bun install` 导致文件冲突。安装前通过 `needsInstall` 检查是否真的需要重新安装：检查 `node_modules` 是否存在、`@opencode-ai/plugin` 版本是否匹配、通过 `PackageRegistry.isOutdated` 查询 npm 注册表判断缓存版本是否过期。

### 22.1.5 插件去重机制

当多个配置源声明了同一个插件时，OpenCode 使用基于优先级的去重算法：

```typescript
// 文件: packages/opencode/src/config/config.ts L543-561
export function deduplicatePlugins(plugins: string[]): string[] {
  const seenNames = new Set<string>()
  const uniqueSpecifiers: string[] = []

  for (const specifier of plugins.toReversed()) {
    const name = getPluginName(specifier)
    if (!seenNames.has(name)) {
      seenNames.add(name)
      uniqueSpecifiers.push(specifier)
    }
  }
  return uniqueSpecifiers.toReversed()
}
```

插件按低到高优先级顺序收集，反转后从高优先级开始去重，最后再反转恢复原始顺序。`getPluginName` 从 `file://` URL 中提取文件名、从 npm 包标识符中提取包名（去掉 `@version` 后缀），确保不同版本号的同名插件只保留高优先级那个。

## 22.2 权限配置

### 22.2.1 细粒度权限模型

OpenCode 的权限系统支持按工具和模式（glob 匹配）精细控制：

```typescript
// 文件: packages/opencode/src/config/config.ts L661-692
export const Permission = z.preprocess(
  permissionPreprocess,
  z.object({
    read: PermissionRule.optional(),
    edit: PermissionRule.optional(),
    glob: PermissionRule.optional(),
    grep: PermissionRule.optional(),
    bash: PermissionRule.optional(),
    task: PermissionRule.optional(),
    external_directory: PermissionRule.optional(),
    todowrite: PermissionAction.optional(),
    webfetch: PermissionAction.optional(),
    websearch: PermissionAction.optional(),
    codesearch: PermissionAction.optional(),
    lsp: PermissionRule.optional(),
    doom_loop: PermissionAction.optional(),
    skill: PermissionRule.optional(),
  }).catchall(PermissionRule).or(PermissionAction),
).transform(permissionTransform)
```

`PermissionRule` 是 `PermissionAction | PermissionObject` 的联合类型——既可以是简单的 `"allow"` / `"ask"` / `"deny"` 字符串，也可以是按模式匹配的对象（如 `{ "src/**": "allow", "*": "ask" }`）。`permissionPreprocess` 和 `permissionTransform` 配合保留原始 key 顺序，这对 glob 匹配至关重要——先匹配的规则优先生效。整个 Permission 还可以直接设置为单个 `PermissionAction` 字符串（如 `"permission": "allow"`），此时所有工具都应用同一策略。

### 22.2.2 企业管理目录

企业部署可通过系统级目录强制配置，该目录的配置优先级最高：

```typescript
// 文件: packages/opencode/src/config/config.ts L48-58
function systemManagedConfigDir(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/opencode"
    case "win32":
      return path.join(
        process.env.ProgramData || "C:\\ProgramData", "opencode")
    default:
      return "/etc/opencode"
  }
}
```

管理员在此目录放置的 `opencode.json` 覆盖所有用户和项目配置。源码中特别注明：企业管理目录的加载与普通 `.opencode` 目录分离处理，不执行依赖安装——因为系统目录需要提升权限才能写入，执行 `bun install` 会失败。

## 22.3 配置文件搜索算法

OpenCode 使用向上遍历算法搜索配置文件和 `.opencode` 目录：

> **源码位置**：`packages/opencode/src/config/paths.ts`

```typescript
// 文件: packages/opencode/src/config/paths.ts L22-43
export async function directories(directory: string, worktree: string) {
  return [
    Global.Path.config,                    // ~/.config/opencode
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? await Array.fromAsync(
          Filesystem.up({                  // 从当前目录向上搜索 .opencode
            targets: [".opencode"],
            start: directory,
            stop: worktree,                // 到 Git 根目录停止
          }),
        )
      : []),
    ...(await Array.fromAsync(
      Filesystem.up({                      // 从 HOME 搜索 .opencode
        targets: [".opencode"],
        start: Global.Path.home,
        stop: Global.Path.home,
      }),
    )),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ]
}
```

`Filesystem.up` 从 `start` 目录开始向父目录逐级搜索 `.opencode` 目录，到 `stop`（Git worktree 根目录）为止。这意味着在 monorepo 结构中，子包目录里的 `.opencode/` 配置优先于根目录的 `.opencode/` 配置。`OPENCODE_DISABLE_PROJECT_CONFIG` 标志可以跳过项目级配置搜索，适用于需要隔离项目配置影响的场景。

Agent 和 Command 的加载同样使用文件系统扫描，支持嵌套目录结构：

```typescript
// 文件: packages/opencode/src/config/config.ts L384-420
async function loadCommand(dir: string) {
  const result: Record<string, Command> = {}
  for (const item of await Glob.scan("{command,commands}/**/*.md", {
    cwd: dir, absolute: true, dot: true, symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item)
    const patterns = [
      "/.opencode/command/", "/.opencode/commands/",
      "/command/", "/commands/"
    ]
    const file = rel(item, patterns) ?? path.basename(item)
    const name = trim(file)  // 去掉扩展名作为命令名
    result[config.name] = parsed.data
  }
  return result
}
```

命令名从文件路径推导——`commands/deploy.md` 的命令名为 `deploy`，`commands/ci/lint.md` 的命令名为 `ci/lint`，支持目录层级作为命名空间。

## 22.4 生产环境部署

### 22.4.1 服务端启动与 mDNS

OpenCode 服务端支持灵活的监听配置和局域网服务发现：

```typescript
// 文件: packages/opencode/src/server/server.ts L536-579
export function listen(opts: {
  port: number; hostname: string;
  mdns?: boolean; mdnsDomain?: string; cors?: string[]
}) {
  const tryServe = (port: number) => {
    try { return Bun.serve({ ...args, port }) }
    catch { return undefined }
  }
  const server = opts.port === 0
    ? (tryServe(4096) ?? tryServe(0))  // 优先尝试 4096 端口
    : tryServe(opts.port)

  const shouldPublishMDNS =
    opts.mdns && server.port &&
    opts.hostname !== "127.0.0.1" &&
    opts.hostname !== "localhost"
  if (shouldPublishMDNS) MDNS.publish(server.port!, opts.mdnsDomain)
}
```

端口 `0` 的处理逻辑是先尝试 4096（OpenCode 的默认端口），失败后退回到操作系统随机分配。mDNS 发布仅在监听非回环地址时生效——监听 `localhost` 时发布 mDNS 没有意义，因为只有本机可以访问。

### 22.4.2 CI/CD 集成

OpenCode 可以在 CI 流水线中以非交互模式运行，`OPENCODE_CONFIG_CONTENT` 环境变量是 CI/CD 集成的核心：

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
        run: curl -fsSL https://get.opencode.ai | bash
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
        run: opencode run "Review the changes in this PR"
```

`OPENCODE_CONFIG_CONTENT` 的优先级仅次于企业管理目录，这意味着它会覆盖项目仓库中 `opencode.json` 的配置——CI 环境可以设置 `"permission": "allow"` 跳过所有交互式确认，而不需要修改仓库代码。

### 22.4.3 Docker 部署

```dockerfile
FROM oven/bun:latest
RUN bun install -g opencode
RUN apt-get update && apt-get install -y git ripgrep \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY opencode.json ./
COPY .opencode/ ./.opencode/
ENV OPENCODE_SERVER_PASSWORD=${OPENCODE_SERVER_PASSWORD}
EXPOSE 4096
CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
```

### 22.4.4 远程配置分发

通过 `.well-known/opencode` 端点分发组织默认配置，配合 wellknown 认证类型实现自动 token 注入：

```typescript
// 文件: packages/opencode/src/config/config.ts L90-111
for (const [key, value] of Object.entries(auth)) {
  if (value.type === "wellknown") {
    const url = key.replace(/\/+$/, "")
    process.env[value.key] = value.token
    const response = await fetch(`${url}/.well-known/opencode`)
    const wellknown = (await response.json()) as any
    const remoteConfig = wellknown.config ?? {}
    result = mergeConfigConcatArrays(result,
      await load(JSON.stringify(remoteConfig), { dir: ..., source: ... }))
  }
}
```

远程配置加载时自动将认证 token 注入环境变量，下游的 Provider 配置可以通过 `{env:OPENCODE_CONSOLE_TOKEN}` 引用这个 token，无需用户手动管理。

### 22.4.5 配置优先级汇总

```text
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

## 22.5 本章要点

- **七层配置优先级**：从远程 `.well-known` 到企业管理目录，层层覆盖，既支持组织级默认又允许个人自定义
- **JSONC 格式 + 变量替换**：`{env:VAR}` 读取环境变量，`{file:path}` 内联文件内容，注释行中的变量引用被自动跳过
- **依赖管理自动化**：`.opencode/` 目录的 `package.json` 和 `@opencode-ai/plugin` 版本自动维护，通过写锁防止并发安装冲突
- **插件去重按优先级**：高优先级配置源的同名插件覆盖低优先级的，通过 `getPluginName` 规范化名称进行匹配
- **细粒度权限系统**：每个工具可按路径模式配置 `allow`/`ask`/`deny`，保留原始 key 顺序确保 glob 匹配优先级正确
- **生产部署支持多种模式**：Docker 容器化、CI/CD 非交互运行（`OPENCODE_CONFIG_CONTENT`）、mDNS 局域网发现、远程 `.well-known` 配置分发
