# 第 19 章　TUI 终端界面

终端用户界面（TUI）是 OpenCode 最核心的交互方式。不同于 Claude Code 基于 Ink（React 的终端渲染器）构建的 TUI，OpenCode 选择了 **OpenTUI + SolidJS** 这一更高性能的组合。本章将深入分析 TUI 的架构设计、组件模型、键盘事件处理与流式渲染管线。

## 19.1 OpenTUI + SolidJS：终端中的响应式 UI

### 19.1.1 技术选型

Ink 是 React 在终端环境的移植，被 Claude Code 等工具广泛采用。OpenCode 则选择了自研终端 UI 框架 **OpenTUI**，搭配 **SolidJS** 作为响应式层。

> **源码位置**：`packages/opencode/src/cli/cmd/tui/app.tsx`

```typescript
// 文件: packages/opencode/src/cli/cmd/tui/app.tsx L1-2
import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Switch, Match, createEffect, createSignal, onMount, batch, Show } from "solid-js"
```

| 维度 | Ink + React | OpenTUI + SolidJS |
|------|-----------|-------------------|
| 渲染模型 | Virtual DOM 全量 diff | 细粒度响应式，精准更新 |
| 帧率控制 | 无内置帧率管理 | 内置 targetFps 控制（默认 60fps） |
| 鼠标支持 | 基础 | 原生鼠标事件、选择、复制 |
| Kitty 键盘协议 | 不支持 | 原生支持 |

SolidJS 的细粒度响应式非常适合 TUI 场景。当 LLM 流式输出文本时，只有新增的文本节点需要重新渲染，而非整棵组件树。`createEffect` 只追踪实际读取的响应式值，精确触发必要的更新。

## 19.2 Provider 嵌套架构

`tui()` 函数是 TUI 的入口，通过 `render()` 启动渲染循环。组件树采用深度嵌套的 Provider 模式管理全局状态，每层 Provider 职责单一：

```typescript
// 文件: packages/opencode/src/cli/cmd/tui/app.tsx L132-198
render(() => (
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
), {
  targetFps: 60,
  exitOnCtrlC: false,
  useKittyKeyboard: {},
  autoFocus: false,
})
```

`render()` 的第二个参数配置了渲染引擎：60fps 目标帧率、禁用内置 Ctrl+C 处理（由 KeybindProvider 接管）、启用 Kitty 键盘协议以获得更精确的按键识别。这些 Provider 构成完整的应用上下文——SDKProvider 与后端 HTTP 服务通信、SyncProvider 维护 SSE 数据同步、ThemeProvider 管理明暗主题、KeybindProvider 处理快捷键注册与匹配、CommandProvider 实现类 VS Code 的命令面板。

## 19.3 路由与视图切换

TUI 仅有两个核心路由：**Home**（首页）和 **Session**（会话页面）。

> **源码位置**：`packages/opencode/src/cli/cmd/tui/context/route.tsx`

```typescript
// 文件: packages/opencode/src/cli/cmd/tui/context/route.tsx L5-17
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

视图切换通过 SolidJS 的 `Switch/Match` 实现，`App` 组件根据 `route.data.type` 渲染对应页面。进入 Session 页面时，`createEffect` 自动更新终端标题为会话名称（截断至 40 字符），让多窗口用户快速识别当前对话。

## 19.4 键盘事件处理

### 19.4.1 Keybind 解析系统

OpenCode 实现了一套完整的快捷键系统，支持 **Leader Key** 模式（类似 Vim）。

> **源码位置**：`packages/opencode/src/util/keybind.ts`

```typescript
// 文件: packages/opencode/src/util/keybind.ts L57-101
export function parse(key: string): Info[] {
  if (key === "none") return []  // "none" 表示禁用

  return key.split(",").map((combo) => {
    const normalized = combo.replace(/<leader>/g, "leader+")
    const parts = normalized.toLowerCase().split("+")
    const info: Info = {
      ctrl: false, meta: false, shift: false, leader: false, name: "",
    }
    for (const part of parts) {
      switch (part) {
        case "ctrl": info.ctrl = true; break
        case "alt": case "meta": case "option": info.meta = true; break
        case "leader": info.leader = true; break
        case "esc": info.name = "escape"; break
        default: info.name = part; break
      }
    }
    return info
  })
}
```

`parse()` 将快捷键字符串（如 `"ctrl+x"`、`"<leader>n"`）解析为结构化的 `Info` 对象。逗号分隔表示多个备选绑定，加号分隔修饰键和主键。`match()` 函数使用 `isDeepEqual` 进行精确比较，`fromParsedKey()` 负责将 OpenTUI 原生的 `ParsedKey` 事件转换为 Keybind 格式。

### 19.4.2 Leader Key 机制

Leader Key 是 Vim 用户熟悉的概念。按下 Leader Key（默认 `Ctrl+X`）后，进入 2 秒的等待窗口：

> **源码位置**：`packages/opencode/src/cli/cmd/tui/context/keybind.tsx`

```typescript
// 文件: packages/opencode/src/cli/cmd/tui/context/keybind.tsx L30-51
function leader(active: boolean) {
  if (active) {
    setStore("leader", true)
    focus = renderer.currentFocusedRenderable
    focus?.blur()  // 临时取消焦点，防止输入干扰
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      if (!store.leader) return
      leader(false)        // 2 秒超时自动退出
      if (!focus || focus.isDestroyed) return
      focus.focus()        // 恢复焦点
    }, 2000)
    return
  }
  if (!active) {
    if (focus && !renderer.currentFocusedRenderable) focus.focus()
    setStore("leader", false)
  }
}
```

进入 Leader 模式时，当前聚焦的组件被 blur 以防止按键被输入框捕获。2 秒窗口内的下一个按键触发对应操作后，通过 `setImmediate` 恢复焦点并退出 Leader 模式。这种异步恢复避免了当前按键事件被恢复焦点后的组件再次处理。

## 19.5 SyncProvider 与流式渲染

### 19.5.1 SSE 驱动的状态同步

TUI 通过 SyncProvider 接收后端的 SSE 事件流，实时更新界面状态。store 包含 provider、session、message、part、lsp、mcp 等二十多个状态字段。

> **源码位置**：`packages/opencode/src/cli/cmd/tui/context/sync.tsx`

SSE 事件的处理使用 `produce` 进行细粒度更新，`Binary.search` 在有序数组中高效定位元素。流式文本增量通过 `message.part.delta` 事件传递，直接拼接到现有 part 的对应字段上：

```typescript
// 文件: packages/opencode/src/cli/cmd/tui/context/sync.tsx L311-326
case "message.part.delta": {
  const parts = store.part[event.properties.messageID]
  if (!parts) break
  const result = Binary.search(parts, event.properties.partID, (p) => p.id)
  if (!result.found) break
  setStore("part", event.properties.messageID, produce((draft) => {
    const part = draft[result.index]
    const field = event.properties.field as keyof typeof part
    const existing = part[field] as string | undefined
    ;(part[field] as string) = (existing ?? "") + event.properties.delta
  }))
  break
}
```

这种 delta 模式让 SolidJS 的响应式系统精确追踪到字段级别的变化，只重绘受影响的文本节点，而非整个消息列表。

### 19.5.2 启动时的分阶段加载

`bootstrap()` 函数将初始数据加载分为 blocking 和 non-blocking 两个阶段。providers、agents、config 等关键数据在第一阶段同步加载（状态设为 `partial`），session 列表、LSP/MCP 状态、命令列表等在第二阶段异步加载（完成后设为 `complete`）。使用 `-c` 继续上次会话时，session 列表被提升到 blocking 阶段，确保导航前数据已就绪。

## 19.6 命令面板与事件系统

`App` 组件通过 `command.register()` 注册了二十多个命令，每个命令包含标题、快捷键绑定、斜杠命令别名和执行回调：

```typescript
// 文件: packages/opencode/src/cli/cmd/tui/app.tsx L360-414
command.register(() => [
  {
    title: "Switch session",
    value: "session.list",
    keybind: "session_list",       // 对应 <leader>l
    slash: { name: "sessions", aliases: ["resume", "continue"] },
    onSelect: () => dialog.replace(() => <DialogSessionList />),
  },
  {
    title: "New session",
    value: "session.new",
    keybind: "session_new",        // 对应 <leader>n
    slash: { name: "new", aliases: ["clear"] },
    onSelect: () => route.navigate({ type: "home" }),
  },
  // ... 更多命令
])
```

后端事件也通过 `sdk.event.on()` 与 TUI 交互——`TuiEvent.ToastShow` 触发 toast 通知、`TuiEvent.CommandExecute` 触发命令执行、`SessionApi.Event.Error` 显示错误提示、`Installation.Event.UpdateAvailable` 通知用户新版本可用。

## 19.7 终端环境自适应

TUI 启动时通过 ANSI 转义序列 `\x1b]11;?\x07` 查询终端背景色，解析返回的 RGB 值计算亮度（使用 `0.299R + 0.587G + 0.114B` 公式），超过阈值则选择 light 主题，否则使用 dark 主题。检测超时 1 秒默认使用深色主题：

```typescript
// 文件: packages/opencode/src/cli/cmd/tui/app.tsx L45-103
async function getTerminalBackgroundColor(): Promise<"dark" | "light"> {
  if (!process.stdin.isTTY) return "dark"
  return new Promise((resolve) => {
    // 查询终端背景色并解析 RGB
    process.stdout.write("\x1b]11;?\x07")
    setTimeout(() => { cleanup(); resolve("dark") }, 1000)
  })
}
```

ErrorBoundary 组件在主题上下文不可用时根据检测到的 mode 选择安全的回退颜色，确保即使发生致命错误也能正确显示错误堆栈和操作按钮。

## 19.8 本章要点

- **OpenCode 选择 OpenTUI + SolidJS** 而非 Ink + React，利用细粒度响应式实现高性能终端渲染，目标帧率 60fps
- **深度 Provider 嵌套架构** 管理 SDK 通信、状态同步、主题、键盘绑定、对话框等全局状态，每层 Provider 职责单一
- **Leader Key 机制** 借鉴 Vim 设计，`Ctrl+X` 触发后 blur 当前组件进入 2 秒等待窗口，`setImmediate` 异步恢复焦点避免事件冲突
- **SSE delta 模式** 将流式文本增量直接拼接到 store 字段，SolidJS 精确追踪字段级变化，避免不必要的重绘
- **分阶段启动** 将关键数据（providers、config）同步加载，非关键数据（LSP、MCP 状态）异步加载，优化首屏速度
- **终端环境自适应**：ANSI 转义序列检测背景色，自动选择明暗主题
