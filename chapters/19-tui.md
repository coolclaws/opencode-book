# 第 19 章　TUI 终端界面

> "Any sufficiently advanced terminal application is indistinguishable from a GUI." —— 改编自 Arthur C. Clarke

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

要理解这一点，需要对比 React 和 SolidJS 在 TUI 场景下的根本差异。React 使用 Virtual DOM——每次状态变化后，框架重新执行整棵组件树的渲染函数，生成一棵新的虚拟节点树，再与旧树进行全量 diff 以找出实际变化。在浏览器 DOM 中，这种 diff 开销可以接受，因为 DOM 操作本身更昂贵。但在终端环境中，"渲染"的最终产物是一串 ANSI 转义序列写入 stdout，这个操作非常轻量。此时 Virtual DOM 的 diff 反而成了性能瓶颈——尤其当 LLM 以每秒几十个 token 的速度流式输出时，每个 token 都会触发一次完整的组件树 diff，大部分计算都浪费在"确认其他组件没变"上。

SolidJS 的细粒度响应式完全绕过了这个问题。每个 `createSignal` 创建的响应式值维护着自己的订阅者列表，当值更新时，只有直接依赖该值的 `createEffect` 和 `createMemo` 被重新执行。对于流式文本输出，store 中某个 part 的 `content` 字段被拼接了新的 delta 文本，SolidJS 只重绘渲染该字段的那一个文本节点，其余数百个组件完全不参与更新。这使得 OpenCode 在高频流式更新场景下能维持稳定的 60fps，而不会因为消息列表变长而出现明显的帧率下降。

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

值得注意的是 Provider 的嵌套顺序并非随意排列，它反映了依赖关系。例如 `ThemeProvider` 必须在 `SyncProvider` 之后，因为主题需要根据同步的配置数据来决定；`KeybindProvider` 必须在 `TuiConfigProvider` 之后，因为快捷键绑定来自 TUI 配置。最内层的三个 Provider——`FrecencyProvider`、`PromptHistoryProvider`、`PromptRefProvider`——都服务于输入框组件，它们被放在最靠近 `<App />` 的位置，确保只在实际需要输入功能的组件树中生效。这些 Provider 通过 `createSimpleContext` 辅助函数创建，每个 Provider 封装一个 `init` 函数，返回的对象成为该 Context 的值，子组件通过 `use` hook 访问。

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

### 19.4.1 键盘事件的完整链路

在终端环境中，用户按下一个键后，事件经历的完整链路远比浏览器复杂。以用户按下 `Ctrl+X` 然后按 `n`（创建新会话）为例，事件的传播路径如下：

```text
终端原始字节              OpenTUI 解析层            Keybind 匹配层
┌──────────────┐        ┌──────────────────┐      ┌──────────────────┐
│ stdin 收到   │        │ Kitty 键盘协议   │      │ Keybind.parse()  │
│ \x18 (Ctrl+X)│───────→│ 解析为 ParsedKey │─────→│ 解析配置字符串   │
│              │        │ {name:"x",       │      │ "ctrl+x" → Info  │
│              │        │  ctrl:true}      │      │                  │
└──────────────┘        └──────────────────┘      └────────┬─────────┘
                                                           │
                        KeybindProvider 分发层              │ Keybind.match()
                        ┌──────────────────┐               │ 深度比较
                        │ useKeyboard 回调 │←──────────────┘
                        │ 匹配 "leader" 键 │
                        │ → leader(true)   │
                        │ → blur 输入框    │
                        │ → 启动 2s 定时器 │
                        └────────┬─────────┘
                                 │ 用户按 "n"
                                 ↓
                        ┌──────────────────┐      ┌──────────────────┐
                        │ setImmediate 恢复│      │ 执行 onSelect    │
                        │ 焦点并退出 leader│─────→│ route.navigate   │
                        │ 模式             │      │ ({type: "home"}) │
                        └──────────────────┘      └──────────────────┘
```

首先，终端将用户的按键编码为原始字节流写入 stdin。传统终端使用简单的 ANSI 转义序列，但很多修饰键组合无法区分（例如 `Ctrl+Shift+A` 和 `Ctrl+A` 产生相同的字节）。OpenTUI 通过启用 Kitty 键盘协议解决了这个问题——该协议让终端以结构化格式报告按键信息，包括精确的修饰键状态和键名，消除了传统协议的歧义。OpenTUI 解析层将原始字节解码为 `ParsedKey` 对象，包含 `name`、`ctrl`、`meta`、`shift` 等字段。

### 19.4.2 Keybind 解析系统

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

`parse()` 将快捷键字符串（如 `"ctrl+x"`、`"<leader>n"`）解析为结构化的 `Info` 对象。逗号分隔表示多个备选绑定，加号分隔修饰键和主键。`match()` 函数使用 `isDeepEqual` 进行精确比较，`fromParsedKey()` 负责将 OpenTUI 原生的 `ParsedKey` 事件转换为 Keybind 格式。这里有一个值得注意的细节：`fromParsedKey` 会将空格键 `" "` 规范化为 `"space"`，确保配置文件中 `"ctrl+space"` 这样的写法能正确匹配。另外，`KeybindProvider` 还处理了一个终端特有的边界情况——`Ctrl+Underscore` 在某些终端中被编码为控制字符 `\x1F`，需要手动还原为 `{name: "_", ctrl: true}` 才能与快捷键配置正确匹配。

### 19.4.3 Leader Key 机制

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

进入 Leader 模式时，当前聚焦的组件被 blur 以防止按键被输入框捕获。2 秒窗口内的下一个按键触发对应操作后，通过 `setImmediate` 恢复焦点并退出 Leader 模式。这种异步恢复避免了当前按键事件被恢复焦点后的组件再次处理。`KeybindProvider` 还暴露了一个 `print` 方法，用于在 UI 底部状态栏展示快捷键提示——它将 Leader 序列中的 `<leader>` 占位符替换为实际的 Leader Key 文本表示（如 `ctrl+x n`），让用户清楚地看到完整的按键序列。

## 19.5 Prompt 组件：复杂输入处理

Prompt 是 TUI 中最复杂的单体组件，它不仅是一个文本输入框，还集成了三个协作子系统：历史记录（history）、频率排序（frecency）和自动补全（autocomplete）。

### 19.5.1 历史记录系统

`PromptHistoryProvider` 管理用户输入的历史。历史条目以 JSONL 格式持久化在 `~/.local/state/opencode/prompt-history.jsonl` 文件中，每条记录不仅保存文本内容，还保存附带的 parts（文件引用、Agent 引用等）和输入模式（normal 或 shell）。`MAX_HISTORY_ENTRIES = 50` 限制了历史容量——超出时截断并重写整个文件以实现自愈式的数据清理。用户通过上下方向键（对应 `history_previous` 和 `history_next` 快捷键）浏览历史，导航逻辑使用负索引从数组末尾回溯：`index = 0` 表示当前输入，`index = -1` 是上一条记录，以此类推。切换历史条目时，组件不仅恢复文本内容，还通过 `restoreExtmarksFromParts` 重建输入框中的 extmark（扩展标记），让文件引用等虚拟文本标签重新出现在正确的位置。

### 19.5.2 Frecency 排序

Frecency（frequency + recency 的混成词）是 Firefox 地址栏等产品广泛采用的排序算法。OpenCode 将它应用于文件自动补全的排序——频繁使用且最近使用过的文件排在前面。核心公式为 `frecency = frequency × (1 / (1 + daysSince))`，其中 `daysSince` 是距离上次使用的天数。刚使用过的文件权重接近其累计频率，一天前的文件权重减半，一周前的文件权重降至约七分之一。Frecency 数据同样以 JSONL 格式持久化，容量上限 `MAX_FRECENCY_ENTRIES = 1000`，超出时按 `lastOpen` 排序截断。当用户在自动补全中选择一个文件时，`updateFrecency` 立即更新内存中的 store 并追加一行到持久化文件，保证下次自动补全时排序立刻反映最新的使用模式。

### 19.5.3 自动补全系统

自动补全通过 `Autocomplete` 组件实现，支持两种触发模式：`@` 触发文件和 Agent 补全，`/` 触发斜杠命令补全。当用户输入 `@` 时，组件向后端 SDK 发起 `find.files` 请求获取文件列表，同时混入 MCP 资源和可用的子 Agent 作为候选项。搜索结果经过 `fuzzysort` 模糊匹配库排序，排序函数在模糊匹配分数之上叠加了 frecency 加权：`score * (1 + frecencyScore)`，使得高频文件即使不完全匹配也能排在前面。对于目录类型的候选项，Tab 键不会选中而是展开目录内容，让用户可以继续向下钻取，这种交互模式借鉴了 shell 的路径补全体验。选中文件后，组件通过 `input.extmarks.create` 在输入框中创建一个虚拟文本标记（extmark），将文件路径显示为一个带样式的标签（如 `@src/agent/agent.ts`），实际的文件 URL 保存在 prompt 的 parts 数组中，提交时一起发送给后端。

## 19.6 SyncProvider 与流式渲染

### 19.6.1 SSE 驱动的状态同步

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

这种 delta 模式让 SolidJS 的响应式系统精确追踪到字段级别的变化，只重绘受影响的文本节点，而非整个消息列表。`Binary.search` 使用二分查找在已排序的 parts 数组中定位目标 part，时间复杂度为 O(log n)，避免了线性扫描的开销。`produce` 来自 SolidJS 的 `solid-js/store` 模块，它创建一个 Immer 风格的可变代理对象——在回调内部直接修改 `draft` 的属性，`produce` 自动将这些修改转化为精确的 store 更新路径。最终，只有 `store.part[messageID][index][field]` 这一条路径上的订阅者被通知更新，整个更新链路从事件接收到 UI 重绘，每一步都是精确瞄准而非广撒网。

### 19.6.2 启动时的分阶段加载

`bootstrap()` 函数将初始数据加载分为 blocking 和 non-blocking 两个阶段。providers、agents、config 等关键数据在第一阶段同步加载（状态设为 `partial`），session 列表、LSP/MCP 状态、命令列表等在第二阶段异步加载（完成后设为 `complete`）。使用 `-c` 继续上次会话时，session 列表被提升到 blocking 阶段，确保导航前数据已就绪。

## 19.7 命令面板与事件系统

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

后端事件也通过 `sdk.event.on()` 与 TUI 交互——`TuiEvent.ToastShow` 触发 toast 通知、`TuiEvent.CommandExecute` 触发命令执行、`SessionApi.Event.Error` 显示错误提示、`Installation.Event.UpdateAvailable` 通知用户新版本可用。Prompt 组件自身也注册了多个命令，包括 `prompt.clear`（清空输入）、`prompt.submit`（提交）、`prompt.paste`（粘贴）、`prompt.stash`（暂存当前输入）、`prompt.stash.pop`（恢复暂存）和 `prompt.editor`（在外部编辑器中打开当前输入）。Stash 功能类似 Git 的 stash——用户可以临时保存当前未提交的输入内容，切换到其他对话处理事情，然后再回来 pop 恢复。

## 19.8 终端环境自适应

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

## 19.9 本章要点

- **OpenCode 选择 OpenTUI + SolidJS** 而非 Ink + React，利用细粒度响应式实现高性能终端渲染，目标帧率 60fps。Virtual DOM 的全量 diff 在高频流式输出场景下成为瓶颈，SolidJS 的信号订阅机制让每次 token 更新只触及一个文本节点
- **深度 Provider 嵌套架构** 管理 SDK 通信、状态同步、主题、键盘绑定、对话框等全局状态，每层 Provider 职责单一，嵌套顺序反映了依赖关系
- **键盘事件链路** 从终端原始字节 → Kitty 协议解析 → `ParsedKey` → `Keybind.fromParsedKey()` 转换 → `Keybind.match()` 深度比较 → Provider 分发到具体处理函数，全链路类型安全
- **Leader Key 机制** 借鉴 Vim 设计，`Ctrl+X` 触发后 blur 当前组件进入 2 秒等待窗口，`setImmediate` 异步恢复焦点避免事件冲突
- **Prompt 组件集成三大子系统**：历史记录（JSONL 持久化、负索引回溯、extmark 重建）、Frecency 排序（频率 × 时间衰减加权）、自动补全（`@` 触发文件/Agent、`/` 触发命令、fuzzysort 模糊匹配 + frecency 加权排序）
- **SSE delta 模式** 将流式文本增量直接拼接到 store 字段，`Binary.search` 二分定位 + `produce` 精确路径更新，SolidJS 追踪字段级变化，避免不必要的重绘
- **分阶段启动** 将关键数据（providers、config）同步加载，非关键数据（LSP、MCP 状态）异步加载，优化首屏速度
- **终端环境自适应**：ANSI 转义序列检测背景色，自动选择明暗主题
