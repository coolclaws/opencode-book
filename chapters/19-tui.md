# 第 19 章　TUI 终端界面

终端用户界面（TUI）是 OpenCode 最核心的交互方式。不同于 Claude Code 基于 Ink（React 的终端渲染器）构建的 TUI，OpenCode 选择了 **OpenTUI + SolidJS** 这一更高性能的组合。本章将深入分析 TUI 的架构设计、组件模型、键盘事件处理与流式渲染管线。

## 19.1 OpenTUI + SolidJS：终端中的响应式 UI

### 19.1.1 为什么不用 Ink？

Ink 是 React 在终端环境的移植，被 Claude Code 等工具广泛采用。然而，OpenCode 团队做出了不同的选择——基于 **OpenTUI** 这一自研终端 UI 框架，搭配 **SolidJS** 作为响应式层。

> **源码位置**：`packages/opencode/src/cli/cmd/tui/app.tsx`

```typescript
// OpenCode TUI 的核心依赖
import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Switch, Match, createEffect, createSignal, onMount, batch, Show } from "solid-js"
```

选择 OpenTUI + SolidJS 的原因：

| 维度 | Ink + React | OpenTUI + SolidJS |
|------|-----------|-------------------|
| 渲染模型 | Virtual DOM 全量 diff | 细粒度响应式，精准更新 |
| 帧率控制 | 无内置帧率管理 | 内置 targetFps 控制（默认 60fps） |
| 语法高亮 | 需额外集成 | 内置 Tree-sitter 解析器支持 |
| 鼠标支持 | 基础 | 原生鼠标事件、选择、复制 |
| Kitty 键盘协议 | 不支持 | 原生支持 |

### 19.1.2 SolidJS 的响应式优势

SolidJS 的细粒度响应式（fine-grained reactivity）非常适合 TUI 场景。当 LLM 流式输出文本时，只有新增的文本节点需要重新渲染，而非整棵组件树：

```typescript
// SolidJS 的 createEffect 只追踪实际读取的响应式值
createEffect(() => {
  // 当 route.data 变化时自动更新终端标题
  if (route.data.type === "session") {
    const session = sync.session.get(route.data.sessionID)
    const title = session.title.length > 40
      ? session.title.slice(0, 37) + "..."
      : session.title
    renderer.setTerminalTitle(`OC | ${title}`)
  }
})
```

## 19.2 界面布局

### 19.2.1 Provider 嵌套架构

OpenCode TUI 采用深度嵌套的 Provider 模式管理全局状态。`app.tsx` 中的 `tui()` 函数揭示了完整的 Provider 层次：

> **源码位置**：`packages/opencode/src/cli/cmd/tui/app.tsx`

```typescript
render(() => {
  return (
    <ErrorBoundary fallback={ErrorComponent}>
      <ArgsProvider {...input.args}>
        <ExitProvider onExit={onExit}>
          <KVProvider>
            <ToastProvider>
              <RouteProvider>
                <TuiConfigProvider config={input.config}>
                  <SDKProvider url={input.url}>
                    <SyncProvider>
                      <ThemeProvider mode={mode}>
                        <LocalProvider>
                          <KeybindProvider>
                            <PromptStashProvider>
                              <DialogProvider>
                                <CommandProvider>
                                  <FrecencyProvider>
                                    <PromptHistoryProvider>
                                      <PromptRefProvider>
                                        <App />
                                      </PromptRefProvider>
                                    </PromptHistoryProvider>
                                  </FrecencyProvider>
                                </CommandProvider>
                              </DialogProvider>
                            </PromptStashProvider>
                          </KeybindProvider>
                        </LocalProvider>
                      </ThemeProvider>
                    </SyncProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </RouteProvider>
            </ToastProvider>
          </KVProvider>
        </ExitProvider>
      </ArgsProvider>
    </ErrorBoundary>
  )
}, {
  targetFps: 60,          // 60 帧渲染
  exitOnCtrlC: false,     // 自行处理 Ctrl+C
  useKittyKeyboard: {},   // 启用 Kitty 键盘协议
})
```

这些 Provider 各有职责：

- **SDKProvider**：与后端 HTTP 服务通信
- **SyncProvider**：同步 session、message、provider 等状态
- **ThemeProvider**：主题管理，支持自动检测终端背景色
- **KeybindProvider**：键盘快捷键注册与匹配
- **DialogProvider**：模态对话框管理
- **CommandProvider**：命令面板（类似 VS Code 的 Ctrl+P）

### 19.2.2 路由与视图切换

TUI 仅有两个核心路由：**Home**（首页）和 **Session**（会话页面）。

> **源码位置**：`packages/opencode/src/cli/cmd/tui/context/route.tsx`

```typescript
export type HomeRoute = {
  type: "home"
  initialPrompt?: PromptInfo
  workspaceID?: string
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  initialPrompt?: PromptInfo
}

export type Route = HomeRoute | SessionRoute
```

视图切换通过 SolidJS 的 `Switch/Match` 实现：

```typescript
<Switch>
  <Match when={route.data.type === "home"}>
    <Home />
  </Match>
  <Match when={route.data.type === "session"}>
    <Session />
  </Match>
</Switch>
```

### 19.2.3 Session 页面布局

Session 页面是最复杂的界面，由以下区域组成：

```
┌─────────────────────────────────────────┐
│ Header: 标题 │ Token 数量 │ 费用        │
├─────────────────────────────────────────┤
│                                         │
│  消息列表区域（ScrollBox）               │
│  - 用户消息                             │
│  - 助手回复（含工具调用详情）            │
│  - 权限请求提示                         │
│                                         │
├─────────────────────────────────────────┤
│ Prompt 输入区域                         │
├─────────────────────────────────────────┤
│ Footer: 目录 │ LSP │ MCP │ 权限状态     │
└─────────────────────────────────────────┘
```

Footer 组件实时显示连接状态：

> **源码位置**：`packages/opencode/src/cli/cmd/tui/routes/session/footer.tsx`

```typescript
export function Footer() {
  const sync = useSync()
  const mcp = createMemo(() =>
    Object.values(sync.data.mcp).filter((x) => x.status === "connected").length
  )
  const lsp = createMemo(() => Object.keys(sync.data.lsp))

  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme.textMuted}>{directory()}</text>
      <box gap={2} flexDirection="row">
        <text>
          <span style={{ fg: lsp().length > 0 ? theme.success : theme.textMuted }}>•</span>
          {lsp().length} LSP
        </text>
        <text>
          <span style={{ fg: theme.success }}>⊙</span> {mcp()} MCP
        </text>
      </box>
    </box>
  )
}
```

## 19.3 键盘事件处理

### 19.3.1 Keybind 解析系统

OpenCode 实现了一套完整的快捷键系统，支持 **Leader Key** 模式（类似 Vim）。

> **源码位置**：`packages/opencode/src/util/keybind.ts`

```typescript
export namespace Keybind {
  // 快捷键信息结构
  export type Info = Pick<ParsedKey, "name" | "ctrl" | "meta" | "shift" | "super"> & {
    leader: boolean // Leader Key 模式标志
  }

  // 解析快捷键字符串为结构化对象
  export function parse(key: string): Info[] {
    if (key === "none") return [] // "none" 表示禁用

    return key.split(",").map((combo) => {
      const normalized = combo.replace(/<leader>/g, "leader+")
      const parts = normalized.toLowerCase().split("+")
      const info: Info = {
        ctrl: false, meta: false, shift: false, leader: false, name: "",
      }
      for (const part of parts) {
        switch (part) {
          case "ctrl": info.ctrl = true; break
          case "alt": case "meta": info.meta = true; break
          case "leader": info.leader = true; break
          default: info.name = part; break
        }
      }
      return info
    })
  }
}
```

### 19.3.2 默认快捷键配置

OpenCode 定义了大量快捷键，覆盖导航、编辑、会话管理等场景：

> **源码位置**：`packages/opencode/src/config/config.ts`

```typescript
export const Keybinds = z.object({
  leader:           z.string().default("ctrl+x"),          // Leader 键
  app_exit:         z.string().default("ctrl+c,ctrl+d,<leader>q"),
  session_new:      z.string().default("<leader>n"),       // 新建会话
  session_list:     z.string().default("<leader>l"),       // 会话列表
  model_list:       z.string().default("<leader>m"),       // 模型切换
  agent_list:       z.string().default("<leader>a"),       // Agent 切换
  agent_cycle:      z.string().default("tab"),             // Tab 循环 Agent
  command_list:     z.string().default("ctrl+p"),          // 命令面板
  session_compact:  z.string().default("<leader>c"),       // 上下文压缩
  input_submit:     z.string().default("return"),          // 提交输入
  input_newline:    z.string().default("shift+return,ctrl+return"),
  messages_page_up: z.string().default("pageup,ctrl+alt+b"),
  // ... 70+ 个快捷键定义
})
```

### 19.3.3 Leader Key 机制

Leader Key 是 Vim 用户熟悉的概念。按下 Leader Key（默认 `Ctrl+X`）后，进入 2 秒的等待窗口，此时按下后续键完成组合操作：

> **源码位置**：`packages/opencode/src/cli/cmd/tui/context/keybind.tsx`

```typescript
function leader(active: boolean) {
  if (active) {
    setStore("leader", true)
    focus = renderer.currentFocusedRenderable
    focus?.blur() // 临时取消焦点，防止输入干扰
    timeout = setTimeout(() => {
      if (!store.leader) return
      leader(false)        // 2 秒超时自动退出
      focus?.focus()       // 恢复焦点
    }, 2000)
    return
  }
  // 退出 Leader 模式
  setStore("leader", false)
}
```

## 19.4 流式渲染

### 19.4.1 SyncProvider 与 SSE 数据流

TUI 通过 SyncProvider 接收后端的 SSE（Server-Sent Events）事件流，实时更新界面状态：

> **源码位置**：`packages/opencode/src/cli/cmd/tui/context/sync.tsx`

```typescript
export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      session: Session[]
      message: { [sessionID: string]: Message[] }
      part: { [messageID: string]: Part[] }
      lsp: LspStatus[]
      mcp: { [key: string]: McpStatus }
      // ... 更多状态字段
    }>({
      // 初始值
    })
    // SSE 事件驱动状态更新
  },
})
```

### 19.4.2 渲染管线流程

当 LLM 流式输出时，数据流经以下管线：

```
LLM API → Provider 层 → Bus 事件 → SSE 推送 → SyncProvider → SolidJS 响应式更新 → OpenTUI 渲染
```

关键环节：

1. **SSE 接收**：SDKProvider 建立与服务端的 SSE 连接
2. **状态更新**：SyncProvider 使用 SolidJS 的 `createStore` + `produce` 进行细粒度更新
3. **精准渲染**：SolidJS 的依赖追踪确保只有受影响的 DOM 节点重绘
4. **帧率控制**：OpenTUI 以 60fps 的目标帧率批量提交终端绘制

### 19.4.3 终端背景色检测

TUI 启动时会自动检测终端背景色，选择合适的明暗主题：

```typescript
async function getTerminalBackgroundColor(): Promise<"dark" | "light"> {
  return new Promise((resolve) => {
    const handler = (data: Buffer) => {
      const match = data.toString().match(/\x1b]11;([^\x07\x1b]+)/)
      if (match) {
        const color = match[1]
        // 解析 RGB 值，计算亮度
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
        resolve(luminance > 0.5 ? "light" : "dark")
      }
    }
    process.stdin.setRawMode(true)
    process.stdout.write("\x1b]11;?\x07") // 查询终端背景色
    setTimeout(() => resolve("dark"), 1000) // 超时默认深色
  })
}
```

## 19.5 与 Claude Code TUI 对比

| 特性 | OpenCode TUI | Claude Code TUI |
|------|-------------|-----------------|
| UI 框架 | OpenTUI + SolidJS | Ink + React |
| 渲染性能 | 细粒度更新，60fps | Virtual DOM diff |
| 主题系统 | 20+ 内置主题（Catppuccin、Dracula 等） | 有限主题支持 |
| 键盘体系 | Leader Key + 70+ 可配置快捷键 | 固定快捷键 |
| 鼠标支持 | 完整鼠标事件、文本选择复制 | 基础支持 |
| 语法高亮 | 内置 Tree-sitter | Markdown 渲染 |
| 命令面板 | Ctrl+P 命令面板（类 VS Code） | 斜杠命令 |
| 配置文件 | tui.json 独立配置 | 内置于主配置 |
| 滚动加速 | 可配置滚动速度与加速 | 标准滚动 |

OpenCode TUI 在功能丰富度和可定制性上明显领先，尤其是 Leader Key 机制和丰富的主题生态体现了对终端重度用户的用心设计。

## 19.6 实战：理解 TUI 的渲染管线

让我们通过一个具体的交互流程，跟踪一条消息从输入到渲染的全过程：

**场景：用户在 Prompt 输入框输入 "Hello" 并按下 Enter**

```
1. Prompt 组件捕获 Enter 键
   ↓ keybind.match("input_submit", evt) 匹配成功
2. 通过 SDKProvider 发送 HTTP 请求到后端
   ↓ POST /session/:id/message
3. 后端创建 UserMessage，启动 LLM 调用
   ↓ Bus.publish(Session.Event.Message, ...)
4. SSE 推送 message 和 part 事件到 TUI
   ↓ EventSource → SyncProvider
5. SyncProvider 更新 store
   ↓ setStore(produce(s => s.message[sessionID].push(msg)))
6. SolidJS 追踪到依赖变化
   ↓ 消息列表组件的 For 循环自动更新
7. OpenTUI 在下一帧渲染新增文本
   ↓ 终端输出更新
```

追踪命令面板的注册和触发：

```typescript
// app.tsx 中注册命令
command.register(() => [
  {
    title: "Switch session",
    value: "session.list",
    keybind: "session_list",       // 对应 <leader>l
    category: "Session",
    slash: { name: "sessions" },   // 也支持 /sessions 斜杠命令
    onSelect: () => {
      dialog.replace(() => <DialogSessionList />)
    },
  },
  {
    title: "New session",
    value: "session.new",
    keybind: "session_new",        // 对应 <leader>n
    slash: { name: "new", aliases: ["clear"] },
    onSelect: () => {
      route.navigate({ type: "home" })
    },
  },
  // ... 更多命令
])
```

## 19.7 本章要点

- **OpenCode 选择 OpenTUI + SolidJS** 而非 Ink + React，利用细粒度响应式实现高性能终端渲染，目标帧率 60fps
- **深度 Provider 嵌套架构** 管理 SDK 通信、状态同步、主题、键盘绑定、对话框等全局状态，每层 Provider 职责单一
- **Leader Key 机制** 借鉴 Vim 的组合键设计，`Ctrl+X` 作为 Leader，后续按键在 2 秒窗口内完成操作，70+ 快捷键全部可通过 `tui.json` 自定义
- **流式渲染管线** 从 SSE 事件流到 SolidJS 响应式 store 再到终端绘制，数据变化精准传播，避免不必要的重绘
- **终端环境自适应**：自动检测背景色选择明暗主题，支持 Kitty 键盘协议、鼠标事件和文本选择复制
